import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliverableTarget, oneLine, sourceLabel } from './agentHome';

test('a profile says where it came from', () => {
  assert.equal(sourceLabel('grokbot-sync'), 'Synced from Grok Bot');
  assert.equal(sourceLabel('self-reported'), 'Self-reported');
});

test('a deliverable opens a web link externally, a Library doc or ticket in the app, any other vault file raw', () => {
  assert.deepEqual(deliverableTarget('https://github.com/o/r/pull/42'), { type: 'external', url: 'https://github.com/o/r/pull/42' });
  assert.deepEqual(deliverableTarget('Projects/CENTCOM/Library/Report.md'), { type: 'route', route: { name: 'doc', path: 'Projects/CENTCOM/Library/Report.md' } });
  assert.deepEqual(deliverableTarget('Projects/CENTCOM/Wiki/Report.md'), { type: 'route', route: { name: 'doc', path: 'Projects/CENTCOM/Library/Report.md' } });
  assert.deepEqual(deliverableTarget('Projects/CENTCOM/Tickets/CEN-7.md'), { type: 'route', route: { name: 'ticket', id: 'CEN-7' } });
  assert.deepEqual(deliverableTarget('Projects/CENTCOM/Library/Outputs/deck.pdf'), { type: 'raw', path: 'Projects/CENTCOM/Library/Outputs/deck.pdf' });
  assert.deepEqual(deliverableTarget('Taste/notes.md'), { type: 'raw', path: 'Taste/notes.md' });
});

test('a markdown description shrinks to one plain line for lists', () => {
  assert.equal(oneLine('**Codex** CLI working in [repos](https://x.y).\n\nSecond paragraph.'), 'Codex CLI working in repos.');
  assert.equal(oneLine('## Who\n\n- Runs `tests`'), 'Who');
  assert.equal(oneLine('   '), '');
});
