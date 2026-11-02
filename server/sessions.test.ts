import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Ticket } from '../shared/types.ts';
import { startServer } from './index.ts';
import { FailureLimiter } from './rate-limit.ts';
import { readSessionCookie, SESSION_IDLE_MS, SESSION_MAX_MS, SessionStore } from './sessions.ts';
import { openEvents, rawRequest, startTestServer, tempDir, type TestServer } from './testkit.ts';

const PROXIED = { 'X-Forwarded-For': '203.0.113.9' };

/** `name=value` from a Set-Cookie list, ready to send back in a Cookie header. */
function cookieFrom(setCookie: string[] | undefined, name = '__Host-centcom_session'): string {
  const line = (setCookie ?? []).find((c) => c.startsWith(`${name}=`));
  assert.ok(line, `no ${name} in ${JSON.stringify(setCookie)}`);
  return line.split(';')[0] as string;
}

describe('SessionStore', () => {
  it('stores only hashes, 0600, and slides the idle timeout up to the absolute limit', async () => {
    const dir = await tempDir('sessions');
    try {
      const store = SessionStore.inDir(dir, () => undefined);
      await store.load();
      const t0 = 1_000_000_000_000;
      const { id } = store.create('owner', 'Test Browser', t0);
      await store.flush();
      const file = path.join(dir, 'sessions.json');
      const text = await fs.readFile(file, 'utf8');
      assert.ok(!text.includes(id), 'the raw session id is never written');
      assert.equal((await fs.stat(file)).mode & 0o777, 0o600);

      assert.equal(store.lookup(id, t0 + SESSION_IDLE_MS - 1)?.tokenId, 'owner');
      // Used just now, so a week from now it is still alive...
      assert.ok(store.lookup(id, t0 + 2 * SESSION_IDLE_MS - 2));
      // ...but never past 30 days from creation, however busy.
      let at = t0;
      while (at + SESSION_IDLE_MS / 2 < t0 + SESSION_MAX_MS) {
        at += SESSION_IDLE_MS / 2;
        store.lookup(id, at);
      }
      assert.equal(store.lookup(id, t0 + SESSION_MAX_MS), null);
      assert.equal(store.lookup(id, t0 + SESSION_MAX_MS - 1), null, 'gone once expired, not resurrected');
      await store.flush();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('dies after a week unused', async () => {
    const store = new SessionStore('/nonexistent/sessions.json', () => undefined);
    const { id } = store.create('owner', '', 0);
    assert.equal(store.lookup(id, SESSION_IDLE_MS), null);
  });

  it('revoking a token ends exactly its sessions; reload keeps live ones and drops expired ones', async () => {
    const dir = await tempDir('sessions-revoke');
    try {
      const store = SessionStore.inDir(dir, () => undefined);
      const a = store.create('owner', '');
      const b = store.create('phone', '');
      const c = store.create('owner', '');
      assert.equal(store.revokeToken('owner'), 2);
      assert.equal(store.lookup(a.id), null);
      assert.equal(store.lookup(c.id), null);
      assert.equal(store.lookup(b.id)?.tokenId, 'phone');
      await store.flush();
      const again = SessionStore.inDir(dir, () => undefined);
      await again.load();
      assert.equal(again.lookup(b.id)?.tokenId, 'phone');
      assert.equal(again.retainTokens((id) => id !== 'phone'), 1);
      assert.equal(again.lookup(b.id), null);
      await again.flush();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('reads the __Host- cookie anywhere and the plain one only on plain-http loopback', () => {
    const id = 'a'.repeat(43);
    assert.equal(readSessionCookie(`x=1; __Host-centcom_session=${id}`, false), id);
    assert.equal(readSessionCookie(`centcom_session=${id}`, false), null);
    assert.equal(readSessionCookie(`centcom_session=${id}`, true), id);
    assert.equal(readSessionCookie(undefined, true), null);
  });
});

describe('FailureLimiter', () => {
  it('limits after N failures in the window and forgets them afterwards', () => {
    const l = new FailureLimiter(3, 1000);
    assert.equal(l.fail('p', 0).limited, false);
    l.fail('p', 1);
    assert.equal(l.fail('p', 2).limited, true);
    assert.equal(l.limited('p', 3), true);
    assert.equal(l.limited('other', 3), false);
    assert.ok(l.retryAfterSeconds('p', 3) >= 1);
    assert.equal(l.limited('p', 1001), false);
  });
});

describe('browser sessions over HTTP', () => {
  let t: TestServer;
  let origin: string;
  before(async () => {
    t = await startTestServer();
    origin = `http://127.0.0.1:${t.port}`;
  });
  after(() => t.close());

  const connect = (token: string, headers: Record<string, string> = PROXIED) =>
    rawRequest(t.port, { method: 'POST', path: '/api/session', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ token }) });

  it('POST /api/session trades a token for a __Host-, HttpOnly, Secure, SameSite=Strict cookie', async () => {
    const res = await connect(t.token);
    assert.equal(res.status, 201);
    const line = (res.headers['set-cookie'] ?? [])[0] ?? '';
    assert.match(line, /^__Host-centcom_session=[A-Za-z0-9_-]{43}; /);
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', 'Max-Age=2592000']) assert.ok(line.split('; ').includes(flag), `${flag} in ${line}`);
    assert.ok(!line.includes('Domain'), '__Host- cookies carry no Domain');
    assert.ok(!res.body.includes(t.token));
  });

  it('plain-http loopback gets the plain cookie without Secure (a browser would drop it otherwise)', async () => {
    const res = await connect(t.token, {});
    assert.equal(res.status, 201);
    const line = (res.headers['set-cookie'] ?? [])[0] ?? '';
    assert.match(line, /^centcom_session=/);
    assert.ok(!line.includes('Secure'));
    assert.ok(line.includes('HttpOnly') && line.includes('SameSite=Strict'));
  });

  it('refuses a wrong token, a missing Origin and a foreign Origin', async () => {
    assert.equal((await connect('b'.repeat(64))).status, 401);
    const noOrigin = await rawRequest(t.port, { method: 'POST', path: '/api/session', headers: { ...PROXIED, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: t.token }) });
    assert.equal(noOrigin.status, 403);
    assert.equal(noOrigin.headers['set-cookie'], undefined);
    const foreign = await rawRequest(t.port, { method: 'POST', path: '/api/session', headers: { ...PROXIED, Origin: 'https://evil.example' }, body: JSON.stringify({ token: t.token }) });
    assert.equal(foreign.status, 403);
  });

  it('the cookie opens protected paths (API, raw files, events) but never the loopback-only ones', async () => {
    const cookie = cookieFrom((await connect(t.token)).headers['set-cookie']);
    const headers = { ...PROXIED, Cookie: cookie };
    assert.equal((await rawRequest(t.port, { path: '/api/tickets', headers })).status, 200);
    assert.equal((await rawRequest(t.port, { path: '/api/raw/README.md', headers })).status, 200);
    const events = await openEvents(t.port, '/api/events', headers);
    events.close();
    for (const p of ['/api/connection', '/api/links/git']) assert.equal((await rawRequest(t.port, { path: p, headers })).status, 403, p);
    const who = JSON.parse((await rawRequest(t.port, { path: '/api/session', headers })).body) as { via: string; session: { expires: number } | null };
    assert.equal(who.via, 'cookie');
    assert.ok(who.session && who.session.expires > Date.now());
  });

  it('a write riding on the cookie needs an allow-listed Origin (CSRF), on top of SameSite=Strict', async () => {
    const cookie = cookieFrom((await connect(t.token)).headers['set-cookie']);
    const write = (headers: Record<string, string>) =>
      rawRequest(t.port, { method: 'POST', path: '/api/tickets', headers: { ...PROXIED, Cookie: cookie, 'Content-Type': 'application/json', ...headers }, body: '{"title":"via cookie"}' });
    assert.equal((await write({ Origin: 'https://evil.example' })).status, 403);
    assert.equal((await write({})).status, 403, 'no Origin header on a cookie write');
    assert.equal((await write({ Origin: origin })).status, 201);
    assert.equal((await t.api<Ticket[]>('GET', '/api/tickets?q=via%20cookie')).json.length, 1);
  });

  it('an unknown or expired session is a 401 that clears the cookie', async () => {
    const res = await rawRequest(t.port, { path: '/api/tickets', headers: { ...PROXIED, Cookie: `__Host-centcom_session=${'z'.repeat(43)}` } });
    assert.equal(res.status, 401);
    const cleared = (res.headers['set-cookie'] ?? [])[0] ?? '';
    assert.match(cleared, /^__Host-centcom_session=;/);
    assert.match(cleared, /Max-Age=0/);
  });

  it('DELETE /api/session ends the session and clears the cookie', async () => {
    const cookie = cookieFrom((await connect(t.token)).headers['set-cookie']);
    const out = await rawRequest(t.port, { method: 'DELETE', path: '/api/session', headers: { ...PROXIED, Origin: origin, Cookie: cookie } });
    assert.equal(out.status, 200);
    assert.match((out.headers['set-cookie'] ?? [])[0] ?? '', /Max-Age=0/);
    assert.equal((await rawRequest(t.port, { path: '/api/tickets', headers: { ...PROXIED, Cookie: cookie } })).status, 401);
  });

  it('sessions survive a restart (only their hashes are on disk)', async () => {
    const dir = await tempDir('session-restart');
    const vault = await tempDir('session-restart-vault');
    try {
      await fs.writeFile(path.join(vault, 'README.md'), 'x');
      const first = await startServer({ port: 0, host: '127.0.0.1', vault, configDir: dir, quiet: true, uiDir: path.join(dir, 'no-ui') });
      const token = (JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8')) as { token: string }).token;
      const o = `http://127.0.0.1:${first.info.port}`;
      const made = await rawRequest(first.info.port, { method: 'POST', path: '/api/session', headers: { ...PROXIED, Origin: o }, body: JSON.stringify({ token }) });
      const cookie = cookieFrom(made.headers['set-cookie']);
      await first.close();
      const stored = await fs.readFile(path.join(dir, 'sessions.json'), 'utf8');
      assert.ok(!stored.includes(cookie.split('=')[1] as string));
      const second = await startServer({ port: 0, host: '127.0.0.1', vault, configDir: dir, quiet: true, uiDir: path.join(dir, 'no-ui') });
      try {
        assert.equal((await rawRequest(second.info.port, { path: '/api/tickets', headers: { ...PROXIED, Cookie: cookie } })).status, 200);
      } finally {
        await second.close();
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
      await fs.rm(vault, { recursive: true, force: true });
    }
  });
});

describe('failed authentication is rate-limited per peer', () => {
  let t: TestServer;
  before(async () => {
    t = await startTestServer();
  });
  after(() => t.close());

  it('turns repeated 401s into 429s for that peer only, and never locks out a valid credential', async () => {
    const noisy = { 'X-Forwarded-For': '198.51.100.7' };
    for (let i = 0; i < 30; i += 1) assert.equal((await rawRequest(t.port, { path: '/api/tickets', headers: { ...noisy, Authorization: 'Bearer wrong' } })).status, 401, `attempt ${i + 1}`);
    const limited = await rawRequest(t.port, { path: '/api/tickets', headers: { ...noisy, Authorization: 'Bearer wrong' } });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers['retry-after']) >= 1);
    assert.equal((await rawRequest(t.port, { path: '/api/tickets', headers: { ...noisy, Authorization: `Bearer ${t.token}` } })).status, 200);
    // The session endpoint is where a browser would guess, so a limited peer gets no session at all.
    const session = await rawRequest(t.port, { method: 'POST', path: '/api/session', headers: { ...noisy, Origin: `http://127.0.0.1:${t.port}` }, body: JSON.stringify({ token: t.token }) });
    assert.equal(session.status, 429);
    assert.equal((await rawRequest(t.port, { path: '/api/tickets', headers: { 'X-Forwarded-For': '198.51.100.8', Authorization: 'Bearer wrong' } })).status, 401, 'another peer is unaffected');
  });
});

describe('writes that contain the server token are refused', () => {
  let t: TestServer;
  before(async () => {
    t = await startTestServer();
  });
  after(() => t.close());

  it('tickets, comments, docs and agent profiles, in any case, and nothing is written', async () => {
    const leak = `here it is: ${t.token.toUpperCase()}`;
    const ticket = (await t.api<Ticket>('POST', '/api/tickets', { title: 'Clean' })).json;
    const attempts: [string, string, unknown][] = [
      ['POST', '/api/tickets', { title: 'Leak', body: leak }],
      ['PATCH', `/api/tickets/${ticket.id}`, { body: leak }],
      ['POST', `/api/tickets/${ticket.id}/comments`, { body: `token ${t.token}` }],
      ['PUT', '/api/doc', { path: 'Notes.md', body: leak }],
      ['PUT', '/api/doc', { path: 'Notes.md', body: 'fine', frontmatter: { secret: t.token } }],
      ['PUT', '/api/agents/research-bot/profile', { description: 'x', instructions: `Use ${t.token}` }],
    ];
    for (const [method, url, body] of attempts) {
      const res = await t.api<{ error: string }>(method, url, body);
      assert.equal(res.status, 400, `${method} ${url}`);
      assert.match(res.json.error, /live CENTCOM token/);
      assert.ok(!res.json.error.includes(t.token));
    }
    assert.equal((await t.api('GET', '/api/doc?path=Notes.md')).status, 404);
    assert.equal((await t.api('GET', '/api/agents/research-bot/profile')).status, 404);
    // Another 64-hex string (a hash, say) is fine.
    assert.equal((await t.api('POST', '/api/tickets', { title: 'Hash', body: 'f'.repeat(64) })).status, 201);
  });
});

describe('security headers', () => {
  let t: TestServer;
  before(async () => {
    t = await startTestServer();
  });
  after(() => t.close());

  it('every response says no-referrer; the API is no-store; the shell cannot be framed', async () => {
    const api = await rawRequest(t.port, { path: '/api/tickets' });
    assert.equal(api.headers['referrer-policy'], 'no-referrer');
    assert.equal(api.headers['cache-control'], 'no-store');
    const refused = await rawRequest(t.port, { path: '/api/tickets', headers: PROXIED });
    assert.equal(refused.headers['referrer-policy'], 'no-referrer');
    const shell = await rawRequest(t.port, { path: '/' });
    assert.equal(shell.headers['content-security-policy'], "frame-ancestors 'none'");
    assert.equal(shell.headers['x-frame-options'], 'DENY');
    assert.match(String(shell.headers['permissions-policy']), /camera=\(\)/);
    assert.equal(shell.headers['referrer-policy'], 'no-referrer');
  });
});

describe('remote binds', () => {
  it('a non-loopback host without an https remote origin refuses to start, before touching the vault', async () => {
    const configDir = await tempDir('bind-config');
    const vault = path.join(configDir, 'vault-never-created');
    try {
      await assert.rejects(startServer({ port: 0, host: '0.0.0.0', vault, configDir, quiet: true }), /Refusing to listen on 0\.0\.0\.0.*remoteOrigin/s);
      await assert.rejects(fs.stat(vault), /ENOENT/);
    } finally {
      await fs.rm(configDir, { recursive: true, force: true });
    }
  });
});
