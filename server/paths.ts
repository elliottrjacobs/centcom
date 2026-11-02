import { promises as fs } from 'node:fs';
import path from 'node:path';
import { legacyLibraryAlias, type FileKind } from '../shared/types.ts';
import { forbidden, invalid, isErrno } from './errors.ts';

/**
 * An allowlisted external folder mounted inside the vault as a symlink (see `server/links.ts`).
 * The allowlist comes from the local config file only; nothing a client sends can extend it.
 */
export interface VaultLink {
  /** Vault-relative mount point, e.g. `Skills/shared`. */
  mount: string;
  /** Absolute path as configured. */
  target: string;
  /** `fs.realpath(target)`: the only place a path under `mount` may resolve to. */
  realTarget: string;
  readonly: boolean;
}

/** A directory plus its realpath. Everything a client names is resolved against one of these. */
export interface SafeRoot {
  root: string;
  realRoot: string;
  /** Mutable on purpose: `POST /api/links/reload` swaps it after re-reading the config. */
  links?: VaultLink[];
}

export interface ResolvedPath {
  /** Absolute path on disk. */
  abs: string;
  /** Root-relative, POSIX-separated, NFC-normalised, no leading slash. `''` is the root itself. */
  rel: string;
  segments: string[];
  /** The link this path is the mount of, or lives beneath. Null for ordinary vault paths. */
  link: VaultLink | null;
  /** True when the path IS a link's mount point (the symlink itself). */
  isMount: boolean;
}

export interface ResolveOptions {
  /** Permit the empty path (the root itself). Default false. */
  allowRoot?: boolean;
  /**
   * Server-chosen sub-directory to resolve inside (e.g. `.trash`). NEVER pass client
   * input here. The client path is still held to every rule below.
   */
  base?: string;
}

const MAX_PATH_CHARS = 1024;
const MAX_SEGMENT_BYTES = 255;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export async function makeSafeRoot(dir: string, links: VaultLink[] = []): Promise<SafeRoot> {
  const root = path.resolve(dir);
  return { root, realRoot: await fs.realpath(root), links };
}

/** The link whose mount is `rel` or an ancestor of it. */
export function linkFor(links: readonly VaultLink[] | undefined, rel: string): VaultLink | null {
  for (const link of links ?? []) if (rel === link.mount || rel.startsWith(`${link.mount}/`)) return link;
  return null;
}

