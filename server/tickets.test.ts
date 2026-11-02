import assert from 'node:assert/strict';
import { promises as fs, type Stats } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { ActivityEvent, ApiError, Project, Ticket } from '../shared/types.ts';
import { parseTicketFile, serializeTicket } from './model.ts';
import { sleep, startTestServer, type TestServer } from './testkit.ts';

type TicketDetail = { ticket: Ticket & { previousIds: string[] }; activity: ActivityEvent[]; children: Ticket[] };

const numberOf = (id: string): number => Number(id.split('-')[1]);

describe('ticket id allocation', () => {
  let t: TestServer;
  before(async () => {
    t = await startTestServer();
    assert.equal((await t.api('POST', '/api/projects', { name: 'Alpha', key: 'ALP' })).status, 201);
  });
  after(() => t.close());

  it('allocates sequentially per key and writes KEY-n.md under the project', async () => {
    const a = await t.api<Ticket>('POST', '/api/tickets', { title: 'First', project: 'Alpha' });
    const b = await t.api<Ticket>('POST', '/api/tickets', { title: 'Second', project: 'ALP' });
    const inbox = await t.api<Ticket>('POST', '/api/tickets', { title: 'No project' });
    assert.equal(a.status, 201);
    assert.equal(a.json.id, 'ALP-1');
    assert.equal(a.json.path, 'Projects/Alpha/Tickets/ALP-1.md');
    assert.equal(b.json.id, 'ALP-2');
    assert.equal(inbox.json.id, 'INB-1');
    assert.equal(inbox.json.path, 'Inbox/INB-1.md');
    assert.equal(inbox.json.project, null);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(t.vault, '.centcom', 'counters.json'), 'utf8')), { ALP: 2, INB: 1 });
  });

  it('never reuses a number after the highest ticket is deleted', async () => {
    const c = await t.api<Ticket>('POST', '/api/tickets', { title: 'Third', project: 'Alpha' });
    assert.equal(c.json.id, 'ALP-3');
    assert.equal((await t.api('DELETE', '/api/tickets/ALP-3?by=codex')).status, 200);
    const d = await t.api<Ticket>('POST', '/api/tickets', { title: 'Fourth', project: 'Alpha' });
    assert.equal(d.json.id, 'ALP-4');
  });

  it('never reuses a number even if counters.json is lost (falls back to disk + trash)', async () => {
    await t.api('DELETE', '/api/tickets/ALP-4');
    await fs.rm(path.join(t.vault, '.centcom', 'counters.json'));
    const e = await t.api<Ticket>('POST', '/api/tickets', { title: 'Fifth', project: 'Alpha' });
    assert.equal(e.json.id, 'ALP-5');
  });

  it('survives a corrupt counters.json', async () => {
    await fs.writeFile(path.join(t.vault, '.centcom', 'counters.json'), '{ this is not json');
    const f = await t.api<Ticket>('POST', '/api/tickets', { title: 'Sixth', project: 'Alpha' });
    assert.equal(f.json.id, 'ALP-6');
  });

  it('jumps past a higher number that someone wrote by hand', async () => {
    await fs.writeFile(path.join(t.vault, 'Projects/Alpha/Tickets/ALP-40.md'), '# Hand-written forty\n');
    const g = await t.api<Ticket>('POST', '/api/tickets', { title: 'After forty', project: 'Alpha' });
    assert.equal(g.json.id, 'ALP-41');
  });

  it('is safe under concurrent creates: unique, contiguous, all on disk', async () => {
    const before = numberOf((await t.api<Ticket>('POST', '/api/tickets', { title: 'Marker', project: 'Alpha' })).json.id);
    const N = 40;
    const results = await Promise.all(Array.from({ length: N }, (_, i) => t.api<Ticket>('POST', '/api/tickets', { title: `Concurrent ${i}`, project: 'Alpha', createdBy: `agent-${i % 4}` })));
    assert.ok(results.every((r) => r.status === 201), 'every create succeeded');
    const numbers = results.map((r) => numberOf(r.json.id)).sort((x, y) => x - y);
    assert.equal(new Set(numbers).size, N, 'ids are unique');
    assert.deepEqual(numbers, Array.from({ length: N }, (_, i) => before + 1 + i), 'ids are contiguous');
    for (const r of results) {
      const raw = await fs.readFile(path.join(t.vault, r.json.path), 'utf8');
      assert.match(raw, new RegExp(`^---\\nid: ${r.json.id}\\n`));
    }
    const counters = JSON.parse(await fs.readFile(path.join(t.vault, '.centcom', 'counters.json'), 'utf8')) as Record<string, number>;
    assert.equal(counters.ALP, before + N);
    const listed = await t.api<Ticket[]>('GET', '/api/tickets?project=Alpha&q=Concurrent');
    assert.equal(listed.json.length, N);
  });

  it('concurrent creates across different keys do not corrupt each other', async () => {
    await t.api('POST', '/api/projects', { name: 'Beta', key: 'BET' });
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => t.api<Ticket>('POST', '/api/tickets', { title: `Mixed ${i}`, project: i % 2 === 0 ? 'Beta' : null })));
    const beta = results.filter((r) => r.json.id.startsWith('BET-')).map((r) => numberOf(r.json.id)).sort((x, y) => x - y);
    assert.deepEqual(beta, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.equal(new Set(results.map((r) => r.json.id)).size, 20);
  });
});

