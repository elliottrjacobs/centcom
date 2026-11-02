import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { HttpError } from './errors.ts';
import { atomicCreateExclusive, atomicWrite, copyName, dedupeName, KeyedMutex, moveEntry, Mutex } from './fsutil.ts';
import { sleep, tempDir } from './testkit.ts';

describe('fs utilities', () => {
  let dir: string;
  before(async () => {
    dir = await tempDir('fsutil');
  });
  after(() => fs.rm(dir, { recursive: true, force: true }));

  it('Mutex runs tasks one at a time, in order, and survives a failing task', async () => {
    const mutex = new Mutex();
    const log: string[] = [];
    let running = 0;
    const task = (name: string, ms: number, fail = false) =>
      mutex.run(async () => {
        running += 1;
        assert.equal(running, 1, 'never two at once');
        log.push(`start ${name}`);
        await sleep(ms);
        running -= 1;
        log.push(`end ${name}`);
        if (fail) throw new Error(`${name} failed`);
        return name;
      });
    const results = await Promise.allSettled([task('a', 20), task('b', 1, true), task('c', 5)]);
    assert.deepEqual(log, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
    assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'rejected', 'fulfilled']);
  });

  it('KeyedMutex serialises per key only', async () => {
    const locks = new KeyedMutex();
    const log: string[] = [];
    await Promise.all([
      locks.run('x', async () => {
        await sleep(20);
        log.push('x1');
      }),
      locks.run('x', async () => void log.push('x2')),
      locks.run('y', async () => void log.push('y1')),
    ]);
    assert.deepEqual(log, ['y1', 'x1', 'x2']);
  });

  it('atomicWrite replaces content, leaves no temp files, and keeps the original creation time', async () => {
    const file = path.join(dir, 'doc.md');
    await fs.writeFile(file, 'one');
    const old = new Date('2026-01-01T00:00:00Z');
    await fs.utimes(file, old, old); // on APFS this also pulls birthtime back
    const born = (await fs.stat(file)).birthtimeMs;
    const stat = await atomicWrite(file, 'two');
    assert.equal(await fs.readFile(file, 'utf8'), 'two');
    assert.ok(stat.mtimeMs > old.getTime() + 1000, 'mtime is now');
    if (process.platform === 'darwin') assert.equal(stat.birthtimeMs, born, 'birthtime carried across the rename');
    assert.deepEqual((await fs.readdir(dir)).filter((n) => n.startsWith('.tmp-')), []);
  });

  it('atomicWrite with createDirs:false refuses to resurrect a vanished folder', async () => {
    await assert.rejects(atomicWrite(path.join(dir, 'gone', 'x.md'), 'x', { createDirs: false }), (err: unknown) => err instanceof HttpError && err.status === 409);
    await assert.rejects(fs.stat(path.join(dir, 'gone')));
  });

  it('atomicCreateExclusive never overwrites, even under a race', async () => {
    const file = path.join(dir, 'exclusive.md');
    const results = await Promise.allSettled(['a', 'b', 'c', 'd', 'e'].map((who) => atomicCreateExclusive(file, who)));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    for (const r of results) if (r.status === 'rejected') assert.equal((r.reason as HttpError).code, 'exists');
    assert.match(await fs.readFile(file, 'utf8'), /^[a-e]$/);
    assert.deepEqual((await fs.readdir(dir)).filter((n) => n.startsWith('.tmp-')), []);
  });

  it('dedupeName and copyName find the first free name', async () => {
    const d = path.join(dir, 'names');
    await fs.mkdir(d);
    assert.equal(await dedupeName(d, 'a.png'), 'a.png');
    await fs.writeFile(path.join(d, 'a.png'), '');
    await fs.writeFile(path.join(d, 'a 2.png'), '');
    assert.equal(await dedupeName(d, 'a.png'), 'a 3.png');
    assert.equal(await copyName(d, 'a.png', false), 'a copy.png');
    await fs.writeFile(path.join(d, 'a copy.png'), '');
    assert.equal(await copyName(d, 'a.png', false), 'a copy 2.png');
    assert.equal(await copyName(d, 'Folder.v2', true), 'Folder.v2 copy');
  });

  it('moveEntry survives EXDEV (another volume): copies, then removes the source, symlinks kept as symlinks', async () => {
    const src = path.join(dir, 'cross-src');
    const dst = path.join(dir, 'cross-dst');
    await fs.mkdir(path.join(src, 'nested'), { recursive: true });
    await fs.writeFile(path.join(src, 'nested', 'file.md'), 'payload');
    await fs.symlink('/etc/hosts', path.join(src, 'a-symlink'));

    const realRename = fs.rename;
    let faked = 0;
    // Same `promises` object fsutil uses, so this is what a cross-volume rename looks like to it.
    (fs as { rename: typeof fs.rename }).rename = async () => {
      faked += 1;
      throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
    };
    try {
      await moveEntry(src, dst);
      const single = path.join(dir, 'single.md');
      await fs.writeFile(single, 'one file');
      await moveEntry(single, path.join(dir, 'single-moved.md'));
    } finally {
      (fs as { rename: typeof fs.rename }).rename = realRename;
    }
    assert.equal(faked, 2);
    await assert.rejects(fs.stat(src), 'source removed');
    assert.equal(await fs.readFile(path.join(dst, 'nested', 'file.md'), 'utf8'), 'payload');
    assert.equal((await fs.lstat(path.join(dst, 'a-symlink'))).isSymbolicLink(), true);
    assert.equal(await fs.readlink(path.join(dst, 'a-symlink')), '/etc/hosts');
    assert.equal(await fs.readFile(path.join(dir, 'single-moved.md'), 'utf8'), 'one file');
  });

  it('moveEntry rethrows anything that is not EXDEV and leaves the source alone', async () => {
    const src = path.join(dir, 'stays.md');
    await fs.writeFile(src, 'still here');
    await assert.rejects(moveEntry(src, path.join(dir, 'no-such-folder', 'x.md')), /ENOENT/);
    assert.equal(await fs.readFile(src, 'utf8'), 'still here');
  });
});
