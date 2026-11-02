import { initializeLabels } from './labels.ts';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import pkg from '../package.json' with { type: 'json' };
import type { ServerInfo } from '../shared/types.ts';
import { CentcomClient } from '../mcp/client.ts';
import { isLoopbackHost, remoteBindProblem, securityGate, type GateVerdict, type SecurityConfig } from './auth.ts';
import { loadConfig } from './config.ts';
import { closeContext, createContext, currentLinks, makeLogger, reloadLinks } from './context.ts';
import { errorMessage, isErrno } from './errors.ts';
import { handleMcpRequest } from './mcp-http.ts';
import { FailureLimiter, loggablePath, peerOf } from './rate-limit.ts';
import { createApp } from './routes.ts';
import { seedVaultIfEmpty } from './seed.ts';
import { handleSessionRequest, SessionStore } from './sessions.ts';
import { TokenStore } from './tokens.ts';
import type { NetHooks } from './ssrf.ts';
import { mountStaticUi, resolveUiDir } from './static.ts';
import { startWatcher, type VaultWatcher } from './watcher.ts';

export const VERSION: string = pkg.version;

export interface StartServerOptions {
  port?: number;
  host?: string;
  vault?: string;
  /** Directory holding the built UI. Default: `$CENTCOM_UI_DIR`, else `<cwd>/dist-ui`. */
  uiDir?: string;
  quiet?: boolean;
  /** Where `config.json` lives. Default: `$CENTCOM_CONFIG_DIR`, else `~/.centcom`. */
  configDir?: string;
  /**
   * TEST-ONLY. Lets the test suite point the bookmark fetcher at an HTTP server on 127.0.0.1,
   * which the SSRF guard otherwise (rightly) refuses. Deliberately not readable from the
   * environment, the config file or any request: a real server never has it.
   */
  unsafeNetForTests?: NetHooks;
}

export interface RunningServer {
  info: ServerInfo;
  /** `http://host:port`, ready to hand to a browser window or a client. */
  url: string;
  close(): Promise<void>;
}

const CORS_ALLOW_HEADERS = 'Authorization, Content-Type, If-None-Match, Last-Event-ID, Mcp-Session-Id, Mcp-Protocol-Version';
const CORS_ALLOW_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string | string[]> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store', ...extra });
  res.end(text);
}


function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: unknown) => {
      if (isErrno(err, 'EADDRINUSE')) reject(new Error(`Port ${port} on ${host} is already in use. Is CENTCOM already running? Use --port / CENTCOM_PORT to pick another.`));
      else if (isErrno(err, 'EADDRNOTAVAIL')) reject(new Error(`Cannot bind ${host}: that address does not exist on this machine.`));
      else reject(err instanceof Error ? err : new Error(String(err)));
    };
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve();
    });
  });
}

