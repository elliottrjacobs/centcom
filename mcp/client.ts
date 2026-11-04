/**
 * Thin REST client shared by the MCP tools and the CLI. It is the ONLY way either of
 * them touches the vault, so there is a single code path (the server's) for every rule.
 */
import {
  legacyLibraryAlias,
  type ActivityEvent,
  type AddAgentDeliverableInput,
  type Agent,
  type AgentDeliverable,
  type AgentHome,
  type AgentProfile,
  type ApiError,
  type CreatedToken,
  type CreateProjectInput,
  type CreateTicketInput,
  type CreateTokenInput,
  type Doc,
  type LinkGitStatus,
  type Project,
  type SaveBookmarkInput,
  type SearchHit,
  type ServerInfo,
  type Ticket,
  type TokenInfo,
  type TreeNode,
  type UpdateTicketInput,
  type UpsertAgentProfileInput,
  type UpsertAgentProfileResult,
  type WriteDocInput,
} from '../shared/types.ts';

export const DEFAULT_URL = 'http://127.0.0.1:4747';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ClientOptions {
  /** Explicit caller location for CLI/stdio clients; never set from the backend host. */
  device?: string | undefined;
  baseUrl?: string | undefined;
  token?: string | undefined;
  /** Swap the transport. The embedded MCP endpoint passes the Hono app's own `fetch` to skip the network hop. */
  fetch?: FetchLike | undefined;
}

export class CentcomApiError extends Error {
  readonly status: number;
  readonly code: ApiError['code'];

  constructor(status: number, message: string, code?: ApiError['code']) {
    super(message);
    this.name = 'CentcomApiError';
    this.status = status;
    this.code = code;
  }
}

type Query = Record<string, string | number | boolean | null | undefined>;

export class CentcomClient {
  readonly baseUrl: string;
  private readonly device: string | undefined;
  private readonly token: string | undefined;
  private readonly fetchImpl: FetchLike;

