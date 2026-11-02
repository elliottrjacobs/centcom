import { promises as fs } from 'node:fs';
import path from 'node:path';
import { META_DIR, type Agent, type VaultUser } from '../shared/types.ts';
import { invalid, isErrno, notFound } from './errors.ts';
import { atomicWrite, Mutex, mtimeOf, statOrNull } from './fsutil.ts';

export const FILESYSTEM_AGENT = 'filesystem';
const OWNER_COLOR = '#5E6AD2';

/** Fixed palette; auto-registered agents get a deterministic pick from it. */
export const AGENT_PALETTE = ['#5E6AD2', '#26B5CE', '#4CB782', '#F2C94C', '#F2994A', '#EB5757', '#BB87FC', '#F78FB3', '#95A2B3', '#0F9D8F'] as const;

/** The tools a new vault knows about out of the box. The one human is whoever the config names (see `ownerAgent`). */
const SEED_AGENTS: readonly Agent[] = [
  { id: 'claude-code', name: 'Claude Code', kind: 'agent', color: '#F2994A', lastSeen: null },
  { id: 'codex', name: 'Codex', kind: 'agent', color: '#4CB782', lastSeen: null },
  { id: 'chatgpt', name: 'ChatGPT', kind: 'agent', color: '#0F9D8F', lastSeen: null },
  { id: 'grok', name: 'Grok', kind: 'agent', color: '#95A2B3', lastSeen: null },
  { id: 'cursor', name: 'Cursor', kind: 'agent', color: '#26B5CE', lastSeen: null },
];

/** The generic tools seeded into every vault. They are tools anyone runs, not someone's named agents. */
const TOOL_IDS = '(?:codex|chatgpt|claude(?:-code)?|cursor|grok)';
/**
 * Words that name a machine rather than an agent: common computer and device classes, by
 * product family or by role. Matched as whole hyphen-separated ids, so `research-assistant`
 * and `codex-researcher` stay agents while `mac-mini` or `codex-laptop` read as devices.
 */
const DEVICE_WORDS =
  '(?:(?:mac-?)?mini|mac(?:-?(?:studio|pro))?|macbook(?:-?(?:pro|air))?|imac|iphone|ipad|laptop|desktop|pc|workstation|server|host|vm|devbox|linux|windows)';
const TOOLS = new RegExp(`^(?:${TOOL_IDS}|filesystem)$`);
const DEVICES = new RegExp(`^${DEVICE_WORDS}(?:-\\d+)?$`);
const TOOL_ON_DEVICE = new RegExp(`^${TOOL_IDS}-${DEVICE_WORDS}(?:-\\d+)?$`);

/** The directory is for personal agents; the registry also retains historical tool/device authors. */
export function isPersonalAgent(agent: Pick<Agent, 'id' | 'kind'>): boolean {
  if (agent.kind !== 'agent') return false;
  const id = normalizeAgentId(agent.id);
  return !TOOLS.test(id) && !DEVICES.test(id) && !TOOL_ON_DEVICE.test(id);
}

function ownerAgent(owner: VaultUser): Agent {
  return { id: owner.id, name: owner.name, kind: 'human', color: OWNER_COLOR, lastSeen: null };
}

const AGENT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** Accepts `Claude Code`, `claude_code`, ` CODEX ` … and returns the canonical slug. Throws 400 when hopeless. */
export function normalizeAgentId(input: unknown, field = 'agent'): string {
  if (typeof input !== 'string') throw invalid(`${field} must be a string agent id.`);
  const id = input
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9._-]/g, '')
    .replace(/^[._-]+/, '')
    .slice(0, 64);
  if (!AGENT_ID.test(id)) throw invalid(`${field} "${String(input).slice(0, 80)}" is not a valid agent id (use a slug like "claude-code").`);
  return id;
}

