import type { DiagramEdge, DiagramNode } from './model';
import { ambientNodes, layoutSpread, type SpreadSpacing } from './spreadLayout';

/**
 * Placement for the diagram panel.
 *
 * The diagram is read one relationship at a time, so the edges decide whether
 * it works, and three things are done for them in order:
 *
 * 1. Parts of the graph that are not connected to each other are laid out
 *    separately and packed side by side. Nothing is gained by giving an entity
 *    with no relationships a column of its own halfway across the diagram, and
 *    a great deal is lost: every edge that has to reach past it gets longer.
 * 2. Inside one part, dependencies still point left to right, because a
 *    consistent direction is what lets you follow a chain at all.
 * 3. An edge that spans more than one column is bent around the columns it
 *    crosses, rather than drawn straight through the nodes standing in them.
 *    The bends are laid out with the nodes, so they take space of their own and
 *    two edges crossing the same gap stay apart.
 */

/** Vertical space between two nodes sharing a column. */
export const NODE_GAP_Y = 26;
/** Horizontal space between one column and the next. */
export const RANK_GAP_X = 108;
/** Space between two parts of the diagram that share no relationship. */
export const BLOCK_GAP = 120;
/** Two edges crossing the same column only need room not to read as one. */
const ROUTE_GAP_Y = 14;
/** Distance the content is held off the top left of the diagram's own space. */
const ORIGIN = 20;
/** Median sweeps over the columns. The last two look both ways. */
const SWEEPS = 6;
/** A column taller than this is split, whatever it costs the routing. */
const MAX_COLUMN_ROWS = 14;
/** Past this the swap-and-measure pass costs more than the crossings it saves. */
const TRANSPOSE_EDGE_BUDGET = 400;
/** Widths tried when packing the parts, as multiples of the square arrangement. */
const PACK_FACTORS = [0.5, 0.7, 0.85, 1, 1.2, 1.5, 1.9, 2.4, 3.1, 4];

