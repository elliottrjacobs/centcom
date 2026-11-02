import { randomBytes } from 'node:crypto';
import { promises as fs, type Stats } from 'node:fs';
import path from 'node:path';
import { conflict as conflictError, exists as existsError, isErrno } from './errors.ts';
import { splitExt } from './paths.ts';

/* ───────────────────────── Mutexes ───────────────────────── */

/** FIFO async mutex. A rejected task never poisons the queue. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/** One mutex per key, garbage-collected when idle. */
export class KeyedMutex {
  private readonly locks = new Map<string, { mutex: Mutex; waiters: number }>();

  async run<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    let entry = this.locks.get(key);
    if (!entry) {
      entry = { mutex: new Mutex(), waiters: 0 };
      this.locks.set(key, entry);
    }
    entry.waiters += 1;
    try {
      return await entry.mutex.run(fn);
    } finally {
      entry.waiters -= 1;
      if (entry.waiters === 0) this.locks.delete(key);
    }
  }
}

/* ───────────────────────── Stat helpers ───────────────────────── */

export async function statOrNull(abs: string): Promise<Stats | null> {
  try {
    return await fs.stat(abs);
  } catch (err) {
    if (isErrno(err, 'ENOENT', 'ENOTDIR')) return null;
    throw err;
  }
}

export async function lstatOrNull(abs: string): Promise<Stats | null> {
  try {
    return await fs.lstat(abs);
  } catch (err) {
    if (isErrno(err, 'ENOENT', 'ENOTDIR')) return null;
    throw err;
  }
}

export async function pathExists(abs: string): Promise<boolean> {
  return (await lstatOrNull(abs)) !== null;
}

/** Millisecond mtime as an integer. This is the value used for `ifMatch`, ETags and echo de-duping. */
export function mtimeOf(stat: Stats): number {
  return Math.floor(stat.mtimeMs);
}

export function birthOf(stat: Stats): number {
  const b = Math.floor(stat.birthtimeMs);
  return b > 0 ? b : Math.floor(stat.mtimeMs);
}

/* ───────────────────────── Atomic writes ───────────────────────── */

