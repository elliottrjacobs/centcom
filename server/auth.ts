import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { ApiError } from '../shared/types.ts';
import { clearSessionCookies, readSessionCookie, type SessionRecord } from './sessions.ts';
import { LOOPBACK_PRINCIPAL, type Principal } from './tokens.ts';

/** Vite dev server origins (see vite.config.ts). */
export const DEV_ORIGINS = ['http://localhost:5179', 'http://127.0.0.1:5179'] as const;

export interface SecurityConfig {
  /** Host the server was asked to bind (config value, not the resolved address). */
  host: string;
  /** Actual listening port. */
  port: number;
  /** Resolves presented tokens (owner and named) and session token ids to principals. */
  tokens: { verify(presented: string): Principal | null; byId(id: string): Principal | null };
  /** Loopback peers must authenticate too. Off for installs that predate it; on for new ones. */
  requireTokenOnLoopback?: boolean;
  /** Extra browser origins allowed for remote access. */
  remoteOrigins: string[];
  /** Honour `?token=` on GET /api/raw/* and /api/events. Off by default; browsers use a session cookie. */
  legacyQueryToken?: boolean;
  /** Browser sessions (see `server/sessions.ts`). Without it, cookies are ignored. */
  sessions?: { lookup(id: string): SessionRecord | null };
}

/* ───────────────────────── Loopback detection ───────────────────────── */

export function isLoopbackAddress(addr: string | undefined | null): boolean {
  if (!addr) return false;
  let a = addr.trim().toLowerCase();
  if (a.startsWith('[') && a.endsWith(']')) a = a.slice(1, -1);
  const zone = a.indexOf('%');
  if (zone !== -1) a = a.slice(0, zone);
  if (a === '::1' || a === '0:0:0:0:0:0:0:1') return true;
  if (a.startsWith('::ffff:')) a = a.slice('::ffff:'.length);
  return /^127(\.\d{1,3}){3}$/.test(a);
}

/** True for host *names* that can only ever mean this machine. */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === 'localhost' || isLoopbackAddress(h);
}

/* ───────────────────────── Token ───────────────────────── */

/** Constant-time comparison. Hashing first equalises length without leaking it. */
export function tokensMatch(presented: string | undefined | null, expected: string): boolean {
  if (typeof presented !== 'string' || presented.length === 0 || expected.length === 0) return false;
  const a = createHash('sha256').update(presented, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const m = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header);
  return m?.[1];
}

/** `?token=` was honoured only where a browser cannot set headers (now behind `legacyQueryToken`). */
export function queryTokenAllowed(method: string, pathname: string): boolean {
  if (method.toUpperCase() !== 'GET') return false;
  return pathname === '/api/events' || pathname.startsWith('/api/raw/');
}

/** Restricting rules match generously: case-folded, with runs of slashes collapsed. */
function canonical(pathname: string): string {
  return pathname.toLowerCase().replace(/\/{2,}/g, '/');
}

/** Paths that require auth for non-loopback peers. The static UI shell is public; it holds no data. */
export function isProtectedPath(pathname: string): boolean {
  const p = canonical(pathname);
  return p === '/api' || p.startsWith('/api/') || p === '/mcp' || p.startsWith('/mcp/');
}

/**
 * Endpoints that only this machine may call, *even with a valid token*. Reloading links makes
 * the server follow whatever the local config says; a remote token-holder must never be able
 * to trigger or time that.
 */
export function isLoopbackOnlyPath(pathname: string): boolean {
  const p = canonical(pathname).replace(/\/+$/, '');
  return p === '/api/connection' || p === '/api/links' || p.startsWith('/api/links/');
}

/**
 * `POST /api/session` (connect) and `DELETE /api/session` (disconnect) are how a browser gets or
 * drops a credential, so they cannot require one. Exact spelling only: relaxing rules never match
 * generously. The handler itself checks the token and the Origin.
 */
export function isSessionEndpoint(method: string, pathname: string): boolean {
  const m = method.toUpperCase();
  return (m === 'POST' || m === 'DELETE') && pathname === '/api/session';
}

export interface AuthInput {
  remoteAddress: string | undefined | null;
  /** True when the request passed through a proxy (X-Forwarded-For & co). The socket peer is then meaningless. */
  forwarded: boolean;
  method: string;
  pathname: string;
  /**
   * Other spellings of the same path (percent-decoded, dot-segments resolved). A rule that
   * restricts applies if ANY spelling matches; a rule that relaxes applies only if ALL do.
   */
  variants?: readonly string[];
  authorization: string | undefined;
  queryToken: string | undefined | null;
  /** The principal for a presented token, or null. */
  verify: (presented: string) => Principal | null;
  /** The browser session cookie: none, a live session (and whose token opened it), or one that is unknown or expired. */
  session?: { state: 'absent' } | { state: 'valid'; principal: Principal } | { state: 'invalid' };
  legacyQueryToken?: boolean;
  requireTokenOnLoopback?: boolean;
}

