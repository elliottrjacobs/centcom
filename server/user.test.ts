/**
 * The vault's owner comes from config, never from the source code: anyone can run CENTCOM.
 * Every config dir and vault here is a temp dir.
 */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { ActivityEvent, Agent, Project, ServerInfo, Ticket } from '../shared/types.ts';
import { coerceUser, deriveDefaultUser, loadConfig, userFromOsUsername } from './config.ts';
import { startServer } from './index.ts';
import { startTestServer, tempDir, type TestServer } from './testkit.ts';

const readJson = async (file: string): Promise<Record<string, unknown>> => JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;

describe('owner derivation (pure)', () => {
  it('id = lowercase slug of the OS username, name = its first token capitalised', () => {
    assert.deepEqual(userFromOsUsername('sam'), { id: 'sam', name: 'Sam' });
    assert.deepEqual(userFromOsUsername('Sam Smith'), { id: 'sam-smith', name: 'Sam' });
    assert.deepEqual(userFromOsUsername('maria.garcia'), { id: 'maria.garcia', name: 'Maria' });
    assert.deepEqual(userFromOsUsername('DEV_BOX_7'), { id: 'dev-box-7', name: 'Dev' });
    assert.deepEqual(userFromOsUsername('  zoë  '), { id: 'zo', name: 'Zoë' }, 'ids stay ASCII slugs; the display name keeps its letters');
  });

  it('falls back to a neutral owner when the username is unusable', () => {
    for (const bad of ['', '   ', '!!!', null, undefined]) assert.deepEqual(userFromOsUsername(bad), { id: 'owner', name: 'Owner' });
  });

  it('coerceUser canonicalises the id and fills a missing name', () => {
    assert.deepEqual(coerceUser({ id: 'Sam Smith', name: '  Sam S.  ' }), { id: 'sam-smith', name: 'Sam S.' });
    assert.deepEqual(coerceUser({ id: 'sam' }), { id: 'sam', name: 'Sam' });
    for (const bad of [null, 'sam', [], {}, { name: 'No Id' }, { id: '###' }, { id: 7 }]) assert.equal(coerceUser(bad), null);
  });
});

describe('owner in config.json', () => {
  let configDir: string;
  let vault: string;
  const saved = { id: process.env.CENTCOM_USER_ID, name: process.env.CENTCOM_USER_NAME };

  before(async () => {
    delete process.env.CENTCOM_USER_ID;
    delete process.env.CENTCOM_USER_NAME;
    configDir = await tempDir('user-config');
    vault = await tempDir('user-vault');
  });
  after(async () => {
    if (saved.id === undefined) delete process.env.CENTCOM_USER_ID;
    else process.env.CENTCOM_USER_ID = saved.id;
    if (saved.name === undefined) delete process.env.CENTCOM_USER_NAME;
    else process.env.CENTCOM_USER_NAME = saved.name;
    for (const dir of [configDir, vault]) await fs.rm(dir, { recursive: true, force: true });
  });

  it('first run: derives the owner from the OS account and persists it', async () => {
    const config = await loadConfig({ configDir, vault });
    assert.deepEqual(config.user, userFromOsUsername(os.userInfo().username));
    assert.deepEqual((await readJson(config.configPath)).user, config.user, 'written to config.json');
  });

  it('is stable afterwards: the file wins over whatever would be derived today', async () => {
    const file = path.join(configDir, 'config.json');
    const data = await readJson(file);
    await fs.writeFile(file, JSON.stringify({ ...data, user: { id: 'sam', name: 'Sam' } }));
    assert.deepEqual((await loadConfig({ configDir, vault })).user, { id: 'sam', name: 'Sam' });
    assert.deepEqual((await loadConfig({ configDir, vault })).user, { id: 'sam', name: 'Sam' });
  });

  it('CENTCOM_USER_ID / CENTCOM_USER_NAME override it without being persisted', async () => {
    process.env.CENTCOM_USER_ID = 'Alex Doe';
    process.env.CENTCOM_USER_NAME = 'Alex';
    try {
      assert.deepEqual((await loadConfig({ configDir, vault })).user, { id: 'alex-doe', name: 'Alex' });
      delete process.env.CENTCOM_USER_NAME;
      assert.deepEqual((await loadConfig({ configDir, vault })).user, { id: 'alex-doe', name: 'Alex' }, 'an id override alone gets a matching name');
      delete process.env.CENTCOM_USER_ID;
      process.env.CENTCOM_USER_NAME = 'Samantha';
      assert.deepEqual((await loadConfig({ configDir, vault })).user, { id: 'sam', name: 'Samantha' }, 'a name override alone keeps the configured id');
    } finally {
      delete process.env.CENTCOM_USER_ID;
      delete process.env.CENTCOM_USER_NAME;
    }
    assert.deepEqual((await readJson(path.join(configDir, 'config.json'))).user, { id: 'sam', name: 'Sam' });
  });

  it('backward compatible: a config written before `user` existed keeps working, and keeps every other key', async () => {
    const oldDir = await tempDir('user-old-config');
    const token = 'a'.repeat(64);
    await fs.writeFile(path.join(oldDir, 'config.json'), JSON.stringify({ vault, port: 4848, host: '127.0.0.1', token, links: [], somethingElse: { kept: true } }), { mode: 0o600 });
    const config = await loadConfig({ configDir: oldDir });
    assert.deepEqual(config.user, userFromOsUsername(os.userInfo().username));
    assert.deepEqual([config.token, config.port], [token, 4848]);
    const onDisk = await readJson(path.join(oldDir, 'config.json'));
    assert.deepEqual(onDisk.user, config.user);
    assert.deepEqual([onDisk.token, onDisk.somethingElse, onDisk.links], [token, { kept: true }, []]);
    assert.equal(((await fs.stat(path.join(oldDir, 'config.json'))).mode & 0o777).toString(8), '600');
    await fs.rm(oldDir, { recursive: true, force: true });
  });

  it('a vault already in use keeps the human it has always attributed work to', async () => {
    const usedVault = await tempDir('user-used-vault');
    await fs.mkdir(path.join(usedVault, '.centcom'), { recursive: true });
    await fs.writeFile(path.join(usedVault, '.centcom', 'agents.json'), JSON.stringify([{ id: 'codex', name: 'Codex', kind: 'agent' }, { id: 'robin', name: 'Robin H', kind: 'human' }]));
    assert.deepEqual(await deriveDefaultUser(usedVault, 'someone-else'), { id: 'robin', name: 'Robin H' });
    assert.deepEqual(await deriveDefaultUser(vault, 'someone-else'), { id: 'someone-else', name: 'Someone' }, 'no roster yet → the OS account');
    await fs.rm(usedVault, { recursive: true, force: true });
  });
});

