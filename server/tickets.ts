import { reportedDevice } from './device.ts';
import { LABEL_LOCK, canonicalLabels } from './labels.ts';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  META_DIR,
  TICKET_STATUSES,
  TRASH_DIR,
  type ActivityEvent,
  type CreateTicketInput,
  type TicketStatus,
  type UpdateTicketInput,
} from '../shared/types.ts';
import { actingAgent, recordActivity, recordActivitySafe, syncAndBroadcast, type Ctx } from './context.ts';
import { normalizeAgentId } from './agents.ts';
import { HttpError, invalid, isErrno, notFound } from './errors.ts';
import { atomicCreateExclusive, atomicWrite } from './fsutil.ts';
import {
  coerceDue,
  coerceLabels,
  INBOX_KEY,
  parseTicketFile,
  serializeTicket,
  ticketDir,
  toApiTicket,
  type ProjectRecord,
  type TicketRecord,
} from './model.ts';
import { assertWritable } from './links.ts';
import { resolveVaultPath } from './paths.ts';
import { ensureProjectFile, excerpt, requireProject } from './projects.ts';
import { moveToTrash } from './trash.ts';

export type ApiTicket = ReturnType<typeof toApiTicket>;

const TICKETS_LOCK = 'tickets';

/* ───────────────────────── Counters / id allocation ───────────────────────── */

function countersPath(ctx: Ctx): string {
  return path.join(ctx.vault.root, META_DIR, 'counters.json');
}

async function readCounters(ctx: Ctx): Promise<Record<string, number>> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(countersPath(ctx), 'utf8'));
    const out: Record<string, number> = {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed)) if (typeof v === 'number' && Number.isInteger(v) && v >= 0) out[k.toUpperCase()] = v;
    }
    return out;
  } catch (err) {
    if (!isErrno(err, 'ENOENT')) ctx.log.warn(`counters.json is unreadable (${(err as Error).message}); falling back to the highest id on disk.`);
    return {};
  }
}

/** Highest `<KEY>-<n>` among file names in a directory. `prefixed` handles `.trash/<epochms>-<KEY>-<n>.md`. */
async function highestInDir(dirAbs: string, key: string, prefixed: boolean): Promise<number> {
  let names: string[];
  try {
    names = await fs.readdir(dirAbs);
  } catch {
    return 0;
  }
  const pattern = new RegExp(`^${prefixed ? '\\d+-' : ''}${key}-(\\d{1,9})\\.(?:md|markdown|mdx)$`, 'i');
  let max = 0;
  for (const name of names) {
    const m = pattern.exec(name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

/**
 * Allocate the next number for `key` and create the ticket file, all under one mutex.
 *
 *   next = max(counter, highest on disk, highest in the index incl. previous ids, highest in .trash) + 1
 *
 * The counter is persisted *before* the file is written, so a crash can skip a number
 * but never reuse one. The file itself is created exclusively, so even a second process
 * (or an agent hand-writing `CEN-13.md` at the same instant) cannot be overwritten.
 */
async function allocateAndCreate(
  ctx: Ctx,
  key: string,
  project: string | null,
  build: (id: string, rel: string) => TicketRecord,
): Promise<TicketRecord> {
  return ctx.counterLock.run(async () => {
    const dirRel = ticketDir(project);
    const dir = await resolveVaultPath(ctx.vault, dirRel);
    assertWritable(dir, 'written to');
    const counters = await readCounters(ctx);
    let n =
      Math.max(
        counters[key] ?? 0,
        await highestInDir(dir.abs, key, false),
        await highestInDir(path.join(ctx.vault.root, TRASH_DIR), key, true),
        ctx.index.highestNumber(key),
      ) + 1;

    for (let attempt = 0; attempt < 50; attempt += 1, n += 1) {
      counters[key] = n;
      await atomicWrite(countersPath(ctx), `${JSON.stringify(counters, null, 2)}\n`);
      const id = `${key}-${n}`;
      const file = await resolveVaultPath(ctx.vault, `${dirRel}/${id}.md`);
      const record = build(id, file.rel);
      try {
        await atomicCreateExclusive(file.abs, serializeTicket(record));
        return record;
      } catch (err) {
        if (err instanceof HttpError && err.code === 'exists') continue;
        throw err;
      }
    }
    throw new HttpError(500, `Could not allocate a ticket id for ${key}.`);
  });
}

/* ───────────────────────── Validation helpers ───────────────────────── */

function cleanTitle(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw invalid('title is required.');
  const title = value.replace(/\s+/g, ' ').trim();
  if (title.length > 500) throw invalid('title is too long (max 500 characters).');
  return title;
}

function cleanOwner(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value.trim() === '') return null;
  return normalizeAgentId(value, 'agent');
}

function cleanDue(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const due = coerceDue(value);
  if (!due) throw invalid('due must be a date in YYYY-MM-DD form, or null.');
  return due;
}

function resolveProjectRef(ctx: Ctx, ref: string | null | undefined): ProjectRecord | null | undefined {
  if (ref === undefined) return undefined;
  if (ref === null || ref.trim() === '') return null;
  const found = ctx.index.findProject(ref.trim());
  if (found) return found;
  if (['inbox', 'none', 'null', INBOX_KEY.toLowerCase()].includes(ref.trim().toLowerCase())) return null;
  throw notFound(`Project "${ref}" not found.`);
}

function resolveParent(ctx: Ctx, value: string | null | undefined, self?: TicketRecord): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value.trim() === '') return null;
  const parent = ctx.index.findTicket(value);
  if (!parent) throw invalid(`Parent ticket "${value}" not found.`);
  if (self) {
    // Walk up from the proposed parent; meeting ourselves means a cycle.
    const seen = new Set<string>();
    for (let cursor: TicketRecord | undefined = parent; cursor; cursor = cursor.parent ? ctx.index.findTicket(cursor.parent) : undefined) {
      if (cursor.path === self.path) throw invalid('A ticket cannot be its own ancestor.');
      if (seen.has(cursor.path)) break;
      seen.add(cursor.path);
    }
  }
  return parent.id;
}