export interface NodeMetrics {
  /** Width the node would like; the column agrees on one for all of them. */
  width: number;
  height: number;
  /**
   * Width to fall back to when the roomy one costs the reader zoom. Room for a
   * full label is worth having, but not at the price of a diagram that no
   * longer fits, so the layout tries both and keeps whichever reads larger.
   */
  minWidth?: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface LayoutNode {
  node: DiagramNode;
  x: number;
  y: number;
  width: number;
  height: number;
}

export type LayoutFlow =
  /** Ranked into columns, dependencies pointing left to right. */
  | 'flow'
  /** Spread over the plane by neighbourhood, with no reading direction. */
  | 'spread';

/**
 * A block of nodes that belong together, and the frame drawn round them.
 *
 * The grouping is the layout's own finding rather than something the analysis
 * declared, so it is handed over as geometry and a name: the view draws a frame
 * and a label, and nothing downstream has to re-derive which nodes were near
 * which.
 */
export interface LayoutGroup {
  key: string;
  /** What the block is called: its source, or its best connected member. */
  label: string;
  /** The whole of it, when the label had to be shortened to fit. */
  detail?: string;
  count: number;
  /** Nodes held by the frame, used to collapse boundary-crossing edges. */
  nodeIds: string[];
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutResult {
  /** Which arrangement produced this, so the edges can be drawn to match. */
  flow: LayoutFlow;
  /** Nodes so widely referenced that their edges are drawn as a wash. */
  ambient: Set<string>;
  /** The neighbourhoods the nodes were grouped into, if the layout found any. */
  groups: LayoutGroup[];
  nodes: LayoutNode[];
  nodeById: Map<string, LayoutNode>;
  /** Points a routed edge passes through, in the edge's own direction. */
  bends: Map<string, Point[]>;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Leaves packed into a block of their own, beside the graph proper. */
export interface LaneOptions {
  nodes: readonly DiagramNode[];
  width: number;
  height: number;
}

export interface GraphLayoutOptions {
  viewportWidth: number;
  viewportHeight: number;
  /** Room `fit` keeps around the content, so packing is scored on what the reader sees. */
  fitPadding: number;
  /**
   * The zoom `fit` will not go past. Scoring beyond it would trade room for the
   * labels against a magnification the camera is never going to apply.
   */
  maxScale?: number;
  measure: (node: DiagramNode) => NodeMetrics;
  lane?: LaneOptions;
  /** `auto` reads the graph's own shape; see `autoFlow`. */
  flow?: LayoutFlow | 'auto';
  /**
   * The grouping the graph already has, if it has one: the schema file a table
   * was declared in, the directory a module sits under. Preferred over anything
   * derived from the shape of the graph, because a reader can check it.
   */
  groupOf?: (node: DiagramNode) => string | undefined;
  /**
   * Room between the nodes, when the default is not what this diagram wants.
   *
   * A dependency graph is read as a shape, so it is packed to stay legible at
   * `fit`. A flowchart is read a step at a time along a line, and the gap is
   * what the eye follows the line through — the same spacing that keeps a
   * module map compact turns a flowchart into a wall of boxes with the arrows
   * hidden between them.
   */
  spacing?: Spacing;
  /** Room between the cards of a spread arrangement; see `SpreadSpacing`. */
  spreadSpacing?: SpreadSpacing;
}

export interface Spacing {
  /** Vertical space between two nodes sharing a column. */
  nodeGapY?: number;
  /** Horizontal space between one column and the next. */
  rankGapX?: number;
  /** Space between two parts of the diagram that share no relationship. */
  blockGap?: number;
}

interface ResolvedSpacing {
  nodeGapY: number;
  rankGapX: number;
  blockGap: number;
}

function resolveSpacing(spacing: Spacing | undefined): ResolvedSpacing {
  return {
    nodeGapY: spacing?.nodeGapY ?? NODE_GAP_Y,
    rankGapX: spacing?.rankGapX ?? RANK_GAP_X,
    blockGap: spacing?.blockGap ?? BLOCK_GAP,
  };
}

/** A node, or a point one edge passes through, sharing a column with nodes. */
interface Entry {
  id: string;
  node?: DiagramNode;
  width: number;
  height: number;
}

/** One connected part of the graph, placed in its own coordinate space. */
export interface Block {
  key: string;
  width: number;
  height: number;
  nodes: LayoutNode[];
  bends: Map<string, Point[]>;
  /** Empty unless the layout grouped its nodes; see `LayoutGroup`. */
  groups?: LayoutGroup[];
}

/** An edge as the layering sees it: pointing forwards, whatever it does on screen. */
interface Link {
  edge: DiagramEdge;
  from: string;
  to: string;
  /** True when the edge had to be turned around to break a cycle. */
  reversed: boolean;
}

export function layoutGraph(
  nodes: readonly DiagramNode[],
  edges: readonly DiagramEdge[],
  options: GraphLayoutOptions,
): LayoutResult {
  const lane = options.lane?.nodes.length ? options.lane : undefined;
  if (!nodes.length && !lane) {
    return {
      flow: 'flow',
      ambient: new Set(),
      groups: [],
      nodes: [],
      nodeById: new Map(),
      bends: new Map(),
      minX: 0,
      minY: 0,
      maxX: 1,
      maxY: 1,
    };
  }

  const ids = new Set(nodes.map((node) => node.id));
  const graphEdges = edges.filter((edge) => edge.from !== edge.to && ids.has(edge.from) && ids.has(edge.to));
  const metrics = new Map(nodes.map((node) => [node.id, options.measure(node)]));
  const requested = options.flow ?? 'auto';
  const flow = requested === 'auto' ? autoFlow(nodes, graphEdges, options.groupOf) : requested;
  // Fold declared areas too small to be worth a frame into their parent path,
  // so a monorepo of a dozen one- and two-module packages draws as `apps` and
  // `packages` rather than a dozen near-empty boxes.
  const groupOf = flow === 'spread' && options.groupOf
    ? coalesceGroups(nodes, options.groupOf)
    : options.groupOf;
  const components = connectedComponents(
    nodes,
    graphEdges,
    flow === 'spread' ? groupOf : undefined,
  );
  const ambient = ambientNodes(nodes, graphEdges);
  const spacing = resolveSpacing(options.spacing);

  const canvasWidth = options.viewportWidth || 1200;
  const canvasHeight = options.viewportHeight || 750;

  const blocksFor = (compact: boolean): Block[] => {
    const blocks = components.map((component) => (flow === 'spread'
      ? layoutSpread(component, metrics, compact, ambient, {
        aspect: canvasWidth / Math.max(1, canvasHeight),
        ...(groupOf ? { groupOf } : {}),
        ...(options.spreadSpacing ? { spacing: options.spreadSpacing } : {}),
      })
      : layoutComponent(component, metrics, compact, spacing)));
    if (lane) {
      blocks.push(layoutLane(lane));
    }
    return blocks;
  };

  const ceiling = options.maxScale ?? Number.POSITIVE_INFINITY;

  let best: { packed: ReturnType<typeof pack>; scale: number; compact: boolean; aspect: number } | undefined;
  for (const compact of [false, true]) {
    // The compact widths only ever win by fitting where the roomy ones do not,
    // so once the roomy arrangement is already being magnified as far as `fit`
    // will go there is nothing left for them to win, and laying the whole graph
    // out a second time to find that out is time the reader waits for nothing.
    if (compact && best && best.scale >= ceiling) {
      break;
    }
    const blocks = blocksFor(compact);
    const area = blocks.reduce((total, block) => total + block.width * block.height, 0);
    const widest = Math.max(1, ...blocks.map((block) => block.width));
    const square = Math.sqrt(Math.max(1, area) * (canvasWidth / canvasHeight));
    for (const factor of PACK_FACTORS) {
      const packed = pack(blocks, Math.max(widest, square * factor), spacing.blockGap);
      const scale = Math.min(
        (canvasWidth - options.fitPadding) / Math.max(1, packed.width),
        (canvasHeight - options.fitPadding) / Math.max(1, packed.height),
        ceiling,
      );
      // Among arrangements that read at practically the same zoom, prefer the
      // one that gives the labels room, and then the one whose shape is closest
      // to the canvas, because that is the one that leaves the least dead space.
      const aspect = Math.abs(Math.log((packed.width / Math.max(1, packed.height)) / (canvasWidth / canvasHeight)));
      const better = !best
        || scale > best.scale * 1.02
        || (scale >= best.scale * 0.98 && (compact !== best.compact ? !compact : aspect < best.aspect));
      if (better) {
        best = { packed, scale: Math.max(scale, best?.scale ?? scale), compact, aspect };
      }
    }
  }

  const placed = best?.packed.nodes ?? [];
  const shifted = placed.map((positioned) => ({ ...positioned, x: positioned.x + ORIGIN, y: positioned.y + ORIGIN }));
  const bends = new Map<string, Point[]>();
  for (const [id, points] of best?.packed.bends ?? []) {
    bends.set(id, points.map((point) => ({ x: point.x + ORIGIN, y: point.y + ORIGIN })));
  }
  const groups = (best?.packed.groups ?? []).map((group) => ({
    ...group,
    x: group.x + ORIGIN,
    y: group.y + ORIGIN,
  }));

  return {
    flow,
    ambient,
    groups,
    nodes: shifted,
    nodeById: new Map(shifted.map((positioned) => [positioned.node.id, positioned])),
    bends,
    ...boundsOf(shifted),
  };
}

/**
 * Below this a column layout is short enough to read whatever its shape.
 *
 * The floor used to sit at 24, from before a section had a middle to put its
 * hub in: a small schema ranked into columns was no worse than a small schema
 * spread into one framed block with its cards in a row. Now that a section is
 * built around the card it is named after, a dense dozen reads better spread
 * than ranked, and a schema of seventeen tables — which is most of the areas a
 * real schema divides into — was landing on the wrong side of the old floor.
 */
const SPREAD_MIN_NODES = 12;

/**
 * Which arrangement the graph asks for.
 *
 * Columns are worth keeping while they still say something. They say the most
 * about a graph that flows: a handful of modules, each depending on the next.
 *
 * They say the least about two shapes. One is a graph with a hub — the table
 * every other table carries a foreign key to. Ranking puts the hub alone in one
 * column and its hundred references in the next, and every one of those
 * relationships is drawn as a line the width of the diagram. The other is a
 * graph with more relationships than nodes, where the ranks are wide enough
 * that most edges skip columns rather than stepping to the next one.
 *
 * Both of those are laid out by neighbourhood instead, which is the arrangement
 * that makes those same edges short.
 */
function autoFlow(
  nodes: readonly DiagramNode[],
  edges: readonly DiagramEdge[],
  groupOf?: (node: DiagramNode) => string | undefined,
): LayoutFlow {
  if (nodes.length < SPREAD_MIN_NODES) {
    return 'flow';
  }
  const degree = new Map<string, number>();
  for (const edge of edges) {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
  }
  const busiest = Math.max(0, ...degree.values());
  const hubbed = busiest >= Math.max(10, nodes.length * 0.2);
  const dense = edges.length >= nodes.length * 1.5;
  // A source-declared map is more useful than dependency ranks once there are
  // enough modules to make several real areas. Keeping those modules in columns
  // discards the project's own boundaries and turns every boundary crossing into
  // a long line across an undifferentiated field.
  const declared = groupOf ? usefulGroupCount(nodes, groupOf) : 0;
  return hubbed || dense || declared >= 2 ? 'spread' : 'flow';
}

function usefulGroupCount(
  nodes: readonly DiagramNode[],
  groupOf: (node: DiagramNode) => string | undefined,
): number {
  const groups = new Map<string, number>();
  let covered = 0;
  for (const node of nodes) {
    const group = groupOf(node);
    if (!group) {
      continue;
    }
    groups.set(group, (groups.get(group) ?? 0) + 1);
    covered += 1;
  }
  if (covered < nodes.length * 0.7) {
    return 0;
  }
  return [...groups.values()].filter((count) => count >= 2).length;
}

export function boundsOf(nodes: readonly LayoutNode[]): { minX: number; minY: number; maxX: number; maxY: number } {
  if (!nodes.length) {
    return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  }
  return {
    minX: Math.min(...nodes.map((positioned) => positioned.x)),
    minY: Math.min(...nodes.map((positioned) => positioned.y)),
    maxX: Math.max(...nodes.map((positioned) => positioned.x + positioned.width)),
    maxY: Math.max(...nodes.map((positioned) => positioned.y + positioned.height)),
  };
}

/**
 * Shelf packing, tallest part first. The parts share no relationship, so the
 * only thing their arrangement has to do is waste as little space as possible.
 */
function pack(
  blocks: readonly Block[],
  targetWidth: number,
  blockGap: number,
): { nodes: LayoutNode[]; bends: Map<string, Point[]>; groups: LayoutGroup[]; width: number; height: number } {
  const ordered = [...blocks].sort((left, right) =>
    right.height - left.height || right.width - left.width || left.key.localeCompare(right.key));

  const nodes: LayoutNode[] = [];
  const bends = new Map<string, Point[]>();
  const groups: LayoutGroup[] = [];
  let x = 0;
  let y = 0;
  let shelfHeight = 0;
  let width = 0;

  for (const block of ordered) {
    if (x > 0 && x + block.width > targetWidth) {
      y += shelfHeight + blockGap;
      x = 0;
      shelfHeight = 0;
    }
    for (const positioned of block.nodes) {
      nodes.push({ ...positioned, x: positioned.x + x, y: positioned.y + y });
    }
    for (const [id, points] of block.bends) {
      bends.set(id, points.map((point) => ({ x: point.x + x, y: point.y + y })));
    }
    for (const group of block.groups ?? []) {
      groups.push({ ...group, x: group.x + x, y: group.y + y });
    }
    x += block.width + blockGap;
    width = Math.max(width, x - blockGap);
    shelfHeight = Math.max(shelfHeight, block.height);
  }
  return { nodes, bends, groups, width, height: y + shelfHeight };
}

/** Fewest members a path-keyed declared area needs before it is folded up. */
export const MIN_DECLARED_AREA = 4;

/**
 * Returns a grouping like the one given, but with path-keyed areas smaller than
 * `MIN_DECLARED_AREA` folded into their parent path, repeated until nothing
 * moves. `apps/web`, `apps/api` and `apps/mobile` become one `apps`; a key with
 * no parent path, or an area already large enough, is left alone; the result
 * never has fewer than two areas.
 */
export function coalesceGroups(
  nodes: readonly DiagramNode[],
  groupOf: (node: DiagramNode) => string | undefined,
): (node: DiagramNode) => string | undefined {
  const sizes = new Map<string, number>();
  for (const node of nodes) {
    const key = groupOf(node);
    if (key) {
      sizes.set(key, (sizes.get(key) ?? 0) + 1);
    }
  }
  const movedTo = new Map<string, string>();
  for (let changed = true; changed && sizes.size > 2;) {
    changed = false;
    for (const [key, size] of [...sizes].sort((left, right) => left[1] - right[1])) {
      if (sizes.size <= 2 || size >= MIN_DECLARED_AREA || !key.includes('/')) {
        continue;
      }
      const parent = key.slice(0, key.lastIndexOf('/'));
      movedTo.set(key, parent);
      sizes.set(parent, (sizes.get(parent) ?? 0) + size);
      sizes.delete(key);
      changed = true;
    }
  }
  if (!movedTo.size) {
    return groupOf;
  }
  const resolve = (key: string): string => {
    let current = key;
    const seen = new Set<string>();
    while (movedTo.has(current) && !seen.has(current)) {
      seen.add(current);
      current = movedTo.get(current) ?? current;
    }
    return current;
  };
  return (node) => {
    const key = groupOf(node);
    return key ? resolve(key) : key;
  };
}

function connectedComponents(
  nodes: readonly DiagramNode[],
  edges: readonly DiagramEdge[],
  groupOf?: (node: DiagramNode) => string | undefined,
): { nodes: DiagramNode[]; edges: DiagramEdge[] }[] {
  const parent = new Map<string, string>(nodes.map((node) => [node.id, node.id]));
  const find = (start: string): string => {
    let root = start;
    while ((parent.get(root) ?? root) !== root) {
      root = parent.get(root) ?? root;
    }
    let walk = start;
    while ((parent.get(walk) ?? walk) !== root) {
      const next = parent.get(walk) ?? walk;
      parent.set(walk, root);
      walk = next;
    }
    return root;
  };
  for (const edge of edges) {
    const left = find(edge.from);
    const right = find(edge.to);
    if (left !== right) {
      parent.set(left, right);
    }
  }
  // A declared area remains one area even when some of its members have no
  // direct relationship. Splitting first and grouping later was the reason ORM
  // entities from the same schema appeared as unrelated loose cards.
  if (groupOf) {
    const representative = new Map<string, string>();
    for (const node of nodes) {
      const group = groupOf(node);
      if (!group) {
        continue;
      }
      const first = representative.get(group);
      if (!first) {
        representative.set(group, node.id);
        continue;
      }
      const left = find(first);
      const right = find(node.id);
      if (left !== right) {
        parent.set(left, right);
      }
    }
  }

  const byRoot = new Map<string, { nodes: DiagramNode[]; edges: DiagramEdge[] }>();
  for (const node of nodes) {
    const root = find(node.id);
    const bucket = byRoot.get(root) ?? { nodes: [], edges: [] };
    bucket.nodes.push(node);
    byRoot.set(root, bucket);
  }
  for (const edge of edges) {
    byRoot.get(find(edge.from))?.edges.push(edge);
  }
  return [...byRoot.values()];
}

function layoutComponent(
  component: { nodes: DiagramNode[]; edges: DiagramEdge[] },
  metrics: Map<string, NodeMetrics>,
  compact: boolean,
  spacing: ResolvedSpacing,
): Block {
  const widthOf = (id: string): number => {
    const measured = metrics.get(id);
    return (compact ? measured?.minWidth ?? measured?.width : measured?.width) ?? 0;
  };
  const heightOf = (id: string): number => metrics.get(id)?.height ?? 0;
  const key = component.nodes.map((node) => node.id).sort()[0] ?? '';

  const single = component.nodes.length === 1 ? component.nodes[0] : undefined;
  if (single) {
    const width = widthOf(single.id);
    const height = heightOf(single.id);
    return { key, width, height, nodes: [{ node: single, x: 0, y: 0, width, height }], bends: new Map() };
  }

  const links = breakCycles(component.nodes, component.edges);
  const ranks = rankNodes(component.nodes, links);

  const byRank = new Map<number, DiagramNode[]>();
  for (const node of component.nodes) {
    const rank = ranks.get(node.id) ?? 0;
    byRank.set(rank, [...(byRank.get(rank) ?? []), node]);
  }
  // Same group before same name, so a column the edges have no opinion about
  // still arrives sorted the way the reader thinks about it.
  for (const group of byRank.values()) {
    group.sort(byGroupThenLabel);
  }

  const layers: Entry[][] = [];
  const layerOf = new Map<string, number>();
  for (const rank of [...byRank.keys()].sort((left, right) => left - right)) {
    const group = byRank.get(rank) ?? [];
    const columns = Math.max(1, Math.ceil(group.length / MAX_COLUMN_ROWS));
    const rows = Math.ceil(group.length / columns);
    for (let start = 0; start < group.length; start += rows) {
      const slice = group.slice(start, start + rows);
      for (const node of slice) {
        layerOf.set(node.id, layers.length);
      }
      layers.push(slice.map((node) => ({ id: node.id, node, width: widthOf(node.id), height: heightOf(node.id) })));
    }
  }

  // A bend per column crossed, so the edge has somewhere to be that is not
  // inside a node, and so the ordering pass can see it and keep it out of the
  // way of the others.
  const routes = new Map<string, string[]>();
  const chains: { from: string; to: string }[] = [];
  for (const link of links) {
    const from = layerOf.get(link.from);
    const to = layerOf.get(link.to);
    if (from === undefined || to === undefined) {
      continue;
    }
    const points: string[] = [];
    for (let index = from + 1; index < to; index += 1) {
      const id = `route:${link.edge.id}:${index}`;
      points.push(id);
      layers[index]?.push({ id, width: 0, height: 0 });
    }
    if (points.length) {
      routes.set(link.edge.id, points);
    }
    const chain = [link.from, ...points, link.to];
    for (let index = 0; index + 1 < chain.length; index += 1) {
      chains.push({ from: chain[index] ?? '', to: chain[index + 1] ?? '' });
    }
  }

  orderLayers(layers, chains);
  const tops = assignY(layers, chains, spacing.nodeGapY);

  let x = 0;
  const layerX: number[] = [];
  const layerWidth: number[] = [];
  for (const layer of layers) {
    const width = Math.max(1, ...layer.map((entry) => entry.width));
    layerX.push(x);
    layerWidth.push(width);
    x += width + spacing.rankGapX;
  }

  const placed: LayoutNode[] = [];
  layers.forEach((layer, index) => {
    for (const entry of layer) {
      if (entry.node) {
        placed.push({
          node: entry.node,
          x: layerX[index] ?? 0,
          y: tops.get(entry.id) ?? 0,
          width: layerWidth[index] ?? 1,
          height: entry.height,
        });
      }
    }
  });

  const bends = new Map<string, Point[]>();
  for (const link of links) {
    const points = routes.get(link.edge.id);
    const start = (layerOf.get(link.from) ?? 0) + 1;
    if (!points?.length) {
      continue;
    }
    const routed = points.map((id, offset) => ({
      x: (layerX[start + offset] ?? 0) + (layerWidth[start + offset] ?? 0) / 2,
      y: tops.get(id) ?? 0,
    }));
    bends.set(link.edge.id, link.reversed ? [...routed].reverse() : routed);
  }

  // The block is measured over its bends too: an edge that swings above the
  // topmost node still has to be inside the box the packing reserves.
  const bounds = boundsOf(placed);
  const points = [...bends.values()].flat();
  const minY = Math.min(bounds.minY, ...points.map((point) => point.y));
  const maxY = Math.max(bounds.maxY, ...points.map((point) => point.y));
  const shift = (dx: number, dy: number): void => {
    for (const positioned of placed) {
      positioned.x -= dx;
      positioned.y -= dy;
    }
    for (const [id, list] of bends) {
      bends.set(id, list.map((point) => ({ x: point.x - dx, y: point.y - dy })));
    }
  };
  shift(bounds.minX, minY);

  return { key, width: bounds.maxX - bounds.minX, height: maxY - minY, nodes: placed, bends };
}

/** Packs the lane's leaves into a block roughly as wide as it is tall. */
function layoutLane(lane: LaneOptions): Block {
  const rows = Math.max(1, Math.round(Math.sqrt(lane.nodes.length * (lane.height + ROUTE_GAP_Y) / lane.width)));
  const perColumn = Math.max(1, Math.ceil(lane.nodes.length / Math.max(1, Math.ceil(lane.nodes.length / rows))));
  const nodes = lane.nodes.map((node, index) => ({
    node,
    x: 16 + Math.floor(index / perColumn) * (lane.width + ROUTE_GAP_Y + 4),
    y: 38 + (index % perColumn) * (lane.height + ROUTE_GAP_Y),
    width: lane.width,
    height: lane.height,
  }));
  const bounds = boundsOf(nodes);
  return {
    // Sorted last among equals, so the leaves never lead the diagram.
    key: '￿-lane',
    width: bounds.maxX - bounds.minX + 32,
    height: bounds.maxY - bounds.minY + 54,
    nodes,
    groups: [{
      key: '￿-lane',
      label: 'External packages',
      detail: 'Dependencies outside this workspace',
      count: lane.nodes.length,
      nodeIds: lane.nodes.map((node) => node.id),
      x: 0,
      y: 0,
      width: bounds.maxX - bounds.minX + 32,
      height: bounds.maxY - bounds.minY + 54,
    }],
    bends: new Map(),
  };
}

/**
 * Turns the cycles around. Ranking cannot place an edge that points back at its
 * own ancestor, so the depth-first pass that finds one flips it; the edge is
 * still drawn in its own direction, it is only laid out in the other.
 */
function breakCycles(nodes: readonly DiagramNode[], edges: readonly DiagramEdge[]): Link[] {
  const outgoing = new Map<string, DiagramEdge[]>();
  for (const edge of edges) {
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge]);
  }
  for (const [id, list] of outgoing) {
    outgoing.set(id, [...list].sort((left, right) => left.id.localeCompare(right.id)));
  }

