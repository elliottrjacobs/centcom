import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { ROOT_FOLDERS, type Doc, type Frontmatter, type TreeNode, type WriteDocInput } from '../shared/types.ts';
import { markApiWrite, recordActivitySafe, shouldLogDocUpdate, syncAndBroadcast, type Ctx } from './context.ts';
import { conflict, exists, invalid, isErrno, notFound, tooLarge } from './errors.ts';
import { atomicCreateExclusive, atomicWrite, birthOf, copyName, dedupeName, lstatOrNull, mtimeOf, pathExists, renameNoClobber, statOrNull } from './fsutil.ts';
import { docTitle, mergeFrontmatter, parseMarkdown, serializeKeepingFrontmatter, serializeMarkdown, toEpoch } from './markdown.ts';
import { projectSlugOf, ticketLocation } from './model.ts';
import { assertNotMountOrAncestor, assertWritable } from './links.ts';
import { assertCreatableName, canHaveSidecar, fileKind, relBasename, relDirname, relJoin, resolveVaultPath, type ResolvedPath } from './paths.ts';
import { moveToTrash } from './trash.ts';

export const MAX_DOC_BYTES = 5 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** Project slug for activity attribution, when the path lives under `Projects/<slug>/`. */
export function projectOfPath(rel: string): string | null {
  return projectSlugOf(rel)?.slug ?? null;
}

function assertNotStructural(rel: string, verb: string): void {
  if (rel === '') throw invalid(`The vault root cannot be ${verb}.`);
  if ((ROOT_FOLDERS as readonly string[]).includes(rel)) throw invalid(`"${rel}" is a structural folder and cannot be ${verb}.`);
}

function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8192).includes(0);
}

/* ───────────────────────── Read ───────────────────────── */

export async function readDoc(ctx: Ctx, clientPath: unknown): Promise<Doc> {
  const target = await resolveVaultPath(ctx.vault, clientPath);
  const stat = await statOrNull(target.abs);
  if (!stat) throw notFound(`${target.rel} does not exist.`);
  if (stat.isDirectory()) throw invalid(`${target.rel} is a folder, not a document.`);
  if (stat.size > MAX_DOC_BYTES) throw tooLarge(`${target.rel} is too large to open as a document; fetch it from /api/raw instead.`);
  const buf = await fs.readFile(target.abs);
  if (looksBinary(buf)) throw invalid(`${target.rel} is a binary file; fetch it from /api/raw instead.`);
  return toDoc(target.rel, buf.toString('utf8'), mtimeOf(stat), birthOf(stat));
}

function toDoc(rel: string, raw: string, mtime: number, birth: number): Doc {
  if (fileKind(rel) !== 'markdown') {
    return { path: rel, title: docTitle({}, rel), frontmatter: {}, body: raw, mtime, created: birth };
  }
  const parsed = parseMarkdown(raw);
  return {
    path: rel,
    title: docTitle(parsed.frontmatter, rel),
    frontmatter: parsed.frontmatter,
    body: parsed.body,
    mtime,
    created: toEpoch(parsed.frontmatter.created) ?? birth,
  };
}

/* ───────────────────────── Write ───────────────────────── */

function assertFrontmatter(value: unknown): asserts value is Frontmatter | undefined {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('frontmatter must be an object.');
}

function activitySubject(rel: string, frontmatter: Frontmatter): string {
  return docTitle(frontmatter, rel);
}