export async function startServer(opts: StartServerOptions = {}): Promise<RunningServer> {
  const log = makeLogger(opts.quiet ?? false);
  const config = await loadConfig({ port: opts.port, host: opts.host, vault: opts.vault, configDir: opts.configDir });
  // Before anything touches the vault: a bind that would send tokens over plain HTTP is refused.
  const allowInsecure = process.env.CENTCOM_ALLOW_INSECURE_REMOTE === '1';
  const bindProblem = remoteBindProblem(config.host, config.remoteOrigins, allowInsecure);
  if (bindProblem) throw new Error(bindProblem);
  if (allowInsecure && !isLoopbackHost(config.host)) log.warn(`CENTCOM_ALLOW_INSECURE_REMOTE=1: serving ${config.host} without requiring an https:// remote origin. Tokens may cross the network in cleartext.`);
  const ctx = await createContext(config.vault, log, { configDir: config.configDir, configPath: config.configPath, user: config.user }, { net: opts.unsafeNetForTests });
  await seedVaultIfEmpty(ctx);

  const tokens = TokenStore.inDir(config.configDir, config.token, (m) => log.warn(m));
  await tokens.load();
  const sessions = SessionStore.inDir(config.configDir, (m) => log.warn(m));
  await sessions.load();
  // Sessions opened with a token that has since been revoked (by hand, or while we were down) end here.
  sessions.retainTokens((id) => tokens.has(id));
  const limiter = new FailureLimiter();
  // Filled in once we are listening (port 0 means "pick one", and the Origin allow-list depends on it).
  const security: SecurityConfig = {
    host: config.host,
    port: config.port,
    tokens,
    remoteOrigins: config.remoteOrigins,
    legacyQueryToken: config.legacyQueryToken === true,
    requireTokenOnLoopback: config.requireTokenOnLoopback === true,
    sessions,
  };
  if (security.legacyQueryToken) log.warn('legacyQueryToken is on: ?token= is accepted on GET /api/raw/* and /api/events. It will be removed in the next release.');
  const info: ServerInfo = { name: 'centcom', version: VERSION, vault: ctx.vault.root, port: config.port, host: config.host, remote: !isLoopbackHost(config.host), links: currentLinks(ctx), user: { ...ctx.user } };

  await initializeLabels(ctx);
  let watcher: VaultWatcher | null = null;
  let reloading: Promise<unknown> = Promise.resolve();
  const reload = (): Promise<ServerInfo['links']> => {
    // One reload at a time; the watcher is rebuilt because its roots are the link targets.
    const run = reloading.then(async () => {
      const links = await reloadLinks(ctx);
      info.links = links;
      if (watcher) {
        await watcher.close().catch(() => undefined);
        watcher = startWatcher(ctx);
        await Promise.race([watcher.ready, new Promise<void>((resolve) => setTimeout(resolve, 5000).unref())]);
      }
      return links;
    });
    reloading = run.catch(() => undefined);
    return run;
  };

  const app = createApp({
    ctx,
    connection: () => ({ token: config.token, urls: config.remoteOrigins }),
    info: () => ({ ...info, links: [...info.links], user: { ...info.user } }),
    reloadLinks: reload,
    containsToken: (text) => tokens.mentionedIn(text),
    tokens,
    sessions,
  });
  mountStaticUi(app, resolveUiDir(opts.uiDir));
  const honoListener = getRequestListener(app.fetch, { overrideGlobalObjects: false });

  // The MCP tools are a REST client. In-process they call the Hono app directly: same routes,
  // same validation, no socket. Each /mcp request gets a client that carries that request's gate
  // verdict, so a tool runs with exactly the caller's token: its scopes, projects and agent.
  const mcpClientFor = (verdict: GateVerdict): CentcomClient =>
    new CentcomClient({ baseUrl: 'http://127.0.0.1', fetch: (input, init) => Promise.resolve(app.fetch(new Request(input, init), { verdict })) });

  const refuse = (req: IncomingMessage, peer: { key: string; display: string }, reason: string): boolean => {
    const { count, limited } = limiter.fail(peer.key);
    // One line per failure until the peer is limited, then one more; never the query string.
    if (count < limiter.limit) log.warn(`Refused ${(req.method ?? 'GET').toUpperCase()} ${loggablePath(req.url)} from ${peer.display}: ${reason}`);
    else if (limited) log.warn(`Rate-limiting ${peer.display} after ${count} failed authentications in ${limiter.windowMs / 60000} minutes.`);
    return limited;
  };

  const onRequest = (req: IncomingMessage, res: ServerResponse): void => {
    // Nothing CENTCOM serves should ever leak its URL (and once, a token) to another site.
    res.setHeader('Referrer-Policy', 'no-referrer');
    const peer = peerOf(req);
    const gate = securityGate(req, security);
    if (!gate.ok) {
      if (gate.status === 401) {
        if (limiter.limited(peer.key)) {
          sendJson(res, 429, { error: 'Too many failed authentications. Wait a few minutes and try again.', code: 'forbidden' }, { 'Retry-After': String(limiter.retryAfterSeconds(peer.key)) });
          return;
        }
        refuse(req, peer, gate.body.error);
      }
      sendJson(res, gate.status, gate.body, gate.setCookie ? { 'Set-Cookie': gate.setCookie } : {});
      return;
    }
    if (gate.origin !== undefined) {
      // Only ever an allow-listed origin, echoed back verbatim. Never `*`.
      res.setHeader('Access-Control-Allow-Origin', gate.origin);
      res.setHeader('Vary', 'Origin');
      if ((req.method ?? '').toUpperCase() === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Methods': CORS_ALLOW_METHODS, 'Access-Control-Allow-Headers': CORS_ALLOW_HEADERS, 'Access-Control-Max-Age': '600' });
        res.end();
        return;
      }
    }
    const pathname = (req.url ?? '/').split('?')[0] ?? '/';
    if (pathname === '/api/session') {
      handleSessionRequest(req, res, {
        store: sessions,
        // The session remembers which token opened it, and inherits that token's scopes and agent.
        verifyToken: (presented) => {
          const principal = tokens.verify(presented);
          return principal ? { tokenId: principal.tokenId } : null;
        },
        limited: () => limiter.limited(peer.key),
        fail: (reason) => void refuse(req, peer, reason),
        plainLoopback: gate.verdict.loopback,
        via: gate.verdict.via,
        origin: gate.origin,
      }).catch((err: unknown) => {
        log.error(`Session: ${errorMessage(err)}`);
        if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error.' });
        else res.end();
      });
      return;
    }
    if (pathname === '/mcp' || pathname === '/mcp/') {
      handleMcpRequest(req, res, { client: mcpClientFor(gate.verdict), version: VERSION, log }).catch((err: unknown) => {
        log.error(`MCP: ${errorMessage(err)}`);
        if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error.' });
        else res.end();
      });
      return;
    }
    honoListener(req, res).catch((err: unknown) => {
      log.error(`HTTP: ${errorMessage(err)}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error.' });
      else res.end();
    });
  };

  const server = createServer(onRequest);
  server.on('clientError', (_err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });

  try {
    await listen(server, config.port, config.host);
  } catch (err) {
    await closeContext(ctx);
    throw err;
  }
  const address = server.address();
  if (address && typeof address === 'object') {
    info.port = address.port;
    security.port = address.port;
  }

  watcher = startWatcher(ctx);
  // Once this resolves, edits made on disk are guaranteed to be noticed. Capped so that an
  // enormous vault can never hold the app's startup hostage.
  await Promise.race([watcher.ready, new Promise<void>((resolve) => setTimeout(resolve, 5000).unref())]);
  const displayHost = config.host.includes(':') ? `[${config.host}]` : config.host;
  const url = `http://${displayHost}:${info.port}`;
  log.info(`CENTCOM ${VERSION} listening on ${url}  ·  vault ${ctx.vault.root}`);
  if (info.remote) log.info('Remote mode: non-loopback clients must send Authorization: Bearer <token> (see config.json).');

  let closing: Promise<void> | null = null;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      // Stop accepting first, then let in-flight writes land, then drop whatever is still open (SSE, keep-alive).
      const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
      await reloading;
      await watcher?.close().catch((err: unknown) => log.warn(`Watcher close: ${errorMessage(err)}`));
      await sessions.flush();
      await tokens.flush();
      await closeContext(ctx);
      server.closeAllConnections();
      await stopped;
    })();
    return closing;
  };

  return { info, url, close };
}

/**
 * "Was this file run directly?" without `import.meta` (this module is also bundled to CJS,
 * and into the CLI and Electron bundles, where `require.main === module` would be true
 * for the *bundle*). So: look at what Node was asked to run.
 */
function shouldAutoStart(): boolean {
  if (process.env.CENTCOM_AUTOSTART === '1') return true;
  if (process.env.CENTCOM_AUTOSTART === '0') return false;
  const entry = process.argv[1];
  if (!entry) return false;
  return /(?:^|[\\/])(?:server|dist-server)[\\/]index(?:\.(?:ts|mts|js|mjs|cjs))?$/.test(entry);
}

if (shouldAutoStart()) {
  process.on('unhandledRejection', (reason) => console.error('[centcom] unhandled rejection:', reason));
  startServer()
    .then((running) => {
      let stopping = false;
      const stop = (signal: string): void => {
        if (stopping) process.exit(1);
        stopping = true;
        console.log(`[centcom] ${signal} received, shutting down…`);
        running.close().then(
          () => process.exit(0),
          () => process.exit(1),
        );
      };
      process.on('SIGINT', () => stop('SIGINT'));
      process.on('SIGTERM', () => stop('SIGTERM'));
    })
    .catch((err: unknown) => {
      console.error(`[centcom] failed to start: ${errorMessage(err)}`);
      process.exit(1);
    });
}
