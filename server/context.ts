import { promises as fs } from 'node:fs';
import path from 'node:path';
import { META_DIR, ROOT_FOLDERS, TRASH_DIR, type ActivityEvent, type LinkInfo, type VaultUser } from '../shared/types.ts';
import { ActivityLog, type NewActivity } from './activity.ts';
import { AgentRegistry, normalizeAgentId } from './agents.ts';
import { errorMessage } from './errors.ts';
import { KeyedMutex, Mutex } from './fsutil.ts';
import { VaultIndex, type Changes } from './index-store.ts';
import { readRawLinks } from './config.ts';
import { loadLinks, toLinkInfo } from './links.ts';
import { migrateProjectLibraries } from './migrate-library.ts';
import { makeSafeRoot, type SafeRoot } from './paths.ts';
import { EventHub } from './sse.ts';
import type { NetHooks } from './ssrf.ts';

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export function makeLogger(quiet: boolean): Logger {
  const stamp = () => new Date().toISOString().slice(11, 19);
  return {
    info: (msg) => {
      if (!quiet) console.log(`[centcom ${stamp()}] ${msg}`);
    },
    warn: (msg) => {
      if (!quiet) console.warn(`[centcom ${stamp()}] warn: ${msg}`);
    },
    // Errors are never silenced: a daily-driver tool must not fail without a trace.
    error: (msg) => console.error(`[centcom ${stamp()}] error: ${msg}`),
  };
}

/** Everything a request handler needs. One per running server; nothing here is module-global. */
export interface Ctx {
  /** Root + realpath + the current link allowlist (`vault.links` is swapped by `reloadLinks`). */
  vault: SafeRoot;
  /** Where `config.json` lives; the only source of the link allowlist. */
  configDir: string;
  configPath: string;
  /** The human who owns this vault (from config). Writes that name no author are attributed to `user.id`. */
  user: VaultUser;
  log: Logger;
  /** Replaced wholesale by `reloadLinks`, so always read it through `ctx.index`. */
  index: VaultIndex;
  hub: EventHub;
  activity: ActivityLog;
  agents: AgentRegistry;
  /** Serialises read-modify-write cycles on a single file (keyed by vault-relative path or ticket id). */
  locks: KeyedMutex;
  /** Guards ticket-number allocation and `counters.json`. */
  counterLock: Mutex;
  /** Guards name allocation for uploads / duplicates / trash ids. */
  nameLock: Mutex;
  /** (agent + path) → last `doc.updated` activity ts, for the 60 s rate limit. */
  docActivityAt: Map<string, number>;
  /** Paths the API itself just wrote, so the watcher never re-attributes them to `filesystem`. */
  recentWrites: Map<string, number>;
  /**
   * TEST-ONLY seams for outbound fetches (see `NetHooks`). Undefined in every real server: the
   * only way to set it is the in-process `startServer({ unsafeNetForTests })` option.
   */
  net?: NetHooks;
}

async function readLinkAllowlist(vault: SafeRoot, configDir: string, configPath: string, log: Logger) {
  const { links, dropped } = await loadLinks(await readRawLinks(configPath), { vaultRoot: vault.root, vaultReal: vault.realRoot, configDir });
  for (const d of dropped) log.warn(`Ignoring link ${JSON.stringify(d.entry)}: ${d.reason}.`);
  for (const l of links) log.info(`Linked ${l.mount} → ${l.target}${l.readonly ? ' (read-only)' : ''}`);
  return links;
}

export async function createContext(vaultDir: string, log: Logger, config: { configDir: string; configPath: string; user: VaultUser }, testOnly: { net?: NetHooks | undefined } = {}): Promise<Ctx> {
  await fs.mkdir(vaultDir, { recursive: true });
  const vault = await makeSafeRoot(vaultDir);
  // Structural folders are recreated on every boot (mkdir -p never overwrites anything).
  for (const dir of ['Projects', 'Inbox', META_DIR, TRASH_DIR, path.join(META_DIR, 'activity')]) {
    await fs.mkdir(path.join(vault.root, dir), { recursive: true });
  }
  vault.links = await readLinkAllowlist(vault, config.configDir, config.configPath, log);
  // Before anything indexes or watches the vault: project `Wiki` folders are now `Library`.
  await migrateProjectLibraries(vault.root, vault.links, log);

  const hub = new EventHub();
  const agents = new AgentRegistry(vault.root, config.user, () => hub.broadcast({ type: 'agents' }), (m) => log.warn(m));
  const activity = new ActivityLog(vault.root, (m) => log.warn(m));
  const index = new VaultIndex(vault, (m) => log.warn(m));

  await agents.load();
  await activity.load();
  await index.rebuild();

  return {
    vault,
    configDir: config.configDir,
    configPath: config.configPath,
    user: config.user,
    log,
    index,
    hub,
    activity,
    agents,
    locks: new KeyedMutex(),
    counterLock: new Mutex(),
    nameLock: new Mutex(),
    docActivityAt: new Map(),
    recentWrites: new Map(),
    ...(testOnly.net ? { net: testOnly.net } : {}),
  };
}

