import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { AgentDeliverable, AgentHome, AgentProfile } from '../shared/types.ts';
import { startTestServer, type TestServer } from './testkit.ts';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('centcom agent (CLI)', () => {
  let t: TestServer;
  before(async () => {
    t = await startTestServer();
  });
  after(() => t.close());

  const centcom = async (...args: string[]) => {
    const env = { ...process.env, CENTCOM_URL: t.base, CENTCOM_CONFIG_DIR: t.configDir, CENTCOM_AGENT: '' };
    const { stdout } = await run(process.execPath, ['--import', 'tsx', path.join(root, 'cli/centcom.ts'), ...args], { cwd: root, env });
    return stdout;
  };

  it('sets a profile from flags and a file, reports a deliverable, and shows the home', async () => {
    const file = path.join(t.configDir, 'instructions.md');
    await fs.writeFile(file, '- Tests first.\n- Never push to main.\n');
    const set = JSON.parse(await centcom('agent', 'profile', 'set', 'codex', '--description', 'Codex CLI.', '--instructions-file', file, '--skill', 'tdd: Red, green, refactor', '--skill', 'review', '--json')) as { profile: AgentProfile; changed: boolean };
    assert.equal(set.changed, true);
    assert.equal(set.profile.instructions, '- Tests first.\n- Never push to main.');
    assert.deepEqual(set.profile.skills, [
      { name: 'tdd', description: 'Red, green, refactor' },
      { name: 'review', description: '' },
    ]);
    assert.equal(set.profile.updatedBy, 'codex', 'no identity given: the agent wrote its own profile');

    const added = JSON.parse(await centcom('agent', 'deliverable', 'add', 'codex', '--title', 'PR 7', '--url', 'https://github.com/o/r/pull/7', '--kind', 'pr', '--as', 'codex', '--json')) as AgentDeliverable;
    assert.equal(added.url, 'https://github.com/o/r/pull/7');

    const home = JSON.parse(await centcom('agent', 'home', 'codex', '--json')) as AgentHome;
    assert.equal(home.profile?.description, 'Codex CLI.');
    assert.deepEqual(home.deliverables.map((d) => d.title), ['PR 7']);

    const text = await centcom('agent', 'home', 'codex');
    assert.match(text, /Codex CLI\./);
    assert.match(text, /PR 7/);
    assert.match(text, /tdd/);
  });
});
