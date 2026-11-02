/**
 * Any file type is a first-class citizen: PDFs, video and audio are classified, served with the
 * right type and with HTTP Range, and every non-markdown file can carry a hidden sidecar note
 * that moves, copies and is trashed with it.
 */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { SearchHit, TreeNode } from '../shared/types.ts';
import { canHaveSidecar, fileKind, vaultContentType } from './paths.ts';
import { parseRange } from './routes.ts';
import { rawRequest, startTestServer, type TestServer } from './testkit.ts';

function find(node: TreeNode, p: string): TreeNode | undefined {
  if (node.path === p) return node;
  for (const child of node.children ?? []) {
    const hit = find(child, p);
    if (hit) return hit;
  }
  return undefined;
}

describe('file kinds (pure)', () => {
  it('classifies by extension, case-insensitively', () => {
    const cases: Record<string, string> = {
      'notes.md': 'markdown', 'notes.MDX': 'markdown', 'shot.PNG': 'image', 'logo.svg': 'image',
      'paper.pdf': 'pdf', 'Paper.PDF': 'pdf',
      'clip.mp4': 'video', 'clip.mov': 'video', 'clip.webm': 'video', 'clip.M4V': 'video',
      'song.mp3': 'audio', 'take.wav': 'audio', 'memo.m4a': 'audio', 'x.aac': 'audio', 'x.ogg': 'audio', 'x.FLAC': 'audio',
      'archive.zip': 'other', 'run.sh': 'other', 'Makefile': 'other', 'data.csv': 'other', 'movie.mkv': 'other',
    };
    for (const [name, kind] of Object.entries(cases)) assert.equal(fileKind(name), kind, name);
  });

  it('serves media with a type a browser can play, and never lets vault content run as script', () => {
    const types: Record<string, string> = {
      'a.pdf': 'application/pdf', 'a.mp4': 'video/mp4', 'a.m4v': 'video/mp4', 'a.mov': 'video/quicktime', 'a.webm': 'video/webm',
      'a.mp3': 'audio/mpeg', 'a.wav': 'audio/wav', 'a.m4a': 'audio/mp4', 'a.aac': 'audio/aac', 'a.ogg': 'audio/ogg', 'a.flac': 'audio/flac',
      'a.html': 'text/plain; charset=utf-8', 'a.js': 'text/plain; charset=utf-8', 'a.css': 'text/plain; charset=utf-8', 'a.xhtml': 'text/plain; charset=utf-8',
      'a.svg': 'image/svg+xml', 'a.unknown': 'application/octet-stream',
    };
    for (const [name, type] of Object.entries(types)) assert.equal(vaultContentType(name), type, name);
  });

  it('a sidecar needs a host with an extension that is not markdown', () => {
    for (const name of ['a.png', 'a.pdf', 'a.mp4', 'a.mp3', 'a.zip', 'run.sh']) assert.equal(canHaveSidecar(name), true, name);
    for (const name of ['README', 'LICENSE', 'Makefile', 'notes.md', 'notes.mdx', '.hidden']) assert.equal(canHaveSidecar(name), false, name);
  });
});

describe('Range header parsing (pure)', () => {
  it('handles the three byte-range forms, clamps to the file, and ignores what it cannot serve', () => {
    assert.deepEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 });
    assert.deepEqual(parseRange('bytes=500-', 1000), { start: 500, end: 999 });
    assert.deepEqual(parseRange('bytes=-200', 1000), { start: 800, end: 999 });
    assert.deepEqual(parseRange('bytes=-5000', 1000), { start: 0, end: 999 });
    assert.deepEqual(parseRange('bytes=900-5000', 1000), { start: 900, end: 999 });
    assert.deepEqual(parseRange(' Bytes = 0 - 0 ', 1000), { start: 0, end: 0 });
    assert.equal(parseRange('bytes=1000-', 1000), 'unsatisfiable');
    assert.equal(parseRange('bytes=5000-6000', 1000), 'unsatisfiable');
    assert.equal(parseRange('bytes=-0', 1000), 'unsatisfiable');
    assert.equal(parseRange('bytes=0-', 0), 'unsatisfiable');
    for (const ignored of [undefined, '', 'bytes=', 'bytes=-', 'bytes=5-2', 'bytes=0-1,5-9', 'items=0-5', 'bytes=a-b', 'bytes=99999999999999999999-']) assert.equal(parseRange(ignored, 1000), null, String(ignored));
  });
});