export type AuthVia = 'loopback' | 'bearer' | 'cookie' | 'query' | 'public';
export type AuthDecision =
  | { ok: true; via: AuthVia; principal: Principal | null }
  | { ok: false; status: 401 | 403; message: string; clearSession?: true };

type Credential =
  | { kind: 'none' }
  | { kind: 'ok'; via: 'bearer' | 'cookie' | 'query'; principal: Principal }
  | { kind: 'bad'; status: 401; message: string; clearSession?: true };

/** What the request presents, judged on its own: a bearer wins, then a session cookie, then (legacy) `?token=`. */
function presentedCredential(input: AuthInput, paths: readonly string[]): Credential {
  const bearer = bearerToken(input.authorization);
  if (bearer !== undefined) {
    const principal = input.verify(bearer);
    return principal ? { kind: 'ok', via: 'bearer', principal } : { kind: 'bad', status: 401, message: 'Invalid token.' };
  }
  const session = input.session ?? { state: 'absent' };
  if (session.state === 'valid') return { kind: 'ok', via: 'cookie', principal: session.principal };
  if (session.state === 'invalid') return { kind: 'bad', status: 401, message: 'Your session has expired. Connect again with a server token.', clearSession: true };
  if (input.queryToken) {
    if (!input.legacyQueryToken) {
      return { kind: 'bad', status: 401, message: '?token= is no longer accepted. Send Authorization: Bearer <token>, or connect through the CENTCOM web UI.' };
    }
    if (!paths.every((p) => queryTokenAllowed(input.method, p))) {
      return { kind: 'bad', status: 401, message: '?token= is only accepted on GET /api/raw/* and GET /api/events. Use an Authorization: Bearer header.' };
    }
    const principal = input.verify(input.queryToken);
    return principal ? { kind: 'ok', via: 'query', principal } : { kind: 'bad', status: 401, message: 'Invalid token.' };
  }
  return { kind: 'none' };
}

/**
 * The authentication decision, isolated so it can be unit-tested without sockets.
 *
 * A request that presents a valid token or session is that token's principal, wherever it comes
 * from, so a scoped token is bound to its agent even on loopback. Otherwise loopback peers are
 * trusted (unless `requireTokenOnLoopback`), and everyone else is refused. Loopback-only
 * endpoints refuse every remote caller outright; with `requireTokenOnLoopback` they also need
 * the owner. `POST`/`DELETE /api/session` are reachable without a credential (they are how a
 * browser gets or drops one).
 */
export function decideAuth(input: AuthInput): AuthDecision {
  const paths = [input.pathname, ...(input.variants ?? [])];
  const isLoopbackPeer = !input.forwarded && isLoopbackAddress(input.remoteAddress);
  const trustedLoopback = isLoopbackPeer && input.requireTokenOnLoopback !== true;
  const refuse = (c: Extract<Credential, { kind: 'bad' }>): AuthDecision => ({ ok: false, status: c.status, message: c.message, ...(c.clearSession ? { clearSession: true as const } : {}) });

  if (paths.some(isLoopbackOnlyPath)) {
    if (!isLoopbackPeer) return { ok: false, status: 403, message: 'This endpoint can only be called from the machine CENTCOM runs on.' };
    if (trustedLoopback) return { ok: true, via: 'loopback', principal: LOOPBACK_PRINCIPAL };
    const cred = presentedCredential(input, paths);
    if (cred.kind === 'bad') return refuse(cred);
    if (cred.kind === 'none') return { ok: false, status: 401, message: 'This server requires a token from local clients too. Send Authorization: Bearer <token>.' };
    return cred.principal.owner ? { ok: true, via: cred.via, principal: cred.principal } : { ok: false, status: 403, message: 'Only the owner token can use this endpoint.' };
  }
  if (!paths.some(isProtectedPath)) return { ok: true, via: 'public', principal: null };
  if (paths.every((p) => isSessionEndpoint(input.method, p))) return { ok: true, via: 'public', principal: null };

  const cred = presentedCredential(input, paths);
  if (cred.kind === 'ok') return { ok: true, via: cred.via, principal: cred.principal };
  // Loopback trust predates tokens: a stale credential from a local client falls back to it
  // rather than breaking that client, exactly as before tokens were checked on loopback.
  if (trustedLoopback) return { ok: true, via: 'loopback', principal: LOOPBACK_PRINCIPAL };
  if (cred.kind === 'bad') return refuse(cred);
  return {
    ok: false,
    status: 401,
    message: isLoopbackPeer ? 'This server requires a token from local clients too. Send Authorization: Bearer <token>.' : 'A token is required for non-loopback clients. Send Authorization: Bearer <token>.',
  };
}

