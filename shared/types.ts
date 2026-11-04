/**
 * The CENTCOM contract. The server implements it, the UI / CLI / MCP consume it.
 *
 * Storage model: everything is a file in the vault. Documents and tickets are
 * markdown with YAML frontmatter; images sit beside an optional sidecar `.md`.
 * All `path` values are vault-relative, POSIX-separated, never start with `/`.
 */

/* ───────────────────────── Vault layout ───────────────────────── */

export const ROOT_FOLDERS = ['Skills', 'Projects', 'Taste', 'Library', 'Inbox', 'Agents'] as const;
export type RootFolder = (typeof ROOT_FOLDERS)[number];

/** Sub-folders every project gets. */
export const PROJECT_SECTIONS = ['Tickets', 'Roadmap', 'Library', 'Skills'] as const;
export type ProjectSection = (typeof PROJECT_SECTIONS)[number];

/**
 * A project's library: docs, documentation, outputs, uploads, any file. (Unrelated to the root
 * `Library/` folder.) It used to be called `Wiki`; old `Projects/<Name>/Wiki/…` paths still work.
 */
export const LIBRARY_SECTION = 'Library';
export const LEGACY_LIBRARY_SECTION = 'Wiki';

/**
 * `Projects/<Name>/Wiki/…` (or `…/wiki/…`) → `Projects/<Name>/Library/…`; null for any other path.
 * The one mapping behind the alias: the server applies it in its path resolver, clients reuse it.
 */
export function legacyLibraryAlias(rel: string): string | null {
  const segments = rel.split('/');
  if (segments.length < 3 || segments[0] !== 'Projects' || !segments[1]) return null;
  if (segments[2] !== LEGACY_LIBRARY_SECTION && segments[2] !== LEGACY_LIBRARY_SECTION.toLowerCase()) return null;
  segments[2] = LIBRARY_SECTION;
  return segments.join('/');
}

/** Dot-folders are internal and never appear in the tree. */
export const TRASH_DIR = '.trash';
export const META_DIR = '.centcom';

/* ───────────────────────── Tree ───────────────────────── */

/**
 * `link` is a saved website: a small markdown file whose frontmatter has `type: link` and a
 * `url`. Everything in the vault is still a file, so bookmarks stay greppable and git-able.
 */
export type FileKind = 'markdown' | 'image' | 'link' | 'pdf' | 'video' | 'audio' | 'other';

export interface TreeNode {
  name: string;
  path: string;
  type: 'dir' | 'file';
  kind?: FileKind; // files only
  /** Display title: frontmatter `title` when present, else the file name sans extension. */
  title?: string;
  mtime: number; // epoch ms
  size?: number;
  /** Any non-markdown file: path of its hidden `<file>.<ext>.md` note, when one exists. */
  sidecar?: string;
  /** `link` only: the saved URL, its site (hostname), and a locally stored preview image path. */
  url?: string;
  site?: string;
  thumb?: string;
  /** `link` only: short description from the page, for cards. */
  description?: string;
  /** True on the mount point of a linked external folder (see `LinkInfo`). */
  linked?: boolean;
  children?: TreeNode[]; // dirs only; dirs first, then files, each A→Z
}

/* ───────────────────────── Documents ───────────────────────── */

export type Frontmatter = Record<string, unknown>;

export interface Doc {
  path: string;
  title: string;
  frontmatter: Frontmatter;
  /** Markdown body without the frontmatter block. */
  body: string;
  mtime: number;
  created: number;
}

export interface WriteDocInput {
  path: string;
  body?: string;
  /** Shallow-merged into existing frontmatter; a key set to `null` is removed. */
  frontmatter?: Frontmatter;
  /** Optimistic concurrency: reject with 409 if the file's mtime differs. */
  ifMatch?: number;
  /** Who is writing. Recorded in activity. Defaults to the vault's owner (`ServerInfo.user.id`). */
  agent?: string;
}

/* ───────────────────────── Tickets ───────────────────────── */

export const TICKET_STATUSES = ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'canceled'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

