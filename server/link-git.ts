/**
 * Git awareness for linked folders. A link is often a subfolder of a clone; when the clone is
 * behind its remote, CENTCOM would silently show stale content. This makes that visible
 * (`status`, local refs only) and fixable (`fetch`, `pull --ff-only`) by the machine's owner.
 *
 * Exec safety: `git` is run with `execFile` (never a shell) and a FIXED argument list. The only
 * thing a client can influence is WHICH configured link is acted on, by naming its mount, and
 * that name is matched exactly against the local allowlist; it never becomes an argument.
 * The directory git runs in is the link's real target from the config file.
 */
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { LinkGitStatus } from '../shared/types.ts';
import type { Ctx } from './context.ts';
import { conflict, HttpError, invalid, notFound } from './errors.ts';
import { mapLimit, mtimeOf } from './fsutil.ts';
import type { VaultLink } from './paths.ts';
import { reconcileFromDisk } from './reconcile.ts';

const GIT_TIMEOUT_MS = 30_000;
const MAX_ERROR_CHARS = 200;

interface GitRun {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** `git` itself could not be started (not installed / not on PATH). */
  missing: boolean;
  timedOut: boolean;
}

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' };
  // Whatever started the server must not be able to point git at some other repository.
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_NAMESPACE', 'GIT_OBJECT_DIRECTORY']) delete env[key];
  return env;
}

/** `args` is always a literal list written in this file. Never pass client input. */
function git(cwd: string, args: readonly string[]): Promise<GitRun> {
  return new Promise((resolve) => {
    execFile('git', [...args], { cwd, timeout: GIT_TIMEOUT_MS, env: gitEnv(), maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const failure = err as (NodeJS.ErrnoException & { killed?: boolean }) | null;
      resolve({
        ok: !failure,
        stdout: String(stdout),
        stderr: String(stderr),
        missing: failure?.code === 'ENOENT',
        timedOut: failure?.killed === true,
      });
    });
  });
}

/** First line of git's complaint, with any `user:secret@` in a URL removed. */
function briefError(run: GitRun): string {
  if (run.timedOut) return `timed out after ${GIT_TIMEOUT_MS / 1000} s`;
  const line = run.stderr.split('\n').map((l) => l.trim()).find(Boolean) ?? 'unknown error';
  return line.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, '$1').slice(0, MAX_ERROR_CHARS);
}

/** Parse `git status --porcelain=v2 --branch`. Exported for tests. */
export function parsePorcelainV2(text: string): Pick<LinkGitStatus, 'branch' | 'upstream' | 'ahead' | 'behind' | 'dirty'> {
  const out: Pick<LinkGitStatus, 'branch' | 'upstream' | 'ahead' | 'behind' | 'dirty'> = { dirty: false };
  for (const line of text.split('\n')) {
    if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length).trim();
      out.branch = head === '(detached)' ? 'HEAD (detached)' : head;
    } else if (line.startsWith('# branch.upstream ')) {
      out.upstream = line.slice('# branch.upstream '.length).trim();
    } else if (line.startsWith('# branch.ab ')) {
      const m = /^# branch\.ab \+(\d+) -(\d+)/.exec(line);
      if (m) {
        out.ahead = Number(m[1]);
        out.behind = Number(m[2]);
      }
    } else if (line.length > 0 && !line.startsWith('#') && !line.startsWith('? ') && !line.startsWith('! ')) {
      // Tracked changes only: modified, staged, renamed, unmerged (`1`/`2`/`u`). Untracked (`?`)
      // and ignored (`!`) files do NOT count. A repo with a scratch folder that is never
      // committed would otherwise be "dirty" forever and could never be pulled from the app,
      // and they don't endanger a fast-forward: git itself refuses, leaving everything intact,
      // if an incoming file would overwrite an untracked one.
      out.dirty = true;
    }
  }
  // An upstream that is configured but whose ref is gone reports no ahead/behind: treat as "tracks nothing".
  if (out.upstream !== undefined && out.ahead === undefined) delete out.upstream;
  return out;
}

interface RepoLocation {
  top: string;
  fetchHead: string;
}

async function locateRepo(link: VaultLink): Promise<{ repo: RepoLocation } | { repo: null; error?: string }> {
  // The target may be a subfolder of the clone; git finds the work tree above it.
  const run = await git(link.realTarget, ['-C', link.realTarget, 'rev-parse', '--show-toplevel', '--git-path', 'FETCH_HEAD']);
  if (run.missing) return { repo: null, error: 'git is not installed (or not on PATH).' };
  if (!run.ok) {
    // "not a git repository" is the ordinary case and not an error worth showing.
    return /not a git repository/i.test(run.stderr) ? { repo: null } : { repo: null, error: `git could not read this folder: ${briefError(run)}` };
  }
  const [top, fetchHead] = run.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!top || !path.isAbsolute(top)) return { repo: null, error: 'git reported no work tree for this folder.' };
  return { repo: { top, fetchHead: path.resolve(link.realTarget, fetchHead ?? path.join(top, '.git', 'FETCH_HEAD')) } };
}

