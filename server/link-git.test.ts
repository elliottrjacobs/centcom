/**
 * Git-aware links. Every repository here is a throwaway that this file `git init`s under
 * os.tmpdir(); the helper refuses to run git anywhere else, and the developer's own git config
 * is switched off for the whole process so the results do not depend on it.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, promises as fs, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { ApiError, LinkGitStatus, SearchHit, TreeNode } from '../shared/types.ts';
import { decideAuth, isLoopbackOnlyPath, routedPaths, type AuthInput } from './auth.ts';
import { OWNER_PRINCIPAL } from './tokens.ts';
import { linkGitStatus, parsePorcelainV2 } from './link-git.ts';
import { isInside } from './paths.ts';
import { openEvents, rawRequest, sleep, startTestServer, tempDir, viaOf, type TestServer } from './testkit.ts';

// The server under test runs in this process, so this isolates ITS git calls too.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

const TMP = realpathSync(os.tmpdir());
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_TERMINAL_PROMPT: '0',
};

/** Run git, but only ever inside a temp directory. */
function g(cwd: string, ...args: string[]): string {
  const real = realpathSync(cwd);
  assert.ok(isInside(TMP, real) && real !== TMP, `refusing to run git outside the temp dir: ${real}`);
  return execFileSync('git', args, { cwd: real, env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

function find(node: TreeNode, p: string): TreeNode | undefined {
  if (node.path === p) return node;
  for (const child of node.children ?? []) {
    const hit = find(child, p);
    if (hit) return hit;
  }
  return undefined;
}

function writeSkill(repo: string, name: string, marker: string): void {
  mkdirSync(path.join(repo, 'skills', name, 'references', 'deep'), { recursive: true });
  mkdirSync(path.join(repo, 'skills', name, 'scripts'), { recursive: true });
  writeFileSync(path.join(repo, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} (${marker})\n---\n# ${name}\n`);
  writeFileSync(path.join(repo, 'skills', name, 'references', 'deep', 'notes.md'), `${marker}notes${name}\n`);
  writeFileSync(path.join(repo, 'skills', name, 'scripts', 'run.sh'), '#!/bin/sh\n');
}

const FIRST_WAVE = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];
const SECOND_WAVE = ['india', 'juliett', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa'];

describe('parsePorcelainV2', () => {
  it('reads branch, upstream, ahead/behind and dirtiness', () => {
    assert.deepEqual(parsePorcelainV2('# branch.oid abc\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -5\n'), { branch: 'main', upstream: 'origin/main', ahead: 2, behind: 5, dirty: false });
    assert.deepEqual(parsePorcelainV2('# branch.oid abc\n# branch.head feature\n'), { branch: 'feature', dirty: false });
    assert.equal(parsePorcelainV2('# branch.head main\n1 .M N... 100644 100644 100644 a b README.md\n').dirty, true);
    assert.equal(parsePorcelainV2('# branch.head main\n? untracked.txt\n').dirty, false, 'untracked is not dirty');
    assert.equal(parsePorcelainV2('# branch.head main\n! ignored.log\n').dirty, false, 'ignored is not dirty');
    assert.equal(parsePorcelainV2('# branch.head main\n1 .M N... 100644 100644 100644 abc def tracked.md\n').dirty, true, 'a modified tracked file is');
    assert.equal(parsePorcelainV2('# branch.oid abc\n# branch.head (detached)\n').branch, 'HEAD (detached)');
    assert.equal(parsePorcelainV2('# branch.head main\n# branch.upstream origin/gone\n').upstream, undefined, 'an upstream whose ref is gone tracks nothing');
  });
});

describe('git endpoints are loopback-only, even with the right token (decision function)', () => {
  const TOKEN = 'd'.repeat(64);
  const input = (o: Partial<AuthInput>): AuthInput => ({ remoteAddress: '100.64.0.9', forwarded: false, method: 'POST', pathname: '/api/links/git/pull', authorization: `Bearer ${TOKEN}`, queryToken: undefined, verify: (t) => (t === TOKEN ? OWNER_PRINCIPAL : null), ...o });
  const PATHS: [string, string][] = [['GET', '/api/links/git'], ['POST', '/api/links/git/fetch'], ['POST', '/api/links/git/pull']];

  it('refuses a remote peer holding the correct token, and a proxied loopback socket', () => {
    for (const [method, pathname] of PATHS) {
      assert.equal(isLoopbackOnlyPath(pathname), true, pathname);
      const remote = decideAuth(input({ method, pathname }));
      assert.deepEqual([remote.ok, !remote.ok && remote.status], [false, 403], `${method} ${pathname}`);
      assert.equal(decideAuth(input({ method, pathname, remoteAddress: '127.0.0.1', forwarded: true })).ok, false, `${pathname} via a proxy`);
      assert.equal(decideAuth(input({ method, pathname, queryToken: TOKEN, authorization: undefined })).ok, false, `${pathname} with ?token=`);
    }
  });

  it('allows this machine, with or without a token', () => {
    for (const [method, pathname] of PATHS) {
      assert.equal(viaOf(decideAuth(input({ method, pathname, remoteAddress: '127.0.0.1', authorization: undefined }))), 'loopback');
      assert.equal(viaOf(decideAuth(input({ method, pathname, remoteAddress: '::1' }))), 'loopback');
    }
  });

  it('cannot be dodged with another spelling of the path', () => {
    for (const raw of ['/api/links/git/pull/', '/API/Links/Git/Pull', '//api//links//git/fetch', '/api/links/git/%70ull', '/api/%6Cinks/git', '/api/x/../links/git/fetch', '/api/links/./git/pull']) {
      const routed = routedPaths(raw);
      assert.ok(routed);
      assert.equal(decideAuth(input({ pathname: routed.pathname, variants: routed.variants })).ok, false, raw);
    }
  });
});

describe('git-aware links over HTTP', () => {
  let t: TestServer;
  let origin: string;
  let cloneRoot: string;
  let vendorRoot: string;
  let plain: string;
  let clone: string;
  let vendor: string;

  const status = async (): Promise<Record<string, LinkGitStatus>> => Object.fromEntries((await t.api<LinkGitStatus[]>('GET', '/api/links/git')).json.map((s) => [s.mount, s]));

  before(async () => {
    origin = await tempDir('git-origin');
    cloneRoot = await tempDir('git-clone');
    vendorRoot = await tempDir('git-vendor');
    plain = await tempDir('git-plain');
    g(origin, 'init', '--quiet', '-b', 'main');
    writeFileSync(path.join(origin, 'README.md'), '# skills repo\n');
    writeSkill(origin, 'keeper', 'seed');
    writeSkill(origin, 'doomed', 'seed');
    g(origin, 'add', '-A');
    g(origin, 'commit', '--quiet', '-m', 'initial');
    g(cloneRoot, 'clone', '--quiet', origin, 'work');
    g(vendorRoot, 'clone', '--quiet', origin, 'work');
    clone = path.join(cloneRoot, 'work');
    vendor = path.join(vendorRoot, 'work');
    await fs.writeFile(path.join(plain, 'note.md'), 'not a repo\n');

    t = await startTestServer({
      // Each link is a SUBFOLDER of its clone, the usual shape of a skills repo.
      config: () => ({
        links: [
          { mount: 'Skills/shared', target: path.join(clone, 'skills') },
          { mount: 'Skills/vendor', target: path.join(vendor, 'skills'), readonly: true },
          { mount: 'Skills/plain', target: plain },
        ],
      }),
    });
  });
  after(async () => {
    await t.close();
    for (const dir of [origin, cloneRoot, vendorRoot, plain]) await fs.rm(dir, { recursive: true, force: true });
  });

  it('status: one entry per valid link, the repo found from a subfolder, a plain folder reported as not a repo', async () => {
    const res = await t.api<LinkGitStatus[]>('GET', '/api/links/git');
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, [
      { mount: 'Skills/shared', repo: true, branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, dirty: false },
      { mount: 'Skills/vendor', repo: true, branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, dirty: false },
      { mount: 'Skills/plain', repo: false },
    ]);
  });

  it('status uses local refs only: a new commit upstream is invisible until someone fetches', async () => {
    rmSync(path.join(origin, 'skills', 'doomed'), { recursive: true, force: true });
    for (const name of FIRST_WAVE) writeSkill(origin, name, 'wave1');
    g(origin, 'add', '-A');
    g(origin, 'commit', '--quiet', '-m', 'remove one skill, add eight');

    assert.equal((await status())['Skills/shared']?.behind, 0, 'no network, so still "up to date"');
    assert.equal((await status())['Skills/shared']?.fetchedAt, undefined, 'a fresh clone has never fetched');
  });

  it('fetch: one link by mount, then all; reports behind and when it fetched', async () => {
    const started = Date.now();
    const one = await t.api<LinkGitStatus[]>('POST', '/api/links/git/fetch', { mount: 'Skills/shared' });
    assert.equal(one.status, 200);
    assert.deepEqual(one.json.map((s) => [s.mount, s.behind]), [['Skills/shared', 1]]);
    assert.ok((one.json[0]?.fetchedAt ?? 0) >= started - 2000, 'fetchedAt is the mtime of FETCH_HEAD');
    assert.equal((await status())['Skills/vendor']?.behind, 0, 'the other clone was not fetched');

    const all = await t.api<LinkGitStatus[]>('POST', '/api/links/git/fetch', {});
    assert.deepEqual(all.json.map((s) => [s.mount, s.repo, s.behind]), [['Skills/shared', true, 1], ['Skills/vendor', true, 1], ['Skills/plain', false, undefined]]);
    assert.ok(find((await t.api<TreeNode>('GET', '/api/tree')).json, 'Skills/shared/doomed'), 'fetching changes no files');
  });

  it('pull: fast-forwards, reconciles the index before answering, and broadcasts a tree event', async () => {
    const events = await openEvents(t.port);
    try {
      const res = await t.api<LinkGitStatus>('POST', '/api/links/git/pull', { mount: 'Skills/shared' });
      assert.equal(res.status, 200);
      assert.deepEqual([res.json.mount, res.json.behind, res.json.ahead, res.json.dirty], ['Skills/shared', 0, 0, false]);

      // No waiting: the response is only sent once the index matches the disk.
      const tree = (await t.api<TreeNode>('GET', '/api/tree')).json;
      for (const name of FIRST_WAVE) {
        assert.ok(find(tree, `Skills/shared/${name}/SKILL.md`), `${name}/SKILL.md`);
        assert.ok(find(tree, `Skills/shared/${name}/references/deep/notes.md`), `${name} nested file`);
      }
      assert.equal(find(tree, 'Skills/shared/doomed'), undefined);
      assert.ok(find(tree, 'Skills/shared/keeper/SKILL.md'));
      assert.deepEqual((await t.api<SearchHit[]>('GET', '/api/search?q=wave1notesgolf')).json.map((h) => h.path), ['Skills/shared/golf/references/deep/notes.md']);
      await events.waitFor((e) => e.type === 'tree');
    } finally {
      events.close();
    }
  });

  it('a read-only link may be pulled (readonly governs API edits, not the owner updating a clone)', async () => {
    const res = await t.api<LinkGitStatus>('POST', '/api/links/git/pull', { mount: 'Skills/vendor' });
    assert.equal(res.status, 200);
    assert.equal(res.json.behind, 0);
    assert.ok(find((await t.api<TreeNode>('GET', '/api/tree')).json, 'Skills/vendor/alpha/SKILL.md'));
    assert.equal((await t.api('PUT', '/api/doc', { path: 'Skills/vendor/alpha/SKILL.md', body: 'edited' })).status, 403, 'still read-only through the API');
  });

  it('pull is refused with 409 conflict when the work tree is dirty, ahead, or tracks nothing', async () => {
    const pull = () => t.api<ApiError>('POST', '/api/links/git/pull', { mount: 'Skills/shared' });
    const head = () => g(clone, 'rev-parse', 'HEAD').trim();
    const startedAt = head();

    // Something new upstream, so a pull would really do something if it were allowed.
    writeFileSync(path.join(origin, 'README.md'), '# skills repo\n\nupdated\n');
    g(origin, 'commit', '--quiet', '-am', 'readme');
    await t.api('POST', '/api/links/git/fetch', { mount: 'Skills/shared' });

    // Dirty: a modified tracked file…
    writeFileSync(path.join(clone, 'skills', 'keeper', 'SKILL.md'), 'local edit\n');
    let res = await pull();
    assert.deepEqual([res.status, res.json.code], [409, 'conflict']);
    assert.match(res.json.error, /uncommitted changes/);
    assert.equal((await status())['Skills/shared']?.dirty, true);
    g(clone, 'checkout', '--quiet', '--', '.');
    // An UNTRACKED file is not "dirty". A clone with a scratch folder that is never committed
    // (a real case: an untracked `briefs/` dir) must stay pullable, or the Pull button is dead
    // forever on exactly the repos people link. Checked via status so this test's
    // behind-the-remote state is left intact for the assertions below.
    writeFileSync(path.join(clone, 'untracked.txt'), 'x');
    assert.equal((await status())['Skills/shared']?.dirty, false);
    rmSync(path.join(clone, 'untracked.txt'));

    // Ahead: a local commit the remote does not have.
    writeFileSync(path.join(clone, 'local.md'), 'local work\n');
    g(clone, 'add', '-A');
    g(clone, 'commit', '--quiet', '-m', 'local commit');
    res = await pull();
    assert.deepEqual([res.status, res.json.code], [409, 'conflict']);
    assert.match(res.json.error, /1 local commit/);
    assert.deepEqual([(await status())['Skills/shared']?.ahead, (await status())['Skills/shared']?.behind], [1, 1]);
    g(clone, 'reset', '--quiet', '--hard', startedAt);

    // No upstream: a local branch that tracks nothing.
    g(clone, 'checkout', '--quiet', '-b', 'experiment');
    res = await pull();
    assert.deepEqual([res.status, res.json.code], [409, 'conflict']);
    assert.match(res.json.error, /no upstream/);
    const s = (await status())['Skills/shared'];
    assert.deepEqual([s?.branch, s?.upstream, s?.ahead], ['experiment', undefined, undefined]);
    g(clone, 'checkout', '--quiet', 'main');

    assert.equal(head(), startedAt, 'none of the refused pulls moved HEAD');
    assert.equal((await pull()).status, 200, 'and once it is clean, on main and not ahead, it goes through');
    assert.notEqual(head(), startedAt);
  });

  it('the only client input is `mount`, and it must name a configured link exactly', async () => {
    for (const mount of ['Skills/nope', 'Skills/shared/', 'skills/shared', 'Skills/shared/../shared', '--upload-pack=touch pwned', '-C /', clone, 'Skills/shared\n--help']) {
      const res = await t.api<ApiError>('POST', '/api/links/git/pull', { mount });
      assert.deepEqual([res.status, res.json.code], [404, 'not_found'], JSON.stringify(mount));
      assert.equal((await t.api<ApiError>('POST', '/api/links/git/fetch', { mount })).status, 404, `fetch ${JSON.stringify(mount)}`);
    }
    for (const body of [{}, { mount: 7 }, { mount: null }, { mount: ['Skills/shared'] }]) assert.equal((await t.api('POST', '/api/links/git/pull', body)).status, 400, JSON.stringify(body));
    const notRepo = await t.api<ApiError>('POST', '/api/links/git/pull', { mount: 'Skills/plain' });
    assert.deepEqual([notRepo.status, notRepo.json.code], [400, 'invalid']);
    await assert.rejects(fs.stat(path.join(clone, 'pwned')));
  });

  it('refuses proxied callers on all three endpoints even with the token', async () => {
    const proxied = { 'X-Forwarded-For': '203.0.113.9', Authorization: `Bearer ${t.token}`, 'Content-Type': 'application/json' };
    const fetchedBefore = (await status())['Skills/vendor']?.fetchedAt;
    assert.equal((await rawRequest(t.port, { path: '/api/links/git', headers: proxied })).status, 403);
    assert.equal((await rawRequest(t.port, { method: 'POST', path: '/api/links/git/fetch', headers: proxied, body: '{}' })).status, 403);
    assert.equal((await rawRequest(t.port, { method: 'POST', path: '/api/links/git/pull', headers: proxied, body: '{"mount":"Skills/vendor"}' })).status, 403);
    assert.equal((await rawRequest(t.port, { method: 'POST', path: '/api/links/git/%70ull', headers: proxied, body: '{"mount":"Skills/vendor"}' })).status, 403);
    assert.equal((await status())['Skills/vendor']?.fetchedAt, fetchedBefore, 'nothing was fetched');
    assert.equal((await rawRequest(t.port, { path: '/api/tickets', headers: proxied })).status, 200, 'the same caller is otherwise welcome');
  });

  it('a `git pull` run by hand in the clone reaches the tree, search and skill discovery without any API call', async () => {
    rmSync(path.join(origin, 'skills', 'alpha'), { recursive: true, force: true });
    for (const name of SECOND_WAVE) writeSkill(origin, name, 'wave2');
    g(origin, 'add', '-A');
    g(origin, 'commit', '--quiet', '-m', 'remove one skill, add eight more');

    g(clone, 'pull', '--quiet', '--ff-only'); // what the owner types in a terminal

    const deadline = Date.now() + 2000;
    for (;;) {
      const tree = (await t.api<TreeNode>('GET', '/api/tree')).json;
      const missing = SECOND_WAVE.filter((name) => !find(tree, `Skills/shared/${name}/SKILL.md`) || !find(tree, `Skills/shared/${name}/references/deep/notes.md`) || !find(tree, `Skills/shared/${name}/scripts/run.sh`));
      if (missing.length === 0 && !find(tree, 'Skills/shared/alpha')) break;
      assert.ok(Date.now() < deadline, `2 s after the pull the index still lacks: ${missing.join(', ')}`);
      await sleep(40);
    }
    for (const name of SECOND_WAVE) {
      assert.deepEqual((await t.api<SearchHit[]>('GET', `/api/search?q=wave2notes${name}`)).json.map((h) => h.path), [`Skills/shared/${name}/references/deep/notes.md`]);
    }
    const rpc = await fetch(`${t.base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_skills', arguments: {} } }),
    });
    const skills = (JSON.parse(((await rpc.json()) as { result: { content: { text: string }[] } }).result.content[0]?.text ?? '[]') as { path: string }[]).map((s) => s.path);
    for (const name of SECOND_WAVE) assert.ok(skills.includes(`Skills/shared/${name}/SKILL.md`), `list_skills: ${name}`);
  });

  it('reports repo:false with an error when git is not installed', async () => {
    const savedPath = process.env.PATH;
    process.env.PATH = path.join(plain, 'no-such-bin');
    try {
      const s = await linkGitStatus({ mount: 'Skills/shared', target: path.join(clone, 'skills'), realTarget: path.join(clone, 'skills'), readonly: false });
      assert.equal(s.repo, false);
      assert.match(s.error ?? '', /git is not installed/);
    } finally {
      process.env.PATH = savedPath;
    }
  });
});
