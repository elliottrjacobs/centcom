import { promises as fs, type Stats } from 'node:fs';
import path from 'node:path';
import type { FileKind, Frontmatter, TreeNode } from '../shared/types.ts';
import { errorMessage } from './errors.ts';
import { birthOf, lstatOrNull, mapLimit, mtimeOf, Mutex } from './fsutil.ts';
import { docTitle, parseMarkdown } from './markdown.ts';
import {
  assignProjectKeys,
  parseProjectFile,
  parseTicketFile,
  projectSlugOf,
  PROJECTS_DIR,
  ticketLocation,
  type ProjectRecord,
  type TicketRecord,
} from './model.ts';
import { canHaveSidecar, fileKind, parseClientPath, relBasename, relDirname, relJoin, type SafeRoot } from './paths.ts';

/** Markdown larger than this is listed but its text is not indexed. */
const MAX_INDEXED_BYTES = 5 * 1024 * 1024;
/** Characters of body kept for search + snippets. */
const MAX_BODY_CHARS = 400_000;

export interface FileEntry {
  path: string;
  name: string;
  kind: FileKind;
  mtime: number;
  size: number;
  created: number;
}

export interface DocEntry {
  path: string;
  title: string;
  frontmatter: Frontmatter;
  body: string;
  bodyLower: string;
}

export interface FileChange {
  path: string;
  kind: FileKind;
  change: 'added' | 'updated' | 'removed';
  mtime: number;
  title?: string;
}

export interface TicketChange {
  id: string;
  before: TicketRecord | null;
  after: TicketRecord | null;
}

export interface Changes {
  files: FileChange[];
  tickets: TicketChange[];
  /** slug → deleted? */
  projects: Map<string, boolean>;
  /** Anything the tree shows changed: entries added/removed, or a title changed. */
  structure: boolean;
}

export function emptyChanges(): Changes {
  return { files: [], tickets: [], projects: new Map(), structure: false };
}

export function hasChanges(c: Changes): boolean {
  return c.structure || c.files.length > 0 || c.tickets.length > 0 || c.projects.size > 0;
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** Folder that holds bookmark previews (`server/bookmarks.ts`). */
const PREVIEW_DIR_NAME = 'assets';
const MAX_CARD_DESCRIPTION = 500;

/** A bookmark: markdown whose frontmatter says `type: link` and carries a `url`. */
export function isLinkFrontmatter(frontmatter: Frontmatter): boolean {
  return frontmatter.type === 'link' && typeof frontmatter.url === 'string' && frontmatter.url.trim() !== '';
}

/**
 * A frontmatter `image` is only ever exposed when it is a plain vault-relative path to an image
 * file: never a URL (a hand-written link file must not be able to make the UI load a remote
 * tracking pixel; browsers read even `https:/host/x` as absolute), never `..`, never a dot-folder.
 */
function vaultPathOrUndefined(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const raw = value.trim();
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) || raw.startsWith('//')) return undefined;
  try {
    const rel = parseClientPath(raw).join('/');
    return fileKind(relBasename(rel)) === 'image' ? rel : undefined;
  } catch {
    return undefined;
  }
}

/** The vault path of a bookmark's locally stored preview, when it has a usable one. */
export function linkPreviewPath(frontmatter: Frontmatter): string | undefined {
  return isLinkFrontmatter(frontmatter) ? vaultPathOrUndefined(frontmatter.image) : undefined;
}

/** The fields of a link file that the tree shows. */
export function linkFields(frontmatter: Frontmatter): Pick<TreeNode, 'url' | 'site' | 'thumb' | 'description'> {
  const url = String(frontmatter.url).trim();
  const out: Pick<TreeNode, 'url' | 'site' | 'thumb' | 'description'> = { url };
  let site = typeof frontmatter.site === 'string' ? frontmatter.site.trim() : '';
  if (!site) {
    try {
      site = new URL(url).hostname.replace(/^www\./, '');
    } catch {
      /* a hand-written link with an odd url still shows up, just without a site */
    }
  }
  if (site) out.site = site;
  const thumb = vaultPathOrUndefined(frontmatter.image);
  if (thumb) out.thumb = thumb;
  if (typeof frontmatter.description === 'string' && frontmatter.description.trim()) out.description = frontmatter.description.trim().slice(0, MAX_CARD_DESCRIPTION);
  return out;
}