  const links: Link[] = [];
  const state = new Map<string, 'open' | 'done'>();
  const visit = (start: string): void => {
    const stack: { id: string; index: number }[] = [{ id: start, index: 0 }];
    state.set(start, 'open');
    while (stack.length) {
      const frame = stack[stack.length - 1];
      if (!frame) {
        break;
      }
      const list = outgoing.get(frame.id) ?? [];
      if (frame.index >= list.length) {
        state.set(frame.id, 'done');
        stack.pop();
        continue;
      }
      const edge = list[frame.index];
      frame.index += 1;
      if (!edge) {
        continue;
      }
      const seen = state.get(edge.to);
      if (seen === 'open') {
        links.push({ edge, from: edge.to, to: edge.from, reversed: true });
        continue;
      }
      links.push({ edge, from: edge.from, to: edge.to, reversed: false });
      if (!seen) {
        state.set(edge.to, 'open');
        stack.push({ id: edge.to, index: 0 });
      }
    }
  };

  for (const node of [...nodes].sort((left, right) => left.id.localeCompare(right.id))) {
    if (!state.has(node.id)) {
      visit(node.id);
    }
  }
  return links;
}

/** Longest path from a root, over edges that have already been made acyclic. */
function rankNodes(nodes: readonly DiagramNode[], links: readonly Link[]): Map<string, number> {
  const indegree = new Map(nodes.map((node) => [node.id, 0]));
  const outgoing = new Map<string, string[]>();
  for (const link of links) {
    if (link.from === link.to) {
      continue;
    }
    indegree.set(link.to, (indegree.get(link.to) ?? 0) + 1);
    outgoing.set(link.from, [...(outgoing.get(link.from) ?? []), link.to]);
  }

  const rank = new Map(nodes.map((node) => [node.id, 0]));
  const queue = nodes.filter((node) => (indegree.get(node.id) ?? 0) === 0).map((node) => node.id).sort();
  const visited = new Set<string>();
  while (queue.length) {
    const id = queue.shift();
    if (!id || visited.has(id)) {
      continue;
    }
    visited.add(id);
    for (const target of outgoing.get(id) ?? []) {
      rank.set(target, Math.max(rank.get(target) ?? 0, (rank.get(id) ?? 0) + 1));
      const remaining = (indegree.get(target) ?? 1) - 1;
      indegree.set(target, remaining);
      if (remaining === 0) {
        queue.push(target);
      }
    }
    queue.sort();
  }
  return rank;
}

/**
 * Crossing reduction. Barycenter sweeps get the ordering roughly right, and the
 * swap pass then tries every adjacent pair, which is what removes the last few
 * crossings a mean cannot see. The best ordering measured is the one kept, so a
 * later sweep can never hand back something worse than an earlier one.
 */
function orderLayers(layers: Entry[][], chains: readonly { from: string; to: string }[]): void {
  const predecessors = new Map<string, string[]>();
  const successors = new Map<string, string[]>();
  for (const chain of chains) {
    successors.set(chain.from, [...(successors.get(chain.from) ?? []), chain.to]);
    predecessors.set(chain.to, [...(predecessors.get(chain.to) ?? []), chain.from]);
  }

  const positions = new Map<string, number>();
  const reindex = (): void => {
    for (const layer of layers) {
      layer.forEach((entry, index) => positions.set(entry.id, index));
    }
  };
  reindex();

  let bestOrder = layers.map((layer) => [...layer]);
  let bestCrossings = countCrossings(layers, chains);

  for (let sweep = 0; sweep < 4; sweep += 1) {
    const forward = sweep % 2 === 0;
    const neighbours = forward ? predecessors : successors;
    const order = forward ? layers : [...layers].reverse();
    for (const layer of order) {
      if (layer.length < 2) {
        continue;
      }
      const scored = layer.map((entry, index) => {
        const known = (neighbours.get(entry.id) ?? [])
          .map((id) => positions.get(id))
          .filter((position): position is number => position !== undefined);
        const barycenter = known.length
          ? known.reduce((total, position) => total + position, 0) / known.length
          : index;
        return { entry, barycenter };
      });
      scored.sort((left, right) => left.barycenter - right.barycenter || compareEntries(left.entry, right.entry));
      layer.splice(0, layer.length, ...scored.map((item) => item.entry));
      reindex();
    }

    if (chains.length <= TRANSPOSE_EDGE_BUDGET) {
      transpose(layers, chains);
      reindex();
    }

    const crossings = countCrossings(layers, chains);
    if (crossings < bestCrossings) {
      bestCrossings = crossings;
      bestOrder = layers.map((layer) => [...layer]);
    }
  }

  layers.forEach((layer, index) => layer.splice(0, layer.length, ...(bestOrder[index] ?? layer)));
}

/** Swaps neighbouring pairs for as long as a swap removes crossings. */
function transpose(layers: Entry[][], chains: readonly { from: string; to: string }[]): void {
  for (let pass = 0; pass < 3; pass += 1) {
    let improved = false;
    for (const layer of layers) {
      for (let index = 0; index + 1 < layer.length; index += 1) {
        const before = countCrossings(layers, chains);
        swap(layer, index);
        if (countCrossings(layers, chains) < before) {
          improved = true;
        } else {
          swap(layer, index);
        }
      }
    }
    if (!improved) {
      return;
    }
  }
}

function swap(layer: Entry[], index: number): void {
  const left = layer[index];
  const right = layer[index + 1];
  if (left && right) {
    layer[index] = right;
    layer[index + 1] = left;
  }
}

/**
 * Two edges between the same pair of columns cross when their endpoints are
 * ordered one way at the start and the other way at the end.
 */
function countCrossings(layers: readonly Entry[][], chains: readonly { from: string; to: string }[]): number {
  const position = new Map<string, number>();
  const layerIndex = new Map<string, number>();
  layers.forEach((layer, index) => layer.forEach((entry, order) => {
    position.set(entry.id, order);
    layerIndex.set(entry.id, index);
  }));

  const byPair = new Map<string, { from: number; to: number }[]>();
  for (const chain of chains) {
    const fromLayer = layerIndex.get(chain.from);
    const toLayer = layerIndex.get(chain.to);
    const from = position.get(chain.from);
    const to = position.get(chain.to);
    if (fromLayer === undefined || toLayer === undefined || from === undefined || to === undefined) {
      continue;
    }
    const key = `${fromLayer}:${toLayer}`;
    byPair.set(key, [...(byPair.get(key) ?? []), { from, to }]);
  }

  let crossings = 0;
  for (const list of byPair.values()) {
    for (let left = 0; left < list.length; left += 1) {
      for (let right = left + 1; right < list.length; right += 1) {
        const one = list[left];
        const other = list[right];
        if (one && other && (one.from - other.from) * (one.to - other.to) < 0) {
          crossings += 1;
        }
      }
    }
  }
  return crossings;
}

/**
 * Vertical position, one column at a time: every entry wants to sit level with
 * the middle of its neighbours, and the column has to honour its own order and
 * spacing. Sweeps alternate direction so the pull comes from both sides.
 */
function assignY(
  layers: readonly Entry[][],
  chains: readonly { from: string; to: string }[],
  nodeGapY: number,
): Map<string, number> {
  const predecessors = new Map<string, string[]>();
  const successors = new Map<string, string[]>();
  for (const chain of chains) {
    successors.set(chain.from, [...(successors.get(chain.from) ?? []), chain.to]);
    predecessors.set(chain.to, [...(predecessors.get(chain.to) ?? []), chain.from]);
  }
  const both = new Map<string, string[]>();
  for (const [id, list] of predecessors) {
    both.set(id, [...list]);
  }
  for (const [id, list] of successors) {
    both.set(id, [...(both.get(id) ?? []), ...list]);
  }

  const gapsOf = (layer: readonly Entry[]): number[] =>
    layer.slice(0, -1).map((entry, index) => (entry.node || layer[index + 1]?.node ? nodeGapY : ROUTE_GAP_Y));
  const spanOf = (layer: readonly Entry[]): number =>
    layer.reduce((total, entry) => total + entry.height, 0) + gapsOf(layer).reduce((total, gap) => total + gap, 0);

  // Start every column centred on a shared midline. A short column left at the
  // top edge sends its edges diving across the whole part for no reason.
  const tallest = Math.max(0, ...layers.map(spanOf));
  const top = new Map<string, number>();
  for (const layer of layers) {
    const gaps = gapsOf(layer);
    let y = (tallest - spanOf(layer)) / 2;
    layer.forEach((entry, index) => {
      top.set(entry.id, y);
      y += entry.height + (gaps[index] ?? 0);
    });
  }

  const heights = new Map(layers.flat().map((entry) => [entry.id, entry.height]));
  const centreOf = (id: string): number | undefined => {
    const value = top.get(id);
    return value === undefined ? undefined : value + (heights.get(id) ?? 0) / 2;
  };

  for (let sweep = 0; sweep < SWEEPS; sweep += 1) {
    const forward = sweep % 2 === 0;
    const neighbours = sweep >= SWEEPS - 2 ? both : forward ? predecessors : successors;
    const order = forward ? layers : [...layers].reverse();
    for (const layer of order) {
      const desired = layer.map((entry) => {
        const known = (neighbours.get(entry.id) ?? [])
          .map(centreOf)
          .filter((value): value is number => value !== undefined);
        return known.length ? median(known) : centreOf(entry.id) ?? 0;
      });
      const tops = straighten(layer.map((entry) => entry.height), gapsOf(layer), desired);
      layer.forEach((entry, index) => top.set(entry.id, tops[index] ?? 0));
    }
  }
  return top;
}

/**
 * Puts one column's entries as close to where their neighbours sit as the
 * column's order and spacing allow.
 *
 * Subtracting the space each entry's predecessors already claim turns "keep a
 * gap between them" into "must not decrease", which is exactly isotonic
 * regression. So the best fit is one pool-adjacent-violators pass, rather than
 * a nudge-and-hope loop that can still leave two nodes overlapping.
 */
function straighten(
  heights: readonly number[],
  gaps: readonly number[],
  desiredCentres: readonly number[],
): number[] {
  const offsets: number[] = [];
  let offset = 0;
  heights.forEach((height, index) => {
    offsets.push(offset);
    offset += height + (gaps[index] ?? 0);
  });
  const targets = desiredCentres.map(
    (centre, index) => centre - (heights[index] ?? 0) / 2 - (offsets[index] ?? 0),
  );

  const blocks: { total: number; count: number; mean: number }[] = [];
  for (const target of targets) {
    let block = { total: target, count: 1, mean: target };
    while (blocks.length) {
      const previous = blocks[blocks.length - 1];
      if (!previous || previous.mean <= block.mean) {
        break;
      }
      blocks.pop();
      const total = previous.total + block.total;
      const count = previous.count + block.count;
      block = { total, count, mean: total / count };
    }
    blocks.push(block);
  }

  const tops: number[] = [];
  for (const block of blocks) {
    for (let index = 0; index < block.count; index += 1) {
      tops.push(block.mean + (offsets[tops.length] ?? 0));
    }
  }
  return tops;
}

function compareEntries(left: Entry, right: Entry): number {
  if (left.node && right.node) {
    return byGroupThenLabel(left.node, right.node);
  }
  return left.id.localeCompare(right.id);
}

function byGroupThenLabel(left: DiagramNode, right: DiagramNode): number {
  return (left.group ?? '').localeCompare(right.group ?? '') || left.label.localeCompare(right.label);
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? 0;
  }
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}