function tempPathFor(abs: string): string {
  // Dot-prefixed: hidden from the tree, ignored by the watcher, unreachable through resolveVaultPath.
  return path.join(path.dirname(abs), `.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
}

async function writeTemp(abs: string, data: string | Uint8Array, createDirs = true): Promise<string> {
  if (createDirs) await fs.mkdir(path.dirname(abs), { recursive: true });
  const tmp = tempPathFor(abs);
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(tmp, 'wx', 0o644);
  } catch (err) {
    // The folder vanished between the caller's checks and now (renamed / trashed concurrently).
    if (!createDirs && isErrno(err, 'ENOENT')) throw conflictError(`${path.basename(abs)} was moved or deleted while it was being saved. Reload and try again.`);
    throw err;
  }
  try {
    await handle.writeFile(data);
    await handle.sync();
  } catch (err) {
    await handle.close().catch(() => undefined);
    await fs.rm(tmp, { force: true });
    throw err;
  }
  await handle.close();
  return tmp;
}

/**
 * Write via a temp file in the same directory, then `rename`. Replacing the inode
 * would reset the file's birthtime on every save, so when overwriting we carry the
 * old birthtime across (on APFS/HFS+, setting mtime earlier than birthtime pulls
 * birthtime back; elsewhere this is a harmless no-op).
 *
 * `createDirs: false` is for rewriting a file that must already exist: it refuses to
 * resurrect a folder that was renamed or trashed underneath us.
 */
export async function atomicWrite(abs: string, data: string | Uint8Array, opts: { createDirs?: boolean } = {}): Promise<Stats> {
  const previous = await statOrNull(abs);
  const tmp = await writeTemp(abs, data, opts.createDirs ?? true);
  try {
    if (previous && previous.birthtimeMs > 0) {
      const now = new Date();
      await fs.utimes(tmp, now, previous.birthtime).catch(() => undefined);
      await fs.utimes(tmp, now, now).catch(() => undefined);
    }
    await fs.rename(tmp, abs);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
  return fs.stat(abs);
}

/**
 * Create a file that must not already exist, atomically and with full content:
 * write a temp file then hard-link it into place (link fails with EEXIST, unlike rename).
 * Falls back to an exclusive open on filesystems without hard links.
 */
export async function atomicCreateExclusive(abs: string, data: string | Uint8Array): Promise<Stats> {
  const tmp = await writeTemp(abs, data);
  try {
    try {
      await fs.link(tmp, abs);
    } catch (err) {
      if (isErrno(err, 'EEXIST')) throw existsError(`${path.basename(abs)} already exists.`);
      if (!isErrno(err, 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS', 'EMLINK')) throw err;
      try {
        await fs.writeFile(abs, data, { flag: 'wx', mode: 0o644 });
      } catch (inner) {
        if (isErrno(inner, 'EEXIST')) throw existsError(`${path.basename(abs)} already exists.`);
        throw inner;
      }
    }
  } finally {
    await fs.rm(tmp, { force: true });
  }
  return fs.stat(abs);
}

/* ───────────────────────── Naming ───────────────────────── */

/** First free name in `dirAbs`: `a.png`, `a 2.png`, `a 3.png`, … */
export async function dedupeName(dirAbs: string, name: string): Promise<string> {
  if (!(await pathExists(path.join(dirAbs, name)))) return name;
  const [stem, ext] = splitExt(name);
  for (let n = 2; n < 10_000; n += 1) {
    const candidate = `${stem} ${n}${ext}`;
    if (!(await pathExists(path.join(dirAbs, candidate)))) return candidate;
  }
  throw existsError(`Could not find a free name for ${name}.`);
}

/** First free "copy" name: `Name copy.md`, `Name copy 2.md`, … */
export async function copyName(dirAbs: string, name: string, isDir: boolean): Promise<string> {
  const [stem, ext] = isDir ? [name, ''] : splitExt(name);
  for (let n = 1; n < 10_000; n += 1) {
    const candidate = n === 1 ? `${stem} copy${ext}` : `${stem} copy ${n}${ext}`;
    if (!(await pathExists(path.join(dirAbs, candidate)))) return candidate;
  }
  throw existsError(`Could not find a free name for a copy of ${name}.`);
}

/**
 * `rename`, surviving a move between volumes. A linked folder can live on another disk than
 * the vault (and so than `.trash`), where rename fails with EXDEV: copy, then remove the source.
 * Symlinks are copied as symlinks, never followed. The destination must not exist.
 */
export async function moveEntry(fromAbs: string, toAbs: string): Promise<void> {
  try {
    await fs.rename(fromAbs, toAbs);
    return;
  } catch (err) {
    if (!isErrno(err, 'EXDEV')) throw err;
  }
  try {
    await fs.cp(fromAbs, toAbs, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, verbatimSymlinks: true });
  } catch (err) {
    // Never leave half a copy behind; the source is still intact at this point.
    await fs.rm(toAbs, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
  await fs.rm(fromAbs, { recursive: true, force: true });
}

/** Move that refuses to clobber. Tolerates case-only renames on case-insensitive filesystems. */
export async function renameNoClobber(fromAbs: string, toAbs: string): Promise<void> {
  const target = await lstatOrNull(toAbs);
  if (target) {
    const source = await fs.lstat(fromAbs);
    const sameEntry = target.ino === source.ino && target.dev === source.dev && fromAbs.toLowerCase() === toAbs.toLowerCase();
    if (!sameEntry) throw existsError(`${path.basename(toAbs)} already exists at the destination.`);
  }
  await fs.mkdir(path.dirname(toAbs), { recursive: true });
  await moveEntry(fromAbs, toAbs);
}

/** Run `fn` over `items` with bounded concurrency. `fn` must handle its own errors. */
export async function mapLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
}

/**
 * Atomically replace a file that holds credential material (hashed tokens, sessions): written
 * 0600 from the first byte, in a 0700 directory, so there is never a moment it is world-readable.
 */
export async function writePrivateFile(abs: string, data: string): Promise<void> {
  await fs.mkdir(path.dirname(abs), { recursive: true, mode: 0o700 });
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}-${randomBytes(6).toString('hex')}.tmp`);
  await fs.writeFile(tmp, data, { mode: 0o600, flag: 'wx' });
  try {
    await fs.rename(tmp, abs);
    await fs.chmod(abs, 0o600);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}