/** Everything about a doc that the tree displays; when it changes, clients must refetch the tree. */
function treeSignature(title: string, frontmatter: Frontmatter): string {
  return isLinkFrontmatter(frontmatter) ? JSON.stringify([title, linkFields(frontmatter)]) : JSON.stringify([title]);
}

/**
 * In-memory picture of the vault: every visible file and folder, parsed markdown,
 * tickets and projects. The filesystem is the source of truth; `sync()` reconciles
 * any path against it and reports exactly what changed, which is what makes API
 * writes and watcher events share one code path (and makes watcher echoes no-ops).
 */
export class VaultIndex {
  readonly files = new Map<string, FileEntry>();
  readonly dirs = new Map<string, { mtime: number; linked?: boolean }>();
  readonly docs = new Map<string, DocEntry>();
  readonly tickets = new Map<string, TicketRecord>();
  readonly projects = new Map<string, ProjectRecord>();

  private readonly children = new Map<string, Set<string>>();
  private readonly ticketPathById = new Map<string, string>();
  private readonly ticketPathByAlias = new Map<string, string>();
  private readonly lock = new Mutex();
  private treeCache: TreeNode | null = null;
  /** Every path some link file names as its preview `image`. Rebuilt with the tree. */
  private previewRefs: Set<string> | null = null;

  constructor(
    private readonly safeRoot: SafeRoot,
    private readonly warn: (msg: string) => void,
  ) {}

  /* ───────────── Public API ───────────── */

  async rebuild(): Promise<void> {
    await this.lock.run(async () => {
      this.files.clear();
      this.dirs.clear();
      this.docs.clear();
      this.tickets.clear();
      this.projects.clear();
      this.children.clear();
      this.ticketPathById.clear();
      this.ticketPathByAlias.clear();
      this.invalidateTree();
      await this.syncInner('', emptyChanges());
    });
  }

  /** Reconcile one path (file or folder, present or gone) with the disk. */
  sync(rel: string): Promise<Changes> {
    return this.syncMany([rel]);
  }

  syncMany(rels: readonly string[]): Promise<Changes> {
    return this.lock.run(async () => {
      const changes = emptyChanges();
      for (const rel of rels) {
        try {
          await this.syncInner(this.topmostUnknownAncestor(rel), changes);
        } catch (err) {
          this.warn(`Index: could not sync "${rel}": ${errorMessage(err)}`);
        }
      }
      if (hasChanges(changes)) this.invalidateTree();
      return changes;
    });
  }

  /**
   * When `rel` sits under folders the index has not seen yet, start the walk at the
   * highest such folder so every new ancestor is indexed properly (project folders included).
   */
  private topmostUnknownAncestor(rel: string): string {
    const segments = rel.split('/').filter(Boolean);
    for (let i = 1; i < segments.length; i += 1) {
      const prefix = segments.slice(0, i).join('/');
      if (!this.dirs.has(prefix)) return prefix;
    }
    return rel;
  }

  private invalidateTree(): void {
    this.treeCache = null;
    this.previewRefs = null;
  }

  /** `<file>.<ext>.md` beside any non-markdown `<file>.<ext>` is that file's note, not a document of its own. */
  isSidecar(rel: string): boolean {
    if (!rel.toLowerCase().endsWith('.md')) return false;
    const host = rel.slice(0, -3);
    return this.files.has(host) && canHaveSidecar(relBasename(host));
  }

  sidecarOf(fileRel: string): string | undefined {
    const candidate = `${fileRel}.md`;
    return canHaveSidecar(relBasename(fileRel)) && this.files.has(fileRel) && this.files.has(candidate) ? candidate : undefined;
  }

