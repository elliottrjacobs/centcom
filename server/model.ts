/**
 * Pure parsing / serialising of the two structured file types: tickets and `project.md`.
 * Liberal in what it reads (never throws on odd input), strict in what it writes.
 */
import type { Stats } from 'node:fs';
import {
  PROJECT_STATUSES,
  TICKET_STATUSES,
  type Frontmatter,
  type ProjectStatus,
  type Ticket,
  type TicketPriority,
  type TicketStatus,
} from '../shared/types.ts';
import { colorFor, normalizeAgentId } from './agents.ts';
import { birthOf, mtimeOf } from './fsutil.ts';
import { fileStem, firstHeading, parseMarkdown, serializeMarkdown, toEpoch } from './markdown.ts';
import { fileKind } from './paths.ts';

export const INBOX_KEY = 'INB';
export const INBOX_DIR = 'Inbox';
export const PROJECTS_DIR = 'Projects';
export const TICKETS_DIR = 'Tickets';
export const PROJECT_FILE = 'project.md';
export const DEFAULT_PROJECT_ICON = 'Folder';

export const TICKET_ID_PATTERN = /^([A-Za-z][A-Za-z0-9]{0,9})-(\d{1,9})$/;
export const PROJECT_KEY_PATTERN = /^[A-Z]{2,5}$/;

/* ───────────────────────── Tickets ───────────────────────── */

/** A ticket as held in the index: the contract shape plus what we must round-trip. */
export interface TicketRecord extends Ticket {
  previousIds: string[];
  /** Frontmatter keys we do not own; preserved verbatim on rewrite. */
  extra: Frontmatter;
}

const TICKET_KEYS = new Set([
  'id',
  'title',
  'status',
  'priority',
  'agent',
  'assignee',
  'owner',
  'created_by',
  'createdBy',
  'labels',
  'tags',
  'due',
  'parent',
  'previous_ids',
  'previousIds',
  'created',
  'updated',
]);

/** Where ticket files live. Returns the owning project slug (null = Inbox), or null when `rel` is not a ticket path. */
export function ticketLocation(rel: string): { project: string | null } | null {
  const parts = rel.split('/');
  if (fileKind(parts[parts.length - 1] ?? '') !== 'markdown') return null;
  if (parts.length === 2 && parts[0] === INBOX_DIR) return { project: null };
  if (parts.length === 4 && parts[0] === PROJECTS_DIR && parts[2] === TICKETS_DIR) return { project: parts[1] as string };
  return null;
}

export function ticketDir(project: string | null): string {
  return project === null ? INBOX_DIR : `${PROJECTS_DIR}/${project}/${TICKETS_DIR}`;
}

export function normalizeTicketId(id: string): string {
  const m = TICKET_ID_PATTERN.exec(id.trim());
  return m ? `${(m[1] as string).toUpperCase()}-${Number(m[2])}` : id.trim();
}

const STATUS_SYNONYMS: Record<string, TicketStatus> = {
  open: 'todo',
  new: 'todo',
  ready: 'todo',
  doing: 'in_progress',
  wip: 'in_progress',
  started: 'in_progress',
  active: 'in_progress',
  inprogress: 'in_progress',
  progress: 'in_progress',
  review: 'in_review',
  inreview: 'in_review',
  reviewing: 'in_review',
  complete: 'done',
  completed: 'done',
  closed: 'done',
  finished: 'done',
  shipped: 'done',
  cancelled: 'canceled',
  cancel: 'canceled',
  wontfix: 'canceled',
  dropped: 'canceled',
};

export function coerceTicketStatus(value: unknown): TicketStatus | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if ((TICKET_STATUSES as readonly string[]).includes(v)) return v as TicketStatus;
  return STATUS_SYNONYMS[v.replace(/_/g, '')] ?? null;
}

const PRIORITY_NAMES: Record<string, TicketPriority> = { none: 0, urgent: 1, critical: 1, p0: 1, high: 2, p1: 2, medium: 3, med: 3, normal: 3, p2: 3, low: 4, p3: 4 };

export function coerceTicketPriority(value: unknown): TicketPriority | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 4) return value as TicketPriority;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (/^[0-4]$/.test(v)) return Number(v) as TicketPriority;
    return PRIORITY_NAMES[v] ?? null;
  }
  return null;
}

export function coerceLabels(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' && typeof item !== 'number') continue;
    const label = String(item).trim().replace(/^#/, '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (label && !out.some(existing => existing.toLowerCase() === label.toLowerCase())) out.push(label);
  }
  return out;
}

export function coerceDue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = /^(\d{4}-\d{2}-\d{2})(?:$|[T ])/.exec(value.trim());
  if (!m) return null;
  return Number.isNaN(Date.parse(`${m[1]}T00:00:00Z`)) ? null : (m[1] as string);
}

function coerceAgentOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const lowered = value.trim().toLowerCase();
  if (lowered === 'null' || lowered === 'none' || lowered === 'unassigned') return null;
  try {
    return normalizeAgentId(value);
  } catch {
    return null;
  }
}

