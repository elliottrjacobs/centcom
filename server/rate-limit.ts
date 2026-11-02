import type { IncomingMessage } from 'node:http';

/**
 * Counts failed authentication per peer. Detection and noise reduction, not prevention: a
 * 256-bit token cannot be guessed. A peer over the limit gets 429 instead of another 401 (and
 * no session at all) until its oldest failure leaves the window; valid credentials still pass,
 * so a client sharing a proxy address with a noisy one is never locked out.
 */
export class FailureLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(
    readonly limit = 30,
    readonly windowMs = 15 * 60 * 1000,
  ) {}

  private recent(key: string, now: number): number[] {
    const list = (this.failures.get(key) ?? []).filter((ts) => now - ts < this.windowMs);
    if (list.length === 0) this.failures.delete(key);
    else this.failures.set(key, list);
    return list;
  }

  limited(key: string, now = Date.now()): boolean {
    return this.recent(key, now).length >= this.limit;
  }

  /** Record a failure. `count` is how many are in the window now, this one included. */
  fail(key: string, now = Date.now()): { count: number; limited: boolean } {
    const list = this.recent(key, now);
    if (list.length < this.limit) list.push(now);
    this.failures.set(key, list);
    if (this.failures.size > 10_000) this.prune(now);
    return { count: list.length, limited: list.length >= this.limit };
  }

  retryAfterSeconds(key: string, now = Date.now()): number {
    const oldest = this.recent(key, now)[0];
    return oldest === undefined ? 0 : Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000));
  }

  private prune(now: number): void {
    for (const key of [...this.failures.keys()]) this.recent(key, now);
  }
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value.join(',') : value;
}

/**
 * Who a request is from, for counting and logging. Behind a proxy the socket is the proxy, so
 * the address the proxy appended (the right-most `X-Forwarded-For` entry) is added; entries a
 * client prepends itself are ignored. Printable and bounded: it goes into a log line.
 */
export function peerOf(req: IncomingMessage): { key: string; display: string } {
  const socket = req.socket.remoteAddress ?? 'unknown';
  const xff = header(req, 'x-forwarded-for')?.split(',').map((s) => s.trim()).filter(Boolean).at(-1);
  const real = header(req, 'x-real-ip')?.trim();
  const via = xff ?? real ?? (header(req, 'forwarded') !== undefined ? 'forwarded' : undefined);
  const clean = (s: string) => s.replace(/[^\w.:[\]%-]/g, '?').slice(0, 80);
  const display = via ? `${clean(via)} via ${clean(socket)}` : clean(socket);
  return { key: display, display };
}

/** A path for a log line: no query string (tokens have lived there), no control characters, bounded. */
export function loggablePath(rawUrl: string | undefined): string {
  const pathOnly = (rawUrl ?? '/').split(/[?#]/)[0] ?? '/';
  return pathOnly.replace(/[^\x21-\x7e]/g, '?').slice(0, 200);
}