describe('liberal parsing of hand-written ticket files', () => {
  const stat = { mtimeMs: 1_700_000_000_000, birthtimeMs: 1_600_000_000_000 } as Stats;

  it('fills defaults: status backlog, priority 0, id from filename, title from first H1', () => {
    const r = parseTicketFile('Projects/X/Tickets/CEN-7.md', '# Fix the login loop\n\nIt loops.\n', stat, 'X');
    assert.equal(r.id, 'CEN-7');
    assert.equal(r.title, 'Fix the login loop');
    assert.equal(r.status, 'backlog');
    assert.equal(r.priority, 0);
    assert.equal(r.agent, null);
    assert.deepEqual(r.labels, []);
    assert.equal(r.due, null);
    assert.equal(r.parent, null);
    assert.equal(r.project, 'X');
    assert.equal(r.created, 1_600_000_000_000);
    assert.equal(r.updated, 1_700_000_000_000);
  });

  it('falls back to the filename for the title, and to the bare filename for the id', () => {
    const r = parseTicketFile('Inbox/call the accountant.md', 'no heading here', stat, null);
    assert.equal(r.id, 'call the accountant');
    assert.equal(r.title, 'call the accountant');
  });

  it('understands sloppy values', () => {
    const raw = ['---', 'title: Sloppy', 'status: In Progress', 'priority: high', 'assignee: Claude Code', 'tags: bug, ui , bug', 'due: 2026-10-01', 'created: 2026-09-01', 'parent: cen-3', 'mood: optimistic', '---', 'Body'].join('\n');
    const r = parseTicketFile('Projects/X/Tickets/cen-12.md', raw, stat, 'X');
    assert.equal(r.id, 'CEN-12');
    assert.equal(r.status, 'in_progress');
    assert.equal(r.priority, 2);
    assert.equal(r.agent, 'claude-code');
    assert.deepEqual(r.labels, ['bug', 'ui']);
    assert.equal(r.due, '2026-10-01');
    assert.equal(r.parent, 'CEN-3');
    assert.equal(r.created, Date.parse('2026-09-01T00:00:00Z'));
    assert.deepEqual(r.extra, { mood: 'optimistic' });
    assert.equal(r.body, 'Body');
  });

  it('maps unknown or wrongly typed values to defaults instead of throwing', () => {
    const raw = ['---', 'status: 17', 'priority: 99', 'agent: [a, b]', 'labels: 5', 'due: next tuesday', 'created: soon', 'previous_ids: nope', '---', ''].join('\n');
    const r = parseTicketFile('Inbox/INB-2.md', raw, stat, null);
    assert.equal(r.status, 'backlog');
    assert.equal(r.priority, 0);
    assert.equal(r.agent, null);
    assert.deepEqual(r.labels, []);
    assert.equal(r.due, null);
    assert.equal(r.created, 1_600_000_000_000);
  });

  it('keeps the whole file as the body when the YAML is broken, so nothing is lost', () => {
    const raw = '---\ntitle: [unclosed\nstatus: todo\n---\n# Real title\n';
    const r = parseTicketFile('Inbox/INB-3.md', raw, stat, null);
    assert.equal(r.id, 'INB-3');
    assert.equal(r.title, 'Real title');
    assert.equal(r.status, 'backlog');
    assert.equal(`${r.body}\n`, raw);
  });

  it('prefers the filename over a conflicting frontmatter id', () => {
    const r = parseTicketFile('Inbox/INB-9.md', '---\nid: CEN-1\n---\n', stat, null);
    assert.equal(r.id, 'INB-9');
  });

  it('writes the documented canonical form and round-trips it', () => {
    const r = parseTicketFile('Projects/X/Tickets/CEN-12.md', '---\ntitle: "Round: trip"\nlabels: [import, vault]\nmood: fine\n---\nBody\n', stat, 'X');
    const out = serializeTicket({ ...r, created: Date.parse('2026-09-19T20:00:00.000Z'), updated: Date.parse('2026-09-19T20:00:00.000Z') });
    assert.equal(
      out,
      [
        '---',
        'id: CEN-12',
        "title: 'Round: trip'",
        'status: backlog',
        'priority: 0',
        'agent: null',
        'created_by: filesystem',
        'labels: [import, vault]',
        'due: null',
        'parent: null',
        'previous_ids: []',
        'created: 2026-09-19T20:00:00.000Z',
        'updated: 2026-09-19T20:00:00.000Z',
        'mood: fine',
        '---',
        'Body',
        '',
      ].join('\n'),
    );
    const again = parseTicketFile('Projects/X/Tickets/CEN-12.md', out, stat, 'X');
    assert.equal(again.title, 'Round: trip');
    assert.deepEqual(again.labels, ['import', 'vault']);
    assert.equal(again.created, Date.parse('2026-09-19T20:00:00.000Z'));
  });
});

