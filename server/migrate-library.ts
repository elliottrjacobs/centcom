/**
 * One-time (and idempotent) startup migration: every project's `Wiki` folder becomes `Library`.
 *
 * `Projects/<Name>/Wiki` is renamed to `Projects/<Name>/Library`. When a `Library` is already
 * there the two are merged: nothing is ever overwritten; an identical file is simply dropped from
 * Wiki, a different one moves in as `<name> (from Wiki)<ext>` (its sidecar note travels with it).
 * File contents are never rewritten: old `…/Wiki/…` links keep working through the path alias in
 * `server/paths.ts`. Symlinks and linked mounts are never followed or moved: a project that is a
 * symlink, a Wiki that is one, or a Wiki holding a configured link mount is left alone and logged.
 * Runs before the index is built, so nothing has to be re-announced.
 */
import { promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';
import { LEGACY_LIBRARY_SECTION, LIBRARY_SECTION } from '../shared/types.ts';
import type { Logger } from './context.ts';
import { isErrno } from './errors.ts';
import { lstatOrNull } from './fsutil.ts';
import { canHaveSidecar, splitExt, type VaultLink } from './paths.ts';
import { PROJECTS_DIR } from './model.ts';

export interface LibraryMigration {
  project: string;
  action: 'renamed' | 'merged' | 'skipped';
  /** Entries moved into Library under their own name. */
  moved: number;
  /** Wiki files dropped because Library already held an identical copy. */
  identical: number;
  /** Wiki entries moved in under a `(from Wiki)` name because Library held something different. */
  kept: number;
  /** Why a project was skipped, or why its Wiki could not be removed. */
  note?: string;
}

async function sameContents(a: string, b: string): Promise<boolean> {
  const [sa, sb] = await Promise.all([fs.stat(a), fs.stat(b)]);
  if (sa.size !== sb.size) return false;
  const [ba, bb] = await Promise.all([fs.readFile(a), fs.readFile(b)]);
  return ba.equals(bb);
}

/** `Page (from Wiki).md`, `Page (from Wiki 2).md`, … such that it (and its sidecar, when it can have one) is free. */
async function fromWikiName(dir: string, name: string, isDir: boolean): Promise<string> {
  const [stem, ext] = isDir ? [name, ''] : splitExt(name);
  for (let n = 1; n < 10_000; n += 1) {
    const candidate = `${stem} (from ${LEGACY_LIBRARY_SECTION}${n === 1 ? '' : ` ${n}`})${ext}`;
    if (await lstatOrNull(path.join(dir, candidate))) continue;
    if (!isDir && canHaveSidecar(candidate) && (await lstatOrNull(path.join(dir, `${candidate}.md`)))) continue;
    return candidate;
  }
  throw new Error(`no free name for ${name} in ${dir}`);
}

/** Move everything in `src` into `dst` without overwriting anything. Removes `src` once empty. */
async function merge(src: string, dst: string, tally: LibraryMigration): Promise<void> {
  const names = (await fs.readdir(src)).sort();
  const present = new Set(names);
  // A sidecar travels with its file, so it is handled together with it, not on its own.
  const isSidecar = (name: string): boolean => name.endsWith('.md') && canHaveSidecar(name.slice(0, -3)) && present.has(name.slice(0, -3));

  for (const name of names) {
    if (isSidecar(name)) continue;
    const from = path.join(src, name);
    const to = path.join(dst, name);
    const source = await fs.lstat(from);
    const target = await lstatOrNull(to);
    const sidecar = !source.isDirectory() && present.has(`${name}.md`) ? `${name}.md` : null;

    if (!target) {
      await fs.rename(from, to);
      tally.moved += 1;
      if (sidecar) await merge1(src, dst, sidecar, tally);
      continue;
    }
    if (source.isDirectory() && !source.isSymbolicLink() && target.isDirectory() && !target.isSymbolicLink()) {
      await merge(from, to, tally);
      continue;
    }
    if (source.isFile() && target.isFile() && (await sameContents(from, to))) {
      await fs.rm(from);
      tally.identical += 1;
      if (sidecar) await merge1(src, dst, sidecar, tally);
      continue;
    }
    const kept = await fromWikiName(dst, name, source.isDirectory());
    await fs.rename(from, path.join(dst, kept));
    tally.kept += 1;
    if (sidecar) await fs.rename(path.join(src, sidecar), path.join(dst, `${kept}.md`));
  }

  try {
    await fs.rmdir(src);
  } catch (err) {
    if (!isErrno(err, 'ENOTEMPTY', 'EEXIST')) throw err;
    tally.note = `${path.basename(src)} is not empty`;
  }
}

/** One file (a sidecar whose host was moved or dropped as-is): same rules, one entry. */
async function merge1(src: string, dst: string, name: string, tally: LibraryMigration): Promise<void> {
  const from = path.join(src, name);
  const to = path.join(dst, name);
  if (!(await lstatOrNull(to))) {
    await fs.rename(from, to);
    tally.moved += 1;
  } else if (await sameContents(from, to)) {
    await fs.rm(from);
    tally.identical += 1;
  } else {
    await fs.rename(from, path.join(dst, await fromWikiName(dst, name, false)));
    tally.kept += 1;
  }
}

function describe(m: LibraryMigration): string {
  const where = `${PROJECTS_DIR}/${m.project}`;
  if (m.action === 'skipped') return `${where}: left ${LEGACY_LIBRARY_SECTION} in place (${m.note}).`;
  if (m.action === 'renamed') return `${where}: renamed ${LEGACY_LIBRARY_SECTION} → ${LIBRARY_SECTION}.`;
  const detail = `${m.moved} moved, ${m.identical} identical dropped, ${m.kept} kept as "(from ${LEGACY_LIBRARY_SECTION})"`;
  return `${where}: merged ${LEGACY_LIBRARY_SECTION} into ${LIBRARY_SECTION} (${detail})${m.note ? `; ${m.note}, left in place` : ''}.`;
}

export async function migrateProjectLibraries(vaultRoot: string, links: readonly VaultLink[], log: Pick<Logger, 'info' | 'warn'>): Promise<LibraryMigration[]> {
  const projectsDir = path.join(vaultRoot, PROJECTS_DIR);
  let entries: Dirent[];
  try {
    entries = await fs.readdir(projectsDir, { withFileTypes: true });
  } catch (err) {
    if (isErrno(err, 'ENOENT', 'ENOTDIR')) return [];
    throw err;
  }

  const done: LibraryMigration[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const project = entry.name;
    const tally: LibraryMigration = { project, action: 'skipped', moved: 0, identical: 0, kept: 0 };
    const wikiRel = `${PROJECTS_DIR}/${project}/${LEGACY_LIBRARY_SECTION}`;
    try {
      if (entry.isSymbolicLink()) {
        // A linked project folder: its contents belong to someone else's tree. Only mention it when there is something to say.
        if (await fs.stat(path.join(projectsDir, project, LEGACY_LIBRARY_SECTION)).catch(() => null)) {
          tally.note = 'the project folder is a symlink';
          done.push(tally);
        }
        continue;
      }
      if (!entry.isDirectory()) continue;
      const wiki = path.join(projectsDir, project, LEGACY_LIBRARY_SECTION);
      const library = path.join(projectsDir, project, LIBRARY_SECTION);
      const wikiStat = await lstatOrNull(wiki);
      if (!wikiStat) continue;
      if (wikiStat.isSymbolicLink() || !wikiStat.isDirectory()) {
        tally.note = wikiStat.isSymbolicLink() ? `${LEGACY_LIBRARY_SECTION} is a symlink` : `${LEGACY_LIBRARY_SECTION} is not a folder`;
        done.push(tally);
        continue;
      }
      if (links.some((l) => l.mount === wikiRel || l.mount.startsWith(`${wikiRel}/`))) {
        tally.note = `a linked folder is mounted inside ${LEGACY_LIBRARY_SECTION}`;
        done.push(tally);
        continue;
      }
      const libraryStat = await lstatOrNull(library);
      if (!libraryStat) {
        await fs.rename(wiki, library);
        tally.action = 'renamed';
      } else if (libraryStat.isSymbolicLink() || !libraryStat.isDirectory()) {
        tally.note = `${LIBRARY_SECTION} exists and is not a plain folder`;
      } else {
        tally.action = 'merged';
        await merge(wiki, library, tally);
      }
      done.push(tally);
    } catch (err) {
      tally.note = `failed: ${(err as Error).message}`;
      done.push(tally);
    }
  }
  for (const m of done) {
    if (m.action === 'skipped' || m.note) log.warn(`Library migration: ${describe(m)}`);
    else log.info(`Library migration: ${describe(m)}`);
  }
  return done;
}
