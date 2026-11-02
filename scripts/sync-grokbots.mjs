#!/usr/bin/env node
/**
 * Mirror every Grok bot's profile into its CENTCOM agent home (`Agents/grokbot-<name>.md`).
 * Runs on the machine that hosts the bots, e.g. daily from cron. Plain Node >= 20: built-ins and
 * global fetch only, so it needs no `pnpm install`.
 *
 *   node scripts/sync-grokbots.mjs --agents-dir D --skills-dir D [--dry-run] [--json] [--agent ID]
 *
 * Env: CENTCOM_URL (required unless --dry-run), CENTCOM_TOKEN or CENTCOM_TOKEN_FILE,
 * CENTCOM_AGENT (writer), GROKBOT_AGENTS_DIR, GROKBOT_SKILLS_DIR. Nothing about any one
 * machine's layout is assumed: both directories must be given. The token is never printed.
 *
 * Bots that disappeared are reported, never deleted.
 */
import { existsSync, promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { buildProfile, dedupeSkills, parseSkillFile, sameProfile } from './grokbot-sync-lib.mjs';

const TIMEOUT_MS = 15_000;

const HELP = `Usage: node scripts/sync-grokbots.mjs --agents-dir DIR --skills-dir DIR [--dry-run] [--json] [--agent ID]

  --agents-dir   bot profiles, one <bot>/profile.json each (or $GROKBOT_AGENTS_DIR); required
  --skills-dir   shared skill library, one <skill>/SKILL.md each (or $GROKBOT_SKILLS_DIR); required
  --agent        who the writes are attributed to (or $CENTCOM_AGENT); when unset, the server
                 attributes them to the token's own agent
  --dry-run      print what would be sent; no network at all
  --json         machine-readable output

Env: CENTCOM_URL (required unless --dry-run), CENTCOM_TOKEN or CENTCOM_TOKEN_FILE.`;

class UsageError extends Error {}

function parseArgs(argv) {
  const opts = { dryRun: false, json: false, help: false };
  const valued = { '--agents-dir': 'agentsDir', '--skills-dir': 'skillsDir', '--agent': 'agent' };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split(/=(.*)/s, 2);
    if (flag === '--dry-run') opts.dryRun = true;
    else if (flag === '--json') opts.json = true;
    else if (flag === '--help' || flag === '-h') opts.help = true;
    else if (valued[flag]) {
      const value = inline ?? argv[(i += 1)];
      if (!value) throw new UsageError(`${flag} needs a value.`);
      opts[valued[flag]] = value;
    } else throw new UsageError(`Unknown option ${argv[i]}. Try --help.`);
  }
  return opts;
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

/** Every bot with a profile.json and a name. Unreadable profiles are warned about and skipped. */
async function readBots(dir) {
  const bots = [];
  for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(dir, entry.name, 'profile.json');
    if (!existsSync(file)) continue;
    let profile;
    try {
      profile = await readJson(file);
    } catch (err) {
      process.stderr.write(`sync-grokbots: skipping ${file}: ${err.message}\n`);
      continue;
    }
    if (!profile || typeof profile !== 'object' || typeof profile.name !== 'string' || !profile.name.trim()) continue;
    bots.push(profile);
  }
  return bots;
}

async function readSkillLibrary(dir) {
  if (!existsSync(dir)) return [];
  const library = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name, 'SKILL.md');
    if (!existsSync(file)) continue;
    const parsed = parseSkillFile(await fs.readFile(file, 'utf8'));
    library.push({ folder: entry.name, name: parsed?.name || entry.name, description: parsed?.description ?? '' });
  }
  return dedupeSkills(library);
}

function readToken() {
  if (process.env.CENTCOM_TOKEN?.trim()) return process.env.CENTCOM_TOKEN.trim();
  const file = process.env.CENTCOM_TOKEN_FILE?.trim();
  if (!file) return undefined;
  if (!existsSync(file)) throw new UsageError(`CENTCOM_TOKEN_FILE ${file} does not exist.`);
  try {
    return readFileSync(file, 'utf8').trim() || undefined;
  } catch {
    throw new UsageError(`Cannot read the token file ${file}.`);
  }
}