function coerceIdList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || !item.trim()) continue;
    const id = normalizeTicketId(item);
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Parse a ticket file. `takenIds` lets the caller veto a frontmatter id that another file already owns.
 * Id precedence: an id-shaped filename, then an id-shaped frontmatter `id`, then the bare filename.
 */
export function parseTicketFile(rel: string, raw: string, stat: Stats, project: string | null, idTaken?: (id: string) => boolean): TicketRecord {
  const parsed = parseMarkdown(raw);
  const fm = parsed.frontmatter;
  const stem = fileStem(rel);

  let id: string;
  if (TICKET_ID_PATTERN.test(stem)) {
    id = normalizeTicketId(stem);
  } else if (typeof fm.id === 'string' && TICKET_ID_PATTERN.test(fm.id.trim()) && !idTaken?.(normalizeTicketId(fm.id))) {
    id = normalizeTicketId(fm.id);
  } else {
    id = stem;
  }

  const title =
    (typeof fm.title === 'string' && fm.title.trim()) || (typeof fm.title === 'number' && String(fm.title)) || firstHeading(parsed.body) || stem;

  const extra: Frontmatter = {};
  for (const [k, v] of Object.entries(fm)) if (!TICKET_KEYS.has(k)) extra[k] = v;

  const parentRaw = typeof fm.parent === 'string' && fm.parent.trim() ? normalizeTicketId(fm.parent) : null;

  return {
    id,
    path: rel,
    title: title.slice(0, 500),
    status: coerceTicketStatus(fm.status) ?? 'backlog',
    priority: coerceTicketPriority(fm.priority) ?? 0,
    agent: coerceAgentOrNull(fm.agent ?? fm.assignee ?? fm.owner),
    createdBy: coerceAgentOrNull(fm.created_by ?? fm.createdBy) ?? 'filesystem',
    labels: coerceLabels(fm.labels ?? fm.tags),
    project,
    due: coerceDue(fm.due),
    parent: parentRaw && parentRaw.toUpperCase() !== id.toUpperCase() ? parentRaw : null,
    body: parsed.body,
    created: toEpoch(fm.created) ?? birthOf(stat),
    updated: toEpoch(fm.updated) ?? mtimeOf(stat),
    previousIds: coerceIdList(fm.previous_ids ?? fm.previousIds).filter((p) => p.toUpperCase() !== id.toUpperCase()),
    extra,
  };
}

/** The canonical on-disk form, in the key order documented in ARCHITECTURE.md. */
export function serializeTicket(t: TicketRecord): string {
  const fm: Frontmatter = {
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    agent: t.agent,
    created_by: t.createdBy,
    labels: t.labels,
    due: t.due,
    parent: t.parent,
    previous_ids: t.previousIds,
    created: new Date(t.created),
    updated: new Date(t.updated),
    ...t.extra,
  };
  return serializeMarkdown(fm, t.body, { flow: true });
}

/** Strip index-only fields. `previousIds` is kept: additive, and useful to clients. */
export function toApiTicket(t: TicketRecord): Ticket & { previousIds: string[] } {
  const { extra: _extra, ...rest } = t;
  return { ...rest, labels: [...t.labels], previousIds: [...t.previousIds] };
}

/* ───────────────────────── Projects ───────────────────────── */

export interface ProjectRecord {
  slug: string;
  name: string;
  /** Effective key. Assigned by the index once every project is known (see `declaredKey`). */
  key: string;
  /** False when the key was derived because `project.md` had none, or another project already owns it. */
  keyExplicit: boolean;
  /** Valid key found in `project.md`, before uniqueness is considered. */
  declaredKey: string | null;
  status: ProjectStatus;
  summary: string;
  color: string;
  icon: string;
  lead: string | null;
  path: string;
  body: string;
  created: number;
  updated: number;
  hasFile: boolean;
  extra: Frontmatter;
}

const PROJECT_KEYS = new Set(['name', 'key', 'status', 'summary', 'color', 'icon', 'lead', 'created', 'updated']);

/** Where a project lives: `Projects/<slug>` (dir) or `Projects/<slug>/project.md`. */
export function projectSlugOf(rel: string): { slug: string; isFile: boolean; isRoot: boolean } | null {
  const parts = rel.split('/');
  if (parts[0] !== PROJECTS_DIR || parts.length < 2) return null;
  const slug = parts[1] as string;
  if (parts.length === 2) return { slug, isFile: false, isRoot: true };
  if (parts.length === 3 && parts[2] === PROJECT_FILE) return { slug, isFile: true, isRoot: false };
  return { slug, isFile: false, isRoot: false };
}

/** Folder-safe display name: strips separators/control chars, collapses whitespace, no leading dots. */
export function slugifyProjectName(name: string): string {
  return name
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
    .trim()
    .slice(0, 80)
    .trim();
}

