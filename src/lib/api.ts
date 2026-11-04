import type { InstructionCatalog, InstructionDocument } from '@shared/instructions';
import { currentDevice } from './device';
import type { SkillCatalog, SkillDocument } from '@shared/skills';
import { authenticatedResource, UNAUTHORIZED_EVENT } from './auth';
import type {
  ProjectLabel,
  ActivityEvent,
  LinkGitStatus,
  SaveBookmarkInput,
  Agent,
  AgentHome,
  AgentProfileSummary,
  ApiError,
  CreateProjectInput,
  CreateTicketInput,
  Doc,
  Project,
  SearchHit,
  ServerInfo,
  Ticket,
  TreeNode,
  UpdateProjectInput,
  UpdateTicketInput,
  WriteDocInput,
  CreateTokenInput,
  CreatedToken,
  TokenInfo,
} from '@shared/types';

/**
 * The human at the keyboard: everything done through the app is attributed to them. It comes
 * from the server's config (`ServerInfo.user`), so nobody's name is baked into the app.
 */
let currentUser = 'me';
export const me = () => currentUser;
export const setMe = (id: string | undefined) => {
  if (id) currentUser = id;
};

export class ApiFailure extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: ApiError['code'],
  ) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
  if (!res.ok) {
    let err: ApiError | undefined;
    try {
      err = (await res.json()) as ApiError;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiFailure(err?.error ?? `${method} ${url} failed (${res.status})`, res.status, err?.code);
  }
  return (await res.json()) as T;
}

const q = (params: Record<string, string | number | undefined | null>) => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
};

/** Encode each segment but keep the slashes, so nested paths stay readable in URLs. */
export const rawUrl = (path: string, mtime?: number) =>
  authenticatedResource(`/api/raw/${path.split('/').map(encodeURIComponent).join('/')}${mtime ? `?v=${mtime}` : ''}`);

export interface TrashItem {
  id: string;
  name: string;
  originalPath: string;
  deletedAt: number;
  isDir: boolean;
}

export interface TicketDetail {
  ticket: Ticket;
  activity: ActivityEvent[];
  children: Ticket[];
}