export function requireTicket(ctx: Ctx, id: string): TicketRecord {
  const ticket = ctx.index.findTicket(id);
  if (!ticket) throw notFound(`Ticket "${id}" not found.`);
  return ticket;
}

/* ───────────────────────── Queries ───────────────────────── */

export interface TicketFilter {
  project?: string | undefined;
  status?: string | undefined;
  agent?: string | undefined;
  label?: string | undefined;
  q?: string | undefined;
  parent?: string | undefined;
}

const NONE_WORDS = new Set(['none', 'null', 'unassigned']);

export function listTickets(ctx: Ctx, filter: TicketFilter): ApiTicket[] {
  let tickets = [...ctx.index.tickets.values()];

  if (filter.project !== undefined && filter.project !== '') {
    const project = resolveProjectRef(ctx, filter.project);
    tickets = tickets.filter((t) => t.project === (project ? project.slug : null));
  }
  if (filter.status) {
    const wanted = new Set<TicketStatus>();
    for (const raw of filter.status.split(',')) {
      const s = raw.trim().toLowerCase();
      if (!s) continue;
      if (!(TICKET_STATUSES as readonly string[]).includes(s)) throw invalid(`Unknown status "${raw.trim()}". Use one of: ${TICKET_STATUSES.join(', ')}.`);
      wanted.add(s as TicketStatus);
    }
    if (wanted.size > 0) tickets = tickets.filter((t) => wanted.has(t.status));
  }
  if (filter.agent) {
    const wanted = NONE_WORDS.has(filter.agent.trim().toLowerCase()) ? null : normalizeAgentId(filter.agent);
    tickets = tickets.filter((t) => t.agent === wanted);
  }
  if (filter.label) {
    const wanted = filter.label.trim().toLowerCase();
    tickets = tickets.filter((t) => t.labels.some((l) => l.toLowerCase() === wanted));
  }
  if (filter.parent) {
    if (NONE_WORDS.has(filter.parent.trim().toLowerCase())) {
      tickets = tickets.filter((t) => t.parent === null);
    } else {
      // Resolve through previous ids on both sides so a re-keyed parent keeps its children.
      const parent = ctx.index.findTicket(filter.parent);
      tickets = parent ? tickets.filter((t) => t.parent !== null && ctx.index.findTicket(t.parent)?.path === parent.path) : [];
    }
  }
  if (filter.q?.trim()) {
    const terms = filter.q.trim().toLowerCase().split(/\s+/);
    tickets = tickets.filter((t) => {
      const hay = `${t.id}\n${t.title}\n${t.labels.join(' ')}\n${t.body}`.toLowerCase();
      return terms.every((term) => hay.includes(term));
    });
  }
  return tickets.sort((a, b) => b.updated - a.updated || a.id.localeCompare(b.id, 'en', { numeric: true })).map(toApiTicket);
}

export async function getTicketDetail(ctx: Ctx, id: string): Promise<{ ticket: ApiTicket; activity: ActivityEvent[]; children: ApiTicket[] }> {
  const ticket = requireTicket(ctx, id);
  const children = [...ctx.index.tickets.values()]
    .filter((t) => t.parent !== null && t.path !== ticket.path && ctx.index.findTicket(t.parent)?.path === ticket.path)
    .sort((a, b) => a.created - b.created)
    .map(toApiTicket);
  // Oldest first: this is a thread. (/api/activity is newest first: that one is a feed.)
  const activity = await ctx.activity.forTickets([ticket.id, ...ticket.previousIds]);
  return { ticket: toApiTicket(ticket), activity, children };
}

