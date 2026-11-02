import type { SearchHit } from '../shared/types.ts';
import type { Ctx } from './context.ts';
import { projectSlugOf } from './model.ts';

const SNIPPET_RADIUS = 60;

/**
 * Scoring, highest first:
 *   exact ticket id ≫ title prefix > title substring > path > body
 * A phrase match always outranks a match where the words are merely all present somewhere.
 */
const SCORE = {
  exactId: 1000,
  idPrefix: 400,
  titleExact: 320,
  titlePrefix: 300,
  titleWordPrefix: 240,
  titleSubstring: 200,
  path: 100,
  body: 50,
  // Multi-word queries whose words match separately.
  termTitle: 12,
  termPath: 6,
  termBody: 3,
} as const;

function snippetAround(body: string, bodyLower: string, needle: string): string | undefined {
  const at = bodyLower.indexOf(needle);
  if (at === -1) return undefined;
  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(body.length, at + needle.length + SNIPPET_RADIUS);
  const text = body.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${text}${end < body.length ? '…' : ''}`;
}

interface Candidate {
  type: SearchHit['type'];
  path: string;
  title: string;
  ticket?: string;
  ids?: string[];
  project: string | null;
  body: string;
  bodyLower: string;
  /** Extra searchable text that is not shown (labels, tags, summary). */
  extraLower: string;
  mtime: number;
}

function scoreCandidate(c: Candidate, q: string, terms: string[]): { score: number; snippet?: string } | null {
  const title = c.title.toLowerCase();
  const pathLower = c.path.toLowerCase();

  if (c.ids?.some((id) => id.toLowerCase() === q)) return withSnippet(c, SCORE.exactId, q, terms);

  let score = 0;
  if (c.ticket && c.ticket.toLowerCase().startsWith(q)) score = Math.max(score, SCORE.idPrefix);
  if (title === q) score = Math.max(score, SCORE.titleExact);
  else if (title.startsWith(q)) score = Math.max(score, SCORE.titlePrefix);
  else if (new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(q)}`, 'u').test(title)) score = Math.max(score, SCORE.titleWordPrefix);
  else if (title.includes(q)) score = Math.max(score, SCORE.titleSubstring);
  if (score === 0 && pathLower.includes(q)) score = SCORE.path;
  if (score === 0 && (c.bodyLower.includes(q) || c.extraLower.includes(q))) score = SCORE.body;

  if (score === 0 && terms.length > 1) {
    let sum = 0;
    for (const term of terms) {
      if (title.includes(term)) sum += SCORE.termTitle;
      else if (pathLower.includes(term)) sum += SCORE.termPath;
      else if (c.bodyLower.includes(term) || c.extraLower.includes(term)) sum += SCORE.termBody;
      else return null;
    }
    score = sum;
  }
  if (score === 0) return null;
  return withSnippet(c, score, q, terms);
}

