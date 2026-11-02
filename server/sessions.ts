/**
 * Browser sessions. The UI trades a token for an HttpOnly cookie once, on the Connect screen,
 * so the token never sits in page storage and never rides in a URL (`<img>`, EventSource).
 *
 * Only a SHA-256 of each session id is stored (`<configDir>/sessions.json`, 0600): the file
 * cannot be replayed. A session lives at most 30 days and dies after 7 days unused.
 */
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { errorMessage, isErrno } from './errors.ts';
import { Mutex, writePrivateFile } from './fsutil.ts';

export const SESSION_COOKIE = '__Host-centcom_session';
/** Plain-http loopback only: browsers refuse `__Host-` (and `Secure`) cookies on http origins. */
export const LOOPBACK_SESSION_COOKIE = 'centcom_session';
export const SESSION_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_MAX_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSIONS_FILE = 'sessions.json';

/** How often a sliding `lastSeen` is written back; reads in between only move it in memory. */
const PERSIST_LAST_SEEN_MS = 60 * 60 * 1000;
const SESSION_ID = /^[A-Za-z0-9_-]{43}$/;

export interface SessionRecord {
  /** SHA-256 (hex) of the session id. The id itself exists only in the browser's cookie jar. */
  hash: string;
  /** The token this session was opened with; revoking that token ends the session. */
  tokenId: string;
  created: number;
  lastSeen: number;
  userAgent: string;
}

const hashOf = (id: string): string => createHash('sha256').update(id, 'utf8').digest('hex');

function coerce(value: unknown): SessionRecord | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.hash !== 'string' || !/^[0-9a-f]{64}$/.test(v.hash) || typeof v.tokenId !== 'string' || !v.tokenId) return null;
  if (typeof v.created !== 'number' || typeof v.lastSeen !== 'number') return null;
  return { hash: v.hash, tokenId: v.tokenId, created: v.created, lastSeen: v.lastSeen, userAgent: typeof v.userAgent === 'string' ? v.userAgent.slice(0, 300) : '' };
}

export function sessionExpired(s: Pick<SessionRecord, 'created' | 'lastSeen'>, now: number): boolean {
  return now - s.created >= SESSION_MAX_MS || now - s.lastSeen >= SESSION_IDLE_MS;
}

export class SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly writeLock = new Mutex();
  private readonly persistedLastSeen = new Map<string, number>();
  private queued = false;

  constructor(
    private readonly file: string,
    private readonly warn: (msg: string) => void,
  ) {}

  static inDir(configDir: string, warn: (msg: string) => void): SessionStore {
    return new SessionStore(path.join(configDir, SESSIONS_FILE), warn);
  }

  async load(now = Date.now()): Promise<void> {
    this.sessions.clear();
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(this.file, 'utf8'));
    } catch (err) {
      if (!isErrno(err, 'ENOENT')) this.warn(`Could not read ${this.file}: ${errorMessage(err)}. Every browser will need to connect again.`);
      return;
    }
    let dropped = false;
    for (const item of Array.isArray(parsed) ? parsed : []) {
      const s = coerce(item);
      if (s && !sessionExpired(s, now)) {
        this.sessions.set(s.hash, s);
        this.persistedLastSeen.set(s.hash, s.lastSeen);
      } else dropped = true;
    }
    if (dropped) this.schedulePersist();
  }

  /** A new session for `tokenId`. Returns the id for the cookie; only its hash is kept. */
  create(tokenId: string, userAgent: string | undefined, now = Date.now()): { id: string; record: SessionRecord } {
    const id = randomBytes(32).toString('base64url');
    const record: SessionRecord = { hash: hashOf(id), tokenId, created: now, lastSeen: now, userAgent: (userAgent ?? '').slice(0, 300) };
    this.sessions.set(record.hash, record);
    this.schedulePersist();
    return { id, record };
  }

  /** The live session for a cookie value, sliding its idle timeout. Expired sessions are removed. */
  lookup(id: string, now = Date.now()): SessionRecord | null {
    if (!SESSION_ID.test(id)) return null;
    const hash = hashOf(id);
    const s = this.sessions.get(hash);
    if (!s) return null;
    if (sessionExpired(s, now)) {
      this.sessions.delete(hash);
      this.schedulePersist();
      return null;
    }
    s.lastSeen = now;
    if (now - (this.persistedLastSeen.get(hash) ?? 0) >= PERSIST_LAST_SEEN_MS) this.schedulePersist();
    return { ...s };
  }

  revoke(id: string): boolean {
    if (!SESSION_ID.test(id)) return false;
    const removed = this.sessions.delete(hashOf(id));
    if (removed) this.schedulePersist();
    return removed;
  }

  /** End every session opened with `tokenId` (the token was revoked or rotated). */
  revokeToken(tokenId: string): number {
    let n = 0;
    for (const [hash, s] of this.sessions) {
      if (s.tokenId === tokenId) {
        this.sessions.delete(hash);
        n += 1;
      }
    }
    if (n > 0) this.schedulePersist();
    return n;
  }

  /** Keep only sessions whose token still exists. */
  retainTokens(live: (tokenId: string) => boolean): number {
    let n = 0;
    for (const [hash, s] of this.sessions) {
      if (!live(s.tokenId)) {
        this.sessions.delete(hash);
        n += 1;
      }
    }
    if (n > 0) this.schedulePersist();
    return n;
  }

  list(): SessionRecord[] {
    return [...this.sessions.values()].map((s) => ({ ...s }));
  }

  async flush(): Promise<void> {
    await this.writeLock.run(() => undefined);
  }

  private schedulePersist(): void {
    if (this.queued) return;
    this.queued = true;
    void this.writeLock
      .run(async () => {
        this.queued = false;
        const list = [...this.sessions.values()];
        await writePrivateFile(this.file, `${JSON.stringify(list, null, 2)}\n`);
        for (const s of list) this.persistedLastSeen.set(s.hash, s.lastSeen);
      })
      .catch((err: unknown) => this.warn(`Could not save ${this.file}: ${errorMessage(err)}`));
  }
}