  /** Resolve a ticket by current id or any previous id, case-insensitively. */
  findTicket(id: string): TicketRecord | undefined {
    const key = id.trim().toUpperCase();
    const p = this.ticketPathById.get(key) ?? this.ticketPathByAlias.get(key);
    return p ? this.tickets.get(p) : undefined;
  }

  /** Highest ticket number ever seen for `key` among live ids and recorded previous ids. */
  highestNumber(key: string): number {
    const prefix = `${key.toUpperCase()}-`;
    let max = 0;
    const consider = (id: string) => {
      if (!id.startsWith(prefix)) return;
      const n = Number(id.slice(prefix.length));
      if (Number.isInteger(n) && n > max) max = n;
    };
    for (const id of this.ticketPathById.keys()) consider(id);
    for (const id of this.ticketPathByAlias.keys()) consider(id);
    return max;
  }

  /** Slug, case-insensitive slug, or key. */
  findProject(ref: string): ProjectRecord | undefined {
    const exact = this.projects.get(ref);
    if (exact) return exact;
    const lowered = ref.trim().toLowerCase();
    for (const p of this.projects.values()) if (p.slug.toLowerCase() === lowered) return p;
    for (const p of this.projects.values()) if (p.key.toLowerCase() === lowered) return p;
    return undefined;
  }

  node(rel: string): TreeNode | undefined {
    const file = this.files.get(rel);
    if (file) return this.fileNode(file);
    if (rel === '' || this.dirs.has(rel)) return this.dirNode(rel);
    return undefined;
  }

  tree(): TreeNode {
    if (!this.treeCache) this.treeCache = this.dirNode('');
    return this.treeCache;
  }

  /* ───────────── Tree building ───────────── */

  private fileNode(file: FileEntry): TreeNode {
    const node: TreeNode = { name: file.name, path: file.path, type: 'file', kind: file.kind, mtime: file.mtime, size: file.size };
    if (file.kind === 'markdown' || file.kind === 'link') {
      const doc = this.docs.get(file.path);
      node.title = doc?.title ?? docTitle({}, file.path);
      if (file.kind === 'link' && doc) Object.assign(node, linkFields(doc.frontmatter));
    } else {
      const sidecar = this.sidecarOf(file.path);
      if (sidecar) node.sidecar = sidecar;
    }
    return node;
  }

  private referencedPreviews(): Set<string> {
    if (!this.previewRefs) {
      this.previewRefs = new Set();
      for (const doc of this.docs.values()) {
        if (!isLinkFrontmatter(doc.frontmatter)) continue;
        const thumb = vaultPathOrUndefined(doc.frontmatter.image);
        if (thumb) this.previewRefs.add(thumb);
      }
    }
    return this.previewRefs;
  }

  /**
   * An `assets` folder holding nothing but bookmark previews is plumbing, not content: it stays
   * out of the tree (its files are still served by /api/raw). One file that no link claims, or
   * any sub-folder, and it is an ordinary folder again. Only ever true for a folder named `assets`.
   */
  private isPreviewOnlyDir(rel: string): boolean {
    if (relBasename(rel) !== PREVIEW_DIR_NAME) return false;
    const names = this.children.get(rel);
    if (!names || names.size === 0) return false;
    const refs = this.referencedPreviews();
    for (const name of names) {
      const childRel = relJoin(rel, name);
      if (!this.files.has(childRel) || !refs.has(childRel)) return false;
    }
    return true;
  }

