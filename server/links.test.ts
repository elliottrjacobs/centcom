/**
 * Linked folders. Every link target here is a throwaway directory under os.tmpdir();
 * nothing in this file ever points at a real repository, ~/CENTCOM or ~/.centcom.
 */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { ApiError, Doc, SearchHit, ServerInfo, TreeNode } from '../shared/types.ts';
import { decideAuth, isLoopbackOnlyPath, routedPaths, type AuthInput } from './auth.ts';
import { OWNER_PRINCIPAL } from './tokens.ts';
import { loadLinks, validateLink, type LinkEnv } from './links.ts';
import { openEvents, rawRequest, startTestServer, tempDir, viaOf, type TestServer } from './testkit.ts';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

function find(node: TreeNode, p: string): TreeNode | undefined {
  if (node.path === p) return node;
  for (const child of node.children ?? []) {
    const hit = find(child, p);
    if (hit) return hit;
  }
  return undefined;
}

const SKILL = '---\n# hand-written: keep this comment\nname:   release-notes\ndescription: "How to write release notes"\nversion: 2026-01-02\n---\n# Release notes\n\nWrite them plainly.\n';

/** A pretend skills repository, complete with a .git folder and a symlink trying to get out. */
async function makeSkillsRepo(outside: string): Promise<string> {
  const repo = await tempDir('link-repo');
  await fs.mkdir(path.join(repo, 'release-notes', 'references'), { recursive: true });
  await fs.mkdir(path.join(repo, '.git'), { recursive: true });
  await fs.writeFile(path.join(repo, 'release-notes', 'SKILL.md'), SKILL);
  await fs.writeFile(path.join(repo, 'release-notes', 'references', 'example.md'), 'An example with the word zygomorphic.\n');
  await fs.writeFile(path.join(repo, '.git', 'config'), '[remote "origin"]\n\turl = git@example.com:secret/skills.git\n');
  await fs.writeFile(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await fs.symlink(outside, path.join(repo, 'escape'));
  await fs.symlink(path.join(repo, 'release-notes'), path.join(repo, 'alias-of-release-notes'));
  return repo;
}

describe('link validation', () => {
  let vault: string;
  let configDir: string;
  let good: string;
  let env: LinkEnv;

  before(async () => {
    vault = await tempDir('lv-vault');
    configDir = await tempDir('lv-config');
    good = await tempDir('lv-target');
    await fs.mkdir(path.join(vault, 'Skills', 'inner'), { recursive: true });
    await fs.writeFile(path.join(good, 'a-file.txt'), 'x');
    env = { vaultRoot: vault, vaultReal: vault, configDir, home: os.homedir() };
  });
  after(async () => {
    for (const dir of [vault, configDir, good]) await fs.rm(dir, { recursive: true, force: true });
  });

  const reasonFor = async (entry: unknown): Promise<string> => {
    const check = await validateLink(entry, env);
    assert.equal(check.ok, false, `expected ${JSON.stringify(entry)} to be rejected`);
    return check.ok ? '' : check.reason;
  };

  it('accepts a plain external directory, defaulting readonly to false', async () => {
    const check = await validateLink({ mount: 'Skills/shared', target: good }, env);
    assert.deepEqual(check, { ok: true, link: { mount: 'Skills/shared', target: good, realTarget: good, readonly: false } });
    const ro = await validateLink({ mount: 'Projects/App/Skills/local', target: good, readonly: true }, env);
    assert.equal(ro.ok && ro.link.readonly, true);
  });

  it('rejects dangerous targets: /, home, anything containing home, the vault, inside it, around it, and the config dir', async () => {
    assert.match(await reasonFor({ mount: 'Skills/x', target: '/' }), /root|home|vault/);
    assert.match(await reasonFor({ mount: 'Skills/x', target: os.homedir() }), /home folder itself/);
    assert.match(await reasonFor({ mount: 'Skills/x', target: '~' }), /home folder itself/);
    assert.match(await reasonFor({ mount: 'Skills/x', target: path.dirname(os.homedir()) }), /contain your home/);
    assert.match(await reasonFor({ mount: 'Skills/x', target: vault }), /the vault or a folder inside it/);
    assert.match(await reasonFor({ mount: 'Skills/x', target: path.join(vault, 'Skills', 'inner') }), /the vault or a folder inside it/);
    assert.match(await reasonFor({ mount: 'Skills/x', target: path.dirname(vault) }), /contain the vault|home/);
    assert.match(await reasonFor({ mount: 'Skills/x', target: configDir }), /config folder/);
    assert.match(await reasonFor({ mount: 'Skills/x', target: path.dirname(configDir) }), /config folder|vault|home/);
  });

  it('rejects targets that are relative, missing, or not a directory', async () => {
    assert.match(await reasonFor({ mount: 'Skills/x', target: 'relative/path' }), /absolute/);
    assert.match(await reasonFor({ mount: 'Skills/x', target: path.join(good, 'nope') }), /does not exist/);
    assert.match(await reasonFor({ mount: 'Skills/x', target: path.join(good, 'a-file.txt') }), /not a directory/);
  });

  it('sees through a symlinked target: what counts is where it really points', async () => {
    const sneaky = path.join(good, 'to-the-vault');
    await fs.symlink(vault, sneaky);
    assert.match(await reasonFor({ mount: 'Skills/x', target: sneaky }), /the vault/);
  });

  it('rejects bad mounts: wrong root, a root folder itself, traversal, dot segments, absolute, overlapping', async () => {
    for (const mount of ['Elsewhere/x', 'Skills', '../Skills/x', 'Skills/../x', 'Skills/.hidden', '/Skills/x', 'Skills\\x', '.centcom/x', '']) {
      await reasonFor({ mount, target: good });
    }
    const first = await validateLink({ mount: 'Skills/a', target: good }, env);
    assert.ok(first.ok);
    const accepted = first.ok ? [first.link] : [];
    assert.equal((await validateLink({ mount: 'Skills/a', target: good }, env, accepted)).ok, false, 'duplicate');
    assert.equal((await validateLink({ mount: 'Skills/a/nested', target: good }, env, accepted)).ok, false, 'nested inside another link');
    assert.equal((await validateLink({ mount: 'Skills/b', target: good }, env, accepted)).ok, true);
  });

  it('rejects malformed entries without throwing', async () => {
    for (const entry of [null, 'Skills/x', 42, [], {}, { mount: 'Skills/x' }, { mount: 1, target: good }, { mount: 'Skills/x', target: good, readonly: 'yes' }]) await reasonFor(entry);
  });

  it('loadLinks drops the bad, keeps the good, creates the missing symlink, and never replaces a real folder', async () => {
    const loaded = await loadLinks(
      [{ mount: 'Skills/shared', target: good }, { mount: 'Skills/bad', target: '/' }, 'garbage', { mount: 'Skills/inner', target: good }],
      env,
    );
    assert.deepEqual(loaded.links.map((l) => l.mount), ['Skills/shared']);
    assert.equal(loaded.dropped.length, 3);
    assert.match(loaded.dropped[2]?.reason ?? '', /will not replace it/);
    assert.equal(await fs.realpath(path.join(vault, 'Skills', 'shared')), good);
    assert.equal((await fs.lstat(path.join(vault, 'Skills', 'inner'))).isSymbolicLink(), false);
    assert.deepEqual(await loadLinks({ not: 'an array' }, env), { links: [], dropped: [{ entry: { not: 'an array' }, reason: '"links" must be an array' }] });
    assert.deepEqual(await loadLinks(undefined, env), { links: [], dropped: [] });
  });
});

describe('reload is loopback-only, even with the right token (decision function)', () => {
  const TOKEN = 'c'.repeat(64);
  const input = (o: Partial<AuthInput>): AuthInput => ({ remoteAddress: '100.64.0.9', forwarded: false, method: 'POST', pathname: '/api/links/reload', authorization: `Bearer ${TOKEN}`, queryToken: undefined, verify: (t) => (t === TOKEN ? OWNER_PRINCIPAL : null), ...o });

  it('refuses a non-loopback peer that presents the correct token', () => {
    const d = decideAuth(input({}));
    assert.deepEqual([d.ok, !d.ok && d.status], [false, 403]);
    // …while the same peer and token are fine everywhere else.
    assert.equal(viaOf(decideAuth(input({ pathname: '/api/tickets' }))), 'bearer');
  });

  it('refuses a proxied request even when the socket is loopback', () => {
    assert.equal(decideAuth(input({ remoteAddress: '127.0.0.1', forwarded: true })).ok, false);
  });

  it('allows this machine', () => {
    assert.equal(viaOf(decideAuth(input({ remoteAddress: '127.0.0.1', authorization: undefined }))), 'loopback');
    assert.equal(viaOf(decideAuth(input({ remoteAddress: '::1' }))), 'loopback');
  });

  it('cannot be dodged with another spelling of the path', () => {
    for (const p of ['/api/links/reload/', '/API/links/reload', '//api//links/reload', '/api/links', '/api/links/anything']) assert.equal(isLoopbackOnlyPath(p), true, p);
    for (const raw of ['/api/links/%72eload', '/api/%6Cinks/reload', '/%61pi/links/reload', '/api/x/../links/reload', '/api/links/./reload']) {
      const routed = routedPaths(raw);
      assert.ok(routed);
      assert.equal(decideAuth(input({ pathname: routed.pathname, variants: routed.variants })).ok, false, raw);
    }
  });

  it('an encoded path can no longer pose as a public one to skip the token', () => {
    for (const raw of ['/%61pi/tickets', '/%2561pi/tickets', '/ap%69/doc?path=AGENTS.md', '/%6Dcp']) {
      const routed = routedPaths(raw);
      assert.ok(routed);
      const d = decideAuth(input({ method: 'GET', pathname: routed.pathname, variants: routed.variants, authorization: undefined }));
      if (raw.includes('%25')) continue; // double-encoded: not an API path to any router, public is correct
      assert.deepEqual([d.ok, !d.ok && d.status], [false, 401], raw);
    }
  });
});

describe('linked folders over HTTP', () => {
  let t: TestServer;
  let repo: string;
  let readonlyRepo: string;
  let outside: string;
  let notAllowlisted: string;

  const upload = (dir: string, name: string) =>
    fetch(`${t.base}/api/upload?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(name)}`, { method: 'POST', body: new Uint8Array(PNG), headers: { 'Content-Type': 'application/octet-stream' } });

  before(async () => {
    outside = await tempDir('link-outside');
    await fs.writeFile(path.join(outside, 'secret.md'), 'must never be served');
    repo = await makeSkillsRepo(outside);
    readonlyRepo = await makeSkillsRepo(outside);
    notAllowlisted = await tempDir('link-unlisted');
    await fs.writeFile(path.join(notAllowlisted, 'ghost.md'), 'not in the allowlist: xenolith');

    t = await startTestServer({
      config: (vault) => ({ links: [{ mount: 'Skills/shared', target: repo }, { mount: 'Skills/vendor', target: readonlyRepo, readonly: true }, { mount: 'Skills/bogus', target: '/' }] }),
      prepare: async (vault) => {
        await fs.mkdir(path.join(vault, 'Skills'), { recursive: true });
        await fs.mkdir(path.join(vault, 'Library'), { recursive: true });
        await fs.symlink(notAllowlisted, path.join(vault, 'Skills', 'unlisted'));
        // Points INTO an allowlisted target, but from somewhere that is not its mount.
        await fs.symlink(repo, path.join(vault, 'Library', 'backdoor'));
      },
    });
  });
  after(async () => {
    await t.close();
    for (const dir of [repo, readonlyRepo, outside, notAllowlisted]) await fs.rm(dir, { recursive: true, force: true });
  });

  it('reports only the valid links in /api/info and mounts them as real symlinks', async () => {
    const info = (await t.api<ServerInfo>('GET', '/api/info')).json;
    assert.deepEqual(info.links, [
      { mount: 'Skills/shared', target: repo, readonly: false },
      { mount: 'Skills/vendor', target: readonlyRepo, readonly: true },
    ]);
    assert.equal((await fs.lstat(path.join(t.vault, 'Skills', 'shared'))).isSymbolicLink(), true);
    assert.equal(await fs.realpath(path.join(t.vault, 'Skills', 'shared')), repo);
    await assert.rejects(fs.lstat(path.join(t.vault, 'Skills', 'bogus')), 'an invalid link is never mounted');
  });

  it('shows an allowlisted link in the tree with linked:true (mount node only), children listed', async () => {
    const tree = (await t.api<TreeNode>('GET', '/api/tree')).json;
    const mount = find(tree, 'Skills/shared');
    assert.equal(mount?.type, 'dir');
    assert.equal(mount?.linked, true);
    assert.deepEqual(mount?.children?.map((c) => c.name), ['release-notes']);
    const skillDir = find(tree, 'Skills/shared/release-notes');
    assert.equal(skillDir?.linked, undefined, 'only the mount node is flagged');
    assert.deepEqual(skillDir?.children?.map((c) => c.name), ['references', 'SKILL.md']);
    assert.equal(find(tree, 'Skills/vendor')?.linked, true);
    assert.equal(find(tree, 'Skills')?.linked, undefined);
  });

  it('skips symlinks nested inside a link, and never shows its .git', async () => {
    const tree = (await t.api<TreeNode>('GET', '/api/tree')).json;
    for (const p of ['Skills/shared/escape', 'Skills/shared/alias-of-release-notes', 'Skills/shared/.git']) assert.equal(find(tree, p), undefined, p);
    assert.equal((await t.api('GET', '/api/doc?path=Skills/shared/escape/secret.md')).status, 403, 'chained escape');
    assert.equal((await t.api('GET', '/api/raw/Skills/shared/escape/secret.md')).status, 403);
    assert.equal((await t.api('PUT', '/api/doc', { path: 'Skills/shared/escape/planted.md', body: 'x' })).status, 403);
    await assert.rejects(fs.stat(path.join(outside, 'planted.md')));
  });

  it('.git/config inside a link target is unreachable by every route', async () => {
    for (const [method, url, body] of [
      ['GET', '/api/doc?path=Skills/shared/.git/config'],
      ['GET', '/api/raw/Skills/shared/.git/config'],
      ['GET', '/api/raw/Skills/shared/%2Egit/config'],
      ['PUT', '/api/doc', { path: 'Skills/shared/.git/config', body: 'pwned' }],
      ['POST', '/api/doc', { path: 'Skills/shared/.git/hooks/pre-commit', body: '#!/bin/sh\n' }],
      ['DELETE', '/api/doc?path=Skills/shared/.git'],
      ['POST', '/api/move', { from: 'Skills/shared/.git/config', to: 'Library/config.md' }],
      ['POST', '/api/move', { from: 'Skills/shared/release-notes/SKILL.md', to: 'Skills/shared/.git/x.md' }],
      ['POST', '/api/duplicate', { path: 'Skills/shared/.git' }],
    ] as [string, string, unknown?][]) {
      const res = await t.api<ApiError>(method, url, body);
      assert.equal(res.status, 403, `${method} ${url}`);
    }
    assert.match(await fs.readFile(path.join(repo, '.git', 'config'), 'utf8'), /secret\/skills\.git/);
    assert.deepEqual((await t.api<SearchHit[]>('GET', '/api/search?q=secret')).json, [], '.git is not indexed');
  });

  it('a symlink that is not allowlisted is absent from the tree and refused by every route', async () => {
    const tree = (await t.api<TreeNode>('GET', '/api/tree')).json;
    assert.equal(find(tree, 'Skills/unlisted'), undefined);
    assert.equal(find(tree, 'Library/backdoor'), undefined, 'pointing into an allowlisted target from elsewhere does not count');
    assert.deepEqual((await t.api<SearchHit[]>('GET', '/api/search?q=xenolith')).json, []);

    for (const base of ['Skills/unlisted', 'Library/backdoor']) {
      const file = base === 'Skills/unlisted' ? `${base}/ghost.md` : `${base}/release-notes/SKILL.md`;
      for (const [method, url, body] of [
        ['GET', `/api/doc?path=${file}`],
        ['GET', `/api/raw/${file}`],
        ['PUT', '/api/doc', { path: file, body: 'x' }],
        ['POST', '/api/doc', { path: `${base}/new.md`, body: 'x' }],
        ['POST', '/api/folder', { path: `${base}/sub` }],
        ['DELETE', `/api/doc?path=${file}`],
        ['DELETE', `/api/doc?path=${base}`],
        ['POST', '/api/move', { from: file, to: 'Library/stolen.md' }],
        ['POST', '/api/move', { from: 'README.md', to: `${base}/README.md` }],
        ['POST', '/api/duplicate', { path: file }],
      ] as [string, string, unknown?][]) {
        const res = await t.api<ApiError>(method, url, body);
        assert.ok(res.status === 403 || res.status === 404, `${method} ${url} → ${res.status}`);
      }
      assert.ok([403, 404].includes((await upload(base, 'a.png')).status));
    }
    assert.equal(await fs.readFile(path.join(notAllowlisted, 'ghost.md'), 'utf8'), 'not in the allowlist: xenolith');
    assert.deepEqual((await fs.readdir(notAllowlisted)).sort(), ['ghost.md']);
  });

  it('linked docs are readable and searchable like any other', async () => {
    const doc = (await t.api<Doc>('GET', '/api/doc?path=Skills/shared/release-notes/SKILL.md')).json;
    assert.equal(doc.frontmatter.name, 'release-notes');
    assert.equal(doc.body, '# Release notes\n\nWrite them plainly.');
    const hits = (await t.api<SearchHit[]>('GET', '/api/search?q=zygomorphic')).json;
    assert.deepEqual(hits.map((h) => h.path).sort(), ['Skills/shared/release-notes/references/example.md', 'Skills/vendor/release-notes/references/example.md']);
    const raw = await fetch(`${t.base}/api/raw/Skills/shared/release-notes/references/example.md`);
    assert.equal(await raw.text(), 'An example with the word zygomorphic.\n');
  });

  it('linked skills show up in the MCP skills library, flagged as linked', async () => {
    const res = await fetch(`${t.base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_skills', arguments: {} } }),
    });
    const payload = (await res.json()) as { result: { content: { text: string }[] } };
    const skills = JSON.parse(payload.result.content[0]?.text ?? '[]') as { name: string; group?: string; linked?: boolean; path: string }[];
    assert.deepEqual(
      skills.map((s) => [s.name, s.group, s.linked, s.path]),
      [
        ['release-notes', 'shared', true, 'Skills/shared/release-notes/SKILL.md'],
        ['release-notes', 'vendor', true, 'Skills/vendor/release-notes/SKILL.md'],
      ],
    );
  });

  it('frontmatter bytes are untouched when only the body changes, even if the editor sends the frontmatter back', async () => {
    const file = path.join(repo, 'release-notes', 'SKILL.md');
    const doc = (await t.api<Doc>('GET', '/api/doc?path=Skills/shared/release-notes/SKILL.md')).json;
    const saved = await t.api<Doc>('PUT', '/api/doc', { path: doc.path, body: '# Release notes\n\nWrite them plainly. And briefly.', frontmatter: doc.frontmatter, ifMatch: doc.mtime, agent: 'codex' });
    assert.equal(saved.status, 200);
    const head = SKILL.slice(0, SKILL.indexOf('# Release notes'));
    assert.equal(await fs.readFile(file, 'utf8'), `${head}# Release notes\n\nWrite them plainly. And briefly.\n`, 'the write landed in the real file, comment and spacing intact');
    assert.deepEqual(saved.json.frontmatter, doc.frontmatter);
  });

  it('YAML is rewritten only when a key really changes', async () => {
    const file = path.join(repo, 'release-notes', 'SKILL.md');
    const before = await fs.readFile(file, 'utf8');
    await t.api('PUT', '/api/doc', { path: 'Skills/shared/release-notes/SKILL.md', frontmatter: {} });
    await t.api('PUT', '/api/doc', { path: 'Skills/shared/release-notes/SKILL.md', frontmatter: { name: 'release-notes' } });
    assert.equal(await fs.readFile(file, 'utf8'), before, 'same values → same bytes');

    await t.api('PUT', '/api/doc', { path: 'Skills/shared/release-notes/SKILL.md', frontmatter: { description: 'Shorter' } });
    const after = await fs.readFile(file, 'utf8');
    assert.match(after, /^---\nname: release-notes\ndescription: Shorter\nversion: '2026-01-02'\n---\n# Release notes/);
    assert.doesNotMatch(after, /hand-written/, 'a real change re-serialises the block');
  });

  it('keeps a file’s final-newline convention, with or without frontmatter', async () => {
    const bare = path.join(repo, 'no-newline.md');
    await fs.writeFile(bare, 'no newline at the end');
    await fs.writeFile(path.join(repo, 'crlf.md'), '---\r\ntitle: Windows\r\n---\r\nline one\r\nline two\r\n');
    await t.api('POST', '/api/links/reload');
    await t.api('PUT', '/api/doc', { path: 'Skills/shared/no-newline.md', body: 'still none' });
    assert.equal(await fs.readFile(bare, 'utf8'), 'still none');

    const crlf = (await t.api<Doc>('GET', '/api/doc?path=Skills/shared/crlf.md')).json;
    assert.equal(crlf.body, 'line one\r\nline two');
    await t.api('PUT', '/api/doc', { path: 'Skills/shared/crlf.md', body: 'line one\r\nline 2', frontmatter: crlf.frontmatter });
    assert.equal(await fs.readFile(path.join(repo, 'crlf.md'), 'utf8'), '---\r\ntitle: Windows\r\n---\r\nline one\r\nline 2\r\n');
  });

  it('normal CRUD works inside a writable link, and lands in the real folder', async () => {
    assert.equal((await t.api('POST', '/api/doc', { path: 'Skills/shared/new-skill/SKILL.md', body: '# New', frontmatter: { name: 'new-skill' } })).status, 201);
    assert.match(await fs.readFile(path.join(repo, 'new-skill', 'SKILL.md'), 'utf8'), /name: new-skill/);
    assert.equal((await t.api('POST', '/api/folder', { path: 'Skills/shared/new-skill/scripts' })).status, 201);
    assert.equal((await upload('Skills/shared/new-skill', 'diagram.png')).status, 201);
    assert.deepEqual((await t.api('POST', '/api/move', { from: 'Skills/shared/new-skill/SKILL.md', to: 'Skills/shared/new-skill/README.md' })).json, { path: 'Skills/shared/new-skill/README.md' });
    assert.deepEqual((await t.api('POST', '/api/duplicate', { path: 'Skills/shared/new-skill/README.md' })).json, { path: 'Skills/shared/new-skill/README copy.md' });
    assert.deepEqual((await fs.readdir(path.join(repo, 'new-skill'))).sort(), ['README copy.md', 'README.md', 'diagram.png', 'scripts']);

    // Out of the link into the vault proper, and back in.
    assert.equal((await t.api('POST', '/api/move', { from: 'Skills/shared/new-skill/README copy.md', to: 'Library/from-link.md' })).status, 200);
    assert.equal((await t.api('POST', '/api/move', { from: 'Library/from-link.md', to: 'Skills/shared/new-skill/back.md' })).status, 200);
    assert.equal(await fs.readFile(path.join(repo, 'new-skill', 'back.md'), 'utf8'), '---\nname: new-skill\n---\n# New\n');
  });

  it('soft delete inside a link moves the real file to the vault trash and restore brings it back', async () => {
    const del = await t.api<{ trashId: string }>('DELETE', '/api/doc?path=Skills/shared/new-skill/back.md');
    assert.equal(del.status, 200);
    await assert.rejects(fs.stat(path.join(repo, 'new-skill', 'back.md')));
    assert.equal((await fs.stat(path.join(t.vault, '.trash', del.json.trashId))).isFile(), true);
    assert.deepEqual((await t.api('POST', '/api/trash/restore', { id: del.json.trashId })).json, { path: 'Skills/shared/new-skill/back.md' });
    assert.equal((await fs.stat(path.join(repo, 'new-skill', 'back.md'))).isFile(), true);

    const folder = await t.api<{ trashId: string }>('DELETE', '/api/doc?path=Skills/shared/new-skill');
    assert.equal(folder.status, 200);
    await assert.rejects(fs.stat(path.join(repo, 'new-skill')));
    assert.equal((await fs.lstat(path.join(t.vault, 'Skills', 'shared'))).isSymbolicLink(), true, 'the mount itself is untouched');
    assert.equal((await fs.stat(path.join(repo, 'release-notes', 'SKILL.md'))).isFile(), true);
  });

  it('a read-only link refuses every mutation with 403 forbidden', async () => {
    const before = await fs.readFile(path.join(readonlyRepo, 'release-notes', 'SKILL.md'), 'utf8');
    for (const [method, url, body] of [
      ['PUT', '/api/doc', { path: 'Skills/vendor/release-notes/SKILL.md', body: 'changed' }],
      ['PUT', '/api/doc', { path: 'Skills/vendor/brand-new.md', body: 'x' }],
      ['POST', '/api/doc', { path: 'Skills/vendor/brand-new.md', body: 'x' }],
      ['DELETE', '/api/doc?path=Skills/vendor/release-notes/SKILL.md'],
      ['DELETE', '/api/doc?path=Skills/vendor/release-notes'],
      ['POST', '/api/folder', { path: 'Skills/vendor/new-folder' }],
      ['POST', '/api/move', { from: 'Skills/vendor/release-notes/SKILL.md', to: 'Library/taken.md' }],
      ['POST', '/api/move', { from: 'Skills/vendor/release-notes/SKILL.md', to: 'Skills/vendor/release-notes/RENAMED.md' }],
      ['POST', '/api/move', { from: 'README.md', to: 'Skills/vendor/README.md' }],
      ['POST', '/api/move', { from: 'Skills/shared/release-notes/references/example.md', to: 'Skills/vendor/example.md' }],
      ['POST', '/api/duplicate', { path: 'Skills/vendor/release-notes/SKILL.md' }],
      ['POST', '/api/duplicate', { path: 'Skills/vendor/release-notes' }],
    ] as [string, string, unknown?][]) {
      const res = await t.api<ApiError>(method, url, body);
      assert.equal(res.status, 403, `${method} ${url} ${JSON.stringify(body ?? '')}`);
      assert.equal(res.json.code, 'forbidden');
      assert.match(res.json.error, /read-only/);
    }
    assert.equal((await upload('Skills/vendor', 'a.png')).status, 403);
    assert.equal((await upload('Skills/vendor/release-notes', 'a.png')).status, 403);
    assert.equal(await fs.readFile(path.join(readonlyRepo, 'release-notes', 'SKILL.md'), 'utf8'), before);
    assert.deepEqual((await fs.readdir(readonlyRepo)).sort(), ['.git', 'alias-of-release-notes', 'escape', 'release-notes']);
    assert.equal((await t.api('GET', '/api/doc?path=Skills/vendor/release-notes/SKILL.md')).status, 200, 'reading is fine');
  });

  it('a mount, and any folder containing one, cannot be moved, renamed, deleted or duplicated (writable or not)', async () => {
    await t.api('POST', '/api/projects', { name: 'Holder', key: 'HLD' });
    const projectRepo = await tempDir('link-project');
    await fs.writeFile(path.join(projectRepo, 'note.md'), 'inside the project link');
    const cfgPath = path.join(t.configDir, 'config.json');
    const cfg = JSON.parse(await fs.readFile(cfgPath, 'utf8')) as { links: unknown[] };
    cfg.links.push({ mount: 'Projects/Holder/Skills/local', target: projectRepo });
    await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2));
    assert.equal((await t.api<{ links: unknown[] }>('POST', '/api/links/reload')).json.links.length, 3);

    for (const mount of ['Skills/shared', 'Skills/vendor', 'Projects/Holder/Skills/local']) {
      for (const [method, url, body] of [
        ['DELETE', `/api/doc?path=${mount}`],
        ['POST', '/api/move', { from: mount, to: 'Library/moved-link' }],
        ['POST', '/api/move', { from: mount, to: `${mount}-renamed` }],
        ['POST', '/api/move', { from: mount, to: mount }],
        ['POST', '/api/duplicate', { path: mount }],
      ] as [string, string, unknown?][]) {
        const res = await t.api<ApiError>(method, url, body);
        assert.equal(res.status, 403, `${method} ${url} ${JSON.stringify(body ?? '')}`);
        assert.match(res.json.error, /linked folder/);
      }
    }
    // Ancestors that contain a mount.
    for (const [method, url, body] of [
      ['DELETE', '/api/doc?path=Projects/Holder/Skills'],
      ['DELETE', '/api/doc?path=Projects/Holder'],
      ['DELETE', '/api/projects/Holder'],
      ['PATCH', '/api/projects/Holder', { name: 'Holder Renamed' }],
      ['POST', '/api/move', { from: 'Projects/Holder/Skills', to: 'Projects/Holder/Abilities' }],
      ['POST', '/api/move', { from: 'Projects/Holder', to: 'Projects/Elsewhere' }],
      ['POST', '/api/duplicate', { path: 'Projects/Holder' }],
    ] as [string, string, unknown?][]) {
      const res = await t.api<ApiError>(method, url, body);
      assert.equal(res.status, 403, `${method} ${url} ${JSON.stringify(body ?? '')}`);
      assert.match(res.json.error, /Projects\/Holder\/Skills\/local/, 'the message names the link');
    }
    assert.equal(await fs.realpath(path.join(t.vault, 'Projects/Holder/Skills/local')), projectRepo);
    assert.equal(await fs.readFile(path.join(projectRepo, 'note.md'), 'utf8'), 'inside the project link');
    assert.equal((await t.api('PATCH', '/api/projects/Holder', { summary: 'still editable' })).status, 200, 'the project itself is not frozen');
    await fs.rm(projectRepo, { recursive: true, force: true });
  });

  it('there is no API to add, change or remove a link', async () => {
    for (const [method, url, body] of [
      ['POST', '/api/links', { mount: 'Skills/evil', target: '/etc' }],
      ['PUT', '/api/links', { links: [] }],
      ['DELETE', '/api/links?mount=Skills/shared'],
      ['POST', '/api/links/add', { mount: 'Skills/evil', target: '/etc' }],
      ['POST', '/api/links/reload', { links: [{ mount: 'Skills/evil', target: '/etc' }] }],
    ] as [string, string, unknown?][]) {
      await t.api(method, url, body);
    }
    const links = (await t.api<ServerInfo>('GET', '/api/info')).json.links.map((l) => l.mount);
    assert.equal(links.includes('Skills/evil'), false);
    await assert.rejects(fs.lstat(path.join(t.vault, 'Skills', 'evil')));
    // Planting a symlink through the API is impossible too: there is simply no such operation,
    // and a hand-made one that is not in the config stays invisible (tested above).
  });

  it('reload: picks up config changes, refuses proxied callers even with the token, and watches link targets', async () => {
    const proxied = { 'X-Forwarded-For': '203.0.113.9', Authorization: `Bearer ${t.token}`, 'Content-Type': 'application/json' };
    assert.equal((await rawRequest(t.port, { method: 'POST', path: '/api/links/reload', headers: proxied, body: '{}' })).status, 403);
    assert.equal((await rawRequest(t.port, { method: 'POST', path: '/api/links/%72eload', headers: proxied, body: '{}' })).status, 403);
    assert.equal((await rawRequest(t.port, { path: '/api/tickets', headers: proxied })).status, 200, 'the same caller is otherwise welcome');
    assert.equal((await rawRequest(t.port, { path: '/%61pi/tickets', headers: { 'X-Forwarded-For': '203.0.113.9' } })).status, 401, 'an encoded path does not skip the token');

    const events = await openEvents(t.port);
    try {
      await fs.writeFile(path.join(repo, 'release-notes', 'added-on-disk.md'), '---\ntitle: Added in the repo\n---\nquixotic\n');
      await events.waitFor((e) => e.type === 'doc' && e.path === 'Skills/shared/release-notes/added-on-disk.md');
      assert.equal((await t.api<SearchHit[]>('GET', '/api/search?q=quixotic')).json[0]?.path, 'Skills/shared/release-notes/added-on-disk.md');
      await fs.writeFile(path.join(repo, '.git', 'index'), 'binary-ish');
      await fs.writeFile(path.join(repo, 'release-notes', 'second.md'), 'second\n');
      await events.waitFor((e) => e.type === 'doc' && e.path === 'Skills/shared/release-notes/second.md');
      assert.equal(events.events.some((e) => typeof e.path === 'string' && e.path.includes('.git')), false, '.git is not watched');

      // Remove one link from the config by hand, then reload.
      const cfgPath = path.join(t.configDir, 'config.json');
      const cfg = JSON.parse(await fs.readFile(cfgPath, 'utf8')) as { links: { mount: string }[] };
      cfg.links = cfg.links.filter((l) => l.mount === 'Skills/shared');
      await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2));
      const before = events.events.length;
      const reloaded = await t.api<{ links: { mount: string }[] }>('POST', '/api/links/reload');
      assert.deepEqual(reloaded.json.links.map((l) => l.mount), ['Skills/shared']);
      assert.ok(events.events.slice(before).some((e) => e.type === 'tree'), 'reload broadcasts a tree event');
    } finally {
      events.close();
    }
    // The vendor symlink is still on disk, but it is no longer allowlisted: gone from the tree, refused by the API.
    const tree = (await t.api<TreeNode>('GET', '/api/tree')).json;
    assert.equal(find(tree, 'Skills/vendor'), undefined);
    assert.equal((await t.api('GET', '/api/doc?path=Skills/vendor/release-notes/SKILL.md')).status, 403);
    assert.equal((await t.api('GET', '/api/doc?path=Skills/shared/release-notes/SKILL.md')).status, 200);
  });
});