/** Turn index changes into SSE events. Used identically by API writes and the watcher. */
export function broadcastChanges(ctx: Ctx, changes: Changes): void {
  for (const file of changes.files) {
    ctx.hub.broadcast(file.change === 'removed' ? { type: 'doc', path: file.path, mtime: file.mtime, deleted: true } : { type: 'doc', path: file.path, mtime: file.mtime });
  }
  const seenTickets = new Set<string>();
  for (const t of changes.tickets) {
    // A rewrite shows up as one entry; a re-key shows up as "old id deleted" + "new id".
    const key = `${t.id}:${t.after ? 'live' : 'gone'}`;
    if (seenTickets.has(key)) continue;
    seenTickets.add(key);
    ctx.hub.broadcast(t.after ? { type: 'ticket', id: t.id } : { type: 'ticket', id: t.id, deleted: true });
  }
  for (const [slug, deleted] of changes.projects) {
    ctx.hub.broadcast(deleted ? { type: 'project', slug, deleted: true } : { type: 'project', slug });
  }
  if (changes.structure) ctx.hub.broadcast({ type: 'tree' });
}

const RECENT_WRITE_MS = 3000;

/** Call before a slow multi-step write (folder copy); `syncAndBroadcast` calls it for everything else. */
export function markApiWrite(ctx: Ctx, rels: readonly string[]): void {
  const now = Date.now();
  for (const rel of rels) ctx.recentWrites.set(rel, now);
  if (ctx.recentWrites.size > 2000) {
    for (const [rel, ts] of ctx.recentWrites) if (now - ts > RECENT_WRITE_MS) ctx.recentWrites.delete(rel);
  }
}

/** True when `rel`, or a folder containing it, was written through the API moments ago. */
export function isRecentApiWrite(ctx: Ctx, rel: string, now = Date.now()): boolean {
  for (let p = rel; ; p = p.slice(0, p.lastIndexOf('/'))) {
    const ts = ctx.recentWrites.get(p);
    if (ts !== undefined && now - ts <= RECENT_WRITE_MS) return true;
    if (!p.includes('/')) return false;
  }
}

/** Sync paths into the index and tell every listener what changed. */
export async function syncAndBroadcast(ctx: Ctx, rels: readonly string[]): Promise<Changes> {
  markApiWrite(ctx, rels);
  const changes = await ctx.index.syncMany(rels);
  broadcastChanges(ctx, changes);
  return changes;
}

/** Who a write is attributed to: the id the client gave, else the vault's owner. */
export function actingAgent(ctx: Pick<Ctx, 'user'>, input: unknown, field = 'agent'): string {
  if (input === undefined || input === null || input === '') return ctx.user.id;
  return normalizeAgentId(input, field);
}

/** Append to the activity log, mark the agent as seen, and push the event to listeners. */
export async function recordActivity(ctx: Ctx, input: NewActivity): Promise<ActivityEvent> {
  const event = await ctx.activity.append(input);
  ctx.agents.touch(event.agent, event.ts);
  ctx.hub.broadcast({ type: 'activity', event });
  return event;
}

/** Same, for call sites where losing a log line must not fail the user's write. */
export async function recordActivitySafe(ctx: Ctx, input: NewActivity): Promise<ActivityEvent | null> {
  try {
    return await recordActivity(ctx, input);
  } catch (err) {
    ctx.log.error(`Could not record activity (${input.type}): ${errorMessage(err)}`);
    return null;
  }
}

const DOC_ACTIVITY_WINDOW_MS = 60_000;

/** `doc.updated` is rate-limited per (agent, file) so autosave does not flood the log. */
export function shouldLogDocUpdate(ctx: Ctx, agent: string, rel: string, now = Date.now()): boolean {
  const key = `${agent}\n${rel}`;
  const last = ctx.docActivityAt.get(key);
  if (last !== undefined && now - last < DOC_ACTIVITY_WINDOW_MS) return false;
  ctx.docActivityAt.set(key, now);
  if (ctx.docActivityAt.size > 5000) {
    for (const [k, ts] of ctx.docActivityAt) if (now - ts >= DOC_ACTIVITY_WINDOW_MS) ctx.docActivityAt.delete(k);
  }
  return true;
}

export function currentLinks(ctx: Ctx): LinkInfo[] {
  return (ctx.vault.links ?? []).map(toLinkInfo);
}

/**
 * Re-read the link allowlist from the config file and rebuild the index around it. The new
 * index is built on the side and swapped in, so readers never see a half-built tree.
 * (The caller restarts the watcher: it owns it.)
 */
export async function reloadLinks(ctx: Ctx): Promise<LinkInfo[]> {
  ctx.vault.links = await readLinkAllowlist(ctx.vault, ctx.configDir, ctx.configPath, ctx.log);
  const next = new VaultIndex(ctx.vault, (m) => ctx.log.warn(m));
  await next.rebuild();
  ctx.index = next;
  ctx.hub.broadcast({ type: 'tree' });
  return currentLinks(ctx);
}

export async function closeContext(ctx: Ctx): Promise<void> {
  ctx.hub.closeAll();
  await Promise.allSettled([ctx.agents.flush(), ctx.activity.flush()]);
}
