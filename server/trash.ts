import { promises as fs } from 'node:fs';
import path from 'node:path';
import { TRASH_DIR } from '../shared/types.ts';
import type { Ctx } from './context.ts';
import { conflict, forbidden, invalid, isErrno, notFound } from './errors.ts';
import { atomicWrite, lstatOrNull, moveEntry, pathExists } from './fsutil.ts';
import { assertNotMountOrAncestor, assertWritable } from './links.ts';
import { linkPreviewPath } from './index-store.ts';
import { canHaveSidecar, relBasename, relDirname, relJoin, resolveVaultPath, type ResolvedPath } from './paths.ts';

export interface TrashItem {
  id: string;
  name: string;
  originalPath: string;
  deletedAt: number;
  isDir: boolean;
}

interface TrashMeta {
  originalPath: string;
  name: string;
  deletedAt: number;
  isDir: boolean;
  /** Trash ids that travel with this item (a file's sidecar note, a bookmark's preview image). */
  companions?: string[];
  /** Set on a companion: the id of the item it belongs to. Companions are hidden from listings. */
  companionOf?: string;
}

const ID_PATTERN = /^(\d{10,16})-(.+)$/;

function trashDir(ctx: Ctx): string {
  return path.join(ctx.vault.root, TRASH_DIR);
}

function metaPath(itemAbs: string): string {
  return `${itemAbs}.json`;
}

/** Byte-safe truncation so `<epochms>-<name>` and its `.json` both fit in NAME_MAX. */
function clampName(name: string, maxBytes = 200): string {
  let out = name;
  while (Buffer.byteLength(out, 'utf8') > maxBytes) out = out.slice(0, -1);
  return out;
}

async function readMeta(itemAbs: string): Promise<TrashMeta | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(metaPath(itemAbs), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const v = parsed as Record<string, unknown>;
    if (typeof v.originalPath !== 'string') return null;
    return {
      originalPath: v.originalPath,
      name: typeof v.name === 'string' ? v.name : relBasename(v.originalPath),
      deletedAt: typeof v.deletedAt === 'number' ? v.deletedAt : 0,
      isDir: v.isDir === true,
      ...(Array.isArray(v.companions) ? { companions: v.companions.filter((c): c is string => typeof c === 'string') } : {}),
      ...(typeof v.companionOf === 'string' ? { companionOf: v.companionOf } : {}),
    };
  } catch {
    return null;
  }
}

/** Trash ids are client input too, so they go through the one path-safety function (rooted at `.trash`). */
async function resolveTrashId(ctx: Ctx, id: unknown): Promise<ResolvedPath> {
  const resolved = await resolveVaultPath(ctx.vault, id, { base: TRASH_DIR });
  if (resolved.segments.length !== 1 || !ID_PATTERN.test(resolved.segments[0] as string)) throw invalid('Invalid trash id.');
  return resolved;
}

async function moveOne(ctx: Ctx, abs: string, rel: string, extra: Partial<TrashMeta>): Promise<string> {
  const stat = await fs.lstat(abs);
  const name = relBasename(rel);
  await fs.mkdir(trashDir(ctx), { recursive: true });
  let ts = Date.now();
  let id = `${ts}-${clampName(name)}`;
  while ((await pathExists(path.join(trashDir(ctx), id))) || (await pathExists(path.join(trashDir(ctx), `${id}.json`)))) {
    ts += 1;
    id = `${ts}-${clampName(name)}`;
  }
  const target = path.join(trashDir(ctx), id);
  const meta: TrashMeta = { originalPath: rel, name, deletedAt: Date.now(), isDir: stat.isDirectory(), ...extra };
  // Meta first: an item without meta is still listable, a meta without an item is ignored.
  await atomicWrite(metaPath(target), `${JSON.stringify(meta, null, 2)}\n`);
  try {
    await moveEntry(abs, target);
  } catch (err) {
    await fs.rm(metaPath(target), { force: true });
    throw err;
  }
  return id;
}

