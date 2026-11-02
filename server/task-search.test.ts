import assert from 'node:assert/strict';
import { it } from 'node:test';
import { startTestServer } from './testkit.ts';
import type { SearchHit } from '../shared/types.ts';

it('task search excludes legacy resources before applying the result limit', async () => {
  const t = await startTestServer();
  try {
    await t.api('POST', '/api/projects', { name: 'Launch', key: 'LCH' });
    await t.api('POST', '/api/tickets', { title: 'Launch checklist', project: 'LCH' });
    await t.api('POST', '/api/doc', { path: 'Library/Launch.md', body: 'Launch' });
    const hits = (await t.api<SearchHit[]>('GET', '/api/search?q=Launch&scope=tasks&limit=2')).json;
    assert.equal(hits.length, 2);
    assert.deepEqual(new Set(hits.map((h) => h.type)), new Set(['project', 'ticket']));
    await t.api('POST', '/api/doc', { path: 'Projects/Launch/Library/Runbook.md', body: 'Launch runbook' });
    const library = (await t.api<SearchHit[]>('GET', '/api/search?q=runbook&scope=tasks')).json;
    assert.equal(library[0]?.path, 'Projects/Launch/Library/Runbook.md');
  } finally { await t.close(); }
});
