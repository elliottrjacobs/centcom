import { AGENTS_DIR, legacyLibraryAlias, type FileKind } from '@shared/types';

/**
 * The app's routes and their hash URLs. Pure (no `window`), so it can be tested; `router.ts`
 * adds the live hash state on top.
 */
export type Route =
  | { name: 'activity' }
  | { name: 'inbox' }
  | { name: 'tickets' }
  | { name: 'agents' }
  | { name: 'skills' }
  | { name: 'instructions' }
  | { name: 'projects' }
  | { name: 'agent'; id: string }
  | { name: 'ticket'; id: string }
  | { name: 'project'; slug: string; tab: ProjectTab }
  | { name: 'folder'; path: string }
  | { name: 'doc'; path: string }
  | { name: 'image'; path: string }
  | { name: 'trash' }
  | { name: 'settings' };

export type ProjectTab = 'overview' | 'tickets' | 'library';
const TABS: ProjectTab[] = ['overview', 'tickets', 'library'];
/** Old tab names that still resolve: the Library used to be the Wiki. */
const TAB_ALIASES: Record<string, ProjectTab> = { wiki: 'library' };

const enc = (p: string) => p.split('/').map(encodeURIComponent).join('/');
const dec = (p: string) => p.split('/').map(decodeURIComponent).join('/');

/** `Projects/<Name>/Wiki/…` → `Projects/<Name>/Library/…`; any other path unchanged. */
const canonical = (path: string) => legacyLibraryAlias(path) ?? path;

export function href(r: Route): string {
  switch (r.name) {
    case 'activity':
    case 'inbox':
    case 'tickets':
    case 'skills':
    case 'instructions':
    case 'projects':
    case 'agents':
    case 'trash':
    case 'settings':
      return `#/${r.name}`;
    case 'agent':
      return `#/agent/${encodeURIComponent(r.id)}`;
    case 'ticket':
      return `#/ticket/${encodeURIComponent(r.id)}`;
    case 'project':
      return `#/project/${encodeURIComponent(r.slug)}/${r.tab}`;
    case 'folder':
      return `#/folder/${enc(r.path)}`;
    case 'doc':
      return `#/doc/${enc(r.path)}`;
    case 'image':
      return `#/image/${enc(r.path)}`;
  }
}

export function parse(hash: string): Route {
  const clean = hash.replace(/^#\/?/, '');
  const [head, ...rest] = clean.split('/');
  const tail = rest.join('/');
  switch (head) {
    case 'inbox':
    case 'tickets':
    case 'skills':
    case 'instructions':
    case 'projects':
    case 'agents':
    case 'trash':
    case 'settings':
      return { name: head };
    case 'agent':
      return tail ? { name: 'agent', id: decodeURIComponent(tail) } : { name: 'agents' };
    case 'ticket':
      return tail ? { name: 'ticket', id: decodeURIComponent(tail) } : { name: 'tickets' };
    case 'project': {
      const slug = decodeURIComponent(rest[0] ?? '');
      const raw = rest[1] ?? '';
      const tab = (TABS as string[]).includes(raw) ? (raw as ProjectTab) : (TAB_ALIASES[raw] ?? 'overview');
      return slug ? { name: 'project', slug, tab } : { name: 'activity' };
    }
    case 'doc': {
      const path = canonical(dec(tail));
      return /^Projects\/[^/]+\/Library\//.test(path) ? { name: 'doc', path } : { name: 'tickets' };
    }
    case 'folder':
    case 'image':
      return { name: 'tickets' };
    case 'activity':
      return { name: 'activity' };
    default:
      return { name: 'tickets' };
  }
}

/**
 * Open whatever a vault path points at. Markdown (including saved links, which are markdown
 * files) opens in the document view; every other file opens in the file viewer.
 */
export function routeForPath(rawPath: string, kind: 'dir' | FileKind): Route {
  const path = canonical(rawPath);
  if (kind === 'dir') {
    const m = /^Projects\/([^/]+)(?:\/(Tickets|Library))?$/.exec(path);
    if (m) {
      const tab: ProjectTab = m[2] === 'Tickets' ? 'tickets' : m[2] === 'Library' ? 'library' : 'overview';
      return { name: 'project', slug: m[1]!, tab };
    }
    return { name: 'folder', path };
  }
  if (kind !== 'markdown' && kind !== 'link') return { name: 'image', path };
  const t = /^(?:Projects\/[^/]+\/Tickets|Inbox)\/([A-Z]{2,5}-\d+)\.md$/.exec(path);
  if (t) return { name: 'ticket', id: t[1]! };
  const p = /^Projects\/([^/]+)\/project\.md$/.exec(path);
  if (p) return { name: 'project', slug: p[1]!, tab: 'overview' };
  const a = new RegExp(`^${AGENTS_DIR}/([^/]+)\\.md$`).exec(path);
  if (a) return { name: 'agent', id: a[1]! };
  return { name: 'doc', path };
}