/** PUT semantics: create or update. `ifMatch` makes the update conditional on the file's mtime. */
export async function writeDoc(ctx: Ctx, input: WriteDocInput, agent: string): Promise<Doc> {
  const target = await resolveVaultPath(ctx.vault, input.path);
  assertWritable(target, 'written');
  assertFrontmatter(input.frontmatter);
  if (input.body !== undefined && typeof input.body !== 'string') throw invalid('body must be a string.');
  const isMarkdown = fileKind(target.rel) === 'markdown';
  if (!isMarkdown && input.frontmatter && Object.keys(input.frontmatter).length > 0) {
    throw invalid('frontmatter is only supported on markdown files.');
  }

  return ctx.locks.run(`path:${target.rel}`, async () => {
    const stat = await statOrNull(target.abs);
    if (stat?.isDirectory()) throw invalid(`${target.rel} is a folder.`);
    if (input.ifMatch !== undefined && input.ifMatch !== null) {
      if (!stat) throw conflict(`${target.rel} no longer exists (it was moved or deleted). Reload before saving.`);
      if (mtimeOf(stat) !== Math.floor(Number(input.ifMatch))) {
        throw conflict(`${target.rel} changed on disk since you loaded it. Reload to merge before saving.`);
      }
    }

    let content: string;
    let frontmatter: Frontmatter = {};
    if (!stat) {
      assertCreatableName(target);
      frontmatter = isMarkdown ? mergeFrontmatter({}, input.frontmatter) : {};
      content = isMarkdown ? serializeMarkdown(frontmatter, input.body ?? '') : (input.body ?? '');
    } else if (!isMarkdown) {
      content = input.body ?? (await fs.readFile(target.abs, 'utf8'));
    } else {
      const current = parseMarkdown(await fs.readFile(target.abs, 'utf8'));
      const body = input.body ?? current.body;
      frontmatter = mergeFrontmatter(current.frontmatter, input.frontmatter);
      // Editors send the whole frontmatter back on every save. Only re-serialise the YAML when a
      // key or value really changed; otherwise the block on disk is kept byte-for-byte (comments,
      // quoting, key order), so saving a body never dirties a file that lives in a git repo.
      const frontmatterChanged = !isDeepStrictEqual(frontmatter, current.frontmatter);
      content = frontmatterChanged ? serializeMarkdown(frontmatter, body, { eol: current.eol || '\n' }) : serializeKeepingFrontmatter(current, body);
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_DOC_BYTES) throw tooLarge('Document is too large (max 5 MB).');

    const written = await atomicWrite(target.abs, content, { createDirs: !stat });
    await syncAndBroadcast(ctx, [target.rel]);
    if (!stat || shouldLogDocUpdate(ctx, agent, target.rel)) {
      await recordActivitySafe(ctx, {
        agent,
        type: stat ? 'doc.updated' : 'doc.created',
        path: target.rel,
        project: projectOfPath(target.rel),
        subject: activitySubject(target.rel, frontmatter),
      });
    }
    return toDoc(target.rel, content, mtimeOf(written), birthOf(written));
  });
}

/** POST semantics: must not exist yet (409 `exists`). */
export async function createDoc(ctx: Ctx, input: { path: unknown; body?: string | undefined; frontmatter?: Frontmatter | undefined }, agent: string): Promise<Doc> {
  const target = await resolveVaultPath(ctx.vault, input.path);
  assertWritable(target, 'created');
  assertCreatableName(target);
  assertFrontmatter(input.frontmatter);
  const isMarkdown = fileKind(target.rel) === 'markdown';
  if (!isMarkdown && input.frontmatter && Object.keys(input.frontmatter).length > 0) {
    throw invalid('frontmatter is only supported on markdown files.');
  }
  const frontmatter = isMarkdown ? mergeFrontmatter({}, input.frontmatter) : {};
  const content = isMarkdown ? serializeMarkdown(frontmatter, input.body ?? '') : (input.body ?? '');
  if (Buffer.byteLength(content, 'utf8') > MAX_DOC_BYTES) throw tooLarge('Document is too large (max 5 MB).');
  if (await pathExists(target.abs)) throw exists(`${target.rel} already exists.`);

  const written = await atomicCreateExclusive(target.abs, content);
  await syncAndBroadcast(ctx, [target.rel]);
  await recordActivitySafe(ctx, {
    agent,
    type: 'doc.created',
    path: target.rel,
    project: projectOfPath(target.rel),
    subject: activitySubject(target.rel, frontmatter),
  });
  return toDoc(target.rel, content, mtimeOf(written), birthOf(written));
}

/* ───────────────────────── Folders ───────────────────────── */

export async function createFolder(ctx: Ctx, clientPath: unknown): Promise<TreeNode> {
  const target = await resolveVaultPath(ctx.vault, clientPath);
  assertWritable(target, 'created');
  assertCreatableName(target);
  if (await pathExists(target.abs)) throw exists(`${target.rel} already exists.`);
  await fs.mkdir(target.abs, { recursive: true });
  await syncAndBroadcast(ctx, [target.rel]);
  const node = ctx.index.node(target.rel);
  if (!node) throw notFound(`${target.rel} could not be created.`);
  return node;
}

/* ───────────────────────── Delete ───────────────────────── */

