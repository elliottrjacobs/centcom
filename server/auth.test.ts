import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OWNER_PRINCIPAL } from './tokens.ts';
import { viaOf } from './testkit.ts';
import { allowedOrigins, decideAuth, isAllowedHost, isAllowedOrigin, isLoopbackAddress, isLoopbackHost, parseHostHeader, queryTokenAllowed, remoteBindProblem, tokensMatch, type AuthInput } from './auth.ts';

const TOKEN = 'a'.repeat(64);
const LOCAL = { host: '127.0.0.1', port: 4747, remoteOrigins: [] as string[] };
const REMOTE = { host: '100.64.0.7', port: 4747, remoteOrigins: ['https://mac.tailnet.ts.net'] };

function input(overrides: Partial<AuthInput>): AuthInput {
  return { remoteAddress: '192.168.1.50', forwarded: false, method: 'GET', pathname: '/api/tickets', authorization: undefined, queryToken: undefined, verify: (t) => (tokensMatch(t, TOKEN) ? OWNER_PRINCIPAL : null), ...overrides };
}
const VALID = { state: 'valid', principal: OWNER_PRINCIPAL } as const;
const INVALID = { state: 'invalid' } as const;

describe('isLoopbackAddress', () => {
  it('recognises IPv4, IPv6 and IPv4-mapped loopback', () => {
    for (const a of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1', '[::1]', '0:0:0:0:0:0:0:1']) assert.equal(isLoopbackAddress(a), true, a);
  });
  it('rejects everything else, including lookalikes', () => {
    for (const a of ['192.168.1.2', '10.0.0.1', '100.64.0.7', '::ffff:192.168.1.2', '0.0.0.0', '1127.0.0.1', '127.0.0.1.evil.example', 'localhost', '', undefined, null]) {
      assert.equal(isLoopbackAddress(a), false, String(a));
    }
  });
  it('isLoopbackHost also accepts the name localhost', () => {
    assert.equal(isLoopbackHost('localhost'), true);
    assert.equal(isLoopbackHost('LOCALHOST'), true);
    assert.equal(isLoopbackHost('0.0.0.0'), false);
    assert.equal(isLoopbackHost('100.64.0.7'), false);
  });
});

describe('decideAuth (token requirement)', () => {
  it('loopback peers need no token', () => {
    assert.equal(viaOf(decideAuth(input({ remoteAddress: '127.0.0.1' }))), 'loopback');
    assert.equal(viaOf(decideAuth(input({ remoteAddress: '::1', method: 'POST' }))), 'loopback');
    assert.equal(viaOf(decideAuth(input({ remoteAddress: '::ffff:127.0.0.1', pathname: '/mcp' }))), 'loopback');
  });

  it('non-loopback peers are refused without a token', () => {
    const d = decideAuth(input({}));
    assert.equal(d.ok, false);
    assert.equal(!d.ok && d.status, 401);
    assert.equal(decideAuth(input({ pathname: '/mcp', method: 'POST' })).ok, false);
    assert.equal(decideAuth(input({ pathname: '/api/health' })).ok, false);
  });

  it('non-loopback peers pass with the right bearer token and fail with a wrong one', () => {
    assert.equal(viaOf(decideAuth(input({ authorization: `Bearer ${TOKEN}` }))), 'bearer');
    assert.equal(viaOf(decideAuth(input({ authorization: `bearer   ${TOKEN}` }))), 'bearer');
    assert.equal(decideAuth(input({ authorization: `Bearer ${'b'.repeat(64)}` })).ok, false);
    assert.equal(decideAuth(input({ authorization: `Bearer ${TOKEN.slice(0, 63)}` })).ok, false);
    assert.equal(decideAuth(input({ authorization: `Basic ${TOKEN}` })).ok, false);
    assert.equal(decideAuth(input({ authorization: 'Bearer ' })).ok, false);
  });

  it('a wrong bearer token is not rescued by a right query token', () => {
    assert.equal(decideAuth(input({ pathname: '/api/events', authorization: 'Bearer nope', queryToken: TOKEN })).ok, false);
  });

  it('?token= is refused everywhere unless legacyQueryToken is on', () => {
    for (const pathname of ['/api/events', '/api/raw/Taste/Visual/a.png']) {
      const d = decideAuth(input({ pathname, queryToken: TOKEN }));
      assert.equal(d.ok, false, pathname);
      assert.match(!d.ok ? d.message : '', /no longer accepted/);
    }
  });

  it('with legacyQueryToken, ?token= works only on GET /api/raw/* and GET /api/events', () => {
    const legacy = (o: Partial<AuthInput>) => input({ legacyQueryToken: true, ...o });
    assert.equal(viaOf(decideAuth(legacy({ pathname: '/api/events', queryToken: TOKEN }))), 'query');
    assert.equal(viaOf(decideAuth(legacy({ pathname: '/api/raw/Taste/Visual/a.png', queryToken: TOKEN }))), 'query');
    assert.equal(decideAuth(legacy({ pathname: '/api/events', queryToken: 'wrong' })).ok, false);

    for (const [method, pathname] of [
      ['GET', '/api/tickets'],
      ['GET', '/api/doc'],
      ['GET', '/api/raw'],
      ['GET', '/api/eventsx'],
      ['POST', '/api/events'],
      ['POST', '/api/raw/a.png'],
      ['DELETE', '/api/raw/a.png'],
      ['POST', '/mcp'],
      ['PUT', '/api/doc'],
    ] as const) {
      assert.equal(decideAuth(legacy({ method, pathname, queryToken: TOKEN })).ok, false, `${method} ${pathname}`);
      assert.equal(queryTokenAllowed(method, pathname), false, `${method} ${pathname}`);
    }
  });

  it('a live session cookie opens protected paths like a bearer, never the loopback-only ones', () => {
    assert.equal(viaOf(decideAuth(input({ session: VALID }))), 'cookie');
    assert.equal(viaOf(decideAuth(input({ pathname: '/api/events', session: VALID }))), 'cookie');
    for (const pathname of ['/api/connection', '/api/links/reload', '/api/links/git']) {
      const d = decideAuth(input({ pathname, session: VALID }));
      assert.equal(!d.ok && d.status, 403, pathname);
    }
    const expired = decideAuth(input({ session: INVALID }));
    assert.equal(!expired.ok && expired.status, 401);
    assert.equal(!expired.ok && expired.clearSession, true);
    assert.equal(viaOf(decideAuth(input({ session: INVALID, authorization: `Bearer ${TOKEN}` }))), 'bearer', 'a bearer wins over a stale cookie');
    assert.equal(decideAuth(input({ session: VALID, authorization: 'Bearer nope' })).ok, false, 'a wrong bearer is not rescued by a cookie');
  });

  it('only the exact POST/DELETE /api/session is reachable without a credential', () => {
    assert.equal(viaOf(decideAuth(input({ method: 'POST', pathname: '/api/session' }))), 'public');
    assert.equal(viaOf(decideAuth(input({ method: 'DELETE', pathname: '/api/session' }))), 'public');
    assert.equal(decideAuth(input({ method: 'GET', pathname: '/api/session' })).ok, false);
    assert.equal(decideAuth(input({ method: 'POST', pathname: '/api/session/' })).ok, false);
    assert.equal(decideAuth(input({ method: 'POST', pathname: '/API/session' })).ok, false);
    assert.equal(decideAuth(input({ method: 'POST', pathname: '/api/session', variants: ['/api/%73ession'] })).ok, false);
  });

  it('a proxied request is never treated as loopback, whatever the socket says', () => {
    assert.equal(decideAuth(input({ remoteAddress: '127.0.0.1', forwarded: true })).ok, false);
    assert.equal(viaOf(decideAuth(input({ remoteAddress: '127.0.0.1', forwarded: true, authorization: `Bearer ${TOKEN}` }))), 'bearer');
  });

  it('an unknown peer address is not loopback', () => {
    assert.equal(decideAuth(input({ remoteAddress: undefined })).ok, false);
  });

  it('the static UI shell is public; /api and /mcp are not', () => {
    assert.equal(viaOf(decideAuth(input({ pathname: '/' }))), 'public');
    assert.equal(viaOf(decideAuth(input({ pathname: '/assets/index-abc.js' }))), 'public');
    assert.equal(decideAuth(input({ pathname: '/api' })).ok, false);
    assert.equal(decideAuth(input({ pathname: '/mcp/' })).ok, false);
  });
});

describe('tokensMatch', () => {
  it('matches only the exact token and never an empty one', () => {
    assert.equal(tokensMatch(TOKEN, TOKEN), true);
    assert.equal(tokensMatch(`${TOKEN} `, TOKEN), false);
    assert.equal(tokensMatch('', TOKEN), false);
    assert.equal(tokensMatch(undefined, TOKEN), false);
    assert.equal(tokensMatch('', ''), false);
  });
});

describe('Host check (anti DNS-rebinding)', () => {
  it('allows loopback names on any port', () => {
    for (const h of ['127.0.0.1', '127.0.0.1:4747', 'localhost:5179', 'LOCALHOST:1', '[::1]', '[::1]:4747']) assert.equal(isAllowedHost(h, LOCAL), true, h);
  });
  it('rejects everything else', () => {
    for (const h of ['evil.example', 'evil.example:4747', '127.0.0.1.evil.example', 'localhost.evil.example', '0.0.0.0:4747', '', undefined, 'a b', 'user@localhost', 'localhost/x', '192.168.1.5']) {
      assert.equal(isAllowedHost(h, LOCAL), false, String(h));
    }
  });
  it('allows the configured host and the hostname of a configured remote origin', () => {
    assert.equal(isAllowedHost('100.64.0.7:4747', REMOTE), true);
    assert.equal(isAllowedHost('mac.tailnet.ts.net', REMOTE), true);
    assert.equal(isAllowedHost('other.tailnet.ts.net', REMOTE), false);
  });
  it('never treats a wildcard bind address as a valid Host', () => {
    assert.equal(isAllowedHost('0.0.0.0:4747', { host: '0.0.0.0', remoteOrigins: [] }), false);
  });
  it('parses authorities', () => {
    assert.deepEqual(parseHostHeader('Example.com:80'), { hostname: 'example.com', port: '80' });
    assert.deepEqual(parseHostHeader('[::1]:4747'), { hostname: '[::1]', port: '4747' });
    assert.equal(parseHostHeader('a:b:c'), null);
  });
});

describe('Origin check (anti-CSRF)', () => {
  it('passes requests without an Origin header (curl, CLI, MCP)', () => {
    assert.equal(isAllowedOrigin(undefined, LOCAL), true);
  });
  it('allows the server itself and the Vite dev origins', () => {
    for (const o of ['http://127.0.0.1:4747', 'http://localhost:4747', 'http://localhost:5179', 'http://127.0.0.1:5179']) assert.equal(isAllowedOrigin(o, LOCAL), true, o);
  });
  it('rejects other origins, other ports, other schemes and "null"', () => {
    for (const o of ['https://evil.example', 'http://localhost:3000', 'http://127.0.0.1:4748', 'https://127.0.0.1:4747', 'null', '', 'http://localhost:4747.evil.example', 'file://']) {
      assert.equal(isAllowedOrigin(o, LOCAL), false, o);
    }
  });
  it('allows the configured remote origin and the configured host', () => {
    assert.equal(isAllowedOrigin('https://mac.tailnet.ts.net', REMOTE), true);
    assert.equal(isAllowedOrigin('http://100.64.0.7:4747', REMOTE), true);
    assert.equal(isAllowedOrigin('https://other.tailnet.ts.net', REMOTE), false);
  });
  it('never includes a wildcard', () => {
    assert.equal(allowedOrigins(REMOTE).has('*'), false);
    assert.equal(allowedOrigins({ host: '0.0.0.0', port: 4747, remoteOrigins: [] }).has('http://0.0.0.0:4747'), false);
  });
});

describe('remoteBindProblem (no tokens over plain HTTP)', () => {
  it('allows loopback binds whatever the origins say', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1']) assert.equal(remoteBindProblem(host, [], false), null, host);
  });
  it('refuses a non-loopback bind without an https origin, with an actionable message', () => {
    for (const origins of [[], ['http://mac.lan:4747']]) {
      const problem = remoteBindProblem('0.0.0.0', origins, false);
      assert.match(problem ?? '', /Refusing to listen on 0\.0\.0\.0/);
      assert.match(problem ?? '', /remoteOrigin/);
      assert.match(problem ?? '', /CENTCOM_ALLOW_INSECURE_REMOTE=1/);
    }
  });
  it('accepts an https remote origin, or the explicit escape hatch', () => {
    assert.equal(remoteBindProblem('100.64.0.7', ['https://mac.tailnet.ts.net'], false), null);
    assert.equal(remoteBindProblem('0.0.0.0', [], true), null);
  });
});
