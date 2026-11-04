import { useSyncExternalStore } from 'react';
import { AGENTS_DIR, type ActivityEvent, type ProjectLabel, type Agent, type AgentProfileSummary, type LinkGitStatus, type LinkInfo, type Project, type ServerEvent, type ServerInfo, type Ticket, type TreeNode } from '@shared/types';
import { api, setMe } from './api';
import { authenticatedResource, UNAUTHORIZED_EVENT } from './auth';

/**
 * One small external store. The server is the source of truth; this is a live
 * mirror kept fresh by the SSE stream, so an agent filing a ticket from a
 * terminal shows up here without a refresh.
 */
export interface State {
  ready: boolean;
  online: boolean;
  info: ServerInfo | null;
  tree: TreeNode | null;
  projects: Project[];
  labels: ProjectLabel[];
  tickets: Ticket[];
  agents: Agent[];
  /** Published agent profiles (short form), for lists. */
  profiles: AgentProfileSummary[];
  activity: ActivityEvent[];
  /** agent id → a counter bumped whenever that agent's home (profile, deliverables) changes. */
  agentVersions: Record<string, number>;
  /** path → mtime of the latest external change, so open editors can react. */
  docVersions: Record<string, number>;
  /** Git state of linked folders: is the clone we are showing behind its remote? */
  linkGit: LinkGitStatus[];
}

let state: State = {
  ready: false,
  online: true,
  info: null,
  tree: null,
  projects: [],
  labels: [],
  tickets: [],
  agents: [],
  profiles: [],
  activity: [],
  agentVersions: {},
  docVersions: {},
  linkGit: [],
};

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const set = (patch: Partial<State>) => {
  state = { ...state, ...patch };
  // Whoever the server says owns this vault is who the app's writes are attributed to.
  if (patch.info) setMe(patch.info.user?.id);
  emit();
};

export const getState = () => state;
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

/* ── Refreshers. Coalesced so an SSE burst causes one fetch, not twenty. ── */

function coalesce(fn: () => Promise<void>) {
  let inflight: Promise<void> | null = null;
  let queued = false;
  const run = (): Promise<void> => {
    if (inflight) {
      queued = true;
      return inflight;
    }
    inflight = fn()
      .catch(() => {
        /* surfaced through `online` */
      })
      .finally(() => {
        inflight = null;
        if (queued) {
          queued = false;
          void run();
        }
      });
    return inflight;
  };
  return run;
}

export const refreshTree = coalesce(async () => set({ tree: await api.tree() }));
export const refreshLabels = coalesce(async () => set({ labels: await api.labels() }));
export const refreshProjects = coalesce(async () => set({ projects: await api.projects() }));
export const refreshTickets = coalesce(async () => set({ tickets: await api.tickets() }));
export const refreshAgents = coalesce(async () => set({ agents: await api.agents() }));
/** An older server without the endpoint just yields none. */
export const refreshProfiles = coalesce(async () => set({ profiles: await api.agentProfiles().catch(() => []) }));
export const refreshActivity = coalesce(async () => set({ activity: await api.activity({ limit: 200 }) }));

/** Local refs only, so it is instant and works offline. An older server without the endpoint just yields none. */
export const refreshLinkGit = coalesce(async () => set({ linkGit: await api.linkGit().catch(() => []) }));

let lastRemoteCheck = 0;
/**
 * Ask the remotes whether linked repos have new commits. Rate-limited, because it is a network
 * call made with the owner's git credentials; `force` is the explicit "Check for updates" button.
 */
export async function checkLinkUpdates(force = false): Promise<void> {
  if (!force && Date.now() - lastRemoteCheck < 15 * 60_000) return;
  lastRemoteCheck = Date.now();
  try {
    set({ linkGit: await api.linkGitFetch() });
  } catch {
    // Off-machine (fetch is loopback-only) or offline: keep showing what local refs say.
    await refreshLinkGit();
  }
}

export const gitFor = (list: LinkGitStatus[], mount: string): LinkGitStatus | null =>
  list.find((g) => g.mount === mount && g.repo) ?? null;

export async function refreshAll() {
  await Promise.all([refreshLabels(), refreshTree(), refreshProjects(), refreshTickets(), refreshAgents(), refreshProfiles(), refreshActivity()]);
}

/** Optimistic local patch so property changes feel instant; SSE reconciles after. */
export function patchTicketLocal(id: string, patch: Partial<Ticket>) {
  set({ tickets: state.tickets.map((t) => (t.id === id ? { ...t, ...patch } : t)) });
}

