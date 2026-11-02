import type { JSONContent } from '@tiptap/react';

/**
 * Markdown fidelity.
 *
 * A WYSIWYG editor re-serializes the whole document on every save, which rewrites
 * syntax it does not model: `[[wikilinks]]` get escaped, raw HTML loses its tags,
 * tables are re-padded, `_em_` becomes `*em*`. For files that agents, git, and
 * Obsidian also read, that is corruption.
 *
 * So a save is a *patch*, not a rewrite: blocks the user did not touch are emitted
 * byte-for-byte from the original source, and only edited blocks come from the
 * serializer (then lightly cleaned, see `tidy`). Editing one word yields a one-line diff.
 */

export interface MarkdownManagerLike {
  instance: { lexer(src: string): Array<{ type: string; raw: string }> };
  parse(markdown: string): JSONContent;
  serialize(content: JSONContent): string;
}

interface SourceBlock {
  /** Exact original text of the block, without trailing newlines. */
  raw: string;
  /** What the serializer produces for this block. Two blocks are "the same" when these match. */
  canon: string;
  /**
   * Everything between this block and the next visible one, verbatim: blank lines plus
   * blocks the editor cannot see at all (link reference definitions, HTML comments).
   */
  gap: string;
}

export interface Baseline {
  /** Invisible content before the first visible block. */
  head: string;
  blocks: SourceBlock[];
}

const canonOf = (m: MarkdownManagerLike, md: string): string => {
  try {
    return m.serialize(m.parse(md)).trim();
  } catch {
    return '';
  }
};

/** Split the original markdown into blocks. Returns null when it cannot be done losslessly. */
export function buildBaseline(m: MarkdownManagerLike, source: string): Baseline | null {
  const src = source.replace(/\r\n?/g, '\n');
  let tokens: Array<{ type: string; raw: string }>;
  try {
    tokens = m.instance.lexer(src);
  } catch {
    return null;
  }
  // The patch is only sound if the pieces add back up to the source exactly.
  if (tokens.map((t) => t.raw).join('') !== src) return null;

  // Reference-style links (`[text][id]`) only resolve when their `[id]: url` definition is in
  // view. Each block is parsed on its own, so hand it the document's definitions as context;
  // they render to nothing, so they do not affect the block's own output.
  const defs = tokens
    .filter((t) => t.type === 'def')
    .map((t) => t.raw.trim())
    .join('\n');

  const base: Baseline = { head: '', blocks: [] };
  for (const t of tokens) {
    const last = base.blocks[base.blocks.length - 1];
    const carry = (text: string) => {
      if (last) last.gap += text;
      else base.head += text;
    };
    if (t.type === 'space') {
      carry(t.raw);
      continue;
    }
    const raw = t.raw.replace(/\n+$/, '');
    const trailing = t.raw.slice(raw.length);
    const canon = t.type === 'def' ? '' : canonOf(m, defs ? `${raw}\n\n${defs}` : raw);
    if (canon === '') {
      // Invisible to the editor: it rides along in the gap so it is never lost.
      carry(t.raw);
      continue;
    }
    base.blocks.push({ raw, canon, gap: trailing });
  }
  return base;
}

/* ───────── Alignment ───────── */

/** Longest common subsequence over block strings, trimmed to the changed middle first. */
function align(a: string[], b: string[]): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    pairs.push([start, start]);
    start++;
  }
  let endA = a.length;
  let endB = b.length;
  const tail: Array<[number, number]> = [];
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
    tail.push([endA, endB]);
  }
  const n = endA - start;
  const k = endB - start;
  if (n > 0 && k > 0) {
    const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(k + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = k - 1; j >= 0; j--) {
        dp[i]![j] = a[start + i] === b[start + j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < k) {
      if (a[start + i] === b[start + j]) {
        pairs.push([start + i, start + j]);
        i++;
        j++;
      } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++;
      else j++;
    }
  }
  return pairs.concat(tail.reverse());
}

/* ───────── Cleanup for blocks that did get re-serialized ───────── */

