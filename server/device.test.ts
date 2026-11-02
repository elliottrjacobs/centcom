import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { ActivityLog } from './activity';
import { startTestServer } from './testkit';
import { CentcomClient } from '../mcp/client';
import type { ActivityEvent, Ticket } from '../shared/types';

const exec = promisify(execFile);
test('ticket history keeps actor, assignee and device independent across clients and persistence', async t => {
  const s = await startTestServer(); t.after(()=>s.close());
  const mini = new CentcomClient({baseUrl:s.base, device:'Mac mini'});
  const book = new CentcomClient({baseUrl:s.base, device:'MacBook'});
  const ticket = await mini.createTicket({title:'Separate identity',createdBy:'codex',agent:'claude-code'});
  await book.updateTicket(ticket.id,{status:'in_progress',by:'codex'});
  await mini.comment(ticket.id,'Reviewed on another host','grokbot-stan','Grok host');
  await new CentcomClient({baseUrl:s.base}).comment(ticket.id,'Legacy caller','codex');
  const detail = await book.getTicket(ticket.id);
  assert.equal(detail.ticket.agent,'claude-code');
  assert.equal(detail.ticket.createdBy,'codex');
  assert.deepEqual(detail.activity.map(e=>[e.agent,e.device]), [['codex','Mac mini'],['codex','MacBook'],['grokbot-stan','Grok host'],['codex',undefined]]);
  assert.equal((await mini.agents()).filter(a=>a.id==='codex').length,1);
  const reloaded = new ActivityLog(s.vault,()=>{}); await reloaded.load();
  assert.deepEqual((await reloaded.forTickets([ticket.id])).map(e=>[e.agent,e.device]),detail.activity.map(e=>[e.agent,e.device]));
  assert.equal((await s.api('DELETE',`/api/tickets/${ticket.id}?by=codex&device=MacBook`)).status,200);
  const events = (await s.api<ActivityEvent[]>('GET','/api/activity')).json;
  assert.equal(events.find(e=>e.type==='ticket.deleted')?.device,'MacBook');
});

test('invalid device attribution is rejected before any ticket mutation', async t => {
  const s = await startTestServer(); t.after(()=>s.close());
  const ticket = (await s.api<Ticket>('POST','/api/tickets',{title:'Unchanged'})).json;
  for (const device of ['', ' ', 'Mac\nmini', 'x'.repeat(101), {}, null]) {
    assert.equal((await s.api('POST','/api/tickets',{title:'Invalid',device})).status,400);
    assert.equal((await s.api('PATCH',`/api/tickets/${ticket.id}`,{title:'Invalid',device})).status,400);
    assert.equal((await s.api('POST',`/api/tickets/${ticket.id}/comments`,{body:'Invalid',agent:'codex',device})).status,400);
  }
  const detail = await new CentcomClient({baseUrl:s.base}).getTicket(ticket.id);
  assert.equal(detail.ticket.title,'Unchanged'); assert.equal(detail.activity.length,1); assert.equal(detail.activity[0]!.device,undefined);
});

test('MCP forwards each caller device and never defaults to the server location', async t => {
  const s = await startTestServer(); t.after(()=>s.close());
  const call = async (name:string,args:Record<string,unknown>) => {
    const response = await fetch(`${s.base}/mcp`, {method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});
    const rpc = await response.json() as { result: {isError?:boolean;content:{text:string}[]} };
    assert.equal(rpc.result.isError,undefined);
    return JSON.parse(rpc.result.content[0]!.text);
  };
  const ticket = await call('create_ticket',{title:'MCP attribution',agent:'grokbot-stan',assignee:'grokbot-stan',device:'Grok host'});
  await call('update_ticket',{id:ticket.id,agent:'grokbot-stan',status:'in_progress',device:'Mac mini'});
  await call('comment_on_ticket',{id:ticket.id,agent:'claude-code',body:'Review',device:'MacBook'});
  await call('comment_on_ticket',{id:ticket.id,agent:'codex',body:'Unknown host'});
  const detail = await call('get_ticket',{id:ticket.id});
  assert.deepEqual(detail.activity.map((e:ActivityEvent)=>e.device),['Grok host','Mac mini','MacBook',undefined]);
});

test('CLI device flag overrides the environment; absent configuration uses the actual caller hostname', async t => {
  const s = await startTestServer(); t.after(()=>s.close());
  const run = async (args:string[], device='MacBook') => {
    const {stdout} = await exec(process.execPath,['--import','tsx',path.resolve('cli/centcom.ts'),...args,'--json'],{env:{...process.env,CENTCOM_URL:s.base,CENTCOM_TOKEN:s.token,CENTCOM_DEVICE:device}});
    return JSON.parse(stdout);
  };
  const ticket = await run(['ticket','create','--title','CLI attribution','--as','codex','--device','Mac mini']);
  await run(['ticket','comment',ticket.id,'--body','From my laptop','--as','codex']);
  await run(['ticket','comment',ticket.id,'--body','Default hostname','--as','grokbot-stan'],'');
  const detail = await new CentcomClient({baseUrl:s.base}).getTicket(ticket.id);
  assert.deepEqual(detail.activity.map(e=>e.device),['Mac mini','MacBook',os.hostname()]);
});