  constructor(opts: ClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_URL).replace(/\/+$/, '');
    this.token = opts.token || undefined;
    this.device = opts.device;
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
  }

  private url(path: string, query?: Query): string {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
    const qs = params.toString();
    return `${this.baseUrl}${path}${qs ? `?${qs}` : ''}`;
  }

  async request<T>(method: string, path: string, opts: { query?: Query; json?: unknown; raw?: Uint8Array; contentType?: string } = {}): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    let body: BodyInit | undefined;
    if (opts.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.json);
    } else if (opts.raw !== undefined) {
      headers['Content-Type'] = opts.contentType ?? 'application/octet-stream';
      body = opts.raw as unknown as BodyInit;
    }

    let res: Response;
    try {
      res = await this.fetchImpl(this.url(path, opts.query), { method, headers, ...(body !== undefined ? { body } : {}) });
    } catch (err) {
      const reason = err instanceof Error ? ((err.cause as Error | undefined)?.message ?? err.message) : String(err);
      throw new CentcomApiError(0, `Cannot reach CENTCOM at ${this.baseUrl} (${reason}). Is the app or \`centcom serve\` running?`);
    }

    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    if (!res.ok) {
      const apiError = parsed as Partial<ApiError> | undefined;
      throw new CentcomApiError(res.status, apiError?.error ?? `${method} ${path} failed with HTTP ${res.status}.`, apiError?.code);
    }
    return parsed as T;
  }

  /* ── Convenience wrappers (names mirror the REST table in ARCHITECTURE.md) ── */

  health = () => this.request<{ ok: boolean }>('GET', '/api/health');
  info = () => this.request<ServerInfo>('GET', '/api/info');
  tree = () => this.request<TreeNode>('GET', '/api/tree');

  readDoc = (path: string) => this.request<Doc>('GET', '/api/doc', { query: { path } });
  writeDoc = (input: WriteDocInput) => this.request<Doc>('PUT', '/api/doc', { json: input });
  upload = (dir: string, name: string, bytes: Uint8Array, agent?: string) =>
    this.request<TreeNode>('POST', '/api/upload', { query: { dir, name, agent }, raw: bytes });

  listTickets = (query: Query = {}) => this.request<Ticket[]>('GET', '/api/tickets', { query });
  getTicket = (id: string) =>
    this.request<{ ticket: Ticket; activity: ActivityEvent[]; children: Ticket[] }>('GET', `/api/tickets/${encodeURIComponent(id)}`);
  createTicket = (input: CreateTicketInput) => this.request<Ticket>('POST', '/api/tickets', { json: { ...input, device: input.device ?? this.device } });
  updateTicket = (id: string, input: UpdateTicketInput) => this.request<Ticket>('PATCH', `/api/tickets/${encodeURIComponent(id)}`, { json: { ...input, device: input.device ?? this.device } });
  comment = (id: string, body: string, agent: string, device?: string) =>
    this.request<ActivityEvent>('POST', `/api/tickets/${encodeURIComponent(id)}/comments`, { json: { body, agent, device: device ?? this.device } });
  editComment = (id: string, commentId: string, body: string, agent: string) =>
    this.request<ActivityEvent>('PATCH', `/api/tickets/${encodeURIComponent(id)}/comments/${encodeURIComponent(commentId)}`, { json: { body, agent } });
  deleteComment = (id: string, commentId: string, agent: string) =>
    this.request<{ ok: true }>('DELETE', `/api/tickets/${encodeURIComponent(id)}/comments/${encodeURIComponent(commentId)}`, { query: { by: agent } });

  listProjects = () => this.request<Project[]>('GET', '/api/projects');
  getProject = (ref: string) => this.request<Project>('GET', `/api/projects/${encodeURIComponent(ref)}`);
  createProject = (input: CreateProjectInput & { agent?: string }) => this.request<Project>('POST', '/api/projects', { json: input });

  activity = (query: Query = {}) => this.request<ActivityEvent[]>('GET', '/api/activity', { query });
  agents = () => this.request<Agent[]>('GET', '/api/agents');
  agentHome = (id: string, limit?: number) => this.request<AgentHome>('GET', `/api/agents/${encodeURIComponent(id)}/home`, { query: { limit } });
  agentProfile = (id: string) => this.request<AgentProfile>('GET', `/api/agents/${encodeURIComponent(id)}/profile`);
  upsertAgentProfile = (id: string, input: UpsertAgentProfileInput) => this.request<UpsertAgentProfileResult>('PUT', `/api/agents/${encodeURIComponent(id)}/profile`, { json: input });
  addAgentDeliverable = (id: string, input: AddAgentDeliverableInput) => this.request<AgentDeliverable>('POST', `/api/agents/${encodeURIComponent(id)}/deliverables`, { json: input });
  removeAgentDeliverable = (id: string, deliverableId: string, agent?: string) =>
    this.request<{ ok: boolean }>('DELETE', `/api/agents/${encodeURIComponent(id)}/deliverables/${encodeURIComponent(deliverableId)}`, { query: { agent } });
  search = (q: string, limit?: number) => this.request<SearchHit[]>('GET', '/api/search', { query: { q, limit } });

  saveBookmark = (input: SaveBookmarkInput) => this.request<Doc>('POST', '/api/bookmarks', { json: input });
  refreshBookmark = (path: string, agent?: string) => this.request<Doc>('POST', '/api/bookmarks/refresh', { json: { path, ...(agent ? { agent } : {}) } });

  /** Loopback-only on the server: these work from the machine CENTCOM runs on and nowhere else. */
  linkGitStatus = () => this.request<LinkGitStatus[]>('GET', '/api/links/git');
  linkGitFetch = (mount?: string) => this.request<LinkGitStatus[]>('POST', '/api/links/git/fetch', { json: mount ? { mount } : {} });
  linkGitPull = (mount: string) => this.request<LinkGitStatus>('POST', '/api/links/git/pull', { json: { mount } });
  reindex = () => this.request<{ ok: boolean; files: number }>('POST', '/api/reindex');

  listTokens = () => this.request<TokenInfo[]>('GET', '/api/tokens');
  createToken = (input: CreateTokenInput) => this.request<CreatedToken>('POST', '/api/tokens', { json: input });
  revokeToken = (id: string) => this.request<{ ok: true; revoked: TokenInfo; sessionsEnded: number }>('DELETE', `/api/tokens/${encodeURIComponent(id)}`);
}