  private dirNode(rel: string): TreeNode {
    const dirNodes: TreeNode[] = [];
    const fileNodes: TreeNode[] = [];
    for (const name of this.children.get(rel) ?? []) {
      const childRel = relJoin(rel, name);
      const file = this.files.get(childRel);
      if (file) {
        if (!this.isSidecar(childRel)) fileNodes.push(this.fileNode(file));
      } else if (this.dirs.has(childRel)) {
        if (!this.isPreviewOnlyDir(childRel)) dirNodes.push(this.dirNode(childRel));
      }
    }
    dirNodes.sort((a, b) => collator.compare(a.name, b.name));
    fileNodes.sort((a, b) => collator.compare(a.name, b.name));
    return {
      name: rel === '' ? path.basename(this.safeRoot.root) : relBasename(rel),
      path: rel,
      type: 'dir',
      mtime: this.dirs.get(rel)?.mtime ?? 0,
      ...(this.dirs.get(rel)?.linked ? { linked: true } : {}),
      children: [...dirNodes, ...fileNodes],
    };
  }

  /* ───────────── Reconciliation ───────────── */

  private async syncInner(rel: string, changes: Changes): Promise<void> {
    if (rel !== '' && rel.split('/').some((s) => s.startsWith('.') || s.length === 0)) return;
    const abs = path.join(this.safeRoot.root, rel);
    let stat = await lstatOrNull(abs);

    // Symlinks are never followed: they are the one way content could leak in from outside the
    // vault. The single exception is an allowlisted link's mount point, and only while it still
    // points exactly at the configured target. Symlinks *inside* a link are skipped like any other.
    let linked = false;
    if (stat?.isSymbolicLink()) {
      const link = (this.safeRoot.links ?? []).find((l) => l.mount === rel);
      const real = link ? await fs.realpath(abs).catch(() => null) : null;
      if (link && real === link.realTarget) {
        stat = await fs.stat(abs).catch(() => null);
        linked = stat?.isDirectory() === true;
      }
      if (!linked) {
        if (link) this.warn(`Index: the link at "${rel}" no longer points at ${link.target}; ignoring it.`);
        this.removeSubtree(rel, changes);
        return;
      }
    }
    if (!stat || (!stat.isFile() && !stat.isDirectory())) {
      this.removeSubtree(rel, changes);
      return;
    }

    if (stat.isDirectory()) {
      if (this.files.has(rel)) this.removeSubtree(rel, changes);
      const known = this.dirs.get(rel);
      if (!known) {
        this.dirs.set(rel, linked ? { mtime: mtimeOf(stat), linked: true } : { mtime: mtimeOf(stat) });
        if (rel !== '') {
          this.link(rel);
          changes.structure = true;
        }
      } else {
        known.mtime = mtimeOf(stat);
        if ((known.linked === true) !== linked) {
          if (linked) known.linked = true;
          else delete known.linked;
          changes.structure = true;
        }
      }
      this.noteProjectDir(rel, changes);

      let fileNames: string[];
      let dirNames: string[];
      try {
        const entries = (await fs.readdir(abs, { withFileTypes: true })).filter((e) => !e.name.startsWith('.'));
        dirNames = entries.filter((e) => e.isDirectory()).map((e) => e.name.normalize('NFC'));
        fileNames = entries.filter((e) => !e.isDirectory()).map((e) => e.name.normalize('NFC'));
      } catch (err) {
        this.warn(`Index: cannot list "${rel}": ${errorMessage(err)}`);
        return;
      }
      const present = new Set([...dirNames, ...fileNames]);
      for (const known of [...(this.children.get(rel) ?? [])]) {
        if (!present.has(known)) this.removeSubtree(relJoin(rel, known), changes);
      }
      const visit = async (name: string) => {
        try {
          await this.syncInner(relJoin(rel, name), changes);
        } catch (err) {
          this.warn(`Index: skipped "${relJoin(rel, name)}": ${errorMessage(err)}`);
        }
      };
      // Files in parallel, sub-folders one at a time: bounded file handles however deep the vault is.
      await mapLimit(fileNames, 16, visit);
      for (const name of dirNames) await visit(name);
      if (rel === PROJECTS_DIR || rel === '') this.settleProjects(changes);
      return;
    }

    await this.syncFile(rel, abs, stat, changes);
  }