function handle(ev: ServerEvent) {
  switch (ev.type) {
    case 'tree':
      void refreshTree();
      // Links are added from the CLI; a tree event is how we learn the set changed.
      void api.info().then((info) => set({ info })).catch(() => {});


      break;
    case 'doc':
      if(ev.path.endsWith('/Labels.json')) void refreshLabels();
      // A hand-edited `Agents/<id>.md` is a profile change like any other.
      if (ev.path.startsWith(`${AGENTS_DIR}/`) && ev.path.endsWith('.md')) bumpAgent(ev.path.slice(AGENTS_DIR.length + 1, -3));
      set({ docVersions: { ...state.docVersions, [ev.path]: ev.deleted ? -1 : ev.mtime } });
      break;
    case 'labels':
      void refreshLabels(); break;
    case 'ticket':
      void refreshLabels();
      void refreshTickets();
      void refreshProjects(); // counts
      break;
    case 'project':
      void refreshProjects();
      void refreshTree();
      break;
    case 'activity':
      // An edited or deleted comment changes where it is; only new events go to the top.
      set({
        activity: ev.replaced
          ? state.activity.map((a) => (a.id === ev.event.id ? ev.event : a))
          : [ev.event, ...state.activity.filter((a) => a.id !== ev.event.id)].slice(0, 300),
      });
      break;
    case 'agents':
      void refreshAgents();
      break;
    case 'agent':
      bumpAgent(ev.id);
      break;
  }
}

function bumpAgent(id: string) {
  void refreshProfiles();
  set({ agentVersions: { ...state.agentVersions, [id]: (state.agentVersions[id] ?? 0) + 1 } });
}

let source: EventSource | null = null;

export async function boot() {
  try {
    const info = await api.info();
    set({ info });
    await refreshAll();
    set({ ready: true, online: true });
  } catch {
    set({ ready: true, online: false });
  }
  connect();
}

let retryTimer: number | undefined;
let retryDelay = 1000;

function connect() {
  window.clearTimeout(retryTimer);
  source?.close();
  const es = new EventSource(authenticatedResource('/api/events'));
  source = es;
  es.onopen = () => {
    retryDelay = 1000;
    if (!state.online || !state.info) {
      // Catch up on whatever we missed while disconnected (or never loaded, if the server started after us).
      void api
        .info()
        .then((info) => set({ info, online: true }))
        .then(refreshAll)
        .catch(() => {});
    }
  };
  es.onmessage = (m) => {
    try {
      handle(JSON.parse(m.data) as ServerEvent);
    } catch {
      /* ignore malformed frame */
    }
  };
  es.onerror = () => {
    if (state.online) set({ online: false });
    // The browser retries by itself only after a network-level drop. An HTTP error response
    // (a proxy's 502 while the server is down, a 401) closes the stream for good, so reconnect by
    // hand, but ask first: if this browser's session has ended, retrying would only pile up
    // failed sign-ins until the server rate-limits it. Hand over to the Connect screen instead.
    if (es.readyState === EventSource.CLOSED) {
      retryTimer = window.setTimeout(() => {
        void fetch('/api/info').then(
          (res) => (res.status === 401 ? window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT)) : connect()),
          () => connect(),
        );
      }, retryDelay);
      retryDelay = Math.min(retryDelay * 1.6, 10_000);
    }
  };
}

/** Stop the live stream (the session ended); `boot()` starts it again after reconnecting. */
export function disconnectEvents(): void {
  window.clearTimeout(retryTimer);
  source?.close();
  source = null;
}

/* ── Selectors / helpers ── */

export function findNode(root: TreeNode | null, path: string): TreeNode | null {
  if (!root) return null;
  if (path === '' || path === root.path) return root;
  const parts = path.split('/');
  let node: TreeNode | undefined = root;
  for (const part of parts) {
    node = node?.children?.find((c) => c.name === part);
    if (!node) return null;
  }
  return node;
}

export const agentById = (agents: Agent[], id: string | null | undefined): Agent | null =>
  (id && agents.find((a) => a.id === id)) || null;

/** The linked folder a path lives in, if any. Linked files belong to another repo or tool; CENTCOM only mounts them. */
export function linkFor(info: ServerInfo | null, path: string): LinkInfo | null {
  return info?.links?.find((l) => path === l.mount || path.startsWith(`${l.mount}/`)) ?? null;
}

/** `/Users/me/Projects/x` → `~/Projects/x`, using the vault path to infer the home directory. */
export function tildify(info: ServerInfo | null, abs: string): string {
  const home = /^(\/Users\/[^/]+|\/home\/[^/]+)/.exec(info?.vault ?? '')?.[1];
  return home && abs.startsWith(`${home}/`) ? `~${abs.slice(home.length)}` : abs;
}