/** 0 none · 1 urgent · 2 high · 3 medium · 4 low (Linear's ordering). */
export type TicketPriority = 0 | 1 | 2 | 3 | 4;

export interface Ticket {
  /** Stable human id, e.g. `CEN-12`. Inbox tickets use the `INB` key. */
  id: string;
  path: string;
  title: string;
  status: TicketStatus;
  priority: TicketPriority;
  /** Agent id that owns the work (`claude-code`, `codex`, the owner's id, …) or null. */
  agent: string | null;
  /** Agent id that filed it. */
  createdBy: string;
  labels: string[];
  /** Project slug (folder name) or null for Inbox. */
  project: string | null;
  /** ISO date `YYYY-MM-DD` or null. */
  due: string | null;
  /** Parent ticket id for sub-tickets. */
  parent: string | null;
  /** Markdown description. */
  body: string;
  created: number;
  updated: number;
}

export interface CreateTicketInput {
  /** Device/runtime performing this action, independent of the agent identity. */
  device?: string;
  title: string;
  project?: string | null;
  status?: TicketStatus;
  priority?: TicketPriority;
  agent?: string | null;
  createdBy?: string;
  labels?: string[];
  due?: string | null;
  parent?: string | null;
  body?: string;
}

export type UpdateTicketInput = Partial<Omit<CreateTicketInput, 'createdBy'>> & {
  /** Who is making the change; recorded in activity. */
  by?: string;
};

/* ───────────────────────── Activity ───────────────────────── */

export type ActivityType =
  | 'ticket.created'
  | 'ticket.updated' // `changes` holds field → [from, to]
  | 'ticket.comment' // `body` holds markdown
  | 'ticket.deleted'
  | 'doc.created'
  | 'doc.updated'
  | 'doc.deleted'
  | 'doc.moved'
  // An agent's description, instructions or skills changed. Never rate-limited: agents act on
  // these, so who changed them is an audit trail. `target` is the agent, `changes` the fields.
  | 'agent.instructions_changed';

export interface ActivityEvent {
  /** Caller-reported device/runtime. Missing on legacy or unreported actions. */
  device?: string;
  id: string;
  ts: number;
  agent: string;
  type: ActivityType;
  /** Ticket id when ticket-scoped. */
  ticket?: string;
  path?: string;
  project?: string | null;
  /** Short human-readable subject (ticket title / doc title). */
  subject?: string;
  body?: string;
  changes?: Record<string, [unknown, unknown]>;
  /** `agent.instructions_changed`: whose instructions. */
  target?: string;
  /** `ticket.comment`: when and by whom the body was last replaced. The old text is not kept. */
  editedAt?: number;
  editedBy?: string;
  /** `ticket.comment`: a deleted comment keeps its place, author and time; its body is gone. */
  deletedAt?: number;
  deletedBy?: string;
}

/* ───────────────────────── Agents ───────────────────────── */

export interface Agent {
  id: string; // slug: `claude-code`
  name: string; // `Claude Code`
  kind: 'human' | 'agent';
  color: string; // hex
  lastSeen: number | null;
  /** Server-owned directory membership. Attribution-only tools, devices and humans are excluded. */
  showInDirectory?: boolean;
}

/* ───────────────────────── Agent homes ─────────────────────────
 * Every agent gets a home: who it is, how it operates, what it can do, and what it made.
 * Stored as `Agents/<id>.md` (frontmatter + `## Description` / `## Instructions and rules`).
 * The registry (`Agent`) stays the source of id / name / kind / colour / lastSeen.
 */
export const AGENTS_DIR = 'Agents';

/** `grokbot-sync`: mirrored from the Grok bot machine; `self-reported`: the agent wrote it. */
export type AgentProfileSource = 'grokbot-sync' | 'self-reported';

export interface AgentSkill {
  name: string;
  description: string;
}

export const DELIVERABLE_KINDS = ['pr', 'doc', 'file', 'link', 'other'] as const;
export type AgentDeliverableKind = (typeof DELIVERABLE_KINDS)[number];