/**
 * Soft-delete a file or folder into `.trash/<epochms>-<name>` with a `<same>.json` recording
 * where it came from. A file's sidecar note (`<file>.<ext>.md`) goes with it. The caller syncs the index.
 */
export function moveToTrash(ctx: Ctx, target: ResolvedPath): Promise<{ trashId: string; removed: string[] }> {
  // Last line of defence, whoever the caller is: a mount (or a folder holding one) is never trashed,
  // so a soft delete can never follow a link and carry off the real folder.
  assertNotMountOrAncestor(ctx.vault, target, 'deleted');
  assertWritable(target, 'deleted');
  return ctx.nameLock.run(async () => {
    const stat = await lstatOrNull(target.abs);
    if (!stat) throw notFound(`${target.rel} does not exist.`);
    if (stat.isSymbolicLink()) throw forbidden(`${target.rel} is a symlink; remove it on disk instead.`);
    const removed = [target.rel];
    const companions: string[] = [];

    const sidecarRel = `${target.rel}.md`;
    if (stat.isFile() && canHaveSidecar(relBasename(target.rel)) && ctx.index.files.has(sidecarRel)) {
      const sidecar = await resolveVaultPath(ctx.vault, sidecarRel);
      if (await pathExists(sidecar.abs)) {
        companions.push(await moveOne(ctx, sidecar.abs, sidecar.rel, { companionOf: 'pending' }));
        removed.push(sidecar.rel);
      }
    }
    // A bookmark's preview image goes with it (and comes back with it). Only a preview CENTCOM
    // itself keeps beside the bookmark, in `<dir>/assets/`, and only when no other bookmark uses it:
    // a hand-written link that points its `image` at some other file never takes that file along.
    const doc = stat.isFile() ? ctx.index.docs.get(target.rel) : undefined;
    const previewRel = doc ? linkPreviewPath(doc.frontmatter) : undefined;
    if (previewRel && relDirname(previewRel) === relJoin(relDirname(target.rel), 'assets')) {
      let shared = false;
      for (const [rel, other] of ctx.index.docs) if (rel !== target.rel && linkPreviewPath(other.frontmatter) === previewRel) shared = true;
      const preview = shared ? null : await resolveVaultPath(ctx.vault, previewRel);
      if (preview && (await lstatOrNull(preview.abs))?.isFile()) {
        assertWritable(preview, 'deleted');
        companions.push(await moveOne(ctx, preview.abs, preview.rel, { companionOf: 'pending' }));
        removed.push(preview.rel);
        // An `assets` folder left empty is removed (rmdir refuses anything else); restoring re-creates it.
        await fs.rmdir(path.dirname(preview.abs)).then(() => removed.push(relDirname(preview.rel)), () => undefined);
      }
    }
    const trashId = await moveOne(ctx, target.abs, target.rel, companions.length > 0 ? { companions } : {});
    for (const companionId of companions) {
      const companionAbs = path.join(trashDir(ctx), companionId);
      const meta = await readMeta(companionAbs);
      if (meta) await atomicWrite(metaPath(companionAbs), `${JSON.stringify({ ...meta, companionOf: trashId }, null, 2)}\n`);
    }
    return { trashId, removed };
  });
}

export async function listTrash(ctx: Ctx): Promise<TrashItem[]> {
  let names: string[];
  try {
    names = await fs.readdir(trashDir(ctx));
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return [];
    throw err;
  }
  const present = new Set(names);
  const items: TrashItem[] = [];
  for (const id of names) {
    if (id.startsWith('.')) continue;
    // `<id>.json` next to an existing `<id>` is that item's metadata, not an item.
    if (id.endsWith('.json') && present.has(id.slice(0, -'.json'.length))) continue;
    const match = ID_PATTERN.exec(id);
    if (!match) continue;
    const abs = path.join(trashDir(ctx), id);
    const stat = await lstatOrNull(abs);
    if (!stat) continue;
    const meta = await readMeta(abs);
    if (meta?.companionOf && present.has(meta.companionOf)) continue;
    items.push({
      id,
      name: meta?.name ?? (match[2] as string),
      originalPath: meta?.originalPath ?? (match[2] as string),
      deletedAt: meta?.deletedAt || Number(match[1]),
      isDir: stat.isDirectory(),
    });
  }
  return items.sort((a, b) => b.deletedAt - a.deletedAt);
}

