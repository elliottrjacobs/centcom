import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Ticket, TokenInfo } from '../shared/types.ts';
import { rawRequest, startTestServer, type TestServer } from './testkit.ts';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('centcom token (CLI)', () => {
  let t: TestServer;
  before(async () => {
    t = await startTestServer();
  });
  after(() => t.close());

  const centcom = async (...args: string[]) => {
    const env = { ...process.env, CENTCOM_URL: t.base, CENTCOM_CONFIG_DIR: t.configDir, CENTCOM_AGENT: '' };
    return run(process.execPath, ['--import', 'tsx', path.join(root, 'cli/centcom.ts'), ...args], { cwd: root, env });
  };

  it('creates a token straight into a 0600 file without printing it, lists it, and revokes it', async () => {
    const file = path.join(t.configDir, 'phone.token');
    const created = await centcom('token', 'create', '--label', 'Phone', '--agent', 'sam-phone', '--scope', 'read,write', '--out-file', file);
    const token = (await fs.readFile(file, 'utf8')).trim();
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    assert.ok(!created.stdout.includes(token) && !created.stderr.includes(token), 'never printed');
    await assert.rejects(centcom('token', 'create', '--label', 'Again', '--agent', 'x', '--scope', 'read', '--out-file', file), 'an existing file is never overwritten');

    const res = await rawRequest(t.port, { method: 'POST', path: '/api/tickets', headers: { 'X-Forwarded-For': '203.0.113.9', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{"title":"From the phone"}' });
    assert.equal((JSON.parse(res.body) as Ticket).createdBy, 'sam-phone');

    const list = JSON.parse((await centcom('token', 'list', '--json')).stdout) as TokenInfo[];
    const phone = list.find((x) => x.label === 'Phone');
    assert.ok(phone);
    assert.match((await centcom('token', 'list')).stdout, /sam-phone/);
    assert.match((await centcom('token', 'revoke', phone.id)).stdout, /Revoked/);
    assert.equal((await rawRequest(t.port, { path: '/api/tickets', headers: { 'X-Forwarded-For': '203.0.113.9', Authorization: `Bearer ${token}` } })).status, 401);
  });
});
