import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { AgentDeliverable, AgentHome, AgentProfile, ApiError } from '../shared/types.ts';
import { openEvents, startTestServer, type TestServer } from './testkit.ts';

type Upserted = { profile: AgentProfile; changed: boolean };

describe('agent home', () => {
  let t: TestServer;
  before(async () => {
    t = await startTestServer();
    await t.api('POST', '/api/projects', { name: 'CENTCOM', key: 'CEN', agent: 'owner' });
  });
  after(() => t.close());

  it('gathers the agent, its profile, its deliverables and only its own activity, newest first', async () => {
    await t.api('PUT', '/api/agents/codex/profile', { description: 'Codex CLI.', instructions: 'Use worktrees.' });
    const ticket = (await t.api<{ id: string }>('POST', '/api/tickets', { title: 'Ship it', project: 'CEN', createdBy: 'codex' })).json;
    await t.api('POST', `/api/tickets/${ticket.id}/comments`, { body: 'On it.', agent: 'codex' });
    await t.api('POST', `/api/tickets/${ticket.id}/comments`, { body: 'Not me.', agent: 'claude-code' });
    await t.api('PUT', '/api/doc', { path: 'Projects/CENTCOM/Library/Notes.md', body: 'notes', agent: 'codex' });
    await t.api('POST', '/api/agents/codex/deliverables', { title: 'PR', url: 'https://github.com/o/r/pull/1', kind: 'pr' });

    const home = await t.api<AgentHome>('GET', '/api/agents/codex/home');
    assert.equal(home.status, 200);
    assert.equal(home.json.agent.id, 'codex');
    assert.equal(home.json.agent.name, 'Codex');
    assert.equal(home.json.profile?.description, 'Codex CLI.');
    assert.deepEqual(home.json.deliverables.map((d) => d.title), ['PR']);
    assert.ok(home.json.activity.every((e) => e.agent === 'codex'));
    const types = home.json.activity.map((e) => `${e.type} ${e.path}`);
    assert.ok(types.indexOf('doc.created Projects/CENTCOM/Library/Notes.md') < types.indexOf(`ticket.comment Projects/CENTCOM/Tickets/${ticket.id}.md`));
    assert.ok(types.includes(`ticket.created Projects/CENTCOM/Tickets/${ticket.id}.md`));

    const limited = await t.api<AgentHome>('GET', '/api/agents/codex/home?limit=1');
    assert.equal(limited.json.activity.length, 1);
    assert.equal((await t.api('GET', '/api/agents/codex/home?limit=0')).status, 400);
  });

  it('an agent on the roster with no profile still has a home', async () => {
    const home = await t.api<AgentHome>('GET', '/api/agents/cursor/home');
    assert.equal(home.status, 200);
    assert.equal(home.json.profile, null);
    assert.deepEqual(home.json.deliverables, []);
  });

  it('a hand-written profile for an agent nobody registered is enough for a home; neither is a 404', async () => {
    await fs.mkdir(path.join(t.vault, 'Agents'), { recursive: true });
    await fs.writeFile(path.join(t.vault, 'Agents/hand-made.md'), '---\nname: Hand Made\n---\nJust a description.\n');
    const home = await t.api<AgentHome>('GET', '/api/agents/hand-made/home');
    assert.equal(home.status, 200);
    assert.equal(home.json.agent.name, 'Hand Made');
    assert.equal(home.json.profile?.description, 'Just a description.');
    assert.equal((await t.api('GET', '/api/agents/no-such-agent/home')).status, 404);
  });

  it('tells listeners when a home changes', async () => {
    const events = await openEvents(t.port);
    try {
      await t.api('PUT', '/api/agents/grok/profile', { description: 'Grok.', instructions: '' });
      await events.waitFor((e) => e.type === 'agent' && e.id === 'grok');
    } finally {
      events.close();
    }
  });
});