  private async syncFile(rel: string, abs: string, stat: Stats, changes: Changes): Promise<void> {
    if (this.dirs.has(rel)) this.removeSubtree(rel, changes);
    const previous = this.files.get(rel);
    const mtime = mtimeOf(stat);
    if (previous && previous.mtime === mtime && previous.size === stat.size) return;

    const name = relBasename(rel);
    let kind: FileKind = fileKind(name);
    const entry: FileEntry = { path: rel, name, kind, mtime, size: stat.size, created: birthOf(stat) };

    let title: string | undefined;
    if (kind === 'markdown') {
      let raw = '';
      if (stat.size <= MAX_INDEXED_BYTES) {
        try {
          raw = await fs.readFile(abs, 'utf8');
        } catch (err) {
          this.warn(`Index: cannot read "${rel}": ${errorMessage(err)}`);
        }
      } else {
        this.warn(`Index: "${rel}" is larger than ${MAX_INDEXED_BYTES} bytes; its text is not searchable.`);
      }
      const before = this.docs.get(rel);
      const parsed = parseMarkdown(raw);
      if (parsed.malformed) this.warn(`Index: "${rel}" has malformed frontmatter; treating the whole file as body.`);
      const body = parsed.body.length > MAX_BODY_CHARS ? parsed.body.slice(0, MAX_BODY_CHARS) : parsed.body;
      title = docTitle(parsed.frontmatter, rel);
      // A saved website is still a markdown file on disk; what makes it a `link` is its frontmatter.
      if (isLinkFrontmatter(parsed.frontmatter)) entry.kind = kind = 'link';
      this.docs.set(rel, { path: rel, title, frontmatter: parsed.frontmatter, body, bodyLower: body.toLowerCase() });
      if (before && treeSignature(before.title, before.frontmatter) !== treeSignature(title, parsed.frontmatter)) changes.structure = true;

      this.indexTicket(rel, raw, stat, changes);
      this.indexProjectFile(rel, raw, stat, changes);
    }

    this.files.set(rel, entry);
    if (!previous) {
      this.link(rel);
      changes.structure = true;
    }
    changes.files.push({ path: rel, kind, change: previous ? 'updated' : 'added', mtime, ...(title !== undefined ? { title } : {}) });
  }

  /** Register `rel` under its parent, creating index entries for any ancestors we have not seen yet. */
  private link(rel: string): void {
    let child = rel;
    while (child !== '') {
      const parent = relDirname(child);
      let set = this.children.get(parent);
      if (!set) {
        set = new Set();
        this.children.set(parent, set);
      }
      set.add(relBasename(child));
      if (parent !== '' && !this.dirs.has(parent)) this.dirs.set(parent, { mtime: Date.now() });
      child = parent;
    }
  }

  private removeSubtree(rel: string, changes: Changes): void {
    if (rel === '') return;
    const file = this.files.get(rel);
    const isDir = this.dirs.has(rel);
    if (!file && !isDir) return;

    if (isDir) {
      for (const name of [...(this.children.get(rel) ?? [])]) this.removeSubtree(relJoin(rel, name), changes);
      this.children.delete(rel);
      this.dirs.delete(rel);
      const project = projectSlugOf(rel);
      if (project?.isRoot && this.projects.delete(project.slug)) {
        changes.projects.set(project.slug, true);
        assignProjectKeys(this.projects.values());
      }
    }
    if (file) {
      this.files.delete(rel);
      const doc = this.docs.get(rel);
      this.docs.delete(rel);
      changes.files.push({ path: rel, kind: file.kind, change: 'removed', mtime: file.mtime, ...(doc ? { title: doc.title } : {}) });
      this.dropTicket(rel, changes);
      const project = projectSlugOf(rel);
      if (project?.isFile) this.refreshProjectWithoutFile(project.slug, changes);
    }
    this.children.get(relDirname(rel))?.delete(relBasename(rel));
    changes.structure = true;
  }

  /* ───────────── Tickets ───────────── */

