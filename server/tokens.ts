/**
 * Named, scoped tokens. Every client gets its own, so a leak is one revocation instead of a
 * fleet-wide rotation, and so the server knows who is writing instead of taking their word for it.
 *
 * `<configDir>/tokens.json` (0600) holds only SHA-256 hashes. The token in `config.json` is the
 * **owner** token: it keeps working exactly as before (all scopes, may act as any agent), so
 * nothing breaks on upgrade. Tokens created here are bound to one agent id: writes are recorded
 * as that agent, and a request claiming to be anyone else is refused.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { TOKEN_SCOPES, type TokenInfo, type TokenScope } from '../shared/types.ts';
import { normalizeAgentId } from './agents.ts';
import { errorMessage, invalid, isErrno, notFound } from './errors.ts';
import { Mutex, writePrivateFile } from './fsutil.ts';

export const TOKENS_FILE = 'tokens.json';
export const OWNER_TOKEN_ID = 'owner';
/** The implicit principal of a loopback request when `requireTokenOnLoopback` is off. */
export const LOOPBACK_TOKEN_ID = 'loopback';

/** Who a request is, once the gate has authenticated it. */
export interface Principal {
  tokenId: string;
  /** The only agent id this caller may write as; null = any (the owner token, loopback). */
  agent: string | null;
  scopes: readonly TokenScope[];
  /** Project slugs this caller is confined to; null = all. */
  projects: readonly string[] | null;
  /** With `write:instructions`: whose instructions it may write (ids, or `prefix*`); null = anyone's. */
  instructionAgents: readonly string[] | null;
  /** Owner token or trusted loopback: may manage tokens and write any agent's instructions. */
  owner: boolean;
}

export const OWNER_PRINCIPAL: Principal = Object.freeze({ tokenId: OWNER_TOKEN_ID, agent: null, scopes: TOKEN_SCOPES, projects: null, instructionAgents: null, owner: true });
export const LOOPBACK_PRINCIPAL: Principal = Object.freeze({ tokenId: LOOPBACK_TOKEN_ID, agent: null, scopes: TOKEN_SCOPES, projects: null, instructionAgents: null, owner: true });

/** `grokbot-*` → itself; `Research Bot` → `research-bot`. Throws 400 on anything else. */
export function normalizeAgentPattern(raw: string): string {
  const value = raw.trim();
  if (value.endsWith('*')) return `${normalizeAgentId(value.slice(0, -1), 'instructionAgents')}*`;
  return normalizeAgentId(value, 'instructionAgents');
}

export function agentMatches(patterns: readonly string[] | null, id: string): boolean {
  if (patterns === null) return true;
  return patterns.some((p) => (p.endsWith('*') ? id.startsWith(p.slice(0, -1)) : id === p));
}

interface StoredToken extends TokenInfo {
  /** SHA-256 (hex) of the token. The token itself is shown once, at creation, and never stored. */
  hash: string;
}

const PERSIST_LAST_USED_MS = 60 * 60 * 1000;
const MAX_LABEL = 100;

export const hashToken = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

export function newTokenSecret(): string {
  return randomBytes(32).toString('hex');
}

function coerce(value: unknown): StoredToken | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || !/^tok_[0-9a-f]{12}$/.test(v.id) || typeof v.hash !== 'string' || !/^[0-9a-f]{64}$/.test(v.hash)) return null;
  const scopes = Array.isArray(v.scopes) ? v.scopes.filter((s): s is TokenScope => (TOKEN_SCOPES as readonly unknown[]).includes(s)) : [];
  let agent: string;
  try {
    agent = normalizeAgentId(v.agent);
  } catch {
    return null;
  }
  return {
    id: v.id,
    hash: v.hash,
    label: typeof v.label === 'string' ? v.label.slice(0, MAX_LABEL) : v.id,
    agent,
    scopes,
    projects: Array.isArray(v.projects) ? v.projects.filter((p): p is string => typeof p === 'string' && p.length > 0) : null,
    instructionAgents: Array.isArray(v.instructionAgents) ? v.instructionAgents.filter((p): p is string => typeof p === 'string' && p.length > 0) : null,
    created: typeof v.created === 'number' ? v.created : 0,
    lastUsed: typeof v.lastUsed === 'number' ? v.lastUsed : null,
    owner: false,
  };
}

