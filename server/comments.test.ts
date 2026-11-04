import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { ActivityEvent, CreatedToken, ServerInfo, Ticket } from '../shared/types.ts';
import { ActivityLog } from './activity.ts';
import { rawRequest, startTestServer, type TestServer } from './testkit.ts';

type TicketDetail = { ticket: Ticket; activity: ActivityEvent[]; children: Ticket[] };

const PROXIED = { 'X-Forwarded-For': '203.0.113.9' };

/** A remote (proxied) JSON request with a bearer token. */
async function remote<T = unknown>(t: TestServer, token: string, method: string, url: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await rawRequest(t.port, {
    method,
    path: url,
    headers: { ...PROXIED, Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: (res.body ? JSON.parse(res.body) : undefined) as T };
}

async function mcpCall(t: TestServer, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const res = await rawRequest(t.port, {
    method: 'POST',
    path: '/mcp',
    headers: { Authorization: `Bearer ${t.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  assert.equal(res.status, 200, res.body);
  const result = (JSON.parse(res.body) as { result: { content: { text: string }[]; isError?: boolean } }).result;
  return { isError: result.isError === true, text: result.content[0]?.text ?? '' };
}

/** Every line ever written to the activity log, as one string. */
async function activityOnDisk(t: TestServer): Promise<string> {
  const dir = path.join(t.vault, '.centcom', 'activity');
  const files = await fs.readdir(dir);
  return (await Promise.all(files.map((f) => fs.readFile(path.join(dir, f), 'utf8')))).join('\n');
}

describe('editing and deleting comments', () => {
  let t: TestServer;
  let ticket: Ticket;
  const comment = async (body: string, agent = 'codex') => {
    const res = await t.api<ActivityEvent>('POST', `/api/tickets/${ticket.id}/comments`, { body, agent });
    assert.equal(res.status, 201);
    return res.json;
  };
  const thread = async (id = ticket.id) => (await t.api<TicketDetail>('GET', `/api/tickets/${id}`)).json.activity.filter((e) => e.type === 'ticket.comment');

  before(async () => {
    t = await startTestServer();
    await t.api('POST', '/api/projects', { name: 'Alpha', key: 'ALP' });
    await t.api('POST', '/api/projects', { name: 'Beta', key: 'BET' });
    ticket = (await t.api<Ticket>('POST', '/api/tickets', { title: 'Thread', project: 'ALP' })).json;
  });
  after(() => t.close());

  it('edits in place: same id, time and author, new text, who edited it; the old text is gone from disk', async () => {
    const original = await comment('Contact me at leaked@example.invalid');
    const res = await t.api<ActivityEvent>('PATCH', `/api/tickets/${ticket.id}/comments/${original.id}`, { body: '  Contact info@example.invalid  ', agent: 'owner' });
    assert.equal(res.status, 200);
    assert.equal(res.json.id, original.id);
    assert.equal(res.json.ts, original.ts);
    assert.equal(res.json.agent, 'codex');
    assert.equal(res.json.body, 'Contact info@example.invalid');
    assert.equal(res.json.editedBy, 'owner');
    assert.ok((res.json.editedAt ?? 0) >= original.ts);

    const stored = (await thread()).find((e) => e.id === original.id);
    assert.equal(stored?.body, 'Contact info@example.invalid');
    assert.equal(stored?.editedBy, 'owner');
    const disk = await activityOnDisk(t);
    assert.ok(!disk.includes('leaked@example.invalid'), 'the old text is not kept');
    assert.ok(disk.includes('info@example.invalid'));
    // The feed carries the edited event where it was, not a new one.
    const feed = (await t.api<ActivityEvent[]>('GET', `/api/activity?ticket=${ticket.id}`)).json;
    assert.equal(feed.filter((e) => e.id === original.id).length, 1);
  });

  it('deletes to a tombstone: the comment keeps its place, author and time, and its text is erased', async () => {
    const original = await comment('Remove this secret phrase');
    const res = await t.api<{ ok: true }>('DELETE', `/api/tickets/${ticket.id}/comments/${original.id}?by=owner`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { ok: true });

    const stored = (await thread()).find((e) => e.id === original.id);
    assert.equal(stored?.agent, 'codex');
    assert.equal(stored?.ts, original.ts);
    assert.equal(stored?.body, undefined);
    assert.equal(stored?.deletedBy, 'owner');
    assert.ok(!(await activityOnDisk(t)).includes('Remove this secret phrase'));

    assert.equal((await t.api('DELETE', `/api/tickets/${ticket.id}/comments/${original.id}`)).status, 200, 'deleting again is a no-op');
    assert.equal((await t.api('PATCH', `/api/tickets/${ticket.id}/comments/${original.id}`, { body: 'back' })).status, 404, 'a deleted comment cannot be edited');
  });

  it('survives a restart: the rewritten log loads cleanly, with every other line intact', async () => {
    const original = await comment('before restart');
    await t.api('PATCH', `/api/tickets/${ticket.id}/comments/${original.id}`, { body: 'after edit' });
    const warnings: string[] = [];
    const fresh = new ActivityLog(t.vault, (msg) => warnings.push(msg));
    await fresh.load();
    const events = fresh.query({ tickets: [ticket.id], limit: 500 });
    assert.equal(events.find((e) => e.id === original.id)?.body, 'after edit');
    assert.equal(events.length, (await t.api<ActivityEvent[]>('GET', `/api/activity?ticket=${ticket.id}&limit=500`)).json.length);
    assert.deepEqual(warnings, []);
  });

  it('refuses bad input: unknown ids, a comment on another ticket, a non-comment event, an empty body, a live token', async () => {
    const original = await comment('valid');
    const other = (await t.api<Ticket>('POST', '/api/tickets', { title: 'Other', project: 'ALP' })).json;
    assert.equal((await t.api('PATCH', `/api/tickets/${ticket.id}/comments/nope-0000000000`, { body: 'x' })).status, 404);
    assert.equal((await t.api('PATCH', `/api/tickets/${other.id}/comments/${original.id}`, { body: 'x' })).status, 404);
    assert.equal((await t.api('PATCH', `/api/tickets/ALP-999/comments/${original.id}`, { body: 'x' })).status, 404);
    const created = (await t.api<TicketDetail>('GET', `/api/tickets/${other.id}`)).json.activity[0] as ActivityEvent;
    assert.equal((await t.api('PATCH', `/api/tickets/${other.id}/comments/${created.id}`, { body: 'x' })).status, 404, 'only comments can be edited');
    assert.equal((await t.api('DELETE', `/api/tickets/${other.id}/comments/${created.id}`)).status, 404, 'only comments can be deleted');
    assert.equal((await t.api('PATCH', `/api/tickets/${ticket.id}/comments/${original.id}`, { body: '   ' })).status, 400);
    assert.equal((await t.api('PATCH', `/api/tickets/${ticket.id}/comments/${original.id}`, { body: `token ${t.token}` })).status, 400);
    assert.equal((await thread()).find((e) => e.id === original.id)?.body, 'valid');
  });

  it('follows a ticket that moved projects: the comment is found under its new id', async () => {
    const moving = (await t.api<Ticket>('POST', '/api/tickets', { title: 'Mover', project: 'ALP' })).json;
    const original = (await t.api<ActivityEvent>('POST', `/api/tickets/${moving.id}/comments`, { body: 'before the move', agent: 'codex' })).json;
    const moved = (await t.api<Ticket>('PATCH', `/api/tickets/${moving.id}`, { project: 'BET' })).json;
    assert.notEqual(moved.id, moving.id);
    assert.equal((await t.api('PATCH', `/api/tickets/${moved.id}/comments/${original.id}`, { body: 'after the move' })).status, 200);
    assert.equal((await thread(moved.id)).find((e) => e.id === original.id)?.body, 'after the move');
  });

  it('a named token may change only its own comments; the owner may change any', async () => {
    const mint = async (agent: string, projects?: string[]) =>
      (await t.api<CreatedToken>('POST', '/api/tokens', { label: agent, agent, scopes: ['read', 'write'], ...(projects ? { projects } : {}) })).json.token;
    const bot = await mint('comment-bot');
    const other = await mint('other-bot');
    const confined = await mint('comment-bot-beta', ['Beta']);

    const mine = (await remote<ActivityEvent>(t, bot, 'POST', `/api/tickets/${ticket.id}/comments`, { body: 'bot wrote this' })).json;
    const theirs = await comment('codex wrote this');

    assert.equal((await remote(t, bot, 'PATCH', `/api/tickets/${ticket.id}/comments/${mine.id}`, { body: 'bot fixed this' })).status, 200);
    assert.equal((await remote(t, bot, 'PATCH', `/api/tickets/${ticket.id}/comments/${mine.id}`, { body: 'as codex', agent: 'codex' })).status, 403, 'cannot claim another identity');
    assert.equal((await remote(t, other, 'PATCH', `/api/tickets/${ticket.id}/comments/${mine.id}`, { body: 'hijacked' })).status, 403);
    assert.equal((await remote(t, other, 'DELETE', `/api/tickets/${ticket.id}/comments/${mine.id}`)).status, 403);
    assert.equal((await remote(t, bot, 'DELETE', `/api/tickets/${ticket.id}/comments/${theirs.id}`)).status, 403);
    assert.equal((await remote(t, confined, 'PATCH', `/api/tickets/${ticket.id}/comments/${mine.id}`, { body: 'outside my projects' })).status, 403);

    const after = await thread();
    assert.equal(after.find((e) => e.id === mine.id)?.body, 'bot fixed this');
    assert.equal(after.find((e) => e.id === mine.id)?.editedBy, 'comment-bot');
    assert.equal(after.find((e) => e.id === theirs.id)?.body, 'codex wrote this');

    assert.equal((await remote(t, t.token, 'DELETE', `/api/tickets/${ticket.id}/comments/${mine.id}?by=owner`)).status, 200, 'the owner token may delete anyone’s comment');
    assert.equal((await remote(t, bot, 'DELETE', `/api/tickets/${ticket.id}/comments/${mine.id}`)).status, 200, 'already deleted: a no-op for its author too');
  });

  it('/api/info tells each client who it is, so they offer the actions only where they work', async () => {
    const bot = (await t.api<CreatedToken>('POST', '/api/tokens', { label: 'Info', agent: 'info-bot', scopes: ['read'] })).json.token;
    assert.deepEqual((await remote<ServerInfo>(t, bot, 'GET', '/api/info')).json.caller, { agent: 'info-bot', owner: false });
    assert.deepEqual((await remote<ServerInfo>(t, t.token, 'GET', '/api/info')).json.caller, { agent: null, owner: true });
    assert.equal((await remote(t, bot, 'PATCH', `/api/tickets/${ticket.id}/comments/whatever-0000000000`, { body: 'x' })).status, 403, 'read-only tokens cannot write');
  });

  it('MCP edit_comment and delete_comment go through the same code path', async () => {
    const original = await comment('via mcp', 'claude-code');
    const edited = await mcpCall(t, 'edit_comment', { agent: 'claude-code', id: ticket.id, comment: original.id, body: 'edited via mcp' });
    assert.equal(edited.isError, false, edited.text);
    assert.equal((JSON.parse(edited.text) as ActivityEvent).body, 'edited via mcp');
    const deleted = await mcpCall(t, 'delete_comment', { agent: 'claude-code', id: ticket.id, comment: original.id });
    assert.equal(deleted.isError, false, deleted.text);
    assert.equal((await thread()).find((e) => e.id === original.id)?.deletedBy, 'claude-code');
    const missing = await mcpCall(t, 'edit_comment', { agent: 'claude-code', id: ticket.id, comment: 'nope-0000000000', body: 'x' });
    assert.equal(missing.isError, true);
  });
});
