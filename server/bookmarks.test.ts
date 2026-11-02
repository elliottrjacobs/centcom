/**
 * Bookmarks end to end. The "website" is an HTTP server this file starts on 127.0.0.1, which the
 * SSRF guard refuses by design; the suite reaches it through the test-only hooks (`site.test`
 * resolves to it, and only its port is let through). A second CENTCOM server, started exactly
 * the way production starts one, proves those hooks do not exist outside tests.
 */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { ActivityEvent, ApiError, Doc, SearchHit, TreeNode } from '../shared/types.ts';
import { cleanText, decodeEntities, decodeHtml, fallbackTitle, fileNameForTitle, normalizeBookmarkUrl, parsePageMetadata, siteOf, slugify, sniffImage } from './bookmarks.ts';
import type { NetHooks } from './ssrf.ts';
import { startTestServer, tempDir, type TestServer } from './testkit.ts';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.domain)</script></svg>');

function find(node: TreeNode, p: string): TreeNode | undefined {
  if (node.path === p) return node;
  for (const child of node.children ?? []) {
    const hit = find(child, p);
    if (hit) return hit;
  }
  return undefined;
}

describe('page metadata (pure)', () => {
  const base = new URL('https://example.com/blog/post?x=1');

  it('title: og:title → twitter:title → <title>; description: og:description → meta description', () => {
    const full = '<html><head><title>Plain title</title><meta name="description" content="Plain description"><meta property="og:title" content="OG title"><meta name="twitter:title" content="Twitter title"><meta property="og:description" content="OG description"></head></html>';
    assert.deepEqual(parsePageMetadata(full, base), { title: 'OG title', description: 'OG description' });
    assert.deepEqual(parsePageMetadata('<title>Plain title</title><meta name="twitter:title" content="Twitter title"><meta name="description" content="Plain description">', base), { title: 'Twitter title', description: 'Plain description' });
    assert.deepEqual(parsePageMetadata('<TITLE lang="en">\n  Plain   title\n</TITLE>', base), { title: 'Plain title' });
    assert.deepEqual(parsePageMetadata('<p>nothing useful</p>', base), {});
  });

  it('image: og:image → twitter:image, resolved against the FINAL url; only http(s) survives', () => {
    assert.equal(parsePageMetadata('<meta property="og:image" content="/img/a.png"><meta name="twitter:image" content="/img/b.png">', base).image, 'https://example.com/img/a.png');
    assert.equal(parsePageMetadata("<meta name='twitter:image' content='../b.png'>", base).image, 'https://example.com/b.png');
    assert.equal(parsePageMetadata('<meta property="og:image" content="//cdn.example.net/c.png?a=1&amp;b=2">', base).image, 'https://cdn.example.net/c.png?a=1&b=2');
    for (const bad of ['javascript:alert(1)', 'data:image/png;base64,AAAA', 'file:///etc/passwd']) assert.equal(parsePageMetadata(`<meta property="og:image" content="${bad}">`, base).image, undefined, bad);
  });

  it('tolerates attribute order, quoting styles, case, and ignores <metadata>', () => {
    assert.equal(parsePageMetadata('<META CONTENT="Shouty" PROPERTY="OG:TITLE">', base).title, 'Shouty');
    assert.equal(parsePageMetadata('<meta content=Bare property=og:title>', base).title, 'Bare');
    assert.equal(parsePageMetadata('<metadata property="og:title" content="not a meta tag"></metadata><title>Real</title>', base).title, 'Real');
    assert.equal(parsePageMetadata('<meta property="og:title" content=""><title>Falls through an empty value</title>', base).title, 'Falls through an empty value');
  });

  it('decodes entities, collapses whitespace, strips control and bidi characters, caps the lengths', () => {
    assert.equal(decodeEntities('Tom &amp; Jerry &lt;3 &quot;cheese&quot; &#8212; &#x1F9C0; &mdash; &nbsp;x &bogus; &#0; &#xD800;'), `Tom & Jerry <3 "cheese" — 🧀 —  x &bogus; ${String.fromCodePoint(0xfffd)} ${String.fromCodePoint(0xfffd)}`);
    assert.equal(cleanText(`  a\n\tb ${String.fromCodePoint(0x202e)}c${String.fromCodePoint(0x200b)}d${String.fromCodePoint(0)}  `, 50), 'a b c d');
    const meta = parsePageMetadata(`<meta property="og:title" content="${'T'.repeat(500)}"><meta name="description" content="${'D'.repeat(2000)}">`, base);
    assert.deepEqual([Array.from(meta.title ?? '').length, Array.from(meta.description ?? '').length], [200, 500]);
    assert.ok(meta.title?.endsWith('…'));
  });

  it('stays linear on a hostile page', () => {
    const started = Date.now();
    parsePageMetadata('<meta '.repeat(300_000), base);
    parsePageMetadata(`${'<meta x="'.repeat(200_000)}>`, base);
    parsePageMetadata(`<title>${'<'.repeat(1_000_000)}`, base);
    assert.ok(Date.now() - started < 1500, `took ${Date.now() - started} ms`);
  });

  it('honours the declared charset', () => {
    assert.equal(decodeHtml(Buffer.from([0x63, 0x61, 0x66, 0xe9]), 'text/html; charset=ISO-8859-1'), 'café');
    assert.equal(decodeHtml(Buffer.concat([Buffer.from('<meta charset="windows-1252"><title>'), Buffer.from([0x93, 0x68, 0x69, 0x94])]), 'text/html').slice(-4), '“hi”');
    assert.equal(decodeHtml(Buffer.from('plain ✓'), 'text/html; charset=no-such-charset'), 'plain ✓');
  });
});