/* ───────────────────────── Mutations ───────────────────────── */

export async function createTicket(ctx: Ctx, input: CreateTicketInput): Promise<ApiTicket> {
  return ctx.locks.run(LABEL_LOCK, () => createTicketWithLabels(ctx,input));
}
async function createTicketWithLabels(ctx: Ctx, input: CreateTicketInput): Promise<ApiTicket> {
  const origin = reportedDevice(input.device);
  const title = cleanTitle(input.title);
  const createdBy = actingAgent(ctx, input.createdBy, 'createdBy');
  const owner = cleanOwner(input.agent) ?? null;
  const due = cleanDue(input.due) ?? null;
  const parent = resolveParent(ctx, input.parent) ?? null;

  let project = resolveProjectRef(ctx, input.project) ?? null;
  if (project) project = await ensureProjectFile(ctx, project);
  const labels = await canonicalLabels(ctx, project?.slug ?? null, input.labels ?? []);

  const now = Date.now();
  const record = await allocateAndCreate(ctx, project ? project.key : INBOX_KEY, project ? project.slug : null, (id, rel) => ({
    id,
    path: rel,
    title,
    status: input.status ?? 'backlog',
    priority: input.priority ?? 0,
    agent: owner,
    createdBy,
    labels,
    project: project ? project.slug : null,
    due,
    parent,
    body: input.body ?? '',
    created: now,
    updated: now,
    previousIds: [],
    extra: {},
  }));

  await syncAndBroadcast(ctx, [record.path]);
  await recordActivitySafe(ctx, { ...origin, agent: createdBy, type: 'ticket.created', ticket: record.id, path: record.path, project: record.project, subject: record.title, ts: now });
  return toApiTicket(ctx.index.tickets.get(record.path) ?? record);
}

/** Re-read the ticket from disk so a stale index can never cause a lost update. */
async function loadFresh(ctx: Ctx, indexed: TicketRecord): Promise<TicketRecord> {
  const file = await resolveVaultPath(ctx.vault, indexed.path);
  try {
    const [raw, stat] = await Promise.all([fs.readFile(file.abs, 'utf8'), fs.stat(file.abs)]);
    const fresh = parseTicketFile(indexed.path, raw, stat, indexed.project);
    // The index owns id resolution (duplicates, frontmatter ids); keep its verdict.
    return { ...fresh, id: indexed.id };
  } catch (err) {
    if (isErrno(err, 'ENOENT')) throw notFound(`Ticket "${indexed.id}" no longer exists on disk.`);
    throw err;
  }
}

