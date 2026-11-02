import { randomBytes } from 'node:crypto';
import { promises as fs, watch as fsWatch, type FSWatcher as NodeFsWatcher } from 'node:fs';
import path from 'node:path';
import { watch as chokidarWatch, type FSWatcher as ChokidarWatcher } from 'chokidar';
import { META_DIR } from '../shared/types.ts';
import { broadcastChanges, type Ctx } from './context.ts';
import { errorMessage } from './errors.ts';
import { hasChanges } from './index-store.ts';
import { relDirname, toPosix } from './paths.ts';
import { logExternalActivity } from './reconcile.ts';

const DEBOUNCE_MS = 80;
/** A steady stream of events (a long copy, a log being appended) must not postpone indexing for ever. */
const MAX_WAIT_MS = 1000;
/** After folders appear or vanish, look at their parent once more this long after things go quiet. */
const SETTLE_MS = 400;
/** A follow-up scan that still finds news schedules another, this many times at most. */
const MAX_SETTLE_ROUNDS = 3;
/** How long to wait for the native watcher to prove it is delivering events. */
const READY_TIMEOUT_MS = 3000;

const AGENTS_FILE = `${META_DIR}/agents.json`;

/** A directory being watched, and where its contents appear in the vault (`''` for the vault itself). */
interface WatchRoot {
  abs: string;
  prefix: string;
}

/**
 * `native`: one recursive `fs.watch` handle per root. `chokidar`: one handle per directory.
 *
 * ROOT CAUSE of "a git pull added eight folders and the index never saw them": on macOS every
 * `fs.watch` directory handle in the process is served by ONE FSEvents stream, and libuv tears
 * that stream down and re-creates it ("since now") each time a handle is added. chokidar 5 has
 * no FSEvents backend any more; it adds a handle for every directory it discovers. So the first
 * new folder of a burst makes chokidar add handles (for it and each nested sub-folder) exactly
 * while the events for the *rest* of the burst are still in flight, those events die with the
 * old stream, and chokidar only ever re-reads a directory when an event for it arrives: the
 * sibling folders stay invisible until a full rebuild. (Measured here with plain `fs.watch`, no
 * chokidar: 40 file creations while 40 handles are being added → 19–28 events delivered; with
 * no handles added → 40/40. One recursive handle, same burst → 32/32, every run.)
 *
 * The fix is to stop adding handles while things change: on macOS each root gets a single
 * recursive handle, created once, so the stream is never restarted mid-burst. inotify has no
 * such coupling, so elsewhere chokidar stays. Either way events are only *hints*: every path is
 * reconciled against the disk (a folder means its whole subtree), and structural bursts get a
 * follow-up scan of the parent folder in case a hint went missing.
 */
export type WatchBackend = 'native' | 'chokidar';

export function defaultWatchBackend(platform: NodeJS.Platform = process.platform): WatchBackend {
  return platform === 'darwin' ? 'native' : 'chokidar';
}

/** Every root `abs` lives in (a link target may sit inside another link's target). */
function rootsOf(roots: readonly WatchRoot[], abs: string): { root: WatchRoot; inner: string }[] {
  const hits: { root: WatchRoot; inner: string }[] = [];
  for (const root of roots) {
    const inner = toPosix(path.relative(root.abs, abs));
    if (inner === '' || (!inner.startsWith('..') && !path.isAbsolute(inner))) hits.push({ root, inner });
  }
  return hits;
}

/**
 * Only visible content is watched: the vault, plus each linked folder's real target (symlinks
 * are never followed, so a link is watched at its source). Dot-entries are ignored relative to
 * the root they live in, which is what keeps a linked repo's `.git` out even when the target's
 * own path contains a dot-folder (`~/.claude/skills`). `agents.json` is the one internal file
 * watched, so hand edits to it are picked up.
 */
function isIgnored(roots: readonly WatchRoot[], abs: string): boolean {
  const hits = rootsOf(roots, abs);
  if (hits.length === 0) return false;
  return hits.every(({ root, inner }) => {
    if (inner === '') return false;
    if (root.prefix === '' && (inner === META_DIR || inner === AGENTS_FILE)) return false;
    return inner.split('/').some((segment) => segment.startsWith('.'));
  });
}

