/**
 * Outbound HTTP for bookmark previews, written as security code.
 *
 * Saving a bookmark makes THIS machine fetch a URL chosen by whoever called the API: any agent,
 * and any remote token-holder. Unguarded, that is a read primitive against everything the
 * machine can reach and the caller cannot: loopback services (this server included), the LAN,
 * cloud metadata endpoints, and every other device on the tailnet. So:
 *
 *   1. Only `http:` / `https:`, no credentials in the URL, no obviously-local host names.
 *   2. The host name is resolved HERE, and the request is refused if ANY answer is a non-public
 *      address (a DNS answer mixing one public and one private address is an attack, not a CDN).
 *   3. The socket then connects to exactly the address that was validated: the request is given
 *      a `lookup` that returns it, so there is no second resolution for DNS rebinding to win.
 *      SNI and `Host` stay the original name.
 *   4. Redirects are followed by hand, at most 5, and every hop goes through 1–3 again.
 *   5. Hard caps on time and bytes; no cookies, no auth, nothing of the caller's is forwarded.
 *
 * Callers must never hand the raw response, or any upstream error text, back to the client.
 */
import dns from 'node:dns';
import http, { type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';

export const MAX_REDIRECTS = 5;
export const FETCH_TIMEOUT_MS = 8000;
const USER_AGENT = 'Mozilla/5.0 (compatible; CENTCOM-bookmarks/1.0)';

export type BlockReason =
  | 'invalid_url'
  | 'scheme'
  | 'credentials'
  | 'hostname'
  | 'address'
  | 'dns'
  | 'redirects'
  | 'timeout'
  | 'network'
  | 'status';

/** Carries a fixed, generic reason. Never upstream text. */
export class FetchBlockedError extends Error {
  readonly reason: BlockReason;
  constructor(reason: BlockReason, detail: string) {
    super(detail);
    this.name = 'FetchBlockedError';
    this.reason = reason;
  }
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/**
 * TEST-ONLY seams. They exist because the guard (correctly) refuses 127.0.0.1, where the test
 * HTTP server lives. They are reachable only by passing an object to `startServer()` in-process;
 * there is no env var, config key, header or API field that sets them, and the production
 * entry points never pass one (asserted in `server/bookmarks.test.ts`).
 */
export interface NetHooks {
  /** Replaces DNS. */
  lookup?: (hostname: string) => Promise<ResolvedAddress[]>;
  /** Return true to let one otherwise-blocked address + port through. */
  allow?: (address: string, port: number) => boolean;
}

/* ───────────────────────── Address classification (pure) ───────────────────────── */

function parseIPv4(text: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (!m) return null;
  const octets = m.slice(1).map(Number);
  return octets.every((o) => o >= 0 && o <= 255) ? octets : null;
}

/** 16 bytes, or null when `text` is not a valid IPv6 address. Zone ids (`%en0`) are refused outright. */
export function parseIPv6(text: string): number[] | null {
  let s = text.trim().toLowerCase();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  if (s.includes('%') || net.isIPv6(s) === false) return null;

  // A trailing dotted quad (`::ffff:10.0.0.1`) is the last 32 bits.
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(':');
  if (s.includes('.')) {
    const v4 = parseIPv4(s.slice(lastColon + 1));
    if (!v4) return null;
    tail = v4;
    s = `${s.slice(0, lastColon + 1)}0:0`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const groups = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    for (const g of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = groups(halves[0] ?? '');
  const rest = halves.length === 2 ? groups(halves[1] ?? '') : [];
  if (!head || !rest) return null;
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const words = [...head, ...new Array<number>(halves.length === 2 ? missing : 0).fill(0), ...rest];
  const bytes: number[] = [];
  for (const w of words) bytes.push(w >> 8, w & 0xff);
  if (tail.length === 4) bytes.splice(12, 4, ...tail);
  return bytes.length === 16 ? bytes : null;
}

function classifyV4(o: readonly number[]): string | null {
  const [a, b, c] = o as [number, number, number, number];
  if (a === 0) return 'unspecified / "this network" (0.0.0.0/8)';
  if (a === 10) return 'private (10.0.0.0/8)';
  if (a === 100 && b >= 64 && b <= 127) return 'carrier-grade NAT / Tailscale (100.64.0.0/10)';
  if (a === 127) return 'loopback (127.0.0.0/8)';
  if (a === 169 && b === 254) return 'link-local, incl. cloud metadata (169.254.0.0/16)';
  if (a === 172 && b >= 16 && b <= 31) return 'private (172.16.0.0/12)';
  if (a === 192 && b === 168) return 'private (192.168.0.0/16)';
  if (a === 192 && b === 0 && c === 0) return 'IETF protocol assignments (192.0.0.0/24)';
  if (a === 192 && b === 0 && c === 2) return 'documentation (192.0.2.0/24)';
  if (a === 198 && (b === 18 || b === 19)) return 'benchmarking (198.18.0.0/15)';
  if (a === 198 && b === 51 && c === 100) return 'documentation (198.51.100.0/24)';
  if (a === 203 && b === 0 && c === 113) return 'documentation (203.0.113.0/24)';
  if (a >= 224 && a <= 239) return 'multicast (224.0.0.0/4)';
  if (a >= 240) return 'reserved / broadcast (240.0.0.0/4)';
  return null;
}

function classifyV6(b: readonly number[]): string | null {
  const zeros = (from: number, to: number): boolean => b.slice(from, to).every((x) => x === 0);
  const embedded = (at: number): string | null => {
    const inner = classifyV4(b.slice(at, at + 4));
    return inner ? `IPv6 form of an IPv4 address that is ${inner}` : null;
  };
  // ::ffff:a.b.c.d — judged by the IPv4 address it stands for.
  if (zeros(0, 10) && b[10] === 0xff && b[11] === 0xff) return embedded(12);
  // ::, ::1 and the long-deprecated IPv4-compatible ::a.b.c.d
  if (zeros(0, 12)) return zeros(12, 15) && b[15] === 1 ? 'loopback (::1)' : zeros(12, 16) ? 'unspecified (::)' : 'IPv4-compatible IPv6 (::/96)';
  // NAT64: 64:ff9b::/96 carries an IPv4 address; 64:ff9b:1::/48 is local-use.
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
    if (zeros(4, 12)) return embedded(12);
    if (b[4] === 0 && b[5] === 1) return 'local-use NAT64 (64:ff9b:1::/48)';
  }
  if (b[0] === 0x01 && b[1] === 0x00 && zeros(2, 8)) return 'discard-only (100::/64)';
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return 'Teredo tunnel (2001::/32)';
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return 'documentation (2001:db8::/32)';
  if (b[0] === 0x20 && b[1] === 0x02) return '6to4 tunnel (2002::/16)';
  if (((b[0] as number) & 0xfe) === 0xfc) return 'unique-local (fc00::/7)';
  if (b[0] === 0xfe && ((b[1] as number) & 0xc0) === 0x80) return 'link-local (fe80::/10)';
  if (b[0] === 0xfe && ((b[1] as number) & 0xc0) === 0xc0) return 'site-local (fec0::/10)';
  if (b[0] === 0xff) return 'multicast (ff00::/8)';
  return null;
}

/**
 * Why `address` must not be fetched, or null when it is an ordinary public address.
 * Anything that is not a well-formed IPv4 / IPv6 literal is refused too (fail closed).
 */
export function blockedAddressReason(address: string): string | null {
  const v4 = parseIPv4(address.trim());
  if (v4) return classifyV4(v4);
  const v6 = parseIPv6(address);
  if (v6) return classifyV6(v6);
  return 'not a valid IP address';
}

const LOCAL_SUFFIXES = ['.localhost', '.local', '.internal', '.ts.net', '.home.arpa', '.lan', '.intranet', '.corp', '.home'];

/** Names that can only mean "somewhere private", whatever DNS says today. */
export function blockedHostnameReason(hostname: string): string | null {
  const h = hostname.trim().toLowerCase().replace(/\.+$/, '');
  if (!h) return 'empty host name';
  if (h === 'localhost') return 'localhost';
  for (const suffix of LOCAL_SUFFIXES) if (h.endsWith(suffix) || h === suffix.slice(1)) return `a local-only name (*${suffix})`;
  return null;
}

/**
 * Syntax-level checks on one URL (the first, and every redirect target). Throws `FetchBlockedError`.
 * An IP-literal host is classified here; a name is classified after resolution in `resolvePublic`.
 */
export function assertFetchableUrl(raw: string | URL, hooks?: NetHooks): URL {
  let url: URL;
  try {
    url = typeof raw === 'string' ? new URL(raw) : raw;
  } catch {
    throw new FetchBlockedError('invalid_url', 'not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new FetchBlockedError('scheme', 'only http: and https: URLs are fetched');
  if (url.username !== '' || url.password !== '') throw new FetchBlockedError('credentials', 'URLs carrying credentials are not fetched');
  const host = hostOf(url);
  if (!host) throw new FetchBlockedError('hostname', 'URL has no host');
  if (net.isIP(host) !== 0) {
    const reason = blockedAddressReason(host);
    if (reason && !hooks?.allow?.(host, portOf(url))) throw new FetchBlockedError('address', reason);
  } else {
    const reason = blockedHostnameReason(host);
    if (reason) throw new FetchBlockedError('hostname', reason);
  }
  return url;
}

/** Host name without IPv6 brackets. (WHATWG URL already canonicalises `0x7f.1`, `2130706433` … to dotted decimal.) */
function hostOf(url: URL): string {
  const h = url.hostname;
  return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
}

function portOf(url: URL): number {
  return url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
}

function systemLookup(hostname: string): Promise<ResolvedAddress[]> {
  return new Promise((resolve, reject) => {
    dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 })));
    });
  });
}

