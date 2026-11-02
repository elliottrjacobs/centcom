import { LIBRARY_SECTION, type TreeNode } from '@shared/types';

/** A project's library: its docs, documentation, outputs and files. */
export const libraryPath = (slug: string) => `Projects/${slug}/${LIBRARY_SECTION}`;

export type LibrarySort = 'title' | 'updated';

const label = (f: TreeNode) => f.title ?? f.name;

function walk(node: TreeNode): TreeNode[] {
  return (node.children ?? []).flatMap((n) => (n.type === 'dir' ? walk(n) : [n]));
}

/**
 * Every file under a Library folder, however deep and whatever its kind. A `<file>.<ext>.md`
 * note belongs to its file, so it is not listed on its own (the server's tree already hides
 * them; this keeps the list right if one slips through).
 */
export function libraryFiles(root: TreeNode | null, opts: { query?: string; sort?: LibrarySort } = {}): TreeNode[] {
  if (!root) return [];
  const files = walk(root);
  const hosts = new Set(files.filter((f) => f.kind !== 'markdown' && f.kind !== 'link').map((f) => f.path));
  const q = opts.query?.trim().toLowerCase() ?? '';
  return files
    .filter((f) => !(f.path.endsWith('.md') && hosts.has(f.path.slice(0, -3))))
    .filter((f) => !q || label(f).toLowerCase().includes(q) || f.name.toLowerCase().includes(q))
    .sort((a, b) => (opts.sort === 'updated' ? b.mtime - a.mtime : 0) || label(a).localeCompare(label(b)));
}
