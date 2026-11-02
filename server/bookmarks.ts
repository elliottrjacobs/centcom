/**
 * Bookmarks: saved websites, stored like everything else as a file. `<dir>/<Title>.md` with
 * frontmatter `type: link` + `url`, the body being the saver's notes; an optional preview image
 * sits in `<dir>/assets/`. The page is fetched through `server/ssrf.ts` and ONLY parsed fields
 * ever reach the client: no response bodies, no upstream error text. A page that cannot be
 * fetched (dead, blocked, not HTML, anything) still yields a saved link.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Doc, Frontmatter, SaveBookmarkInput } from '../shared/types.ts';
import { recordActivitySafe, syncAndBroadcast, type Ctx } from './context.ts';
import { projectOfPath, readDoc, writeDoc } from './docs.ts';
import { HttpError, invalid } from './errors.ts';
import { atomicCreateExclusive, atomicWrite, dedupeName, statOrNull } from './fsutil.ts';
import { assertWritable } from './links.ts';
import { serializeMarkdown } from './markdown.ts';
import { fileKind, parseClientPath, relDirname, relJoin, resolveVaultPath, splitExt } from './paths.ts';
import { FetchBlockedError, guardedFetch, type NetHooks } from './ssrf.ts';

export const DEFAULT_BOOKMARK_DIR = 'Library/Links';
export const PREVIEW_DIR = 'assets';
export const MAX_HTML_BYTES = 2 * 1024 * 1024;
export const MAX_PREVIEW_BYTES = 5 * 1024 * 1024;
export const MAX_TITLE_CHARS = 200;
export const MAX_DESCRIPTION_CHARS = 500;
const MAX_TAG_CHARS = 4000;
const MAX_URL_CHARS = 2048;

/* ───────────────────────── Pure: text ───────────────────────── */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', copy: '©', reg: '®', trade: '™', middot: '·', bull: '•', deg: '°', times: '×',
  eacute: 'é', egrave: 'è', ecirc: 'ê', agrave: 'à', aacute: 'á', acirc: 'â', auml: 'ä', ouml: 'ö', uuml: 'ü', szlig: 'ß',
  ccedil: 'ç', ntilde: 'ñ', iacute: 'í', oacute: 'ó', uacute: 'ú', euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§',
};

const REPLACEMENT = String.fromCodePoint(0xfffd);
/** C0/C1 controls, zero-width and bidi-override characters: none of them belong in a title. */
const INVISIBLE = new RegExp(
  `[${[[0x00, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2066, 0x2069], [0xfeff, 0xfeff]]
    .map(([from, to]) => `\\u{${(from as number).toString(16)}}-\\u{${(to as number).toString(16)}}`)
    .join('')}]`,
  'gu',
);
const CONTROL = new RegExp(`[\\u{0}-\\u{1f}\\u{7f}]`, 'gu');
const COMBINING_MARKS = new RegExp(`[\\u{300}-\\u{36f}]`, 'gu');

function fromCodePoint(n: number): string {
  // Reject what HTML rejects: NUL, surrogates, out of range. Control characters are dropped by `cleanText`.
  if (!Number.isInteger(n) || n <= 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return REPLACEMENT;
  return String.fromCodePoint(n);
}

export function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,15}));/g, (whole, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (dec !== undefined) return fromCodePoint(Number(dec));
    if (hex !== undefined) return fromCodePoint(parseInt(hex, 16));
    return NAMED_ENTITIES[name as string] ?? NAMED_ENTITIES[(name as string).toLowerCase()] ?? whole;
  });
}

/** Entities decoded, control characters gone, whitespace collapsed, hard length cap (on code points). */
export function cleanText(raw: string, max: number): string {
  const text = decodeEntities(raw).replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim();
  const points = Array.from(text);
  return points.length > max ? `${points.slice(0, max - 1).join('').trimEnd()}…` : text;
}

/* ───────────────────────── Pure: HTML → metadata ───────────────────────── */

export interface PageMetadata {
  title?: string;
  description?: string;
  /** Absolute URL of the preview image, resolved against the page's final URL. */
  image?: string;
}

