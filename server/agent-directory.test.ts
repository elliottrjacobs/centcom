import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Agent } from '../shared/types.ts';
import { isPersonalAgent } from './agents.ts';
import { startTestServer } from './testkit.ts';

test('the personal directory excludes tools, device aliases and humans, while allowing named agents on any platform', () => {
  for (const id of ['codex', 'chatgpt', 'claude-code', 'cursor', 'grok', 'filesystem', 'codex-mini', 'claude-macbook', 'codex-macbook', 'Mac mini', 'macbook-pro', 'claude-code-mac-mini', 'codex-laptop', 'claude-code-workstation', 'codex-vm-2', 'imac', 'server']) {
    assert.equal(isPersonalAgent({ id, kind: 'agent' }), false, id);
  }
  assert.equal(isPersonalAgent({ id: 'sam', kind: 'human' }), false);
  for (const id of ['grokbot-stan', 'grokbot-spark', 'research-assistant', 'codex-researcher', 'travel-planner', 'host-relations', 'server-admin-bot']) {
    assert.equal(isPersonalAgent({ id, kind: 'agent' }), true, id);
  }
});

test('both clients receive directory membership without losing historical authors or their homes', async () => {
  const t = await startTestServer();
  try {
    await t.api('POST', '/api/tickets', { title: 'Historical tool work', createdBy: 'codex-mini' });
    await t.api('POST', '/api/tickets', { title: 'Bot work without profile', createdBy: 'grokbot-stan' });
    await t.api('PUT', '/api/agents/travel-planner/profile', { name: 'Travel Planner', description: 'Personal travel agent', instructions: '' });
    const { json: agents } = await t.api<Agent[]>('GET', '/api/agents');
    assert.equal(agents.find((a) => a.id === 'codex-mini')?.showInDirectory, false);
    assert.equal(agents.find((a) => a.id === 'chatgpt')?.showInDirectory, false);
    assert.equal(agents.find((a) => a.kind === 'human')?.showInDirectory, false);
    assert.deepEqual(agents.filter((a) => a.showInDirectory).map((a) => a.id).sort(), ['grokbot-stan', 'travel-planner']);
    assert.equal((await t.api('GET', '/api/agents/codex-mini/home')).status, 200);
    const { json: events } = await t.api<Array<{agent: string}>>('GET', '/api/activity');
    assert.ok(events.some((e) => e.agent === 'codex-mini'));
  } finally { await t.close(); }
});
