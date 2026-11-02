import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { ApiError, Doc, Project, SearchHit, TreeNode } from '../shared/types.ts';
import { startTestServer, type TestServer } from './testkit.ts';

// Smallest valid PNG: 1×1 transparent pixel.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

type TrashItem = { id: string; name: string; originalPath: string; deletedAt: number; isDir: boolean };

function find(node: TreeNode, p: string): TreeNode | undefined {
  if (node.path === p) return node;
  for (const child of node.children ?? []) {
    const hit = find(child, p);
    if (hit) return hit;
  }
  return undefined;
}

describe('documents', () => {
  let t: TestServer;
  before(async () => {
    t = await startTestServer();
  });
  after(() => t.close());

  const upload = (dir: string, name: string, bytes: Buffer) =>
    fetch(`${t.base}/api/upload?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(name)}`, { method: 'POST', body: new Uint8Array(bytes), headers: { 'Content-Type': 'application/octet-stream' } });

  it('writes and reads a doc with frontmatter; what you PUT is what you GET', async () => {
    const put = await t.api<Doc>('PUT', '/api/doc', { path: 'Library/Learnings/caching.md', body: '# Caching\n\nInvalidate carefully.', frontmatter: { title: 'On caching', tags: ['perf', 'infra'], date: '2026-09-19' }, agent: 'codex' });
    assert.equal(put.status, 200);
    assert.equal(put.json.title, 'On caching');
    const got = await t.api<Doc>('GET', '/api/doc?path=Library/Learnings/caching.md');
    assert.equal(got.json.body, '# Caching\n\nInvalidate carefully.');
    assert.deepEqual(got.json.frontmatter, { title: 'On caching', tags: ['perf', 'infra'], date: '2026-09-19' });
    assert.equal(got.json.mtime, put.json.mtime);
    const raw = await fs.readFile(path.join(t.vault, 'Library/Learnings/caching.md'), 'utf8');
    assert.equal(raw, "---\ntitle: On caching\ntags:\n  - perf\n  - infra\ndate: '2026-09-19'\n---\n# Caching\n\nInvalidate carefully.\n");
  });

  it('shallow-merges frontmatter and removes keys set to null', async () => {
    const res = await t.api<Doc>('PUT', '/api/doc', { path: 'Library/Learnings/caching.md', frontmatter: { tags: ['perf'], date: null, reviewed: true } });
    assert.deepEqual(res.json.frontmatter, { title: 'On caching', tags: ['perf'], reviewed: true });
    assert.equal(res.json.body, '# Caching\n\nInvalidate carefully.', 'body untouched when omitted');
  });

  it('leaves a hand-written frontmatter block byte-for-byte intact on body-only saves', async () => {
    const file = path.join(t.vault, 'Library/handmade.md');
    await fs.writeFile(file, '---\n# a comment the author cares about\ntitle:   Spaced   \nwhen: 2026-01-02\n---\nold body\n');
    const res = await t.api<Doc>('PUT', '/api/doc', { path: 'Library/handmade.md', body: 'new body' });
    assert.equal(res.status, 200);
    assert.equal(res.json.frontmatter.when, '2026-01-02');
    assert.equal(await fs.readFile(file, 'utf8'), '---\n# a comment the author cares about\ntitle:   Spaced   \nwhen: 2026-01-02\n---\nnew body\n');
  });

  it('never loses content when frontmatter is malformed', async () => {
    const file = path.join(t.vault, 'Library/broken.md');
    const original = '---\ntitle: [oops\n---\nprecious words\n';
    await fs.writeFile(file, original);
    const got = await t.api<Doc>('GET', '/api/doc?path=Library/broken.md');
    assert.equal(got.status, 200);
    assert.deepEqual(got.json.frontmatter, {});
    assert.equal(`${got.json.body}\n`, original);
    await t.api('PUT', '/api/doc', { path: 'Library/broken.md', body: got.json.body });
    assert.equal(await fs.readFile(file, 'utf8'), original);
  });

  it('ifMatch: a stale mtime is a 409 conflict and nothing is written', async () => {
    const first = await t.api<Doc>('PUT', '/api/doc', { path: 'Library/race.md', body: 'v1' });
    // Someone else (another agent, an editor) saves in between.
    await new Promise((r) => setTimeout(r, 15));
    const second = await t.api<Doc>('PUT', '/api/doc', { path: 'Library/race.md', body: 'v2 by someone else', ifMatch: first.json.mtime });
    assert.equal(second.status, 200);
    assert.notEqual(second.json.mtime, first.json.mtime);

    const stale = await t.api<ApiError>('PUT', '/api/doc', { path: 'Library/race.md', body: 'v3 from a stale editor', ifMatch: first.json.mtime });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.code, 'conflict');
    assert.equal((await t.api<Doc>('GET', '/api/doc?path=Library/race.md')).json.body, 'v2 by someone else');

    const fresh = await t.api<Doc>('PUT', '/api/doc', { path: 'Library/race.md', body: 'v3 after reload', ifMatch: second.json.mtime });
    assert.equal(fresh.status, 200);

    const gone = await t.api<ApiError>('PUT', '/api/doc', { path: 'Library/never-existed.md', body: 'x', ifMatch: 123 });
    assert.equal(gone.status, 409);
    assert.equal(gone.json.code, 'conflict');
  });

  it('ifMatch: of two simultaneous saves from the same base, exactly one wins', async () => {
    const base = await t.api<Doc>('PUT', '/api/doc', { path: 'Library/duel.md', body: 'base' });
    await new Promise((r) => setTimeout(r, 15));
    const results = await Promise.all(['A', 'B', 'C', 'D'].map((who) => t.api<Doc | ApiError>('PUT', '/api/doc', { path: 'Library/duel.md', body: `from ${who}`, ifMatch: base.json.mtime })));
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409, 409, 409]);
  });

  it('POST /api/doc refuses to overwrite: 409 exists', async () => {
    const first = await t.api<Doc>('POST', '/api/doc', { path: 'Library/Links/once.md', body: 'first', frontmatter: { url: 'https://example.com' } });
    assert.equal(first.status, 201);
    const again = await t.api<ApiError>('POST', '/api/doc', { path: 'Library/Links/once.md', body: 'second' });
    assert.equal(again.status, 409);
    assert.equal(again.json.code, 'exists');
    assert.equal((await t.api<Doc>('GET', '/api/doc?path=Library/Links/once.md')).json.body, 'first');
  });

  it('reads plain text files (skill scripts) and refuses binaries and folders', async () => {
    await t.api('PUT', '/api/doc', { path: 'Skills/deploy/scripts/run.sh', body: '#!/bin/sh\necho hi\n' });
    const script = await t.api<Doc>('GET', '/api/doc?path=Skills/deploy/scripts/run.sh');
    assert.equal(script.json.body, '#!/bin/sh\necho hi\n');
    assert.deepEqual(script.json.frontmatter, {});
    assert.equal((await t.api('PUT', '/api/doc', { path: 'Skills/deploy/scripts/run.sh', frontmatter: { a: 1 } })).status, 400);
    assert.equal((await upload('Taste/Visual', 'bin.png', PNG)).status, 201);
    assert.equal((await t.api<ApiError>('GET', '/api/doc?path=Taste/Visual/bin.png')).status, 400);
    assert.equal((await t.api<ApiError>('GET', '/api/doc?path=Library')).status, 400);
    assert.equal((await t.api<ApiError>('GET', '/api/doc?path=Library/nope.md')).json.code, 'not_found');
    assert.equal((await t.api<ApiError>('GET', '/api/doc')).status, 400);
  });

  it('every route refuses unsafe paths', async () => {
    const attempts: [string, string, unknown?][] = [
      ['GET', '/api/doc?path=../../etc/passwd'],
      ['GET', '/api/doc?path=/etc/passwd'],
      ['GET', '/api/doc?path=.centcom/agents.json'],
      ['GET', `/api/doc?path=${encodeURIComponent('Library/a\0.md')}`],
      ['PUT', '/api/doc', { path: '../evil.md', body: 'x' }],
      ['PUT', '/api/doc', { path: 'Skills/.hidden/SKILL.md', body: 'x' }],
      ['POST', '/api/doc', { path: '/tmp/evil.md', body: 'x' }],
      ['DELETE', '/api/doc?path=..'],
      ['DELETE', '/api/doc?path=.trash'],
      ['POST', '/api/folder', { path: 'Library/../../out' }],
      ['POST', '/api/move', { from: 'Library/race.md', to: '../race.md' }],
      ['POST', '/api/move', { from: '.centcom/agents.json', to: 'Library/agents.md' }],
      ['POST', '/api/duplicate', { path: '.centcom/counters.json' }],
      ['GET', '/api/raw/.centcom/agents.json'],
      ['GET', '/api/raw/..%2F..%2Fetc%2Fpasswd'],
      ['GET', '/api/raw/%2Fetc%2Fpasswd'],
      ['POST', '/api/trash/restore', { id: '../Library/race.md' }],
      ['DELETE', '/api/trash?id=..%2F..%2FLibrary'],
    ];
    for (const [method, url, body] of attempts) {
      const res = await t.api<ApiError>(method, url, body);
      assert.ok(res.status === 403 || res.status === 400, `${method} ${url} → ${res.status}`);
      assert.ok(res.json.code === 'forbidden' || res.json.code === 'invalid', `${method} ${url} → ${JSON.stringify(res.json)}`);
    }
    assert.equal((await upload('../outside', 'a.png', PNG)).status, 403);
    assert.equal((await upload('Taste', '../a.png', PNG)).status, 400);
    assert.equal((await upload('Taste', '.hidden.png', PNG)).status, 403);
    await assert.rejects(fs.stat(path.join(t.vault, '..', 'evil.md')));
    assert.equal((await fs.readFile(path.join(t.vault, '.centcom', 'agents.json'), 'utf8')).includes('"owner"'), true, 'internal files untouched');
  });

  it('refuses to follow a symlink out of the vault, on read and on write', async () => {
    const outside = path.join(t.configDir, 'outside.md');
    await fs.writeFile(outside, 'outside the vault');
    await fs.symlink(outside, path.join(t.vault, 'Library', 'link.md'));
    await fs.symlink(t.configDir, path.join(t.vault, 'Library', 'linkdir'));
    assert.equal((await t.api('GET', '/api/doc?path=Library/link.md')).status, 403);
    assert.equal((await t.api('GET', '/api/raw/Library/link.md')).status, 403);
    assert.equal((await t.api('PUT', '/api/doc', { path: 'Library/link.md', body: 'pwned' })).status, 403);
    assert.equal((await t.api('PUT', '/api/doc', { path: 'Library/linkdir/new.md', body: 'pwned' })).status, 403);
    assert.equal(await fs.readFile(outside, 'utf8'), 'outside the vault');
    const tree = (await t.api<TreeNode>('GET', '/api/tree')).json;
    assert.equal(find(tree, 'Library/link.md'), undefined, 'symlinks are not listed');
    assert.equal(find(tree, 'Library/linkdir'), undefined);
  });

  it('upload: serves bytes back, de-dupes names, keeps sidecars out of the tree', async () => {
    const first = (await (await upload('Taste/Visual', 'shot.png', PNG)).json()) as TreeNode;
    const second = (await (await upload('Taste/Visual', 'shot.png', PNG)).json()) as TreeNode;
    assert.equal(first.path, 'Taste/Visual/shot.png');
    assert.equal(first.kind, 'image');
    assert.equal(first.size, PNG.length);
    assert.equal(second.path, 'Taste/Visual/shot 2.png');

    const raw = await fetch(`${t.base}/api/raw/Taste/Visual/shot%202.png`);
    assert.equal(raw.status, 200);
    assert.equal(raw.headers.get('content-type'), 'image/png');
    assert.equal(raw.headers.get('cache-control'), 'no-store', 'vault content never lands in a browser or proxy cache');
    assert.match(raw.headers.get('content-security-policy') ?? '', /sandbox/);
    assert.match(raw.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
    assert.match(raw.headers.get('permissions-policy') ?? '', /camera=\(\)/);
    assert.equal(raw.headers.get('referrer-policy'), 'no-referrer');
    assert.deepEqual(Buffer.from(await raw.arrayBuffer()), PNG);
    const etag = raw.headers.get('etag') as string;
    assert.ok(etag);
    assert.equal((await fetch(`${t.base}/api/raw/Taste/Visual/shot%202.png`, { headers: { 'If-None-Match': etag } })).status, 304);

    // Names that need escaping survive the round trip, however the prefix is spelled.
    await t.api('PUT', '/api/doc', { path: 'Library/100% real & odd #1.md', body: 'odd name' });
    const odd = await fetch(`${t.base}/api/raw/Library/${encodeURIComponent('100% real & odd #1.md')}`);
    assert.equal(await odd.text(), 'odd name\n');
    assert.equal(await (await fetch(`${t.base}/api/r%61w/Library/${encodeURIComponent('100% real & odd #1.md')}`)).text(), 'odd name\n');

    await t.api('PUT', '/api/doc', { path: 'Taste/Visual/shot.png.md', body: 'Calm, dense, great type scale.', frontmatter: { tags: ['dashboard'] } });
    const tree = (await t.api<TreeNode>('GET', '/api/tree')).json;
    assert.equal(find(tree, 'Taste/Visual/shot.png')?.sidecar, 'Taste/Visual/shot.png.md');
    assert.equal(find(tree, 'Taste/Visual/shot.png.md'), undefined, 'the sidecar is hidden');
    const hits = (await t.api<SearchHit[]>('GET', '/api/search?q=dense')).json;
    assert.deepEqual(hits.map((h) => [h.type, h.path]), [['image', 'Taste/Visual/shot.png']]);
  });

  it('upload: never serves vault HTML/SVG as something a browser would run in our origin', async () => {
    await upload('Library', 'page.html', Buffer.from('<script>alert(1)</script>'));
    const html = await fetch(`${t.base}/api/raw/Library/page.html`);
    assert.equal(html.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(html.headers.get('x-content-type-options'), 'nosniff');
    await upload('Taste/Visual', 'logo.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'));
    const svg = await fetch(`${t.base}/api/raw/Taste/Visual/logo.svg`);
    assert.equal(svg.headers.get('content-type'), 'image/svg+xml');
    assert.match(svg.headers.get('content-security-policy') ?? '', /^sandbox;/);
  });

  it('move: files, folders, sidecars travel with their image, 409 when the target exists', async () => {
    const moved = await t.api<{ path: string }>('POST', '/api/move', { from: 'Taste/Visual/shot.png', to: 'Taste/Visual/Dashboards/hero.png', agent: 'cursor' });
    assert.deepEqual(moved.json, { path: 'Taste/Visual/Dashboards/hero.png' });
    const tree = (await t.api<TreeNode>('GET', '/api/tree')).json;
    assert.equal(find(tree, 'Taste/Visual/Dashboards/hero.png')?.sidecar, 'Taste/Visual/Dashboards/hero.png.md');
    assert.equal(find(tree, 'Taste/Visual/shot.png'), undefined);
    await assert.rejects(fs.stat(path.join(t.vault, 'Taste/Visual/shot.png.md')));

    await t.api('PUT', '/api/doc', { path: 'Library/a.md', body: 'a' });
    await t.api('PUT', '/api/doc', { path: 'Library/b.md', body: 'b' });
    const clash = await t.api<ApiError>('POST', '/api/move', { from: 'Library/a.md', to: 'Library/b.md' });
    assert.equal(clash.status, 409);
    assert.equal(clash.json.code, 'exists');
    assert.equal((await t.api<Doc>('GET', '/api/doc?path=Library/b.md')).json.body, 'b');

    assert.equal((await t.api('POST', '/api/move', { from: 'Library/Learnings', to: 'Library/Notes/Learnings' })).status, 200);
    assert.equal((await t.api<Doc>('GET', '/api/doc?path=Library/Notes/Learnings/caching.md')).json.title, 'On caching');
    assert.equal((await t.api('POST', '/api/move', { from: 'Library/Notes', to: 'Library/Notes/Inner' })).status, 400);
    assert.equal((await t.api('POST', '/api/move', { from: 'Library/ghost.md', to: 'Library/x.md' })).status, 404);
    assert.equal((await t.api('POST', '/api/move', { from: 'Skills', to: 'Abilities' })).status, 400, 'structural folders stay put');
  });

  it('soft delete + restore, for a file and for a folder; restore is a 409 when the spot is taken', async () => {
    await t.api('PUT', '/api/doc', { path: 'Library/Research/paper.md', body: 'findings', frontmatter: { title: 'The Paper' } });
    const del = await t.api<{ ok: boolean; trashId: string }>('DELETE', '/api/doc?path=Library/Research/paper.md&agent=codex');
    assert.equal(del.json.ok, true);
    assert.match(del.json.trashId, /^\d+-paper\.md$/);
    assert.equal((await t.api('GET', '/api/doc?path=Library/Research/paper.md')).status, 404);
    assert.equal(JSON.parse(await fs.readFile(path.join(t.vault, '.trash', `${del.json.trashId}.json`), 'utf8')).originalPath, 'Library/Research/paper.md');
    assert.equal(find((await t.api<TreeNode>('GET', '/api/tree')).json, '.trash'), undefined, 'dot-folders never appear in the tree');

    const listed = (await t.api<TrashItem[]>('GET', '/api/trash')).json;
    assert.deepEqual(listed.filter((x) => x.id === del.json.trashId).map((x) => [x.name, x.originalPath, x.isDir]), [['paper.md', 'Library/Research/paper.md', false]]);

    // The original spot gets taken while the file is in the trash.
    await t.api('PUT', '/api/doc', { path: 'Library/Research/paper.md', body: 'a newer paper' });
    const blocked = await t.api<ApiError>('POST', '/api/trash/restore', { id: del.json.trashId });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.json.code, 'conflict');
    await t.api('POST', '/api/move', { from: 'Library/Research/paper.md', to: 'Library/Research/paper v2.md' });
    assert.deepEqual((await t.api('POST', '/api/trash/restore', { id: del.json.trashId })).json, { path: 'Library/Research/paper.md' });
    assert.equal((await t.api<Doc>('GET', '/api/doc?path=Library/Research/paper.md')).json.body, 'findings');
    assert.equal((await t.api('POST', '/api/trash/restore', { id: del.json.trashId })).status, 404);

    const folder = await t.api<{ trashId: string }>('DELETE', '/api/doc?path=Library/Research');
    assert.equal((await t.api('GET', '/api/doc?path=Library/Research/paper.md')).status, 404);
    assert.equal((await t.api<TrashItem[]>('GET', '/api/trash')).json.find((x) => x.id === folder.json.trashId)?.isDir, true);
    await t.api('POST', '/api/trash/restore', { id: folder.json.trashId });
    assert.equal((await t.api<Doc>('GET', '/api/doc?path=Library/Research/paper v2.md')).json.body, 'a newer paper');
    assert.equal((await t.api('DELETE', '/api/doc?path=Library')).status, 400, 'structural folders cannot be deleted');
  });

  it('an image goes to the trash and comes back together with its note', async () => {
    const del = await t.api<{ trashId: string }>('DELETE', '/api/doc?path=Taste/Visual/Dashboards/hero.png');
    await assert.rejects(fs.stat(path.join(t.vault, 'Taste/Visual/Dashboards/hero.png.md')));
    assert.equal((await t.api<TrashItem[]>('GET', '/api/trash')).json.filter((x) => x.originalPath.includes('hero.png')).length, 1, 'one entry, not two');
    await t.api('POST', '/api/trash/restore', { id: del.json.trashId });
    assert.equal(find((await t.api<TreeNode>('GET', '/api/tree')).json, 'Taste/Visual/Dashboards/hero.png')?.sidecar, 'Taste/Visual/Dashboards/hero.png.md');
  });

  it('emptying the trash is permanent and scoped to the trash', async () => {
    await t.api('PUT', '/api/doc', { path: 'Library/tmp1.md', body: '1' });
    await t.api('PUT', '/api/doc', { path: 'Library/tmp2.md', body: '2' });
    const one = await t.api<{ trashId: string }>('DELETE', '/api/doc?path=Library/tmp1.md');
    await t.api('DELETE', '/api/doc?path=Library/tmp2.md');
    assert.deepEqual((await t.api('DELETE', `/api/trash?id=${encodeURIComponent(one.json.trashId)}`)).json, { ok: true });
    assert.equal((await t.api<TrashItem[]>('GET', '/api/trash')).json.some((x) => x.id === one.json.trashId), false);
    assert.deepEqual((await t.api('DELETE', '/api/trash')).json, { ok: true });
    assert.deepEqual((await t.api<TrashItem[]>('GET', '/api/trash')).json, []);
    assert.equal((await t.api<Doc>('GET', '/api/doc?path=Library/b.md')).json.body, 'b', 'the vault itself is untouched');
  });

  it('folders and duplicates', async () => {
    const folder = await t.api<TreeNode>('POST', '/api/folder', { path: 'Library/Fresh/Nested' });
    assert.equal(folder.status, 201);
    assert.deepEqual([folder.json.type, folder.json.path, folder.json.children], ['dir', 'Library/Fresh/Nested', []]);
    assert.equal((await t.api<ApiError>('POST', '/api/folder', { path: 'Library/Fresh/Nested' })).json.code, 'exists');

    assert.deepEqual((await t.api('POST', '/api/duplicate', { path: 'Library/b.md' })).json, { path: 'Library/b copy.md' });
    assert.deepEqual((await t.api('POST', '/api/duplicate', { path: 'Library/b.md' })).json, { path: 'Library/b copy 2.md' });
    assert.deepEqual((await t.api('POST', '/api/duplicate', { path: 'Library/Notes' })).json, { path: 'Library/Notes copy' });
    assert.equal((await t.api<Doc>('GET', '/api/doc?path=Library/Notes copy/Learnings/caching.md')).json.title, 'On caching');
  });

  it('caps JSON bodies at 5 MB', async () => {
    const res = await t.api<ApiError>('PUT', '/api/doc', { path: 'Library/huge.md', body: 'x'.repeat(5 * 1024 * 1024 + 10) });
    assert.equal(res.status, 413);
    await assert.rejects(fs.stat(path.join(t.vault, 'Library/huge.md')));
  });

  it('tree: dirs first then files, A→Z, natural number order, titles from frontmatter', async () => {
    for (const name of ['Item 10.md', 'Item 2.md', 'apple.md']) await t.api('PUT', '/api/doc', { path: `Library/Sorted/${name}`, body: name });
    await t.api('POST', '/api/folder', { path: 'Library/Sorted/zeta' });
    await t.api('PUT', '/api/doc', { path: 'Library/Sorted/Banana.md', body: '', frontmatter: { title: 'A banana' } });
    const node = find((await t.api<TreeNode>('GET', '/api/tree')).json, 'Library/Sorted');
    assert.deepEqual(node?.children?.map((c) => c.name), ['zeta', 'apple.md', 'Banana.md', 'Item 2.md', 'Item 10.md']);
    assert.equal(node?.children?.find((c) => c.name === 'Banana.md')?.title, 'A banana');
    assert.equal(node?.children?.find((c) => c.name === 'apple.md')?.title, 'apple');
  });
});