export interface AgentDeliverable {
  id: string;
  title: string;
  /** Absolute http(s) URL, or a vault-relative path to a CENTCOM doc. */
  url: string;
  kind: AgentDeliverableKind;
  /** `YYYY-MM-DD`. */
  date: string;
  /** Project slug. */
  project?: string;
  note?: string;
  addedBy: string;
}

export interface AgentProfile {
  id: string;
  name: string;
  source: AgentProfileSource;
  /** Markdown: who the agent is. */
  description: string;
  /** Markdown: how it operates, its rules. */
  instructions: string;
  skills: AgentSkill[];
  /** Newest first. */
  deliverables: AgentDeliverable[];
  /** Epoch ms of the last change (frontmatter `updated`, ISO on disk). */
  updated: number;
  updatedBy: string;
  /** `Agents/<id>.md`. */
  path: string;
}

/** What a list of agents shows: who each one is, without the long parts. */
export type AgentProfileSummary = Pick<AgentProfile, 'id' | 'name' | 'source' | 'description' | 'updated' | 'updatedBy'>;

export interface UpsertAgentProfileInput {
  name?: string;
  description: string;
  instructions: string;
  /** Omitted: keep the current list. */
  skills?: AgentSkill[];
  /** Default `self-reported`. */
  source?: AgentProfileSource;
  /** Who is writing. Defaults to the profile's own agent id. */
  agent?: string;
}

export interface UpsertAgentProfileResult {
  profile: AgentProfile;
  /** False when nothing differed: the file was not rewritten and `updated` did not move. */
  changed: boolean;
}

export interface AddAgentDeliverableInput {
  title: string;
  url: string;
  kind: AgentDeliverableKind;
  /** Default today. */
  date?: string;
  project?: string;
  note?: string;
  agent?: string;
}

export interface AgentHome {
  agent: Agent;
  profile: AgentProfile | null;
  deliverables: AgentDeliverable[];
  /** Events attributed to this agent, newest first. */
  activity: ActivityEvent[];
}

/* ───────────────────────── Projects ───────────────────────── */

