import type { StructureNode } from './model';

/**
 * The structure view's tree.
 *
 * A folder tree is the shape a reader already carries in their head, so the
 * fastest way to hand one over is to draw it the way `tree` and `git log
 * --graph` draw one: a row per entry, with a line running down from each folder
 * to the last thing inside it. The lines are what separate this from a plain
 * indent — four levels deep, indentation alone leaves you counting spaces to
 * work out which folder a file is actually in.
 *
 * The rows are built here rather than in the webview so the ordering, the
 * elbows and the filtering can be tested without a DOM, and so the panel and
 * the sidebar draw the same tree — the panel typing its lines out in
 * box-drawing characters, the sidebar drawing the same `guides` as borders,
 * because a glyph in a 22px sidebar row is not tall enough to join up.
 */

/** The four pieces a tree line is drawn from. */
export interface ConnectorGlyphs {
  /** An entry with siblings still to come. */
  branch: string;
  /** The last entry in its folder, which closes the line rather than passing it on. */
  last: string;
  /** An ancestor that still has siblings: its line passes through this row. */
  through: string;
  /** An ancestor that has none: nothing passes through. */
  blank: string;
}

/** What `tree` itself uses, and what the diagram panel draws. */
export const WIDE_CONNECTORS: ConnectorGlyphs = {
  branch: '├── ',
  last: '└── ',
  through: '│   ',
  blank: '    ',
};

export interface TreeRow {
  node: StructureNode;
  /** 0 for the entries at the top of the workspace. */
  depth: number;
  /**
   * One entry per folder between the root and this row, outermost first: true
   * when that folder still has siblings below it, so its line carries on past
   * this row and has to be drawn through it.
   */
  guides: readonly boolean[];
  /** The last entry in its folder. */
  last: boolean;
  folder: boolean;
  /** A folder with something in it — the only kind that can be opened. */
  hasChildren: boolean;
  /** Whether this row's children are drawn underneath it. */
  open: boolean;
  /** Files at or below this row; what a closed folder reports instead of them. */
  files: number;
  /** This row answers the filter itself, rather than being kept for a child. */
  match: boolean;
}

export interface TreeOptions {
  /** Whether a folder shows its contents. Not consulted while a filter is on. */
  isOpen: (node: StructureNode, depth: number) => boolean;
  /** Set to filter: a row survives when it matches, or holds something that does. */
  match?: (node: StructureNode) => boolean;
  /** Ceiling on the rows built, so one enormous workspace cannot lock the view. */
  limit?: number;
}

export interface TreeResult {
  rows: TreeRow[];
  /** Entries answering the filter, whether or not the limit had room to draw them. */
  matches: number;
  /** Rows the limit left out. */
  truncated: number;
}

/** Files under a node, counting the node itself when it is one. */
export function countFiles(node: StructureNode): number {
  if (node.kind === 'file') {
    return 1;
  }
  return node.children.reduce((total, child) => total + countFiles(child), 0);
}

/** The `│   ├── ` a row opens with. */
export function connector(row: TreeRow, glyphs: ConnectorGlyphs = WIDE_CONNECTORS): string {
  const trunk = row.guides.map((carries) => (carries ? glyphs.through : glyphs.blank)).join('');
  return trunk + (row.last ? glyphs.last : glyphs.branch);
}

/**
 * Flattens the tree into the rows to draw. The root is left out: it is the
 * workspace itself, and it is already named in the header above the view.
 */
export function buildTree(root: StructureNode, options: TreeOptions): TreeResult {
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  const filter = options.match;
  const rows: TreeRow[] = [];
  let matches = 0;
  let truncated = 0;

  // A filter keeps every folder a match sits inside, so the match is shown
  // where it lives rather than as a path fragment with nothing around it.
  const kept = new Map<string, boolean>();
  const keeps = (node: StructureNode): boolean => {
    if (!filter) {
      return true;
    }
    const remembered = kept.get(node.id);
    if (remembered !== undefined) {
      return remembered;
    }
    // The children are walked whatever the node itself answered, so one pass
    // fills the cache for the whole subtree instead of one pass per ancestor.
    const anyChild = node.children.map(keeps).some(Boolean);
    const answer = filter(node) || anyChild;
    kept.set(node.id, answer);
    return answer;
  };

  // Counting files is a walk of the subtree, and every folder row asks for one.
  // Parents are counted before their children, so the answers are already there.
  const sizes = new Map<string, number>();
  const filesUnder = (node: StructureNode): number => {
    const remembered = sizes.get(node.id);
    if (remembered !== undefined) {
      return remembered;
    }
    const total = node.kind === 'file'
      ? 1
      : node.children.reduce((sum, child) => sum + filesUnder(child), 0);
    sizes.set(node.id, total);
    return total;
  };

  const entriesOf = (node: StructureNode): StructureNode[] => sortEntries(node.children).filter(keeps);

  const walk = (nodes: readonly StructureNode[], depth: number, guides: boolean[]): void => {
    nodes.forEach((node, index) => {
      const last = index === nodes.length - 1;
      const folder = node.kind === 'folder';
      const hasChildren = folder && node.children.length > 0;
      // Under a filter every folder is opened: what is left inside one is only
      // ever matches, and a match behind a closed folder is not a result. A
      // folder that matched on its own name has nothing kept inside it, so it
      // stays shut and reports its size — the same answer a closed folder gives.
      const entries = hasChildren && (Boolean(filter) || options.isOpen(node, depth))
        ? entriesOf(node)
        : [];
      const match = !filter || filter(node);
      if (match) {
        matches += 1;
      }
      const row: TreeRow = {
        node,
        depth,
        guides: [...guides],
        last,
        folder,
        hasChildren,
        open: entries.length > 0,
        files: filesUnder(node),
        match,
      };
      if (rows.length < limit) {
        rows.push(row);
      } else {
        truncated += 1;
      }
      if (entries.length) {
        guides.push(!last);
        walk(entries, depth + 1, guides);
        guides.pop();
      }
    });
  };

  walk(entriesOf(root), 0, []);
  return { rows, matches, truncated };
}

/**
 * Folders first, then names. Both orders are defensible; this is the one every
 * file browser uses, so it is the one a reader can scan without first working
 * out where the folders went.
 */
function sortEntries(nodes: readonly StructureNode[]): StructureNode[] {
  return [...nodes].sort((left, right) =>
    Number(right.kind === 'folder') - Number(left.kind === 'folder')
    || left.label.localeCompare(right.label)
    || left.path.localeCompare(right.path));
}