export function isInside(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

/** Pure, synchronous half of the check: syntax only. Exported for tests and for non-IO callers. */
export function parseClientPath(input: unknown, opts: Pick<ResolveOptions, 'allowRoot'> = {}): string[] {
  if (typeof input !== 'string') throw invalid('path must be a string.');
  if (input.includes('\0')) throw invalid('path must not contain NUL bytes.');
  if (input.length > MAX_PATH_CHARS) throw invalid(`path is too long (max ${MAX_PATH_CHARS} characters).`);
  const raw = input.normalize('NFC');
  if (raw.startsWith('/') || raw.startsWith('\\') || /^[A-Za-z]:/.test(raw)) throw forbidden('Absolute paths are not allowed; use a vault-relative path.');
  if (raw.includes('\\')) throw forbidden('Backslashes are not allowed in paths; use "/".');

  const segments = raw.split('/').filter((s) => s.length > 0);
  for (const seg of segments) {
    if (seg === '..') throw forbidden('".." is not allowed in paths.');
    if (seg.startsWith('.')) throw forbidden(`Dot-prefixed path segments are not allowed ("${seg}").`);
    if (CONTROL_CHARS.test(seg)) throw invalid('path must not contain control characters.');
    if (Buffer.byteLength(seg, 'utf8') > MAX_SEGMENT_BYTES) throw invalid('A path segment is too long (max 255 bytes).');
  }
  if (segments.length === 0 && !opts.allowRoot) throw invalid('path is required.');
  return segments;
}

/**
 * Extra strictness for names we are about to *create* (be strict in what we write).
 * Reading existing oddly-named files stays possible; creating new ones is not.
 */
export function assertCreatableName(resolved: ResolvedPath): void {
  const seg = resolved.segments[resolved.segments.length - 1];
  if (seg === undefined) throw invalid('path is required.');
  if (seg !== seg.trim()) throw invalid(`Names must not start or end with whitespace ("${seg}").`);
  if (seg.endsWith('.')) throw invalid(`Names must not end with a dot ("${seg}").`);
}

/**
 * Project `Wiki` folders are now `Library` (see `server/migrate-library.ts`), so an old
 * `Projects/<Name>/Wiki/…` path means `Projects/<Name>/Library/…`, and the canonical path is
 * what every response reports. A Wiki that is still on disk (one the migration skipped, such as
 * a symlink) keeps its own path.
 */
async function aliasLegacyLibrary(safeRoot: SafeRoot, segments: string[]): Promise<string[]> {
  const aliased = legacyLibraryAlias(segments.join('/'));
  if (aliased === null) return segments;
  try {
    await fs.lstat(path.join(safeRoot.root, ...segments.slice(0, 3)));
    return segments;
  } catch {
    return aliased.split('/');
  }
}

/**
 * THE path-safety function. Every client-supplied path, on every route, goes through here.
 *
 * Rejects absolute paths, `..`, NUL bytes, backslashes, control characters and any
 * dot-prefixed segment, then walks up to the nearest existing ancestor and requires its
 * realpath to stay inside
 *   - the vault's realpath, or
 *   - when (and only when) the client path is at or beneath an allowlisted link's mount,
 *     that link's real target,
 * without landing in a dot-directory by way of a symlink. Any other symlink that leaves
 * the vault stays unreachable, including one that happens to point into a link target
 * from somewhere that is not its mount.
 */
export async function resolveVaultPath(safeRoot: SafeRoot, input: unknown, opts: ResolveOptions = {}): Promise<ResolvedPath> {
  // Server-chosen bases (`.trash`) hold their own names; only vault paths get the Wiki → Library alias.
  const segments = opts.base ? parseClientPath(input, opts) : await aliasLegacyLibrary(safeRoot, parseClientPath(input, opts));
  const rel = segments.join('/');
  const baseAbs = opts.base ? path.join(safeRoot.root, opts.base) : safeRoot.root;
  const baseReal = opts.base ? path.join(safeRoot.realRoot, opts.base) : safeRoot.realRoot;
  const abs = path.join(baseAbs, ...segments);
  if (!isInside(baseAbs, abs)) throw forbidden('Path escapes the vault.');
  // Links only ever apply to ordinary vault paths, never inside a server-chosen base such as `.trash`.
  const link = opts.base ? null : linkFor(safeRoot.links, rel);
  const resolved: ResolvedPath = { abs, rel, segments, link, isMount: link !== null && link.mount === rel };

  // Nearest ancestor that exists *as a directory entry* (lstat, so a dangling symlink counts as existing).
  let probe = abs;
  for (;;) {
    try {
      await fs.lstat(probe);
      break;
    } catch (err) {
      if (!isErrno(err, 'ENOENT', 'ENOTDIR')) throw forbidden('Path cannot be resolved.');
      const parent = path.dirname(probe);
      if (parent === probe || !isInside(baseAbs, parent)) {
        // The base itself does not exist yet (e.g. an empty `.trash`); nothing on disk to escape through.
        return resolved;
      }
      probe = parent;
    }
  }

  let real: string;
  try {
    real = await fs.realpath(probe);
  } catch {
    // Dangling or looping symlink: writing "through" it could create a file outside the vault.
    throw forbidden('Path resolves through a broken symlink.');
  }

  const container = link && isInside(link.realTarget, real) ? link.realTarget : baseReal;
  if (!isInside(container, real)) throw forbidden('Path escapes the vault through a symlink.');
  const realRel = path.relative(container, real);
  if (realRel && realRel.split(path.sep).some((s) => s.startsWith('.'))) {
    throw forbidden('Path resolves into a hidden directory.');
  }
  return resolved;
}

/* ───────────────────────── Helpers on already-safe relative paths ───────────────────────── */

export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

export function relJoin(...parts: string[]): string {
  return parts.filter((p) => p.length > 0).join('/');
}

export function relDirname(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i === -1 ? '' : rel.slice(0, i);
}

export function relBasename(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i === -1 ? rel : rel.slice(i + 1);
}

/** `name.ext` → [`name`, `.ext`]; dotless names → [`name`, ``]. */
export function splitExt(name: string): [string, string] {
  const i = name.lastIndexOf('.');
  return i <= 0 ? [name, ''] : [name.slice(0, i), name.slice(i)];
}

export function isHiddenRel(rel: string): boolean {
  return rel.split('/').some((s) => s.startsWith('.'));
}

const MARKDOWN_EXT = new Set(['.md', '.markdown', '.mdx']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.bmp', '.ico', '.tif', '.tiff', '.heic', '.heif']);

const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm', '.m4v']);
const AUDIO_EXT = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac']);

/**
 * Kind by file name alone. `link` is never returned here: a bookmark is a markdown file whose
 * FRONTMATTER says `type: link`, so only the index (which has read it) can tell.
 */
export function fileKind(name: string): Exclude<FileKind, 'link'> {
  const ext = splitExt(name)[1].toLowerCase();
  if (MARKDOWN_EXT.has(ext)) return 'markdown';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (ext === '.pdf') return 'pdf';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (AUDIO_EXT.has(ext)) return 'audio';
  return 'other';
}

/**
 * Any non-markdown `<file>.<ext>` can carry a hidden `<file>.<ext>.md` note beside it. The
 * extension is required: `README` + `README.md` are two documents, not a file and its note.
 */
export function canHaveSidecar(name: string): boolean {
  return splitExt(name)[1] !== '' && fileKind(name) !== 'markdown';
}

const CONTENT_TYPES: Record<string, string> = {
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.mdx': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'text/plain; charset=utf-8',
  '.yaml': 'text/plain; charset=utf-8',
  '.yml': 'text/plain; charset=utf-8',
  '.toml': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.m4v': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.zip': 'application/zip',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

/** Types a browser would execute if we served them as-is from the API origin. Vault content is untrusted. */
const ACTIVE_TEXT_EXT = new Set(['.html', '.htm', '.xhtml', '.xht', '.xml', '.js', '.mjs', '.cjs', '.css', '.ts', '.tsx', '.jsx', '.sh', '.py', '.rb']);

/** Content type for `/api/raw`. Never returns a type that lets vault content run as script in our origin. */
export function vaultContentType(name: string): string {
  const ext = splitExt(name)[1].toLowerCase();
  if (ACTIVE_TEXT_EXT.has(ext)) return 'text/plain; charset=utf-8';
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

/** Content type for the built UI (trusted, ours). */
export function staticContentType(name: string): string {
  const ext = splitExt(name)[1].toLowerCase();
  switch (ext) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.map':
      return 'application/json; charset=utf-8';
    case '.wasm':
      return 'application/wasm';
    default:
      return CONTENT_TYPES[ext] ?? 'application/octet-stream';
  }
}