describe('agent profile summaries', () => {
  let t: TestServer;
  before(async () => {
    t = await startTestServer();
  });
  after(() => t.close());

  it('lists every published profile, without instructions, skills or deliverables, by id', async () => {
    assert.deepEqual((await t.api('GET', '/api/agent-profiles')).json, [], 'none before anyone publishes');
    await t.api('PUT', '/api/agents/codex/profile', { description: 'Codex CLI.', instructions: 'Long rules.', skills: [{ name: 'tdd', description: 'x' }] });
    await t.api('PUT', '/api/agents/grokbot-stan/profile', { name: 'Stan', description: 'General assistant.', instructions: '', source: 'grokbot-sync', agent: 'grokbot-stan' });
    await fs.writeFile(path.join(t.vault, 'Agents/README.txt'), 'not a profile');
    await fs.writeFile(path.join(t.vault, 'Agents/Bad Name!.md'), 'not an agent id');

    const list = await t.api<Array<Record<string, unknown>>>('GET', '/api/agent-profiles');
    assert.equal(list.status, 200);
    assert.deepEqual(
      list.json.map(({ updated, ...rest }) => (assert.equal(typeof updated, 'number'), rest)),
      [
        { id: 'codex', name: 'Codex', source: 'self-reported', description: 'Codex CLI.', updatedBy: 'codex' },
        { id: 'grokbot-stan', name: 'Stan', source: 'grokbot-sync', description: 'General assistant.', updatedBy: 'grokbot-stan' },
      ],
    );
  });
});

