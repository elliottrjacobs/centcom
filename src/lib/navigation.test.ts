import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultNavigation, normalizeNavigation, movePage, openingPage, startupHash } from './navigation.ts';
test('navigation retains custom order and hidden pages, repairs obsolete and duplicate IDs',()=>{
  const prefs=normalizeNavigation({order:['skills','skills','gone','inbox'] as any,hidden:['trash','gone','trash'] as any});
  assert.deepEqual(prefs.order.slice(0,2),['skills','inbox']);assert.equal(new Set(prefs.order).size,defaultNavigation.order.length);assert.deepEqual(prefs.hidden,['trash']);
});
test('moving pages works in both directions and does not mutate saved state',()=>{
  const order=['inbox','skills','tickets'] as const;
  assert.deepEqual(movePage([...order],'inbox','tickets'),['skills','tickets','inbox']);
  assert.deepEqual(movePage([...order],'tickets','inbox'),['tickets','inbox','skills']);
  assert.deepEqual(order,['inbox','skills','tickets']);
});

test('default opening page is validated and does not override explicit routes',()=>{
 assert.equal(openingPage('instructions'),'instructions');assert.equal(openingPage('missing'),'tickets');
 assert.equal(startupHash('', 'projects'),'#/projects');assert.equal(startupHash('#/', 'skills'),'#/skills');
 assert.equal(startupHash('#/ticket/CEN-29','instructions'),'#/ticket/CEN-29');
 assert.equal(startupHash('#/tickets','skills'),'#/tickets');
});