function withSnippet(c: Candidate, score: number, q: string, terms: string[]): { score: number; snippet?: string } {
  const snippet = snippetAround(c.body, c.bodyLower, q) ?? terms.map((t) => snippetAround(c.body, c.bodyLower, t)).find((s) => s !== undefined);
  return snippet === undefined ? { score } : { score, snippet };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tagsText(frontmatter: Record<string, unknown>): string {
  const parts: string[] = [];
  // `url` and `site` make saved links findable by where they point, not only by what they are called.
  for (const key of ['tags', 'labels', 'tag', 'summary', 'description', 'name', 'url', 'site']) {
    const v = frontmatter[key];
    if (typeof v === 'string') parts.push(v);
    else if (Array.isArray(v)) parts.push(v.filter((x) => typeof x === 'string' || typeof x === 'number').join(' '));
  }
  return parts.join(' ').toLowerCase();
}

/** Project docs: the Library, plus any legacy Wiki folder the migration had to leave in place. */
const PROJECT_LIBRARY = /^Projects\/[^/]+\/(?:Library|Wiki)\//;

/**
 * `scope`: `tasks` = tickets, projects and project Library docs; any other value is a vault
 * folder (already resolved, so canonical) and only hits at or beneath it are returned.
 */
export function search(ctx: Ctx, query: string, limitInput?: number, scope?: string): SearchHit[] {
  const q = query.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!q) return [];
  const limit = Math.max(1, Math.min(limitInput ?? 30, 200));
  const terms = q.split(' ').filter(Boolean);
  const { index } = ctx;
  const candidates: Candidate[] = [];

  for (const [rel, doc] of index.docs) {
    if (index.isSidecar(rel)) continue; // surfaced through its image
    const mtime = index.files.get(rel)?.mtime ?? 0;
    const ticket = index.tickets.get(rel);
    const project = projectSlugOf(rel);
    if (ticket) {
      candidates.push({
        type: 'ticket',
        path: rel,
        title: ticket.title,
        ticket: ticket.id,
        ids: [ticket.id, ...ticket.previousIds],
        project: ticket.project,
        body: doc.body,
        bodyLower: doc.bodyLower,
        extraLower: `${ticket.labels.join(' ')} ${ticket.status} ${ticket.agent ?? ''}`.toLowerCase(),
        mtime,
      });
    } else if (project?.isFile) {
      const record = index.projects.get(project.slug);
      candidates.push({
        type: 'project',
        path: `Projects/${project.slug}`,
        title: record?.name ?? project.slug,
        project: project.slug,
        body: doc.body,
        bodyLower: doc.bodyLower,
        extraLower: `${record?.key ?? ''} ${record?.summary ?? ''}`.toLowerCase(),
        mtime,
      });
    } else {
      candidates.push({ type: 'doc', path: rel, title: doc.title, project: project?.slug ?? null, body: doc.body, bodyLower: doc.bodyLower, extraLower: tagsText(doc.frontmatter), mtime });
    }
  }

  // Projects that exist only as a folder (no project.md yet).
  for (const record of index.projects.values()) {
    if (!record.hasFile) candidates.push({ type: 'project', path: record.path, title: record.name, project: record.slug, body: '', bodyLower: '', extraLower: record.key.toLowerCase(), mtime: record.updated });
  }

  for (const file of index.files.values()) {
    if (file.kind === 'markdown' || file.kind === 'link') continue;
    const sidecarPath = index.sidecarOf(file.path);
    const sidecar = sidecarPath ? index.docs.get(sidecarPath) : undefined;
    // Images, PDFs, video and audio are found by name and by their note. Any other file only
    // when someone wrote a note for it (a linked repo's scripts would otherwise drown the results).
    if (file.kind === 'other' && !sidecar) continue;
    candidates.push({
      // The contract has no hit type per media kind: a non-image file is reported as a `doc` at its own path.
      type: file.kind === 'image' ? 'image' : 'doc',
      path: file.path,
      title: sidecar?.frontmatter.title && typeof sidecar.frontmatter.title === 'string' ? sidecar.frontmatter.title : file.name,
      project: projectSlugOf(file.path)?.slug ?? null,
      body: sidecar?.body ?? '',
      bodyLower: sidecar?.bodyLower ?? '',
      extraLower: sidecar ? tagsText(sidecar.frontmatter) : '',
      mtime: file.mtime,
    });
  }

  const hits: (SearchHit & { mtime: number })[] = [];
  for (const c of candidates) {
    if (scope === 'tasks' && c.type !== 'ticket' && c.type !== 'project' && !PROJECT_LIBRARY.test(c.path)) continue;
    if (scope && scope !== 'tasks' && c.path !== scope && !c.path.startsWith(`${scope}/`)) continue;
    const scored = scoreCandidate(c, q, terms);
    if (!scored) continue;
    hits.push({
      type: c.type,
      path: c.path,
      title: c.title,
      ...(c.ticket ? { ticket: c.ticket } : {}),
      project: c.project,
      ...(scored.snippet ? { snippet: scored.snippet } : {}),
      score: scored.score,
      mtime: c.mtime,
    });
  }
  hits.sort((a, b) => b.score - a.score || b.mtime - a.mtime || a.path.localeCompare(b.path));
  return hits.slice(0, limit).map(({ mtime: _mtime, ...hit }) => hit);
}
