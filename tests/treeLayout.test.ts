import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildTree,
  connector,
  countFiles,
  type TreeOptions,
  type TreeRow,
} from '../src/treeLayout';
import type { StructureNode } from '../src/model';

// Nodes are built from their full path, so a child's path really does sit under
// its parent's and the ordering below means what it says.
const file = (path: string): StructureNode => ({
  id: path,
  label: path.slice(path.lastIndexOf('/') + 1),
  path,
  kind: 'file',
  children: [],
});

const folder = (path: string, children: StructureNode[]): StructureNode => ({
  id: path || '/',
  label: path.slice(path.lastIndexOf('/') + 1) || 'root',
  path,
  kind: 'folder',
  children,
});

const allOpen: TreeOptions = { isOpen: () => true };

const build = (root: StructureNode, overrides: Partial<TreeOptions> = {}): TreeRow[] =>
  buildTree(root, { ...allOpen, ...overrides }).rows;

/** The tree as a terminal would print it, which is what the assertions read. */
const draw = (rows: readonly TreeRow[]): string[] =>
  rows.map((row) => `${connector(row)}${row.node.label}`);

const paths = (rows: readonly TreeRow[]): string[] => rows.map((row) => row.node.path);

test('draws an elbow per entry with the branch line running through', () => {
  const root = folder('', [
    folder('src', [
      folder('src/ui', [file('src/ui/button.ts')]),
      file('src/index.ts'),
    ]),
    file('README.md'),
  ]);

  assert.deepEqual(draw(build(root)), [
    '├── src',
    '│   ├── ui',
    '│   │   └── button.ts',
    '│   └── index.ts',
    '└── README.md',
  ]);
});

test('closes the line under the last entry rather than carrying it on', () => {
  const root = folder('', [
    folder('a', [file('a/one.ts'), file('a/two.ts')]),
    folder('b', [file('b/three.ts')]),
  ]);
  const rows = build(root);

  assert.deepEqual(draw(rows), [
    '├── a',
    '│   ├── one.ts',
    '│   └── two.ts',
    '└── b',
    '    └── three.ts',
  ]);
  // The last child of the last folder carries no line above it at any level.
  assert.deepEqual([...(rows.at(-1)?.guides ?? [])], [false]);
});

test('puts folders before files and sorts each by name', () => {
  const root = folder('', [
    file('zebra.ts'),
    folder('alpha', []),
    file('apple.ts'),
    folder('zulu', []),
  ]);

  assert.deepEqual(paths(build(root)), ['alpha', 'zulu', 'apple.ts', 'zebra.ts']);
});

test('a closed folder reports its files instead of listing them', () => {
  const root = folder('', [
    folder('src', [folder('src/deep', [file('src/deep/a.ts'), file('src/deep/b.ts')])]),
  ]);
  const rows = build(root, { isOpen: (node) => node.path !== 'src/deep' });

  assert.deepEqual(paths(rows), ['src', 'src/deep']);
  const closed = rows.at(-1);
  assert.equal(closed?.open, false);
  assert.equal(closed?.hasChildren, true);
  assert.equal(closed?.files, 2);
});

test('an empty folder is never open, however the caller answers', () => {
  const rows = build(folder('', [folder('empty', [])]));

  assert.equal(rows[0]?.hasChildren, false);
  assert.equal(rows[0]?.open, false);
});

test('a filter keeps the folders a match sits inside, and opens them', () => {
  const root = folder('', [
    folder('src', [
      folder('src/db', [file('src/db/schema.sql')]),
      folder('src/ui', [file('src/ui/button.ts')]),
    ]),
    file('README.md'),
  ]);
  // Everything closed: the filter still has to reach the match.
  const result = buildTree(root, {
    isOpen: () => false,
    match: (node) => node.label.includes('.sql'),
  });

  assert.deepEqual(paths(result.rows), ['src', 'src/db', 'src/db/schema.sql']);
  assert.deepEqual(result.rows.map((row) => row.match), [false, false, true]);
  assert.equal(result.matches, 1);
});

test('a folder matching on its own name stays shut and reports its size', () => {
  const root = folder('', [folder('reports', [file('reports/a.ts')]), file('other.ts')]);
  const result = buildTree(root, {
    isOpen: () => true,
    match: (node) => node.label === 'reports',
  });

  // Listing the contents would answer a search nobody ran; the count says what
  // is in there, and clearing the filter opens it.
  assert.deepEqual(paths(result.rows), ['reports']);
  assert.equal(result.rows[0]?.open, false);
  assert.equal(result.rows[0]?.hasChildren, true);
  assert.equal(result.rows[0]?.files, 1);
  assert.equal(result.matches, 1);
});

test('the limit caps the rows built and counts what it left out', () => {
  const root = folder('', Array.from({ length: 10 }, (_, index) => file(`f${index}.ts`)));
  const result = buildTree(root, { ...allOpen, limit: 4 });

  assert.equal(result.rows.length, 4);
  assert.equal(result.truncated, 6);
});

test('a caller can draw the same guides with glyphs of its own', () => {
  const root = folder('', [folder('src', [file('src/a.ts'), file('src/b.ts')])]);
  const narrow = { branch: '├─', last: '└─', through: '│ ', blank: '  ' };

  assert.deepEqual(
    build(root).map((row) => `${connector(row, narrow)}${row.node.label}`),
    ['└─src', '  ├─a.ts', '  └─b.ts'],
  );
});

test('counts the files under a node and none of the folders', () => {
  const root = folder('', [
    folder('src', [folder('src/ui', [file('src/ui/a.ts')]), file('src/b.ts')]),
    file('c.ts'),
  ]);

  assert.equal(countFiles(root), 3);
  assert.equal(countFiles(folder('empty', [])), 0);
  assert.equal(countFiles(file('a.ts')), 1);
});