export async function updateTicket(ctx: Ctx, idInput: string, input: UpdateTicketInput, labelOperation = false): Promise<ApiTicket> {
  if(!labelOperation) return ctx.locks.run(LABEL_LOCK, () => updateTicketWithLabels(ctx,idInput,input));
  return updateTicketWithLabels(ctx,idInput,input,true);
}
async function updateTicketWithLabels(ctx: Ctx, idInput: string, input: UpdateTicketInput, labelOperation = false): Promise<ApiTicket> {
  const origin = reportedDevice(input.device);
  const by = actingAgent(ctx, input.by, 'by');
  requireTicket(ctx, idInput);

  // One lock for all ticket rewrites: a re-key changes a ticket's path mid-flight, so per-path
  // locks would not actually exclude each other. Rewrites take milliseconds; contention is a non-issue.
  return ctx.locks.run(TICKETS_LOCK, async () => {
    const current = await loadFresh(ctx, requireTicket(ctx, idInput));
    const next: TicketRecord = { ...current, labels: [...current.labels], previousIds: [...current.previousIds], extra: { ...current.extra } };
    const changes: Record<string, [unknown, unknown]> = {};

    if (input.title !== undefined) {
      const title = cleanTitle(input.title);
      if (title !== current.title) {
        changes.title = [current.title, title];
        next.title = title;
      }
    }
    if (input.status !== undefined && input.status !== current.status) {
      changes.status = [current.status, input.status];
      next.status = input.status;
    }
    if (input.priority !== undefined && input.priority !== current.priority) {
      changes.priority = [current.priority, input.priority];
      next.priority = input.priority;
    }
    const owner = cleanOwner(input.agent);
    if (owner !== undefined && owner !== current.agent) {
      changes.agent = [current.agent, owner];
      next.agent = owner;
    }
    if(input.project !== undefined && (resolveProjectRef(ctx,input.project)?.slug ?? null) !== current.project && input.labels === undefined) input = {...input, labels: []};
    if (input.labels !== undefined) {
      const target = input.project === undefined ? current.project : resolveProjectRef(ctx,input.project)?.slug ?? null;
      const labels = labelOperation ? coerceLabels(input.labels) : await canonicalLabels(ctx,target,input.labels);
      if (labels.join('\n') !== current.labels.join('\n')) {
        changes.labels = [current.labels, labels];
        next.labels = labels;
      }
    }
    const due = cleanDue(input.due);
    if (due !== undefined && due !== current.due) {
      changes.due = [current.due, due];
      next.due = due;
    }
    const parent = resolveParent(ctx, input.parent, current);
    if (parent !== undefined && parent !== current.parent) {
      changes.parent = [current.parent, parent];
      next.parent = parent;
    }
    if (input.body !== undefined && input.body !== current.body) {
      changes.body = [excerpt(current.body), excerpt(input.body)];
      next.body = input.body;
    }

    let targetProject = resolveProjectRef(ctx, input.project);
    const moving = targetProject !== undefined && (targetProject ? targetProject.slug : null) !== current.project;

    if (Object.keys(changes).length === 0 && !moving) return toApiTicket(current);
    next.updated = Date.now();

    if (!moving) {
      const file = await resolveVaultPath(ctx.vault, current.path);
      assertWritable(file, 'updated');
      await atomicWrite(file.abs, serializeTicket(next), { createDirs: false });
      await syncAndBroadcast(ctx, [current.path]);
    } else {
      // Re-key: new id from the target's sequence, old id remembered, file moved. New file first,
      // old file removed second, so a crash leaves a duplicate rather than a hole.
      assertWritable(await resolveVaultPath(ctx.vault, current.path), 'moved');
      if (targetProject) targetProject = await ensureProjectFile(ctx, targetProject);
      const slug = targetProject ? targetProject.slug : null;
      changes.project = [current.project, slug];
      const created = await allocateAndCreate(ctx, targetProject ? targetProject.key : INBOX_KEY, slug, (id, rel) => ({
        ...next,
        id,
        path: rel,
        project: slug,
        previousIds: [...new Set([...current.previousIds, current.id])],
      }));
      changes.id = [current.id, created.id];
      const old = await resolveVaultPath(ctx.vault, current.path);
      await fs.rm(old.abs, { force: true });
      await syncAndBroadcast(ctx, [current.path, created.path]);
      next.id = created.id;
      next.path = created.path;
      next.project = slug;
    }

    await recordActivitySafe(ctx, { ...origin, agent: by, type: 'ticket.updated', ticket: next.id, path: next.path, project: next.project, subject: next.title, changes, ts: next.updated });
    return toApiTicket(ctx.index.tickets.get(next.path) ?? next);
  });
}

export async function deleteTicket(ctx: Ctx, idInput: string, byInput: unknown, deviceInput?: unknown): Promise<{ ok: true }> {
  const origin = reportedDevice(deviceInput);
  const by = actingAgent(ctx, byInput, 'by');
  requireTicket(ctx, idInput);
  return ctx.locks.run(TICKETS_LOCK, async () => {
    const ticket = requireTicket(ctx, idInput);
    const file = await resolveVaultPath(ctx.vault, ticket.path);
    const { removed } = await moveToTrash(ctx, file);
    await syncAndBroadcast(ctx, removed);
    await recordActivitySafe(ctx, { ...origin, agent: by, type: 'ticket.deleted', ticket: ticket.id, path: ticket.path, project: ticket.project, subject: ticket.title });
    return { ok: true as const };
  });
}

export async function commentOnTicket(ctx: Ctx, idInput: string, bodyInput: unknown, agentInput: unknown, deviceInput?: unknown): Promise<ActivityEvent> {
  const origin = reportedDevice(deviceInput);
  if (typeof bodyInput !== 'string' || !bodyInput.trim()) throw invalid('body is required.');
  if (bodyInput.length > 100_000) throw invalid('Comment is too long (max 100,000 characters).');
  const agent = actingAgent(ctx, agentInput);
  const ticket = requireTicket(ctx, idInput);
  // A comment is the whole point of the request, so a failure to persist it is an error (not "safe").
  const event = await recordActivity(ctx, { ...origin, agent, type: 'ticket.comment', ticket: ticket.id, path: ticket.path, project: ticket.project, subject: ticket.title, body: bodyInput.trim() });
  ctx.hub.broadcast({ type: 'ticket', id: ticket.id });
  return event;
}
