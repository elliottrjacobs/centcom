import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { TRASH_DIR } from '../shared/types.ts';
import { HttpError } from './errors.ts';
import { makeSafeRoot, parseClientPath, resolveVaultPath, type SafeRoot } from './paths.ts';
import { tempDir } from './testkit.ts';

const NUL = String.fromCharCode(0);

async function rejects(promise: Promise<unknown>, status: number, label: string): Promise<void> {
  await assert.rejects(
    promise,
    (err: unknown) => {
      assert.ok(err instanceof HttpError, `${label}: expected an HttpError, got ${String(err)}`);
      assert.equal(err.status, status, `${label}: status`);
      assert.equal(err.code, status === 403 ? 'forbidden' : 'invalid', `${label}: code`);
      return true;
    },
    label,
  );
}

describe('resolveVaultPath', () => {
  let vaultDir: string;
  let outside: string;
  let vault: SafeRoot;

  before(async () => {
    vaultDir = await tempDir('paths-vault');
    outside = await tempDir('paths-outside');
    await fs.mkdir(path.join(vaultDir, 'Library', 'Learnings'), { recursive: true });
    await fs.mkdir(path.join(vaultDir, '.centcom'), { recursive: true });
    await fs.mkdir(path.join(vaultDir, TRASH_DIR), { recursive: true });
    await fs.writeFile(path.join(vaultDir, 'Library', 'note.md'), 'hello');
    await fs.writeFile(path.join(vaultDir, '.centcom', 'agents.json'), '[]');
    await fs.writeFile(path.join(outside, 'secret.txt'), 'top secret');
    await fs.mkdir(path.join(outside, 'dir'));

    await fs.symlink(path.join(outside, 'secret.txt'), path.join(vaultDir, 'Library', 'leak.md'));
    await fs.symlink(path.join(outside, 'dir'), path.join(vaultDir, 'Library', 'escape'));
    await fs.symlink(path.join(outside, 'does-not-exist'), path.join(vaultDir, 'Library', 'dangling.md'));
    await fs.symlink(path.join(vaultDir, '.centcom'), path.join(vaultDir, 'Library', 'meta'));
    await fs.symlink(path.join(vaultDir, 'Library', 'Learnings'), path.join(vaultDir, 'Library', 'inside-link'));
    await fs.symlink(outside, path.join(vaultDir, TRASH_DIR, '1700000000000-evil'));
    vault = await makeSafeRoot(vaultDir);
  });

  after(async () => {
    await fs.rm(vaultDir, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  it('resolves ordinary relative paths, existing or not', async () => {
    const existing = await resolveVaultPath(vault, 'Library/note.md');
    assert.equal(existing.rel, 'Library/note.md');
    assert.equal(existing.abs, path.join(vaultDir, 'Library', 'note.md'));

    const fresh = await resolveVaultPath(vault, 'Library/New Folder/Deep/idea.md');
    assert.equal(fresh.rel, 'Library/New Folder/Deep/idea.md');
    assert.ok(fresh.abs.startsWith(vaultDir + path.sep));
  });

  it('tolerates duplicate and trailing slashes', async () => {
    assert.equal((await resolveVaultPath(vault, 'Library//note.md')).rel, 'Library/note.md');
    assert.equal((await resolveVaultPath(vault, 'Library/')).rel, 'Library');
  });

  it('rejects path traversal', async () => {
    for (const p of ['../outside.md', 'Library/../../etc/passwd', 'Library/..', '..', 'a/b/../../../c', 'Library/../Library/note.md']) {
      await rejects(resolveVaultPath(vault, p), 403, p);
    }
  });

  it('rejects absolute paths (POSIX, Windows, UNC-ish)', async () => {
    for (const p of ['/etc/passwd', `${vaultDir}/Library/note.md`, 'C:\\Windows\\system32', 'c:/Windows', '\\\\server\\share', '\\etc\\passwd', '///']) {
      await rejects(resolveVaultPath(vault, p), 403, p);
    }
  });

  it('rejects backslashes anywhere', async () => {
    await rejects(resolveVaultPath(vault, 'Library\\..\\..\\secret'), 403, 'backslash traversal');
    await rejects(resolveVaultPath(vault, 'Library/a\\b.md'), 403, 'backslash in name');
  });

  it('rejects every dot-prefixed segment', async () => {
    for (const p of ['.centcom/agents.json', '.trash/x', '.git/config', 'Library/.hidden.md', 'Library/./note.md', '.', '.env', 'Projects/x/.DS_Store', '...']) {
      await rejects(resolveVaultPath(vault, p), 403, p);
    }
  });

  it('rejects NUL bytes and other control characters', async () => {
    await rejects(resolveVaultPath(vault, `Library/note.md${NUL}.png`), 400, 'NUL suffix');
    await rejects(resolveVaultPath(vault, `${NUL}`), 400, 'bare NUL');
    await rejects(resolveVaultPath(vault, `Library/a${String.fromCharCode(10)}b.md`), 400, 'newline');
    await rejects(resolveVaultPath(vault, `Library/a${String.fromCharCode(27)}b.md`), 400, 'escape');
  });

  it('rejects non-strings, empty paths and absurd lengths', async () => {
    for (const p of [undefined, null, 42, {}, ['a']]) await rejects(resolveVaultPath(vault, p), 400, String(p));
    await rejects(resolveVaultPath(vault, ''), 400, 'empty');
    await rejects(resolveVaultPath(vault, `Library/${'x'.repeat(300)}.md`), 400, 'long segment');
    await rejects(resolveVaultPath(vault, 'a/'.repeat(600)), 400, 'long path');
  });

  it('allows the root only when asked', async () => {
    const root = await resolveVaultPath(vault, '', { allowRoot: true });
    assert.equal(root.rel, '');
    assert.equal(root.abs, vaultDir);
  });

  it('rejects a symlinked file that points outside the vault', async () => {
    await rejects(resolveVaultPath(vault, 'Library/leak.md'), 403, 'file symlink');
  });

  it('rejects paths that pass through a symlinked directory leaving the vault', async () => {
    await rejects(resolveVaultPath(vault, 'Library/escape'), 403, 'dir symlink');
    await rejects(resolveVaultPath(vault, 'Library/escape/new-file.md'), 403, 'new file under dir symlink');
    await rejects(resolveVaultPath(vault, 'Library/escape/a/b/c.md'), 403, 'deep new file under dir symlink');
  });

  it('rejects a dangling symlink (writing through it would create a file outside)', async () => {
    await rejects(resolveVaultPath(vault, 'Library/dangling.md'), 403, 'dangling symlink');
  });

  it('rejects a symlink that lands in a hidden directory inside the vault', async () => {
    await rejects(resolveVaultPath(vault, 'Library/meta/agents.json'), 403, 'symlink to .centcom');
  });

  it('allows a symlink that stays inside the visible vault', async () => {
    const ok = await resolveVaultPath(vault, 'Library/inside-link/new.md');
    assert.equal(ok.rel, 'Library/inside-link/new.md');
  });

  it('resolves inside a server-chosen base and still applies every rule', async () => {
    const item = await resolveVaultPath(vault, '1700000000001-note.md', { base: TRASH_DIR });
    assert.equal(item.abs, path.join(vaultDir, TRASH_DIR, '1700000000001-note.md'));
    await rejects(resolveVaultPath(vault, '../Library/note.md', { base: TRASH_DIR }), 403, 'traversal out of base');
    await rejects(resolveVaultPath(vault, '/etc/passwd', { base: TRASH_DIR }), 403, 'absolute in base');
    await rejects(resolveVaultPath(vault, '1700000000000-evil', { base: TRASH_DIR }), 403, 'symlink out of base');
    await rejects(resolveVaultPath(vault, '1700000000000-evil/secret.txt', { base: TRASH_DIR }), 403, 'through symlink out of base');
  });

  it('works when the vault root itself is reached through a symlink', async () => {
    const link = path.join(outside, 'vault-link');
    await fs.symlink(vaultDir, link);
    const viaLink = await makeSafeRoot(link);
    assert.equal((await resolveVaultPath(viaLink, 'Library/note.md')).rel, 'Library/note.md');
    await rejects(resolveVaultPath(viaLink, 'Library/leak.md'), 403, 'escape via symlinked root');
  });

  it('normalises to NFC so one file has one path', () => {
    const decomposed = `Library/cafe${String.fromCharCode(0x301)}.md`;
    assert.deepEqual(parseClientPath(decomposed), ['Library', `caf${String.fromCharCode(0xe9)}.md`]);
  });
});