/** Apply `fn` to prose only, leaving fenced code and inline code spans untouched. */
function outsideCode(block: string, fn: (prose: string) => string): string {
  if (/^ {0,3}(```|~~~)/.test(block)) return block;
  return block
    .split(/(`+[\s\S]*?`+)/g)
    .map((part, i) => (i % 2 === 1 ? part : fn(part)))
    .join('');
}

/**
 * Undo escapes the serializer adds but markdown does not need:
 *  - `\[` `\]`  brackets are only special as part of a link, and real links are emitted as
 *    `[text](url)` unescaped. So an escaped bracket is literal text: `[[wikilinks]]`, `[^1]`,
 *    `[!note]`. A `\]` directly before `(` stays escaped so literal text never becomes a link.
 *  - `\_` between word characters can never open or close emphasis (`snake_case`).
 *  - `[x](x)` / `[x](mailto:x)` is how an autolinked URL or email comes back; restore the bare form.
 */
export function tidy(block: string): string {
  return outsideCode(block, (s) =>
    s
      .replace(/\\\[/g, '[')
      .replace(/\\\](?!\()/g, ']')
      .replace(/(?<=[\p{L}\p{N}])\\_(?=[\p{L}\p{N}])/gu, '_')
      .replace(/\[([^\]\n]+)\]\((?:mailto:)?\1\)/g, '$1'),
  );
}

/* ───────── Patch ───────── */

/**
 * @param current  serializer output for each top-level node, in document order
 * @param baseline what the document was loaded from, or null for a new/unsplittable document
 */
export function patchMarkdown(current: string[], baseline: Baseline | null): string {
  const cur = current.map((c) => c.trim()).filter((c) => c !== '');
  if (!baseline || baseline.blocks.length === 0) return (baseline?.head ?? '') + cur.map(tidy).join('\n\n');

  const orig = baseline.blocks;
  const pairs = align(
    orig.map((b) => b.canon),
    cur,
  );
  const origOfCur = new Map<number, number>(pairs.map(([o, c]) => [c, o]));

  // Between two anchors, pair leftover originals with leftover current blocks in order: an
  // edited block keeps its original gap, so invisible content after it survives the edit.
  const inherit = new Map<number, number>();
  const anchors: Array<[number, number]> = [[-1, -1], ...pairs, [orig.length, cur.length]];
  for (let a = 0; a < anchors.length - 1; a++) {
    const [o0, c0] = anchors[a]!;
    const [o1, c1] = anchors[a + 1]!;
    for (let o = o0 + 1, c = c0 + 1; o < o1 && c < c1; o++, c++) inherit.set(c, o);
  }

  // Which current block each original ended up as (matched or inherited). Originals with no
  // owner were deleted. Invisible content in a deleted block's gap is kept, carried back to the
  // nearest surviving block: deleting a paragraph must not silently delete the link
  // definitions that happened to follow it.
  const ownerOfOrig = new Map<number, number>();
  for (const [c, o] of origOfCur) ownerOfOrig.set(o, c);
  for (const [c, o] of inherit) ownerOfOrig.set(o, c);
  const orphaned = new Map<number, string>();
  let carryTo = -1;
  for (let o = 0; o < orig.length; o++) {
    const owner = ownerOfOrig.get(o);
    if (owner !== undefined) carryTo = owner;
    else if (orig[o]!.gap.trim() !== '') orphaned.set(carryTo, `${orphaned.get(carryTo) ?? ''}\n\n${orig[o]!.gap.trim()}`);
  }

  const headOrphans = (orphaned.get(-1) ?? '').trim();
  let out = baseline.head + (headOrphans ? `${headOrphans}\n\n` : '');

  for (let c = 0; c < cur.length; c++) {
    const o = origOfCur.get(c);
    out += o !== undefined ? orig[o]!.raw : tidy(cur[c]!);

    const last = c === cur.length - 1;
    const from = o ?? inherit.get(c);
    const gap = from !== undefined ? orig[from]!.gap : '';

    // Rule 1. Two untouched blocks that were neighbours keep their original spacing verbatim,
    // even a single newline. Nothing can have been deleted between them, so no orphans apply.
    if (!last && o !== undefined && origOfCur.get(c + 1) === o + 1) {
      out += gap;
      continue;
    }
    // Rule 2. Otherwise keep whatever invisible content followed this block, then separate
    // with a blank line. (A bare newline is not safe next to an edited block: it can fuse them.)
    const invisible = gap.replace(/\s+$/, '');
    if (invisible.trim() !== '') out += invisible;
    out += orphaned.get(c) ?? '';
    if (!last) out += '\n\n';
  }
  return out;
}
