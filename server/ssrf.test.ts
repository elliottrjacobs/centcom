/**
 * The SSRF guard, as a pure function and against real sockets. The only servers contacted are
 * ones this file starts on 127.0.0.1; reaching them at all requires the test-only hooks, which
 * is itself part of what is being tested.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import zlib from 'node:zlib';
import { assertFetchableUrl, blockedAddressReason, blockedHostnameReason, FetchBlockedError, guardedFetch, MAX_REDIRECTS, parseIPv6, resolvePublic, type NetHooks, type ResolvedAddress } from './ssrf.ts';

const blocked = (address: string): void => assert.notEqual(blockedAddressReason(address), null, `${address} must be blocked`);
const allowed = (address: string): void => assert.equal(blockedAddressReason(address), null, `${address} must be allowed`);

async function reasonOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof FetchBlockedError, `expected a FetchBlockedError, got ${String(err)}`);
    return err.reason;
  }
  return assert.fail('expected the fetch to be refused');
}

describe('address classification (pure)', () => {
  it('blocks loopback: 127/8 and ::1', () => {
    for (const a of ['127.0.0.1', '127.0.0.53', '127.255.255.254', '::1', '0:0:0:0:0:0:0:1', '[::1]']) blocked(a);
  });

  it('blocks the private ranges: 10/8, 172.16/12, 192.168/16, exactly', () => {
    for (const a of ['10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255', '192.168.0.1', '192.168.255.255']) blocked(a);
    for (const a of ['9.255.255.255', '11.0.0.1', '172.15.255.255', '172.32.0.1', '192.167.255.255', '192.169.0.1']) allowed(a);
  });

  it('blocks link-local, including the cloud metadata address, and fe80::/10', () => {
    for (const a of ['169.254.169.254', '169.254.0.1', '169.254.255.255', 'fe80::1', 'fe80::1ff:fe23:4567:890a', 'febf:ffff::1']) blocked(a);
    for (const a of ['169.253.255.255', '169.255.0.1']) allowed(a);
    assert.equal(parseIPv6('fe80::1%en0'), null, 'a zone id is never accepted');
    blocked('fe80::1%en0');
  });

  it('blocks CGNAT 100.64/10: the Tailscale range', () => {
    for (const a of ['100.64.0.1', '100.100.100.100', '100.101.102.103', '100.127.255.255']) blocked(a);
    for (const a of ['100.63.255.255', '100.128.0.1']) allowed(a);
  });

  it('blocks unique-local fc00::/7 (Tailscale IPv6 lives here too) and site-local', () => {
    for (const a of ['fc00::1', 'fd00::1', 'fd7a:115c:a1e0::1', 'fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'fec0::1']) blocked(a);
    allowed('fbff::1');
  });

  it('blocks unspecified, multicast, broadcast and reserved space', () => {
    for (const a of ['0.0.0.0', '0.1.2.3', '::', '0:0:0:0:0:0:0:0', '224.0.0.1', '239.255.255.250', 'ff02::1', 'ff0e::1', '255.255.255.255', '240.0.0.1']) blocked(a);
  });

  it('blocks IPv4-mapped IPv6 forms of every blocked range, in dotted and hex spelling', () => {
    for (const a of [
      '::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:7f00:1', '0000:0000:0000:0000:0000:ffff:7f00:0001',
      '::ffff:10.0.0.1', '::ffff:a00:1', '::ffff:172.16.0.1', '::ffff:192.168.1.1', '::ffff:c0a8:101',
      '::ffff:169.254.169.254', '::ffff:a9fe:a9fe', '::ffff:100.64.0.1', '::ffff:6440:1', '::ffff:0.0.0.0', '::ffff:224.0.0.1', '::ffff:255.255.255.255',
    ]) blocked(a);
    allowed('::ffff:8.8.8.8'); // a mapped PUBLIC address is just that public address
  });

  it('blocks the other ways an IPv4 address hides inside IPv6', () => {
    for (const a of ['::127.0.0.1', '::10.0.0.1', '64:ff9b::7f00:1', '64:ff9b::10.0.0.1', '64:ff9b::a9fe:a9fe', '64:ff9b:1::1', '2002:7f00:1::', '2002:a00:1::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2', '2001:db8::1', '100::1']) blocked(a);
    allowed('64:ff9b::808:808'); // NAT64 of 8.8.8.8
  });

  it('allows ordinary public addresses and fails closed on anything unparseable', () => {
    for (const a of ['93.184.216.34', '1.1.1.1', '8.8.8.8', '2606:4700:4700::1111', '2001:4860:4860::8888', '2a00:1450:4001:81b::200e']) allowed(a);
    for (const a of ['', 'example.com', '1.2.3', '1.2.3.4.5', '256.1.1.1', '0x7f.0.0.1', ':::', 'gggg::1', '1::2::3']) blocked(a);
  });
});

describe('host names and URLs (pure)', () => {
  it('blocks localhost, *.local, *.internal, *.ts.net whatever they resolve to', () => {
    for (const h of ['localhost', 'LOCALHOST', 'localhost.', 'foo.localhost', 'printer.local', 'Printer.LOCAL.', 'db.internal', 'metadata.google.internal', 'mac.tailnet-name.ts.net', 'a.ts.net', 'ts.net', 'nas.lan', 'router.home.arpa', '']) {
      assert.notEqual(blockedHostnameReason(h), null, h);
    }
    for (const h of ['example.com', 'localhost.example.com', 'internal.example.com', 'notlocal.com', 'mylocal', 'ts.network', 'wats.net.example']) assert.equal(blockedHostnameReason(h), null, h);
  });

  it('only http: and https:, never with credentials', () => {
    const reason = (raw: string): string => {
      try {
        assertFetchableUrl(raw);
      } catch (err) {
        return (err as FetchBlockedError).reason;
      }
      return 'ok';
    };
    assert.equal(reason('https://example.com/a?b=c'), 'ok');
    assert.equal(reason('http://example.com:8080/'), 'ok', 'any port is fine');
    for (const raw of ['ftp://example.com/', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'gopher://example.com/', 'ws://example.com/']) assert.equal(reason(raw), 'scheme', raw);
    for (const raw of ['http://user:pass@example.com/', 'https://user@example.com/', 'https://:pw@example.com/']) assert.equal(reason(raw), 'credentials', raw);
    for (const raw of ['not a url', 'http://', '//example.com', '']) assert.equal(reason(raw), 'invalid_url', JSON.stringify(raw));
  });

  it('sees through every spelling of a local IP literal', () => {
    for (const raw of [
      'http://127.0.0.1:4848/', 'http://127.1/', 'http://2130706433/', 'http://0x7f000001/', 'http://0x7f.0.0.1/', 'http://017700000001/', 'http://0177.0.0.1/',
      'http://0/', 'http://0.0.0.0/', 'http://[::1]/', 'http://[::]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://[0:0:0:0:0:ffff:a9fe:a9fe]/',
      'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.1/', 'http://192.168.1.1/', 'http://172.16.0.1/', 'http://100.64.0.1/', 'http://[fd7a:115c:a1e0::1]/', 'http://[fe80::1]/',
    ]) {
      assert.throws(() => assertFetchableUrl(raw), (err: unknown) => err instanceof FetchBlockedError && err.reason === 'address', raw);
    }
    for (const raw of ['http://localhost/', 'http://localhost:4747/api/info', 'https://mac.tailnet.ts.net/', 'http://nas.local/', 'http://db.internal:5432/']) {
      assert.throws(() => assertFetchableUrl(raw), (err: unknown) => err instanceof FetchBlockedError && err.reason === 'hostname', raw);
    }
  });
});

describe('resolution (fake DNS)', () => {
  const dnsReturning = (answers: ResolvedAddress[], calls: string[] = []): NetHooks => ({
    lookup: async (hostname) => {
      calls.push(hostname);
      return answers;
    },
  });

  it('refuses when ANY answer is private, even beside a public one, in either order', async () => {
    const pub: ResolvedAddress = { address: '93.184.216.34', family: 4 };
    for (const priv of ['10.0.0.5', '127.0.0.1', '169.254.169.254', '100.64.0.7', '::1', 'fd00::5', '::ffff:10.0.0.5']) {
      const answer: ResolvedAddress = { address: priv, family: priv.includes(':') ? 6 : 4 };
      assert.equal(await reasonOf(resolvePublic(new URL('http://rebind.example/'), dnsReturning([pub, answer]))), 'address', `public + ${priv}`);
      assert.equal(await reasonOf(resolvePublic(new URL('http://rebind.example/'), dnsReturning([answer, pub]))), 'address', `${priv} + public`);
    }
  });

  it('returns the first answer when all are public, and that is the address the socket will use', async () => {
    const target = await resolvePublic(new URL('https://example.com/'), dnsReturning([{ address: '93.184.216.34', family: 4 }, { address: '2606:2800:220:1::1', family: 6 }]));
    assert.deepEqual(target, { address: '93.184.216.34', family: 4 });
  });

  it('treats no answer and a failing resolver the same way: refused', async () => {
    assert.equal(await reasonOf(resolvePublic(new URL('http://nothing.example/'), dnsReturning([]))), 'dns');
    assert.equal(await reasonOf(resolvePublic(new URL('http://nothing.example/'), { lookup: async () => Promise.reject(new Error('ENOTFOUND')) })), 'dns');
  });

  it('never consults DNS for an IP literal', async () => {
    const calls: string[] = [];
    assert.deepEqual(await resolvePublic(new URL('http://93.184.216.34/'), dnsReturning([{ address: '10.0.0.1', family: 4 }], calls)), { address: '93.184.216.34', family: 4 });
    assert.deepEqual(calls, []);
  });
});

describe('guardedFetch against real sockets', () => {
  let site: http.Server;
  let other: http.Server;
  let sitePort = 0;
  let otherPort = 0;
  const siteRequests: { url: string; headers: http.IncomingHttpHeaders }[] = [];
  let otherHits = 0;
  let lookups: string[] = [];
  /** `site.test` is "public" for this suite: resolves to 127.0.0.1, and only the site's own port is let through. */
  let hooks: NetHooks;

  before(async () => {
    site = http.createServer((req, res) => {
      siteRequests.push({ url: req.url ?? '', headers: req.headers });
      const url = new URL(req.url ?? '/', 'http://site.test');
      const redirect = (to: string): void => {
        res.writeHead(302, { Location: to });
        res.end();
      };
      if (url.pathname === '/ok') return void res.writeHead(200, { 'Content-Type': 'text/html' }).end('<title>fine</title>');
      if (url.pathname === '/to-metadata') return redirect('http://169.254.169.254/latest/meta-data/iam/');
      if (url.pathname === '/to-other-port') return redirect(`http://127.0.0.1:${otherPort}/secret`);
      if (url.pathname === '/to-localhost') return redirect(`http://localhost:${otherPort}/secret`);
      if (url.pathname === '/to-file') return redirect('file:///etc/passwd');
      if (url.pathname === '/to-private-name') return redirect('http://intranet.test/secret');
      if (url.pathname === '/to-creds') return redirect('http://admin:hunter2@site.test/ok');
      if (url.pathname === '/hop') {
        const n = Number(url.searchParams.get('n') ?? '0');
        return n > 0 ? redirect(`/hop?n=${n - 1}`) : void res.writeHead(200, { 'Content-Type': 'text/plain' }).end('landed');
      }
      if (url.pathname === '/big') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        const chunk = Buffer.alloc(64 * 1024, 0x61);
        let sent = 0;
        const pump = (): void => {
          while (sent < 200 && !res.destroyed) {
            sent += 1;
            if (!res.write(chunk)) return void res.once('drain', pump);
          }
          res.end();
        };
        return pump();
      }
      if (url.pathname === '/bomb') {
        res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip' });
        return void res.end(zlib.gzipSync(Buffer.alloc(40 * 1024 * 1024, 0x62)));
      }
      if (url.pathname === '/hang') return; // never answers
      res.writeHead(404).end('nope');
    });
    other = http.createServer((_req, res) => {
      otherHits += 1;
      res.writeHead(200).end('INTERNAL-SERVICE-SECRET');
    });
    await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
    sitePort = (site.address() as AddressInfo).port;
    otherPort = (other.address() as AddressInfo).port;
    hooks = {
      lookup: async (hostname) => {
        lookups.push(hostname);
        if (hostname === 'site.test') return [{ address: '127.0.0.1', family: 4 }];
        if (hostname === 'intranet.test') return [{ address: '10.0.0.5', family: 4 }];
        throw new Error('ENOTFOUND');
      },
      allow: (address, port) => address === '127.0.0.1' && port === sitePort,
    };
  });
  after(async () => {
    site.closeAllConnections();
    other.closeAllConnections();
    await Promise.all([new Promise((r) => site.close(r)), new Promise((r) => other.close(r))]);
  });

  const get = (pathname: string, extra: Partial<Parameters<typeof guardedFetch>[1]> = {}) => guardedFetch(`http://site.test:${sitePort}${pathname}`, { maxBytes: 1024 * 1024, accept: 'text/html', hooks, ...extra });

  it('without the test hooks, 127.0.0.1 is refused and the server never hears from us', async () => {
    const before = siteRequests.length;
    assert.equal(await reasonOf(guardedFetch(`http://127.0.0.1:${sitePort}/ok`, { maxBytes: 1024, accept: '*/*' })), 'address');
    assert.equal(await reasonOf(guardedFetch(`http://localhost:${sitePort}/ok`, { maxBytes: 1024, accept: '*/*' })), 'hostname');
    assert.equal(siteRequests.length, before);
  });

  it('connects to the validated address, resolves once, and keeps Host as the original name', async () => {
    lookups = [];
    let answers = 0;
    const rebinding: NetHooks = {
      ...hooks,
      // A rebinding resolver: public-looking the first time, internal ever after.
      lookup: async (hostname) => {
        lookups.push(hostname);
        answers += 1;
        return [{ address: answers === 1 ? '127.0.0.1' : '10.0.0.99', family: 4 }];
      },
    };
    const res = await guardedFetch(`http://site.test:${sitePort}/ok`, { maxBytes: 1024, accept: 'text/html', hooks: rebinding });
    assert.equal(res.status, 200);
    assert.equal(res.body.toString(), '<title>fine</title>');
    assert.deepEqual(lookups, ['site.test'], 'one resolution per hop: there is no second lookup for a rebind to win');
    assert.deepEqual(res.connectedTo, ['127.0.0.1']);
    assert.equal(siteRequests.at(-1)?.headers.host, `site.test:${sitePort}`);
  });

  it('sends a plain User-Agent and nothing of the caller: no cookies, no auth', async () => {
    await get('/ok');
    const headers = siteRequests.at(-1)?.headers ?? {};
    assert.match(String(headers['user-agent']), /CENTCOM/);
    for (const name of ['cookie', 'authorization', 'proxy-authorization', 'referer', 'origin', 'x-forwarded-for']) assert.equal(headers[name], undefined, name);
  });

  it('re-validates every redirect hop: private address, other local port, localhost, file:, private name, credentials', async () => {
    otherHits = 0;
    assert.equal(await reasonOf(get('/to-metadata')), 'address');
    assert.equal(await reasonOf(get('/to-other-port')), 'address');
    assert.equal(await reasonOf(get('/to-localhost')), 'hostname');
    assert.equal(await reasonOf(get('/to-file')), 'scheme');
    assert.equal(await reasonOf(get('/to-private-name')), 'address');
    assert.equal(await reasonOf(get('/to-creds')), 'credentials');
    assert.equal(otherHits, 0, 'the internal service was never contacted');
  });

  it(`follows at most ${MAX_REDIRECTS} redirects`, async () => {
    const res = await get(`/hop?n=${MAX_REDIRECTS}`);
    assert.equal(res.body.toString(), 'landed');
    assert.equal(res.connectedTo.length, MAX_REDIRECTS + 1);
    assert.equal(await reasonOf(get(`/hop?n=${MAX_REDIRECTS + 1}`)), 'redirects');
  });

  it('stops reading at the byte cap, for plain and for compressed bodies', async () => {
    const big = await get('/big', { maxBytes: 100_000 });
    assert.deepEqual([big.body.length, big.truncated], [100_000, true]);
    const bomb = await get('/bomb', { maxBytes: 2 * 1024 * 1024 });
    assert.deepEqual([bomb.body.length, bomb.truncated], [2 * 1024 * 1024, true], 'the cap is on DECODED bytes');
  });

  it('gives up after the time budget', async () => {
    const started = Date.now();
    assert.equal(await reasonOf(get('/hang', { timeoutMs: 300 })), 'timeout');
    assert.ok(Date.now() - started < 2000);
  });
});
