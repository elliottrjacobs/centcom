import matter from 'gray-matter';
import type { Frontmatter } from '../shared/types.ts';
import { relBasename, splitExt } from './paths.ts';

export type Eol = '' | '\n' | '\r\n';

export interface ParsedMarkdown {
  frontmatter: Frontmatter;
  /** Body without the file's final line ending (see `eol`). */
  body: string;
  /** Raw YAML between the fences, exactly as found on disk (null when there is no block). */
  rawFrontmatter: string | null;
  /**
   * The whole fenced block exactly as it sits on disk: BOM, fences, comments, quoting, line
   * endings and all. Re-emitting this instead of re-serialising is what keeps a save from
   * producing a noisy diff in a file that lives in somebody's git repo. Null when there is no block.
   */
  rawBlock: string | null;
  /** How the file ended: nothing, LF or CRLF. Preserved on rewrite. */
  eol: Eol;
  /** True when a frontmatter block exists but is not valid YAML / not a mapping. */
  malformed: boolean;
}

// The closing fence must start a line. The capture is absent for an empty `---\n---` block.
const FENCE = /^\uFEFF?---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;

/** YAML timestamps come back as Date objects; hand JSON-safe strings to everyone downstream. */
function normalizeValue(value: unknown): unknown {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const iso = value.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso;
  }
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = normalizeValue(v);
    return out;
  }
  return value;
}

/**
 * Liberal parser. Never throws. When the frontmatter block is broken the whole file
 * is returned as the body so nothing a human or agent wrote is ever hidden or lost.
 */
export function parseMarkdown(raw: string): ParsedMarkdown {
  const eol: Eol = raw.endsWith('\r\n') ? '\r\n' : raw.endsWith('\n') ? '\n' : '';
  const whole = (text: string): string => (eol ? text.slice(0, -eol.length) : text);
  const match = FENCE.exec(raw);
  if (!match) return { frontmatter: {}, body: whole(raw.replace(/^\uFEFF/, '')), rawFrontmatter: null, rawBlock: null, eol, malformed: false };
  const rawFrontmatter = match[1] ?? '';
  const rawBlock = match[0];
  // A block that runs to the very end of the file owns the final newline; the body is then empty.
  const rest = raw.slice(rawBlock.length);
  const body = rest.length === 0 ? '' : whole(rest);
  if (rawFrontmatter.trim() === '') return { frontmatter: {}, body, rawFrontmatter, rawBlock, eol, malformed: false };
  const broken: ParsedMarkdown = { frontmatter: {}, body: whole(raw), rawFrontmatter: null, rawBlock: null, eol, malformed: true };
  try {
    // Passing an options object disables gray-matter's unbounded content cache.
    const parsed = matter(`---\n${rawFrontmatter}\n---\n`, {});
    const data: unknown = parsed.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return broken;
    return { frontmatter: normalizeValue(data) as Frontmatter, body, rawFrontmatter, rawBlock, eol, malformed: false };
  } catch {
    return broken;
  }
}

function dumpYaml(frontmatter: Frontmatter, opts: SerializeOptions): string {
  const yamlOptions: Record<string, unknown> = { lineWidth: -1, noRefs: true, sortKeys: false };
  if (opts.flow) yamlOptions.flowLevel = 1;
  // gray-matter forwards unknown options to js-yaml's safeDump.
  const out = matter.stringify('', frontmatter, yamlOptions as never);
  const m = FENCE.exec(out);
  return m ? (m[1] ?? '') : '';
}

/**
 * Files end with a newline; API bodies do not carry it. Reading drops exactly one line ending
 * and writing puts exactly one back, so what a client PUTs is what it GETs, and a body that
 * really does end in blank lines keeps them. An empty body gets no line ending at all.
 */
function toDisk(text: string, eol: Eol | undefined): string {
  return text.length === 0 ? '' : `${text}${eol ?? '\n'}`;
}

export interface SerializeOptions {
  /** Emit nested collections in flow style (`labels: [a, b]`), as ticket files do. */
  flow?: boolean;
  /** Final line ending to use. Default LF. Pass the existing file's `eol` to keep its convention. */
  eol?: Eol;
}

/** Strict writer: one fenced YAML block (omitted when empty), body, final line ending. */
export function serializeMarkdown(frontmatter: Frontmatter, body: string, opts: SerializeOptions = {}): string {
  const keys = Object.keys(frontmatter).filter((k) => frontmatter[k] !== undefined);
  if (keys.length === 0) return toDisk(body, opts.eol);
  const clean: Frontmatter = {};
  for (const k of keys) clean[k] = frontmatter[k];
  return `---\n${dumpYaml(clean, opts)}\n---\n${toDisk(body, opts.eol)}`;
}

/**
 * Replace only the body of an existing file. The frontmatter block is re-emitted byte-for-byte
 * and the file keeps its final-newline convention (a file that had a body and no final newline
 * still has none).
 */
export function serializeKeepingFrontmatter(current: ParsedMarkdown, body: string): string {
  const eol: Eol = current.body.length === 0 && current.eol === '' ? '\n' : current.eol;
  if (current.rawBlock === null) return toDisk(body, eol);
  if (body.length === 0) return current.rawBlock;
  const joint = /\r?\n$/.test(current.rawBlock) ? '' : current.eol || '\n';
  return `${current.rawBlock}${joint}${toDisk(body, eol)}`;
}

/** Shallow merge; a key set to `null` is removed. */
export function mergeFrontmatter(base: Frontmatter, patch: Frontmatter | undefined): Frontmatter {
  if (!patch) return { ...base };
  const out: Frontmatter = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

export function firstHeading(body: string): string | null {
  const m = /^#[ \t]+(.+?)[ \t]*#*[ \t]*$/m.exec(body);
  const text = m?.[1]?.trim();
  return text ? text : null;
}

export function fileStem(rel: string): string {
  return splitExt(relBasename(rel))[0];
}

/** Display title per the contract: frontmatter `title` when present, else the file name sans extension. */
export function docTitle(frontmatter: Frontmatter, rel: string): string {
  const t = frontmatter.title;
  if (typeof t === 'string' && t.trim()) return t.trim();
  if (typeof t === 'number') return String(t);
  return fileStem(rel);
}

/** Epoch ms from anything a human might put in a date field. */
export function toEpoch(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 0 && value < 1e11 ? Math.round(value * 1000) : Math.round(value);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === 'string' && value.trim()) {
    const t = Date.parse(value.trim());
    return Number.isNaN(t) ? null : t;
  }
  return null;
}
