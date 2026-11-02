/**
 * Agent homes: one human-readable file per agent at `Agents/<id>.md`.
 *
 *   frontmatter  id, name, source, updated (ISO), updated_by, skills[], deliverables[]
 *   body         `## Description` … `## Instructions and rules` …
 *
 * Read liberally (a person may hand-edit the file), written deterministically, and only
 * rewritten when something really changed, so a daily sync that finds nothing new leaves the
 * file, its mtime and `updated` alone. The registry (`.centcom/agents.json`) stays the source of
 * id / name / kind / colour / lastSeen; a profile only adds to it.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import {
  AGENTS_DIR,
  DELIVERABLE_KINDS,
  type AddAgentDeliverableInput,
  type AgentDeliverable,
  type AgentDeliverableKind,
  type AgentHome,
  type AgentProfile,
  type AgentProfileSource,
  type AgentProfileSummary,
  type AgentSkill,
  type Frontmatter,
  type UpsertAgentProfileInput,
  type UpsertAgentProfileResult,
} from '../shared/types.ts';
import { colorFor, normalizeAgentId, titleCaseId } from './agents.ts';
import { recordActivitySafe, shouldLogDocUpdate, syncAndBroadcast, type Ctx } from './context.ts';
import { invalid, notFound } from './errors.ts';
import { atomicWrite, mtimeOf, statOrNull } from './fsutil.ts';
import { assertWritable } from './links.ts';
import { parseMarkdown, serializeMarkdown, toEpoch } from './markdown.ts';
import { resolveVaultPath, type ResolvedPath } from './paths.ts';

const DESCRIPTION_HEADING = /^##[ \t]+description[ \t]*#*[ \t]*$/im;
const INSTRUCTIONS_HEADING = /^##[ \t]+(?:(?:operating[ \t]+)?instructions(?:[ \t]+(?:and|&)[ \t]+rules)?|rules)[ \t]*#*[ \t]*$/im;

/* ───────────────────────── Parse (liberal) ───────────────────────── */

function str(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}

function coerceSource(value: unknown): AgentProfileSource {
  return value === 'grokbot-sync' ? 'grokbot-sync' : 'self-reported';
}

function coerceSkills(value: unknown): AgentSkill[] {
  if (!Array.isArray(value)) return [];
  const out: AgentSkill[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item.trim()) out.push({ name: item.trim(), description: '' });
    else if (item && typeof item === 'object') {
      const name = str((item as Record<string, unknown>).name)?.trim();
      if (name) out.push({ name, description: str((item as Record<string, unknown>).description)?.trim() ?? '' });
    }
  }
  return out;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function deliverableId(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 12);
}