const ATTR = /([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function attributesOf(tag: string): Map<string, string> {
  const out = new Map<string, string>();
  ATTR.lastIndex = 0;
  for (let m = ATTR.exec(tag); m; m = ATTR.exec(tag)) {
    const name = (m[1] as string).toLowerCase();
    if (!out.has(name)) out.set(name, m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

/**
 * Every `<meta>` in the (already size-capped) document, in one linear pass. No backtracking
 * regex ever runs over the whole page: a hostile document cannot make this quadratic.
 */
function metaTags(html: string, lower: string): Map<string, string> {
  const found = new Map<string, string>();
  let nextClose = -1;
  for (let at = lower.indexOf('<meta'); at !== -1; at = lower.indexOf('<meta', at + 5)) {
    if (nextClose < at) {
      nextClose = lower.indexOf('>', at);
      if (nextClose === -1) break; // no tag after this point can be complete either
    }
    if (nextClose - at > MAX_TAG_CHARS) continue;
    const boundary = lower.charCodeAt(at + 5);
    if (!(boundary === 32 || boundary === 9 || boundary === 10 || boundary === 13 || boundary === 12 || boundary === 47)) continue; // `<metadata>` is not `<meta>`
    const attrs = attributesOf(html.slice(at + 5, nextClose));
    const key = (attrs.get('property') ?? attrs.get('name') ?? attrs.get('itemprop') ?? '').trim().toLowerCase();
    const content = attrs.get('content');
    if (key && content !== undefined && content.trim() !== '' && !found.has(key)) found.set(key, content);
  }
  return found;
}

function titleTag(html: string, lower: string): string | undefined {
  const open = lower.indexOf('<title');
  if (open === -1) return undefined;
  const start = lower.indexOf('>', open);
  if (start === -1) return undefined;
  const end = lower.indexOf('</title', start);
  const raw = html.slice(start + 1, end === -1 ? start + 1 + 2000 : Math.min(end, start + 1 + 2000));
  return raw;
}

/** title: og:title → twitter:title → <title>. description: og:description → meta description. image: og:image → twitter:image. */
export function parsePageMetadata(html: string, finalUrl: URL): PageMetadata {
  const lower = html.toLowerCase();
  const meta = metaTags(html, lower);
  const first = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = meta.get(key);
      if (value !== undefined) return value;
    }
    return undefined;
  };
  const out: PageMetadata = {};

  const title = cleanText(first('og:title', 'twitter:title') ?? titleTag(html, lower) ?? '', MAX_TITLE_CHARS);
  if (title) out.title = title;
  const description = cleanText(first('og:description', 'description', 'twitter:description') ?? '', MAX_DESCRIPTION_CHARS);
  if (description) out.description = description;

  const image = first('og:image', 'og:image:url', 'og:image:secure_url', 'twitter:image', 'twitter:image:src');
  if (image) {
    try {
      const resolved = new URL(decodeEntities(image).trim(), finalUrl);
      if ((resolved.protocol === 'http:' || resolved.protocol === 'https:') && resolved.href.length <= MAX_URL_CHARS) out.image = resolved.href;
    } catch {
      /* an unparseable image URL is simply no image */
    }
  }
  return out;
}

/** Bytes → text, honouring the declared charset (header first, then an early `<meta charset>`). Never throws. */
export function decodeHtml(body: Buffer, contentType: string | undefined): string {
  const fromHeader = /charset\s*=\s*"?([^\s;"]+)/i.exec(contentType ?? '')?.[1];
  const fromMeta = /<meta[^>]{0,200}charset\s*=\s*["']?([a-zA-Z0-9_-]{2,40})/i.exec(body.subarray(0, 2048).toString('latin1'))?.[1];
  for (const label of [fromHeader, fromMeta, 'utf-8']) {
    if (!label) continue;
    try {
      return new TextDecoder(label, { fatal: false }).decode(body);
    } catch {
      /* unknown label: try the next */
    }
  }
  return body.toString('utf8');
}

/* ───────────────────────── Pure: images ───────────────────────── */

export type PreviewExt = 'png' | 'jpg' | 'webp' | 'gif';

/**
 * The image type according to the BYTES. Content-Type and file extension are not consulted:
 * only these four raster formats are ever stored. SVG in particular (script-capable) has no
 * signature here and so can never be saved as a preview, whatever the server claims it is.
 */
export function sniffImage(buf: Buffer): PreviewExt | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 6 && (buf.subarray(0, 6).toString('latin1') === 'GIF87a' || buf.subarray(0, 6).toString('latin1') === 'GIF89a')) return 'gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

/* ───────────────────────── Pure: names ───────────────────────── */

/** Absolute, normalised http(s) URL without credentials, or a 400. This is about what may be STORED; fetching has stricter rules. */
export function normalizeBookmarkUrl(input: unknown): URL {
  if (typeof input !== 'string' || !input.trim()) throw invalid('url is required.');
  if (input.length > MAX_URL_CHARS) throw invalid(`url is too long (max ${MAX_URL_CHARS} characters).`);
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw invalid('url is not a valid absolute URL (it must start with http:// or https://).');
  }
  // `javascript:`, `data:`, `file:` … would be dangerous the moment a UI renders the bookmark as a link.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw invalid('Only http:// and https:// URLs can be saved as bookmarks.');
  if (url.username || url.password) throw invalid('Remove the username/password from the URL: bookmarks are stored as plain text.');
  if (!url.hostname) throw invalid('url has no host.');
  return url;
}