export function titleCaseId(id: string): string {
  return id
    .split(/[-._]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export function colorFor(id: string): string {
  let h = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return AGENT_PALETTE[(h >>> 0) % AGENT_PALETTE.length] as string;
}

function coerceAgent(value: unknown): Agent | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  let id: string;
  try {
    id = normalizeAgentId(v.id);
  } catch {
    return null;
  }
  return {
    id,
    name: typeof v.name === 'string' && v.name.trim() ? v.name.trim() : titleCaseId(id),
    kind: v.kind === 'human' ? 'human' : 'agent',
    color: typeof v.color === 'string' && HEX_COLOR.test(v.color) ? v.color : colorFor(id),
    lastSeen: typeof v.lastSeen === 'number' && Number.isFinite(v.lastSeen) ? v.lastSeen : null,
  };
}

export class AgentRegistry {
  private readonly agents = new Map<string, Agent>();
  private readonly file: string;
  private readonly writeLock = new Mutex();
  private queued = false;
  /** mtime of our own last write, so the watcher can tell an external edit from an echo. */
  lastWrittenMtime = 0;

  constructor(
    vaultRoot: string,
    /** The vault's owner, from config. Never hardcoded: it is the seeded human and the default author. */
    private readonly owner: VaultUser,
    private readonly onChange: () => void,
    private readonly warn: (msg: string) => void,
  ) {
    this.file = path.join(vaultRoot, META_DIR, 'agents.json');
  }

  async load(): Promise<void> {
    this.agents.clear();
    let existed = true;
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const agent = coerceAgent(item);
          if (agent && !this.agents.has(agent.id)) this.agents.set(agent.id, agent);
        }
      } else {
        this.warn(`${this.file} is not an array; starting from the seed agents.`);
      }
    } catch (err) {
      if (isErrno(err, 'ENOENT')) existed = false;
      else this.warn(`Could not read ${this.file}: ${(err as Error).message}. Starting from the seed agents.`);
    }
    let added = false;
    if (!existed || this.agents.size === 0) {
      for (const seed of [ownerAgent(this.owner), ...SEED_AGENTS]) {
        if (!this.agents.has(seed.id)) {
          this.agents.set(seed.id, { ...seed });
          added = true;
        }
      }
    }
    // Writes with no explicit author are attributed to the owner, so the owner is always on the roster
    // as a human (never auto-registered as a bot by a first write). An existing entry is left exactly as it is.
    if (!this.agents.has(this.owner.id)) {
      this.agents.set(this.owner.id, ownerAgent(this.owner));
      added = true;
    }
    if (added || !existed) await this.persist();
  }

  /** Reload after an external edit of agents.json. */
  async reloadIfChangedExternally(): Promise<boolean> {
    const stat = await statOrNull(this.file);
    if (!stat || mtimeOf(stat) === this.lastWrittenMtime) return false;
    this.lastWrittenMtime = mtimeOf(stat);
    await this.load();
    this.onChange();
    return true;
  }

  list(): Agent[] {
    return [...this.agents.values()].sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'human' ? -1 : 1));
  }

  get(id: string): Agent | undefined {
    return this.agents.get(id);
  }

  /** Record activity by `id`, auto-registering unknown agents. */
  touch(id: string, ts: number): void {
    const existing = this.agents.get(id);
    if (!existing) {
      this.agents.set(id, { id, name: titleCaseId(id), kind: 'agent', color: colorFor(id), lastSeen: ts });
      this.onChange();
    } else {
      const previous = existing.lastSeen ?? 0;
      existing.lastSeen = Math.max(previous, ts);
      // Presence updates are chatty; only wake the UI when it would visibly change.
      if (ts - previous > 30_000) this.onChange();
    }
    this.schedulePersist();
  }

  /** Put `id` on the roster without marking it as seen (someone else wrote about it). `name`, when given, becomes its display name. */
  async ensure(id: string, name?: string): Promise<Agent> {
    const existing = this.agents.get(id);
    if (!existing) {
      this.agents.set(id, { id, name: name?.trim().slice(0, 80) || titleCaseId(id), kind: 'agent', color: colorFor(id), lastSeen: null });
    } else if (name !== undefined && name.trim() && name.trim().slice(0, 80) !== existing.name) {
      existing.name = name.trim().slice(0, 80);
    } else {
      return { ...existing };
    }
    await this.persist();
    this.onChange();
    return { ...(this.agents.get(id) as Agent) };
  }

  async patch(id: string, changes: { name?: string | undefined; color?: string | undefined; kind?: 'human' | 'agent' | undefined }): Promise<Agent> {
    const agent = this.agents.get(id);
    if (!agent) throw notFound(`Agent "${id}" not found.`);
    if (changes.name !== undefined) {
      const name = changes.name.trim();
      if (!name) throw invalid('name must not be empty.');
      agent.name = name.slice(0, 80);
    }
    if (changes.color !== undefined) {
      if (!HEX_COLOR.test(changes.color)) throw invalid('color must be a hex colour like #5E6AD2.');
      agent.color = changes.color;
    }
    if (changes.kind !== undefined) agent.kind = changes.kind;
    await this.persist();
    this.onChange();
    return { ...agent };
  }

  /** Resolves once everything touched so far is on disk. */
  async flush(): Promise<void> {
    await this.writeLock.run(() => undefined);
  }

  private schedulePersist(): void {
    // A queued write serialises the state at the time it runs, so one is enough.
    if (this.queued) return;
    this.queued = true;
    void this.writeLock
      .run(async () => {
        this.queued = false;
        await this.writeNow();
      })
      .catch((err: unknown) => this.warn(`Could not save agents.json: ${(err as Error).message}`));
  }

  private persist(): Promise<void> {
    return this.writeLock.run(() => this.writeNow());
  }

  private async writeNow(): Promise<void> {
    const stat = await atomicWrite(this.file, `${JSON.stringify(this.list(), null, 2)}\n`);
    this.lastWrittenMtime = mtimeOf(stat);
  }
}
