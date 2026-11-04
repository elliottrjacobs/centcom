import { localInstructionReport } from './instruction-inventory.ts';
import { readInstructionSource, rememberInstructionSource } from './instruction-source.ts';
import os from 'node:os';
import { localSkillReport } from './skill-inventory.ts';
/**
 * `centcom`: the command-line way into CENTCOM. Everything goes through the REST API
 * (same code path as the app and the MCP tools); only `serve` runs the server itself.
 * Zero-dependency argument parsing; plain aligned text for humans, `--json` for machines.
 *
 * No shebang here on purpose: scripts/build-node.mjs adds `#!/usr/bin/env node` as a banner when it
 * bundles this file to dist-cli/centcom.cjs, and a second one from the source would be a syntax error.
 */
import { fstatSync, promises as fsp, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import pkg from '../package.json' with { type: 'json' };
import { TICKET_STATUSES, type ActivityEvent, type CreateTokenInput, type AgentDeliverable, type AgentHome, type LinkGitStatus, type LinkInfo, type Ticket, type TicketPriority, type TicketStatus, type TreeNode } from '../shared/types.ts';
import { CentcomApiError, CentcomClient, collectSkills, DEFAULT_URL, findNode, findSkill, walkFiles } from '../mcp/client.ts';
import { isLoopbackHost } from '../server/auth.ts';
import { expandHome, loadConfig, readConfigFileSync, updateConfigFile } from '../server/config.ts';
import { createMount, inspectMount, validateLink, type LinkEnv } from '../server/links.ts';
import type { VaultLink } from '../server/paths.ts';

const VERSION: string = pkg.version;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

const HELP = `centcom ${VERSION}: single source of truth for your agents

Usage
  centcom status
  centcom serve [--port N] [--host H] [--vault P]
  centcom mcp                                   stdio MCP server (uses CENTCOM_URL / CENTCOM_TOKEN)

  centcom ticket create --title T [--project P] [--priority 0-4] [--status S] [--agent A]
                        [--label L ...] [--due YYYY-MM-DD] [--parent ID] [--body B | --body-file F | stdin]
  centcom ticket list [--project P] [--status S[,S]] [--agent A] [--mine] [--label L] [--all]
  centcom ticket show <ID>
  centcom ticket update <ID> [--status S] [--priority N] [--agent A] [--title T] [--project P]
                        [--label L ...] [--due D] [--parent ID] [--body B | --body-file F]
  centcom ticket start|review|done|cancel <ID>
  centcom ticket comment <ID> <text…>           (or pipe the comment on stdin)
  centcom ticket edit-comment <ID> <COMMENT> <text…>   replace a comment's text (ids are in ticket show)
  centcom ticket delete-comment <ID> <COMMENT>          erase a comment's text; it stays in the thread as deleted

  centcom project list
  centcom project create --name N [--key K] [--summary S]
  centcom skill sync [--device ID] [--device-name NAME] [--project-dir PATH ...]
                     [--root PATH ... --agent NAME --project PATH] [--report-file JSON]
  centcom instruction sync [--device ID] [--device-name NAME] [--project-dir PATH ...] [--report-file JSON]
  centcom instruction catalog                   global and project instruction files
  centcom skill catalog                          deduplicated installed Skills
  centcom skill list [--project P]
  centcom skill show <name> [--project P]
  centcom doc ls [path]
  centcom doc read <path>
  centcom doc write <path> (--body B | --body-file F | stdin)
  centcom search <query…>
  centcom taste add <file> [--folder Taste/…] [--note "why I like it"] [--tag T ...]

  centcom link list
  centcom link add <target> --at <mount> [--readonly]    mount a real folder inside the vault (e.g. --at Skills/shared)
  centcom link remove <mount>                            removes the symlink + config entry only, never the folder's contents
  centcom link status [--fetch]                          git state of each linked clone: branch, ahead/behind, dirty (--fetch asks the remote first)
  centcom link pull <mount>                              git pull --ff-only in that link's clone; refused if it is dirty, ahead, or tracks nothing

  centcom bookmark add <url> [--folder F] [--title T] [--note N] [--tag T ...]
  centcom bookmark list [--folder F]

  centcom agent list
  centcom agent home <id> [--limit N]                    description, instructions, skills, deliverables, recent activity
  centcom agent profile show <id>
  centcom agent profile set <id> [--description D | --description-file F] [--instructions I | --instructions-file F]
                        [--skill "name: what it does" ...] [--name N] [--source self-reported|grokbot-sync]
  centcom agent deliverable add <id> --title T --url U --kind pr|doc|file|link|other [--date YYYY-MM-DD]
                        [--project P] [--note N]         (--url here is the deliverable; set the server with $CENTCOM_URL)
  centcom agent deliverable remove <id> <deliverable-id>

  centcom token list                                     owner token and named tokens: agent, scopes, projects, last used
  centcom token create --label L --agent ID --scope read|write|write:instructions ... [--project P[,P…]]
                       [--instructions-for 'grokbot-*' ...] [--out-file F]
                                                         shown once; --out-file writes it to F (0600) instead of printing;
                                                         --instructions-for limits write:instructions to those agents
  centcom token revoke <token-id>                        ends the token and every browser session it opened

Global options
  --json            print raw JSON
  --as ID           act as this agent
  --device NAME     ticket action location; defaults to $CENTCOM_DEVICE, then this machine’s hostname
  --url URL         server to talk to (default: $CENTCOM_URL, then ~/.centcom/config.json, then ${DEFAULT_URL})
  -h, --help        show this help          --version   print the version

Identity
  Who a change is attributed to: --as, else $CENTCOM_AGENT, else --agent, else "cli".
  On "ticket create|update|list", --agent names the ticket's owner; elsewhere it is the same as --as.
  Statuses: ${TICKET_STATUSES.join(', ')}.  Priorities: 0 none, 1 urgent, 2 high, 3 medium, 4 low.
`;

/* ───────────────────────── Errors ───────────────────────── */

class UsageError extends Error {}

function fail(message: string, code = 1): never {
  process.stderr.write(`centcom: ${message}\n`);
  process.exit(code);
}

/* ───────────────────────── Argument parsing ───────────────────────── */

const VALUE_FLAGS = new Set([
  'title', 'project', 'priority', 'status', 'agent', 'as', 'label', 'body', 'body-file', 'port', 'host', 'vault',
  'device', 'device-name', 'root', 'project-dir', 'reporter', 'report-file', 'name', 'key', 'summary', 'folder', 'note', 'tag', 'limit', 'url', 'due', 'parent', 'at',
  'description', 'description-file', 'instructions', 'instructions-file', 'skill', 'source', 'kind', 'date',
  'scope', 'out-file', 'instructions-for',
]);
const BOOLEAN_FLAGS = new Set(['json', 'mine', 'all', 'help', 'version', 'quiet', 'readonly', 'fetch']);
const REPEATABLE = new Set(['label', 'tag', 'root', 'project-dir', 'skill', 'scope', 'instructions-for']);

interface Args {
  positionals: string[];
  values: Map<string, string[]>;
  bools: Set<string>;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { positionals: [], values: new Map(), bools: new Set() };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;
    if (token === '--') {
      args.positionals.push(...argv.slice(i + 1));
      break;
    }
    if (token === '-h') {
      args.bools.add('help');
      continue;
    }
    if (!token.startsWith('--') || token.length < 3) {
      args.positionals.push(token);
      continue;
    }
    const eq = token.indexOf('=');
    const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
    if (BOOLEAN_FLAGS.has(name)) {
      if (eq !== -1) throw new UsageError(`--${name} does not take a value.`);
      args.bools.add(name);
      continue;
    }
    if (!VALUE_FLAGS.has(name)) throw new UsageError(`Unknown option --${name}. Run "centcom --help".`);
    let value: string | undefined;
    if (eq !== -1) value = token.slice(eq + 1);
    else {
      i += 1;
      value = argv[i];
    }
    if (value === undefined) throw new UsageError(`--${name} needs a value.`);
    const list = args.values.get(name) ?? [];
    if (list.length > 0 && !REPEATABLE.has(name)) throw new UsageError(`--${name} was given more than once.`);
    list.push(value);
    args.values.set(name, list);
  }
  return args;
}