describe('agent homes over MCP', () => {
  let t: TestServer;
  before(async () => {
    t = await startTestServer();
  });
  after(() => t.close());

  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await fetch(`${t.base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    const payload = (await res.json()) as { result?: { content: { text: string }[]; isError?: boolean }; error?: unknown };
    return { isError: payload.error !== undefined || payload.result?.isError === true, text: payload.result?.content[0]?.text ?? '' };
  };

  it('an agent publishes its profile and a deliverable, then reads its home', async () => {
    const upsert = await call('agent_profile_upsert', { agent: 'claude-code', description: 'Terminal coder.', instructions: 'Tests first.', skills: [{ name: 'tdd', description: 'Red, green.' }] });
    assert.equal(upsert.isError, false, upsert.text);
    assert.equal((JSON.parse(upsert.text) as Upserted).changed, true);

    const added = await call('agent_deliverable_add', { agent: 'claude-code', title: 'PR 9', url: 'https://github.com/o/r/pull/9', kind: 'pr' });
    assert.equal(added.isError, false, added.text);

    const home = await call('agent_home', { id: 'claude-code' });
    assert.equal(home.isError, false, home.text);
    const parsed = JSON.parse(home.text) as AgentHome;
    assert.equal(parsed.profile?.instructions, 'Tests first.');
    assert.deepEqual(parsed.deliverables.map((d) => d.title), ['PR 9']);
    assert.equal((await call('agent_profile_upsert', { description: '', instructions: '' })).isError, true, 'agent is required');
  });
});

describe('agent deliverables', () => {
  let t: TestServer;
  before(async () => {
    t = await startTestServer();
    await t.api('POST', '/api/projects', { name: 'CENTCOM', key: 'CEN' });
  });
  after(() => t.close());

  const today = (): string => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  it('reporting a deliverable creates the profile when there is none, and it shows up on it', async () => {
    const res = await t.api<AgentDeliverable>('POST', '/api/agents/codex/deliverables', { title: 'Agent homes API', url: 'https://github.com/o/r/pull/7', kind: 'pr', project: 'CEN', note: 'Server side.' });
    assert.equal(res.status, 201);
    assert.equal(res.json.title, 'Agent homes API');
    assert.equal(res.json.kind, 'pr');
    assert.equal(res.json.date, today());
    assert.equal(res.json.project, 'CENTCOM');
    assert.equal(res.json.addedBy, 'codex');

    const profile = (await t.api<AgentProfile>('GET', '/api/agents/codex/profile')).json;
    assert.equal(profile.source, 'self-reported');
    assert.equal(profile.description, '');
    assert.deepEqual(profile.deliverables, [res.json]);
  });

  it('the same url again updates that entry instead of adding a second one', async () => {
    const first = await t.api<AgentDeliverable>('POST', '/api/agents/codex/deliverables', { title: 'Old title', url: 'https://example.com/report', kind: 'link', date: '2026-10-01' });
    const second = await t.api<AgentDeliverable>('POST', '/api/agents/codex/deliverables', { title: 'New title', url: 'https://example.com/report', kind: 'doc', date: '2026-10-02', agent: 'claude-code' });
    assert.equal(second.status, 200);
    assert.equal(second.json.id, first.json.id);
    const profile = (await t.api<AgentProfile>('GET', '/api/agents/codex/profile')).json;
    const matching = profile.deliverables.filter((d) => d.url === 'https://example.com/report');
    assert.equal(matching.length, 1);
    assert.equal(matching[0]?.title, 'New title');
    assert.equal(matching[0]?.kind, 'doc');
    assert.equal(matching[0]?.addedBy, 'claude-code');
  });

  it('newest first, and deleting one removes only it', async () => {
    await t.api('POST', '/api/agents/dot/deliverables', { title: 'Older', url: 'https://example.com/a', kind: 'link', date: '2026-01-01' });
    const newer = await t.api<AgentDeliverable>('POST', '/api/agents/dot/deliverables', { title: 'Newer', url: 'https://example.com/b', kind: 'link', date: '2026-02-01' });
    let profile = (await t.api<AgentProfile>('GET', '/api/agents/dot/profile')).json;
    assert.deepEqual(profile.deliverables.map((d) => d.title), ['Newer', 'Older']);

    const del = await t.api('DELETE', `/api/agents/dot/deliverables/${newer.json.id}`);
    assert.equal(del.status, 200);
    profile = (await t.api<AgentProfile>('GET', '/api/agents/dot/profile')).json;
    assert.deepEqual(profile.deliverables.map((d) => d.title), ['Older']);
    assert.equal((await t.api('DELETE', `/api/agents/dot/deliverables/${newer.json.id}`)).status, 404);
  });

  it('a vault path is a valid url for a CENTCOM doc', async () => {
    const res = await t.api<AgentDeliverable>('POST', '/api/agents/codex/deliverables', { title: 'Runbook', url: 'Projects/CENTCOM/Library/Runbook.md', kind: 'doc' });
    assert.equal(res.status, 201);
    assert.equal(res.json.url, 'Projects/CENTCOM/Library/Runbook.md');
  });

  it('refuses script URLs, other schemes, bad dates, unknown projects and kinds', async () => {
    const post = (b: Record<string, unknown>) => t.api<ApiError>('POST', '/api/agents/codex/deliverables', { title: 'x', kind: 'link', url: 'https://example.com/x', ...b });
    assert.equal((await post({ url: 'javascript:alert(1)' })).status, 400);
    assert.equal((await post({ url: 'ftp://example.com/file' })).status, 400);
    assert.equal((await post({ url: 'https://user:pw@example.com/' })).status, 400);
    assert.equal((await post({ url: '../outside.md' })).status, 403);
    assert.equal((await post({ date: '22/10/2026' })).status, 400);
    assert.equal((await post({ project: 'NOPE' })).status, 400);
    assert.equal((await post({ kind: 'video' })).status, 400);
    assert.equal((await post({ title: '' })).status, 400);
  });
});

describe('agent profiles', () => {
  let t: TestServer;
  before(async () => {
    t = await startTestServer();
  });
  after(() => t.close());

  it('a profile PUT by an agent is what GET returns', async () => {
    const put = await t.api<Upserted>('PUT', '/api/agents/claude-code/profile', {
      description: 'Writes code in the terminal.',
      instructions: 'Always run the tests.\n\n- Never push to main.',
      skills: [{ name: 'tdd', description: 'Red, green.' }],
    });
    assert.equal(put.status, 200);
    assert.equal(put.json.changed, true);

    const got = await t.api<AgentProfile>('GET', '/api/agents/claude-code/profile');
    assert.equal(got.status, 200);
    assert.equal(got.json.id, 'claude-code');
    assert.equal(got.json.name, 'Claude Code');
    assert.equal(got.json.source, 'self-reported');
    assert.equal(got.json.description, 'Writes code in the terminal.');
    assert.equal(got.json.instructions, 'Always run the tests.\n\n- Never push to main.');
    assert.deepEqual(got.json.skills, [{ name: 'tdd', description: 'Red, green.' }]);
    assert.deepEqual(got.json.deliverables, []);
    assert.equal(got.json.updatedBy, 'claude-code');
    assert.equal(got.json.path, 'Agents/claude-code.md');
  });

  it('PUTting the same profile again changes nothing: no rewrite, `updated` stays put', async () => {
    const input = { name: 'Stan', description: 'General assistant.', instructions: '', skills: [{ name: 'errands', description: 'Runs them.' }], source: 'grokbot-sync', agent: 'grokbot-stan' };
    const first = await t.api<Upserted>('PUT', '/api/agents/grokbot-stan/profile', input);
    assert.equal(first.json.changed, true);
    const file = path.join(t.vault, 'Agents/grokbot-stan.md');
    const before = await fs.readFile(file, 'utf8');
    const mtime = (await fs.stat(file)).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));

    const again = await t.api<Upserted>('PUT', '/api/agents/grokbot-stan/profile', input);
    assert.equal(again.status, 200);
    assert.equal(again.json.changed, false);
    assert.equal(again.json.profile.updated, first.json.profile.updated);
    assert.equal(await fs.readFile(file, 'utf8'), before);
    assert.equal((await fs.stat(file)).mtimeMs, mtime);

    const edited = await t.api<Upserted>('PUT', '/api/agents/grokbot-stan/profile', { ...input, description: 'General assistant. Sets things up.' });
    assert.equal(edited.json.changed, true);
    assert.ok(edited.json.profile.updated > first.json.profile.updated);
  });

  it('stores a readable markdown file with Description and Instructions sections', async () => {
    await t.api('PUT', '/api/agents/codex/profile', { description: 'Codex CLI.', instructions: 'Work in a worktree.', skills: [], agent: 'codex' });
    const raw = await fs.readFile(path.join(t.vault, 'Agents/codex.md'), 'utf8');
    assert.match(raw, /^---\nid: codex\nname: Codex\nsource: self-reported\nupdated: '?\d{4}-\d\d-\d\dT[^\n]+\nupdated_by: codex\nskills: \[\]\ndeliverables: \[\]\n---\n/);
    assert.ok(raw.endsWith('---\n## Description\n\nCodex CLI.\n\n## Instructions and rules\n\nWork in a worktree.\n'), raw);
  });

  it('reads a hand-edited file liberally', async () => {
    await fs.mkdir(path.join(t.vault, 'Agents'), { recursive: true });
    await fs.writeFile(
      path.join(t.vault, 'Agents/dot.md'),
      '---\nname: Dot\nskills:\n  - summarise\n  - name: plan\n    description: Plans the day\n  - 42\n---\n# Dot\n\n## Description\nOpenAI’s assistant.\n\n## Instructions & rules\n\n### Tone\nBrief.\n\n## Rules\nStill instructions.\n',
    );
    const got = await t.api<AgentProfile>('GET', '/api/agents/dot/profile');
    assert.equal(got.status, 200);
    assert.equal(got.json.name, 'Dot');
    assert.equal(got.json.source, 'self-reported');
    assert.equal(got.json.description, 'OpenAI’s assistant.');
    assert.equal(got.json.instructions, '### Tone\nBrief.\n\n## Rules\nStill instructions.');
    assert.deepEqual(got.json.skills, [
      { name: 'summarise', description: '' },
      { name: 'plan', description: 'Plans the day' },
    ]);
  });

  it('a profile for an unknown agent registers it, and `name` becomes its registry name', async () => {
    const put = await t.api<Upserted>('PUT', '/api/agents/Security%20Watch/profile', { name: 'Security Watch', description: 'Monitors.', instructions: '', agent: 'grokbot-stan' });
    assert.equal(put.status, 200);
    assert.equal(put.json.profile.id, 'security-watch');
    const agents = (await t.api<{ id: string; name: string; lastSeen: number | null }[]>('GET', '/api/agents')).json;
    assert.equal(agents.find((a) => a.id === 'security-watch')?.name, 'Security Watch');
    assert.equal(agents.find((a) => a.id === 'security-watch')?.lastSeen, null, 'written about, not seen');
    assert.ok(agents.find((a) => a.id === 'grokbot-stan')?.lastSeen, 'the writer was seen');
  });

  it('404 for an agent with no profile; 400 for bodies past the limits', async () => {
    assert.equal((await t.api('GET', '/api/agents/nobody/profile')).status, 404);
    assert.equal((await t.api('PUT', '/api/agents/codex/profile', { description: 'x'.repeat(4001), instructions: '' })).status, 400);
    assert.equal((await t.api('PUT', '/api/agents/codex/profile', { description: '', instructions: '', skills: [{ name: '', description: '' }] })).status, 400);
    assert.equal((await t.api('PUT', '/api/agents/codex/profile', { instructions: '' })).status, 400, 'description is required');
  });
});