/**
 * Resolve `url`'s host and return the ONE address the request will connect to. Refuses when
 * any answer is non-public: an attacker who controls the zone controls every record in it.
 */
export async function resolvePublic(url: URL, hooks?: NetHooks): Promise<ResolvedAddress> {
  const host = hostOf(url);
  const literal = net.isIP(host);
  if (literal !== 0) return { address: host, family: literal === 6 ? 6 : 4 }; // classified by assertFetchableUrl
  let answers: ResolvedAddress[];
  try {
    answers = await (hooks?.lookup ?? systemLookup)(host);
  } catch {
    throw new FetchBlockedError('dns', 'host name did not resolve');
  }
  if (answers.length === 0) throw new FetchBlockedError('dns', 'host name did not resolve');
  const port = portOf(url);
  for (const answer of answers) {
    const reason = blockedAddressReason(answer.address);
    if (reason && !hooks?.allow?.(answer.address, port)) throw new FetchBlockedError('address', `host resolves to an address that is ${reason}`);
  }
  return answers[0] as ResolvedAddress;
}

/* ───────────────────────── The guarded request ───────────────────────── */

export interface GuardedFetchOptions {
  /** Stop reading the body after this many bytes. */
  maxBytes: number;
  accept: string;
  /** Budget for the whole fetch, redirects included. Default 8 s. */
  timeoutMs?: number;
  hooks?: NetHooks | undefined;
}

