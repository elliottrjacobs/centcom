/**
 * Shared helpers for the node:test suites. Not a test file itself.
 *
 * Every server started here gets a brand-new temp vault AND a brand-new temp config dir,
 * passed explicitly, so a test can never read or write ~/CENTCOM or ~/.centcom.
 */
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startServer, type RunningServer } from './index.ts';
import type { NetHooks } from './ssrf.ts';

export interface TestServer {
  server: RunningServer;
  port: number;
  vault: string;
  configDir: string;
  base: string;
  token: string;
  api<T = unknown>(method: string, url: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; json: T; headers: Headers }>;
  close(): Promise<void>;
}

/** The vault owner every test server is configured with. */
export const TEST_USER = { id: 'owner', name: 'Owner' } as const;

export async function tempDir(prefix: string): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `centcom-${prefix}-`)));
}

export async function startTestServer(
  opts: { prepare?: (vault: string) => Promise<void>; seed?: boolean; config?: (vault: string) => Record<string, unknown>; net?: NetHooks } = {},
): Promise<TestServer> {
  const vault = await tempDir('vault');
  const configDir = await tempDir('config');
  // An empty vault gets seeded with the CENTCOM project; most tests want a blank slate instead.
  if (opts.seed !== true) await fs.writeFile(path.join(vault, 'README.md'), '# Test vault\n');
  if (opts.prepare) await opts.prepare(vault);
  // A fixed owner, so no test depends on the OS account it happens to run under. Extra keys for
  // config.json (e.g. `links`) come from `opts.config`; pass `user: undefined` there to exercise
  // the derived default. The server fills in the token and the rest.
  await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify({ user: TEST_USER, ...opts.config?.(vault) }, null, 2), { mode: 0o600 });

  const server = await startServer({ port: 0, host: '127.0.0.1', vault, configDir, quiet: true, uiDir: path.join(configDir, 'no-ui'), ...(opts.net ? { unsafeNetForTests: opts.net } : {}) });
  const port = server.info.port;
  const base = `http://127.0.0.1:${port}`;
  const token = (JSON.parse(await fs.readFile(path.join(configDir, 'config.json'), 'utf8')) as { token: string }).token;

  return {
    server,
    port,
    vault,
    configDir,
    base,
    token,
    async api<T>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
      const res = await fetch(`${base}${url}`, {
        method,
        headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      let json: unknown;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = text;
      }
      return { status: res.status, json: json as T, headers: res.headers };
    },
    async close() {
      await server.close();
      await fs.rm(vault, { recursive: true, force: true });
      await fs.rm(configDir, { recursive: true, force: true });
    },
  };
}

export interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** node:http request, because `fetch` will not let a test forge `Host` or `Origin`. */
export function rawRequest(port: number, opts: { method?: string; path: string; headers?: Record<string, string>; body?: string | Buffer }): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path, headers: opts.headers ?? {}, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

export interface EventStream {
  events: Record<string, unknown>[];
  waitFor(predicate: (event: Record<string, unknown>) => boolean, timeoutMs?: number): Promise<Record<string, unknown>>;
  close(): void;
}

/** Minimal SSE client over node:http. Resolves once the stream is open. */
export function openEvents(port: number, pathWithQuery = '/api/events', headers: Record<string, string> = {}): Promise<EventStream> {
  return new Promise((resolve, reject) => {
    const events: Record<string, unknown>[] = [];
    const waiters: { predicate: (e: Record<string, unknown>) => boolean; resolve: (e: Record<string, unknown>) => void }[] = [];
    const req = http.get({ host: '127.0.0.1', port, path: pathWithQuery, headers, agent: false }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`SSE connect failed: HTTP ${res.statusCode}`));
        res.resume();
        return;
      }
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;
        let at: number;
        while ((at = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            const event = JSON.parse(line.slice(6)) as Record<string, unknown>;
            events.push(event);
            for (const waiter of [...waiters]) {
              if (waiter.predicate(event)) {
                waiters.splice(waiters.indexOf(waiter), 1);
                waiter.resolve(event);
              }
            }
          }
        }
      });
      resolve({
        events,
        waitFor(predicate, timeoutMs = 5000) {
          const seen = events.find(predicate);
          if (seen) return Promise.resolve(seen);
          return new Promise((res2, rej2) => {
            const timer = setTimeout(() => rej2(new Error(`Timed out waiting for an SSE event. Saw: ${JSON.stringify(events)}`)), timeoutMs);
            waiters.push({
              predicate,
              resolve: (e) => {
                clearTimeout(timer);
                res2(e);
              },
            });
          });
        },
        close: () => req.destroy(),
      });
    });
    req.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(err);
    });
  });
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** `via` of an allowed auth decision, or `refused <status>`: one comparable string per outcome. */
export function viaOf(d: { ok: true; via: string } | { ok: false; status: number }): string {
  return d.ok ? d.via : `refused ${d.status}`;
}