describe('any file type over HTTP', () => {
  let t: TestServer;
  const BYTES = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));
  const upload = (dir: string, name: string, bytes: Buffer = BYTES) =>
    fetch(`${t.base}/api/upload?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(name)}&agent=codex`, { method: 'POST', body: new Uint8Array(bytes), headers: { 'Content-Type': 'application/octet-stream' } });
  const tree = async (): Promise<TreeNode> => (await t.api<TreeNode>('GET', '/api/tree')).json;

  before(async () => {
    t = await startTestServer();
  });
  after(() => t.close());

  it('upload accepts any type and the tree reports its kind', async () => {
    const expected: [string, string][] = [['paper.pdf', 'pdf'], ['clip.mp4', 'video'], ['clip.mov', 'video'], ['memo.m4a', 'audio'], ['song.flac', 'audio'], ['bundle.zip', 'other'], ['model.glb', 'other'], ['noext', 'other']];
    for (const [name, kind] of expected) {
      const res = await upload('Taste/Media', name);
      assert.equal(res.status, 201, name);
      assert.equal(((await res.json()) as TreeNode).kind, kind, name);
    }
    const root = await tree();
    for (const [name, kind] of expected) assert.equal(find(root, `Taste/Media/${name}`)?.kind, kind, name);
  });

  it('/api/raw serves pdf / video / audio with the right Content-Type and advertises ranges', async () => {
    for (const [name, type] of [['paper.pdf', 'application/pdf'], ['clip.mp4', 'video/mp4'], ['clip.mov', 'video/quicktime'], ['memo.m4a', 'audio/mp4'], ['song.flac', 'audio/flac']] as const) {
      const res = await fetch(`${t.base}/api/raw/Taste/Media/${name}`);
      assert.deepEqual([res.status, res.headers.get('content-type'), res.headers.get('accept-ranges'), res.headers.get('content-length')], [200, type, 'bytes', '1000'], name);
      assert.deepEqual(Buffer.from(await res.arrayBuffer()), BYTES);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.doesNotMatch(res.headers.get('content-security-policy') ?? '', /sandbox/, `${name}: a built-in viewer cannot run in a sandbox`);
      assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'none'/);
    }
  });

  it('Range requests: 206 with the exact slice, suffix and open-ended forms, 416 when unsatisfiable', async () => {
    const get = (range: string, extra: Record<string, string> = {}) => rawRequest(t.port, { path: '/api/raw/Taste/Media/clip.mp4', headers: { Range: range, ...extra } });
    const slice = async (range: string): Promise<{ status: number; contentRange: string | undefined; body: Buffer }> => {
      const res = await fetch(`${t.base}/api/raw/Taste/Media/clip.mp4`, { headers: { Range: range } });
      return { status: res.status, contentRange: res.headers.get('content-range') ?? undefined, body: Buffer.from(await res.arrayBuffer()) };
    };

    const first = await slice('bytes=0-99');
    assert.deepEqual([first.status, first.contentRange, first.body.length], [206, 'bytes 0-99/1000', 100]);
    assert.deepEqual(first.body, BYTES.subarray(0, 100));
    const middle = await slice('bytes=250-499');
    assert.deepEqual([middle.status, middle.contentRange], [206, 'bytes 250-499/1000']);
    assert.deepEqual(middle.body, BYTES.subarray(250, 500));
    const tail = await slice('bytes=-10');
    assert.deepEqual([tail.status, tail.contentRange], [206, 'bytes 990-999/1000']);
    assert.deepEqual(tail.body, BYTES.subarray(990));
    const open = await slice('bytes=900-');
    assert.deepEqual([open.status, open.contentRange, open.body.length], [206, 'bytes 900-999/1000', 100]);
    const probe = await slice('bytes=0-'); // what <video> sends first
    assert.deepEqual([probe.status, probe.contentRange, probe.body.length], [206, 'bytes 0-999/1000', 1000]);

    const headers = (await get('bytes=0-99')).headers;
    assert.deepEqual([headers['content-length'], headers['content-type'], headers['accept-ranges']], ['100', 'video/mp4', 'bytes']);

    const beyond = await get('bytes=1000-2000');
    assert.deepEqual([beyond.status, beyond.headers['content-range']], [416, 'bytes */1000']);
    assert.equal((await get('bytes=0-1,5-9')).status, 200, 'several ranges: the whole file, which the spec allows');
    assert.equal((await get('lines=0-5')).status, 200);
  });

  it('If-Range only honours the range while the file is unchanged; If-None-Match still wins', async () => {
    const etag = (await fetch(`${t.base}/api/raw/Taste/Media/clip.mp4`)).headers.get('etag') ?? '';
    assert.ok(etag);
    assert.equal((await rawRequest(t.port, { path: '/api/raw/Taste/Media/clip.mp4', headers: { Range: 'bytes=0-9', 'If-Range': etag } })).status, 206);
    assert.equal((await rawRequest(t.port, { path: '/api/raw/Taste/Media/clip.mp4', headers: { Range: 'bytes=0-9', 'If-Range': '"stale"' } })).status, 200);
    assert.equal((await rawRequest(t.port, { path: '/api/raw/Taste/Media/clip.mp4', headers: { Range: 'bytes=0-9', 'If-None-Match': etag } })).status, 304);
  });

  it('keeps the hardening for html / js / css / svg, ranges or not', async () => {
    await upload('Taste/Media', 'page.html', Buffer.from('<script>alert(1)</script>'));
    await upload('Taste/Media', 'app.js', Buffer.from('alert(1)'));
    await upload('Taste/Media', 'site.css', Buffer.from('body{}'));
    await upload('Taste/Media', 'logo.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'));
    for (const [name, type] of [['page.html', 'text/plain; charset=utf-8'], ['app.js', 'text/plain; charset=utf-8'], ['site.css', 'text/plain; charset=utf-8'], ['logo.svg', 'image/svg+xml']] as const) {
      for (const headers of [{}, { Range: 'bytes=0-3' }] as Record<string, string>[]) {
        const res = await rawRequest(t.port, { path: `/api/raw/Taste/Media/${name}`, headers });
        assert.equal(res.headers['content-type'], type, name);
        assert.match(String(res.headers['content-security-policy']), /^sandbox; default-src 'none'/, name);
        assert.equal(res.headers['x-content-type-options'], 'nosniff');
      }
    }
  });

  it('a pdf gets a sidecar: hidden from the tree, exposed on its node, found by search', async () => {
    assert.equal((await t.api('PUT', '/api/doc', { path: 'Taste/Media/paper.pdf.md', body: 'Why I kept this: the typography is superlativus.', frontmatter: { title: 'The good paper', tags: ['typography'] }, agent: 'codex' })).status, 200);
    const root = await tree();
    assert.equal(find(root, 'Taste/Media/paper.pdf')?.sidecar, 'Taste/Media/paper.pdf.md');
    assert.equal(find(root, 'Taste/Media/paper.pdf.md'), undefined, 'the note is not a tree entry of its own');
    for (const q of ['superlativus', 'typography', 'good paper', 'paper.pdf']) {
      const hits = (await t.api<SearchHit[]>('GET', `/api/search?q=${encodeURIComponent(q)}`)).json;
      assert.deepEqual(hits.filter((h) => h.path.startsWith('Taste/Media/paper')).map((h) => [h.type, h.path]), [['doc', 'Taste/Media/paper.pdf']], `q=${q}`);
    }
    assert.equal((await t.api<SearchHit[]>('GET', '/api/search?q=clip.mp4')).json[0]?.path, 'Taste/Media/clip.mp4', 'media is found by name even without a note');
    assert.deepEqual((await t.api<SearchHit[]>('GET', '/api/search?q=bundle.zip')).json, [], 'other files only once they have a note');
  });

  it('video, audio and other files get sidecars too, but README + README.md stay two documents', async () => {
    for (const host of ['clip.mp4', 'memo.m4a', 'bundle.zip']) await t.api('PUT', '/api/doc', { path: `Taste/Media/${host}.md`, body: `note for ${host}` });
    await upload('Library', 'README', Buffer.from('plain readme'));
    await t.api('PUT', '/api/doc', { path: 'Library/README.md', body: 'markdown readme' });
    const root = await tree();
    for (const host of ['clip.mp4', 'memo.m4a', 'bundle.zip']) {
      assert.equal(find(root, `Taste/Media/${host}`)?.sidecar, `Taste/Media/${host}.md`, host);
      assert.equal(find(root, `Taste/Media/${host}.md`), undefined, host);
    }
    assert.equal(find(root, 'Library/README')?.sidecar, undefined);
    assert.ok(find(root, 'Library/README.md'), 'not mistaken for a sidecar');
    assert.equal((await t.api<SearchHit[]>('GET', '/api/search?q=bundle.zip')).json[0]?.path, 'Taste/Media/bundle.zip');
  });

  it('the sidecar moves, is duplicated, is trashed and is restored with its file', async () => {
    assert.deepEqual((await t.api('POST', '/api/move', { from: 'Taste/Media/paper.pdf', to: 'Library/Research/renamed.pdf' })).json, { path: 'Library/Research/renamed.pdf' });
    let root = await tree();
    assert.equal(find(root, 'Library/Research/renamed.pdf')?.sidecar, 'Library/Research/renamed.pdf.md');
    assert.equal(find(root, 'Taste/Media/paper.pdf'), undefined);
    await assert.rejects(fs.stat(path.join(t.vault, 'Taste/Media/paper.pdf.md')), 'the note left with it');

    assert.deepEqual((await t.api('POST', '/api/duplicate', { path: 'Library/Research/renamed.pdf' })).json, { path: 'Library/Research/renamed copy.pdf' });
    assert.equal(find(await tree(), 'Library/Research/renamed copy.pdf')?.sidecar, 'Library/Research/renamed copy.pdf.md');

    const del = await t.api<{ trashId: string }>('DELETE', '/api/doc?path=Library/Research/renamed.pdf');
    assert.equal(del.status, 200);
    await assert.rejects(fs.stat(path.join(t.vault, 'Library/Research/renamed.pdf.md')), 'the note went to the trash too');
    assert.deepEqual((await t.api('POST', '/api/trash/restore', { id: del.json.trashId })).json, { path: 'Library/Research/renamed.pdf' });
    root = await tree();
    assert.equal(find(root, 'Library/Research/renamed.pdf')?.sidecar, 'Library/Research/renamed.pdf.md');
    assert.match(await fs.readFile(path.join(t.vault, 'Library/Research/renamed.pdf.md'), 'utf8'), /superlativus/);
  });
});