/** Soft-delete a file or folder. Tickets and projects deleted this way are attributed as such. */
export async function deletePath(ctx: Ctx, clientPath: unknown, agent: string): Promise<{ ok: true; trashId: string }> {
  const target = await resolveVaultPath(ctx.vault, clientPath);
  assertNotStructural(target.rel, 'deleted');
  assertNotMountOrAncestor(ctx.vault, target, 'deleted');
  assertWritable(target, 'deleted');
  const ticket = ctx.index.tickets.get(target.rel);
  const subject = ticket?.title ?? ctx.index.docs.get(target.rel)?.title ?? relBasename(target.rel);
  const { trashId, removed } = await moveToTrash(ctx, target);
  await syncAndBroadcast(ctx, removed);
  await recordActivitySafe(
    ctx,
    ticket
      ? { agent, type: 'ticket.deleted', ticket: ticket.id, path: target.rel, project: ticket.project, subject }
      : { agent, type: 'doc.deleted', path: target.rel, project: projectOfPath(target.rel), subject },
  );
  return { ok: true, trashId };
}

/* ───────────────────────── Move ───────────────────────── */

export async function movePath(ctx: Ctx, fromInput: unknown, toInput: unknown, agent: string): Promise<{ path: string }> {
  const from = await resolveVaultPath(ctx.vault, fromInput);
  const to = await resolveVaultPath(ctx.vault, toInput);
  assertNotStructural(from.rel, 'moved');
  assertNotStructural(to.rel, 'replaced');
  // Checked before the "same path" shortcut so that a linked folder never looks movable.
  assertNotMountOrAncestor(ctx.vault, from, 'moved or renamed');
  assertNotMountOrAncestor(ctx.vault, to, 'replaced');
  assertWritable(from, 'moved');
  assertWritable(to, 'written to');
  assertCreatableName(to);
  if (from.rel === to.rel) return { path: to.rel };
  if (to.rel.startsWith(`${from.rel}/`)) throw invalid('A folder cannot be moved into itself.');

  const stat = await lstatOrNull(from.abs);
  if (!stat) throw notFound(`${from.rel} does not exist.`);
  const subject = ctx.index.docs.get(from.rel)?.title ?? relBasename(from.rel);

  // A file's sidecar note (`<file>.<ext>.md`) travels with it: images, PDFs, media, anything that is not markdown.
  const touched = [from.rel, to.rel];
  let sidecar: { from: ResolvedPath; to: ResolvedPath } | null = null;
  if (stat.isFile() && canHaveSidecar(relBasename(from.rel)) && ctx.index.files.has(`${from.rel}.md`)) {
    sidecar = { from: await resolveVaultPath(ctx.vault, `${from.rel}.md`), to: await resolveVaultPath(ctx.vault, `${to.rel}.md`) };
    if ((await pathExists(sidecar.from.abs)) && (await pathExists(sidecar.to.abs)) && sidecar.from.rel.toLowerCase() !== sidecar.to.rel.toLowerCase()) {
      throw exists(`${sidecar.to.rel} already exists at the destination.`);
    }
  }

  await ctx.nameLock.run(async () => {
    try {
      await renameNoClobber(from.abs, to.abs);
    } catch (err) {
      if (isErrno(err, 'ENOTEMPTY', 'EEXIST', 'EISDIR', 'ENOTDIR')) throw exists(`${to.rel} already exists at the destination.`);
      throw err;
    }
    if (sidecar && (await pathExists(sidecar.from.abs))) {
      await renameNoClobber(sidecar.from.abs, sidecar.to.abs);
      touched.push(sidecar.from.rel, sidecar.to.rel);
    }
  });

  await syncAndBroadcast(ctx, touched);
  await recordActivitySafe(ctx, {
    agent,
    type: 'doc.moved',
    path: to.rel,
    project: projectOfPath(to.rel),
    subject,
    changes: { path: [from.rel, to.rel] },
  });
  return { path: to.rel };
}

/* ───────────────────────── Duplicate ───────────────────────── */

