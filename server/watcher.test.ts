/**
 * Bulk changes made on disk while the server runs (a `git pull` inside a linked folder's real
 * target, an import into a plain vault folder) must reach the tree, search and skill discovery
 * without anyone calling reload. Every directory here is a throwaway under os.tmpdir().
 */
import assert from 'node:assert/strict';
import { mkdirSync, promises as fs, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { SearchHit, TreeNode } from '../shared/types.ts';
import { createContext, closeContext, makeLogger } from './context.ts';
import { openEvents, rawRequest, sleep, startTestServer, tempDir, type TestServer } from './testkit.ts';
import { defaultWatchBackend, startWatcher } from './watcher.ts';

export function find(node: TreeNode, p: string): TreeNode | undefined {
  if (node.path === p) return node;
  for (const child of node.children ?? []) {
    const hit = find(child, p);
    if (hit) return hit;
  }
  return undefined;
}

async function waitUntil<T>(probe: () => Promise<T | undefined | false>, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}.`);
    await sleep(40);
  }
}

const NEW_SKILLS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];

/**
 * What a checkout does: folders and the files inside them, one after another with a breath in
 * between (git writes a tree path by path; it does not materialise eight folders in one tick).
 * That pacing is what loses events: see the root-cause note in `server/watcher.ts`.
 */
async function writeSkill(root: string, name: string, marker: string, gapMs = 1): Promise<void> {
  const gap = () => (gapMs > 0 ? sleep(gapMs) : Promise.resolve());
  mkdirSync(path.join(root, name), { recursive: true });
  writeFileSync(path.join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: The ${name} skill (${marker})\n---\n# ${name}\n\nBody mentions ${marker}${name}.\n`);
  await gap();
  mkdirSync(path.join(root, name, 'references', 'deep'), { recursive: true });
  writeFileSync(path.join(root, name, 'references', 'guide.md'), `Guide for ${name}: ${marker}guide${name}\n`);
  await gap();
  writeFileSync(path.join(root, name, 'references', 'deep', 'notes.md'), `Deep notes for ${name}: ${marker}deep${name}\n`);
  mkdirSync(path.join(root, name, 'scripts'), { recursive: true });
  writeFileSync(path.join(root, name, 'scripts', 'run.sh'), '#!/bin/sh\necho hi\n');
  await gap();
}