/** Newest first; undated last; then by title, so the order on disk never depends on how it got there. */
function sortDeliverables(list: AgentDeliverable[]): AgentDeliverable[] {
  return [...list].sort((a, b) => (b.date || '0').localeCompare(a.date || '0') || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
}

function coerceDeliverables(value: unknown, fallbackAgent: string): AgentDeliverable[] {
  if (!Array.isArray(value)) return [];
  const out: AgentDeliverable[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const v = item as Record<string, unknown>;
    const url = str(v.url)?.trim();
    if (!url) continue;
    const kind = str(v.kind)?.trim().toLowerCase() ?? '';
    const date = str(v.date)?.trim() ?? '';
    const project = str(v.project)?.trim();
    const note = str(v.note)?.trim();
    out.push({
      // A hand-added entry without an id still gets a stable one, so it can be deleted through the API.
      id: str(v.id)?.trim() || deliverableId(url),
      title: str(v.title)?.trim() || url,
      url,
      kind: (DELIVERABLE_KINDS as readonly string[]).includes(kind) ? (kind as AgentDeliverableKind) : 'other',
      date: DATE.test(date) ? date : '',
      ...(project ? { project } : {}),
      ...(note ? { note } : {}),
      addedBy: str(v.added_by)?.trim() || str(v.addedBy)?.trim() || fallbackAgent,
    });
  }
  return sortDeliverables(out);
}

/** Split the body on the two section headings. No headings at all: the whole body is the description. */
function splitBody(body: string): { description: string; instructions: string } {
  const desc = DESCRIPTION_HEADING.exec(body);
  const descStart = desc ? desc.index + desc[0].length : 0;
  const rest = body.slice(descStart);
  const instr = INSTRUCTIONS_HEADING.exec(rest);
  return {
    description: (instr ? rest.slice(0, instr.index) : rest).trim(),
    instructions: instr ? rest.slice(instr.index + instr[0].length).trim() : '',
  };
}

function toProfile(ctx: Ctx, id: string, rel: string, raw: string, mtime: number): AgentProfile {
  const { frontmatter, body } = parseMarkdown(raw);
  const { description, instructions } = splitBody(body);
  return {
    id,
    name: str(frontmatter.name)?.trim() || ctx.agents.get(id)?.name || titleCaseId(id),
    source: coerceSource(frontmatter.source),
    description,
    instructions,
    skills: coerceSkills(frontmatter.skills),
    deliverables: coerceDeliverables(frontmatter.deliverables, id),
    updated: toEpoch(frontmatter.updated) ?? mtime,
    updatedBy: str(frontmatter.updated_by)?.trim() || id,
    path: rel,
  };
}

/* ───────────────────────── Serialize (strict, deterministic) ───────────────────────── */

function serializeProfile(p: AgentProfile): string {
  const frontmatter: Frontmatter = {
    id: p.id,
    name: p.name,
    source: p.source,
    updated: new Date(p.updated).toISOString(),
    updated_by: p.updatedBy,
    skills: p.skills.map((s) => ({ name: s.name, description: s.description })),
    deliverables: sortDeliverables(p.deliverables).map((d) => ({
      id: d.id,
      title: d.title,
      url: d.url,
      kind: d.kind,
      date: d.date,
      ...(d.project ? { project: d.project } : {}),
      ...(d.note ? { note: d.note } : {}),
      added_by: d.addedBy,
    })),
  };
  const body = ['## Description', p.description, '## Instructions and rules', p.instructions].filter(Boolean).join('\n\n');
  return serializeMarkdown(frontmatter, body);
}

/* ───────────────────────── Files ───────────────────────── */

async function profileFile(ctx: Ctx, id: string): Promise<ResolvedPath> {
  return resolveVaultPath(ctx.vault, `${AGENTS_DIR}/${id}.md`);
}

async function readAt(ctx: Ctx, id: string, file: ResolvedPath): Promise<AgentProfile | null> {
  const stat = await statOrNull(file.abs);
  if (!stat?.isFile()) return null;
  return toProfile(ctx, id, file.rel, await fs.readFile(file.abs, 'utf8'), mtimeOf(stat));
}

/** What an agent acts on: a change to any of these is an instruction change. */
const INSTRUCTION_FIELDS = ['description', 'instructions', 'skills'] as const;

function instructionChanges(before: AgentProfile | null, after: AgentProfile): Record<string, [unknown, unknown]> {
  const changes: Record<string, [unknown, unknown]> = {};
  const size = (p: AgentProfile | null, field: (typeof INSTRUCTION_FIELDS)[number]): number =>
    p === null ? 0 : field === 'skills' ? p.skills.length : p[field].length;
  for (const field of INSTRUCTION_FIELDS) {
    const same = before !== null && (field === 'skills' ? isDeepStrictEqual(before.skills, after.skills) : before[field] === after[field]);
    // Sizes, not text: the profile itself holds the content; the log records that it changed and by whom.
    if (!same && !(before === null && size(null, field) === size(after, field))) changes[field] = [size(before, field), size(after, field)];
  }
  return changes;
}

async function writeProfile(ctx: Ctx, file: ResolvedPath, profile: AgentProfile, before: AgentProfile | null, writer: string): Promise<void> {
  await atomicWrite(file.abs, serializeProfile(profile));
  await syncAndBroadcast(ctx, [file.rel]);
  ctx.hub.broadcast({ type: 'agent', id: profile.id });
  const changes = instructionChanges(before, profile);
  if (Object.keys(changes).length > 0) {
    // Every time, never rate-limited: agents follow these, so who changed them is the audit trail.
    await recordActivitySafe(ctx, { agent: writer, type: 'agent.instructions_changed', target: profile.id, path: file.rel, project: null, subject: profile.name, changes });
  } else if (before === null || shouldLogDocUpdate(ctx, writer, file.rel)) {
    await recordActivitySafe(ctx, { agent: writer, type: before === null ? 'doc.created' : 'doc.updated', path: file.rel, project: null, subject: profile.name });
  }
}

/* ───────────────────────── Interface ───────────────────────── */

export async function readProfile(ctx: Ctx, rawId: string): Promise<AgentProfile | null> {
  const id = normalizeAgentId(rawId, 'id');
  return readAt(ctx, id, await profileFile(ctx, id));
}

/** Create or replace an agent's description, instructions and (when given) skills. A no-op write changes nothing. */
export async function upsertProfile(ctx: Ctx, rawId: string, input: UpsertAgentProfileInput, writerInput?: string): Promise<UpsertAgentProfileResult> {
  const id = normalizeAgentId(rawId, 'id');
  const writer = writerInput ? normalizeAgentId(writerInput) : id;
  const name = input.name?.trim();
  if (input.name !== undefined && !name) throw invalid('name must not be empty.');
  const file = await profileFile(ctx, id);
  assertWritable(file, 'written');

  const result = await ctx.locks.run(`path:${file.rel}`, async (): Promise<UpsertAgentProfileResult> => {
    const current = await readAt(ctx, id, file);
    const next: AgentProfile = {
      id,
      name: name || current?.name || ctx.agents.get(id)?.name || titleCaseId(id),
      source: input.source ?? 'self-reported',
      description: input.description.trim(),
      instructions: input.instructions.trim(),
      skills: input.skills ? input.skills.map((s) => ({ name: s.name.trim(), description: s.description.trim() })) : (current?.skills ?? []),
      deliverables: current?.deliverables ?? [],
      updated: Date.now(),
      updatedBy: writer,
      path: file.rel,
    };
    const same =
      current !== null &&
      current.name === next.name &&
      current.source === next.source &&
      current.description === next.description &&
      current.instructions === next.instructions &&
      isDeepStrictEqual(current.skills, next.skills);
    if (same) return { profile: current, changed: false };
    await writeProfile(ctx, file, next, current, writer);
    return { profile: next, changed: true };
  });

  await ctx.agents.ensure(id, name);
  ctx.agents.touch(writer, Date.now());
  return result;
}

/** Every published profile, short form, by id. A file whose name is not an agent id is not a profile. */
export async function listProfiles(ctx: Ctx): Promise<AgentProfileSummary[]> {
  const dir = await resolveVaultPath(ctx.vault, AGENTS_DIR);
  const names = await fs.readdir(dir.abs).catch(() => [] as string[]);
  const out: AgentProfileSummary[] = [];
  for (const name of names.filter((n) => n.endsWith('.md')).sort()) {
    const id = name.slice(0, -3);
    let valid = false;
    try {
      valid = normalizeAgentId(id, 'id') === id;
    } catch {
      /* not an agent id */
    }
    if (!valid) continue;
    const profile = await readAt(ctx, id, await profileFile(ctx, id));
    if (profile) out.push({ id, name: profile.name, source: profile.source, description: profile.description, updated: profile.updated, updatedBy: profile.updatedBy });
  }
  return out;
}

/** Everything about one agent: who it is, how it works, and what it has made (reported deliverables + its own activity). */
export async function agentHome(ctx: Ctx, rawId: string, limit?: number): Promise<AgentHome> {
  const id = normalizeAgentId(rawId, 'id');
  const profile = await readAt(ctx, id, await profileFile(ctx, id));
  const registered = ctx.agents.get(id);
  if (!registered && !profile) throw notFound(`Agent "${id}" not found.`);
  return {
    agent: registered ? { ...registered } : { id, name: profile?.name ?? titleCaseId(id), kind: 'agent', color: colorFor(id), lastSeen: null },
    profile,
    deliverables: profile?.deliverables ?? [],
    activity: ctx.activity.query({ agent: id, limit: limit ?? 50 }),
  };
}

/* ───────────────────────── Deliverables ───────────────────────── */

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** http(s) only (anything else could be script once a UI renders it as a link), or a safe vault path. */
async function canonicalUrl(ctx: Ctx, raw: string): Promise<string> {
  const value = raw.trim();
  if (!value) throw invalid('url is required.');
  if (!URL_SCHEME.test(value)) return (await resolveVaultPath(ctx.vault, value)).rel;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid('url is not a valid URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw invalid('url must be an http(s) URL or a vault-relative path.');
  if (url.username || url.password) throw invalid('url must not contain credentials.');
  return url.href;
}

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function checkDate(date: string | undefined): string {
  if (date === undefined || date === '') return localToday();
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!DATE.test(date) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw invalid('date must be YYYY-MM-DD.');
  return date;
}

/** Read-modify-write of one profile's deliverables. A missing profile is created as an empty, self-reported one. */
async function mutateDeliverables<T>(
  ctx: Ctx,
  rawId: string,
  writerInput: string | undefined,
  fn: (list: AgentDeliverable[], writer: string) => { list: AgentDeliverable[]; result: T },
): Promise<T> {
  const id = normalizeAgentId(rawId, 'id');
  const writer = writerInput ? normalizeAgentId(writerInput) : id;
  const file = await profileFile(ctx, id);
  assertWritable(file, 'written');
  const result = await ctx.locks.run(`path:${file.rel}`, async () => {
    const current = await readAt(ctx, id, file);
    const { list, result } = fn(current?.deliverables ?? [], writer);
    const base = current ?? { id, name: ctx.agents.get(id)?.name || titleCaseId(id), source: 'self-reported' as const, description: '', instructions: '', skills: [], path: file.rel };
    // Deliverables are not instructions: nothing an agent acts on changes here, so no audit event.
    await writeProfile(ctx, file, { ...base, deliverables: sortDeliverables(list), updated: Date.now(), updatedBy: writer }, current, writer);
    return result;
  });
  await ctx.agents.ensure(id);
  ctx.agents.touch(writer, Date.now());
  return result;
}

/** Report something an agent made. The same url again updates that entry instead of adding another. */
export async function addDeliverable(ctx: Ctx, rawId: string, input: AddAgentDeliverableInput, writerInput?: string): Promise<{ deliverable: AgentDeliverable; created: boolean }> {
  const title = input.title.trim();
  if (!title) throw invalid('title is required.');
  if (!(DELIVERABLE_KINDS as readonly string[]).includes(input.kind)) throw invalid(`kind must be one of ${DELIVERABLE_KINDS.join(', ')}.`);
  const url = await canonicalUrl(ctx, input.url);
  const date = checkDate(input.date);
  let project: string | undefined;
  if (input.project !== undefined && input.project.trim() !== '') {
    project = ctx.index.findProject(input.project.trim())?.slug;
    if (!project) throw invalid(`project "${input.project}" not found.`);
  }
  const note = input.note?.trim();
  return mutateDeliverables(ctx, rawId, writerInput, (list, writer) => {
    const existing = list.find((d) => d.url === url);
    const deliverable: AgentDeliverable = { id: existing?.id ?? deliverableId(url), title, url, kind: input.kind, date, ...(project ? { project } : {}), ...(note ? { note } : {}), addedBy: writer };
    return { list: [...list.filter((d) => d !== existing), deliverable], result: { deliverable, created: !existing } };
  });
}

export async function removeDeliverable(ctx: Ctx, rawId: string, deliverableId: string, writerInput?: string): Promise<void> {
  await mutateDeliverables(ctx, rawId, writerInput, (list) => {
    if (!list.some((d) => d.id === deliverableId)) throw notFound(`Agent "${rawId}" has no deliverable "${deliverableId}".`);
    return { list: list.filter((d) => d.id !== deliverableId), result: undefined };
  });
}