export function coerceProjectStatus(value: unknown): ProjectStatus | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if ((PROJECT_STATUSES as readonly string[]).includes(v)) return v as ProjectStatus;
  if (v === 'cancelled') return 'canceled';
  if (v === 'complete' || v === 'done' || v === 'shipped') return 'completed';
  if (v === 'in_progress' || v === 'in progress' || v === 'started') return 'active';
  if (v === 'on hold' || v === 'on_hold') return 'paused';
  return null;
}

/** `Recall Radar` → RR, `CENTCOM` → CEN, then progressively longer / suffixed until unique. */
export function deriveProjectKey(name: string, taken: ReadonlySet<string>): string {
  const words = name
    .normalize('NFKD')
    .replace(/[^A-Za-z\s-]/g, '')
    .split(/[\s-]+/)
    .filter(Boolean);
  const letters = words.join('').toUpperCase();
  const candidates: string[] = [];
  if (words.length >= 2) candidates.push(words.map((w) => w.charAt(0)).join('').toUpperCase().slice(0, 5));
  for (const len of [3, 4, 5, 2]) if (letters.length >= len) candidates.push(letters.slice(0, len));
  const base = (candidates.find((c) => c.length >= 2) ?? 'PRJ').slice(0, 4);
  for (const c of candidates) if (PROJECT_KEY_PATTERN.test(c) && !taken.has(c)) return c;
  for (const suffix of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    const c = `${base}${suffix}`.slice(0, 5);
    if (PROJECT_KEY_PATTERN.test(c) && !taken.has(c)) return c;
  }
  for (let i = 0; i < 26 * 26; i += 1) {
    const c = `P${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}`;
    if (!taken.has(c)) return c;
  }
  return 'PRJ';
}

/** Key uniqueness is resolved afterwards by `assignProjectKeys`; here `key` is only a provisional value. */
export function parseProjectFile(slug: string, raw: string | null, fileStat: Stats | null, dirStat: Stats): ProjectRecord {
  const parsed = raw === null ? { frontmatter: {} as Frontmatter, body: '' } : parseMarkdown(raw);
  const fm = parsed.frontmatter;
  const explicitKey = typeof fm.key === 'string' && PROJECT_KEY_PATTERN.test(fm.key.trim().toUpperCase()) ? fm.key.trim().toUpperCase() : null;
  const declaredKey = explicitKey && explicitKey !== INBOX_KEY ? explicitKey : null;
  const declaredName = typeof fm.name === 'string' && slugifyProjectName(fm.name) === slug ? fm.name.trim() : slug;

  const extra: Frontmatter = {};
  for (const [k, v] of Object.entries(fm)) if (!PROJECT_KEYS.has(k)) extra[k] = v;

  let lead: string | null = null;
  if (typeof fm.lead === 'string' && fm.lead.trim()) {
    try {
      lead = normalizeAgentId(fm.lead);
    } catch {
      lead = null;
    }
  }

  return {
    slug,
    name: declaredName,
    key: declaredKey ?? deriveProjectKey(slug, new Set([INBOX_KEY])),
    keyExplicit: declaredKey !== null,
    declaredKey,
    status: coerceProjectStatus(fm.status) ?? 'active',
    summary: typeof fm.summary === 'string' ? fm.summary.trim() : '',
    color: typeof fm.color === 'string' && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(fm.color.trim()) ? fm.color.trim() : colorFor(slug),
    icon: typeof fm.icon === 'string' && fm.icon.trim() ? fm.icon.trim() : DEFAULT_PROJECT_ICON,
    lead,
    path: `${PROJECTS_DIR}/${slug}`,
    body: parsed.body,
    created: toEpoch(fm.created) ?? birthOf(fileStat ?? dirStat),
    updated: toEpoch(fm.updated) ?? mtimeOf(fileStat ?? dirStat),
    hasFile: raw !== null,
    extra,
  };
}

/**
 * Settle every project's effective key. Declared keys win (first by slug on a clash);
 * everyone else gets a derived key that avoids all of them. Deterministic for a given set.
 */
export function assignProjectKeys(projects: Iterable<ProjectRecord>): void {
  const ordered = [...projects].sort((a, b) => a.slug.localeCompare(b.slug));
  const taken = new Set<string>([INBOX_KEY]);
  const pending: ProjectRecord[] = [];
  for (const p of ordered) {
    if (p.declaredKey && !taken.has(p.declaredKey)) {
      p.key = p.declaredKey;
      p.keyExplicit = true;
      taken.add(p.key);
    } else {
      pending.push(p);
    }
  }
  for (const p of pending) {
    p.key = deriveProjectKey(p.slug, taken);
    p.keyExplicit = false;
    taken.add(p.key);
  }
}

export function serializeProject(p: ProjectRecord): string {
  const fm: Frontmatter = {
    ...(p.name !== p.slug ? { name: p.name } : {}),
    key: p.key,
    status: p.status,
    summary: p.summary,
    color: p.color,
    icon: p.icon,
    lead: p.lead,
    created: new Date(p.created),
    updated: new Date(p.updated),
    ...p.extra,
  };
  return serializeMarkdown(fm, p.body);
}
