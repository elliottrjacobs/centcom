import { test } from 'node:test';
import assert from 'node:assert/strict';
import { href, parse, routeForPath } from './routes';
import { PAGE_IDS, startupHash } from './navigation';

test('an agent home has its own route, and round-trips ids that need encoding', () => {
  assert.equal(href({ name: 'agent', id: 'grokbot-stan' }), '#/agent/grokbot-stan');
  assert.deepEqual(parse('#/agent/grokbot-stan'), { name: 'agent', id: 'grokbot-stan' });
  assert.deepEqual(parse(href({ name: 'agent', id: 'a b/c' })), { name: 'agent', id: 'a b/c' });
  assert.deepEqual(parse('#/agent/'), { name: 'agents' });
});

test('the project Library tab lives at /library, and the old /wiki URL still lands there', () => {
  assert.equal(href({ name: 'project', slug: 'Recall Radar', tab: 'library' }), '#/project/Recall%20Radar/library');
  assert.deepEqual(parse('#/project/Recall%20Radar/library'), { name: 'project', slug: 'Recall Radar', tab: 'library' });
  assert.deepEqual(parse('#/project/Recall%20Radar/wiki'), { name: 'project', slug: 'Recall Radar', tab: 'library' });
  assert.deepEqual(parse('#/project/CENTCOM/nonsense'), { name: 'project', slug: 'CENTCOM', tab: 'overview' });
});

test('a doc route opens Library pages, and an old Wiki path opens the same page under Library', () => {
  assert.deepEqual(parse('#/doc/Projects/CENTCOM/Library/Notes/Plan.md'), { name: 'doc', path: 'Projects/CENTCOM/Library/Notes/Plan.md' });
  assert.deepEqual(parse('#/doc/Projects/CENTCOM/Wiki/Plan.md'), { name: 'doc', path: 'Projects/CENTCOM/Library/Plan.md' });
  assert.deepEqual(parse('#/doc/Projects/CENTCOM/Tickets/CEN-1.md'), { name: 'tickets' });
});

test('an agent profile file opens that agent’s home', () => {
  assert.deepEqual(routeForPath('Agents/grokbot-stan.md', 'markdown'), { name: 'agent', id: 'grokbot-stan' });
  assert.deepEqual(routeForPath('Agents/Notes/readme.md', 'markdown'), { name: 'doc', path: 'Agents/Notes/readme.md' });
});

test('a project Library folder (or a leftover Wiki folder) routes to the Library tab', () => {
  assert.deepEqual(routeForPath('Projects/CENTCOM/Library', 'dir'), { name: 'project', slug: 'CENTCOM', tab: 'library' });
  assert.deepEqual(routeForPath('Projects/CENTCOM/Wiki', 'dir'), { name: 'project', slug: 'CENTCOM', tab: 'library' });
  assert.deepEqual(routeForPath('Projects/CENTCOM/Tickets', 'dir'), { name: 'project', slug: 'CENTCOM', tab: 'tickets' });
  assert.deepEqual(routeForPath('Projects/CENTCOM/Wiki/Plan.md', 'markdown'), { name: 'doc', path: 'Projects/CENTCOM/Library/Plan.md' });
});

// The live navigation preferences must still resolve after merging the extracted PR router.
test('every configured page round-trips and can be the startup page', () => {
  for (const name of PAGE_IDS) {
    assert.deepEqual(parse(href({ name })), { name });
    assert.deepEqual(parse(startupHash('', name)), { name });
  }
  assert.deepEqual(parse(startupHash('#/agent/codex-mini', 'skills')), { name: 'agent', id: 'codex-mini' });
  assert.deepEqual(parse(startupHash('#/project/CENTCOM/wiki', 'instructions')), { name: 'project', slug: 'CENTCOM', tab: 'library' });
});