describe('a vault full of odd files never breaks the index', () => {
  let t: TestServer;
  before(async () => {
    t = await startTestServer({
      prepare: async (vault) => {
        const tickets = path.join(vault, 'Projects', 'Handmade', 'Tickets');
        await fs.mkdir(tickets, { recursive: true });
        await fs.mkdir(path.join(vault, 'Inbox'), { recursive: true });
        // No project.md at all: the folder alone makes it a project.
        await fs.writeFile(path.join(tickets, 'HM-1.md'), '# Only a heading\n');
        await fs.writeFile(path.join(tickets, 'HM-2.md'), '---\ntitle: [broken yaml\n---\nstill here\n');
        await fs.writeFile(path.join(tickets, 'HM-3.md'), '---\n- a\n- list\n---\nfrontmatter is a list\n');
        await fs.writeFile(path.join(tickets, 'HM-4.md'), '');
        await fs.writeFile(path.join(tickets, 'HM-5.md'), Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x80, 0x81]));
        await fs.writeFile(path.join(tickets, 'loose note.md'), '---\nstatus: done\npriority: urgent\n---\nNamed by a human\n');
        await fs.mkdir(path.join(tickets, 'HM-6.md'));
        await fs.writeFile(path.join(vault, 'Inbox', 'INB-7.md'), '---\nstatus: todo\nagent: grok\n---\n# From the inbox\n');
        await fs.writeFile(path.join(vault, 'Projects', 'Handmade', 'Wiki.md'), '---\n: : :\n---\n');
      },
    });
  });
  after(() => t.close());

  it('indexes every readable ticket with defaults and skips nothing it can show', async () => {
    const res = await t.api<Ticket[]>('GET', '/api/tickets?project=Handmade');
    assert.equal(res.status, 200);
    const byId = new Map(res.json.map((x) => [x.id, x]));
    assert.equal(byId.get('HM-1')?.title, 'Only a heading');
    assert.equal(byId.get('HM-1')?.status, 'backlog');
    assert.equal(byId.get('HM-2')?.title, 'HM-2');
    assert.match(byId.get('HM-2')?.body ?? '', /broken yaml/);
    assert.ok(byId.has('HM-3'));
    assert.ok(byId.has('HM-4'));
    assert.ok(byId.has('HM-5'));
    assert.equal(byId.get('loose note')?.status, 'done');
    assert.equal(byId.get('loose note')?.priority, 1);
    assert.equal(byId.has('HM-6'), false, 'a directory named like a ticket is not a ticket');
  });

  it('treats a bare folder as a project with a derived, stable key', async () => {
    const res = await t.api<Project[]>('GET', '/api/projects');
    const handmade = res.json.find((p) => p.slug === 'Handmade');
    assert.ok(handmade);
    assert.match(handmade.key, /^[A-Z]{2,5}$/);
    assert.equal(handmade.counts.backlog >= 4, true);
    assert.equal(handmade.counts.done, 1);
  });

  it('serves the inbox ticket and the rest of the API normally', async () => {
    const inbox = await t.api<TicketDetail>('GET', '/api/tickets/INB-7');
    assert.equal(inbox.json.ticket.title, 'From the inbox');
    assert.equal(inbox.json.ticket.agent, 'grok');
    assert.equal((await t.api('GET', '/api/tree')).status, 200);
    assert.equal((await t.api('GET', '/api/search?q=heading')).status, 200);
  });

  it('can update a hand-written ticket, normalising it on write', async () => {
    const res = await t.api<Ticket>('PATCH', '/api/tickets/HM-1', { status: 'in-progress', priority: 'high', agent: 'Claude Code', by: 'claude-code' });
    assert.equal(res.status, 200);
    assert.equal(res.json.status, 'in_progress');
    assert.equal(res.json.priority, 2);
    assert.equal(res.json.agent, 'claude-code');
    const raw = await fs.readFile(path.join(t.vault, 'Projects/Handmade/Tickets/HM-1.md'), 'utf8');
    assert.match(raw, /^---\nid: HM-1\ntitle: Only a heading\nstatus: in_progress\npriority: 2\nagent: claude-code\n/);
    assert.match(raw, /\n---\n# Only a heading\n$/);
  });

  it('new tickets in the bare-folder project continue after the hand-numbered ones and pin the key in project.md', async () => {
    const projects = await t.api<Project[]>('GET', '/api/projects');
    const key = projects.json.find((p) => p.slug === 'Handmade')?.key as string;
    const res = await t.api<Ticket>('POST', '/api/tickets', { title: 'Server made', project: 'Handmade' });
    assert.equal(res.status, 201);
    assert.equal(res.json.id, key === 'HM' ? 'HM-6' : `${key}-1`);
    assert.match(await fs.readFile(path.join(t.vault, 'Projects/Handmade/project.md'), 'utf8'), new RegExp(`key: ${key}`));
  });
});

