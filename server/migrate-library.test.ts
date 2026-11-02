import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { Doc } from '../shared/types.ts';
import { startServer } from './index.ts';
import { startTestServer, tempDir } from './testkit.ts';

async function write(root: string, rel: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await fs.writeFile(path.join(root, rel), content);
}

async function exists(abs: string): Promise<boolean> {
  return fs.lstat(abs).then(
    () => true,
    () => false,
  );
}

/** Every file under `dir`, relative to it, sorted. */
async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    for (const entry of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(child);
      else out.push(child);
    }
  };
  await walk('');
  return out.sort();
}

describe('Wiki → Library migration at startup', () => {
  it('renames a project Wiki folder to Library, sidecars and dot-files included', async () => {
    const t = await startTestServer({
      prepare: async (vault) => {
        await write(vault, 'Projects/Alpha/Wiki/Page.md', '# Page\n');
        await write(vault, 'Projects/Alpha/Wiki/Deep/Nested.md', 'nested\n');
        await write(vault, 'Projects/Alpha/Wiki/shot.png', 'png');
        await write(vault, 'Projects/Alpha/Wiki/shot.png.md', 'why this shot\n');
        await write(vault, 'Projects/Alpha/Wiki/.obsidian-note', 'hidden\n');
      },
    });
    try {
      const project = path.join(t.vault, 'Projects/Alpha');
      assert.equal(await exists(path.join(project, 'Wiki')), false);
      assert.deepEqual(await listFiles(path.join(project, 'Library')), ['.obsidian-note', 'Deep/Nested.md', 'Page.md', 'shot.png', 'shot.png.md']);
      const doc = await t.api<Doc>('GET', '/api/doc?path=Projects/Alpha/Library/Page.md');
      assert.equal(doc.status, 200);
      assert.equal(doc.json.body, '# Page');
    } finally {
      await t.close();
    }
  });

  it('merges into an existing Library without overwriting anything, and a second start changes nothing', async () => {
    const t = await startTestServer({
      prepare: async (vault) => {
        await write(vault, 'Projects/Beta/Library/Same.md', 'same\n');
        await write(vault, 'Projects/Beta/Library/Diff.md', 'library version\n');
        await write(vault, 'Projects/Beta/Library/shot.png', 'library png');
        await write(vault, 'Projects/Beta/Library/Sub/Other.md', 'other\n');
        await write(vault, 'Projects/Beta/Wiki/Same.md', 'same\n');
        await write(vault, 'Projects/Beta/Wiki/Diff.md', 'wiki version\n');
        await write(vault, 'Projects/Beta/Wiki/Only.md', 'only in wiki\n');
        await write(vault, 'Projects/Beta/Wiki/shot.png', 'wiki png');
        await write(vault, 'Projects/Beta/Wiki/shot.png.md', 'note on the wiki png\n');
        await write(vault, 'Projects/Beta/Wiki/Sub/Inner.md', 'inner\n');
      },
    });
    const library = path.join(t.vault, 'Projects/Beta/Library');
    const expected = ['Diff (from Wiki).md', 'Diff.md', 'Only.md', 'Same.md', 'Sub/Inner.md', 'Sub/Other.md', 'shot (from Wiki).png', 'shot (from Wiki).png.md', 'shot.png'];
    let restarted: Awaited<ReturnType<typeof startServer>> | null = null;
    try {
      assert.equal(await exists(path.join(t.vault, 'Projects/Beta/Wiki')), false);
      assert.deepEqual(await listFiles(library), expected);
      assert.equal(await fs.readFile(path.join(library, 'Diff.md'), 'utf8'), 'library version\n');
      assert.equal(await fs.readFile(path.join(library, 'Diff (from Wiki).md'), 'utf8'), 'wiki version\n');
      assert.equal(await fs.readFile(path.join(library, 'shot.png'), 'utf8'), 'library png');
      assert.equal(await fs.readFile(path.join(library, 'shot (from Wiki).png'), 'utf8'), 'wiki png');
      assert.equal(await fs.readFile(path.join(library, 'shot (from Wiki).png.md'), 'utf8'), 'note on the wiki png\n');

      const mtimes = await Promise.all(expected.map(async (f) => (await fs.stat(path.join(library, f))).mtimeMs));
      await t.server.close();
      restarted = await startServer({ port: 0, host: '127.0.0.1', vault: t.vault, configDir: t.configDir, quiet: true, uiDir: path.join(t.configDir, 'no-ui') });
      assert.deepEqual(await listFiles(library), expected);
      assert.deepEqual(await Promise.all(expected.map(async (f) => (await fs.stat(path.join(library, f))).mtimeMs)), mtimes);
    } finally {
      await restarted?.close();
      await t.close();
    }
  });

  it('never follows or moves a symlinked Wiki or a symlinked project', async () => {
    const outside = await tempDir('outside');
    await write(outside, 'wiki/Theirs.md', 'theirs\n');
    await write(outside, 'project/Wiki/Page.md', 'page\n');
    const t = await startTestServer({
      prepare: async (vault) => {
        await fs.mkdir(path.join(vault, 'Projects/Gamma'), { recursive: true });
        await fs.symlink(path.join(outside, 'wiki'), path.join(vault, 'Projects/Gamma/Wiki'));
        await fs.symlink(path.join(outside, 'project'), path.join(vault, 'Projects/Delta'));
      },
    });
    try {
      assert.equal((await fs.lstat(path.join(t.vault, 'Projects/Gamma/Wiki'))).isSymbolicLink(), true);
      assert.equal(await exists(path.join(t.vault, 'Projects/Gamma/Library')), false);
      assert.deepEqual(await listFiles(path.join(outside, 'wiki')), ['Theirs.md']);
      assert.deepEqual(await listFiles(path.join(outside, 'project')), ['Wiki/Page.md']);
    } finally {
      await t.close();
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});