/** Drop every path that has an ancestor in the list (`''` is everyone's ancestor). */
function topmost(rels: readonly string[]): string[] {
  const set = new Set(rels);
  if (set.has('')) return [''];
  return [...set].filter((rel) => {
    for (let p = relDirname(rel); ; p = relDirname(p)) {
      if (set.has(p) && p !== rel) return false;
      if (p === '') return true;
    }
  });
}

export interface VaultWatcher {
  close(): Promise<void>;
  /** Resolves when events are flowing: edits made on disk after this are guaranteed to be noticed. */
  ready: Promise<void>;
  backend: WatchBackend;
}

interface Backend {
  ready: Promise<void>;
  close(): Promise<void>;
}

type OnEvent = (root: WatchRoot, inner: string) => void;

/* ───────────────────────── Backends ───────────────────────── */

function startNativeBackend(ctx: Ctx, roots: readonly WatchRoot[], onEvent: OnEvent): Backend {
  const handles: NodeFsWatcher[] = [];
  let closed = false;
  let probe: { inner: string; seen: () => void } | null = null;

  // The vault root is last in `roots`. The stream is rebuilt for each handle added, so an event
  // arriving on the LAST handle proves the final stream, the one covering every root, is live.
  for (const root of roots) {
    try {
      const handle = fsWatch(root.abs, { recursive: true, persistent: true }, (_event, filename) => {
        if (closed) return;
        // No name means "something under here changed": reconcile the whole root.
        const inner = filename === null ? '' : toPosix(String(filename));
        if (probe && root.prefix === '' && inner === probe.inner) probe.seen();
        else onEvent(root, inner);
      });
      handle.on('error', (err) => ctx.log.warn(`Watcher error on ${root.abs}: ${errorMessage(err)}`));
      handles.push(handle);
    } catch (err) {
      ctx.log.warn(`Cannot watch ${root.abs}: ${errorMessage(err)}. Changes made there on disk need POST /api/reindex.`);
    }
  }

  const ready = (async () => {
    // fs.watch returns before the FSEvents stream behind it is running. Prove it is: keep touching
    // a hidden probe file until its event comes back. (Inside `.centcom`, so never in a linked repo.)
    const name = `.watch-probe-${process.pid}-${randomBytes(4).toString('hex')}`;
    const file = path.join(ctx.vault.root, META_DIR, name);
    let seen = false;
    const sawProbe = new Promise<void>((resolve) => {
      probe = {
        inner: `${META_DIR}/${name}`,
        seen: () => {
          seen = true;
          resolve();
        },
      };
    });
    const deadline = Date.now() + READY_TIMEOUT_MS;
    try {
      while (!seen && !closed && Date.now() < deadline) {
        await fs.writeFile(file, String(Date.now()));
        await Promise.race([sawProbe, new Promise<void>((resolve) => setTimeout(resolve, 100))]);
      }
    } catch (err) {
      ctx.log.warn(`Watcher probe failed: ${errorMessage(err)}`);
    } finally {
      probe = null;
      await fs.rm(file, { force: true }).catch(() => undefined);
    }
    if (!seen && !closed) ctx.log.warn('File watching did not confirm it is live; edits made on disk may be picked up late. POST /api/reindex reconciles on demand.');
  })();

  return {
    ready,
    async close() {
      closed = true;
      for (const handle of handles) handle.close();
      await ready.catch(() => undefined);
    },
  };
}

function startChokidarBackend(ctx: Ctx, roots: readonly WatchRoot[], onEvent: OnEvent): Backend {
  const watcher: ChokidarWatcher = chokidarWatch(
    roots.map((r) => r.abs),
    {
      ignoreInitial: true,
      followSymlinks: false,
      ignored: (abs: string) => isIgnored(roots, abs),
      ignorePermissionErrors: true,
      atomic: false,
    },
  );
  watcher.on('all', (_event, abs) => {
    for (const hit of rootsOf(roots, abs)) if (hit.inner !== '') onEvent(hit.root, hit.inner);
  });
  watcher.on('error', (err) => ctx.log.warn(`Watcher error: ${errorMessage(err)}`));
  const ready = new Promise<void>((resolve) => {
    watcher.once('ready', () => resolve());
  });
  return { ready, close: () => watcher.close() };
}

/* ───────────────────────── The watcher ───────────────────────── */

/**
 * file events → debounce → `index.syncMany` → SSE. Because the index compares mtime + size,
 * the echo of one of our own API writes reconciles to "no change" and emits nothing.
 */
