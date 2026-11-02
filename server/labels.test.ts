import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './testkit';
import type { ProjectLabel, Ticket } from '../shared/types';
test('project label catalog persists, scopes edits, and prevents stale drafts resurrecting deleted names', async () => {
 const s=await startTestServer();try {
  for(const [name,key] of [['Alpha','ALP'],['Beta','BET']]) assert.equal((await s.api('POST','/api/projects',{name,key})).status,201);
  const a=(await s.api<Ticket>('POST','/api/tickets',{project:'Alpha',title:'A',labels:['GTM']})).json;
  const b=(await s.api<Ticket>('POST','/api/tickets',{project:'Beta',title:'B',labels:['GTM']})).json;
  const all=(await s.api<ProjectLabel[]>('GET','/api/labels')).json;
  assert.equal(all.filter(l=>l.name==='GTM').length,2);
  const label=all.find(l=>l.project==='Alpha')!;
  assert.equal((await s.api('PATCH',`/api/labels/${label.id}`,{project:'Alpha',name:'Growth',color:'#14b8a6'})).status,200);
  assert.deepEqual((await s.api<{ticket:Ticket}>('GET',`/api/tickets/${a.id}`)).json.ticket.labels,['Growth']);
  assert.deepEqual((await s.api<{ticket:Ticket}>('GET',`/api/tickets/${b.id}`)).json.ticket.labels,['GTM']);
  assert.deepEqual((await s.api<Ticket>('PATCH',`/api/tickets/${a.id}`,{labels:['GTM']})).json.labels,['Growth']);
  assert.equal((await s.api('PATCH',`/api/labels/${label.id}`,{project:'Alpha',deleted:true})).status,200);
  assert.deepEqual((await s.api<Ticket>('PATCH',`/api/tickets/${a.id}`,{labels:['GTM','Growth']})).json.labels,[]);
  assert.equal((await s.api('PATCH',`/api/labels/${label.id}`,{project:'Alpha',deleted:false})).status,200);
  assert.equal((await s.api('POST','/api/labels',{project:'Alpha',name:'growth'})).status,409);
  assert.equal((await s.api('PATCH',`/api/labels/${label.id}`,{project:'Beta',name:'Wrong'})).status,404);
  const orphan=(await s.api<ProjectLabel>('POST','/api/labels',{project:'Beta',name:'No tasks yet',color:'#ff0000'})).json;
  assert.ok((await s.api<ProjectLabel[]>('GET','/api/labels')).json.some(l=>l.id===orphan.id));
 }finally{await s.close();}
});