/** Find a node in a tree by path. An old `Projects/<Name>/Wiki/…` path finds the Library when no Wiki folder is left. */
export function findNode(root: TreeNode, path: string): TreeNode | undefined {
  const wanted = path.replace(/^\/+|\/+$/g, '');
  const found = findExact(root, wanted);
  if (found) return found;
  const alias = legacyLibraryAlias(wanted);
  return alias === null ? undefined : findExact(root, alias);
}

function findExact(root: TreeNode, wanted: string): TreeNode | undefined {
  if (wanted === '') return root;
  let current: TreeNode | undefined = root;
  let prefix = '';
  for (const segment of wanted.split('/')) {
    prefix = prefix ? `${prefix}/${segment}` : segment;
    const next: TreeNode | undefined = current?.children?.find((child) => child.path === prefix || child.path.toLowerCase() === prefix.toLowerCase());
    if (!next) return undefined;
    prefix = next.path;
    current = next;
  }
  return current;
}

export function walkFiles(node: TreeNode, visit: (file: TreeNode) => void): void {
  if (node.type === 'file') visit(node);
  for (const child of node.children ?? []) walkFiles(child, visit);
}

/* ───────────────────────── Skills (shared by the MCP tools and the CLI) ───────────────────────── */

export interface SkillSummary {
  name: string;
  description: string;
  scope: 'global' | 'project';
  project?: string;
  /** Path of the SKILL.md. */
  path: string;
  /** The skill's folder; supporting files live here. */
  folder: string;
  /** Where under the Skills root it sits when not at the top level, e.g. the name of a linked skills repo. */
  group?: string;
  /** True when the skill lives in a linked (external) folder: editing it edits the real file. */
  linked?: boolean;
}

/**
 * Skills are folders holding a `SKILL.md` (Agent Skills format). They may sit directly under
 * `folderPath` or deeper, which is how a linked skills repository (`Skills/<repo>/<skill>/SKILL.md`)
 * shows up. A folder that is a skill is not searched for further skills inside it.
 */
export async function collectSkills(client: CentcomClient, tree: TreeNode, folderPath: string, scope: SkillSummary['scope'], project?: string): Promise<SkillSummary[]> {
  const root = findNode(tree, folderPath);
  const out: SkillSummary[] = [];
  if (!root) return out;

  const visit = async (dir: TreeNode, linked: boolean, depth: number): Promise<void> => {
    const isLinked = linked || dir.linked === true;
    const file = dir === root ? undefined : dir.children?.find((c) => c.type === 'file' && c.name.toLowerCase() === 'skill.md');
    if (file) {
      let description = '';
      let name = dir.name;
      try {
        const doc = await client.readDoc(file.path);
        if (typeof doc.frontmatter.description === 'string') description = doc.frontmatter.description;
        if (typeof doc.frontmatter.name === 'string' && doc.frontmatter.name.trim()) name = doc.frontmatter.name.trim();
      } catch {
        /* unreadable skill: still list it */
      }
      const group = dir.path.slice(root.path.length + 1).split('/').slice(0, -1).join('/');
      out.push({ name, description, scope, ...(project ? { project } : {}), path: file.path, folder: dir.path, ...(group ? { group } : {}), ...(isLinked ? { linked: true } : {}) });
      return;
    }
    if (depth >= 6) return;
    for (const child of dir.children ?? []) if (child.type === 'dir') await visit(child, isLinked, depth + 1);
  };
  await visit(root, false, 0);
  return out;
}

/** Match by frontmatter `name` or folder name, case-insensitively. Earlier entries win (put project skills first). */
export function findSkill(skills: SkillSummary[], name: string): SkillSummary | undefined {
  const wanted = name.trim().toLowerCase();
  return skills.find((s) => s.name.toLowerCase() === wanted || s.folder.split('/').pop()?.toLowerCase() === wanted);
}
