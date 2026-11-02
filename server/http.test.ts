import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { ServerInfo, Ticket } from '../shared/types.ts';
import { TOOL_NAMES } from '../mcp/tools.ts';
import { startServer } from './index.ts';
import { openEvents, rawRequest, startTestServer, tempDir, type TestServer } from './testkit.ts';

describe('HTTP security gate (real sockets)', () => {
  let t: TestServer;
  before(async () => {
    t = await startTestServer();
  });
  after(() => t.close());

  it('binds loopback and reports remote:false', async () => {
    const info = (await t.api<ServerInfo>('GET', '/api/info')).json;
    assert.equal(info.name, 'centcom');
    assert.equal(info.host, '127.0.0.1');
    assert.equal(info.remote, false);
    assert.equal(info.port, t.port);
    assert.equal(info.vault, t.vault);
    assert.deepEqual((await t.api('GET', '/api/health')).json, { ok: true });
  });

  it('rejects a foreign Origin with 403 on /api, /mcp and the static shell, for reads and writes', async () => {
    for (const origin of ['https://evil.example', 'http://localhost:3000', `http://127.0.0.1:${t.port + 1}`, 'null']) {
      for (const [method, p] of [['GET', '/api/health'], ['GET', '/api/tickets'], ['POST', '/api/tickets'], ['POST', '/mcp'], ['GET', '/'], ['OPTIONS', '/api/tickets']] as const) {
        const res = await rawRequest(t.port, { method, path: p, headers: { Origin: origin, 'Content-Type': 'application/json' }, body: method === 'POST' ? '{"title":"csrf"}' : undefined });
        assert.equal(res.status, 403, `${method} ${p} from ${origin}`);
        assert.equal(JSON.parse(res.body).code, 'forbidden');
        assert.equal(res.headers['access-control-allow-origin'], undefined);
      }
    }
    assert.deepEqual((await t.api<Ticket[]>('GET', '/api/tickets?q=csrf')).json, [], 'the forged write never happened');
  });

  it('accepts its own origin and the Vite dev origins, echoing them back (never "*")', async () => {
    for (const origin of [`http://127.0.0.1:${t.port}`, `http://localhost:${t.port}`, 'http://localhost:5179', 'http://127.0.0.1:5179']) {
      const res = await rawRequest(t.port, { path: '/api/health', headers: { Origin: origin } });
      assert.equal(res.status, 200, origin);
      assert.equal(res.headers['access-control-allow-origin'], origin);
      assert.equal(res.headers.vary, 'Origin');
    }
    const preflight = await rawRequest(t.port, { method: 'OPTIONS', path: '/api/tickets', headers: { Origin: 'http://localhost:5179', 'Access-Control-Request-Method': 'POST' } });
    assert.equal(preflight.status, 204);
    assert.match(String(preflight.headers['access-control-allow-methods']), /PATCH/);
    const plain = await rawRequest(t.port, { path: '/api/health' });
    assert.equal(plain.status, 200, 'no Origin header (curl, CLI, MCP) passes');
    assert.equal(plain.headers['access-control-allow-origin'], undefined);
  });

  it('rejects a foreign Host header with 403 (DNS rebinding), and accepts loopback names on any port', async () => {
    for (const host of ['evil.example', `evil.example:${t.port}`, '127.0.0.1.evil.example', 'localhost.evil.example:80', '0.0.0.0', '192.168.1.10']) {
      for (const p of ['/api/health', '/mcp', '/', '/api/raw/README.md']) {
        const res = await rawRequest(t.port, { path: p, headers: { Host: host } });
        assert.equal(res.status, 403, `${p} with Host: ${host}`);
      }
    }
    for (const host of [`127.0.0.1:${t.port}`, 'localhost', 'localhost:5179', '[::1]:4747']) {
      assert.equal((await rawRequest(t.port, { path: '/api/health', headers: { Host: host } })).status, 200, host);
    }
  });

  it('connection credentials are never available to proxied clients, even with a valid token', async () => {
    const local = await t.api<{ token: string }>('GET', '/api/connection');
    assert.equal(local.status, 200);
    assert.equal(local.json.token, t.token);
    for (const auth of [undefined, `Bearer ${t.token}`]) {
      const headers: Record<string, string> = { 'X-Forwarded-For': '203.0.113.9' };
      if (auth) headers.Authorization = auth;
      assert.equal((await rawRequest(t.port, { path: '/api/connection', headers })).status, 403);
    }
  });

  it('demands the token as soon as a request is not provably from this machine', async () => {
    const proxied = { 'X-Forwarded-For': '203.0.113.9' };
    assert.equal((await rawRequest(t.port, { path: '/api/tickets', headers: proxied })).status, 401);
    assert.equal((await rawRequest(t.port, { path: '/api/tickets', headers: { ...proxied, Authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await rawRequest(t.port, { path: '/api/tickets', headers: { ...proxied, Authorization: `Bearer ${t.token}` } })).status, 200);
    assert.equal((await rawRequest(t.port, { method: 'POST', path: '/mcp', headers: proxied, body: '{}' })).status, 401);

    // ?token= is gone (browsers use a session cookie), unless legacyQueryToken is set: see below.
    for (const p of [`/api/tickets?token=${t.token}`, `/api/raw/README.md?token=${t.token}`, `/api/events?token=${t.token}`]) {
      assert.equal((await rawRequest(t.port, { path: p, headers: proxied })).status, 401, p);
    }
    assert.equal((await rawRequest(t.port, { method: 'DELETE', path: `/api/doc?path=README.md&token=${t.token}`, headers: proxied })).status, 401);
    await assert.rejects(openEvents(t.port, `/api/events?token=${t.token}`, proxied), /401/);
    await assert.rejects(openEvents(t.port, '/api/events', proxied), /401/);
    assert.equal((await t.api('GET', '/api/doc?path=README.md')).status, 200, 'the rejected DELETE did nothing');
  });

  it('legacyQueryToken brings ?token= back, still only on GET /api/raw/* and /api/events', async () => {
    const legacy = await startTestServer({ config: () => ({ legacyQueryToken: true }) });
    try {
      const proxied = { 'X-Forwarded-For': '203.0.113.9' };
      assert.equal((await rawRequest(legacy.port, { path: `/api/raw/README.md?token=${legacy.token}`, headers: proxied })).status, 200);
      assert.equal((await rawRequest(legacy.port, { path: '/api/raw/README.md?token=nope', headers: proxied })).status, 401);
      assert.equal((await rawRequest(legacy.port, { path: `/api/tickets?token=${legacy.token}`, headers: proxied })).status, 401);
      const events = await openEvents(legacy.port, `/api/events?token=${legacy.token}`, proxied);
      events.close();
    } finally {
      await legacy.close();
    }
  });

  it('unknown API routes are JSON 404s', async () => {
    const res = await t.api<{ code: string }>('GET', '/api/nope');
    assert.equal(res.status, 404);
    assert.equal(res.json.code, 'not_found');
  });
});

describe('MCP over Streamable HTTP', () => {
  let t: TestServer;
  before(async () => {
    t = await startTestServer({ seed: true });
  });
  after(() => t.close());

  const rpc = async (body: unknown) => {
    const res = await fetch(`${t.base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as { result?: Record<string, unknown>; error?: { code: number; message: string } } };
  };
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await rpc({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } });
    const result = res.json.result as { content: { text: string }[]; isError?: boolean };
    return { isError: result.isError === true, text: result.content[0]?.text ?? '' };
  };

  it('answers initialize and lists exactly the documented tools', async () => {
    const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
    assert.equal(init.status, 200);
    assert.equal((init.json.result?.serverInfo as { name: string }).name, 'centcom');
    const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = list.json.result?.tools as { name: string; inputSchema: { required?: string[] } }[];
    assert.deepEqual(tools.map((x) => x.name).sort(), [...TOOL_NAMES].sort());
    for (const mutating of ['create_ticket', 'update_ticket', 'comment_on_ticket', 'write_doc']) {
      assert.ok(tools.find((x) => x.name === mutating)?.inputSchema.required?.includes('agent'), `${mutating} requires agent`);
    }
  });

  it('is stateless: GET and DELETE are 405', async () => {
    assert.equal((await fetch(`${t.base}/mcp`, { headers: { Accept: 'text/event-stream' } })).status, 405);
    assert.equal((await fetch(`${t.base}/mcp`, { method: 'DELETE' })).status, 405);
    assert.equal((await fetch(`${t.base}/mcp`, { method: 'POST', body: '{nope', headers: { 'Content-Type': 'application/json' } })).status, 400);
  });

  it('tools go through the same REST code path: create → update → comment → read back', async () => {
    assert.match((await call('centcom_guide', {})).text, /shared task tracker/);

    const created = JSON.parse((await call('create_ticket', { agent: 'claude-code', title: 'Filed over MCP', project: 'CEN', assignee: 'claude-code', status: 'in_progress', priority: 2 })).text) as Ticket;
    assert.match(created.id, /^CEN-\d+$/);
    assert.equal(created.createdBy, 'claude-code');
    assert.equal(created.agent, 'claude-code');

    const missingAgent = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'create_ticket', arguments: { title: 'anonymous' } } });
    assert.ok(missingAgent.json.error || (missingAgent.json.result as { isError?: boolean }).isError, 'mutations without an agent are refused');

    assert.equal((JSON.parse((await call('update_ticket', { agent: 'claude-code', id: created.id, status: 'done' })).text) as Ticket).status, 'done');
    await call('comment_on_ticket', { agent: 'claude-code', id: created.id, body: 'Shipped.' });
    const detail = JSON.parse((await call('get_ticket', { id: created.id })).text) as { activity: { type: string; agent: string }[] };
    assert.deepEqual(detail.activity.map((e) => `${e.agent}:${e.type}`), ['claude-code:ticket.created', 'claude-code:ticket.updated', 'claude-code:ticket.comment']);

    const listed = JSON.parse((await call('list_tickets', { project: 'CEN', status: ['done'] })).text) as { tickets: { id: string; body?: string }[] };
    assert.deepEqual(listed.tickets.map((x) => x.id), [created.id]);
    assert.equal(listed.tickets[0]?.body, undefined, 'list omits bodies');

    const notFound = await call('get_ticket', { id: 'CEN-9999' });
    assert.equal(notFound.isError, true);
    assert.match(notFound.text, /not_found/);
  });

  it('docs, skills, taste, search and activity tools', async () => {
    await call('write_doc', { agent: 'codex', path: 'Skills/release-notes/SKILL.md', body: '# Release notes\nWrite them plainly.', frontmatter: { name: 'release-notes', description: 'How to write release notes' } });
    await call('write_doc', { agent: 'codex', path: 'Skills/release-notes/references/example.md', body: 'An example.' });
    await call('write_doc', { agent: 'codex', path: 'Taste/Writing/voice.md', body: 'Short sentences. No hype.', frontmatter: { tags: ['voice'] } });

    const skills = JSON.parse((await call('list_skills', {})).text) as { name: string; description: string; scope: string }[];
    assert.deepEqual(skills, [{ name: 'release-notes', description: 'How to write release notes', scope: 'global', path: 'Skills/release-notes/SKILL.md', folder: 'Skills/release-notes' }]);
    const skill = JSON.parse((await call('get_skill', { name: 'Release-Notes' })).text) as { body: string; files: string[] };
    assert.match(skill.body, /Write them plainly/);
    assert.deepEqual(skill.files, ['Skills/release-notes/references/example.md']);

    const taste = JSON.parse((await call('get_taste', { tag: 'voice' })).text) as { docs: { path: string; body: string }[]; images: unknown[] };
    assert.deepEqual(taste.docs.map((d) => [d.path, d.body]), [['Taste/Writing/voice.md', 'Short sentences. No hype.']]);

    const folder = JSON.parse((await call('list_folder', { path: 'Skills/release-notes' })).text) as { children: { name: string }[] };
    assert.deepEqual(folder.children.map((c) => c.name), ['references', 'SKILL.md']);
    assert.equal((JSON.parse((await call('read_doc', { path: 'Taste/Writing/voice.md' })).text) as { body: string }).body, 'Short sentences. No hype.');
    assert.equal((JSON.parse((await call('search', { q: 'hype' })).text) as { path: string }[])[0]?.path, 'Taste/Writing/voice.md');
    assert.ok((JSON.parse((await call('recent_activity', { agent: 'codex', limit: 5 })).text) as unknown[]).length >= 3);
    assert.equal((await call('read_doc', { path: '../outside.md' })).isError, true);
    assert.equal((await call('write_doc', { agent: 'codex', path: '.centcom/agents.json', body: '[]' })).isError, true);
  });
});

describe('live events (SSE) and the watcher', () => {
  let t: TestServer;
  before(async () => {
    t = await startTestServer();
  });
  after(() => t.close());

  it('streams events for API writes', async () => {
    const events = await openEvents(t.port);
    try {
      const ticket = (await t.api<Ticket>('POST', '/api/tickets', { title: 'Watch me', createdBy: 'codex' })).json;
      await events.waitFor((e) => e.type === 'ticket' && e.id === ticket.id);
      await events.waitFor((e) => e.type === 'doc' && e.path === ticket.path);
      await events.waitFor((e) => e.type === 'tree');
      const activity = await events.waitFor((e) => e.type === 'activity');
      assert.equal((activity.event as { type: string; agent: string }).type, 'ticket.created');
      await events.waitFor((e) => e.type === 'agents');
    } finally {
      events.close();
    }
  });

  it('notices files written straight to disk, and attributes them to "filesystem"', async () => {
    const events = await openEvents(t.port);
    try {
      await fs.mkdir(path.join(t.vault, 'Library', 'Dropped'), { recursive: true });
      await fs.writeFile(path.join(t.vault, 'Library', 'Dropped', 'note.md'), '---\ntitle: Dropped in\n---\nvia the filesystem\n');
      const doc = await events.waitFor((e) => e.type === 'doc' && e.path === 'Library/Dropped/note.md');
      assert.equal(typeof doc.mtime, 'number');
      await events.waitFor((e) => e.type === 'tree');
      const activity = await events.waitFor((e) => e.type === 'activity' && (e.event as { path?: string }).path === 'Library/Dropped/note.md');
      assert.deepEqual([(activity.event as { agent: string }).agent, (activity.event as { type: string }).type], ['filesystem', 'doc.created']);
      assert.equal((await t.api<{ title: string }>('GET', '/api/doc?path=Library/Dropped/note.md')).json.title, 'Dropped in');
      assert.equal((await t.api<{ path: string }[]>('GET', '/api/search?q=filesystem')).json[0]?.path, 'Library/Dropped/note.md');

      await fs.rm(path.join(t.vault, 'Library', 'Dropped', 'note.md'));
      await events.waitFor((e) => e.type === 'doc' && e.path === 'Library/Dropped/note.md' && e.deleted === true);
    } finally {
      events.close();
    }
  });

  it('does not echo its own writes back as filesystem activity, and ignores dot-folders', async () => {
    const events = await openEvents(t.port);
    try {
      await t.api('PUT', '/api/doc', { path: 'Library/own-write.md', body: 'by the API', agent: 'codex' });
      await fs.mkdir(path.join(t.vault, '.git'), { recursive: true });
      await fs.writeFile(path.join(t.vault, '.git', 'HEAD'), 'ref: refs/heads/main\n');
      await fs.writeFile(path.join(t.vault, 'Library', 'sentinel.md'), 'marks the end of the window\n');
      await events.waitFor((e) => e.type === 'activity' && (e.event as { path?: string }).path === 'Library/sentinel.md');
      const mine = events.events.filter((e) => e.type === 'activity' && (e.event as { path?: string }).path === 'Library/own-write.md');
      assert.deepEqual(mine.map((e) => (e.event as { agent: string }).agent), ['codex']);
      assert.equal(events.events.filter((e) => e.type === 'doc' && e.path === 'Library/own-write.md').length, 1, 'one doc event, no watcher echo');
      assert.equal(events.events.some((e) => typeof e.path === 'string' && e.path.startsWith('.git')), false);
    } finally {
      events.close();
    }
  });
});

describe('server entry', () => {
  it('serves a built UI with SPA fallback, without shadowing /api, and refuses traversal', async () => {
    const vault = await tempDir('ui-vault');
    const configDir = await tempDir('ui-config');
    const uiDir = await tempDir('ui-dist');
    await fs.writeFile(path.join(vault, 'README.md'), 'x');
    await fs.mkdir(path.join(uiDir, 'assets'));
    await fs.writeFile(path.join(uiDir, 'index.html'), '<!doctype html><title>CENTCOM</title>');
    await fs.writeFile(path.join(uiDir, 'assets', 'app-abc123.js'), 'console.log(1)');
    const server = await startServer({ port: 0, vault, configDir, uiDir, quiet: true });
    try {
      const get = (p: string) => rawRequest(server.info.port, { path: p });
      assert.match((await get('/')).body, /<title>CENTCOM<\/title>/);
      assert.match((await get('/projects/CENTCOM/tickets')).body, /<title>CENTCOM<\/title>/, 'SPA fallback');
      const asset = await get('/assets/app-abc123.js');
      assert.equal(asset.body, 'console.log(1)');
      assert.match(String(asset.headers['content-type']), /javascript/);
      assert.match(String(asset.headers['cache-control']), /immutable/);
      assert.equal((await get('/assets/missing.js')).status, 404);
      // A config created on first run requires a token from local clients too; the shell stays public.
      const config = JSON.parse(await fs.readFile(path.join(configDir, 'config.json'), 'utf8')) as { token: string; requireTokenOnLoopback?: boolean };
      assert.equal(config.requireTokenOnLoopback, true);
      assert.equal((await get('/api/health')).status, 401);
      const authed = (p: string) => rawRequest(server.info.port, { path: p, headers: { Authorization: `Bearer ${config.token}` } });
      assert.equal(JSON.parse((await authed('/api/health')).body).ok, true);
      assert.equal((await authed('/api/unknown')).status, 404);
      assert.doesNotMatch((await get('/%2e%2e/%2e%2e/etc/passwd')).body, /root:/);
      assert.doesNotMatch((await get('/..%2f..%2fREADME.md')).body, /^x$/);
    } finally {
      await server.close();
      for (const dir of [vault, configDir, uiDir]) await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses to start twice on one port with a clear message, and close() frees the port', async () => {
    const t = await startTestServer();
    const vault = await tempDir('second-vault');
    const configDir = await tempDir('second-config');
    await assert.rejects(startServer({ port: t.port, vault, configDir, quiet: true }), /already in use/);
    await t.close();
    const again = await startServer({ port: t.port, vault, configDir, quiet: true });
    assert.equal(again.info.port, t.port);
    await again.close();
    for (const dir of [vault, configDir]) await fs.rm(dir, { recursive: true, force: true });
  });
});