function flag(args: Args, name: string): string | undefined {
  return args.values.get(name)?.[0];
}

function flags(args: Args, name: string): string[] {
  // `--label a,b --label c` → [a, b, c]
  return (args.values.get(name) ?? []).flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);
}

function need(value: string | undefined, what: string): string {
  if (value === undefined || value.trim() === '') throw new UsageError(`${what} is required.`);
  return value;
}

/* ───────────────────────── Output ───────────────────────── */

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
const paint = (code: string) => (text: string) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const dim = paint('2');
const bold = paint('1');
const STATUS_COLOR: Record<TicketStatus, (s: string) => string> = {
  backlog: dim,
  todo: paint('37'),
  in_progress: paint('33'),
  in_review: paint('36'),
  done: paint('32'),
  canceled: dim,
};
const PRIORITY_LABEL: Record<number, string> = { 0: '-', 1: 'urgent', 2: 'high', 3: 'medium', 4: 'low' };

function out(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

function printJson(value: unknown): void {
  out(JSON.stringify(value, null, 2));
}

/** Column-aligned rows. `style` colours a cell without disturbing the padding maths. */
function table(rows: string[][], style?: (cell: string, col: number, row: number) => string): string {
  if (rows.length === 0) return '';
  const widths: number[] = [];
  for (const row of rows) row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, cell.length)));
  return rows
    .map((row, r) =>
      row
        .map((cell, i) => {
          const padded = i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0);
          return style ? style(padded, i, r) : padded;
        })
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)}d ago`;
  return new Date(ts).toISOString().slice(0, 10);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

function ticketTable(tickets: Ticket[]): string {
  const rows = [['ID', 'STATUS', 'PRI', 'OWNER', 'TITLE'], ...tickets.map((t) => [t.id, t.status, PRIORITY_LABEL[t.priority] ?? '-', t.agent ?? '-', truncate(t.title, 80)])];
  return table(rows, (cell, col, row) => {
    if (row === 0) return dim(cell);
    if (col === 0) return bold(cell);
    if (col === 1) return (STATUS_COLOR[cell.trim() as TicketStatus] ?? ((s: string) => s))(cell);
    return cell;
  });
}

function describeEvent(e: ActivityEvent): string {
  const when = dim(ago(e.ts));
  if (e.type === 'ticket.comment') {
    const head = `${bold(e.agent)}${e.device ? ` on ${e.device}` : ''} commented ${when} ${dim(e.id)}`;
    if (e.deletedAt !== undefined) return `${head}\n    ${dim(`(deleted by ${e.deletedBy ?? 'unknown'} ${ago(e.deletedAt)})`)}`;
    const edited = e.editedAt !== undefined ? ` ${dim(`(edited by ${e.editedBy ?? 'unknown'} ${ago(e.editedAt)})`)}` : '';
    return `${head}${edited}\n${(e.body ?? '').split('\n').map((l) => `    ${l}`).join('\n')}`;
  }
  if (e.type === 'ticket.updated' && e.changes) {
    const parts = Object.entries(e.changes).map(([field, [from, to]]) => (field === 'body' ? 'description edited' : `${field}: ${fmt(from)} → ${fmt(to)}`));
    return `${bold(e.agent)}${e.device ? ` on ${e.device}` : ''} ${parts.join(', ')} ${when}`;
  }
  return `${bold(e.agent)}${e.device ? ` on ${e.device}` : ''} ${e.type.replace('.', ' ')} ${when}`;
}

function fmt(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'none';
  return Array.isArray(value) ? `[${value.join(', ')}]` : String(value);
}

/* ───────────────────────── Input ───────────────────────── */

/** True when something is actually attached to stdin (a pipe or a file), not a terminal or /dev/null. */
function stdinIsPiped(): boolean {
  if (process.stdin.isTTY) return false;
  try {
    const stat = fstatSync(0);
    return stat.isFIFO() || stat.isFile() || stat.isSocket();
  } catch {
    return false;
  }
}

/**
 * Read all of stdin. With `idleMs`, give up (returning '') when nothing at all has arrived by
 * then: agent harnesses sometimes hand us an open pipe that nobody will ever write to or close.
 */
function readStdin(idleMs?: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (timer) clearTimeout(timer);
      process.stdin.pause();
      // A pipe nobody closes must not keep the process alive after we have stopped listening.
      (process.stdin as unknown as { unref?: () => void }).unref?.();
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    if (idleMs !== undefined) timer = setTimeout(() => (chunks.length === 0 ? finish() : undefined), idleMs);
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', finish);
    process.stdin.on('error', reject);
  });
}

async function bodyInput(args: Args, opts: { required: boolean }): Promise<string | undefined> {
  const inline = flag(args, 'body');
  const file = flag(args, 'body-file');
  if (inline !== undefined && file !== undefined) throw new UsageError('Use either --body or --body-file, not both.');
  if (inline !== undefined && inline !== '-') return inline;
  if (file !== undefined && file !== '-') {
    try {
      return readFileSync(path.resolve(file), 'utf8').replace(/\r?\n$/, '');
    } catch (err) {
      fail(`Cannot read ${file}: ${(err as Error).message}`);
    }
  }
  const explicitStdin = inline === '-' || file === '-';
  if (explicitStdin || stdinIsPiped()) {
    // `echo … |` always appends a newline that is not part of what the caller meant to say.
    const text = (await readStdin(explicitStdin || opts.required ? undefined : 1500)).replace(/\r?\n$/, '');
    if (text.trim() !== '' || explicitStdin) return text;
  }
  if (opts.required) throw new UsageError('Provide content with --body, --body-file, or on stdin.');
  return undefined;
}

/* ───────────────────────── Client + identity ───────────────────────── */

/** `urlIsServer: false` on commands where `--url` is data (a deliverable's link), not the server to talk to. */
function makeClient(args: Args, { urlIsServer = true } = {}): CentcomClient {
  const device = flag(args, 'device') ?? (process.env.CENTCOM_DEVICE?.trim() || os.hostname());
  const explicitUrl = (urlIsServer ? flag(args, 'url') : undefined) ?? process.env.CENTCOM_URL?.trim();
  const envToken = process.env.CENTCOM_TOKEN?.trim();
  const config = readConfigFileSync();
  if (explicitUrl) {
    let host = '';
    try {
      host = new URL(explicitUrl).hostname;
    } catch {
      throw new UsageError(`"${explicitUrl}" is not a valid URL.`);
    }
    // The local config token is only ever offered to this machine; a remote URL needs CENTCOM_TOKEN.
    const token = envToken || (isLoopbackHost(host.replace(/^\[|\]$/g, '')) ? config?.token : undefined);
    return new CentcomClient({ device, baseUrl: explicitUrl, token });
  }
  if (config?.serverUrl) {
    const remote = new URL(config.serverUrl);
    if (remote.protocol !== 'https:') throw new UsageError('Configured serverUrl must use HTTPS.');
    return new CentcomClient({ device, baseUrl: remote.origin, token: envToken || config.token });
  }
  const envPort = process.env.CENTCOM_PORT?.trim();
  if (config || envPort) {
    const rawHost = config?.host && config.host !== '0.0.0.0' && config.host !== '::' ? config.host : '127.0.0.1';
    const host = rawHost.includes(':') ? `[${rawHost}]` : rawHost;
    const port = envPort || String(config?.port ?? 4747);
    return new CentcomClient({ device, baseUrl: `http://${host}:${port}`, token: envToken || config?.token });
  }
  return new CentcomClient({ device, baseUrl: DEFAULT_URL, token: envToken });
}

