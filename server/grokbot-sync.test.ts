import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { AgentProfile } from '../shared/types.ts';
import { startTestServer, tempDir, type TestServer } from './testkit.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts/sync-grokbots.mjs');

interface SyncReport {
  count: number;
  bots: { id: string; name: string; description: string; instructions: number; skills: string[] }[];
  results?: { id: string; status: 'created' | 'updated' | 'unchanged' | 'failed'; error?: string }[];
  summary?: { created: number; updated: number; unchanged: number; failed: number };
}

/** Runs the script the way the bot machine does: plain `node`, no tsx, no node_modules on the path that matters. */
function sync(args: string[], env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const clean = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env };
    execFile(process.execPath, [script, ...args], { env: clean, cwd: path.dirname(script) }, (err, stdout, stderr) => {
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
  });
}

describe('scripts/sync-grokbots.mjs', () => {
  let t: TestServer;
  let agents: string;
  let skills: string;

  const writeBot = async (dir: string, profile: Record<string, unknown>) => {
    await fs.mkdir(path.join(agents, dir), { recursive: true });
    await fs.writeFile(path.join(agents, dir, 'profile.json'), JSON.stringify({ title: '', avatarShape: 'circle', avatarColor: '#fff', serverId: 's', harness: 'grok', ...profile }));
  };

  before(async () => {
    t = await startTestServer();
    agents = await tempDir('grok-agents');
    skills = await tempDir('grok-skills');
    await writeBot('aaa', { name: 'Stan', description: "The owner's general-purpose assistant. Uses grill-me." });
    await writeBot('bbb', { name: 'Security Watch', description: `You are Security Watch. You watch everything.\n\nRules:\n- Never use lfg.\n- Use grill-me when unsure.` });
    await writeBot('ccc', { name: '', description: 'nameless' });
    await fs.mkdir(path.join(agents, 'no-profile'));
    await fs.writeFile(path.join(agents, 'active-agent.json'), '{}');
    for (const [folder, description] of [['grill-me', 'A relentless interview.'], ['lfg', 'Hands-off.']] as const) {
      await fs.mkdir(path.join(skills, folder));
      await fs.writeFile(path.join(skills, folder, 'SKILL.md'), `---\nname: ${folder}\ndescription: ${description}\n---\n# ${folder}\n`);
    }
  });
  after(async () => {
    await t.close();
    await fs.rm(agents, { recursive: true, force: true });
    await fs.rm(skills, { recursive: true, force: true });
  });

  const dirs = () => ['--agents-dir', agents, '--skills-dir', skills];
  const env = () => ({ CENTCOM_URL: t.base, CENTCOM_TOKEN: t.token, CENTCOM_AGENT: 'grokbot-stan' });

  it('--dry-run reports what it would send without touching the network', async () => {
    const run = await sync([...dirs(), '--dry-run', '--json'], {});
    assert.equal(run.code, 0, run.stderr);
    const report = JSON.parse(run.stdout) as SyncReport;
    assert.equal(report.count, 2);
    assert.deepEqual(report.bots.map((b) => [b.id, b.skills]), [
      ['grokbot-security-watch', ['grill-me']],
      ['grokbot-stan', ['grill-me']],
    ]);
    assert.equal(report.bots[0]?.description, 'You are Security Watch. You watch everything.');
    assert.ok((report.bots[0]?.instructions ?? 0) > 40);
    assert.equal(report.results, undefined);
  });

  it('creates the profiles, then a second run changes nothing, then an edit updates only that bot', async () => {
    const first = await sync([...dirs(), '--json'], env());
    assert.equal(first.code, 0, first.stderr);
    assert.deepEqual((JSON.parse(first.stdout) as SyncReport).summary, { created: 2, updated: 0, unchanged: 0, failed: 0 });

    const stan = (await t.api<AgentProfile>('GET', '/api/agents/grokbot-stan/profile')).json;
    assert.equal(stan.source, 'grokbot-sync');
    assert.equal(stan.updatedBy, 'grokbot-stan');
    assert.deepEqual(stan.skills, [{ name: 'grill-me', description: 'A relentless interview.' }]);
    const watch = (await t.api<AgentProfile>('GET', '/api/agents/grokbot-security-watch/profile')).json;
    assert.match(watch.instructions, /Never use lfg/);
    const agentsList = (await t.api<{ id: string; name: string }[]>('GET', '/api/agents')).json;
    assert.equal(agentsList.find((a) => a.id === 'grokbot-security-watch')?.name, 'Security Watch');

    const again = await sync([...dirs(), '--json'], env());
    assert.deepEqual((JSON.parse(again.stdout) as SyncReport).summary, { created: 0, updated: 0, unchanged: 2, failed: 0 });
    assert.equal((await t.api<AgentProfile>('GET', '/api/agents/grokbot-stan/profile')).json.updated, stan.updated);

    await writeBot('aaa', { name: 'Stan', description: "The owner's general-purpose assistant. Runs errands." });
    const edited = await sync([...dirs()], env());
    assert.equal(edited.code, 0, edited.stderr);
    assert.match(edited.stdout, /created 0, updated 1, unchanged 1, failed 0/);
    assert.ok(!`${first.stdout}${first.stderr}${edited.stdout}${edited.stderr}`.includes(t.token), 'the token is never printed');
  });

  it('exits non-zero when a push fails, and needs CENTCOM_URL unless it is a dry run', async () => {
    const down = await sync([...dirs()], { CENTCOM_URL: 'http://127.0.0.1:9', CENTCOM_TOKEN: t.token });
    assert.notEqual(down.code, 0);
    assert.match(down.stdout, /failed 2/);
    assert.ok(!`${down.stdout}${down.stderr}`.includes(t.token));

    const noUrl = await sync([...dirs()], {});
    assert.notEqual(noUrl.code, 0);
    assert.match(noUrl.stderr, /CENTCOM_URL/);
  });

  it('assumes no machine layout: both directories are required, and a named token file must exist', async () => {
    const noAgents = await sync(['--skills-dir', skills, '--dry-run'], {});
    assert.equal(noAgents.code, 2);
    assert.match(noAgents.stderr, /--agents-dir/);
    const noSkills = await sync(['--agents-dir', agents, '--dry-run'], {});
    assert.equal(noSkills.code, 2);
    assert.match(noSkills.stderr, /--skills-dir/);
    const viaEnv = await sync(['--dry-run', '--json'], { GROKBOT_AGENTS_DIR: agents, GROKBOT_SKILLS_DIR: skills });
    assert.equal(viaEnv.code, 0, viaEnv.stderr);
    const missingFile = await sync([...dirs()], { CENTCOM_URL: t.base, CENTCOM_TOKEN_FILE: path.join(agents, 'missing-token') });
    assert.equal(missingFile.code, 2);
    assert.match(missingFile.stderr, /does not exist/);
  });
});
