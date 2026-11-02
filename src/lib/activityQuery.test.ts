import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ActivityEvent } from '@shared/types';
import { filterActivity } from './activityQuery';

const events: ActivityEvent[] = [
  {id: 'a', ts: 10, agent: 'legacy-agent', type: 'ticket.comment', ticket: 'CEN-1'},
  {id: 'b', ts: 30, agent: 'codex', type: 'ticket.updated', ticket: 'CEN-1'},
  {id: 'c', ts: 20, agent: 'codex', type: 'ticket.comment', ticket: 'CEN-2'},
];

test('activity combines event author and kind, retaining historical authors without task data', () => {
  assert.deepEqual(filterActivity(events, 'codex', 'ticket.comment', false).map(e => e.id), ['c']);
  assert.deepEqual(filterActivity(events, 'legacy-agent', '', false).map(e => e.id), ['a']);
  assert.deepEqual(filterActivity(events, 'legacy-agent', 'ticket.updated', false), []);
});

test('activity explicitly orders both ways without mutating the shared feed, and clearing restores events', () => {
  assert.deepEqual(filterActivity(events, '', '', false).map(e => e.id), ['b', 'c', 'a']);
  assert.deepEqual(filterActivity(events, '', '', true).map(e => e.id), ['a', 'c', 'b']);
  assert.deepEqual(events.map(e => e.id), ['a', 'b', 'c']);
});