export const PROJECT_STATUSES = ['backlog', 'planned', 'active', 'paused', 'completed', 'canceled'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export interface Project {
  /** Folder name under `Projects/`; doubles as the display name. */
  slug: string;
  name: string;
  /** Ticket id prefix, 2–5 uppercase letters, unique. */
  key: string;
  status: ProjectStatus;
  summary: string;
  color: string;
  /** reicon icon name. */
  icon: string;
  lead: string | null;
  path: string; // `Projects/<slug>`
  /** Overview markdown (body of `project.md`). */
  body: string;
  counts: Record<TicketStatus, number>;
  created: number;
  updated: number;
}

export interface CreateProjectInput {
  name: string;
  key?: string; // derived from name when omitted
  status?: ProjectStatus;
  summary?: string;
  color?: string;
  icon?: string;
  lead?: string | null;
  body?: string;
}
export type UpdateProjectInput = Partial<CreateProjectInput>;

/* ───────────────────────── Roadmap ───────────────────────── */

/** Roadmap items are markdown docs in `<project>/Roadmap/` with a `stage` frontmatter key. */
export const ROADMAP_STAGES = ['idea', 'later', 'next', 'now', 'shipped'] as const;
export type RoadmapStage = (typeof ROADMAP_STAGES)[number];

/* ───────────────────────── Search ───────────────────────── */

export interface SearchHit {
  type: 'doc' | 'ticket' | 'project' | 'image';
  path: string;
  title: string;
  /** Ticket id when `type === 'ticket'`. */
  ticket?: string;
  project?: string | null;
  snippet?: string;
  score: number;
}

/* ───────────────────────── Live events (SSE) ───────────────────────── */

export interface ProjectLabel { id: string; project: string | null; name: string; color: string; deleted: boolean }

export type ServerEvent =
  | { type: 'labels' }
  | { type: 'tree' } // structure changed: refetch tree
  | { type: 'doc'; path: string; mtime: number; deleted?: boolean }
  | { type: 'ticket'; id: string; deleted?: boolean }
  | { type: 'project'; slug: string; deleted?: boolean }
  // `replaced`: an existing event changed in place (a comment edited or deleted), not a new one.
  | { type: 'activity'; event: ActivityEvent; replaced?: boolean }
  | { type: 'agents' }
  | { type: 'agent'; id: string }; // one agent's home (profile / deliverables) changed

/* ───────────────────────── Linked folders ─────────────────────────
 * CENTCOM is a window onto files that already have a home, not a second copy of
 * them. A link mounts an external folder (a skills repo, a project's
 * `.claude/skills`) inside the vault as a real symlink. It is followed only
 * because its target is allowlisted in the local config file; no API can add one.
 */
export interface LinkInfo {
  /** Vault-relative mount point, e.g. `Skills/shared`. */
  mount: string;
  /** Absolute path of the real folder. */
  target: string;
  /** When true, every mutation beneath the mount is refused. */
  readonly: boolean;
}

/** Git state of a linked folder that lives in a repository, so a stale clone is visible instead of silent. */
export interface LinkGitStatus {
  mount: string;
  /** False when the target is not inside a git work tree; the other fields are then absent. */
  repo: boolean;
  branch?: string;
  /** Upstream, e.g. `origin/main`. Absent when the branch tracks nothing. */
  upstream?: string;
  ahead?: number;
  behind?: number;
  /** Uncommitted changes in the work tree (a pull is refused while true). */
  dirty?: boolean;
  /** When remote refs were last fetched (epoch ms), if known. */
  fetchedAt?: number;
  error?: string;
}

/* ───────────────────────── Bookmarks ─────────────────────────
 * Saved websites. Stored as `<dir>/<Title>.md` with frontmatter
 * `type: link`, `url`, `site`, `description`, `image` (local path), `tags`, `saved`, `saved_by`;
 * the body is the user's or agent's notes.
 */
export interface SaveBookmarkInput {
  url: string;
  /** Vault folder to save into. Defaults to `Library/Links`. */
  dir?: string;
  /** Overrides the fetched page title. */
  title?: string;
  tags?: string[];
  note?: string;
  agent?: string;
}

/* ───────────────────────── Server info ───────────────────────── */

/** The human who owns this vault. Comes from config, never hardcoded, so anyone can run CENTCOM. */
export interface VaultUser {
  id: string; // agent id used for attribution, e.g. `sam`
  name: string; // display name, e.g. `Sam`
}

export interface ServerInfo {
  name: 'centcom';
  version: string;
  vault: string; // absolute path
  port: number;
  host: string;
  /** True when the server accepts non-loopback connections (token required for those). */
  remote: boolean;
  links: LinkInfo[];
  user: VaultUser;
  /** Who is asking: the agent a named token writes as (null = any) and whether it is the owner. */
  caller?: { agent: string | null; owner: boolean };
}

export interface ApiError {
  error: string;
  code?: 'not_found' | 'conflict' | 'invalid' | 'forbidden' | 'exists';
}

/* ───────────────────────── Tokens ───────────────────────── */

/**
 * `read`: every GET. `write`: tickets, comments, docs, projects, uploads and the rest.
 * `write:instructions`: rewrite another agent's profile (its instructions) and deliverables;
 * without it a token may change only its own agent's.
 */
export const TOKEN_SCOPES = ['read', 'write', 'write:instructions'] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];

/** A token as the API shows it. The secret is never returned except once, on creation. */
export interface TokenInfo {
  id: string; // `owner`, or `tok_<12 hex>`
  label: string;
  /** The agent id every write with this token is recorded as; null for the owner token (any). */
  agent: string | null;
  scopes: TokenScope[];
  /** Project slugs the token is confined to; null for every project. */
  projects: string[] | null;
  /** With `write:instructions`: agents whose instructions it may change (ids or `prefix*`); null for anyone's. */
  instructionAgents: string[] | null;
  created: number;
  lastUsed: number | null;
  owner: boolean;
}

export interface CreateTokenInput {
  label: string;
  agent: string;
  scopes: TokenScope[];
  projects?: string[];
  instructionAgents?: string[];
}

/** Returned once by `POST /api/tokens`: copy `token` now, it cannot be shown again. */
export interface CreatedToken {
  token: string;
  info: TokenInfo;
}