describe('ticket lifecycle over REST', () => {
  let t: TestServer;
  before(async () => {
    t = await startTestServer();
    await t.api('POST', '/api/projects', { name: 'Source', key: 'SRC' });
    await t.api('POST', '/api/projects', { name: 'Target Project', key: 'TGT' });
  });
  after(() => t.close());

  it('validates input with 400 + code invalid', async () => {
    for (const bad of [{}, { title: '   ' }, { title: 'x', status: 'nonsense' }, { title: 'x', priority: 9 }, { title: 'x', due: 'tomorrow' }, { title: 'x', labels: 'nope' }, { title: 'x', parent: 'NOPE-1' }]) {
      const res = await t.api<ApiError>('POST', '/api/tickets', bad);
      assert.equal(res.status, 400, JSON.stringify(bad));
      assert.equal(res.json.code, 'invalid');
      assert.equal(typeof res.json.error, 'string');
    }
    assert.equal((await t.api<ApiError>('POST', '/api/tickets', { title: 'x', project: 'Nope' })).status, 404);
    assert.equal((await t.api<ApiError>('GET', '/api/tickets/SRC-999')).json.code, 'not_found');
    const notJson = await fetch(`${t.base}/api/tickets`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' });
    assert.equal(notJson.status, 400);
  });

  it('create → patch → comment → detail, with activity attributed and agents auto-registered', async () => {
    const created = await t.api<Ticket>('POST', '/api/tickets', { title: 'Wire up search', project: 'Source', priority: 2, labels: ['search', 'search', ' ui '], createdBy: 'codex', body: 'Make it fast.' });
    assert.deepEqual(created.json.labels, ['search', 'ui']);
    assert.equal(created.json.createdBy, 'codex');

    const patched = await t.api<Ticket>('PATCH', `/api/tickets/${created.json.id}`, { status: 'in_progress', agent: 'brand-new-bot', by: 'brand-new-bot' });
    assert.equal(patched.json.status, 'in_progress');
    assert.equal(patched.json.agent, 'brand-new-bot');
    assert.ok(patched.json.updated >= created.json.updated);

    const noop = await t.api<Ticket>('PATCH', `/api/tickets/${created.json.id}`, { status: 'in_progress', by: 'codex' });
    assert.equal(noop.json.updated, patched.json.updated, 'a no-op patch does not rewrite the file');

    const comment = await t.api<ActivityEvent>('POST', `/api/tickets/${created.json.id}/comments`, { body: 'Halfway there.', agent: 'brand-new-bot' });
    assert.equal(comment.status, 201);
    assert.equal(comment.json.type, 'ticket.comment');
    assert.equal((await t.api<ApiError>('POST', `/api/tickets/${created.json.id}/comments`, { body: '  ', agent: 'x' })).status, 400);

    const detail = await t.api<TicketDetail>('GET', `/api/tickets/${created.json.id.toLowerCase()}`);
    assert.deepEqual(detail.json.activity.map((e) => e.type), ['ticket.created', 'ticket.updated', 'ticket.comment']);
    assert.deepEqual(detail.json.activity[1]?.changes, { status: ['backlog', 'in_progress'], agent: [null, 'brand-new-bot'] });
    assert.equal(detail.json.activity[2]?.body, 'Halfway there.');

    const agents = await t.api<{ id: string; name: string; kind: string; lastSeen: number | null }[]>('GET', '/api/agents');
    const bot = agents.json.find((a) => a.id === 'brand-new-bot');
    assert.equal(bot?.name, 'Brand New Bot');
    assert.equal(bot?.kind, 'agent');
    assert.ok((bot?.lastSeen ?? 0) > 0);
    assert.ok(agents.json.some((a) => a.id === 'owner' && a.kind === 'human'), 'the configured owner is the seeded human');

    const feed = await t.api<ActivityEvent[]>('GET', '/api/activity?agent=brand-new-bot');
    assert.deepEqual(feed.json.map((e) => e.type), ['ticket.comment', 'ticket.updated'], 'feed is newest first');
  });

  it('filters: project, status csv, agent, label, q, parent', async () => {
    const parent = (await t.api<Ticket>('POST', '/api/tickets', { title: 'Epic', project: 'SRC', status: 'todo' })).json;
    const child = (await t.api<Ticket>('POST', '/api/tickets', { title: 'Sub task zebra', project: 'SRC', parent: parent.id.toLowerCase(), agent: 'grok', labels: ['x'], status: 'done' })).json;
    assert.equal(child.parent, parent.id);

    const ids = async (qs: string) => (await t.api<Ticket[]>('GET', `/api/tickets?${qs}`)).json.map((x) => x.id);
    assert.deepEqual(await ids(`parent=${parent.id}`), [child.id]);
    assert.deepEqual(await ids('agent=grok'), [child.id]);
    assert.deepEqual(await ids('label=X'), [child.id]);
    assert.deepEqual(await ids('q=zebra'), [child.id]);
    assert.ok((await ids('status=todo,done&project=SRC')).includes(parent.id));
    assert.equal((await ids('status=done&project=SRC')).includes(parent.id), false);
    assert.deepEqual(await ids('project=inbox'), []);
    assert.equal((await t.api('GET', '/api/tickets?status=bogus')).status, 400);

    const detail = await t.api<TicketDetail>('GET', `/api/tickets/${parent.id}`);
    assert.deepEqual(detail.json.children.map((c) => c.id), [child.id]);
    assert.equal((await t.api<ApiError>('PATCH', `/api/tickets/${parent.id}`, { parent: child.id })).status, 400, 'cycles are refused');
  });

  it('moving a ticket between projects re-keys it; the old id still resolves everywhere', async () => {
    const original = (await t.api<Ticket>('POST', '/api/tickets', { title: 'Wanderer', project: 'Source', body: 'keep me', createdBy: 'codex' })).json;
    const child = (await t.api<Ticket>('POST', '/api/tickets', { title: 'Follows the wanderer', project: 'Source', parent: original.id })).json;
    await t.api('POST', `/api/tickets/${original.id}/comments`, { body: 'before the move', agent: 'codex' });

    const moved = await t.api<Ticket & { previousIds: string[] }>('PATCH', `/api/tickets/${original.id}`, { project: 'TGT', status: 'todo', by: 'owner' });
    assert.equal(moved.status, 200);
    assert.equal(moved.json.id, 'TGT-1');
    assert.equal(moved.json.project, 'Target Project');
    assert.equal(moved.json.path, 'Projects/Target Project/Tickets/TGT-1.md');
    assert.deepEqual(moved.json.previousIds, [original.id]);
    assert.equal(moved.json.body, 'keep me');
    assert.equal(moved.json.createdBy, 'codex');
    assert.equal(moved.json.created, original.created);

    await assert.rejects(fs.stat(path.join(t.vault, original.path)), 'the old file is gone');
    const raw = await fs.readFile(path.join(t.vault, moved.json.path), 'utf8');
    assert.match(raw, /^---\nid: TGT-1\n/);
    assert.match(raw, new RegExp(`previous_ids: \\[${original.id}\\]`));

    const viaOld = await t.api<TicketDetail>('GET', `/api/tickets/${original.id}`);
    assert.equal(viaOld.status, 200);
    assert.equal(viaOld.json.ticket.id, 'TGT-1');
    assert.ok(viaOld.json.activity.some((e) => e.body === 'before the move'), 'history under the old id is kept');
    assert.deepEqual(viaOld.json.activity.at(-1)?.changes?.id, [original.id, 'TGT-1']);
    assert.deepEqual(viaOld.json.children.map((c) => c.id), [child.id], 'children that point at the old id still attach');
    assert.deepEqual((await t.api<Ticket[]>('GET', `/api/tickets?parent=TGT-1`)).json.map((c) => c.id), [child.id]);

    const patchedViaOld = await t.api<Ticket>('PATCH', `/api/tickets/${original.id}`, { priority: 1 });
    assert.equal(patchedViaOld.json.id, 'TGT-1');
    assert.equal(patchedViaOld.json.priority, 1);
    assert.equal((await t.api('POST', `/api/tickets/${original.id}/comments`, { body: 'after', agent: 'codex' })).status, 201);
    assert.equal((await t.api<{ ticket?: string }[]>('GET', `/api/search?q=${original.id}`)).json[0]?.ticket, 'TGT-1');

    // The vacated number is never handed out again, and moving on keeps the whole id trail.
    const next = (await t.api<Ticket>('POST', '/api/tickets', { title: 'Newcomer', project: 'Source' })).json;
    assert.ok(numberOf(next.id) > numberOf(child.id));
    const toInbox = await t.api<Ticket & { previousIds: string[] }>('PATCH', '/api/tickets/TGT-1', { project: null });
    assert.match(toInbox.json.id, /^INB-\d+$/);
    assert.deepEqual(toInbox.json.previousIds, [original.id, 'TGT-1']);
    assert.equal((await t.api<TicketDetail>('GET', '/api/tickets/TGT-1')).json.ticket.id, toInbox.json.id);
    assert.equal((await t.api<TicketDetail>('GET', `/api/tickets/${original.id}`)).json.ticket.id, toInbox.json.id);
  });

  it('soft delete then restore', async () => {
    const ticket = (await t.api<Ticket>('POST', '/api/tickets', { title: 'Disposable', project: 'Source' })).json;
    assert.deepEqual((await t.api('DELETE', `/api/tickets/${ticket.id}?by=codex`)).json, { ok: true });
    assert.equal((await t.api('GET', `/api/tickets/${ticket.id}`)).status, 404);
    assert.equal((await t.api('DELETE', `/api/tickets/${ticket.id}`)).status, 404);

    const trash = await t.api<{ id: string; name: string; originalPath: string; isDir: boolean; deletedAt: number }[]>('GET', '/api/trash');
    const item = trash.json.find((x) => x.originalPath === ticket.path);
    assert.ok(item);
    assert.equal(item.name, `${ticket.id}.md`);
    assert.equal(item.isDir, false);

    const restored = await t.api<{ path: string }>('POST', '/api/trash/restore', { id: item.id });
    assert.deepEqual(restored.json, { path: ticket.path });
    const back = await t.api<TicketDetail>('GET', `/api/tickets/${ticket.id}`);
    assert.equal(back.json.ticket.title, 'Disposable');
    assert.ok(back.json.activity.some((e) => e.type === 'ticket.deleted' && e.agent === 'codex'));
  });

  it('concurrent patches to one ticket are serialised: no lost updates', async () => {
    const ticket = (await t.api<Ticket>('POST', '/api/tickets', { title: 'Contended', project: 'Source' })).json;
    await Promise.all([
      t.api('PATCH', `/api/tickets/${ticket.id}`, { status: 'todo' }),
      t.api('PATCH', `/api/tickets/${ticket.id}`, { priority: 3 }),
      t.api('PATCH', `/api/tickets/${ticket.id}`, { labels: ['a', 'b'] }),
      t.api('PATCH', `/api/tickets/${ticket.id}`, { agent: 'cursor' }),
      t.api('PATCH', `/api/tickets/${ticket.id}`, { due: '2026-12-24' }),
    ]);
    const final = (await t.api<TicketDetail>('GET', `/api/tickets/${ticket.id}`)).json.ticket;
    assert.equal(final.status, 'todo');
    assert.equal(final.priority, 3);
    assert.deepEqual(final.labels, ['a', 'b']);
    assert.equal(final.agent, 'cursor');
    assert.equal(final.due, '2026-12-24');
  });

  it('picks up a ticket written straight to disk (watcher) and logs it', async () => {
    await fs.writeFile(path.join(t.vault, 'Projects/Source/Tickets/SRC-500.md'), '---\ntitle: Dropped in by hand\nstatus: todo\ncreated_by: cursor\n---\n');
    let found: TicketDetail | undefined;
    for (let i = 0; i < 50 && !found; i += 1) {
      const res = await t.api<TicketDetail>('GET', '/api/tickets/SRC-500');
      if (res.status === 200) found = res.json;
      else await sleep(100);
    }
    assert.ok(found, 'the watcher indexed the new file');
    assert.equal(found.ticket.title, 'Dropped in by hand');
    const next = (await t.api<Ticket>('POST', '/api/tickets', { title: 'After the hand-made one', project: 'Source' })).json;
    assert.equal(next.id, 'SRC-501');
  });
});