async function restoreOne(ctx: Ctx, id: string): Promise<string> {
  const item = await resolveTrashId(ctx, id);
  if (!(await pathExists(item.abs))) throw notFound(`Nothing in the trash with id "${id}".`);
  const meta = await readMeta(item.abs);
  const fallback = ID_PATTERN.exec(id)?.[2] ?? id;
  // The stored path is data on disk, not something to trust: it is validated like any client path.
  const destination = await resolveVaultPath(ctx.vault, meta?.originalPath ?? fallback);
  if (await pathExists(destination.abs)) {
    throw conflict(`Cannot restore: "${destination.rel}" already exists. Move or rename it first.`);
  }
  assertWritable(destination, 'restored');
  await fs.mkdir(path.dirname(destination.abs), { recursive: true });
  await moveEntry(item.abs, destination.abs);
  await fs.rm(metaPath(item.abs), { force: true });
  return destination.rel;
}

/** Put an item back where it came from. 409 when that path is occupied. Returns every restored path. */
export function restoreFromTrash(ctx: Ctx, id: unknown): Promise<{ path: string; restored: string[] }> {
  return ctx.nameLock.run(async () => {
    const item = await resolveTrashId(ctx, id);
    const meta = await readMeta(item.abs);
    const restoredPath = await restoreOne(ctx, item.segments[0] as string);
    const restored = [restoredPath];
    for (const companionId of meta?.companions ?? []) {
      try {
        restored.push(await restoreOne(ctx, companionId));
      } catch (err) {
        // Leave it in the trash, now as a visible item of its own.
        ctx.log.warn(`Trash: could not restore companion ${companionId}: ${(err as Error).message}`);
        try {
          const companion = await resolveTrashId(ctx, companionId);
          const companionMeta = await readMeta(companion.abs);
          if (companionMeta) {
            const { companionOf: _drop, ...rest } = companionMeta;
            await atomicWrite(metaPath(companion.abs), `${JSON.stringify(rest, null, 2)}\n`);
          }
        } catch {
          /* best effort */
        }
      }
    }
    return { path: restoredPath, restored };
  });
}

async function purgeOne(ctx: Ctx, id: string): Promise<void> {
  const item = await resolveTrashId(ctx, id);
  const meta = await readMeta(item.abs);
  if (!(await pathExists(item.abs))) throw notFound(`Nothing in the trash with id "${id}".`);
  await fs.rm(item.abs, { recursive: true, force: true });
  await fs.rm(metaPath(item.abs), { force: true });
  for (const companionId of meta?.companions ?? []) {
    try {
      const companion = await resolveTrashId(ctx, companionId);
      await fs.rm(companion.abs, { recursive: true, force: true });
      await fs.rm(metaPath(companion.abs), { force: true });
    } catch {
      /* already gone */
    }
  }
}

/** Permanently delete one trashed item, or empty the trash when `id` is omitted. */
export function purgeTrash(ctx: Ctx, id?: unknown): Promise<void> {
  return ctx.nameLock.run(async () => {
    if (id !== undefined && id !== null && id !== '') {
      await purgeOne(ctx, String(id));
      return;
    }
    let names: string[];
    try {
      names = await fs.readdir(trashDir(ctx));
    } catch (err) {
      if (isErrno(err, 'ENOENT')) return;
      throw err;
    }
    for (const name of names) await fs.rm(path.join(trashDir(ctx), name), { recursive: true, force: true });
  });
}