export function startWatcher(ctx: Ctx, opts: { backend?: WatchBackend } = {}): VaultWatcher {
  // Link targets first, the vault last (the native backend's readiness probe relies on that order).
  const roots: WatchRoot[] = [...(ctx.vault.links ?? []).map((l) => ({ abs: l.realTarget, prefix: l.mount })), { abs: ctx.vault.root, prefix: '' }];
  const kind = opts.backend ?? defaultWatchBackend();
  const pending = new Set<string>();
  const settleDirs = new Set<string>();
  let agentsDirty = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  let settleRounds = 0;
  let firstPendingAt = 0;
  let running: Promise<void> = Promise.resolve();
  let closed = false;

  const armSettle = (): void => {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(settle, SETTLE_MS);
  };

  /**
   * Safety net. Whatever delivered the events can lose some in a burst, and a folder nobody
   * told us about would otherwise stay missing for good. So once a structural burst goes quiet,
   * the folders it touched are walked again; while that keeps finding news, it looks again.
   */
  const settle = (): void => {
    settleTimer = null;
    const targets = topmost([...settleDirs]);
    settleDirs.clear();
    running = running
      .then(async () => {
        if (closed || targets.length === 0) return;
        const changes = await ctx.index.syncMany(targets);
        if (!hasChanges(changes)) {
          settleRounds = 0;
          return;
        }
        ctx.log.info(`Watcher: a follow-up scan of ${targets.map((t) => t || '(vault)').join(', ')} found ${changes.files.length} file change(s) no event had reported.`);
        broadcastChanges(ctx, changes);
        await logExternalActivity(ctx, changes);
        if (settleRounds < MAX_SETTLE_ROUNDS) {
          settleRounds += 1;
          for (const target of targets) settleDirs.add(target);
          armSettle();
        } else {
          settleRounds = 0;
        }
      })
      .catch((err: unknown) => ctx.log.error(`Watcher: ${errorMessage(err)}`));
  };

  const flush = (): void => {
    timer = null;
    firstPendingAt = 0;
    const batch = [...pending];
    pending.clear();
    const reloadAgents = agentsDirty;
    agentsDirty = false;
    running = running
      .then(async () => {
        if (closed) return;
        if (reloadAgents) await ctx.agents.reloadIfChangedExternally();
        if (batch.length === 0) return;
        // Parents before children, so a new folder is walked once rather than once per file inside it.
        batch.sort((a, b) => a.length - b.length);
        const wereDirs = batch.filter((rel) => ctx.index.dirs.has(rel));
        // Syncing a folder reconciles its whole subtree: a new folder never depends on the
        // per-file events for its contents arriving.
        const changes = await ctx.index.syncMany(batch);
        if (!hasChanges(changes)) return;
        broadcastChanges(ctx, changes);
        await logExternalActivity(ctx, changes);
        if (changes.structure) {
          // Folders came or went. Their siblings may have too, without a word: re-walk the parent.
          for (const rel of [...wereDirs, ...batch.filter((r) => ctx.index.dirs.has(r))]) settleDirs.add(relDirname(rel));
          if (settleDirs.size > 0) {
            settleRounds = 0;
            armSettle();
          }
        }
      })
      .catch((err: unknown) => ctx.log.error(`Watcher: ${errorMessage(err)}`));
  };

  const onEvent: OnEvent = (root, rawInner) => {
    if (closed) return;
    const inner = rawInner.normalize('NFC');
    if (root.prefix === '' && inner === AGENTS_FILE) agentsDirty = true;
    else if (inner.split('/').some((segment) => segment.startsWith('.'))) return;
    else pending.add(inner === '' ? root.prefix : root.prefix === '' ? inner : `${root.prefix}/${inner}`);
    const now = Date.now();
    if (firstPendingAt === 0) firstPendingAt = now;
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, Math.max(0, Math.min(DEBOUNCE_MS, firstPendingAt + MAX_WAIT_MS - now)));
  };

  const backend = kind === 'native' ? startNativeBackend(ctx, roots, onEvent) : startChokidarBackend(ctx, roots, onEvent);

  return {
    ready: backend.ready,
    backend: kind,
    async close() {
      closed = true;
      if (timer) clearTimeout(timer);
      if (settleTimer) clearTimeout(settleTimer);
      await backend.close();
      await running;
    },
  };
}