export interface CreateTokenOptions {
  label: string;
  agent: string;
  scopes: readonly string[];
  /** Project slugs (already resolved by the caller); omit or null for every project. */
  projects?: readonly string[] | null;
  /** With `write:instructions`: whose instructions (ids or `prefix*`); omit or null for anyone's. */
  instructionAgents?: readonly string[] | null;
}

export class TokenStore {
  private readonly tokens = new Map<string, StoredToken>();
  private readonly persistedLastUsed = new Map<string, number>();
  private readonly writeLock = new Mutex();
  private ownerHash: Buffer;
  private queued = false;

  constructor(
    private readonly file: string,
    ownerToken: string,
    private readonly warn: (msg: string) => void,
  ) {
    this.ownerHash = Buffer.from(hashToken(ownerToken), 'hex');
  }

  static inDir(configDir: string, ownerToken: string, warn: (msg: string) => void): TokenStore {
    return new TokenStore(path.join(configDir, TOKENS_FILE), ownerToken, warn);
  }

  async load(): Promise<void> {
    this.tokens.clear();
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(this.file, 'utf8'));
    } catch (err) {
      if (!isErrno(err, 'ENOENT')) this.warn(`Could not read ${this.file}: ${errorMessage(err)}. Only the owner token will work until it is fixed.`);
      return;
    }
    for (const item of Array.isArray(parsed) ? parsed : []) {
      const t = coerce(item);
      if (t && !this.tokens.has(t.id)) {
        this.tokens.set(t.id, t);
        this.persistedLastUsed.set(t.id, t.lastUsed ?? 0);
      }
    }
  }

  /** The principal for a presented token, or null. Hash first, then compare in constant time. */
  verify(presented: string | undefined | null, now = Date.now()): Principal | null {
    if (typeof presented !== 'string' || presented.length === 0 || presented.length > 512) return null;
    const hash = Buffer.from(hashToken(presented), 'hex');
    if (timingSafeEqual(hash, this.ownerHash)) return OWNER_PRINCIPAL;
    for (const t of this.tokens.values()) {
      if (timingSafeEqual(hash, Buffer.from(t.hash, 'hex'))) {
        t.lastUsed = now;
        if (now - (this.persistedLastUsed.get(t.id) ?? 0) >= PERSIST_LAST_USED_MS) this.schedulePersist();
        return principalOf(t);
      }
    }
    return null;
  }

  /** The principal behind a token id (sessions remember the id, never the token). */
  byId(id: string): Principal | null {
    if (id === OWNER_TOKEN_ID) return OWNER_PRINCIPAL;
    const t = this.tokens.get(id);
    return t ? principalOf(t) : null;
  }

  /** True when `text` contains any live token: owner or named. Tokens are 64 hex characters. */
  mentionedIn(text: string): boolean {
    for (const m of text.matchAll(/[0-9a-f]{64}/gi)) {
      const hash = Buffer.from(hashToken(m[0].toLowerCase()), 'hex');
      if (timingSafeEqual(hash, this.ownerHash)) return true;
      for (const t of this.tokens.values()) if (timingSafeEqual(hash, Buffer.from(t.hash, 'hex'))) return true;
    }
    return false;
  }

  list(): TokenInfo[] {
    const named = [...this.tokens.values()].map(({ hash: _hash, ...info }) => ({
      ...info,
      projects: info.projects ? [...info.projects] : null,
      instructionAgents: info.instructionAgents ? [...info.instructionAgents] : null,
      scopes: [...info.scopes],
    }));
    return [
      { id: OWNER_TOKEN_ID, label: 'Owner token (config.json)', agent: null, scopes: [...TOKEN_SCOPES], projects: null, instructionAgents: null, created: 0, lastUsed: null, owner: true },
      ...named.sort((a, b) => a.created - b.created),
    ];
  }

  /** A new token. The secret is returned exactly once; only its hash is kept. */
  async create(opts: CreateTokenOptions, now = Date.now()): Promise<{ token: string; info: TokenInfo }> {
    const label = opts.label.trim().slice(0, MAX_LABEL);
    if (!label) throw invalid('label is required: say which device or agent will hold this token.');
    const agent = normalizeAgentId(opts.agent);
    const scopes = [...new Set(opts.scopes)];
    const unknown = scopes.filter((s) => !(TOKEN_SCOPES as readonly string[]).includes(s));
    if (unknown.length > 0) throw invalid(`Unknown scope ${unknown.join(', ')}. Scopes: ${TOKEN_SCOPES.join(', ')}.`);
    if (scopes.length === 0) throw invalid(`Give the token at least one scope: ${TOKEN_SCOPES.join(', ')}.`);
    if ((scopes.includes('write') || scopes.includes('write:instructions')) && !scopes.includes('read')) scopes.unshift('read');
    const projects = opts.projects && opts.projects.length > 0 ? [...new Set(opts.projects)] : null;
    const patterns = opts.instructionAgents && opts.instructionAgents.length > 0 ? [...new Set(opts.instructionAgents.map(normalizeAgentPattern))] : null;
    if (patterns && !scopes.includes('write:instructions')) throw invalid('instructionAgents only means something with the write:instructions scope.');
    const token = newTokenSecret();
    const stored: StoredToken = {
      id: `tok_${randomBytes(6).toString('hex')}`,
      hash: hashToken(token),
      label,
      agent,
      scopes: scopes as TokenScope[],
      projects,
      instructionAgents: patterns,
      created: now,
      lastUsed: null,
      owner: false,
    };
    this.tokens.set(stored.id, stored);
    await this.persistNow();
    const { hash: _hash, ...info } = stored;
    return { token, info };
  }

  async revoke(id: string): Promise<TokenInfo> {
    if (id === OWNER_TOKEN_ID) throw invalid('The owner token lives in config.json; it cannot be revoked here.');
    const t = this.tokens.get(id);
    if (!t) throw notFound(`No token "${id}".`);
    this.tokens.delete(id);
    await this.persistNow();
    const { hash: _hash, ...info } = t;
    return info;
  }

  has(id: string): boolean {
    return id === OWNER_TOKEN_ID || this.tokens.has(id);
  }

  async flush(): Promise<void> {
    await this.writeLock.run(() => undefined);
  }

  private async write(): Promise<void> {
    const list = [...this.tokens.values()];
    await writePrivateFile(this.file, `${JSON.stringify(list, null, 2)}\n`);
    for (const t of list) this.persistedLastUsed.set(t.id, t.lastUsed ?? 0);
  }

  private persistNow(): Promise<void> {
    return this.writeLock.run(() => this.write());
  }

  private schedulePersist(): void {
    if (this.queued) return;
    this.queued = true;
    void this.writeLock
      .run(async () => {
        this.queued = false;
        await this.write();
      })
      .catch((err: unknown) => this.warn(`Could not save ${this.file}: ${errorMessage(err)}`));
  }
}

function principalOf(t: StoredToken): Principal {
  return {
    tokenId: t.id,
    agent: t.agent,
    scopes: [...t.scopes],
    projects: t.projects ? [...t.projects] : null,
    instructionAgents: t.instructionAgents ? [...t.instructionAgents] : null,
    owner: false,
  };
}

/**
 * May this caller change `targetId`'s profile (its instructions) or deliverables? The owner may
 * change anyone's. A named token may change its own with `write`, and someone else's only with
 * `write:instructions`, and then only agents its `instructionAgents` patterns allow.
 */
export function mayWriteInstructions(p: Principal, targetId: string): boolean {
  if (p.owner) return true;
  if (p.agent === targetId && (hasScope(p, 'write') || hasScope(p, 'write:instructions'))) return true;
  return hasScope(p, 'write:instructions') && agentMatches(p.instructionAgents, targetId);
}

export function hasScope(p: Principal, scope: TokenScope): boolean {
  return p.scopes.includes(scope);
}
