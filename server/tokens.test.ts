import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { ActivityEvent, CreatedToken, Project, SearchHit, Ticket, TokenInfo, TreeNode } from '../shared/types.ts';
import { rawRequest, startTestServer, type RawResponse, type TestServer } from './testkit.ts';

const PROXIED = { 'X-Forwarded-For': '203.0.113.9' };

/** A remote (proxied) JSON request with a bearer token. */
async function remote<T = unknown>(t: TestServer, token: string, method: string, url: string, body?: unknown): Promise<{ status: number; json: T; res: RawResponse }> {
  const res = await rawRequest(t.port, {
    method,
    path: url,
    headers: { ...PROXIED, Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: (res.body ? JSON.parse(res.body) : undefined) as T, res };
}

async function mcpCall(t: TestServer, token: string, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const res = await rawRequest(t.port, {
    method: 'POST',
    path: '/mcp',
    headers: { ...PROXIED, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  assert.equal(res.status, 200, res.body);
  const result = (JSON.parse(res.body) as { result: { content: { text: string }[]; isError?: boolean } }).result;
  return { isError: result.isError === true, text: result.content[0]?.text ?? '' };
}

describe('named tokens', () => {
  let t: TestServer;
  let alpha: Project;
  let beta: Project;
  const create = async (body: Record<string, unknown>) => {
    const res = await t.api<CreatedToken>('POST', '/api/tokens', body);
    assert.equal(res.status, 201, JSON.stringify(res.json));
    return res.json;
  };

  before(async () => {
    t = await startTestServer();
    alpha = (await t.api<Project>('POST', '/api/projects', { name: 'Alpha', key: 'ALP' })).json;
    beta = (await t.api<Project>('POST', '/api/projects', { name: 'Beta', key: 'BET' })).json;
  });
  after(() => t.close());

  it('the owner token keeps working remotely and may still act as any agent (nothing breaks on upgrade)', async () => {
    const res = await remote<Ticket>(t, t.token, 'POST', '/api/tickets', { title: 'Owner as codex', createdBy: 'codex', project: 'ALP' });
    assert.equal(res.status, 201);
    assert.equal(res.json.createdBy, 'codex');
    const list = (await t.api<TokenInfo[]>('GET', '/api/tokens')).json;
    assert.deepEqual(list.map((x) => x.id), ['owner']);
    assert.equal(list[0]?.owner, true);
  });

  it('creating shows the secret once and stores only its hash, 0600', async () => {
    const created = await create({ label: 'Phone', agent: 'Sam Phone', scopes: ['read', 'write'] });
    assert.match(created.token, /^[0-9a-f]{64}$/);
    assert.equal(created.info.agent, 'sam-phone');
    const file = path.join(t.configDir, 'tokens.json');
    const text = await fs.readFile(file, 'utf8');
    assert.ok(!text.includes(created.token));
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    const listed = (await t.api<Record<string, unknown>[]>('GET', '/api/tokens')).json.find((x) => x.id === created.info.id);
    assert.ok(listed && !('hash' in listed) && !('token' in listed));
    assert.equal((await t.api('POST', '/api/tokens', { label: 'x', agent: 'a', scopes: ['admin'] })).status, 400);
    assert.equal((await t.api('POST', '/api/tokens', { label: 'x', agent: 'a', scopes: ['read'], projects: ['NOPE'] })).status, 400);
  });

  it('a named token is its agent: writes are recorded as it, and claiming anyone else is refused', async () => {
    const { token } = await create({ label: 'Research bot', agent: 'research-bot', scopes: ['read', 'write'] });
    const made = await remote<Ticket>(t, token, 'POST', '/api/tickets', { title: 'Bound create', project: 'ALP' });
    assert.equal(made.status, 201);
    assert.equal(made.json.createdBy, 'research-bot');
    assert.equal((await remote(t, token, 'POST', '/api/tickets', { title: 'Spoof', createdBy: 'codex' })).status, 403);
    assert.equal((await remote(t, token, 'POST', '/api/tickets', { title: 'Same id', createdBy: 'Research Bot' })).status, 201);
    assert.equal((await remote(t, token, 'PATCH', `/api/tickets/${made.json.id}`, { status: 'todo', by: 'codex' })).status, 403);
    assert.equal((await remote(t, token, 'POST', `/api/tickets/${made.json.id}/comments`, { body: 'hi', agent: 'claude-code' })).status, 403);
    assert.equal((await remote(t, token, 'POST', `/api/tickets/${made.json.id}/comments`, { body: 'mine' })).status, 201);
    assert.equal((await remote(t, token, 'PUT', '/api/doc', { path: 'Projects/Alpha/Library/Note.md', body: 'x', agent: 'codex' })).status, 403);
    const events = (await t.api<ActivityEvent[]>('GET', `/api/activity?ticket=${made.json.id}`)).json;
    assert.ok(events.length >= 2 && events.every((e) => e.agent === 'research-bot'));
    // The assignee is not identity: a bound token may still assign work to someone else.
    assert.equal((await remote<Ticket>(t, token, 'POST', '/api/tickets', { title: 'For codex', agent: 'codex' })).json.agent, 'codex');
  });

  it('MCP tools run with the caller token: same identity binding and scopes', async () => {
    const { token } = await create({ label: 'MCP bot', agent: 'mcp-bot', scopes: ['read', 'write'] });
    const spoof = await mcpCall(t, token, 'create_ticket', { agent: 'codex', title: 'Spoofed over MCP' });
    assert.equal(spoof.isError, true);
    assert.match((JSON.parse(spoof.text) as { error: string }).error, /writes as "mcp-bot"/);
    const ok = await mcpCall(t, token, 'create_ticket', { agent: 'mcp-bot', title: 'Over MCP' });
    assert.equal(ok.isError, false, ok.text);
    assert.equal((JSON.parse(ok.text) as Ticket).createdBy, 'mcp-bot');
    const reader = await create({ label: 'Reader', agent: 'reader-bot', scopes: ['read'] });
    assert.equal((await mcpCall(t, reader.token, 'list_projects', {})).isError, false);
    const denied = await mcpCall(t, reader.token, 'create_ticket', { agent: 'reader-bot', title: 'No write scope' });
    assert.equal(denied.isError, true);
    assert.match((JSON.parse(denied.text) as { error: string }).error, /write scope/);
  });

  it('scopes: a read-only token reads and cannot write; only the owner manages tokens or renames agents', async () => {
    const { token } = await create({ label: 'Dashboard', agent: 'dashboard', scopes: ['read'] });
    assert.equal((await remote(t, token, 'GET', '/api/tickets')).status, 200);
    assert.equal((await remote(t, token, 'POST', '/api/tickets', { title: 'nope' })).status, 403);
    const writer = await create({ label: 'Writer', agent: 'writer-bot', scopes: ['write'] });
    assert.deepEqual(writer.info.scopes.sort(), ['read', 'write'], 'write implies read');
    for (const [method, url, body] of [['GET', '/api/tokens', undefined], ['POST', '/api/tokens', { label: 'x', agent: 'y', scopes: ['read'] }], ['DELETE', `/api/tokens/${writer.info.id}`, undefined], ['PATCH', '/api/agents/codex', { name: 'Hacked' }]] as const) {
      assert.equal((await remote(t, writer.token, method, url, body)).status, 403, `${method} ${url}`);
    }
  });

  it('a project-confined token sees and touches only its projects', async () => {
    await t.api('POST', '/api/tickets', { title: 'Beta secret', project: 'BET', body: 'confidential-beta' });
    await t.api('PUT', '/api/doc', { path: `${beta.path}/Library/Plan.md`, body: 'beta plan confidential-beta' });
    const { token } = await create({ label: 'Alpha only', agent: 'alpha-bot', scopes: ['read', 'write'], projects: ['Alpha'] });
    const tickets = (await remote<Ticket[]>(t, token, 'GET', '/api/tickets')).json;
    assert.ok(tickets.length > 0 && tickets.every((x) => x.project === alpha.slug));
    assert.deepEqual((await remote<Project[]>(t, token, 'GET', '/api/projects')).json.map((p) => p.slug), [alpha.slug]);
    assert.equal((await remote(t, token, 'GET', `/api/projects/${beta.slug}`)).status, 403);
    assert.equal((await remote(t, token, 'POST', '/api/tickets', { title: 'Into beta', project: 'BET' })).status, 403);
    assert.equal((await remote(t, token, 'POST', '/api/tickets', { title: 'Into the inbox' })).status, 403);
    assert.equal((await remote(t, token, 'POST', '/api/tickets', { title: 'Into alpha', project: 'ALP' })).status, 201);
    assert.equal((await remote(t, token, 'GET', `/api/doc?path=${encodeURIComponent(`${beta.path}/Library/Plan.md`)}`)).status, 403);
    assert.equal((await remote(t, token, 'GET', `/api/raw/${beta.path}/Library/Plan.md`)).status, 403);
    assert.equal((await remote(t, token, 'PUT', '/api/doc', { path: `${alpha.path}/Library/Ok.md`, body: 'fine' })).status, 200);
    assert.equal((await remote(t, token, 'PUT', '/api/doc', { path: 'Inbox/Loose.md', body: 'no' })).status, 403);
    const hits = (await remote<SearchHit[]>(t, token, 'GET', '/api/search?q=confidential-beta')).json;
    assert.deepEqual(hits, []);
    const tree = (await remote<TreeNode>(t, token, 'GET', '/api/tree')).json;
    assert.deepEqual(tree.children?.map((n) => n.name), ['Projects']);
    assert.deepEqual(tree.children?.[0]?.children?.map((n) => n.name), [alpha.slug]);
    const activity = (await remote<ActivityEvent[]>(t, token, 'GET', '/api/activity')).json;
    assert.ok(activity.every((e) => e.project === alpha.slug));
    for (const url of ['/api/events', '/api/instructions', '/api/skills', '/api/trash']) assert.equal((await remote(t, token, 'GET', url)).status, 403, url);
    assert.equal((await remote(t, token, 'POST', '/api/projects', { name: 'Gamma' })).status, 403);
  });

  it('writes containing a named token are refused like the owner token', async () => {
    const { token } = await create({ label: 'Leaky', agent: 'leaky-bot', scopes: ['read'] });
    const res = await t.api<{ error: string }>('POST', '/api/tickets', { title: 'Leak', body: `token: ${token}` });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /live CENTCOM token/);
  });

  it('revoking ends the token and every browser session it opened', async () => {
    const { token, info } = await create({ label: 'Laptop browser', agent: 'laptop-browser', scopes: ['read', 'write'] });
    const origin = `http://127.0.0.1:${t.port}`;
    const login = await rawRequest(t.port, { method: 'POST', path: '/api/session', headers: { ...PROXIED, Origin: origin }, body: JSON.stringify({ token }) });
    assert.equal(login.status, 201);
    const cookie = (login.headers['set-cookie']?.[0] ?? '').split(';')[0] as string;
    // The session inherits the token's agent.
    const viaCookie = await rawRequest(t.port, { method: 'POST', path: '/api/tickets', headers: { ...PROXIED, Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }, body: '{"title":"From the laptop browser"}' });
    assert.equal(viaCookie.status, 201);
    assert.equal((JSON.parse(viaCookie.body) as Ticket).createdBy, 'laptop-browser');
    const revoked = await t.api<{ sessionsEnded: number }>('DELETE', `/api/tokens/${info.id}`);
    assert.equal(revoked.status, 200);
    assert.equal(revoked.json.sessionsEnded, 1);
    assert.equal((await remote(t, token, 'GET', '/api/tickets')).status, 401);
    const after = await rawRequest(t.port, { path: '/api/tickets', headers: { ...PROXIED, Cookie: cookie } });
    assert.equal(after.status, 401);
    assert.match(after.headers['set-cookie']?.[0] ?? '', /Max-Age=0/);
    assert.equal((await t.api('DELETE', '/api/tokens/owner')).status, 400, 'the owner token is not revocable here');
  });

  it('on trusted loopback a stale bearer still falls back to loopback, but a valid named one binds identity', async () => {
    const stale = await rawRequest(t.port, { path: '/api/tickets', headers: { Authorization: `Bearer ${'0'.repeat(64)}` } });
    assert.equal(stale.status, 200);
    const { token } = await create({ label: 'Local bot', agent: 'local-bot', scopes: ['read', 'write'] });
    const made = await rawRequest(t.port, { method: 'POST', path: '/api/tickets', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{"title":"Local","createdBy":"codex"}' });
    assert.equal(made.status, 403);
  });
});

describe('requireTokenOnLoopback', () => {
  let t: TestServer;
  before(async () => {
    t = await startTestServer({ config: () => ({ requireTokenOnLoopback: true }) });
  });
  after(() => t.close());

  it('loopback clients need a credential; the owner token gets everything, including the loopback-only endpoints', async () => {
    assert.equal((await rawRequest(t.port, { path: '/api/tickets' })).status, 401);
    const owner = { Authorization: `Bearer ${t.token}` };
    assert.equal((await rawRequest(t.port, { path: '/api/tickets', headers: owner })).status, 200);
    assert.equal((await rawRequest(t.port, { path: '/api/connection' })).status, 401);
    assert.equal((await rawRequest(t.port, { path: '/api/connection', headers: owner })).status, 200);
    const named = JSON.parse((await rawRequest(t.port, { method: 'POST', path: '/api/tokens', headers: { ...owner, 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'Local', agent: 'local-bot', scopes: ['read', 'write'] }) })).body) as CreatedToken;
    assert.equal((await rawRequest(t.port, { path: '/api/connection', headers: { Authorization: `Bearer ${named.token}` } })).status, 403);
    assert.equal((await rawRequest(t.port, { path: '/api/connection', headers: { ...owner, ...PROXIED } })).status, 403, 'still never remote');
    assert.equal((await rawRequest(t.port, { path: '/api/tickets', headers: { Authorization: `Bearer ${'0'.repeat(64)}` } })).status, 401, 'no loopback fallback');
  });

  it('a browser on plain-http loopback signs in with the plain session cookie', async () => {
    const origin = `http://127.0.0.1:${t.port}`;
    const login = await rawRequest(t.port, { method: 'POST', path: '/api/session', headers: { Origin: origin }, body: JSON.stringify({ token: t.token }) });
    assert.equal(login.status, 201);
    const cookie = (login.headers['set-cookie']?.[0] ?? '').split(';')[0] as string;
    assert.match(cookie, /^centcom_session=/);
    assert.equal((await rawRequest(t.port, { path: '/api/tickets', headers: { Cookie: cookie } })).status, 200);
  });
});