export async function duplicatePath(ctx: Ctx, clientPath: unknown, agent: string): Promise<{ path: string }> {
  const source = await resolveVaultPath(ctx.vault, clientPath);
  assertNotStructural(source.rel, 'duplicated');
  assertNotMountOrAncestor(ctx.vault, source, 'duplicated');
  assertWritable(source, 'duplicated'); // the copy lands beside the original
  const stat = await lstatOrNull(source.abs);
  if (!stat) throw notFound(`${source.rel} does not exist.`);
  if (stat.isSymbolicLink()) throw invalid('Symlinks cannot be duplicated.');
  if (ticketLocation(source.rel) && ctx.index.tickets.has(source.rel)) {
    throw invalid('Tickets are duplicated by creating a new ticket (POST /api/tickets), so the copy gets its own id.');
  }

  const dirRel = relDirname(source.rel);
  const dirAbs = path.dirname(source.abs);
  const touched: string[] = [];
  const copyRel = await ctx.nameLock.run(async () => {
    const name = await copyName(dirAbs, relBasename(source.rel), stat.isDirectory());
    const target = await resolveVaultPath(ctx.vault, relJoin(dirRel, name));
    markApiWrite(ctx, [target.rel]);
    // Symlinks inside a copied folder are skipped: they are never followed anywhere else either.
    await fs.cp(source.abs, target.abs, {
      recursive: true,
      errorOnExist: true,
      force: false,
      filter: async (src) => !(await fs.lstat(src)).isSymbolicLink() && !path.basename(src).startsWith('.'),
    });
    touched.push(target.rel);
    if (stat.isFile() && canHaveSidecar(relBasename(source.rel)) && (await pathExists(`${source.abs}.md`))) {
      const sidecarTarget = await resolveVaultPath(ctx.vault, `${target.rel}.md`);
      if (!(await pathExists(sidecarTarget.abs))) {
        await fs.copyFile(`${source.abs}.md`, sidecarTarget.abs);
        touched.push(sidecarTarget.rel);
      }
    }
    return target.rel;
  });

  await syncAndBroadcast(ctx, touched);
  await recordActivitySafe(ctx, {
    agent,
    type: 'doc.created',
    path: copyRel,
    project: projectOfPath(copyRel),
    subject: ctx.index.docs.get(copyRel)?.title ?? relBasename(copyRel),
  });
  return { path: copyRel };
}

/* ───────────────────────── Upload ───────────────────────── */

/**
 * Stream a request body to disk. The cap is enforced while streaming (Content-Length can lie
 * or be absent), into a hidden temp file that is only renamed into place when complete.
 */
export async function uploadFile(
  ctx: Ctx,
  dirInput: unknown,
  nameInput: unknown,
  body: ReadableStream<Uint8Array> | null,
  agent: string,
): Promise<TreeNode> {
  if (typeof nameInput !== 'string' || !nameInput.trim()) throw invalid('name is required.');
  if (nameInput.includes('/') || nameInput.includes('\\')) throw invalid('name must be a file name, not a path.');
  const dir = await resolveVaultPath(ctx.vault, dirInput ?? '', { allowRoot: true });
  const dirStat = await statOrNull(dir.abs);
  if (dirStat && !dirStat.isDirectory()) throw invalid(`${dir.rel} is not a folder.`);
  // Validates the name with the same rules as every other client path.
  const probe = await resolveVaultPath(ctx.vault, relJoin(dir.rel, nameInput.trim()));
  assertWritable(probe, 'uploaded to');
  assertCreatableName(probe);
  if (!body) throw invalid('Request body is empty.');

  await fs.mkdir(dir.abs, { recursive: true });
  const tmp = path.join(dir.abs, `.tmp-upload-${process.pid}-${randomBytes(6).toString('hex')}`);
  const handle = await fs.open(tmp, 'wx', 0o644);
  let size = 0;
  try {
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_UPLOAD_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge('Upload exceeds the 50 MB limit.');
      }
      await handle.write(value);
    }
    await handle.sync();
    await handle.close();
  } catch (err) {
    await handle.close().catch(() => undefined);
    await fs.rm(tmp, { force: true });
    throw err;
  }
  if (size === 0) {
    await fs.rm(tmp, { force: true });
    throw invalid('Request body is empty.');
  }

  let finalRel: string;
  try {
    finalRel = await ctx.nameLock.run(async () => {
      const name = await dedupeName(dir.abs, relBasename(probe.rel));
      const target = await resolveVaultPath(ctx.vault, relJoin(dir.rel, name));
      await fs.rename(tmp, target.abs);
      return target.rel;
    });
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }

  await syncAndBroadcast(ctx, [finalRel]);
  await recordActivitySafe(ctx, { agent, type: 'doc.created', path: finalRel, project: projectOfPath(finalRel), subject: relBasename(finalRel) });
  const node = ctx.index.node(finalRel);
  if (!node) throw notFound(`${finalRel} could not be indexed after upload.`);
  return node;
}