/* ───────────────────────── Cookies ───────────────────────── */

/**
 * `secure` is false only for a browser talking plain http to loopback (`http://127.0.0.1`),
 * where a `Secure` or `__Host-` cookie would simply be dropped. Everything else, including any
 * request that came through a proxy, gets the full `__Host-` form.
 */
export function sessionCookie(id: string, secure: boolean): string {
  const name = secure ? SESSION_COOKIE : LOOPBACK_SESSION_COOKIE;
  return `${name}=${id}; HttpOnly; ${secure ? 'Secure; ' : ''}SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_MS / 1000}`;
}

export function clearSessionCookies(secure: boolean): string[] {
  const clear = (name: string, withSecure: boolean) => `${name}=; HttpOnly; ${withSecure ? 'Secure; ' : ''}SameSite=Strict; Path=/; Max-Age=0`;
  return secure ? [clear(SESSION_COOKIE, true)] : [clear(SESSION_COOKIE, true), clear(LOOPBACK_SESSION_COOKIE, false)];
}

/** The session id the browser presented, if any. The plain-named cookie counts only on plain-http loopback. */
export function readSessionCookie(header: string | string[] | undefined, plainLoopback: boolean): string | null {
  const raw = Array.isArray(header) ? header.join('; ') : header;
  if (!raw) return null;
  let plain: string | null = null;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name === SESSION_COOKIE && value) return value;
    if (name === LOOPBACK_SESSION_COOKIE && value && plainLoopback) plain = value;
  }
  return plain;
}

/* ───────────────────────── /api/session ───────────────────────── */

export interface SessionEndpointDeps {
  store: SessionStore;
  /** The token's id when `presented` is a live token, else null. Constant-time. */
  verifyToken: (presented: string) => { tokenId: string } | null;
  /** True when this peer has failed authentication too often recently. */
  limited: () => boolean;
  /** Count one failed attempt from this peer. */
  fail: (reason: string) => void;
  /** Plain-http loopback (no proxy): the only case where the cookie is not `Secure`. */
  plainLoopback: boolean;
  /** How the gate authenticated this request (GET only reaches here when it did). */
  via: string;
  /** The Origin header, already checked against the allow-list by the gate. */
  origin: string | undefined;
}

const MAX_SESSION_BODY = 4096;

function send(res: ServerResponse, status: number, body: unknown, cookies: string[] = [], extra: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...(cookies.length > 0 ? { 'Set-Cookie': cookies } : {}),
    ...extra,
  });
  res.end(text);
}

async function readSmallJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buf.length;
    if (size > MAX_SESSION_BODY) throw new Error('too large');
    chunks.push(buf);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

/**
 * `POST` opens a session from `{ token }`, `DELETE` ends the one in the cookie, `GET` says how
 * this request was authenticated. POST and DELETE are reachable without credentials (they are
 * how you get or drop one), so they insist on an allow-listed Origin: only the CENTCOM UI
 * itself may call them.
 */
export async function handleSessionRequest(req: IncomingMessage, res: ServerResponse, deps: SessionEndpointDeps): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  const cookie = readSessionCookie(req.headers.cookie, deps.plainLoopback);

  if (method === 'GET') {
    const session = cookie ? deps.store.lookup(cookie) : null;
    send(res, 200, { via: deps.via, session: session ? { created: session.created, lastSeen: session.lastSeen, expires: Math.min(session.created + SESSION_MAX_MS, session.lastSeen + SESSION_IDLE_MS) } : null });
    return;
  }
  if (method !== 'POST' && method !== 'DELETE') {
    send(res, 405, { error: 'Use POST to connect or DELETE to disconnect.', code: 'invalid' }, [], { Allow: 'GET, POST, DELETE' });
    return;
  }
  if (deps.origin === undefined) {
    send(res, 403, { error: 'Sessions are only for the CENTCOM web UI. Other clients send Authorization: Bearer <token>.', code: 'forbidden' });
    return;
  }

  if (method === 'DELETE') {
    if (cookie) deps.store.revoke(cookie);
    send(res, 200, { ok: true }, clearSessionCookies(!deps.plainLoopback));
    return;
  }

  if (deps.limited()) {
    send(res, 429, { error: 'Too many failed attempts. Wait a few minutes and try again.', code: 'forbidden' }, [], { 'Retry-After': '900' });
    return;
  }
  let token: unknown;
  try {
    token = (await readSmallJson(req) as { token?: unknown } | null)?.token;
  } catch {
    send(res, 400, { error: 'Send {"token": "<server token>"} as JSON.', code: 'invalid' });
    return;
  }
  const match = typeof token === 'string' ? deps.verifyToken(token.trim()) : null;
  if (!match) {
    deps.fail('session: invalid token');
    send(res, 401, { error: 'That token is not valid for this server.', code: 'forbidden' });
    return;
  }
  const { id, record } = deps.store.create(match.tokenId, typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined);
  send(res, 201, { ok: true, expires: record.created + SESSION_MAX_MS }, [sessionCookie(id, !deps.plainLoopback)]);
}