/** `ownerFlag`: on this command `--agent` names the ticket owner, so it ranks below $CENTCOM_AGENT for identity. */
function identity(args: Args, ownerFlag = false): string {
  const as = flag(args, 'as');
  const agent = flag(args, 'agent');
  const env = process.env.CENTCOM_AGENT?.trim();
  if (as) return as;
  if (ownerFlag) return env || agent || 'cli';
  return agent || env || 'cli';
}

function parsePriority(value: string | undefined): TicketPriority | undefined {
  if (value === undefined) return undefined;
  const names: Record<string, TicketPriority> = { none: 0, urgent: 1, high: 2, medium: 3, low: 4 };
  const v = value.trim().toLowerCase();
  if (/^[0-4]$/.test(v)) return Number(v) as TicketPriority;
  const named = names[v];
  if (named === undefined) throw new UsageError('--priority must be 0-4 (0 none, 1 urgent, 2 high, 3 medium, 4 low).');
  return named;
}

function nullable(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  return ['', 'none', 'null'].includes(value.trim().toLowerCase()) ? null : value;
}

/* ───────────────────────── Commands ───────────────────────── */

async function cmdStatus(args: Args): Promise<void> {
  const client = makeClient(args);
  const info = await client.info();
  const [projects, tickets] = await Promise.all([client.listProjects(), client.listTickets()]);
  if (args.bools.has('json')) return printJson({ ...info, url: client.baseUrl, projects: projects.length, tickets: tickets.length });
  const open = tickets.filter((t) => t.status !== 'done' && t.status !== 'canceled');
  out(
    table([
      ['server', `${client.baseUrl}  (centcom ${info.version})`],
      ['vault', info.vault],
      ['access', info.remote ? 'remote (token required off-machine)' : 'this machine only'],
      ['projects', String(projects.length)],
      ['tickets', `${open.length} open, ${tickets.filter((t) => t.status === 'in_progress').length} in progress, ${tickets.length} total`],
    ]),
  );
}

async function cmdServe(args: Args): Promise<void> {
  const portFlag = flag(args, 'port');
  const port = portFlag === undefined ? undefined : Number(portFlag);
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) throw new UsageError('--port must be a number between 0 and 65535.');
  const { startServer } = await import('../server/index.ts');
  const vault = flag(args, 'vault');
  const host = flag(args, 'host');
  const running = await startServer({
    ...(port !== undefined ? { port } : {}),
    ...(host !== undefined ? { host } : {}),
    ...(vault !== undefined ? { vault: path.resolve(vault) } : {}),
    quiet: args.bools.has('quiet'),
  });
  let stopping = false;
  const stop = (): void => {
    if (stopping) process.exit(1);
    stopping = true;
    running.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  await new Promise<never>(() => undefined);
}