/**
 * Why binding `host` would be unsafe, or null. Off loopback, bearer tokens and session cookies
 * cross the network: that is only acceptable behind TLS, which the configured `https://` remote
 * origin attests to. `CENTCOM_ALLOW_INSECURE_REMOTE=1` is the explicit escape hatch.
 */
export function remoteBindProblem(host: string, remoteOrigins: readonly string[], allowInsecure: boolean): string | null {
  if (isLoopbackHost(host) || allowInsecure) return null;
  if (remoteOrigins.some((o) => o.toLowerCase().startsWith('https://'))) return null;
  return (
    `Refusing to listen on ${host}: tokens would cross the network over plain HTTP. ` +
    'Put CENTCOM behind HTTPS (Tailscale Serve, Cloudflare Tunnel or a reverse proxy) and add its https:// origin to remoteOrigin in config.json, ' +
    'or keep host at 127.0.0.1. To run without TLS on an isolated test network anyway, set CENTCOM_ALLOW_INSECURE_REMOTE=1.'
  );
}

/* ───────────────────────── Host / Origin ───────────────────────── */

/** Split a Host header into hostname + port. Returns null when it is not a plain authority. */
export function parseHostHeader(header: string | undefined): { hostname: string; port: string | null } | null {
  if (!header) return null;
  const value = header.trim().toLowerCase();
  if (!value || /[\s/@?#\\]/.test(value)) return null;
  if (value.startsWith('[')) {
    const m = /^(\[[0-9a-f:.%]+\])(?::(\d{1,5}))?$/.exec(value);
    return m ? { hostname: m[1] as string, port: m[2] ?? null } : null;
  }
  const m = /^([^:]+)(?::(\d{1,5}))?$/.exec(value);
  return m ? { hostname: m[1] as string, port: m[2] ?? null } : null;
}

function bracketless(host: string): string {
  const h = host.trim().toLowerCase();
  return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
}

/** Anti DNS-rebinding: the Host header must name this machine or the configured host (any port). */
export function isAllowedHost(header: string | undefined, sec: Pick<SecurityConfig, 'host' | 'remoteOrigins'>): boolean {
  const parsed = parseHostHeader(header);
  if (!parsed) return false;
  const name = bracketless(parsed.hostname);
  if (name === '127.0.0.1' || name === 'localhost' || name === '::1') return true;
  const configured = bracketless(sec.host);
  // A wildcard bind address is not a name anyone can legitimately put in a Host header.
  if (configured && configured !== '0.0.0.0' && configured !== '::' && name === configured) return true;
  for (const origin of sec.remoteOrigins) {
    try {
      if (bracketless(new URL(origin).hostname) === name) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

export function allowedOrigins(sec: Pick<SecurityConfig, 'host' | 'port' | 'remoteOrigins'>): Set<string> {
  const set = new Set<string>([`http://127.0.0.1:${sec.port}`, `http://localhost:${sec.port}`, ...DEV_ORIGINS]);
  const configured = bracketless(sec.host);
  if (configured && !isLoopbackHost(configured) && configured !== '0.0.0.0' && configured !== '::') {
    const authority = configured.includes(':') ? `[${configured}]` : configured;
    set.add(`http://${authority}:${sec.port}`);
  }
  for (const origin of sec.remoteOrigins) set.add(origin);
  return set;
}

/** Anti-CSRF: no Origin header passes (curl, CLI, MCP); a present Origin must be on the allow-list. */
export function isAllowedOrigin(origin: string | undefined, sec: Pick<SecurityConfig, 'host' | 'port' | 'remoteOrigins'>): boolean {
  if (origin === undefined) return true;
  const value = origin.trim().toLowerCase();
  if (!value || value === 'null') return false;
  return allowedOrigins(sec).has(value);
}

/* ───────────────────────── The gate ───────────────────────── */

/** What the gate concluded about a request. Attached to the IncomingMessage so routes can double-check it. */
export interface GateVerdict {
  via: AuthVia | 'preflight';
  /** The peer is provably this machine (loopback socket, not proxied). */
  loopback: boolean;
  /** Who the request is: null only for public paths and preflights. */
  principal: Principal | null;
  /** The browser session that authenticated the request (`via: 'cookie'`). */
  session?: SessionRecord;
}

const VERDICT = Symbol.for('centcom.gateVerdict');

export function gateVerdictOf(req: IncomingMessage | undefined): GateVerdict | undefined {
  return req ? (req as unknown as Record<symbol, GateVerdict | undefined>)[VERDICT] : undefined;
}

export type GateResult =
  | { ok: true; origin: string | undefined; verdict: GateVerdict }
  | { ok: false; status: 400 | 401 | 403; body: ApiError; setCookie?: string[] };

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function tryDecode(text: string, decoder: (s: string) => string): string {
  try {
    return decoder(text);
  } catch {
    return text.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
      try {
        return decoder(run);
      } catch {
        return run;
      }
    });
  }
}

/**
 * Every spelling of the request path that a router downstream might act on. Hono matches
 * routes on the `decodeURI`-decoded path, so `/%61pi/tickets` IS `/api/tickets` to it; the
 * gate has to see it that way too, or an encoded path would walk straight past the token check.
 */
export function routedPaths(rawUrl: string | undefined): { pathname: string; variants: string[]; token: string | null } | null {
  const raw = rawUrl ?? '/';
  let url: URL;
  try {
    url = new URL(raw, 'http://centcom.invalid');
  } catch {
    return null;
  }
  const cut = raw.search(/[?#]/);
  const rawPath = cut === -1 ? raw : raw.slice(0, cut);
  const forms = new Set<string>();
  for (const p of [url.pathname, rawPath]) {
    forms.add(p);
    forms.add(tryDecode(p, decodeURI));
    forms.add(tryDecode(p, decodeURIComponent));
  }
  forms.delete(url.pathname);
  return { pathname: url.pathname, variants: [...forms], token: url.searchParams.get('token') };
}

/**
 * Runs on the raw Node request, before either Hono or the MCP transport sees it,
 * so `/api`, `/mcp` and the static UI share exactly one set of rules.
 */
export function securityGate(req: IncomingMessage, sec: SecurityConfig): GateResult {
  if (!isAllowedHost(headerValue(req.headers.host), sec)) {
    return { ok: false, status: 403, body: { error: 'Host header not allowed.', code: 'forbidden' } };
  }
  const origin = headerValue(req.headers.origin);
  if (!isAllowedOrigin(origin, sec)) {
    return { ok: false, status: 403, body: { error: 'Origin not allowed.', code: 'forbidden' } };
  }
  const forwarded =
    req.headers['x-forwarded-for'] !== undefined || req.headers['forwarded'] !== undefined || req.headers['x-real-ip'] !== undefined;
  const loopback = !forwarded && isLoopbackAddress(req.socket.remoteAddress);
  const attach = (verdict: GateVerdict): GateVerdict => {
    (req as unknown as Record<symbol, GateVerdict>)[VERDICT] = verdict;
    return verdict;
  };

  const method = (req.method ?? 'GET').toUpperCase();
  // CORS preflights never carry credentials; the origin was already vetted above.
  if (method === 'OPTIONS' && origin !== undefined) return { ok: true, origin, verdict: attach({ via: 'preflight', loopback, principal: null }) };

  const routed = routedPaths(req.url);
  if (!routed) return { ok: false, status: 400, body: { error: 'Malformed request URL.', code: 'invalid' } };
  // A cookie matters wherever a credential does: off loopback, or on it when loopback must
  // authenticate. The plain-named one counts only on plain-http loopback, where a `__Host-`
  // cookie cannot exist. A session whose token has since been revoked is no session.
  const wantCookie = sec.sessions !== undefined && (!loopback || sec.requireTokenOnLoopback === true);
  const cookie = wantCookie ? readSessionCookie(req.headers.cookie, loopback) : null;
  const session = cookie ? sec.sessions?.lookup(cookie) ?? null : null;
  const sessionPrincipal = session ? sec.tokens.byId(session.tokenId) : null;
  const decision = decideAuth({
    remoteAddress: req.socket.remoteAddress,
    forwarded,
    method,
    pathname: routed.pathname,
    variants: routed.variants,
    authorization: headerValue(req.headers.authorization),
    queryToken: routed.token,
    verify: (presented) => sec.tokens.verify(presented),
    session: cookie === null ? { state: 'absent' } : sessionPrincipal ? { state: 'valid', principal: sessionPrincipal } : { state: 'invalid' },
    legacyQueryToken: sec.legacyQueryToken === true,
    requireTokenOnLoopback: sec.requireTokenOnLoopback === true,
  });
  if (!decision.ok) {
    return { ok: false, status: decision.status, body: { error: decision.message, code: 'forbidden' }, ...(decision.clearSession ? { setCookie: clearSessionCookies(!loopback) } : {}) };
  }
  // SameSite=Strict already keeps the cookie off cross-site requests; a write riding on a cookie
  // must also prove where it came from. Browsers send Origin on every non-GET fetch.
  if (decision.via === 'cookie' && method !== 'GET' && method !== 'HEAD' && origin === undefined) {
    return { ok: false, status: 403, body: { error: 'A write using a browser session must come from the CENTCOM UI (Origin header required).', code: 'forbidden' } };
  }
  return { ok: true, origin, verdict: attach({ via: decision.via, loopback, principal: decision.principal, ...(session && decision.via === 'cookie' ? { session } : {}) }) };
}
