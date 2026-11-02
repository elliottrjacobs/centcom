import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Ticket } from '../../shared/types';
import { compareTasks, matchesTask, EMPTY_FILTERS } from './taskQuery';
import { coerceLabels } from '../../server/model';
const task = (patch: Partial<Ticket> = {}) => ({ id:'CEN-1', title:'Task', body:'Description', status:'todo', priority:0, project:null, agent:null, due:null, labels:[], updated:1, created:1, ...patch }) as Ticket;
test('filters combine and distinguish unassigned, no priority, and inbox', () => {
 const filters = {...EMPTY_FILTERS, agent:'__none', priority:'0', project:'__inbox', labels:['Bug'], due:'overdue'};
 const t = task({labels:['bug'], due:'2026-09-21'});
 assert.equal(matchesTask(t,filters,'2026-09-22'),true);
 for(const change of [{agent:'codex'}, {priority:2 as const}, {project:'BiteMark'}, {labels:[]}, {status:'done' as const}, {due:null}, {due:'2026-09-22'}]) assert.equal(matchesTask({...t,...change},filters,'2026-09-22'),false);
});
test('search finds labels and description, all selected labels must match', () => {
 const t = task({labels:['Bug','iOS'], body:'Fix the capture sheet'});
 assert.ok(matchesTask(t,{...EMPTY_FILTERS,query:' CAPTURE ',labels:['bug','ios']},'2026-09-22'));
 assert.ok(matchesTask(t,{...EMPTY_FILTERS,query:'IOS'},'2026-09-22'));
 assert.equal(matchesTask(t,{...EMPTY_FILTERS,labels:['bug','release']},'2026-09-22'),false);
});
test('due today includes today, missing due sorts last, priority none sorts last', () => {
 const items = [task({id:'CEN-3'}), task({id:'CEN-2',due:'2026-09-23',priority:1}), task({due:'2026-09-22',priority:3})];
 assert.deepEqual([...items].sort((a,b)=>compareTasks('due',a,b)).map(t=>t.id),['CEN-1','CEN-2','CEN-3']);
 assert.deepEqual([...items].sort((a,b)=>compareTasks('priority',a,b)).map(t=>t.id),['CEN-2','CEN-1','CEN-3']);
 assert.equal(items.filter(t=>matchesTask(t,{...EMPTY_FILTERS,due:'today'},'2026-09-22')).length,1);
});
test('sorting supports natural titles, newest created, and recent updates', () => {
 const a=task({title:'Task 10',created:10,updated:2}), b=task({id:'CEN-2',title:'Task 2',created:2,updated:10});
 assert.ok(compareTasks('title',a,b)>0); assert.ok(compareTasks('created',a,b)<0); assert.ok(compareTasks('updated',a,b)>0);
});
test('labels normalize whitespace and case duplicates without losing display names', () => {
 assert.deepEqual(coerceLabels(['  Release   Blocker ', 'release blocker','#bug','Bug','', 'a'.repeat(61), 'a'.repeat(60)]), ['Release Blocker','bug','a'.repeat(60)]);
});