async function cmdMcp(args: Args): Promise<void> {
  const client = makeClient(args);
  const [{ StdioServerTransport }, { createMcpServer }] = await Promise.all([import('@modelcontextprotocol/sdk/server/stdio.js'), import('../mcp/tools.ts')]);
  const server = createMcpServer(client, VERSION);
  // stdout belongs to the protocol from here on; anything human-readable goes to stderr.
  await server.connect(new StdioServerTransport());
  process.stderr.write(`centcom mcp: serving over stdio, backed by ${client.baseUrl}\n`);
  const shutdown = (): void => {
    void server.close().finally(() => process.exit(0));
  };
  process.stdin.on('close', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await new Promise<never>(() => undefined);
}

function showTicket(detail: { ticket: Ticket; activity: ActivityEvent[]; children: Ticket[] }): void {
  const t = detail.ticket;
  out(`${bold(t.id)}  ${t.title}`);
  out(
    table([
      ['status', t.status],
      ['priority', PRIORITY_LABEL[t.priority] ?? '-'],
      ['owner', t.agent ?? '-'],
      ['project', t.project ?? 'Inbox'],
      ['labels', t.labels.join(', ') || '-'],
      ['due', t.due ?? '-'],
      ['parent', t.parent ?? '-'],
      ['filed by', `${t.createdBy}, ${ago(t.created)}`],
      ['updated', ago(t.updated)],
      ['file', t.path],
    ]),
  );
  if (t.body.trim()) out(`\n${t.body.trim()}`);
  if (detail.children.length > 0) out(`\n${dim('Sub-tickets')}\n${ticketTable(detail.children)}`);
  if (detail.activity.length > 0) out(`\n${dim('Activity')}\n${detail.activity.map(describeEvent).join('\n')}`);
}

async function cmdTicket(args: Args): Promise<void> {
  const [, sub, ...rest] = args.positionals;
  const client = makeClient(args);
  const json = args.bools.has('json');

  switch (sub) {
    case 'create': {
      const title = need(flag(args, 'title') ?? (rest.length > 0 ? rest.join(' ') : undefined), '--title');
      const body = await bodyInput(args, { required: false });
      const status = flag(args, 'status');
      const owner = nullable(flag(args, 'agent'));
      const labels = flags(args, 'label');
      const ticket = await client.createTicket({
        title,
        createdBy: identity(args, true),
        ...(flag(args, 'project') !== undefined ? { project: nullable(flag(args, 'project')) ?? null } : {}),
        ...(status !== undefined ? { status: status as TicketStatus } : {}),
        ...(parsePriority(flag(args, 'priority')) !== undefined ? { priority: parsePriority(flag(args, 'priority')) as TicketPriority } : {}),
        ...(owner !== undefined ? { agent: owner } : {}),
        ...(labels.length > 0 ? { labels } : {}),
        ...(flag(args, 'due') !== undefined ? { due: nullable(flag(args, 'due')) ?? null } : {}),
        ...(flag(args, 'parent') !== undefined ? { parent: nullable(flag(args, 'parent')) ?? null } : {}),
        ...(body !== undefined ? { body } : {}),
      });
      if (json) return printJson(ticket);
      return out(`Created ${bold(ticket.id)}  ${ticket.title}\n${dim(ticket.path)}`);
    }
    case 'list':
    case 'ls': {
      const owner = args.bools.has('mine') ? identity(args) : flag(args, 'agent');
      if (args.bools.has('mine') && owner === 'cli') throw new UsageError('--mine needs to know who you are: set CENTCOM_AGENT or pass --as.');
      let tickets = await client.listTickets({ project: flag(args, 'project'), status: flag(args, 'status'), agent: owner, label: flag(args, 'label') });
      // Without an explicit status filter, finished work is noise.
      if (!flag(args, 'status') && !args.bools.has('all')) tickets = tickets.filter((t) => t.status !== 'done' && t.status !== 'canceled');
      const limit = flag(args, 'limit');
      if (limit !== undefined) tickets = tickets.slice(0, Math.max(1, Number(limit) || 1));
      if (json) return printJson(tickets);
      if (tickets.length === 0) return out(dim('No tickets match.'));
      const order: Record<TicketStatus, number> = { in_progress: 0, in_review: 1, todo: 2, backlog: 3, done: 4, canceled: 5 };
      tickets.sort((a, b) => order[a.status] - order[b.status] || (a.priority || 9) - (b.priority || 9) || b.updated - a.updated);
      return out(ticketTable(tickets));
    }
    case 'show':
    case 'get': {
      const detail = await client.getTicket(need(rest[0], 'A ticket id'));
      return json ? printJson(detail) : showTicket(detail);
    }
    case 'update': {
      const id = need(rest[0], 'A ticket id');
      const status = flag(args, 'status');
      const owner = nullable(flag(args, 'agent'));
      const labels = args.values.has('label') ? flags(args, 'label') : undefined;
      const body = flag(args, 'body') !== undefined || flag(args, 'body-file') !== undefined ? await bodyInput(args, { required: true }) : undefined;
      const patch = {
        ...(status !== undefined ? { status: status as TicketStatus } : {}),
        ...(parsePriority(flag(args, 'priority')) !== undefined ? { priority: parsePriority(flag(args, 'priority')) as TicketPriority } : {}),
        ...(owner !== undefined ? { agent: owner } : {}),
        ...(flag(args, 'title') !== undefined ? { title: flag(args, 'title') as string } : {}),
        ...(flag(args, 'project') !== undefined ? { project: nullable(flag(args, 'project')) ?? null } : {}),
        ...(labels !== undefined ? { labels } : {}),
        ...(flag(args, 'due') !== undefined ? { due: nullable(flag(args, 'due')) ?? null } : {}),
        ...(flag(args, 'parent') !== undefined ? { parent: nullable(flag(args, 'parent')) ?? null } : {}),
        ...(body !== undefined ? { body } : {}),
      };
      if (Object.keys(patch).length === 0) throw new UsageError('Nothing to update: pass at least one of --status, --priority, --agent, --title, --project, --label, --due, --parent, --body.');
      const ticket = await client.updateTicket(id, { ...patch, by: identity(args, true) });
      if (json) return printJson(ticket);
      return out(`Updated ${bold(ticket.id)}  ${ticket.status}  ${ticket.title}${ticket.id.toUpperCase() !== id.toUpperCase() ? dim(`  (was ${id.toUpperCase()})`) : ''}`);
    }
    case 'start':
    case 'review':
    case 'done':
    case 'cancel': {
      const id = need(rest[0], 'A ticket id');
      const status: TicketStatus = sub === 'start' ? 'in_progress' : sub === 'review' ? 'in_review' : sub === 'done' ? 'done' : 'canceled';
      const me = identity(args);
      // Starting an unowned ticket claims it, so the board shows who is on it.
      const claim = sub === 'start' && me !== 'cli' && (await client.getTicket(id)).ticket.agent === null;
      const ticket = await client.updateTicket(id, { status, by: me, ...(claim ? { agent: me } : {}) });
      if (json) return printJson(ticket);
      return out(`${bold(ticket.id)} → ${ticket.status}${claim ? `, owner ${me}` : ''}  ${ticket.title}`);
    }
    case 'comment': {
      const id = need(rest[0], 'A ticket id');
      let text = rest.slice(1).join(' ');
      if (!text.trim()) text = (await bodyInput(args, { required: true })) ?? '';
      const event = await client.comment(id, text, identity(args));
      if (json) return printJson(event);
      return out(`Commented on ${bold(event.ticket ?? id)} as ${event.agent}.`);
    }
    case 'edit-comment': {
      const id = need(rest[0], 'A ticket id');
      const commentId = need(rest[1], 'A comment id (shown by `centcom ticket show`)');
      let text = rest.slice(2).join(' ');
      if (!text.trim()) text = (await bodyInput(args, { required: true })) ?? '';
      const event = await client.editComment(id, commentId, text, identity(args));
      if (json) return printJson(event);
      return out(`Edited comment ${dim(commentId)} on ${bold(event.ticket ?? id)}.`);
    }
    case 'delete-comment': {
      const id = need(rest[0], 'A ticket id');
      const commentId = need(rest[1], 'A comment id (shown by `centcom ticket show`)');
      const result = await client.deleteComment(id, commentId, identity(args));
      if (json) return printJson(result);
      return out(`Deleted comment ${dim(commentId)} on ${bold(id.toUpperCase())}.`);
    }
    default:
      throw new UsageError(`Unknown ticket command "${sub ?? ''}". Try: create, list, show, update, start, review, done, cancel, comment, edit-comment, delete-comment.`);
  }
}

async function cmdProject(args: Args): Promise<void> {
  const [, sub] = args.positionals;
  const client = makeClient(args);
  const json = args.bools.has('json');
  if (sub === 'list' || sub === 'ls' || sub === undefined) {
    const projects = await client.listProjects();
    if (json) return printJson(projects);
    if (projects.length === 0) return out(dim('No projects yet. Create one with: centcom project create --name "My Project"'));
    const rows = [['KEY', 'NAME', 'STATUS', 'OPEN', 'DONE', 'SUMMARY']];
    for (const p of projects) {
      const open = p.counts.backlog + p.counts.todo + p.counts.in_progress + p.counts.in_review;
      rows.push([p.key, p.name, p.status, String(open), String(p.counts.done), truncate(p.summary, 60)]);
    }
    return out(table(rows, (cell, col, row) => (row === 0 ? dim(cell) : col === 0 ? bold(cell) : cell)));
  }
  if (sub === 'create') {
    const project = await client.createProject({
      name: need(flag(args, 'name'), '--name'),
      agent: identity(args),
      ...(flag(args, 'key') !== undefined ? { key: flag(args, 'key') as string } : {}),
      ...(flag(args, 'summary') !== undefined ? { summary: flag(args, 'summary') as string } : {}),
    });
    if (json) return printJson(project);
    return out(`Created project ${bold(project.name)} (${project.key})\n${dim(project.path)}`);
  }
  throw new UsageError(`Unknown project command "${sub}". Try: list, create.`);
}

async function cmdInstruction(args: Args): Promise<void> {
  const client=makeClient(args);
  if(args.positionals[1]==='catalog')return printJson(await client.request('GET','/api/instructions'));
  if(args.positionals[1]!=='sync')throw new UsageError('Try: centcom instruction sync or catalog.');
  const file=flag(args,'report-file');
  const reporter=flag(args,'reporter') ?? 'centcom-cli';
  const saved=!file && reporter==='centcom-cli' ? await readInstructionSource() : {};
  const projects=args.values.get('project-dir')?.map(p=>path.resolve(p)) ?? saved.projects;
  const report=file ? JSON.parse(await fsp.readFile(path.resolve(file),'utf8')) : await localInstructionReport({
    deviceId:flag(args,'device') ?? saved.deviceId,deviceName:flag(args,'device-name') ?? saved.deviceName,reporter,
    projects,
  });
  const result=await client.request<{files:number}>('PUT','/api/instructions/inventory',{json:report});
  if(!file && reporter==='centcom-cli')await rememberInstructionSource(report,projects);
  if(args.bools.has('json'))return printJson(result);
  out(`Reported ${result.files} instruction files from ${report.deviceName}.`);
}

async function cmdSkill(args: Args): Promise<void> {
  const [, sub, name] = args.positionals;
  const client = makeClient(args);
  const json = args.bools.has('json');
  if (sub === 'sync') {
    const file = flag(args, 'report-file');
    const roots = args.values.get('root');
    const report = file ? JSON.parse(await fsp.readFile(path.resolve(file), 'utf8')) : await localSkillReport({
      deviceId: flag(args, 'device'), deviceName: flag(args, 'device-name'), reporter: flag(args, 'reporter') ?? 'centcom-cli',
      projects: args.values.get('project-dir')?.map(p => path.resolve(p)),
      roots: roots?.map(p => ({path: path.resolve(p), agent: flag(args, 'agent') ?? 'Custom', project: flag(args, 'project') ?? null})),
    });
    if (!file && roots && !flag(args, 'reporter')) report.reporter = `custom:${flag(args, 'agent') ?? 'Custom'}`;
    const result = await client.request<{installations:number}>('PUT','/api/skills/inventory',{json: report});
    if (json) return printJson(result);
    return out(`Reported ${result.installations} Skill installations from ${report.deviceName}.`);
  }
  if (sub === 'catalog') return printJson(await client.request('GET','/api/skills'));
  const tree = await client.tree();
  const projectRef = flag(args, 'project');
  const project = projectRef ? await client.getProject(projectRef) : undefined;
  const skills = [...(project ? await collectSkills(client, tree, `${project.path}/Skills`, 'project', project.slug) : []), ...(await collectSkills(client, tree, 'Skills', 'global'))];

  if (sub === 'list' || sub === 'ls' || sub === undefined) {
    if (json) return printJson(skills);
    if (skills.length === 0) return out(dim('No skills yet. A skill is a folder with a SKILL.md under Skills/.'));
    const where = (s: (typeof skills)[number]): string => `${s.scope === 'project' ? (s.project ?? 'project') : 'global'}${s.group ? `/${s.group}` : ''}${s.linked ? ' (linked)' : ''}`;
    const rows = [['NAME', 'WHERE', 'DESCRIPTION'], ...skills.map((s) => [s.name, where(s), truncate(s.description.replace(/\s+/g, ' '), 90)])];
    return out(table(rows, (cell, col, row) => (row === 0 ? dim(cell) : col === 0 ? bold(cell) : cell)));
  }
  if (sub === 'show' || sub === 'get') {
    const skill = findSkill(skills, need(name, 'A skill name'));
    if (!skill) fail(`Skill "${name}" not found.${skills.length > 0 ? ` Available: ${skills.map((s) => s.name).join(', ')}.` : ''}`);
    const doc = await client.readDoc(skill.path);
    const files: string[] = [];
    const folder = findNode(tree, skill.folder);
    if (folder) walkFiles(folder, (f) => (f.path !== skill.path ? files.push(f.path) : undefined));
    if (json) return printJson({ ...skill, frontmatter: doc.frontmatter, body: doc.body, files });
    out(`${bold(skill.name)}  ${dim(skill.path)}`);
    if (skill.description) out(skill.description);
    out(`\n${doc.body.trim()}`);
    if (files.length > 0) out(`\n${dim('Files')}\n${files.map((f) => `  ${f}`).join('\n')}`);
    return;
  }
  throw new UsageError(`Unknown skill command "${sub}". Try: list, show.`);
}

async function cmdDoc(args: Args): Promise<void> {
  const [, sub, target] = args.positionals;
  const client = makeClient(args);
  const json = args.bools.has('json');
  switch (sub) {
    case 'ls':
    case 'list': {
      const tree = await client.tree();
      const node = findNode(tree, target ?? '');
      if (!node) fail(`"${target}" not found.`);
      if (node.type !== 'dir') fail(`"${node.path}" is a file. Use: centcom doc read ${node.path}`);
      const children: TreeNode[] = node.children ?? [];
      if (json) return printJson(children.map(({ children: kids, ...rest }) => ({ ...rest, ...(kids ? { items: kids.length } : {}) })));
      if (children.length === 0) return out(dim('(empty)'));
      return out(
        table(
          children.map((c) => [c.type === 'dir' ? `${c.name}/` : c.name, c.type === 'dir' ? `${c.children?.length ?? 0} item${c.children?.length === 1 ? '' : 's'}` : (c.title && c.title !== c.name.replace(/\.[^.]+$/, '') ? c.title : ''), ago(c.mtime)]),
          (cell, col) => (col === 0 ? (cell.trimEnd().endsWith('/') ? bold(cell) : cell) : dim(cell)),
        ),
      );
    }
    case 'read':
    case 'cat': {
      const doc = await client.readDoc(need(target, 'A path'));
      if (json) return printJson(doc);
      const keys = Object.keys(doc.frontmatter);
      if (keys.length > 0) out(dim(`---\n${keys.map((k) => `${k}: ${JSON.stringify(doc.frontmatter[k])}`).join('\n')}\n---`));
      return out(doc.body);
    }
    case 'write': {
      const docPath = need(target, 'A path');
      const body = (await bodyInput(args, { required: true })) ?? '';
      const doc = await client.writeDoc({ path: docPath, body, agent: identity(args) });
      if (json) return printJson(doc);
      return out(`Wrote ${bold(doc.path)} (${Buffer.byteLength(body, 'utf8')} bytes)`);
    }
    default:
      throw new UsageError(`Unknown doc command "${sub ?? ''}". Try: ls, read, write.`);
  }
}

async function cmdSearch(args: Args): Promise<void> {
  const query = args.positionals.slice(1).join(' ').trim();
  if (!query) throw new UsageError('What should I search for? Usage: centcom search <query…>');
  const limit = flag(args, 'limit');
  const hits = await makeClient(args).search(query, limit !== undefined ? Number(limit) || undefined : undefined);
  if (args.bools.has('json')) return printJson(hits);
  if (hits.length === 0) return out(dim('No results.'));
  for (const hit of hits) {
    out(`${dim(hit.type.padEnd(7))} ${bold(hit.ticket ? `${hit.ticket}  ${hit.title}` : hit.title)}  ${dim(hit.path)}`);
    if (hit.snippet) out(`        ${hit.snippet}`);
  }
}

async function cmdTaste(args: Args): Promise<void> {
  const [, sub, file] = args.positionals;
  if (sub !== 'add') throw new UsageError(`Unknown taste command "${sub ?? ''}". Try: centcom taste add <file> [--folder …] [--note …] [--tag …]`);
  const source = path.resolve(need(file, 'A file'));
  let size: number;
  try {
    const stat = statSync(source);
    if (!stat.isFile()) fail(`${source} is not a file.`);
    size = stat.size;
  } catch (err) {
    fail(`Cannot read ${source}: ${(err as Error).message}`);
  }
  if (size > MAX_UPLOAD_BYTES) fail(`${path.basename(source)} is ${(size / 1024 / 1024).toFixed(1)} MB; the limit is 50 MB.`);

  const name = path.basename(source);
  const ext = path.extname(name).toLowerCase();
  const isImage = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.bmp', '.heic', '.heif', '.tif', '.tiff'].includes(ext);
  const isText = ['.md', '.markdown', '.mdx', '.txt'].includes(ext);
  let folder = (flag(args, 'folder') ?? (isImage ? 'Taste/Visual' : isText ? 'Taste/Writing' : 'Taste')).replace(/^\/+|\/+$/g, '');
  if (folder.toLowerCase() !== 'taste' && !folder.toLowerCase().startsWith('taste/')) folder = `Taste/${folder}`;

  const client = makeClient(args);
  const me = identity(args);
  const node = await client.upload(folder, name, readFileSync(source), me);
  const note = flag(args, 'note');
  const tags = flags(args, 'tag');
  let notePath: string | undefined;
  if (note !== undefined || tags.length > 0) {
    const frontmatter = { ...(tags.length > 0 ? { tags } : {}), added: new Date().toISOString().slice(0, 10), added_by: me };
    if (node.kind === 'markdown' || node.kind === 'link') {
      // A writing sample carries its own frontmatter; the note rides along there.
      await client.writeDoc({ path: node.path, frontmatter: { ...frontmatter, ...(note ? { note } : {}) }, agent: me });
      notePath = node.path;
    } else {
      notePath = `${node.path}.md`;
      await client.writeDoc({ path: notePath, body: note ? `${note.trim()}\n` : '', frontmatter, agent: me });
    }
  }
  if (args.bools.has('json')) return printJson({ ...node, ...(notePath ? { note: notePath } : {}) });
  out(`Added ${bold(node.path)}${notePath && notePath !== node.path ? `\n${dim(`note: ${notePath}`)}` : ''}`);
}

async function cmdBookmark(args: Args): Promise<void> {
  const [, sub, operand] = args.positionals;
  const client = makeClient(args);
  const json = args.bools.has('json');

  if (sub === 'add' || sub === 'save') {
    const url = need(operand, 'A URL');
    const folder = flag(args, 'folder');
    const title = flag(args, 'title');
    const note = flag(args, 'note');
    const tags = flags(args, 'tag');
    const doc = await client.saveBookmark({
      url,
      agent: identity(args),
      ...(folder !== undefined ? { dir: folder.replace(/^\/+|\/+$/g, '') } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(note !== undefined ? { note } : {}),
      ...(tags.length > 0 ? { tags } : {}),
    });
    if (json) return printJson(doc);
    const problem = typeof doc.frontmatter.fetch_error === 'string' ? `\n${dim(`saved as a plain link (${doc.frontmatter.fetch_error})`)}` : '';
    return out(`Saved ${bold(doc.title)}\n${dim(`${String(doc.frontmatter.url)}  →  ${doc.path}`)}${problem}`);
  }

  if (sub === 'list' || sub === 'ls' || sub === undefined) {
    const folder = (flag(args, 'folder') ?? '').replace(/^\/+|\/+$/g, '');
    const root = findNode(await client.tree(), folder);
    if (!root) fail(`Folder "${folder}" not found.`);
    const links: TreeNode[] = [];
    walkFiles(root, (f) => (f.kind === 'link' ? links.push(f) : undefined));
    if (json) return printJson(links);
    if (links.length === 0) return out(dim(`No bookmarks${folder ? ` under ${folder}` : ''} yet. Add one with: centcom bookmark add <url>`));
    links.sort((a, b) => b.mtime - a.mtime);
    return out(table([['TITLE', 'SITE', 'SAVED', 'FILE'], ...links.map((l) => [truncate(l.title ?? l.name, 60), l.site ?? '-', ago(l.mtime), l.path])], (cell, col, row) => (row === 0 ? dim(cell) : col === 0 ? bold(cell) : col === 3 ? dim(cell) : cell)));
  }

  throw new UsageError(`Unknown bookmark command "${sub}". Try: add <url>, list.`);
}

/* ── Tokens ── */

async function cmdToken(args: Args): Promise<void> {
  const [, sub, operand] = args.positionals;
  const client = makeClient(args);
  const json = args.bools.has('json');

  if (sub === 'list' || sub === 'ls' || sub === undefined) {
    const list = await client.listTokens();
    if (json) return printJson(list);
    return out(
      table(
        [
          ['ID', 'LABEL', 'AGENT', 'SCOPES', 'PROJECTS', 'LAST USED'],
          ...list.map((t) => [
            t.id,
            truncate(t.label, 40),
            t.agent ?? 'any',
            t.scopes.map((s) => (s === 'write:instructions' && t.instructionAgents ? `${s}(${t.instructionAgents.join(',')})` : s)).join(' '),
            t.projects?.join(', ') ?? 'all',
            t.lastUsed ? ago(t.lastUsed) : '-',
          ]),
        ],
        (cell, col, row) => (row === 0 ? dim(cell) : col === 0 ? bold(cell) : cell),
      ),
    );
  }

  if (sub === 'create' || sub === 'new') {
    const scopes = flags(args, 'scope').flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean);
    if (scopes.length === 0) throw new UsageError('Give the token at least one --scope: read, write, write:instructions.');
    const projects = (flag(args, 'project') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const instructionAgents = flags(args, 'instructions-for').flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean);
    const outFile = flag(args, 'out-file');
    const created = await client.createToken({
      label: need(flag(args, 'label'), 'A --label (which device or agent will hold it)'),
      agent: need(flag(args, 'agent'), 'An --agent id (every write with this token is recorded as it)'),
      scopes: scopes as CreateTokenInput['scopes'],
      ...(projects.length > 0 ? { projects } : {}),
      ...(instructionAgents.length > 0 ? { instructionAgents } : {}),
    });
    if (outFile) {
      // Exclusive create: never overwrite a file that might already hold another credential.
      await fsp.writeFile(expandHome(outFile), `${created.token}\n`, { mode: 0o600, flag: 'wx' });
      if (json) return printJson({ info: created.info, outFile });
      return out(`Created ${bold(created.info.id)} for ${bold(created.info.agent ?? 'any')} (${created.info.scopes.join(' ')}). Token written to ${outFile} (0600). It cannot be shown again.`);
    }
    if (json) return printJson(created);
    process.stderr.write(dim(`Created ${created.info.id} for ${created.info.agent ?? 'any'}. Copy the token now; it cannot be shown again.\n`));
    return out(created.token);
  }

  if (sub === 'revoke' || sub === 'delete' || sub === 'rm') {
    const result = await client.revokeToken(need(operand, 'A token id (see centcom token list)'));
    if (json) return printJson(result);
    return out(`Revoked ${bold(result.revoked.id)} (${result.revoked.label}).${result.sessionsEnded > 0 ? ` Ended ${result.sessionsEnded} browser session${result.sessionsEnded === 1 ? '' : 's'}.` : ''}`);
  }

  throw new UsageError(`Unknown token command "${sub}". Try: list, create, revoke.`);
}

/* ── Agent homes ── */

/** `--x "text"` or `--x-file path` (`-` = stdin). Undefined when neither is given. */
async function textOrFile(args: Args, name: string): Promise<string | undefined> {
  const inline = flag(args, name);
  const file = flag(args, `${name}-file`);
  if (inline !== undefined && file !== undefined) throw new UsageError(`Use either --${name} or --${name}-file, not both.`);
  if (inline !== undefined) return inline;
  if (file === undefined) return undefined;
  if (file === '-') return (await readStdin()).replace(/\r?\n$/, '');
  try {
    return readFileSync(path.resolve(file), 'utf8');
  } catch (err) {
    fail(`Cannot read ${file}: ${(err as Error).message}`);
  }
}

/** Only an identity the caller actually gave; otherwise the server attributes the write to the agent itself. */
function explicitIdentity(args: Args): string | undefined {
  const me = identity(args);
  return me === 'cli' && !flag(args, 'as') && !flag(args, 'agent') ? undefined : me;
}

function showHome(home: AgentHome): void {
  const { agent, profile } = home;
  out(`${bold(agent.name)}  ${dim(agent.id)}${profile ? dim(`  ${profile.source}, updated ${ago(profile.updated)} by ${profile.updatedBy}`) : ''}`);
  if (!profile) out(dim('No profile yet. Publish one with: centcom agent profile set <id> --description … --instructions-file …'));
  if (profile?.description) out(`\n${dim('Description')}\n${profile.description}`);
  if (profile?.instructions) out(`\n${dim('Instructions and rules')}\n${profile.instructions}`);
  if (profile && profile.skills.length > 0) out(`\n${dim('Skills')}\n${table(profile.skills.map((s) => [s.name, truncate(s.description.replace(/\s+/g, ' '), 90)]), (cell, col) => (col === 0 ? bold(cell) : cell))}`);
  if (home.deliverables.length > 0) {
    out(`\n${dim('Deliverables')}\n${table(home.deliverables.map((d) => [d.date || '-', d.kind, truncate(d.title, 60), d.url, dim(d.id)]))}`);
  }
  if (home.activity.length > 0) out(`\n${dim('Activity')}\n${home.activity.slice(0, 20).map((e) => `${describeEvent(e)}${e.subject ? `  ${e.subject}` : ''}`).join('\n')}`);
}

async function cmdAgent(args: Args): Promise<void> {
  const [, sub, verb, ...rest] = args.positionals;
  const json = args.bools.has('json');

  if (sub === 'list' || sub === 'ls' || sub === undefined) {
    const agents = await makeClient(args).agents();
    if (json) return printJson(agents);
    return out(table([['ID', 'NAME', 'KIND', 'LAST SEEN'], ...agents.map((a) => [a.id, a.name, a.kind, a.lastSeen ? ago(a.lastSeen) : '-'])], (cell, col, row) => (row === 0 ? dim(cell) : col === 0 ? bold(cell) : cell)));
  }

  if (sub === 'home' || sub === 'show') {
    const limit = flag(args, 'limit');
    const home = await makeClient(args).agentHome(need(verb, 'An agent id'), limit !== undefined ? Number(limit) || undefined : undefined);
    return json ? printJson(home) : showHome(home);
  }

  if (sub === 'profile') {
    const id = need(rest[0], 'An agent id');
    const client = makeClient(args);
    if (verb === 'show' || verb === 'get') {
      const profile = await client.agentProfile(id);
      if (json) return printJson(profile);
      return showHome({ agent: { id: profile.id, name: profile.name, kind: 'agent', color: '', lastSeen: null }, profile, deliverables: profile.deliverables, activity: [] });
    }
    if (verb === 'set') {
      // Only what is given changes; the server needs both texts, so fill the missing one from what is there.
      const description = await textOrFile(args, 'description');
      const instructions = await textOrFile(args, 'instructions');
      const skillFlags = args.values.get('skill');
      const name = flag(args, 'name');
      const source = flag(args, 'source');
      if (source !== undefined && source !== 'self-reported' && source !== 'grokbot-sync') throw new UsageError('--source must be self-reported or grokbot-sync.');
      if (description === undefined && instructions === undefined && skillFlags === undefined && name === undefined) {
        throw new UsageError('Nothing to set: pass at least one of --description, --instructions(-file), --skill, --name.');
      }
      const current = description === undefined || instructions === undefined ? await client.agentProfile(id).catch(() => undefined) : undefined;
      const writer = explicitIdentity(args);
      const result = await client.upsertAgentProfile(id, {
        description: description ?? current?.description ?? '',
        instructions: instructions ?? current?.instructions ?? '',
        // `--skill "name: what it does"`, repeatable. The value may contain commas, so it is not split on them.
        ...(skillFlags ? { skills: skillFlags.map((s) => ({ name: s.split(':')[0]?.trim() ?? '', description: s.includes(':') ? s.slice(s.indexOf(':') + 1).trim() : '' })) } : {}),
        ...(name !== undefined ? { name } : {}),
        ...(source !== undefined ? { source: source as 'self-reported' | 'grokbot-sync' } : {}),
        ...(writer ? { agent: writer } : {}),
      });
      if (json) return printJson(result);
      return out(result.changed ? `Updated the profile of ${bold(result.profile.name)}\n${dim(result.profile.path)}` : `No change to the profile of ${bold(result.profile.name)}.`);
    }
    throw new UsageError(`Unknown agent profile command "${verb ?? ''}". Try: show <id>, set <id>.`);
  }

  if (sub === 'deliverable' || sub === 'deliverables') {
    const id = need(rest[0], 'An agent id');
    const writer = explicitIdentity(args);
    if (verb === 'add') {
      // Here `--url` is the deliverable's link (pick the server with $CENTCOM_URL), or pass it after the id.
      const client = makeClient(args, { urlIsServer: false });
      const kind = need(flag(args, 'kind'), '--kind (pr, doc, file, link or other)');
      const deliverable = await client.addAgentDeliverable(id, {
        title: need(flag(args, 'title'), '--title'),
        url: need(flag(args, 'url') ?? rest[1], '--url'),
        kind: kind as AgentDeliverable['kind'],
        ...(flag(args, 'date') !== undefined ? { date: flag(args, 'date') as string } : {}),
        ...(flag(args, 'project') !== undefined ? { project: flag(args, 'project') as string } : {}),
        ...(flag(args, 'note') !== undefined ? { note: flag(args, 'note') as string } : {}),
        ...(writer ? { agent: writer } : {}),
      });
      if (json) return printJson(deliverable);
      return out(`Reported ${bold(deliverable.title)} (${deliverable.kind}, ${deliverable.date})\n${dim(`${deliverable.url}  id ${deliverable.id}`)}`);
    }
    if (verb === 'remove' || verb === 'rm') {
      const deliverableId = need(rest[1], 'A deliverable id (see "centcom agent home <id>")');
      await makeClient(args).removeAgentDeliverable(id, deliverableId, writer);
      if (json) return printJson({ ok: true });
      return out(`Removed deliverable ${deliverableId} from ${id}.`);
    }
    throw new UsageError(`Unknown agent deliverable command "${verb ?? ''}". Try: add <id>, remove <id> <deliverable-id>.`);
  }

  throw new UsageError(`Unknown agent command "${sub}". Try: list, home, profile, deliverable.`);
}

/* ── Linked folders: local config + the symlink itself. Deliberately NOT an API call: the server
   has no endpoint that accepts a link, so only someone at this machine's shell can create one. ── */

async function linkEnv(): Promise<{ env: LinkEnv; vault: string }> {
  const config = await loadConfig();
  let vaultReal: string;
  try {
    vaultReal = await fsp.realpath(config.vault);
  } catch {
    fail(`The vault ${config.vault} does not exist yet. Start CENTCOM once (the app, or "centcom serve") and try again.`);
  }
  return { env: { vaultRoot: config.vault, vaultReal, configDir: config.configDir }, vault: config.vault };
}

function rawLinkEntries(): Record<string, unknown>[] {
  const links = readConfigFileSync()?.links;
  return Array.isArray(links) ? links.filter((l): l is Record<string, unknown> => Boolean(l) && typeof l === 'object') : [];
}

async function askServerToReload(args: Args): Promise<string> {
  try {
    const res = await makeClient(args).request<{ links: LinkInfo[] }>('POST', '/api/links/reload');
    return `The running server reloaded its links (${res.links.length} active).`;
  } catch (err) {
    if (err instanceof CentcomApiError && err.status === 0) return 'CENTCOM is not running; the change takes effect the next time it starts.';
    return `Could not tell the running server to reload (${err instanceof Error ? err.message : String(err)}). Restart CENTCOM to apply the change.`;
  }
}

async function cmdLink(args: Args): Promise<void> {
  const [, sub, operand] = args.positionals;
  const json = args.bools.has('json');

  if (sub === 'list' || sub === 'ls' || sub === undefined) {
    const { env } = await linkEnv();
    const accepted: VaultLink[] = [];
    const rows: { mount: string; target: string; readonly: boolean; state: string }[] = [];
    for (const entry of rawLinkEntries()) {
      const check = await validateLink(entry, env, accepted);
      if (!check.ok) {
        rows.push({ mount: String(entry.mount ?? '?'), target: String(entry.target ?? '?'), readonly: entry.readonly === true, state: `invalid: ${check.reason}` });
        continue;
      }
      accepted.push(check.link);
      const state = await inspectMount(env.vaultRoot, check.link);
      const label = { ok: 'ok', missing: 'not mounted yet (created on next start/reload)', 'wrong-target': 'symlink points elsewhere', occupied: 'mount path is taken by a real file or folder' }[state];
      rows.push({ mount: check.link.mount, target: check.link.target, readonly: check.link.readonly, state: label });
    }
    if (json) return printJson(rows);
    if (rows.length === 0) return out(dim('No linked folders. Add one with: centcom link add <folder> --at Skills/<name>'));
    return out(table([['MOUNT', 'TARGET', 'MODE', 'STATE'], ...rows.map((r) => [r.mount, r.target, r.readonly ? 'read-only' : 'read-write', r.state])], (cell, col, row) => (row === 0 ? dim(cell) : col === 0 ? bold(cell) : cell)));
  }

  if (sub === 'add') {
    const target = path.resolve(expandHome(need(operand, 'A target folder')));
    const mountInput = need(flag(args, 'at'), '--at <mount> (for example --at Skills/shared)');
    const { env } = await linkEnv();
    const accepted: VaultLink[] = [];
    for (const entry of rawLinkEntries()) {
      const existing = await validateLink(entry, env, accepted);
      if (existing.ok) accepted.push(existing.link);
    }
    const check = await validateLink({ mount: mountInput, target, readonly: args.bools.has('readonly') }, env, accepted);
    if (!check.ok) fail(`Cannot link: ${check.reason}.`);
    const state = await inspectMount(env.vaultRoot, check.link);
    if (state !== 'missing') fail(`Cannot link: "${check.link.mount}" already exists in the vault. Pick another mount point or move it out of the way first.`);
    try {
      await createMount(env, check.link);
    } catch (err) {
      fail(`Cannot link: ${(err as Error).message}.`);
    }
    await updateConfigFile(undefined, (data) => {
      const links = Array.isArray(data.links) ? (data.links as unknown[]) : [];
      links.push({ mount: check.link.mount, target: check.link.target, readonly: check.link.readonly });
      data.links = links;
    });
    const note = await askServerToReload(args);
    if (json) return printJson({ mount: check.link.mount, target: check.link.target, readonly: check.link.readonly, note });
    return out(`Linked ${bold(check.link.mount)} → ${check.link.target}${check.link.readonly ? ' (read-only)' : ''}\n${dim(note)}`);
  }

  if (sub === 'remove' || sub === 'rm') {
    const mountInput = need(operand, 'A mount path (see "centcom link list")').replace(/^\/+|\/+$/g, '');
    const { env } = await linkEnv();
    const entries = rawLinkEntries();
    const index = entries.findIndex((e) => typeof e.mount === 'string' && e.mount.replace(/^\/+|\/+$/g, '').normalize('NFC') === mountInput.normalize('NFC'));
    if (index === -1) fail(`"${mountInput}" is not a linked folder. Run "centcom link list".`);
    const abs = path.join(env.vaultRoot, ...mountInput.split('/'));
    let removedSymlink = false;
    const stat = await fsp.lstat(abs).catch(() => null);
    if (stat?.isSymbolicLink()) {
      // unlink removes the symlink itself. It cannot recurse and it never touches the target.
      await fsp.unlink(abs);
      removedSymlink = true;
    }
    await updateConfigFile(undefined, (data) => {
      const links = Array.isArray(data.links) ? (data.links as Record<string, unknown>[]) : [];
      data.links = links.filter((e) => !(e && typeof e.mount === 'string' && e.mount.replace(/^\/+|\/+$/g, '').normalize('NFC') === mountInput.normalize('NFC')));
    });
    const note = await askServerToReload(args);
    const leftover = stat && !removedSymlink ? ` "${mountInput}" in the vault is a real ${stat.isDirectory() ? 'folder' : 'file'}, not a symlink, so it was left alone.` : '';
    if (json) return printJson({ mount: mountInput, removedSymlink, note });
    return out(`Unlinked ${bold(mountInput)}. The real folder and everything in it are untouched.${leftover}\n${dim(note)}`);
  }

  // Git state lives on the server side of the API (loopback-only there), so these two need it running.
  if (sub === 'status' || sub === 'git') {
    const client = makeClient(args);
    const statuses = args.bools.has('fetch') ? await client.linkGitFetch() : await client.linkGitStatus();
    if (json) return printJson(statuses);
    if (statuses.length === 0) return out(dim('No linked folders.'));
    return out(table([['MOUNT', 'BRANCH', 'UPSTREAM', 'AHEAD', 'BEHIND', 'TREE', 'FETCHED', 'NOTE'], ...statuses.map(gitStatusRow)], (cell, col, row) => (row === 0 ? dim(cell) : col === 0 ? bold(cell) : col === 4 && cell.trim() !== '0' && cell.trim() !== '-' ? paint('33')(cell) : cell)));
  }

  if (sub === 'pull') {
    const mountInput = need(operand, 'A mount path (see "centcom link status")').replace(/^\/+|\/+$/g, '');
    const status = await makeClient(args).linkGitPull(mountInput);
    if (json) return printJson(status);
    return out(`Pulled ${bold(status.mount)}: ${status.branch ?? '?'} is ${status.behind === 0 ? 'up to date with' : `${status.behind ?? '?'} behind`} ${status.upstream ?? 'its upstream'}.`);
  }

  throw new UsageError(`Unknown link command "${sub}". Try: list, add, remove, status, pull.`);
}

function gitStatusRow(s: LinkGitStatus): string[] {
  if (!s.repo) return [s.mount, '-', '-', '-', '-', '-', '-', s.error ?? 'not a git repository'];
  const num = (n: number | undefined): string => (n === undefined ? '-' : String(n));
  return [s.mount, s.branch ?? '-', s.upstream ?? '(none)', num(s.ahead), num(s.behind), s.dirty ? 'dirty' : 'clean', s.fetchedAt ? ago(s.fetchedAt) : 'never', s.error ?? ''];
}

/* ───────────────────────── Main ───────────────────────── */

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.bools.has('version')) return out(VERSION);
  const command = args.positionals[0];
  if (args.bools.has('help') || command === undefined || command === 'help') return out(HELP);
  switch (command) {
    case 'status':
      return cmdStatus(args);
    case 'serve':
      return cmdServe(args);
    case 'mcp':
      return cmdMcp(args);
    case 'ticket':
    case 'tickets':
      return cmdTicket(args);
    case 'project':
    case 'projects':
      return cmdProject(args);
    case 'instruction':
    case 'instructions':
      return cmdInstruction(args);
    case 'skill':
    case 'skills':
      return cmdSkill(args);
    case 'doc':
    case 'docs':
      return cmdDoc(args);
    case 'search':
      return cmdSearch(args);
    case 'taste':
      return cmdTaste(args);
    case 'link':
    case 'links':
      return cmdLink(args);
    case 'bookmark':
    case 'bookmarks':
      return cmdBookmark(args);
    case 'agent':
    case 'agents':
      return cmdAgent(args);
    case 'token':
    case 'tokens':
      return cmdToken(args);
    default:
      throw new UsageError(`Unknown command "${command}". Run "centcom --help".`);
  }
}

main().then(
  () => {
    // Let stdout drain (piped output can be large) instead of cutting it off with process.exit().
    process.exitCode = process.exitCode ?? 0;
  },
  (err: unknown) => {
    if (err instanceof UsageError) fail(err.message, 2);
    if (err instanceof CentcomApiError) fail(err.message, 1);
    fail(err instanceof Error ? err.message : String(err), 1);
  },
);