export function siteOf(url: URL): string {
  return url.hostname.toLowerCase().replace(/^www\./, '');
}

/** What a bookmark is called when the page could not say: host + path, no query string. */
export function fallbackTitle(url: URL): string {
  let pathname = url.pathname.replace(/\/+$/, '');
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    /* keep it encoded */
  }
  return cleanText(`${siteOf(url)}${pathname}`, MAX_TITLE_CHARS);
}

/** A title as a file name: nothing the filesystem, the path resolver or a shell would trip over. */
export function fileNameForTitle(title: string): string {
  const stem = title
    .normalize('NFC')
    .replace(CONTROL, ' ')
    .replace(/[\\/:*?"<>|#^[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '');
  let out = Array.from(stem).slice(0, 100).join('').replace(/[.\s]+$/g, '');
  while (Buffer.byteLength(out, 'utf8') > 200) out = Array.from(out).slice(0, -1).join('');
  return `${out || 'Untitled link'}.md`;
}

export function slugify(text: string): string {
  const slug = text
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slug || 'link';
}

export function shortHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8);
}

function cleanTags(tags: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const tag of tags ?? []) {
    const t = cleanText(String(tag), 60).replace(/^#+/, '');
    if (t && !out.includes(t)) out.push(t);
  }
  return out.slice(0, 50);
}

/* ───────────────────────── Fetching ───────────────────────── */

interface Fetched {
  meta: PageMetadata;
  preview: { bytes: Buffer; ext: PreviewExt } | null;
}

/** Generic, fixed wording for the saved file. Nothing from upstream is ever interpolated here. */
function failureNote(err: unknown): string {
  if (err instanceof FetchBlockedError) {
    switch (err.reason) {
      case 'address':
      case 'hostname':
        return 'not fetched: the address is private, local or otherwise not on the public internet';
      case 'scheme':
      case 'credentials':
      case 'invalid_url':
        return 'not fetched: the URL is not one CENTCOM will request';
      case 'dns':
        return 'not fetched: the host name did not resolve';
      case 'timeout':
        return 'not fetched: the site took too long to answer';
      case 'redirects':
        return 'not fetched: too many redirects';
      default:
        return 'not fetched: the site could not be reached';
    }
  }
  return 'not fetched: the page could not be read';
}

class NotAPage extends Error {}

async function fetchPreviewImage(imageUrl: string, hooks: NetHooks | undefined): Promise<Fetched['preview']> {
  try {
    const res = await guardedFetch(imageUrl, { maxBytes: MAX_PREVIEW_BYTES, accept: 'image/png,image/jpeg,image/webp,image/gif;q=0.9,*/*;q=0.1', hooks });
    if (res.status < 200 || res.status >= 300 || res.truncated || res.body.length === 0) return null; // truncated = over the 5 MB cap
    const ext = sniffImage(res.body);
    return ext ? { bytes: res.body, ext } : null;
  } catch {
    return null; // a bookmark without a picture is still a bookmark
  }
}

