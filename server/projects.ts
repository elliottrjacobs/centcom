import { promises as fs } from 'node:fs';
import path from 'node:path';
import { LIBRARY_SECTION, TICKET_STATUSES, type CreateProjectInput, type Project, type TicketStatus, type UpdateProjectInput } from '../shared/types.ts';
import { colorFor, normalizeAgentId } from './agents.ts';
import { recordActivitySafe, syncAndBroadcast, type Ctx } from './context.ts';
import { conflict, exists, invalid, notFound } from './errors.ts';
import { atomicWrite, pathExists, renameNoClobber } from './fsutil.ts';
import {
  DEFAULT_PROJECT_ICON,
  deriveProjectKey,
  INBOX_KEY,
  PROJECT_FILE,
  PROJECT_KEY_PATTERN,
  PROJECTS_DIR,
  serializeProject,
  slugifyProjectName,
  TICKETS_DIR,
  type ProjectRecord,
} from './model.ts';
import { assertNotMountOrAncestor, assertWritable } from './links.ts';
import { resolveVaultPath } from './paths.ts';
import { moveToTrash } from './trash.ts';

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** Long text is summarised in the activity log rather than copied into it twice. */
export function excerpt(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function emptyCounts(): Record<TicketStatus, number> {
  const counts = {} as Record<TicketStatus, number>;
  for (const s of TICKET_STATUSES) counts[s] = 0;
  return counts;
}

export function toApiProject(ctx: Ctx, record: ProjectRecord): Project {
  const counts = emptyCounts();
  for (const t of ctx.index.tickets.values()) if (t.project === record.slug) counts[t.status] += 1;
  return {
    slug: record.slug,
    name: record.name,
    key: record.key,
    status: record.status,
    summary: record.summary,
    color: record.color,
    icon: record.icon,
    lead: record.lead,
    path: record.path,
    body: record.body,
    counts,
    created: record.created,
    updated: record.updated,
  };
}

export function listProjects(ctx: Ctx): Project[] {
  return [...ctx.index.projects.values()].sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' })).map((p) => toApiProject(ctx, p));
}

/** Accepts a slug, a case-insensitive slug, or a key. */
export function requireProject(ctx: Ctx, ref: string): ProjectRecord {
  const record = ctx.index.findProject(ref);
  if (!record) throw notFound(`Project "${ref}" not found.`);
  return record;
}

function takenKeys(ctx: Ctx, exceptSlug?: string): Set<string> {
  const taken = new Set<string>([INBOX_KEY]);
  for (const p of ctx.index.projects.values()) if (p.slug !== exceptSlug) taken.add(p.key);
  return taken;
}

function validateKey(ctx: Ctx, raw: string, exceptSlug?: string): string {
  const key = raw.trim().toUpperCase();
  if (!PROJECT_KEY_PATTERN.test(key)) throw invalid('key must be 2–5 letters (A–Z).');
  if (key === INBOX_KEY) throw invalid(`"${INBOX_KEY}" is reserved for the Inbox.`);
  if (takenKeys(ctx, exceptSlug).has(key)) throw exists(`Another project already uses the key ${key}.`);
  return key;
}

function validateLead(lead: string | null | undefined): string | null | undefined {
  if (lead === undefined) return undefined;
  if (lead === null || lead.trim() === '') return null;
  return normalizeAgentId(lead, 'lead');
}

async function writeProjectFile(ctx: Ctx, record: ProjectRecord): Promise<void> {
  const file = await resolveVaultPath(ctx.vault, `${record.path}/${PROJECT_FILE}`);
  assertWritable(file, 'updated');
  await atomicWrite(file.abs, serializeProject(record));
}

export async function createProject(ctx: Ctx, input: CreateProjectInput, agent: string): Promise<Project> {
  const name = (input.name ?? '').trim();
  const slug = slugifyProjectName(name);
  if (!slug) throw invalid('name is required and must contain at least one usable character.');
  if (input.color !== undefined && !HEX_COLOR.test(input.color)) throw invalid('color must be a hex colour like #5E6AD2.');

  // Project creation is rare; serialising it keeps key uniqueness race-free.
  return ctx.locks.run('projects', async () => {
    const dir = await resolveVaultPath(ctx.vault, `${PROJECTS_DIR}/${slug}`);
    if ((await pathExists(dir.abs)) || ctx.index.findProject(slug)?.slug.toLowerCase() === slug.toLowerCase()) {
      throw exists(`A project named "${slug}" already exists.`);
    }
    const key = input.key !== undefined && input.key !== '' ? validateKey(ctx, input.key) : deriveProjectKey(slug, takenKeys(ctx));
    const now = Date.now();
    const record: ProjectRecord = {
      slug,
      name: slugifyProjectName(name) === name ? name : slug,
      key,
      keyExplicit: true,
      declaredKey: key,
      status: input.status ?? 'active',
      summary: (input.summary ?? '').trim(),
      color: input.color ?? colorFor(slug),
      icon: input.icon?.trim() || DEFAULT_PROJECT_ICON,
      lead: validateLead(input.lead) ?? null,
      path: dir.rel,
      body: input.body ?? '',
      created: now,
      updated: now,
      hasFile: true,
      extra: {},
    };
    for (const section of [TICKETS_DIR, LIBRARY_SECTION]) await fs.mkdir(path.join(dir.abs, section), { recursive: true });
    await writeProjectFile(ctx, record);
    await syncAndBroadcast(ctx, [dir.rel]);
    await recordActivitySafe(ctx, { agent, type: 'doc.created', path: `${dir.rel}/${PROJECT_FILE}`, project: slug, subject: record.name });
    return toApiProject(ctx, requireProject(ctx, slug));
  });
}

/** Make sure a project has a `project.md` with an explicit key, so its ticket ids can never drift. */
export async function ensureProjectFile(ctx: Ctx, record: ProjectRecord): Promise<ProjectRecord> {
  if (record.hasFile && record.keyExplicit) return record;
  return ctx.locks.run('projects', async () => {
    const fresh = requireProject(ctx, record.slug);
    if (fresh.hasFile && fresh.keyExplicit) return fresh;
    const next: ProjectRecord = { ...fresh, keyExplicit: true, declaredKey: fresh.key, hasFile: true, updated: Date.now() };
    await writeProjectFile(ctx, next);
    await syncAndBroadcast(ctx, [`${fresh.path}/${PROJECT_FILE}`]);
    return requireProject(ctx, record.slug);
  });
}

export async function updateProject(ctx: Ctx, ref: string, input: UpdateProjectInput, agent: string): Promise<Project> {
  if (input.color !== undefined && !HEX_COLOR.test(input.color)) throw invalid('color must be a hex colour like #5E6AD2.');
  return ctx.locks.run('projects', async () => {
    const current = requireProject(ctx, ref);
    const next: ProjectRecord = { ...current, extra: { ...current.extra } };
    const changes: Record<string, [unknown, unknown]> = {};
    const set = <K extends keyof ProjectRecord>(field: K, value: ProjectRecord[K]) => {
      if (current[field] === value) return;
      changes[field] = field === 'body' ? [excerpt(String(current[field])), excerpt(String(value))] : [current[field], value];
      next[field] = value;
    };

    if (input.status !== undefined) set('status', input.status);
    if (input.summary !== undefined) set('summary', input.summary.trim());
    if (input.color !== undefined) set('color', input.color);
    if (input.icon !== undefined) set('icon', input.icon.trim() || DEFAULT_PROJECT_ICON);
    if (input.body !== undefined) set('body', input.body);
    const lead = validateLead(input.lead);
    if (lead !== undefined) set('lead', lead);

    if (input.key !== undefined && input.key.trim().toUpperCase() !== current.key) {
      const key = validateKey(ctx, input.key, current.slug);
      const hasTickets = [...ctx.index.tickets.values()].some((t) => t.project === current.slug);
      if (hasTickets) throw conflict(`The key cannot change once a project has tickets (${current.key}-… ids are already in use).`);
      set('key', key);
      next.declaredKey = key;
      next.keyExplicit = true;
    }

    let newSlug = current.slug;
    if (input.name !== undefined) {
      const name = input.name.trim();
      newSlug = slugifyProjectName(name);
      if (!newSlug) throw invalid('name must contain at least one usable character.');
      if (newSlug !== current.slug) {
        const clash = ctx.index.findProject(newSlug);
        if (clash && clash.slug !== current.slug && clash.slug.toLowerCase() === newSlug.toLowerCase()) throw exists(`A project named "${newSlug}" already exists.`);
        changes.name = [current.name, newSlug];
      }
      next.name = slugifyProjectName(name) === name ? name : newSlug;
    }

    if (Object.keys(changes).length === 0 && current.hasFile && current.keyExplicit) return toApiProject(ctx, current);

    next.updated = Date.now();
    next.hasFile = true;
    next.keyExplicit = true;
    next.declaredKey = next.key;

    const touched: string[] = [];
    if (newSlug !== current.slug) {
      const from = await resolveVaultPath(ctx.vault, current.path);
      const to = await resolveVaultPath(ctx.vault, `${PROJECTS_DIR}/${newSlug}`);
      assertNotMountOrAncestor(ctx.vault, from, 'renamed');
      await renameNoClobber(from.abs, to.abs);
      next.slug = newSlug;
      next.path = to.rel;
      touched.push(from.rel, to.rel);
    }
    await writeProjectFile(ctx, next);
    touched.push(`${next.path}/${PROJECT_FILE}`);
    await syncAndBroadcast(ctx, touched);
    await recordActivitySafe(ctx, {
      agent,
      type: newSlug !== current.slug ? 'doc.moved' : 'doc.updated',
      path: `${next.path}/${PROJECT_FILE}`,
      project: next.slug,
      subject: next.name,
      changes,
    });
    return toApiProject(ctx, requireProject(ctx, next.slug));
  });
}

export async function deleteProject(ctx: Ctx, ref: string, agent: string): Promise<{ ok: true; trashId: string }> {
  return ctx.locks.run('projects', async () => {
    const record = requireProject(ctx, ref);
    const dir = await resolveVaultPath(ctx.vault, record.path);
    const { trashId, removed } = await moveToTrash(ctx, dir);
    await syncAndBroadcast(ctx, removed);
    await recordActivitySafe(ctx, { agent, type: 'doc.deleted', path: record.path, project: record.slug, subject: record.name });
    return { ok: true as const, trashId };
  });
}