  private dropTicket(rel: string, changes: Changes): TicketRecord | null {
    const before = this.tickets.get(rel);
    if (!before) return null;
    this.tickets.delete(rel);
    if (this.ticketPathById.get(before.id.toUpperCase()) === rel) this.ticketPathById.delete(before.id.toUpperCase());
    for (const alias of before.previousIds) {
      if (this.ticketPathByAlias.get(alias.toUpperCase()) === rel) this.ticketPathByAlias.delete(alias.toUpperCase());
    }
    changes.tickets.push({ id: before.id, before, after: null });
    if (before.project) changes.projects.set(before.project, changes.projects.get(before.project) ?? false);
    return before;
  }

  private indexTicket(rel: string, raw: string, stat: Stats, changes: Changes): void {
    const location = ticketLocation(rel);
    if (!location) return;
    const pending = emptyChanges();
    const before = this.dropTicket(rel, pending);
    let after: TicketRecord;
    try {
      after = parseTicketFile(rel, raw, stat, location.project, (id) => {
        const owner = this.ticketPathById.get(id.toUpperCase());
        return owner !== undefined && owner !== rel;
      });
    } catch (err) {
      this.warn(`Index: skipped ticket "${rel}": ${errorMessage(err)}`);
      if (before) changes.tickets.push({ id: before.id, before, after: null });
      return;
    }
    const idKey = after.id.toUpperCase();
    const owner = this.ticketPathById.get(idKey);
    if (owner && owner !== rel) {
      this.warn(`Index: ticket id ${after.id} is claimed by both "${owner}" and "${rel}"; lookups resolve to the first.`);
    } else {
      this.ticketPathById.set(idKey, rel);
    }
    for (const alias of after.previousIds) {
      const aliasKey = alias.toUpperCase();
      if (!this.ticketPathByAlias.has(aliasKey)) this.ticketPathByAlias.set(aliasKey, rel);
    }
    this.tickets.set(rel, after);
    changes.tickets.push({ id: after.id, before, after });
    if (after.project) changes.projects.set(after.project, changes.projects.get(after.project) ?? false);
    if (before?.project && before.project !== after.project) changes.projects.set(before.project, changes.projects.get(before.project) ?? false);
  }

  /* ───────────── Projects ───────────── */

  /** Any folder directly under `Projects/` is a project, with or without a `project.md`. */
  private noteProjectDir(rel: string, changes: Changes): void {
    const project = projectSlugOf(rel);
    if (!project?.isRoot || this.projects.has(project.slug)) return;
    const dirMtime = this.dirs.get(rel)?.mtime ?? Date.now();
    const fakeStat = { mtimeMs: dirMtime, birthtimeMs: dirMtime } as Stats;
    this.projects.set(project.slug, parseProjectFile(project.slug, null, null, fakeStat));
    assignProjectKeys(this.projects.values());
    changes.projects.set(project.slug, false);
  }

  private indexProjectFile(rel: string, raw: string, stat: Stats, changes: Changes): void {
    const project = projectSlugOf(rel);
    if (!project?.isFile) return;
    this.projects.set(project.slug, parseProjectFile(project.slug, raw, stat, stat));
    assignProjectKeys(this.projects.values());
    changes.projects.set(project.slug, false);
  }

  private refreshProjectWithoutFile(slug: string, changes: Changes): void {
    const dir = this.dirs.get(`${PROJECTS_DIR}/${slug}`);
    if (!dir) return;
    const fakeStat = { mtimeMs: dir.mtime, birthtimeMs: dir.mtime } as Stats;
    this.projects.set(slug, parseProjectFile(slug, null, null, fakeStat));
    assignProjectKeys(this.projects.values());
    changes.projects.set(slug, false);
  }

  /** Drop project records whose folder vanished without us walking through it. */
  private settleProjects(changes: Changes): void {
    for (const slug of [...this.projects.keys()]) {
      if (!this.dirs.has(`${PROJECTS_DIR}/${slug}`)) {
        this.projects.delete(slug);
        changes.projects.set(slug, true);
      }
    }
    assignProjectKeys(this.projects.values());
  }
}
