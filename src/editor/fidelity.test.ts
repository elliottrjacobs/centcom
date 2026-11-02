import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MarkdownManager } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import Image from '@tiptap/extension-image';
import type { JSONContent } from '@tiptap/react';
import { buildBaseline, patchMarkdown, tidy, type MarkdownManagerLike } from './fidelity';

// The same extension set the editor uses, so the serializer under test is the real one.
const manager = new MarkdownManager({
  extensions: [StarterKit.configure({ underline: false }), TaskList, TaskItem.configure({ nested: true }), TableKit, Image],
}) as unknown as MarkdownManagerLike;

/** Serialize each top-level node on its own, exactly as the editor does. */
const blocksOf = (doc: JSONContent): string[] => (doc.content ?? []).map((node) => manager.serialize({ type: 'doc', content: [node] }));

/** Load `source`, let `edit` mutate the parsed document, and return what would be saved. */
function roundTrip(source: string, edit: (doc: JSONContent) => void = () => {}): string {
  const baseline = buildBaseline(manager, source);
  const doc = manager.parse(source);
  edit(doc);
  return patchMarkdown(blocksOf(doc), baseline);
}

const para = (text: string): JSONContent => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const setText = (doc: JSONContent, index: number, text: string) => {
  doc.content![index] = para(text);
};

const TRICKY = `# Fidelity probe

See [[Session Log 2026-09-01]] and [[Projects/BiteMark|the BiteMark page]].

A footnote reference[^1] and a #tag and an email a_b_c@example.com.

> [!note] Obsidian callout
> Body of the callout.

| Col A | Col B |
| --- | --- |
| 1 | \`x_y\` |

1. First
2. Second
   - nested *emphasis* and _underscore emphasis_

<details><summary>Raw HTML</summary>Hidden text</details>

Snake_case_word and 2 * 3 * 4 and a literal \\* star.

\`\`\`ts
const a: number[] = [1, 2];
\`\`\`

[^1]: The footnote text.

EDITME`;

describe('markdown fidelity', () => {
  it('reproduces an unedited document byte-for-byte', () => {
    assert.equal(roundTrip(TRICKY), TRICKY);
  });

  it('changes only the edited block', () => {
    const out = roundTrip(TRICKY, (doc) => setText(doc, doc.content!.length - 1, 'EDITME edited'));
    assert.equal(out, TRICKY.replace(/EDITME$/, 'EDITME edited'));
  });

  it('keeps wikilinks, callouts, footnotes, HTML and table padding when another block changes', () => {
    const out = roundTrip(TRICKY, (doc) => setText(doc, 0, 'Renamed'));
    for (const must of [
      '[[Session Log 2026-09-01]]',
      '[[Projects/BiteMark|the BiteMark page]]',
      'reference[^1]',
      '> [!note] Obsidian callout',
      '<details><summary>Raw HTML</summary>Hidden text</details>',
      '| --- | --- |',
      '_underscore emphasis_',
      'Snake_case_word and 2 * 3 * 4',
      '[^1]: The footnote text.',
    ]) {
      assert.ok(out.includes(must), `lost: ${must}`);
    }
    assert.ok(!out.includes('\\['), 'introduced an escaped bracket');
  });

  it('does not escape wikilinks or snake_case inside the block that WAS edited', () => {
    const out = roundTrip('Intro.\n\nOld text.', (doc) => setText(doc, 1, 'See [[Some Page]] about snake_case_name and [^2].'));
    assert.equal(out, 'Intro.\n\nSee [[Some Page]] about snake_case_name and [^2].');
  });

  it('preserves single-newline spacing between untouched neighbours', () => {
    const src = '# Title\nTight paragraph.\n\nLast.';
    assert.equal(roundTrip(src), src);
    assert.equal(
      roundTrip(src, (doc) => setText(doc, 2, 'Last, edited.')),
      '# Title\nTight paragraph.\n\nLast, edited.',
    );
  });

  it('never loses link reference definitions, even when the block before them is edited or deleted', () => {
    const src = 'Read [the docs][d].\n\n[d]: https://example.com/docs\n\nTail.';
    assert.equal(roundTrip(src), src);
    const edited = roundTrip(src, (doc) => setText(doc, 0, 'Rewritten.'));
    assert.ok(edited.includes('[d]: https://example.com/docs'), edited);
    const deleted = roundTrip(src, (doc) => void doc.content!.splice(0, 1));
    assert.ok(deleted.includes('[d]: https://example.com/docs'), deleted);
    assert.ok(deleted.includes('Tail.'));
  });

  it('handles inserted and deleted blocks', () => {
    const src = 'One.\n\nTwo.\n\nThree.';
    assert.equal(
      roundTrip(src, (doc) => void doc.content!.splice(1, 0, para('Inserted.'))),
      'One.\n\nInserted.\n\nTwo.\n\nThree.',
    );
    assert.equal(
      roundTrip(src, (doc) => void doc.content!.splice(1, 1)),
      'One.\n\nThree.',
    );
  });

  it('restores the original text when an edit is undone', () => {
    const src = 'Uses _underscore_ emphasis.\n\nOther.';
    const out = roundTrip(src, (doc) => {
      const original = doc.content![0]!;
      setText(doc, 0, 'temp');
      doc.content![0] = original;
    });
    assert.equal(out, src);
  });

  it('writes a brand-new document cleanly', () => {
    assert.equal(patchMarkdown(blocksOf({ type: 'doc', content: [para('Hello [[World]].')] }), buildBaseline(manager, '')), 'Hello [[World]].');
  });

  it('normalizes CRLF sources instead of refusing them', () => {
    assert.ok(buildBaseline(manager, 'A.\r\n\r\nB.') !== null);
  });
});

describe('tidy', () => {
  it('leaves code alone', () => {
    assert.equal(tidy('Regex `/\\[a-z\\]/` stays'), 'Regex `/\\[a-z\\]/` stays');
    assert.equal(tidy('```js\nconst r = /\\[x\\]/;\n```'), '```js\nconst r = /\\[x\\]/;\n```');
  });
  it('keeps a bracket escaped when unescaping would create a link', () => {
    assert.equal(tidy('literal \\[text\\](not-a-link)'), 'literal [text\\](not-a-link)');
  });
  it('only unescapes intraword underscores', () => {
    assert.equal(tidy('snake\\_case but \\_leading\\_'), 'snake_case but \\_leading\\_');
  });
  it('restores bare autolinks', () => {
    assert.equal(tidy('[me@example.com](mailto:me@example.com)'), 'me@example.com');
    assert.equal(tidy('[https://a.dev](https://a.dev)'), 'https://a.dev');
    assert.equal(tidy('[docs](https://a.dev)'), '[docs](https://a.dev)');
  });
});