/** Local refs only: nothing here touches the network or takes a lock in the repository. */
export async function linkGitStatus(link: VaultLink): Promise<LinkGitStatus & { top?: string }> {
  const located = await locateRepo(link);
  if (!located.repo) return { mount: link.mount, repo: false, ...(located.error ? { error: located.error } : {}) };
  const { top, fetchHead } = located.repo;

  const status: LinkGitStatus & { top?: string } = { mount: link.mount, repo: true, top };
  const run = await git(top, ['-C', top, '--no-optional-locks', 'status', '--porcelain=v2', '--branch', '--untracked-files=normal']);
  if (run.ok) Object.assign(status, parsePorcelainV2(run.stdout));
  else status.error = `git status failed: ${briefError(run)}`;

  try {
    status.fetchedAt = mtimeOf(await fs.stat(fetchHead));
  } catch {
    /* never fetched (a fresh clone has no FETCH_HEAD) */
  }
  return status;
}

function publicStatus(status: LinkGitStatus & { top?: string }): LinkGitStatus {
  const { top: _top, ...rest } = status;
  return rest;
}

function requireLink(ctx: Ctx, mount: unknown): VaultLink {
  if (typeof mount !== 'string' || !mount) throw invalid('mount is required.');
  // Exact match against the allowlist from the local config file. Nothing else about the request is used.
  const link = (ctx.vault.links ?? []).find((l) => l.mount === mount);
  if (!link) throw notFound(`"${mount.slice(0, 200)}" is not a linked folder.`);
  return link;
}

/** One status per valid link, in config order. */
export async function allLinkGitStatus(ctx: Ctx): Promise<LinkGitStatus[]> {
  const links = ctx.vault.links ?? [];
  const out: LinkGitStatus[] = new Array<LinkGitStatus>(links.length);
  await mapLimit(links.map((link, i) => ({ link, i })), 4, async ({ link, i }) => {
    out[i] = publicStatus(await linkGitStatus(link));
  });
  return out;
}

/**
 * `git fetch --quiet` for one link (by mount) or all of them, then fresh statuses. Several links
 * into one clone fetch it once. A failed fetch is reported on that link's status, not thrown:
 * being offline must not hide the state of the other links.
 */
export async function fetchLinks(ctx: Ctx, mount?: unknown): Promise<LinkGitStatus[]> {
  const links = mount === undefined || mount === null ? (ctx.vault.links ?? []) : [requireLink(ctx, mount)];
  const fetched = new Map<string, string | null>();
  const out: LinkGitStatus[] = [];
  for (const link of links) {
    const located = await locateRepo(link);
    let fetchError: string | null = null;
    if (located.repo) {
      const { top } = located.repo;
      if (!fetched.has(top)) {
        const run = await ctx.locks.run(`git:${top}`, () => git(top, ['-C', top, 'fetch', '--quiet']));
        fetched.set(top, run.ok ? null : `git fetch failed: ${briefError(run)}`);
      }
      fetchError = fetched.get(top) ?? null;
    }
    const status = publicStatus(await linkGitStatus(link));
    out.push(fetchError && !status.error ? { ...status, error: fetchError } : status);
  }
  return out;
}

/**
 * Fast-forward one link's clone. Refused (409) unless that is provably safe: a clean work tree,
 * an upstream, and nothing local that the remote lacks. A read-only link may still be pulled:
 * `readonly` governs edits made through the API, not the owner updating their own clone.
 */
export async function pullLink(ctx: Ctx, mount: unknown): Promise<LinkGitStatus> {
  const link = requireLink(ctx, mount);
  const before = await linkGitStatus(link);
  if (!before.repo || !before.top) throw invalid(before.error ? `"${link.mount}" cannot be pulled: ${before.error}` : `"${link.mount}" is not inside a git repository.`);
  const top = before.top;

  return ctx.locks.run(`git:${top}`, async () => {
    const status = await linkGitStatus(link);
    if (status.error) throw conflict(`"${link.mount}" cannot be pulled: ${status.error}`);
    if (status.dirty) throw conflict(`"${link.mount}" has uncommitted changes. Commit or stash them in ${top} first.`);
    if (!status.upstream) throw conflict(`"${link.mount}" is on ${status.branch ?? 'a branch'} with no upstream to pull from.`);
    if ((status.ahead ?? 0) > 0) throw conflict(`"${link.mount}" has ${status.ahead} local commit(s) that are not on ${status.upstream}. Push or rebase in ${top} first.`);

    // --ff-only: never creates a merge commit. --no-rebase: a `pull.rebase` in the owner's git config must not turn this into a rebase.
    const run = await git(top, ['-C', top, 'pull', '--ff-only', '--no-rebase', '--quiet']);
    if (!run.ok) throw new HttpError(502, `git pull failed: ${briefError(run)}`);

    // Do not wait for file events: bring the index in line now, and always tell clients to refetch.
    await reconcileFromDisk(ctx, [link.mount], { announceTree: true });
    return publicStatus(await linkGitStatus(link));
  });
}