describe('the configured owner is used everywhere the app used to assume a name', () => {
  let t: TestServer;
  before(async () => {
    t = await startTestServer({ seed: true, config: () => ({ user: { id: 'sam', name: 'Sam' } }) });
  });
  after(() => t.close());

  it('is reported by /api/info', async () => {
    assert.deepEqual((await t.api<ServerInfo>('GET', '/api/info')).json.user, { id: 'sam', name: 'Sam' });
  });

  it('is the one seeded human', async () => {
    const humans = (await t.api<Agent[]>('GET', '/api/agents')).json.filter((a) => a.kind === 'human');
    assert.deepEqual(humans.map((a) => [a.id, a.name]), [['sam', 'Sam']]);
  });

  it('is who unattributed writes belong to', async () => {
    await t.api('PUT', '/api/doc', { path: 'Library/by-default.md', body: 'no agent given' });
    const ticket = (await t.api<Ticket>('POST', '/api/tickets', { title: 'No author given' })).json;
    assert.equal(ticket.createdBy, 'sam');
    const feed = (await t.api<ActivityEvent[]>('GET', '/api/activity?agent=sam')).json;
    assert.ok(feed.some((e) => e.type === 'doc.created' && e.path === 'Library/by-default.md'));
  });

  it('seeds AGENTS.md in their name and generic, provider-neutral starter tickets', async () => {
    const guide = await fs.readFile(path.join(t.vault, 'AGENTS.md'), 'utf8');
    assert.match(guide, /Sam's project and task tracker/);
    assert.match(guide, /one backend/);
    assert.doesNotMatch(guide, /save_bookmark/);

    const project = (await t.api<Project>('GET', '/api/projects/CEN')).json;
    assert.equal(project.lead, 'sam');
    const tickets = (await t.api<Ticket[]>('GET', '/api/tickets?project=CEN')).json;
    assert.ok(tickets.every((x) => x.createdBy === 'sam' || x.title === 'No author given'));
    const titles = tickets.map((x) => x.title);
    for (const wanted of ['Connect your first agent', 'Connect the iOS companion', 'Set up remote access']) assert.ok(titles.includes(wanted), wanted);
    const remote = tickets.find((x) => x.title === 'Set up remote access');
    for (const provider of [/Tailscale/, /Cloudflare Tunnel/, /reverse proxy/]) assert.match(remote?.body ?? '', provider);
    assert.match(remote?.body ?? '', /without a token are refused/);
  });

  it('an existing roster gains the owner as a human rather than a bot', async () => {
    const vault = await tempDir('user-roster-vault');
    const configDir = await tempDir('user-roster-config');
    await fs.mkdir(path.join(vault, '.centcom'), { recursive: true });
    await fs.writeFile(path.join(vault, 'README.md'), 'x');
    await fs.writeFile(path.join(vault, '.centcom', 'agents.json'), JSON.stringify([{ id: 'codex', name: 'Codex', kind: 'agent', color: '#4CB782', lastSeen: null }]));
    await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify({ user: { id: 'robin', name: 'Robin' } }), { mode: 0o600 });
    const server = await startServer({ port: 0, host: '127.0.0.1', vault, configDir, quiet: true, uiDir: path.join(configDir, 'no-ui') });
    try {
      const agents = (await (await fetch(`${server.url}/api/agents`)).json()) as Agent[];
      assert.deepEqual(agents.map((a) => [a.id, a.kind]), [['robin', 'human'], ['codex', 'agent']]);
    } finally {
      await server.close();
      for (const dir of [vault, configDir]) await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('nothing personal is baked into shipped code', () => {
  it('server/, mcp/ and cli/ contain no owner name and no home-folder path outside tests', async () => {
    const root = path.resolve(import.meta.dirname, '..');
    // Assembled so this file would not trip its own check if it were ever scanned.
    const personal = new RegExp(['ell', 'iott'].join(''), 'i');
    const homePath = /(?:\/Users\/|\/home\/)[a-z]/i;
    const offenders: string[] = [];
    let scanned = 0;
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(abs);
        else if (/\.(?:ts|mts|js|mjs|json|md)$/.test(entry.name) && !entry.name.endsWith('.test.ts') && entry.name !== 'testkit.ts') {
          scanned += 1;
          const text = await fs.readFile(abs, 'utf8');
          text.split('\n').forEach((line, i) => {
            if (personal.test(line) || homePath.test(line)) offenders.push(`${path.relative(root, abs)}:${i + 1}: ${line.trim().slice(0, 120)}`);
          });
        }
      }
    };
    for (const dir of ['server', 'mcp', 'cli']) await walk(path.join(root, dir));
    assert.ok(scanned > 25, `expected to scan the source tree, scanned ${scanned} files`);
    assert.deepEqual(offenders, []);
  });
});