export const api = {
  instructions: () => request<InstructionCatalog>('GET', '/api/instructions'),
  refreshInstructions: async () => {
    if (window.centcom?.isElectron) {
      if (!window.centcom.scanInstructions) throw new Error('Restart CENTCOM to enable refreshing local instruction files.');
      const report = await window.centcom.scanInstructions();
      await request('PUT', '/api/instructions/inventory', report);
    }
    return request<InstructionCatalog>('GET', '/api/instructions');
  },
  instructionDocument: (id: string) => request<InstructionDocument>('GET', `/api/instructions/copies/${encodeURIComponent(id)}`),
  skills: () => request<SkillCatalog>('GET', '/api/skills'),
  skillDocument: (id: string) => request<SkillDocument>('GET', `/api/skills/installations/${encodeURIComponent(id)}`),
  /** The server token itself: only ever handed out on the machine the server runs on. */
  connection: () => request<{ token: string; urls: string[] }>('GET', '/api/connection'),
  info: () => request<ServerInfo>('GET', '/api/info'),
  tree: () => request<TreeNode>('GET', '/api/tree'),

  doc: (path: string) => request<Doc>('GET', `/api/doc${q({ path })}`),
  saveDoc: (input: WriteDocInput) => request<Doc>('PUT', '/api/doc', { agent: me(), ...input }),
  createDoc: (path: string, body = '', frontmatter?: Record<string, unknown>) =>
    request<Doc>('POST', '/api/doc', { path, body, frontmatter, agent: me() }),
  remove: (path: string) => request<{ ok: true; trashId: string }>('DELETE', `/api/doc${q({ path })}`),
  createFolder: (path: string) => request<TreeNode>('POST', '/api/folder', { path }),
  move: (from: string, to: string) => request<{ path: string }>('POST', '/api/move', { from, to, agent: me() }),
  duplicate: (path: string) => request<{ path: string }>('POST', '/api/duplicate', { path }),
  upload: async (dir: string, file: File | Blob, name: string) => {
    const res = await fetch(`/api/upload${q({ dir, name })}`, {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => undefined)) as ApiError | undefined;
      throw new ApiFailure(err?.error ?? 'Upload failed', res.status, err?.code);
    }
    return (await res.json()) as TreeNode;
  },

  tickets: (f: { project?: string; status?: string; agent?: string; label?: string; q?: string } = {}) =>
    request<Ticket[]>('GET', `/api/tickets${q(f)}`),
  ticket: (id: string) => request<TicketDetail>('GET', `/api/tickets/${encodeURIComponent(id)}`),
  createTicket: (input: CreateTicketInput) =>
    request<Ticket>('POST', '/api/tickets', { createdBy: me(), device: currentDevice(), ...input }),
  updateTicket: (id: string, input: UpdateTicketInput) =>
    request<Ticket>('PATCH', `/api/tickets/${encodeURIComponent(id)}`, { by: me(), device: currentDevice(), ...input }),
  deleteTicket: (id: string) =>
    request<{ ok: true }>('DELETE', `/api/tickets/${encodeURIComponent(id)}${q({ by: me(), device: currentDevice() })}`),
  comment: (id: string, body: string) =>
    request<ActivityEvent>('POST', `/api/tickets/${encodeURIComponent(id)}/comments`, { body, agent: me(), device: currentDevice() }),
  editComment: (id: string, commentId: string, body: string) =>
    request<ActivityEvent>('PATCH', `/api/tickets/${encodeURIComponent(id)}/comments/${encodeURIComponent(commentId)}`, { body, agent: me() }),
  deleteComment: (id: string, commentId: string) =>
    request<{ ok: true }>('DELETE', `/api/tickets/${encodeURIComponent(id)}/comments/${encodeURIComponent(commentId)}${q({ by: me() })}`),

  labels: () => request<ProjectLabel[]>('GET', '/api/labels'),
  createLabel: (project: string | null, name: string, color: string) => request<ProjectLabel>('POST','/api/labels',{project,name,color,agent:me()}),
  updateLabel: (label: ProjectLabel, patch: Partial<Pick<ProjectLabel,'name'|'color'|'deleted'>>) => request<ProjectLabel>('PATCH',`/api/labels/${label.id}`,{project:label.project,...patch,agent:me()}),
  projects: () => request<Project[]>('GET', '/api/projects'),
  createProject: (input: CreateProjectInput) => request<Project>('POST', '/api/projects', input),
  updateProject: (slug: string, input: UpdateProjectInput) =>
    request<Project>('PATCH', `/api/projects/${encodeURIComponent(slug)}`, input),
  deleteProject: (slug: string) => request<{ ok: true }>('DELETE', `/api/projects/${encodeURIComponent(slug)}`),

  activity: (f: { limit?: number; agent?: string; project?: string; ticket?: string } = {}) =>
    request<ActivityEvent[]>('GET', `/api/activity${q(f)}`),
  agents: () => request<Agent[]>('GET', '/api/agents'),
  updateAgent: (id: string, input: Partial<Pick<Agent, 'name' | 'color' | 'kind'>>) =>
    request<Agent>('PATCH', `/api/agents/${encodeURIComponent(id)}`, input),
  agentProfiles: () => request<AgentProfileSummary[]>('GET', '/api/agent-profiles'),
  agentHome: (id: string, limit = 100) => request<AgentHome>('GET', `/api/agents/${encodeURIComponent(id)}/home${q({ limit })}`),
  removeDeliverable: (id: string, deliverableId: string) =>
    request<{ ok: true }>('DELETE', `/api/agents/${encodeURIComponent(id)}/deliverables/${encodeURIComponent(deliverableId)}${q({ agent: me() })}`),

  search: (query: string, limit = 30) => request<SearchHit[]>('GET', `/api/search${q({ q: query, limit, scope: 'tasks' })}`),

  saveBookmark: (input: SaveBookmarkInput) => request<Doc>('POST', '/api/bookmarks', { agent: me(), ...input }),
  refreshBookmark: (path: string) => request<Doc>('POST', '/api/bookmarks/refresh', { path }),

  /** Git state of linked folders, from local refs (no network). */
  linkGit: () => request<LinkGitStatus[]>('GET', '/api/links/git'),
  /** Ask the remotes what is new. Only works on the machine the server runs on. */
  linkGitFetch: (mount?: string) => request<LinkGitStatus[]>('POST', '/api/links/git/fetch', { mount }),
  linkGitPull: (mount: string) => request<LinkGitStatus>('POST', '/api/links/git/pull', { mount }),
  reindex: () => request<{ ok: true }>('POST', '/api/reindex'),

  /** Owner only: named tokens. The secret comes back once, from createToken. */
  tokens: () => request<TokenInfo[]>('GET', '/api/tokens'),
  createToken: (input: CreateTokenInput) => request<CreatedToken>('POST', '/api/tokens', input),
  revokeToken: (id: string) => request<{ ok: true; sessionsEnded: number }>('DELETE', `/api/tokens/${encodeURIComponent(id)}`),

  trash: () => request<TrashItem[]>('GET', '/api/trash'),
  restore: (id: string) => request<{ path: string }>('POST', '/api/trash/restore', { id }),
  purge: (id?: string) => request<{ ok: true }>('DELETE', `/api/trash${q({ id })}`),
};
