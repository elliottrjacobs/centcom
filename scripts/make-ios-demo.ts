/**
 * Builds `ios/CENTCOM/Resources/Demo/demo.json`: every response the iPhone app asks for, recorded
 * from a real server holding a small fictional workspace. The app's demo mode answers from this
 * file, so anyone (App Review included) can try the app without a server, and the shapes can never
 * drift from the real API. Run `pnpm build:ios-demo` after API changes.
 *
 * Keys are `<path after /api/>[?name=value&…]`, query items sorted and percent-decoded, which is
 * exactly how `DemoURLProtocol.key(for:)` reads a request.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Agent, Ticket, TreeNode } from '../shared/types.ts';
import type { SkillCatalog, SkillReport } from '../shared/skills.ts';
import type { InstructionCatalog } from '../shared/instructions.ts';
import { startServer } from '../server/index.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'ios/CENTCOM/Resources/Demo/demo.json');

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'centcom-demo-'));
await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ user: { id: 'sam', name: 'Sam' } }), { mode: 0o600 });
const server = await startServer({ port: 0, host: '127.0.0.1', vault: path.join(dir, 'vault'), configDir: dir, quiet: true, uiDir: path.join(dir, 'no-ui') });
const base = `http://127.0.0.1:${server.info.port}/api/`;

async function call<T>(method: string, p: string, body?: unknown): Promise<T> {
  const res = await fetch(base + p, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!res.ok) throw new Error(`${method} ${p}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

try {
  /* ── A fictional workspace ── */
  await call('POST', 'projects', { name: 'Website relaunch', key: 'WEB', summary: 'New marketing site and docs, live before the spring launch.', color: '#26B5CE', icon: 'Globe' });
  await call('POST', 'projects', { name: 'Mobile app', key: 'APP', summary: 'iPhone companion: offline reading and faster capture.', color: '#BB87FC', icon: 'Smartphone' });
  await call('POST', 'labels', { project: 'WEB', name: 'copy', color: '#F2994A' });
  await call('POST', 'labels', { project: 'WEB', name: 'design', color: '#BB87FC' });
  const tickets: [string, Record<string, unknown>][] = [
    ['WEB', { title: 'Write the pricing page copy', status: 'in_progress', priority: 2, agent: 'research-bot', labels: ['copy'], due: '2026-11-20', body: 'Three plans, one comparison table. Keep it under 300 words.' }],
    ['WEB', { title: 'Choose the hero illustration', status: 'in_review', priority: 3, agent: 'sam', labels: ['design'] }],
    ['WEB', { title: 'Redirect the old docs URLs', status: 'todo', priority: 2, agent: 'claude-code' }],
    ['WEB', { title: 'Accessibility pass on the navigation', status: 'backlog', priority: 3 }],
    ['APP', { title: 'Cache the last 50 tasks for offline reading', status: 'in_progress', priority: 1, agent: 'codex', body: 'Read-only offline mode. Writes still need a connection.' }],
    ['APP', { title: 'Share sheet: capture a link as a task', status: 'todo', priority: 3 }],
    ['APP', { title: 'App icon in dark mode', status: 'done', priority: 4, agent: 'sam' }],
    ['', { title: 'Renew the domain', status: 'todo', priority: 2, due: '2026-12-01' }],
  ];
  const made: Ticket[] = [];
  for (const [project, input] of tickets) made.push(await call<Ticket>('POST', 'tickets', { ...input, ...(project ? { project } : {}), createdBy: 'sam', device: 'Demo' }));
  await call('POST', `tickets/${made[0]!.id}/comments`, { agent: 'research-bot', device: 'Cloud', body: 'Drafted all three plans. The comparison table is in the Library: *Launch plan*.' });
  await call('POST', `tickets/${made[0]!.id}/comments`, { agent: 'sam', device: 'iPhone', body: 'Looks good. Shorten the Pro description to one line.' });
  await call('POST', `tickets/${made[4]!.id}/comments`, { agent: 'codex', device: 'Laptop', body: 'Storing snapshots in the app container. Tests pass; opening a PR next.' });
  await call('PATCH', `tickets/${made[1]!.id}`, { status: 'in_review', by: 'design-bot' });
  await call('PUT', 'doc', { path: 'Projects/Website relaunch/Library/Launch plan.md', body: '# Launch plan\n\n| Plan | Price | For |\n| --- | --- | --- |\n| Free | $0 | Trying it out |\n| Pro | $8 | One person |\n| Team | $20 | Shared projects |\n\n- [x] Pricing copy drafted\n- [ ] Hero illustration\n- [ ] Redirects\n', agent: 'research-bot' });
  await call('PUT', 'agents/research-bot/profile', { name: 'Research Bot', description: 'Reads sources, drafts copy, and cites everything.', instructions: '- Cite a source for every claim.\n- Draft in the Library, then link it from the ticket.\n- Ask before publishing anything.', skills: [{ name: 'summarize', description: 'Condense long sources into a page.' }], agent: 'research-bot' });
  await call('PUT', 'agents/design-bot/profile', { name: 'Design Bot', description: 'Proposes layouts and checks contrast.', instructions: '- Light mode first.\n- Check WCAG AA contrast on every color pair.', agent: 'design-bot' });
  await call('POST', 'agents/research-bot/deliverables', { title: 'Launch plan', url: 'Projects/Website relaunch/Library/Launch plan.md', kind: 'doc', project: 'WEB', agent: 'research-bot' });
  const skillReport: SkillReport = {
    deviceId: 'laptop',
    deviceName: 'Laptop',
    reporter: 'demo',
    entries: [
      { name: 'summarize', description: 'Condense long sources into a page.', agent: 'Claude Code', scope: 'global', project: null, path: '/Users/sam/.claude/skills/summarize/SKILL.md', sourceUrl: null, markdown: '---\nname: summarize\ndescription: Condense long sources into a page.\n---\n# Summarize\n\nRead everything, then write one page with sources.\n' },
      { name: 'release-notes', description: 'Write release notes from merged pull requests.', agent: 'Codex', scope: 'global', project: null, path: '/Users/sam/.codex/skills/release-notes/SKILL.md', sourceUrl: null, markdown: '---\nname: release-notes\ndescription: Write release notes from merged pull requests.\n---\n# Release notes\n\nGroup by user-visible change. No internal jargon.\n' },
    ],
  };
  await call('PUT', 'skills/inventory', skillReport);
  await call('PUT', 'instructions/inventory', {
    deviceId: 'laptop',
    deviceName: 'Laptop',
    reporter: 'demo',
    entries: [{ name: 'AGENTS.md', agent: 'Codex', scope: 'global', project: null, projectKey: null, relativePath: '.codex/AGENTS.md', path: '/Users/sam/.codex/AGENTS.md', markdown: '# How I work\n\nTrack work in CENTCOM. Claim a ticket before starting and comment as you go.\n' }],
  });

  /* ── Record what the app reads ── */
  const record: Record<string, unknown> = {};
  const get = async <T>(p: string, query: Record<string, string> = {}): Promise<T> => {
    const qs = Object.entries(query).sort(([a], [b]) => a.localeCompare(b));
    const value = await call<T>('GET', qs.length ? `${p}?${new URLSearchParams(qs).toString()}` : p);
    record[qs.length ? `${p}?${qs.map(([k, v]) => `${k}=${v}`).join('&')}` : p] = value;
    return value;
  };
  for (const p of ['info', 'projects', 'labels', 'activity', 'agent-profiles']) await get(p);
  const all = await get<Ticket[]>('tickets');
  for (const t of all) await get(`tickets/${t.id}`);
  for (const a of await get<Agent[]>('agents')) await get(`agents/${a.id}/home`);
  const tree = await get<TreeNode>('tree');
  const docs: string[] = [];
  const walk = (n: TreeNode) => {
    if (n.type === 'file' && n.path.endsWith('.md') && n.path.startsWith('Projects/')) docs.push(n.path);
    for (const c of n.children ?? []) walk(c);
  };
  walk(tree);
  for (const p of docs) await get('doc', { path: p });
  for (const s of (await get<SkillCatalog>('skills')).skills) for (const i of s.installations) await get(`skills/installations/${i.id}`);
  for (const file of (await get<InstructionCatalog>('instructions')).files) for (const copy of file.copies) await get(`instructions/copies/${copy.id}`);

  // The vault path is this machine's temp dir; the demo describes a fictional one.
  (record.info as { vault: string }).vault = '/Users/sam/CENTCOM';
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, `${JSON.stringify(record, null, 1)}\n`);
  console.log(`wrote ${path.relative(root, out)}: ${Object.keys(record).length} responses`);
} finally {
  await server.close();
  await fs.rm(dir, { recursive: true, force: true });
}