describe('projects', () => {
  let t: TestServer;
  before(async () => {
    t = await startTestServer({ seed: true });
  });
  after(() => t.close());

  it('seeds an empty vault once: AGENTS.md, folders, the CENTCOM project and its tickets', async () => {
    const projects = (await t.api<Project[]>('GET', '/api/projects')).json;
    assert.deepEqual(projects.map((p) => [p.slug, p.key, p.status]), [['CENTCOM', 'CEN', 'active']]);
    assert.equal((projects[0]?.counts.todo ?? 0) + (projects[0]?.counts.backlog ?? 0), 3);
    assert.match((await t.api<Doc>('GET', '/api/doc?path=AGENTS.md')).json.body, /shared task tracker/);
    for (const dir of ['Projects', 'Inbox']) {
      assert.equal((await fs.stat(path.join(t.vault, dir))).isDirectory(), true, dir);
    }
    assert.equal((await fs.stat(path.join(t.configDir, 'config.json'))).mode & 0o777, 0o600);
  });

  it('creates section folders, derives unique keys, rejects duplicates', async () => {
    const created = await t.api<Project>('POST', '/api/projects', { name: 'Recall Radar', summary: 'Food safety', agent: 'codex' });
    assert.equal(created.status, 201);
    assert.equal(created.json.key, 'RR');
    assert.equal(created.json.path, 'Projects/Recall Radar');
    for (const section of ['Tickets', 'Library']) assert.equal((await fs.stat(path.join(t.vault, 'Projects/Recall Radar', section))).isDirectory(), true);
    assert.equal(await fs.stat(path.join(t.vault, 'Projects/Recall Radar/Wiki')).catch(() => null), null, 'no Wiki folder any more');
    assert.equal((await t.api<Project>('POST', '/api/projects', { name: 'Rocket Robots' })).json.key, 'ROC', 'RR is taken');
    assert.equal((await t.api<ApiError>('POST', '/api/projects', { name: 'recall radar' })).json.code, 'exists');
    assert.equal((await t.api<ApiError>('POST', '/api/projects', { name: 'Another', key: 'CEN' })).json.code, 'exists');
    assert.equal((await t.api('POST', '/api/projects', { name: 'Bad key', key: 'x1' })).status, 400);
    assert.equal((await t.api('POST', '/api/projects', { name: 'Inboxish', key: 'INB' })).status, 400);
    assert.equal((await t.api('POST', '/api/projects', { name: '../..' })).status, 400);
  });

  it('renaming a project renames its folder; tickets keep their ids', async () => {
    const before = (await t.api<{ id: string }[]>('GET', '/api/tickets?project=CENTCOM')).json.map((x) => x.id).sort();
    const renamed = await t.api<Project>('PATCH', '/api/projects/CENTCOM', { name: 'Command Center', status: 'paused' });
    assert.equal(renamed.json.slug, 'Command Center');
    assert.equal(renamed.json.key, 'CEN');
    assert.equal(renamed.json.status, 'paused');
    assert.equal((await t.api('GET', '/api/projects/CENTCOM')).status, 404);
    assert.equal((await t.api<Project>('GET', '/api/projects/cen')).json.slug, 'Command Center', 'lookup by key');
    const after = (await t.api<{ id: string; project: string; path: string }[]>('GET', '/api/tickets?project=CEN')).json;
    assert.deepEqual(after.map((x) => x.id).sort(), before);
    assert.ok(after.every((x) => x.project === 'Command Center' && x.path.startsWith('Projects/Command Center/Tickets/')));
    assert.equal((await t.api<ApiError>('PATCH', '/api/projects/CEN', { key: 'CMD' })).status, 409, 'key is frozen once tickets exist');
  });

  it('deleting a project is a soft delete of the whole folder', async () => {
    assert.deepEqual((await t.api('DELETE', '/api/projects/Rocket Robots')).json, { ok: true });
    assert.equal((await t.api('GET', '/api/projects/ROC')).status, 404);
    const item = (await t.api<TrashItem[]>('GET', '/api/trash')).json.find((x) => x.originalPath === 'Projects/Rocket Robots');
    assert.equal(item?.isDir, true);
    await t.api('POST', '/api/trash/restore', { id: item?.id });
    assert.equal((await t.api<Project>('GET', '/api/projects/ROC')).json.name, 'Rocket Robots');
  });

  it('search ranks: exact ticket id ≫ title prefix > title substring > path > body', async () => {
    await t.api('PUT', '/api/doc', { path: 'Library/Research/quasar files/x.md', body: 'nothing relevant', frontmatter: { title: 'Filed away' } });
    await t.api('PUT', '/api/doc', { path: 'Library/Research/deep.md', body: `${'Preamble sentence that is only here to take up room. '.repeat(3)}Eventually it mentions a quasar in passing, ${'and then carries on for quite a while longer. '.repeat(3)}`, frontmatter: { title: 'Deep field' } });
    await t.api('PUT', '/api/doc', { path: 'Library/Research/t1.md', body: '', frontmatter: { title: 'Quasar catalogue' } });
    await t.api('PUT', '/api/doc', { path: 'Library/Research/t2.md', body: '', frontmatter: { title: 'The brightest quasar' } });
    const hits = (await t.api<SearchHit[]>('GET', '/api/search?q=quasar')).json;
    assert.deepEqual(hits.map((h) => h.title), ['Quasar catalogue', 'The brightest quasar', 'Filed away', 'Deep field']);
    assert.match(hits[3]?.snippet ?? '', /^….*mentions a quasar in passing.*…$/);
    assert.ok((hits[3]?.snippet?.length ?? 0) <= 6 + 60 + 6 + 60 + 2);

    const byId = (await t.api<SearchHit[]>('GET', '/api/search?q=cen-2')).json;
    assert.equal(byId[0]?.ticket, 'CEN-2');
    assert.equal(byId[0]?.type, 'ticket');
    assert.ok((byId[0]?.score ?? 0) > (byId[1]?.score ?? 0) * 2);
    assert.equal((await t.api<SearchHit[]>('GET', '/api/search?q=recall')).json[0]?.type, 'project');
    assert.deepEqual((await t.api<SearchHit[]>('GET', '/api/search?q=')).json, []);
  });
});