function client(baseUrl, token) {
  const headers = { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  return async (method, apiPath, body) => {
    let res;
    try {
      res = await fetch(`${baseUrl.replace(/\/+$/, '')}${apiPath}`, {
        method,
        headers: body === undefined ? headers : { ...headers, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(`cannot reach CENTCOM (${err.cause?.code ?? err.name})`);
    }
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, ok: res.ok, json };
  };
}

async function push(api, wanted, writer) {
  const id = encodeURIComponent(wanted.id);
  const current = await api('GET', `/api/agents/${id}/profile`);
  if (!current.ok && current.status !== 404) throw new Error(current.json?.error ?? `GET profile failed with HTTP ${current.status}`);
  const remote = current.ok ? current.json : null;
  if (sameProfile(remote, wanted)) return 'unchanged';
  const { id: _id, ...body } = wanted;
  const put = await api('PUT', `/api/agents/${id}/profile`, { ...body, ...(writer ? { agent: writer } : {}) });
  if (!put.ok) throw new Error(put.json?.error ?? `PUT profile failed with HTTP ${put.status}`);
  if (!put.json?.changed) return 'unchanged';
  return remote ? 'updated' : 'created';
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return void process.stdout.write(`${HELP}\n`);

  const agentsDir = opts.agentsDir || process.env.GROKBOT_AGENTS_DIR?.trim();
  const skillsDir = opts.skillsDir || process.env.GROKBOT_SKILLS_DIR?.trim();
  if (!agentsDir) throw new UsageError('Where are the bot profiles? Pass --agents-dir DIR or set GROKBOT_AGENTS_DIR.');
  if (!skillsDir) throw new UsageError('Where is the shared skill library? Pass --skills-dir DIR or set GROKBOT_SKILLS_DIR.');
  const writer = opts.agent || process.env.CENTCOM_AGENT?.trim() || undefined;
  const baseUrl = process.env.CENTCOM_URL?.trim();
  if (!opts.dryRun && !baseUrl) throw new UsageError('CENTCOM_URL is required (or pass --dry-run).');

  const library = await readSkillLibrary(skillsDir);
  const wanted = (await readBots(agentsDir)).map((bot) => buildProfile(bot, library)).sort((a, b) => a.id.localeCompare(b.id));
  const bots = wanted.map((p) => ({ id: p.id, name: p.name, description: p.description, instructions: p.instructions.length, skills: p.skills.map((s) => s.name) }));

  if (opts.dryRun) {
    if (opts.json) return void process.stdout.write(`${JSON.stringify({ dryRun: true, count: bots.length, bots }, null, 2)}\n`);
    const lines = [`${bots.length} Grok bot${bots.length === 1 ? '' : 's'} (dry run, nothing sent)`];
    for (const b of bots) {
      lines.push(`\n${b.id}  ${b.name}`, `  description   ${b.description.slice(0, 80)}${b.description.length > 80 ? '…' : ''}`, `  instructions  ${b.instructions} chars`, `  skills        ${b.skills.join(', ') || '-'}`);
    }
    return void process.stdout.write(`${lines.join('\n')}\n`);
  }

  const api = client(baseUrl, readToken());
  const results = [];
  for (const profile of wanted) {
    try {
      results.push({ id: profile.id, name: profile.name, status: await push(api, profile, writer) });
    } catch (err) {
      results.push({ id: profile.id, name: profile.name, status: 'failed', error: err.message });
    }
  }

  // Bots whose profile is still in CENTCOM but no longer on this machine: reported, never deleted.
  let gone = [];
  if (results.some((r) => r.status !== 'failed')) {
    const list = await api('GET', '/api/agents').catch(() => null);
    const present = new Set(wanted.map((p) => p.id));
    if (list?.ok && Array.isArray(list.json)) gone = list.json.map((a) => a.id).filter((id) => id.startsWith('grokbot-') && id !== writer && !present.has(id));
  }

  const summary = { created: 0, updated: 0, unchanged: 0, failed: 0 };
  for (const r of results) summary[r.status] += 1;
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ dryRun: false, count: bots.length, bots, results, gone, summary }, null, 2)}\n`);
  } else {
    for (const r of results) process.stdout.write(`${r.status.padEnd(9)} ${r.id}  ${r.name}${r.error ? `  (${r.error})` : ''}\n`);
    if (gone.length > 0) process.stdout.write(`not on this machine any more (left in CENTCOM): ${gone.join(', ')}\n`);
    process.stdout.write(`created ${summary.created}, updated ${summary.updated}, unchanged ${summary.unchanged}, failed ${summary.failed}\n`);
  }
  if (summary.failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`sync-grokbots: ${err.message}\n`);
  process.exitCode = err instanceof UsageError ? 2 : 1;
});
