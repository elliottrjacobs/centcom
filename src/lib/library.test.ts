import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TreeNode } from '../../shared/types';
import { libraryFiles, libraryPath } from './library';

const file = (path: string, patch: Partial<TreeNode> = {}): TreeNode => {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return { name, path, type: 'file', kind: 'markdown', title: name.replace(/\.[^.]+$/, ''), mtime: 1, size: 10, ...patch };
};
const dir = (path: string, children: TreeNode[]): TreeNode => ({ name: path.slice(path.lastIndexOf('/') + 1), path, type: 'dir', mtime: 1, children });

const L = 'Projects/CENTCOM/Library';
const tree = dir(L, [
  dir(`${L}/Outputs`, [file(`${L}/Outputs/Report.pdf`, { kind: 'pdf', mtime: 50 }), file(`${L}/Outputs/Demo.mp4`, { kind: 'video', mtime: 5 })]),
  file(`${L}/Plan.md`, { title: 'Launch plan', mtime: 30 }),
  file(`${L}/diagram.png`, { kind: 'image', mtime: 40, sidecar: `${L}/diagram.png.md` }),
  file(`${L}/diagram.png.md`, { mtime: 41 }),
  file(`${L}/data.csv`, { kind: 'other', mtime: 20 }),
]);

test('the project Library is Projects/<slug>/Library', () => {
  assert.equal(libraryPath('Recall Radar'), 'Projects/Recall Radar/Library');
});

test('lists every file in the Library, nested ones too, not just markdown; sidecar notes are hidden', () => {
  assert.deepEqual(
    libraryFiles(tree).map((f) => f.path),
    [`${L}/data.csv`, `${L}/Outputs/Demo.mp4`, `${L}/diagram.png`, `${L}/Plan.md`, `${L}/Outputs/Report.pdf`],
  );
});

test('finds by title or file name, and sorts by most recently updated on request', () => {
  assert.deepEqual(libraryFiles(tree, { query: 'launch' }).map((f) => f.name), ['Plan.md']);
  assert.deepEqual(libraryFiles(tree, { query: '.PDF' }).map((f) => f.name), ['Report.pdf']);
  assert.deepEqual(libraryFiles(tree, { sort: 'updated' }).map((f) => f.name), ['Report.pdf', 'diagram.png', 'Plan.md', 'data.csv', 'Demo.mp4']);
  assert.deepEqual(libraryFiles(null), []);
});