/** Throws (generic errors only) when the page yields nothing usable. */
async function fetchPage(url: URL, hooks: NetHooks | undefined): Promise<Fetched> {
  const res = await guardedFetch(url, { maxBytes: MAX_HTML_BYTES, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', hooks });
  if (res.status < 200 || res.status >= 300) throw new FetchBlockedError('status', 'the site answered with an error');
  const contentType = String(res.headers['content-type'] ?? '');
  if (contentType && !/\b(?:text\/html|application\/xhtml\+xml)\b/i.test(contentType)) throw new NotAPage();
  const meta = parsePageMetadata(decodeHtml(res.body, contentType), res.finalUrl);
  const preview = meta.image ? await fetchPreviewImage(meta.image, hooks) : null;
  return { meta, preview };
}

/* ───────────────────────── Save ───────────────────────── */

function isLinkDoc(frontmatter: Frontmatter): boolean {
  return frontmatter.type === 'link' && typeof frontmatter.url === 'string' && frontmatter.url.trim() !== '';
}

function sameUrl(stored: unknown, wanted: URL): boolean {
  if (typeof stored !== 'string') return false;
  try {
    return new URL(stored.trim()).href === wanted.href;
  } catch {
    return false;
  }
}

function findExisting(ctx: Ctx, dirRel: string, url: URL): string | undefined {
  for (const [rel, doc] of ctx.index.docs) {
    if (relDirname(rel) === dirRel && isLinkDoc(doc.frontmatter) && sameUrl(doc.frontmatter.url, url)) return rel;
  }
  return undefined;
}

/** Store the preview at `<dir>/assets/<slug>-<shorthash>.<ext>` and return its vault-relative path. */
async function storePreview(ctx: Ctx, dirRel: string, stem: string, url: URL, preview: NonNullable<Fetched['preview']>): Promise<string> {
  const name = `${slugify(stem)}-${shortHash(url.href)}.${preview.ext}`;
  const target = await resolveVaultPath(ctx.vault, relJoin(dirRel, PREVIEW_DIR, name));
  assertWritable(target, 'written');
  await atomicWrite(target.abs, preview.bytes);
  return target.rel;
}

export interface SavedBookmark {
  doc: Doc;
  /** False when a bookmark for this URL was already in the folder and is returned as is. */
  created: boolean;
}

export async function saveBookmark(ctx: Ctx, input: SaveBookmarkInput, agent: string): Promise<SavedBookmark> {
  const url = normalizeBookmarkUrl(input.url);
  const dir = await resolveVaultPath(ctx.vault, input.dir === undefined || input.dir === '' ? DEFAULT_BOOKMARK_DIR : input.dir);
  assertWritable(dir, 'written to');
  const dirStat = await statOrNull(dir.abs);
  if (dirStat && !dirStat.isDirectory()) throw invalid(`${dir.rel} is not a folder.`);

  // One save per (folder, URL) at a time, so two agents saving the same page get the same file.
  return ctx.locks.run(`bookmark:${dir.rel}\n${url.href}`, async () => {
    const existing = findExisting(ctx, dir.rel, url);
    if (existing) return { doc: await readDoc(ctx, existing), created: false };

    let fetched: Fetched | null = null;
    let note: string | null = null;
    try {
      fetched = await fetchPage(url, ctx.net);
    } catch (err) {
      note = err instanceof NotAPage ? null : failureNote(err);
      if (!(err instanceof FetchBlockedError) && !(err instanceof NotAPage)) ctx.log.warn('Bookmark: the page could not be parsed; saved as a plain link.');
    }

    const title = cleanText(input.title ?? '', MAX_TITLE_CHARS) || fetched?.meta.title || fallbackTitle(url);
    await fs.mkdir(dir.abs, { recursive: true });

    let imageRel: string | undefined;
    if (fetched?.preview) {
      try {
        imageRel = await storePreview(ctx, dir.rel, splitExt(fileNameForTitle(title))[0], url, fetched.preview);
      } catch (err) {
        ctx.log.warn(`Bookmark: could not store the preview image (${err instanceof HttpError ? err.message : 'write failed'}).`);
      }
    }

    const tags = cleanTags(input.tags);
    const frontmatter: Frontmatter = {
      type: 'link',
      title,
      url: url.href,
      site: siteOf(url),
      ...(fetched?.meta.description ? { description: fetched.meta.description } : {}),
      ...(imageRel ? { image: imageRel } : {}),
      tags,
      saved: new Date().toISOString(),
      saved_by: agent,
      ...(note ? { fetch_error: note } : {}),
    };
    const content = serializeMarkdown(frontmatter, (input.note ?? '').replace(/\r\n/g, '\n').trim());

    const rel = await ctx.nameLock.run(async () => {
      for (let attempt = 0; ; attempt += 1) {
        const name = await dedupeName(dir.abs, fileNameForTitle(title));
        const target = await resolveVaultPath(ctx.vault, relJoin(dir.rel, name));
        try {
          await atomicCreateExclusive(target.abs, content);
          return target.rel;
        } catch (err) {
          if (attempt >= 5 || !(err instanceof HttpError && err.code === 'exists')) throw err;
        }
      }
    });

    // One sync for both files: the tree never shows a preview folder without the link that owns it.
    await syncAndBroadcast(ctx, imageRel ? [imageRel, rel] : [rel]);
    await recordActivitySafe(ctx, { agent, type: 'doc.created', path: rel, project: projectOfPath(rel), subject: title });
    return { doc: await readDoc(ctx, rel), created: true };
  });
}

/* ───────────────────────── Refresh ───────────────────────── */

/**
 * Re-fetch the page behind an existing link file. Notes (the body), tags, `saved` and
 * `saved_by` are never touched, and a title somebody chose is kept: the title is only filled
 * in when it is still the placeholder from a save that could not reach the site.
 */
export async function refreshBookmark(ctx: Ctx, clientPath: unknown, agent: string): Promise<Doc> {
  const target = await resolveVaultPath(ctx.vault, clientPath);
  assertWritable(target, 'refreshed');
  if (fileKind(target.rel) !== 'markdown') throw invalid(`${target.rel} is not a bookmark.`);
  const current = await readDoc(ctx, target.rel);
  if (!isLinkDoc(current.frontmatter)) throw invalid(`${target.rel} is not a bookmark (its frontmatter needs "type: link" and a "url").`);
  const url = normalizeBookmarkUrl(current.frontmatter.url);

  let fetched: Fetched;
  try {
    fetched = await fetchPage(url, ctx.net);
  } catch {
    // Generic on purpose: the reason could describe what is reachable from this machine.
    throw new HttpError(502, 'The page could not be fetched. The bookmark is unchanged.');
  }

  const patch: Frontmatter = { site: siteOf(url), fetch_error: null };
  const currentTitle = typeof current.frontmatter.title === 'string' ? current.frontmatter.title.trim() : '';
  if (fetched.meta.title && (currentTitle === '' || currentTitle === fallbackTitle(url))) patch.title = fetched.meta.title;
  if (fetched.meta.description) patch.description = fetched.meta.description;

  const dirRel = relDirname(target.rel);
  const previous = typeof current.frontmatter.image === 'string' ? current.frontmatter.image : undefined;
  if (fetched.preview) {
    const imageRel = await storePreview(ctx, dirRel, splitExt(path.posix.basename(target.rel))[0], url, fetched.preview);
    patch.image = imageRel;
    const touched = [imageRel];
    // A preview that changed format leaves its old file behind; it was ours (same folder, same URL hash), so tidy it.
    if (previous && previous !== imageRel && relDirname(previous) === relJoin(dirRel, PREVIEW_DIR) && previous.includes(`-${shortHash(url.href)}.`)) {
      try {
        parseClientPath(previous);
        const old = await resolveVaultPath(ctx.vault, previous);
        await fs.rm(old.abs, { force: true });
        touched.push(old.rel);
      } catch {
        /* not ours to remove after all */
      }
    }
    await syncAndBroadcast(ctx, touched);
  }
  return writeDoc(ctx, { path: target.rel, frontmatter: patch }, agent);
}