describe('preview images and names (pure)', () => {
  it('accepts png / jpeg / webp / gif by their bytes, and nothing else', () => {
    assert.equal(sniffImage(PNG), 'png');
    assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), 'jpg');
    assert.equal(sniffImage(Buffer.from('GIF89a......')), 'gif');
    assert.equal(sniffImage(Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WEBPVP8 ')])), 'webp');
    for (const bad of [SVG, Buffer.from('<?xml version="1.0"?><svg/>'), Buffer.from('<!doctype html>'), Buffer.from('BM......'), Buffer.from('RIFF....WAVE'), Buffer.from([0, 0, 1, 0]), Buffer.alloc(0)]) assert.equal(sniffImage(bad), null);
  });

  it('only http(s) URLs without credentials can be stored', () => {
    assert.equal(normalizeBookmarkUrl('  HTTPS://Example.COM:443/a/../b?q=1#frag ').href, 'https://example.com/b?q=1#frag');
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'ftp://example.com/', 'https://user:pw@example.com/', 'example.com', 'not a url', '', 7, null, `https://example.com/${'a'.repeat(3000)}`]) {
      assert.throws(() => normalizeBookmarkUrl(bad), /url|URL|http/, String(bad).slice(0, 40));
    }
  });

  it('site drops www., the fallback title is host + path', () => {
    assert.equal(siteOf(new URL('https://WWW.Example.com/x')), 'example.com');
    assert.equal(fallbackTitle(new URL('https://www.example.com/docs/getting%20started/?utm=1#top')), 'example.com/docs/getting started');
    assert.equal(fallbackTitle(new URL('https://example.com/')), 'example.com');
  });

  it('file names are safe for the filesystem and for the path resolver', () => {
    assert.equal(fileNameForTitle('A/B: "C" <D> | E? *F*'), 'A B C D E F.md');
    assert.equal(fileNameForTitle('...hidden. '), 'hidden.md');
    assert.equal(fileNameForTitle('../../etc/passwd'), 'etc passwd.md');
    assert.equal(fileNameForTitle('   '), 'Untitled link.md');
    assert.ok(Buffer.byteLength(fileNameForTitle('長'.repeat(300))) <= 204);
    assert.equal(slugify('Héllo, Wörld! — 2026'), 'hello-world-2026');
    assert.equal(slugify('日本語'), 'link');
  });
});

