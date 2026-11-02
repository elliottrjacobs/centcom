import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Doc, SearchHit, TreeNode } from '../shared/types.ts';
import { startTestServer, type TestServer } from './testkit.ts';

/** Old `Projects/<Name>/Wiki/…` paths keep working after the rename; they land on, and report, `…/Library/…`. */
describe('Wiki paths are aliases of Library', () => {
  let t: TestServer;
  const lib = (rel: string) => path.join(t.vault, 'Projects/Atlas/Library', rel);
  before(async () => {
    t = await startTestServer();
    await t.api('POST', '/api/projects', { name: 'Atlas', key: 'ATL' });
  });
  after(() => t.close());

  it('PUT, POST and GET through a Wiki path read and write the Library file', async () => {
    const put = await t.api<Doc>('PUT', '/api/doc', { path: 'Projects/Atlas/Wiki/Plan.md', body: 'the plan' });
    assert.equal(put.status, 200);
    assert.equal(put.json.path, 'Projects/Atlas/Library/Plan.md');
    assert.equal(await fs.readFile(lib('Plan.md'), 'utf8'), 'the plan\n');

    const post = await t.api<Doc>('POST', '/api/doc', { path: 'Projects/Atlas/wiki/Lower.md', body: 'lower-case alias' });
    assert.equal(post.json.path, 'Projects/Atlas/Library/Lower.md');

    const got = await t.api<Doc>('GET', '/api/doc?path=Projects/Atlas/Wiki/Plan.md');
    assert.equal(got.json.path, 'Projects/Atlas/Library/Plan.md');
    assert.equal(got.json.body, 'the plan');
  });

  it('raw bytes, folders and uploads go through the alias', async () => {
    await fs.writeFile(lib('data.txt'), 'raw bytes');
    const raw = await fetch(`${t.base}/api/raw/Projects/Atlas/Wiki/data.txt`);
    assert.equal(raw.status, 200);
    assert.equal(await raw.text(), 'raw bytes');

    const folder = await t.api<TreeNode>('POST', '/api/folder', { path: 'Projects/Atlas/Wiki/Specs' });
    assert.equal(folder.json.path, 'Projects/Atlas/Library/Specs');

    const up = await fetch(`${t.base}/api/upload?dir=${encodeURIComponent('Projects/Atlas/Wiki/Specs')}&name=spec.pdf`, { method: 'POST', body: new Uint8Array([37, 80, 68, 70]) });
    assert.equal(up.status, 201);
    assert.equal(((await up.json()) as TreeNode).path, 'Projects/Atlas/Library/Specs/spec.pdf');
    assert.equal((await fs.readFile(lib('Specs/spec.pdf'))).length, 4);
  });

  it('move (both ends), duplicate and delete accept Wiki paths', async () => {
    await t.api('PUT', '/api/doc', { path: 'Projects/Atlas/Library/Draft.md', body: 'draft' });
    const moved = await t.api<{ path: string }>('POST', '/api/move', { from: 'Projects/Atlas/Wiki/Draft.md', to: 'Projects/Atlas/Wiki/Final.md' });
    assert.equal(moved.status, 200);
    assert.equal(moved.json.path, 'Projects/Atlas/Library/Final.md');
    assert.equal(await fs.readFile(lib('Final.md'), 'utf8'), 'draft\n');

    const copy = await t.api<{ path: string }>('POST', '/api/duplicate', { path: 'Projects/Atlas/Wiki/Final.md' });
    assert.equal(copy.json.path, 'Projects/Atlas/Library/Final copy.md');

    const del = await t.api('DELETE', `/api/doc?path=${encodeURIComponent('Projects/Atlas/Wiki/Final copy.md')}`);
    assert.equal(del.status, 200);
    assert.equal(await fs.stat(lib('Final copy.md')).catch(() => null), null);
  });

  it('search finds Library docs in the tasks scope, and a Wiki path scope means the Library', async () => {
    await t.api('PUT', '/api/doc', { path: 'Projects/Atlas/Library/Runbook.md', body: 'zebra runbook' });
    await t.api('PUT', '/api/doc', { path: 'Library/Zebra.md', body: 'zebra elsewhere' });
    const tasks = (await t.api<SearchHit[]>('GET', '/api/search?q=zebra&scope=tasks')).json;
    assert.deepEqual(tasks.map((h) => h.path), ['Projects/Atlas/Library/Runbook.md']);
    const scoped = (await t.api<SearchHit[]>('GET', `/api/search?q=zebra&scope=${encodeURIComponent('Projects/Atlas/Wiki')}`)).json;
    assert.deepEqual(scoped.map((h) => h.path), ['Projects/Atlas/Library/Runbook.md']);
  });

  it('a deliverable reported at a Wiki path is stored at its Library path', async () => {
    const res = await t.api<{ url: string }>('POST', '/api/agents/codex/deliverables', { title: 'Plan', url: 'Projects/Atlas/Wiki/Plan.md', kind: 'doc' });
    assert.equal(res.json.url, 'Projects/Atlas/Library/Plan.md');
  });

  it('something trashed from a Wiki before the rename is restored into the Library', async () => {
    const id = `${Date.now()}-Old.md`;
    await fs.writeFile(path.join(t.vault, '.trash', id), 'from before\n');
    await fs.writeFile(path.join(t.vault, '.trash', `${id}.json`), JSON.stringify({ originalPath: 'Projects/Atlas/Wiki/Old.md', name: 'Old.md', deletedAt: Date.now(), isDir: false }));
    const restored = await t.api<{ path: string }>('POST', '/api/trash/restore', { id });
    assert.equal(restored.status, 200);
    assert.equal(restored.json.path, 'Projects/Atlas/Library/Old.md');
    assert.equal(await fs.readFile(lib('Old.md'), 'utf8'), 'from before\n');
  });

  it('MCP lists a Wiki folder as the Library, and get_project reports a Library section', async () => {
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = await fetch(`${t.base}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      });
      const payload = (await res.json()) as { result: { content: { text: string }[]; isError?: boolean } };
      assert.notEqual(payload.result.isError, true, payload.result.content[0]?.text);
      return JSON.parse(payload.result.content[0]?.text ?? 'null') as Record<string, unknown>;
    };
    await t.api('PUT', '/api/doc', { path: 'Projects/Atlas/Library/Listed.md', body: 'listed' });
    const folder = await call('list_folder', { path: 'Projects/Atlas/Wiki' });
    assert.equal(folder.path, 'Projects/Atlas/Library');
    assert.ok((folder.children as { path: string }[]).some((c) => c.path === 'Projects/Atlas/Library/Listed.md'));
    const project = await call('get_project', { project: 'ATL' });
    const sections = project.sections as Record<string, { path: string }[]>;
    assert.ok(sections.Library?.some((f) => f.path === 'Projects/Atlas/Library/Listed.md'));
    assert.equal(sections.Wiki, undefined);
  });

  it('a project whose Wiki is still on disk (e.g. a symlink the migration skipped) is not aliased', async () => {
    await fs.mkdir(path.join(t.vault, 'Projects/Atlas/Wiki'), { recursive: true });
    try {
      const put = await t.api<Doc>('PUT', '/api/doc', { path: 'Projects/Atlas/Wiki/Kept.md', body: 'kept' });
      assert.equal(put.json.path, 'Projects/Atlas/Wiki/Kept.md');
    } finally {
      await fs.rm(path.join(t.vault, 'Projects/Atlas/Wiki'), { recursive: true, force: true });
    }
  });
});