export interface GuardedResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  /** True when the body was longer than `maxBytes` and reading stopped there. */
  truncated: boolean;
  finalUrl: URL;
  /** Every address a socket was opened to, in order (for tests and logs; never sent to clients). */
  connectedTo: string[];
}

function decoderFor(encoding: string | undefined): NodeJS.ReadWriteStream | null {
  switch ((encoding ?? '').trim().toLowerCase()) {
    case 'gzip':
    case 'x-gzip':
      return zlib.createGunzip();
    case 'deflate':
      return zlib.createInflate();
    case 'br':
      return zlib.createBrotliDecompress();
    default:
      return null;
  }
}

interface Hop {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  truncated: boolean;
}

/** One request to one validated address. Reads the body only for a final (non-redirect) answer. */
function requestOnce(url: URL, target: ResolvedAddress, opts: GuardedFetchOptions, deadline: number): Promise<Hop> {
  return new Promise((resolve, reject) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return reject(new FetchBlockedError('timeout', 'timed out'));
    const transport = url.protocol === 'https:' ? https : http;
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: hostOf(url), // → Host header and TLS SNI: the original name, never the address
        port: portOf(url),
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        agent: false, // a fresh socket every time: nothing pooled, nothing reused across hosts
        headers: { 'User-Agent': USER_AGENT, Accept: opts.accept, 'Accept-Encoding': 'gzip, deflate, br', 'Accept-Language': 'en' },
        // The pin: whatever name Node is about to resolve, it gets the address we validated.
        lookup: (_hostname: string, options: unknown, callback: (...args: unknown[]) => void) => {
          const cb = (typeof options === 'function' ? options : callback) as (...args: unknown[]) => void;
          const wantsAll = typeof options === 'object' && options !== null && (options as { all?: boolean }).all === true;
          if (wantsAll) cb(null, [{ address: target.address, family: target.family }]);
          else cb(null, target.address, target.family);
        },
      } as http.RequestOptions,
      (res: IncomingMessage) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.destroy();
          return finish(() => resolve({ status, headers: res.headers, body: Buffer.alloc(0), truncated: false }));
        }
        const decoder = decoderFor(res.headers['content-encoding'] as string | undefined);
        const stream: NodeJS.ReadableStream = decoder ? res.pipe(decoder) : res;
        const chunks: Buffer[] = [];
        let size = 0;
        const done = (truncated: boolean): void => finish(() => resolve({ status, headers: res.headers, body: Buffer.concat(chunks), truncated }));
        stream.on('data', (chunk: Buffer) => {
          if (settled) return;
          const room = opts.maxBytes - size;
          if (chunk.length > room) {
            // One byte past the cap is proof the body is too long. The cap applies to DECODED
            // bytes, so a compression bomb stops here too.
            if (room > 0) chunks.push(chunk.subarray(0, room));
            size += room;
            done(true);
            res.destroy();
            req.destroy();
            return;
          }
          chunks.push(chunk);
          size += chunk.length;
        });
        stream.on('end', () => done(false));
        stream.on('error', () => (size > 0 ? done(true) : finish(() => reject(new FetchBlockedError('network', 'response could not be read')))));
        res.on('error', () => finish(() => reject(new FetchBlockedError('network', 'connection failed'))));
      },
    );
    const timer = setTimeout(() => {
      finish(() => reject(new FetchBlockedError('timeout', 'timed out')));
      req.destroy();
    }, remaining);
    req.on('error', () => finish(() => reject(new FetchBlockedError('network', 'connection failed'))));
    req.end();
  });
}

/**
 * GET `rawUrl` under the rules at the top of this file. Resolves for any final HTTP status;
 * rejects with `FetchBlockedError` (generic reasons only) when a rule or the network says no.
 */
export async function guardedFetch(rawUrl: string | URL, opts: GuardedFetchOptions): Promise<GuardedResponse> {
  const deadline = Date.now() + (opts.timeoutMs ?? FETCH_TIMEOUT_MS);
  const connectedTo: string[] = [];
  let url = assertFetchableUrl(rawUrl, opts.hooks);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const target = await resolvePublic(url, opts.hooks);
    connectedTo.push(target.address);
    const res = await requestOnce(url, target, opts, deadline);
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      let next: URL;
      try {
        next = new URL(res.headers.location, url);
      } catch {
        throw new FetchBlockedError('invalid_url', 'redirect target is not a valid URL');
      }
      url = assertFetchableUrl(next, opts.hooks); // every hop is held to every rule
      continue;
    }
    return { status: res.status, headers: res.headers, body: res.body, truncated: res.truncated, finalUrl: url, connectedTo };
  }
  throw new FetchBlockedError('redirects', `more than ${MAX_REDIRECTS} redirects`);
}