describe('bookmarks over HTTP', () => {
  let t: TestServer;
  let prod: TestServer;
  let site: http.Server;
  let sitePort = 0;
  let siteUp = true;
  const hits: string[] = [];
  const url = (p: string): string => `http://site.test:${sitePort}${p}`;
  const save = (body: Record<string, unknown>) => t.api<Doc>('POST', '/api/bookmarks', body);
  const tree = async (): Promise<TreeNode> => (await t.api<TreeNode>('GET', '/api/tree')).json;

  before(async () => {
    site = http.createServer((req, res) => {
      hits.push(req.url ?? '');
      if (!siteUp) return void res.writeHead(503, { 'Content-Type': 'text/html' }).end('<title>UPSTREAM-ERROR-TEXT maintenance</title>');
      const html = (body: string): void => void res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(body);
      switch ((req.url ?? '').split('?')[0]) {
        case '/article':
          return html('<html><head><title>Ignored &ndash; plain</title><meta property="og:title" content="An Article: About &quot;Things&quot; / Stuff"><meta property="og:description" content="  A   thoughtful piece\n about zymurgy &amp; more.  "><meta property="og:image" content="/img/preview.png"></head><body>ARTICLE-BODY-TEXT</body></html>');
        case '/twitter':
          return html('<title>Tweet-ish</title><meta name="twitter:title" content="Twitter Card"><meta name="twitter:image" content="img/preview.png">');
        case '/same-title':
          return html('<meta property="og:title" content="An Article: About &quot;Things&quot; / Stuff">');
        case '/img/preview.png':
          return void res.writeHead(200, { 'Content-Type': 'image/png' }).end(PNG);
        case '/svg-disguised':
          return html('<title>Disguised</title><meta property="og:image" content="/img/evil-as-png">');
        case '/img/evil-as-png':
          return void res.writeHead(200, { 'Content-Type': 'image/png' }).end(SVG); // lies about its type
        case '/svg-honest':
          return html('<title>Honest</title><meta property="og:image" content="/img/logo.svg">');
        case '/img/logo.svg':
          return void res.writeHead(200, { 'Content-Type': 'image/svg+xml' }).end(SVG);
        case '/huge-image':
          return html('<title>Huge</title><meta property="og:image" content="/img/huge.png">');
        case '/img/huge.png':
          return void res.writeHead(200, { 'Content-Type': 'image/png' }).end(Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024)]));
        case '/to-metadata':
          return void res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' }).end();
        case '/image-on-lan':
          return html('<title>LAN image</title><meta property="og:image" content="http://192.168.1.1/admin.png">');
        case '/secret':
          return html('<html><body>TOP-SECRET-BODY no title, no meta</body></html>');
        case '/report.pdf':
          return void res.writeHead(200, { 'Content-Type': 'application/pdf' }).end('%PDF-1.4 PDF-BODY-TEXT');
        case '/flaky':
          return html('<title>Back online</title><meta name="description" content="Recovered description"><meta property="og:image" content="/img/preview.png">');
        default:
          return void res.writeHead(404, { 'Content-Type': 'text/html' }).end('<title>UPSTREAM-ERROR-TEXT not found</title>');
      }
    });
    await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
    sitePort = (site.address() as AddressInfo).port;

    const net: NetHooks = {
      lookup: async (hostname) => {
        if (hostname === 'site.test' || hostname === 'www.site.test') return [{ address: '127.0.0.1', family: 4 }];
        if (hostname === 'mixed.test') return [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }];
        throw new Error('ENOTFOUND');
      },
      allow: (address, port) => address === '127.0.0.1' && port === sitePort,
    };
    const roRepo = await tempDir('bm-readonly');
    t = await startTestServer({ net, config: () => ({ links: [{ mount: 'Library/Vendor', target: roRepo, readonly: true }] }) });
    // Started the way production starts it: no hooks. Junk in the config and the environment must not conjure any.
    process.env.CENTCOM_UNSAFE_NET = '1';
    process.env.CENTCOM_ALLOW_PRIVATE = '1';
    prod = await startTestServer({ config: () => ({ unsafeNetForTests: { allow: true }, net: { allow: ['127.0.0.1'] }, ssrf: { allowPrivate: true }, allowPrivateAddresses: true }) });
  });
  after(async () => {
    delete process.env.CENTCOM_UNSAFE_NET;
    delete process.env.CENTCOM_ALLOW_PRIVATE;
    await t.close();
    await prod.close();
    site.closeAllConnections();
    await new Promise((r) => site.close(r));
  });

  it('saves a page as <dir>/<Title>.md with link frontmatter, a locally stored preview, and the note as the body', async () => {
    const res = await save({ url: url('/article?utm=1'), tags: ['brewing', '#science', 'brewing'], note: 'Read the section on **yeast**.\n', agent: 'codex' });
    assert.equal(res.status, 201);
    const doc = res.json;
    assert.equal(doc.path, 'Library/Links/An Article About Things Stuff.md');
    assert.equal(doc.title, 'An Article: About "Things" / Stuff');
    assert.equal(doc.body, 'Read the section on **yeast**.');
    const fm = doc.frontmatter;
    assert.deepEqual(Object.keys(fm), ['type', 'title', 'url', 'site', 'description', 'image', 'tags', 'saved', 'saved_by']);
    assert.deepEqual([fm.type, fm.url, fm.site, fm.description, fm.tags, fm.saved_by], ['link', url('/article?utm=1'), 'site.test', 'A thoughtful piece about zymurgy & more.', ['brewing', 'science'], 'codex']);
    assert.match(String(fm.image), /^Library\/Links\/assets\/an-article-about-things-stuff-[0-9a-f]{8}\.png$/);
    assert.ok(!Number.isNaN(Date.parse(String(fm.saved))));

    assert.deepEqual(await fs.readFile(path.join(t.vault, String(fm.image))), PNG, 'the preview is stored in the vault, not hot-linked');
    const raw = await fetch(`${t.base}/api/raw/${String(fm.image)}`);
    assert.deepEqual([raw.status, raw.headers.get('content-type')], [200, 'image/png']);
    assert.match(await fs.readFile(path.join(t.vault, doc.path), 'utf8'), /^---\ntype: link\ntitle: /);

    const feed = (await t.api<ActivityEvent[]>('GET', '/api/activity?agent=codex')).json;
    assert.deepEqual(feed.filter((e) => e.path === doc.path).map((e) => [e.type, e.subject]), [['doc.created', 'An Article: About "Things" / Stuff']]);
    assert.equal(feed.some((e) => e.path === fm.image), false, 'the preview is plumbing, not activity');
  });

  it('the tree shows it as kind "link" with url, site, thumb, description and title; the previews folder stays out of the way', async () => {
    const root = await tree();
    const node = find(root, 'Library/Links/An Article About Things Stuff.md');
    assert.equal(node?.kind, 'link');
    assert.deepEqual([node?.title, node?.url, node?.site, node?.description], ['An Article: About "Things" / Stuff', url('/article?utm=1'), 'site.test', 'A thoughtful piece about zymurgy & more.']);
    assert.match(node?.thumb ?? '', /^Library\/Links\/assets\/.+\.png$/);
    assert.equal(find(root, 'Library/Links/assets'), undefined, 'an assets folder holding only previews is hidden');

    // The moment it holds anything that is not a preview, it is an ordinary folder again.
    await t.api('PUT', '/api/doc', { path: 'Library/Links/assets/notes.md', body: 'mine' });
    assert.deepEqual(find(await tree(), 'Library/Links/assets')?.children?.map((c) => c.name).sort(), [path.basename(node?.thumb ?? ''), 'notes.md'].sort());
    await t.api('DELETE', '/api/doc?path=Library/Links/assets/notes.md');
    assert.equal(find(await tree(), 'Library/Links/assets'), undefined);

    // A hand-made folder that merely shares the name is never hidden.
    await t.api('PUT', '/api/doc', { path: 'Taste/assets/keep.md', body: 'visible' });
    assert.ok(find(await tree(), 'Taste/assets'));
  });

  it('a thumb is only ever a vault path: a link file cannot make the UI load a remote image', async () => {
    await t.api('PUT', '/api/doc', { path: 'Library/Links/Hand made.md', body: '', frontmatter: { type: 'link', url: 'https://example.org/x', image: 'https://tracker.example/pixel.png' } });
    await t.api('PUT', '/api/doc', { path: 'Library/Links/Traversal.md', body: '', frontmatter: { type: 'link', url: 'https://example.org/y', image: '../../etc/passwd' } });
    await t.api('PUT', '/api/doc', { path: 'Library/Links/Not a link.md', body: '', frontmatter: { type: 'link' } });
    const root = await tree();
    assert.deepEqual([find(root, 'Library/Links/Hand made.md')?.kind, find(root, 'Library/Links/Hand made.md')?.thumb, find(root, 'Library/Links/Hand made.md')?.site], ['link', undefined, 'example.org']);
    assert.equal(find(root, 'Library/Links/Traversal.md')?.thumb, undefined);
    assert.equal(find(root, 'Library/Links/Not a link.md')?.kind, 'markdown', 'type: link without a url is just a document');
  });

  it('is found by title, url, site, description and tag, as a "doc" hit', async () => {
    for (const q of ['about things', 'article?utm', 'site.test', 'zymurgy', 'science']) {
      const hits2 = (await t.api<SearchHit[]>('GET', `/api/search?q=${encodeURIComponent(q)}`)).json;
      const hit = hits2.find((h) => h.path === 'Library/Links/An Article About Things Stuff.md');
      assert.equal(hit?.type, 'doc', `q=${q}`);
    }
  });

  it('the same url in the same folder returns the existing bookmark with 200, not a duplicate', async () => {
    const before = hits.length;
    const again = await save({ url: `HTTP://SITE.TEST:${sitePort}/article?utm=1`, note: 'a different note', agent: 'cursor' });
    assert.equal(again.status, 200);
    assert.deepEqual([again.json.path, again.json.body, again.json.frontmatter.saved_by], ['Library/Links/An Article About Things Stuff.md', 'Read the section on **yeast**.', 'codex']);
    assert.equal(hits.length, before, 'and nothing was fetched again');

    const [a, b] = await Promise.all([save({ url: url('/twitter') }), save({ url: url('/twitter') })]);
    assert.deepEqual([a.status, b.status].sort(), [200, 201], 'two agents saving the same page at once get one file');
    assert.equal(a.json.path, b.json.path);

    // The old project `Wiki` path is an alias of its `Library`.
    const elsewhere = await save({ url: url('/article?utm=1'), dir: 'Projects/Reading/Wiki' });
    assert.deepEqual([elsewhere.status, elsewhere.json.path], [201, 'Projects/Reading/Library/An Article About Things Stuff.md'], 'another folder is another bookmark');
    const aliased = await save({ url: url('/article?utm=1'), dir: 'Projects/Reading/Library' });
    assert.deepEqual([aliased.status, aliased.json.path], [200, elsewhere.json.path], 'Wiki and Library are the same folder');
    const sameTitle = await save({ url: url('/same-title') });
    assert.deepEqual([sameTitle.status, sameTitle.json.path], [201, 'Library/Links/An Article About Things Stuff 2.md'], 'a different url with the same title gets a de-duplicated file name');
  });

  it('twitter:title / twitter:image are the fallback, and a relative image resolves against the page', async () => {
    const doc = (await t.api<Doc>('GET', '/api/doc?path=Library/Links/Twitter%20Card.md')).json;
    assert.equal(doc.title, 'Twitter Card');
    assert.match(String(doc.frontmatter.image), /^Library\/Links\/assets\/twitter-card-[0-9a-f]{8}\.png$/);
    assert.ok(hits.includes('/img/preview.png'));
  });

  it('a dead or failing site never loses the link: it is saved with a fallback title and a generic note', async () => {
    const refused = await save({ url: 'http://gone.test/some/deep/page?x=1', agent: 'codex' });
    assert.equal(refused.status, 201);
    assert.deepEqual([refused.json.title, refused.json.path, refused.json.frontmatter.site], ['gone.test/some/deep/page', 'Library/Links/gone.test some deep page.md', 'gone.test']);
    assert.match(String(refused.json.frontmatter.fetch_error), /^not fetched: /);
    assert.equal(refused.json.frontmatter.image, undefined);

    const notFound = await save({ url: url('/missing'), title: 'My own title', note: 'kept anyway' });
    assert.deepEqual([notFound.status, notFound.json.title, notFound.json.body], [201, 'My own title', 'kept anyway']);
    assert.match(String(notFound.json.frontmatter.fetch_error), /could not be reached/);

    const pdf = await save({ url: url('/report.pdf') });
    assert.deepEqual([pdf.status, pdf.json.title, pdf.json.frontmatter.fetch_error], [201, `site.test/report.pdf`, undefined], 'not a page: a plain link, and that is not an error');
  });

  it('never hands back upstream bodies or upstream error text', async () => {
    const secret = await save({ url: url('/secret') });
    assert.equal(secret.status, 201);
    const everything = JSON.stringify([secret.json, (await save({ url: url('/nope') })).json, (await t.api('GET', '/api/doc?path=Library/Links/site.test%20report.pdf.md')).json]);
    for (const leak of ['TOP-SECRET-BODY', 'UPSTREAM-ERROR-TEXT', 'PDF-BODY-TEXT', 'ARTICLE-BODY-TEXT']) assert.equal(everything.includes(leak), false, leak);
    assert.equal(secret.json.title, 'site.test/secret');
  });

  it('an svg is never stored as a preview, whether it admits to being one or not; nor is anything over 5 MB', async () => {
    for (const p of ['/svg-disguised', '/svg-honest', '/huge-image']) {
      const res = await save({ url: url(p) });
      assert.equal(res.status, 201, p);
      assert.equal(res.json.frontmatter.image, undefined, `${p}: no image key`);
      assert.equal(res.json.frontmatter.fetch_error, undefined, `${p}: the page itself was fine`);
    }
    assert.ok(hits.includes('/img/evil-as-png') && hits.includes('/img/logo.svg'), 'they were fetched, then rejected by their bytes');
    const stored = await fs.readdir(path.join(t.vault, 'Library', 'Links', 'assets'));
    assert.deepEqual(stored.filter((name) => !name.endsWith('.png')), []);
    for (const name of stored) assert.deepEqual(await fs.readFile(path.join(t.vault, 'Library', 'Links', 'assets', name)), PNG, `${name} is the real PNG`);
  });

  it('a redirect to a private address, a preview on the LAN, and a name with one private DNS answer are all refused, and still saved', async () => {
    const redirected = await save({ url: url('/to-metadata') });
    assert.equal(redirected.status, 201);
    assert.match(String(redirected.json.frontmatter.fetch_error), /private, local/);

    const lan = await save({ url: url('/image-on-lan') });
    assert.deepEqual([lan.status, lan.json.title, lan.json.frontmatter.image], [201, 'LAN image', undefined]);

    // Port 80 on purpose: the test hook only ever lets 127.0.0.1:<the site's port> through, so this
    // name's private answer is judged exactly as production would judge it, and nothing is dialled.
    const before = hits.length;
    const mixed = await save({ url: 'http://mixed.test/article' });
    assert.equal(mixed.status, 201);
    assert.match(String(mixed.json.frontmatter.fetch_error), /private, local/);
    assert.equal(hits.length, before, 'one private answer poisons the whole name: nothing was requested');
  });

  it('PRODUCTION WIRING has no hook: loopback, metadata and localhost targets are refused, never contacted, and still saved as plain links', async () => {
    const before = hits.length;
    const cases: [string, string][] = [
      [`http://127.0.0.1:${sitePort}/article`, `127.0.0.1/article`],
      [`http://127.0.0.1:${prod.port}/`, '127.0.0.1'],
      ['http://169.254.169.254/latest/meta-data/', '169.254.169.254/latest/meta-data'],
      [`http://localhost:${sitePort}/article`, 'localhost/article'],
      [`http://[::1]:${sitePort}/article`, '[::1]/article'],
      [`http://[::ffff:127.0.0.1]:${sitePort}/article`, '[::ffff:7f00:1]/article'],
      [`http://2130706433:${sitePort}/article`, '127.0.0.1/article'],
      ['http://100.100.100.100/', '100.100.100.100'],
      ['https://mac.tailnet.ts.net/', 'mac.tailnet.ts.net'],
    ];
    for (const [target, title] of cases) {
      const res = await prod.api<Doc>('POST', '/api/bookmarks', { url: target, dir: `Library/Blocked/${cases.findIndex((c) => c[0] === target)}` });
      assert.equal(res.status, 201, target);
      assert.equal(res.json.title, title, target);
      assert.equal(res.json.frontmatter.type, 'link');
      assert.match(String(res.json.frontmatter.fetch_error), /private, local/, target);
      assert.equal(res.json.frontmatter.image, undefined);
    }
    assert.equal(hits.length, before, 'the local site never heard from the production-wired server');
    const node = find((await prod.api<TreeNode>('GET', '/api/tree')).json, 'Library/Blocked/0/127.0.0.1 article.md');
    assert.deepEqual([node?.kind, node?.site], ['link', '127.0.0.1']);
  });

  it('the hook can only be passed in-process: no shipped entry point mentions it', async () => {
    const root = path.resolve(import.meta.dirname, '..');
    const mentions: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.') || entry.name.startsWith('dist') || entry.name === 'release') continue;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(abs);
        else if (/\.(?:ts|tsx|mts|js|mjs|cjs|json)$/.test(entry.name) && !entry.name.endsWith('.test.ts') && (await fs.readFile(abs, 'utf8')).includes('unsafeNetForTests')) mentions.push(path.relative(root, abs));
      }
    };
    for (const dir of ['server', 'cli', 'mcp', 'electron', 'scripts', 'src', 'shared']) await walk(path.join(root, dir));
    assert.deepEqual(mentions.sort(), ['server/context.ts', 'server/index.ts', 'server/testkit.ts'], 'only the option itself, its doc comment, and the test kit');
    assert.doesNotMatch(await fs.readFile(path.join(root, 'server', 'config.ts'), 'utf8'), /NetHooks|ssrf/i, 'config cannot carry it');
    assert.doesNotMatch(await fs.readFile(path.join(root, 'server', 'ssrf.ts'), 'utf8'), /process\.env/, 'nor can the environment');
    assert.doesNotMatch(await fs.readFile(path.join(root, 'server', 'bookmarks.ts'), 'utf8'), /process\.env/);
  });

  it('rejects what must never be stored, and saves nothing', async () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,<script>1</script>', 'file:///etc/passwd', 'ftp://example.com/x', 'https://user:pw@example.com/', 'example.com/no-scheme', '']) {
      const res = await t.api<ApiError>('POST', '/api/bookmarks', { url: bad });
      assert.deepEqual([res.status, res.json.code], [400, 'invalid'], bad);
    }
    assert.equal((await t.api('POST', '/api/bookmarks', {})).status, 400);
    assert.equal((await t.api('POST', '/api/bookmarks', { url: url('/article'), tags: 'not-an-array' })).status, 400);
    const links = await fs.readdir(path.join(t.vault, 'Library', 'Links'));
    assert.equal(links.some((n) => /alert|passwd|example\.com/.test(n)), false);
  });

  it('the folder goes through the one path resolver: no traversal, no dot-folders, no read-only link', async () => {
    for (const [dir, status] of [['../outside', 403], ['/etc', 403], ['.centcom', 403], ['Library/.hidden', 403], ['Library/Vendor', 403], ['Library/Vendor/sub', 403], ['README.md', 400]] as [string, number][]) {
      const res = await t.api<ApiError>('POST', '/api/bookmarks', { url: url('/article'), dir });
      assert.equal(res.status, status, dir);
    }
    await assert.rejects(fs.stat(path.join(t.vault, '..', 'outside')));
  });

  it('refresh: fills in what a failed save could not, keeps notes, tags and a chosen title, and reports failure without touching the file', async () => {
    siteUp = false;
    const saved = await save({ url: url('/flaky'), note: 'my notes stay', tags: ['keep-me'], agent: 'codex' });
    assert.deepEqual([saved.status, saved.json.title], [201, 'site.test/flaky']);
    assert.match(String(saved.json.frontmatter.fetch_error), /could not be reached/);
    const file = path.join(t.vault, saved.json.path);
    const beforeBytes = await fs.readFile(file, 'utf8');

    const failed = await t.api<ApiError>('POST', '/api/bookmarks/refresh', { path: saved.json.path });
    assert.equal(failed.status, 502);
    assert.doesNotMatch(failed.json.error, /UPSTREAM|503|maintenance/);
    assert.equal(await fs.readFile(file, 'utf8'), beforeBytes, 'a failed refresh changes nothing');

    siteUp = true;
    const refreshed = await t.api<Doc>('POST', '/api/bookmarks/refresh', { path: saved.json.path, agent: 'cursor' });
    assert.equal(refreshed.status, 200);
    const fm = refreshed.json.frontmatter;
    assert.deepEqual([refreshed.json.title, fm.description, fm.tags, fm.saved_by, fm.saved, fm.fetch_error, refreshed.json.body], ['Back online', 'Recovered description', ['keep-me'], 'codex', saved.json.frontmatter.saved, undefined, 'my notes stay']);
    assert.match(String(fm.image), /^Library\/Links\/assets\/site-test-flaky-[0-9a-f]{8}\.png$/);
    assert.equal(find(await tree(), saved.json.path)?.thumb, fm.image, 'the tree picks the new thumb up');

    // A title a person chose survives a refresh.
    await t.api('PUT', '/api/doc', { path: saved.json.path, frontmatter: { title: 'What I call it' } });
    assert.equal((await t.api<Doc>('POST', '/api/bookmarks/refresh', { path: saved.json.path })).json.title, 'What I call it');

    assert.equal((await t.api('POST', '/api/bookmarks/refresh', { path: 'README.md' })).status, 400, 'not a bookmark');
    assert.equal((await t.api('POST', '/api/bookmarks/refresh', { path: 'Library/Links/nope.md' })).status, 404);
    assert.equal((await t.api('POST', '/api/bookmarks/refresh', { path: '../x.md' })).status, 403);
  });

  it('deleting a bookmark takes its preview to the trash with it, and restoring brings both back', async () => {
    const saved = await save({ url: url('/article?for=trash'), dir: 'Library/Disposable' });
    const image = String(saved.json.frontmatter.image);
    assert.match(image, /^Library\/Disposable\/assets\//);

    const del = await t.api<{ trashId: string }>('DELETE', `/api/doc?path=${encodeURIComponent(saved.json.path)}`);
    assert.equal(del.status, 200);
    await assert.rejects(fs.stat(path.join(t.vault, image)), 'the preview left with its bookmark');
    await assert.rejects(fs.stat(path.join(t.vault, 'Library/Disposable/assets')), 'and the emptied previews folder does not linger');
    assert.deepEqual(find(await tree(), 'Library/Disposable')?.children, [], 'nothing is left behind in the tree');
    assert.deepEqual((await t.api<{ name: string }[]>('GET', '/api/trash')).json.filter((i) => i.name.endsWith('.png')), [], 'the preview is not a trash item of its own');

    assert.deepEqual((await t.api('POST', '/api/trash/restore', { id: del.json.trashId })).json, { path: saved.json.path });
    assert.deepEqual(await fs.readFile(path.join(t.vault, image)), PNG);
    const root = await tree();
    assert.equal(find(root, saved.json.path)?.thumb, image);
    assert.equal(find(root, 'Library/Disposable/assets'), undefined, 'hidden again, because its one file is a preview again');

    // A link that points its image at somebody's real file never drags that file into the trash.
    await fs.writeFile(path.join(t.vault, 'Taste', 'hero.png'), PNG);
    await t.api('PUT', '/api/doc', { path: 'Library/Disposable/Borrowed.md', body: '', frontmatter: { type: 'link', url: 'https://example.org/b', image: 'Taste/hero.png' } });
    assert.equal((await t.api('DELETE', '/api/doc?path=Library/Disposable/Borrowed.md')).status, 200);
    assert.deepEqual(await fs.readFile(path.join(t.vault, 'Taste', 'hero.png')), PNG);
  });

  it('save_bookmark over MCP requires agent + url and lands in the chosen folder', async () => {
    const rpc = async (args: Record<string, unknown>) => {
      const res = await fetch(`${t.base}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'save_bookmark', arguments: args } }),
      });
      const payload = (await res.json()) as { result?: { content: { text: string }[]; isError?: boolean }; error?: unknown };
      return { isError: payload.error !== undefined || payload.result?.isError === true, text: payload.result?.content[0]?.text ?? '' };
    };
    const ok = await rpc({ agent: 'claude-code', url: url('/article?via=mcp'), note: 'Found while debugging.', tags: ['mcp'], folder: 'Library/Research' });
    assert.equal(ok.isError, false, ok.text);
    const doc = JSON.parse(ok.text) as Doc;
    assert.deepEqual([doc.path, doc.frontmatter.saved_by, doc.frontmatter.tags, doc.body], ['Library/Research/An Article About Things Stuff.md', 'claude-code', ['mcp'], 'Found while debugging.']);
    assert.equal((await rpc({ url: url('/article') })).isError, true, 'agent is required');
    assert.equal((await rpc({ agent: 'claude-code' })).isError, true, 'url is required');

    const guide = await fetch(`${t.base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) });
    const tools = ((await guide.json()) as { result: { tools: { name: string; inputSchema: { required?: string[] } }[] } }).result.tools;
    assert.deepEqual(tools.find((x) => x.name === 'save_bookmark')?.inputSchema.required?.sort(), ['agent', 'url']);
  });
});