async function listSkills(t: TestServer): Promise<{ name: string; path: string }[]> {
  const res = await fetch(`${t.base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_skills', arguments: {} } }),
  });
  const payload = (await res.json()) as { result: { content: { text: string }[] } };
  return JSON.parse(payload.result.content[0]?.text ?? '[]') as { name: string; path: string }[];
}

/** Tree, search and skill discovery all see every new skill, nested files included. */
async function assertAllVisible(t: TestServer, mount: string, marker: string, timeoutMs: number): Promise<void> {
  await waitUntil(
    async () => {
      const tree = (await t.api<TreeNode>('GET', '/api/tree')).json;
      return NEW_SKILLS.every((name) => find(tree, `${mount}/${name}/SKILL.md`) && find(tree, `${mount}/${name}/references/deep/notes.md`) && find(tree, `${mount}/${name}/scripts/run.sh`));
    },
    timeoutMs,
    `all ${NEW_SKILLS.length} new folders under ${mount} to appear in the tree`,
  );
  for (const name of NEW_SKILLS) {
    const hits = (await t.api<SearchHit[]>('GET', `/api/search?q=${marker}deep${name}`)).json;
    assert.deepEqual(hits.map((h) => h.path), [`${mount}/${name}/references/deep/notes.md`], `search finds the nested file of ${name}`);
  }
  if (mount.startsWith('Skills/')) {
    const skills = (await listSkills(t)).map((s) => s.path);
    for (const name of NEW_SKILLS) assert.ok(skills.includes(`${mount}/${name}/SKILL.md`), `list_skills discovers ${name}`);
  }
}

describe('watcher: bulk-created nested folders', () => {
  let t: TestServer;
  let clone: string;

  before(async () => {
    clone = await tempDir('watch-clone');
    // The link target is a SUBFOLDER of the (pretend) clone, as it is for a real skills repo.
    await fs.mkdir(path.join(clone, '.git'), { recursive: true });
    for (const name of ['old-one', 'old-two', 'doomed']) await writeSkill(path.join(clone, 'skills'), name, 'seed', 0);
    t = await startTestServer({
      config: () => ({ links: [{ mount: 'Skills/shared', target: path.join(clone, 'skills') }] }),
      prepare: async (vault) => {
        await fs.mkdir(path.join(vault, 'Library', 'Imports', 'existing'), { recursive: true });
        await fs.writeFile(path.join(vault, 'Library', 'Imports', 'existing', 'note.md'), 'already here\n');
      },
    });
  });
  after(async () => {
    await t.close();
    await fs.rm(clone, { recursive: true, force: true });
  });

  it('inside a link target: one folder removed and eight nested folders added in one burst', async () => {
    const tree = (await t.api<TreeNode>('GET', '/api/tree')).json;
    assert.ok(find(tree, 'Skills/shared/doomed/SKILL.md'), 'precondition: the seed skills are indexed');

    const root = path.join(clone, 'skills');
    rmSync(path.join(root, 'doomed'), { recursive: true, force: true });
    for (const name of NEW_SKILLS) await writeSkill(root, name, 'lnk');

    await assertAllVisible(t, 'Skills/shared', 'lnk', 2000);
    const after = (await t.api<TreeNode>('GET', '/api/tree')).json;
    assert.equal(find(after, 'Skills/shared/doomed'), undefined, 'the removed folder is gone');
    assert.ok(find(after, 'Skills/shared/old-one/SKILL.md'), 'untouched folders stay');
  });

  it('inside a plain vault folder: the same burst', async () => {
    const root = path.join(t.vault, 'Library', 'Imports');
    rmSync(path.join(root, 'existing'), { recursive: true, force: true });
    for (const name of NEW_SKILLS) await writeSkill(root, name, 'vlt');
    await assertAllVisible(t, 'Library/Imports', 'vlt', 2000);
    assert.equal(find((await t.api<TreeNode>('GET', '/api/tree')).json, 'Library/Imports/existing'), undefined);
  });

  it('a second burst into folders the watcher only just learned about is seen too', async () => {
    const root = path.join(clone, 'skills');
    for (const name of NEW_SKILLS) {
      mkdirSync(path.join(root, name, 'references', 'deep', 'deeper'), { recursive: true });
      writeFileSync(path.join(root, name, 'references', 'deep', 'deeper', 'late.md'), `late addition latemark${name}\n`);
    }
    await waitUntil(
      async () => {
        const tree = (await t.api<TreeNode>('GET', '/api/tree')).json;
        return NEW_SKILLS.every((name) => find(tree, `Skills/shared/${name}/references/deep/deeper/late.md`));
      },
      2000,
      'files added deep inside the new folders',
    );
  });
});

describe('POST /api/reindex', () => {
  let t: TestServer;
  before(async () => {
    t = await startTestServer();
  });
  after(() => t.close());

  it('reconciles the index with the disk and broadcasts a tree event', async () => {
    const events = await openEvents(t.port);
    try {
      // Written and reindexed back to back: far inside the watcher's own latency (FSEvents alone
      // takes tens of ms, then an 80 ms debounce), so what the tree shows next came from the reindex.
      mkdirSync(path.join(t.vault, 'Library', 'Bulk', 'nested', 'deeper'), { recursive: true });
      writeFileSync(path.join(t.vault, 'Library', 'Bulk', 'nested', 'deeper', 'found.md'), '---\ntitle: Found by reindex\n---\nreindexmarker\n');
      const res = await t.api<{ ok: boolean; files: number }>('POST', '/api/reindex');
      assert.equal(res.status, 200);
      assert.deepEqual([res.json.ok, res.json.files], [true, 1]);
      const tree = (await t.api<TreeNode>('GET', '/api/tree')).json;
      assert.equal(find(tree, 'Library/Bulk/nested/deeper/found.md')?.title, 'Found by reindex');
      assert.equal((await t.api<SearchHit[]>('GET', '/api/search?q=reindexmarker')).json[0]?.path, 'Library/Bulk/nested/deeper/found.md');
      await events.waitFor((e) => e.type === 'tree');

      // Nothing to do is still a success, and still tells clients to refetch.
      const before = events.events.length;
      assert.deepEqual((await t.api<{ ok: boolean; files: number }>('POST', '/api/reindex')).json.files, 0);
      await events.waitFor((e) => e.type === 'tree' && events.events.indexOf(e) >= before);

      // Removals are reconciled too.
      rmSync(path.join(t.vault, 'Library', 'Bulk'), { recursive: true, force: true });
      await t.api('POST', '/api/reindex');
      assert.equal(find((await t.api<TreeNode>('GET', '/api/tree')).json, 'Library/Bulk'), undefined);
    } finally {
      events.close();
    }
  });

  it('is an ordinary authenticated endpoint: a remote caller needs the token, and with it is allowed', async () => {
    const proxied = { 'X-Forwarded-For': '203.0.113.9', 'Content-Type': 'application/json' };
    assert.equal((await rawRequest(t.port, { method: 'POST', path: '/api/reindex', headers: proxied, body: '{}' })).status, 401);
    assert.equal((await rawRequest(t.port, { method: 'POST', path: '/api/reindex', headers: { ...proxied, Authorization: `Bearer ${t.token}` }, body: '{}' })).status, 200);
  });
});

describe('watch backends', () => {
  it('macOS gets one recursive handle per root; everything else keeps chokidar', () => {
    assert.equal(defaultWatchBackend('darwin'), 'native');
    assert.equal(defaultWatchBackend('linux'), 'chokidar');
    assert.equal(defaultWatchBackend('win32'), 'chokidar');
  });

  for (const backend of ['native', 'chokidar'] as const) {
    it(`${backend}: indexes a new nested folder, maps link targets to their mount, ignores dot-folders`, { skip: backend === 'native' && process.platform !== 'darwin' && process.platform !== 'win32' }, async () => {
      const vault = await tempDir('wb-vault');
      const configDir = await tempDir('wb-config');
      const target = await tempDir('wb-target');
      await fs.writeFile(path.join(vault, 'README.md'), '# x\n');
      await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify({ links: [{ mount: 'Skills/ext', target }] }));
      const ctx = await createContext(vault, makeLogger(true), { configDir, configPath: path.join(configDir, 'config.json'), user: { id: 'tester', name: 'Tester' } });
      const watcher = startWatcher(ctx, { backend });
      try {
        assert.equal(watcher.backend, backend);
        await watcher.ready;
        // chokidar's "ready" on macOS can precede the FSEvents stream actually running (the same
        // per-directory-handle weakness described in watcher.ts, and why it is not the macOS
        // backend). The native backend proves its own readiness with a probe and needs no grace.
        if (backend === 'chokidar') await sleep(500);
        // One root at a time: under chokidar on macOS, activity in one root can cost the other its
        // events (the very bug this file is about), and this test is about path mapping, not bursts.
        mkdirSync(path.join(vault, 'Library', 'New', 'Inner'), { recursive: true });
        writeFileSync(path.join(vault, 'Library', 'New', 'Inner', 'doc.md'), 'hello\n');
        await waitUntil(async () => ctx.index.files.has('Library/New/Inner/doc.md'), 4000, `${backend} to report the new vault files`);

        if (backend === 'chokidar') await sleep(300);
        mkdirSync(path.join(target, '.git'), { recursive: true });
        writeFileSync(path.join(target, '.git', 'HEAD'), 'ref: refs/heads/main\n');
        mkdirSync(path.join(target, 'skill-a', 'refs'), { recursive: true });
        writeFileSync(path.join(target, 'skill-a', 'SKILL.md'), '# a\n');
        writeFileSync(path.join(target, 'skill-a', 'refs', 'r.md'), 'r\n');
        await waitUntil(async () => ctx.index.files.has('Skills/ext/skill-a/SKILL.md') && ctx.index.files.has('Skills/ext/skill-a/refs/r.md'), 4000, `${backend} to map the link target's files to its mount`);
        assert.equal([...ctx.index.files.keys()].some((p) => p.includes('.git')), false);

        if (backend === 'chokidar') await sleep(300);
        rmSync(path.join(target, 'skill-a'), { recursive: true, force: true });
        await waitUntil(async () => !ctx.index.dirs.has('Skills/ext/skill-a'), 4000, `${backend} to report the removal`);
      } finally {
        await watcher.close();
        await closeContext(ctx);
        for (const dir of [vault, configDir, target]) await fs.rm(dir, { recursive: true, force: true });
      }
    });
  }
});
