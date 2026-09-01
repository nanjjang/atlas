import type { DiagramEdge, DiagramNode } from './model';
import type { Block, LayoutGroup, LayoutNode, NodeMetrics } from './graphLayout';

export interface SpreadOptions {
  /** The shape to pack towards, so `fit` can fill the canvas. */
  aspect: number;
  /** The grouping the graph already has; see `declaredGroups`. */
  groupOf?: (node: DiagramNode) => string | undefined;
  /** Room between the cards, when the defaults are not what this view wants. */
  spacing?: SpreadSpacing;
}

export interface SpreadSpacing {
  /** Lanes between relationship ranks and peers inside one section. */
  sectionGapX?: number;
  sectionGapY?: number;
  /** Grid gaps for a section whose cards have no relationship to follow. */
  isolatedGapX?: number;
  isolatedGapY?: number;
  /** Space between two framed communities. */
  groupGap?: number;
  /** Room either side of a section's hub, and between its satellites. */
  hubGapX?: number;
  satelliteGapY?: number;
}

interface ResolvedSpreadSpacing {
  sectionGapX: number;
  sectionGapY: number;
  isolatedGapX: number;
  isolatedGapY: number;
  groupGap: number;
  hubGapX: number;
  satelliteGapY: number;
}

function resolveSpreadSpacing(spacing: SpreadSpacing | undefined): ResolvedSpreadSpacing {
  return {
    sectionGapX: spacing?.sectionGapX ?? SECTION_GAP_X,
    sectionGapY: spacing?.sectionGapY ?? SECTION_GAP_Y,
    isolatedGapX: spacing?.isolatedGapX ?? ISOLATED_GAP_X,
    isolatedGapY: spacing?.isolatedGapY ?? ISOLATED_GAP_Y,
    groupGap: spacing?.groupGap ?? GROUP_GAP,
    hubGapX: spacing?.hubGapX ?? HUB_GAP_X,
    satelliteGapY: spacing?.satelliteGapY ?? SATELLITE_GAP_Y,
  };
}

/**
 * Placement for a graph that a column layout cannot help.
 *
 * Ranking into columns works while the relationships have a direction worth
 * following. A schema does not: nearly every table points at the same few
 * tables, so ranking puts those few in one column and everything else in the
 * next, and the result is a hundred lines converging on one edge of the canvas.
 *
 * The answer is not to scatter them. A force pass shortens the edges and finds
 * the neighbourhoods, but what it produces still reads as a spill — nothing
 * lines up, nothing has a boundary, and there is no order to look along. Every
 * diagram people actually keep open is built the other way round: things that
 * belong together sit in a block, the blocks are arranged in rows, and the
 * result looks decided rather than settled.
 *
 * So this places by construction rather than by simulation:
 *
 * 1. The grouping the graph already has is used when it has one. A table was
 *    declared in a schema file and a module sits in a directory; that is a
 *    grouping the reader can check against the source, and no amount of
 *    community detection on the edges will beat it. Communities are what the
 *    layout falls back to when nothing was declared.
 * 2. A large declared area is divided into a handful of relationship-sized
 *    sections. A migration file containing thirty unrelated tables is useful
 *    provenance, but it is not a readable visual section.
 * 3. Inside a section, relationships run left to right through roomy columns.
 *    Only entities with no relationship at all use a small sparse grid.
 * 4. The communities are ordered so each follows whichever unplaced community
 *    it shares the most relationships with, then packed onto shelves. Related
 *    blocks end up adjacent without the packing giving up its rows.
 *
 * Every step is deterministic. The same graph is placed the same way, which a
 * simulation could only promise by never being touched again.
 */

/** Rounds of label propagation. The labels stop moving well before this. */
const COMMUNITY_ROUNDS = 14;
/** Share of the graph that has to reference a node before it counts as ambient. */
const HUB_SHARE = 0.22;
/** …and the fewest relationships that can make one, on a small graph. */
const HUB_MIN_DEGREE = 12;
/** What an ambient node's vote is worth when deciding who belongs together. */
const HUB_VOTE = 0.06;
/** Clear lanes between relationship ranks and peers in one section. */
const SECTION_GAP_X = 210;
const SECTION_GAP_Y = 104;
/**
 * A grid of unrelated cards has no edges to route around, so it is packed like
 * text, not like a diagram. The routing-lane gaps above would leave a frame of
 * three cards a thousand pixels wide, which forces the whole map into a narrow
 * column and drops `fit` onto a cropped corner.
 */
const ISOLATED_GAP_X = 26;
const ISOLATED_GAP_Y = 18;
/** Room inside a community's frame, and the strip its name sits in. */
const GROUP_PADDING = 30;
const GROUP_HEADER = 38;
/** Space between two communities. */
const GROUP_GAP = 130;
/**
 * Room either side of a section's hub, and between the satellites stacked
 * beside it. The horizontal gap carries every relationship in the section, so
 * it is a lane; the vertical one only has to keep two satellites apart, and a
 * lane-sized gap there would make a section of six taller than the canvas.
 */
const HUB_GAP_X = 150;
const SATELLITE_GAP_Y = 34;
/** Below this there is no middle to put anything in. */
const MIN_RADIAL_MEMBERS = 4;
/** The shape a community's grid aims for: wider than tall, like a screen. */
const TARGET_ASPECT = 1.6;
/** A community larger than this is split, so no one block swamps the canvas. */
const MAX_GROUP_MEMBERS = 10;
/** Unrelated entities are intentionally kept in smaller, scan-sized sections. */
const MAX_ISOLATED_MEMBERS = 6;
/**
 * Below this a community is folded into the one it is most tied to. Label
 * propagation on a sparse graph answers with dozens of pairs and triples, and
 * forty framed boxes of three is not a grouping — it is the same undifferentiated
 * field the frames were meant to break up.
 */
const MIN_GROUP_MEMBERS = 5;
/** Widths tried when packing the blocks, as multiples of the square arrangement. */
const PACK_FACTORS = [0.6, 0.8, 1, 1.25, 1.55, 1.9, 2.4, 3];

/** The synthetic community the cross-area entities are gathered into. */
const CORE_COMMUNITY = -1;
/** Areas the graph needs before a centre frame of shared entities means anything. */
const CORE_MIN_AREAS = 3;
/** Cross-area entities the graph needs before that centre frame is drawn. */
const CORE_MIN_MEMBERS = 2;
/** The most entities a centre holds; past this it is not a centre, it is a wall. */
const CORE_MAX_MEMBERS = 10;
/** Below this the graph is too small for a centre to read as anything but clutter. */
const CORE_MIN_NODES = 16;

/**
 * The nodes so much of the graph references that referencing them says nothing.
 *
 * A `tenant_id` on every table is a fact about the schema, not about any one
 * table. Those relationships are worth almost nothing when deciding what
 * belongs with what, and the diagram draws them as a wash rather than as lines,
 * so the relationships that do distinguish one table from another are the ones
 * left visible.
 *
 * Nothing is dropped: the lines are still there, still hoverable, and still
 * counted in the details panel.
 */
export function ambientNodes(
  nodes: readonly DiagramNode[],
  edges: readonly DiagramEdge[],
): Set<string> {
  const degree = new Map<string, number>();
  for (const edge of edges) {
    if (edge.from === edge.to) {
      continue;
    }
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
  }
  const threshold = Math.max(HUB_MIN_DEGREE, nodes.length * HUB_SHARE);
  const ambient = new Set<string>();
  for (const [id, count] of degree) {
    if (count >= threshold) {
      ambient.add(id);
    }
  }
  return ambient;
}

/** One community, ordered and measured, before it has been placed. */
interface Cluster {
  key: string;
  label: string;
  members: DiagramNode[];
  positions: LayoutNode[];
  width: number;
  height: number;
  detail?: string;
}

export function layoutSpread(
  component: { nodes: DiagramNode[]; edges: DiagramEdge[] },
  metrics: Map<string, NodeMetrics>,
  compact: boolean,
  ambient: ReadonlySet<string>,
  options: SpreadOptions,
): Block {
  // Sorted once, so nothing below depends on the order the nodes arrived in.
  const members = [...component.nodes].sort((left, right) => left.id.localeCompare(right.id));
  const key = members[0]?.id ?? '';
  const ids = new Set(members.map((node) => node.id));
  const edges = component.edges
    .filter((edge) => edge.from !== edge.to && ids.has(edge.from) && ids.has(edge.to))
    .sort((left, right) => left.id.localeCompare(right.id));

  const adjacency = new Map<string, string[]>(members.map((node) => [node.id, []]));
  for (const edge of edges) {
    adjacency.get(edge.from)?.push(edge.to);
    adjacency.get(edge.to)?.push(edge.from);
  }
  const degreeOf = (id: string): number => adjacency.get(id)?.length ?? 0;
  const widthOf = (id: string): number => {
    const measured = metrics.get(id);
    return (compact ? measured?.minWidth ?? measured?.width : measured?.width) ?? 0;
  };
  const heightOf = (id: string): number => metrics.get(id)?.height ?? 0;

  const declared = options.groupOf
    ? declaredGroups(members, edges, adjacency, degreeOf, ambient, options.groupOf)
    : undefined;
  const communities = declared?.communities
    ?? mergeSmall(detectCommunities(members, adjacency, ambient), members, edges);
  const spacing = resolveSpreadSpacing(options.spacing);

  // The entities whose relationships reach into two or more other areas are what
  // ties the graph together. Drawn inside whichever area declared them they sit
  // at the end of every line that crosses a boundary; gathered into a frame of
  // their own in the middle, each of those lines becomes one spoke from an area
  // to the centre — the way this diagram is drawn by hand. Only when the areas
  // were declared: a centre carved out of communities guessed from the edges is
  // a guess resting on a guess.
  const cored = declared
    ? carveCore(members, adjacency, communities, declared.names, ambient)
    : undefined;
  const names = cored
    ? new Map([
      ...(declared?.names ?? []),
      [CORE_COMMUNITY, { label: 'Integration Core', detail: 'Entities shared across areas' }],
    ])
    : declared?.names;

  const clusters = buildClusters(
    members, edges, cored ?? communities, adjacency, degreeOf, widthOf, heightOf, names, spacing,
  ).map((cluster) => ({ ...cluster, key: `${key}::${cluster.key}` }));

  const corePrefix = `${key}::${CORE_COMMUNITY}:`;
  const core = cored ? clusters.filter((cluster) => cluster.key.startsWith(corePrefix)) : [];
  const ring = clusters.filter((cluster) => !core.includes(cluster));
  return core.length > 0 && ring.length >= CORE_MIN_AREAS
    ? packAroundCore(key, core, orderClusters(ring, edges), spacing.groupGap)
    : packClusters(key, orderClusters(clusters, edges), options.aspect, spacing.groupGap);
}

/**
 * Reassigns the entities that carry relationships into two or more other areas
 * to one synthetic community, so `buildClusters` frames them together in the
 * middle rather than leaving them at the ends of every boundary-crossing line.
 *
 * Returns nothing — leaving the ordinary shelf pack in charge — unless the graph
 * has the size, the areas, and enough of these bridge entities for a centre to
 * be worth drawing, and unless the areas it empties still stand on their own.
 */
function carveCore(
  members: readonly DiagramNode[],
  adjacency: ReadonlyMap<string, string[]>,
  communities: ReadonlyMap<string, number>,
  names: ReadonlyMap<number, { label: string; detail: string }>,
  ambient: ReadonlySet<string>,
): Map<string, number> | undefined {
  // A large declared area is split into scan-sized sections, each its own
  // community; a key from one section to another of the same schema file is not
  // a boundary crossing. So bridges are counted against the declared area — the
  // section's `detail` — not the section.
  const areaOf = (id: string): string | undefined => {
    const community = communities.get(id);
    return community === undefined ? undefined : names.get(community)?.detail ?? `#${community}`;
  };
  const areas = new Set(members.map((node) => areaOf(node.id)).filter((area): area is string => area !== undefined));
  if (members.length < CORE_MIN_NODES || areas.size < CORE_MIN_AREAS) {
    return undefined;
  }

  const reach = new Map<string, number>();
  for (const node of members) {
    if (ambient.has(node.id)) {
      continue;
    }
    const own = areaOf(node.id);
    const foreign = new Set<string>();
    for (const other of adjacency.get(node.id) ?? []) {
      const area = areaOf(other);
      if (area !== undefined && area !== own) {
        foreign.add(area);
      }
    }
    if (foreign.size >= 2) {
      reach.set(node.id, foreign.size);
    }
  }
  if (reach.size < CORE_MIN_MEMBERS) {
    return undefined;
  }

  // A centre is a handful of shared entities, not half the schema. When more
  // than a frame's worth reach across areas, the ones that reach furthest are
  // the centre and the rest stay in their areas.
  const bridges = new Set(
    [...reach.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, CORE_MAX_MEMBERS)
      .map(([id]) => id),
  );

  // Pulling the last of an area's tables into the core would leave an empty
  // frame, so the carve is only taken when enough areas keep a table.
  const kept = new Map<string, number>();
  for (const node of members) {
    if (!bridges.has(node.id)) {
      const area = areaOf(node.id);
      if (area !== undefined) {
        kept.set(area, (kept.get(area) ?? 0) + 1);
      }
    }
  }
  if ([...kept.values()].filter((count) => count > 0).length < CORE_MIN_AREAS) {
    return undefined;
  }

  const next = new Map(communities);
  for (const id of bridges) {
    next.set(id, CORE_COMMUNITY);
  }
  return next;
}

/** Below this share of the nodes carrying one, a declared grouping is partial. */
const DECLARED_COVERAGE = 0.7;

/**
 * The grouping the graph came with.
 *
 * A schema file is not a guess about which tables belong together — it is the
 * answer, written by whoever wrote the schema. Grouping by it also does the
 * thing community detection was only approximating: a foreign key usually
 * points at a table in the same file, so the edges that stay inside a frame are
 * most of them, and the few that cross are the ones worth looking at.
 *
 * It is only used when it actually groups: at least two of them, most of the
 * nodes covered, and not so many that each holds one node.
 */
function declaredGroups(
  nodes: readonly DiagramNode[],
  edges: readonly DiagramEdge[],
  adjacency: ReadonlyMap<string, string[]>,
  degreeOf: (id: string) => number,
  ambient: ReadonlySet<string>,
  groupOf: (node: DiagramNode) => string | undefined,
): { communities: Map<string, number>; names: Map<number, { label: string; detail: string }> } | undefined {
  const buckets = new Map<string, DiagramNode[]>();
  let covered = 0;
  for (const node of nodes) {
    const key = groupOf(node);
    if (key === undefined || key === '') {
      continue;
    }
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.push(node);
    } else {
      buckets.set(key, [node]);
    }
    covered += 1;
  }
  if (buckets.size < 1 || covered < nodes.length * DECLARED_COVERAGE || buckets.size > nodes.length / 2) {
    return undefined;
  }

  const communities = new Map<string, number>();
  const names = new Map<number, { label: string; detail: string }>();
  for (const [key, bucket] of buckets) {
    const sections = splitDeclaredBucket(bucket, edges, adjacency, degreeOf, ambient);
    const base = key.split('/').at(-1) ?? key;
    for (const [part, section] of sections.entries()) {
      const index = names.size;
      const leader = breadthFirst(section, adjacency, degreeOf)[0];
      const suffix = sections.length > 1
        ? ` · ${shortSectionName(leader?.label ?? `${part + 1}`)}${part > 0 ? ` ${part + 1}` : ''}`
        : '';
      names.set(index, { label: `${base}${suffix}`, detail: key });
      for (const node of section) {
        communities.set(node.id, index);
      }
    }
  }

  // Whatever was left out goes in one block of its own rather than being
  // dropped or scattered through the others.
  if (covered < nodes.length) {
    const index = names.size;
    names.set(index, { label: 'Ungrouped', detail: 'Declared in no shared source' });
    for (const node of nodes) {
      if (!communities.has(node.id)) {
        communities.set(node.id, index);
      }
    }
  }
  return { communities, names };
}

/**
 * A source-level group is provenance, not permission to draw a wall of cards.
 * Small groups stay intact. Larger ones are split first by real relationships,
 * then into scan-sized pieces; ambient hubs do not glue every section together.
 */
function splitDeclaredBucket(
  bucket: readonly DiagramNode[],
  edges: readonly DiagramEdge[],
  adjacency: ReadonlyMap<string, string[]>,
  degreeOf: (id: string) => number,
  ambient: ReadonlySet<string>,
): DiagramNode[][] {
  if (bucket.length <= MAX_GROUP_MEMBERS) {
    return [[...bucket]];
  }
  const inside = new Map(bucket.map((node) => [node.id, node]));
  const joined = new Map<string, string[]>(bucket.map((node) => [node.id, []]));
  for (const edge of edges) {
    if (!inside.has(edge.from) || !inside.has(edge.to) || ambient.has(edge.from) || ambient.has(edge.to)) {
      continue;
    }
    joined.get(edge.from)?.push(edge.to);
    joined.get(edge.to)?.push(edge.from);
  }

  const components: DiagramNode[][] = [];
  const isolated: DiagramNode[] = [];
  const seen = new Set<string>();
  for (const node of bucket) {
    if (seen.has(node.id)) {
      continue;
    }
    const ids: string[] = [];
    const queue = [node.id];
    seen.add(node.id);
    while (queue.length) {
      const id = queue.shift();
      if (id === undefined) {
        continue;
      }
      ids.push(id);
      for (const neighbour of [...new Set(joined.get(id) ?? [])].sort()) {
        if (!seen.has(neighbour)) {
          seen.add(neighbour);
          queue.push(neighbour);
        }
      }
    }
    const members = ids.flatMap((id) => inside.get(id) ?? []);
    if (members.length === 1 && !(joined.get(members[0]?.id ?? '')?.length)) {
      isolated.push(...members);
    } else {
      components.push(members);
    }
  }

  const result: DiagramNode[][] = [];
  for (const component of components.sort((left, right) => right.length - left.length || left[0]!.id.localeCompare(right[0]!.id))) {
    const ordered = breadthFirst(component, adjacency, degreeOf);
    for (let start = 0; start < ordered.length; start += MAX_GROUP_MEMBERS) {
      result.push(ordered.slice(start, start + MAX_GROUP_MEMBERS));
    }
  }
  const orderedIsolated = [...isolated].sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
  for (let start = 0; start < orderedIsolated.length; start += MAX_ISOLATED_MEMBERS) {
    result.push(orderedIsolated.slice(start, start + MAX_ISOLATED_MEMBERS));
  }
  return result.length ? result : [[...bucket]];
}

function shortSectionName(label: string): string {
  const last = label.split('/').at(-1) ?? label;
  return last.replace(/[_-]?\d+$/, '').replace(/[_-]+/g, ' ').trim() || last;
}

/**
 * Label propagation: every node repeatedly takes the label its neighbours agree
 * on most. A neighbour's vote is worth `1/sqrt(degree)`, which is the whole
 * reason this produces communities on a schema at all — an unweighted vote lets
 * the one table half the schema references hand its own label to half the
 * schema, and the answer comes back as a single community.
 *
 * Ties go to the smallest label and nodes are visited in a fixed order, so the
 * same graph always comes back with the same communities.
 */
function detectCommunities(
  nodes: readonly DiagramNode[],
  adjacency: ReadonlyMap<string, string[]>,
  ambient: ReadonlySet<string>,
): Map<string, number> {
  const order = nodes.map((node) => node.id);
  const weight = new Map<string, number>(
    order.map((id) => [
      id,
      (ambient.has(id) ? HUB_VOTE : 1) / Math.sqrt(Math.max(1, adjacency.get(id)?.length ?? 0)),
    ]),
  );
  const labels = new Map<string, number>(order.map((id, index) => [id, index]));

  for (let round = 0; round < COMMUNITY_ROUNDS; round += 1) {
    let moved = false;
    for (const id of order) {
      const neighbours = adjacency.get(id) ?? [];
      if (!neighbours.length) {
        continue;
      }
      const votes = new Map<number, number>();
      for (const neighbour of neighbours) {
        const label = labels.get(neighbour);
        if (label !== undefined) {
          votes.set(label, (votes.get(label) ?? 0) + (weight.get(neighbour) ?? 0));
        }
      }
      let best = labels.get(id) ?? 0;
      let bestScore = -1;
      for (const [label, score] of [...votes].sort((left, right) => left[0] - right[0])) {
        if (score > bestScore + 1e-9) {
          best = label;
          bestScore = score;
        }
      }
      if (best !== labels.get(id)) {
        labels.set(id, best);
        moved = true;
      }
    }
    if (!moved) {
      break;
    }
  }

  const compacted = new Map<number, number>();
  const result = new Map<string, number>();
  for (const id of order) {
    const label = labels.get(id) ?? 0;
    let index = compacted.get(label);
    if (index === undefined) {
      index = compacted.size;
      compacted.set(label, index);
    }
    result.set(id, index);
  }
  return result;
}

/**
 * Folds every community too small to be worth a frame into the one it shares
 * the most relationships with — and, failing that, into the smallest other
 * community, so a group of strays still ends up somewhere rather than becoming
 * a row of one-line boxes.
 */
function mergeSmall(
  communities: Map<string, number>,
  nodes: readonly DiagramNode[],
  edges: readonly DiagramEdge[],
): Map<string, number> {
  const sizes = new Map<number, number>();
  for (const node of nodes) {
    const community = communities.get(node.id) ?? 0;
    sizes.set(community, (sizes.get(community) ?? 0) + 1);
  }
  if (sizes.size < 2) {
    return communities;
  }

  const ties = new Map<number, Map<number, number>>();
  for (const edge of edges) {
    const from = communities.get(edge.from);
    const to = communities.get(edge.to);
    if (from === undefined || to === undefined || from === to) {
      continue;
    }
    for (const [one, other] of [[from, to], [to, from]] as const) {
      const row = ties.get(one) ?? new Map<number, number>();
      row.set(other, (row.get(other) ?? 0) + 1);
      ties.set(one, row);
    }
  }

  // A community is only ever folded into a larger one, so following the chain
  // of merges terminates and no two communities can swallow each other.
  const mergedInto = new Map<number, number>();
  const resolve = (community: number): number => {
    let current = community;
    while (mergedInto.has(current)) {
      current = mergedInto.get(current) ?? current;
    }
    return current;
  };

  const smallestFirst = [...sizes.keys()].sort((left, right) =>
    (sizes.get(left) ?? 0) - (sizes.get(right) ?? 0) || left - right);
  for (const community of smallestFirst) {
    const source = resolve(community);
    if (source !== community || (sizes.get(source) ?? 0) >= MIN_GROUP_MEMBERS) {
      continue;
    }
    const neighbours = [...(ties.get(community) ?? [])]
      .map(([other, count]) => ({ target: resolve(other), count }))
      .filter((entry) => entry.target !== source);
    const strongest = neighbours.sort((left, right) =>
      right.count - left.count
      || (sizes.get(right.target) ?? 0) - (sizes.get(left.target) ?? 0)
      || left.target - right.target)[0]?.target
      ?? [...sizes.keys()]
        .map(resolve)
        .filter((other) => other !== source)
        .sort((left, right) => (sizes.get(left) ?? 0) - (sizes.get(right) ?? 0) || left - right)[0];
    if (strongest === undefined) {
      continue;
    }
    mergedInto.set(source, strongest);
    sizes.set(strongest, (sizes.get(strongest) ?? 0) + (sizes.get(source) ?? 0));
    sizes.set(source, 0);
  }

  const settled = new Map<string, number>();
  for (const [id, community] of communities) {
    settled.set(id, resolve(community));
  }
  return settled;
}

/**
 * Each community as a relationship-directed mini diagram.
 *
 * Members are visited breadth-first from the best connected one, so a node
 * lands near what it is joined to rather than near whatever name follows it
 * alphabetically. Every cell is sized to the widest member, because a grid
 * whose rows do not share edges is not read as a grid.
 */
function buildClusters(
  nodes: readonly DiagramNode[],
  edges: readonly DiagramEdge[],
  communities: ReadonlyMap<string, number>,
  adjacency: ReadonlyMap<string, string[]>,
  degreeOf: (id: string) => number,
  widthOf: (id: string) => number,
  heightOf: (id: string) => number,
  names: ReadonlyMap<number, { label: string; detail: string }> | undefined,
  spacing: ResolvedSpreadSpacing,
): Cluster[] {
  const grouped = new Map<number, DiagramNode[]>();
  for (const node of nodes) {
    const community = communities.get(node.id) ?? 0;
    const bucket = grouped.get(community);
    if (bucket) {
      bucket.push(node);
    } else {
      grouped.set(community, [node]);
    }
  }

  const clusters: Cluster[] = [];
  for (const [community, bucket] of [...grouped].sort((left, right) => left[0] - right[0])) {
    const ordered = breadthFirst(bucket, adjacency, degreeOf);
    // A community big enough to fill the canvas on its own is cut into blocks
    // of a readable size rather than drawn as one wall of cells.
    for (let start = 0; start < ordered.length; start += MAX_GROUP_MEMBERS) {
      const slice = ordered.slice(start, start + MAX_GROUP_MEMBERS);
      const leader = slice[0];
      if (!leader) {
        continue;
      }
      const placed = placeSection(slice, edges, widthOf, heightOf, spacing);
      const named = names?.get(community);
      const part = start > 0 ? ` (${Math.floor(start / MAX_GROUP_MEMBERS) + 1})` : '';
      clusters.push({
        key: `${community}:${start}`,
        label: named ? `${named.label}${part}` : leader.label,
        ...(named ? { detail: named.detail } : {}),
        members: slice,
        positions: placed.nodes,
        width: placed.width + GROUP_PADDING * 2,
        height: placed.height + GROUP_PADDING * 2 + GROUP_HEADER,
      });
    }
  }
  return clusters;
}

/** Places edges left-to-right. Cycles are condensed into one rank. */
function placeSection(
  members: readonly DiagramNode[],
  edges: readonly DiagramEdge[],
  widthOf: (id: string) => number,
  heightOf: (id: string) => number,
  spacing: ResolvedSpreadSpacing,
): { nodes: LayoutNode[]; width: number; height: number } {
  const inside = new Set(members.map((node) => node.id));
  const links = edges.filter((edge) => inside.has(edge.from) && inside.has(edge.to) && edge.from !== edge.to);
  if (!links.length) {
    return placeIsolated(members, widthOf, heightOf, spacing);
  }

  const neighboursOf = new Map<string, Set<string>>(members.map((node) => [node.id, new Set<string>()]));
  for (const edge of links) {
    neighboursOf.get(edge.from)?.add(edge.to);
    neighboursOf.get(edge.to)?.add(edge.from);
  }
  const radial = placeRadial(members, neighboursOf, widthOf, heightOf, spacing);
  if (radial) {
    return radial;
  }

  const ranks = directedRanks(members, links);
  const columns = new Map<number, DiagramNode[]>();
  for (const node of members) {
    const rank = ranks.get(node.id) ?? 0;
    const column = columns.get(rank);
    if (column) {
      column.push(node);
    } else {
      columns.set(rank, [node]);
    }
  }
  const neighbours = new Map<string, string[]>(members.map((node) => [node.id, []]));
  for (const edge of links) {
    neighbours.get(edge.from)?.push(edge.to);
    neighbours.get(edge.to)?.push(edge.from);
  }
  const orderedRanks = [...columns.keys()].sort((left, right) => left - right);
  for (const rank of orderedRanks) {
    columns.get(rank)?.sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
  }
  // A few median-like sweeps are enough for a section of at most ten nodes.
  for (let sweep = 0; sweep < 4; sweep += 1) {
    const pass = sweep % 2 ? [...orderedRanks].reverse() : orderedRanks;
    const orderOf = new Map<string, number>();
    for (const rank of orderedRanks) {
      columns.get(rank)?.forEach((node, index) => orderOf.set(node.id, index));
    }
    for (const rank of pass) {
      columns.get(rank)?.sort((left, right) => {
        const barycentre = (id: string): number => {
          const values = (neighbours.get(id) ?? []).flatMap((other) => orderOf.get(other) ?? []);
          return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : orderOf.get(id) ?? 0;
        };
        return barycentre(left.id) - barycentre(right.id) || left.id.localeCompare(right.id);
      });
    }
  }

  const widths = orderedRanks.map((rank) => Math.max(1, ...(columns.get(rank) ?? []).map((node) => widthOf(node.id))));
  const heights = orderedRanks.map((rank) => {
    const column = columns.get(rank) ?? [];
    return column.reduce((sum, node) => sum + heightOf(node.id), 0) + Math.max(0, column.length - 1) * spacing.sectionGapY;
  });
  const totalHeight = Math.max(1, ...heights);
  const positioned: LayoutNode[] = [];
  let x = 0;
  orderedRanks.forEach((rank, columnIndex) => {
    const column = columns.get(rank) ?? [];
    let y = (totalHeight - (heights[columnIndex] ?? 0)) / 2;
    for (const node of column) {
      const width = widthOf(node.id);
      const height = heightOf(node.id);
      positioned.push({ node, x, y, width, height });
      y += height + spacing.sectionGapY;
    }
    x += (widths[columnIndex] ?? 1) + spacing.sectionGapX;
  });
  return {
    nodes: positioned,
    width: Math.max(1, x - spacing.sectionGapX),
    height: totalHeight,
  };
}

/**
 * A section placed around the thing it is about.
 *
 * Most sections are not a sequence. A subject area is one table and the tables
 * that carry a key to it; a package is one module and the modules that import
 * it. Ranking that left to right puts the hub alone in a column with its whole
 * section stacked in the next one, so every relationship in the section is
 * drawn as the same horizontal line at a different height, and the one card the
 * section is named after is indistinguishable from the rest.
 *
 * Put the hub in the middle and its neighbours either side of it and the same
 * relationships become short lines pointing inwards from both directions, which
 * is how anyone drawing this by hand would lay it out — and the shape of the
 * section then says which card it is about before a single label is read.
 *
 * Returns nothing when the section has no such centre, and the ranked columns
 * are left to do what they are good at.
 */
function placeRadial(
  members: readonly DiagramNode[],
  neighboursOf: ReadonlyMap<string, ReadonlySet<string>>,
  widthOf: (id: string) => number,
  heightOf: (id: string) => number,
  spacing: ResolvedSpreadSpacing,
): { nodes: LayoutNode[]; width: number; height: number } | undefined {
  if (members.length < MIN_RADIAL_MEMBERS) {
    return undefined;
  }
  const ordered = [...members].sort((left, right) =>
    (neighboursOf.get(right.id)?.size ?? 0) - (neighboursOf.get(left.id)?.size ?? 0)
    || left.label.localeCompare(right.label)
    || left.id.localeCompare(right.id));
  const hub = ordered[0];
  if (!hub) {
    return undefined;
  }
  const attached = neighboursOf.get(hub.id) ?? new Set<string>();
  // The centre has to be a centre: if half the section is not attached to it,
  // the section is a chain or a mesh and putting one card in the middle of it
  // would be a claim the edges do not support.
  if (attached.size < Math.ceil((members.length - 1) / 2)) {
    return undefined;
  }

  const satellites = ordered.slice(1).sort((left, right) =>
    Number(attached.has(right.id)) - Number(attached.has(left.id))
    || left.label.localeCompare(right.label)
    || left.id.localeCompare(right.id));

  // Dealt alternately so the two sides stay the same height; the hub then sits
  // level with the middle of both rather than floating against the taller one.
  const left: DiagramNode[] = [];
  const right: DiagramNode[] = [];
  satellites.forEach((node, index) => (index % 2 === 0 ? left : right).push(node));

  const columnHeight = (column: readonly DiagramNode[]): number =>
    column.reduce((total, node) => total + heightOf(node.id), 0)
    + Math.max(0, column.length - 1) * spacing.satelliteGapY;
  const columnWidth = (column: readonly DiagramNode[]): number =>
    column.length ? Math.max(...column.map((node) => widthOf(node.id))) : 0;

  const leftWidth = columnWidth(left);
  const rightWidth = columnWidth(right);
  const hubWidth = widthOf(hub.id);
  const hubHeight = heightOf(hub.id);
  const height = Math.max(hubHeight, columnHeight(left), columnHeight(right));

  const nodes: LayoutNode[] = [];
  const stack = (column: readonly DiagramNode[], x: number): void => {
    let y = (height - columnHeight(column)) / 2;
    for (const node of column) {
      const nodeHeight = heightOf(node.id);
      // Right-align the left column and left-align the right one, so both sides
      // present a straight edge to the hub and the lines between them are the
      // same length whatever a card is called.
      const width = widthOf(node.id);
      nodes.push({
        node,
        x: x === 0 ? leftWidth - width : x,
        y,
        width,
        height: nodeHeight,
      });
      y += nodeHeight + spacing.satelliteGapY;
    }
  };

  const hubX = left.length ? leftWidth + spacing.hubGapX : 0;
  stack(left, 0);
  nodes.push({ node: hub, x: hubX, y: (height - hubHeight) / 2, width: hubWidth, height: hubHeight });
  if (right.length) {
    stack(right, hubX + hubWidth + spacing.hubGapX);
  }

  const width = right.length
    ? hubX + hubWidth + spacing.hubGapX + rightWidth
    : hubX + hubWidth;
  return { nodes, width: Math.max(1, width), height: Math.max(1, height) };
}

/** Strongly-connected components become DAG vertices, then longest-path ranks. */
function directedRanks(members: readonly DiagramNode[], edges: readonly DiagramEdge[]): Map<string, number> {
  const outgoing = new Map<string, string[]>(members.map((node) => [node.id, []]));
  for (const edge of edges) {
    outgoing.get(edge.from)?.push(edge.to);
  }
  for (const targets of outgoing.values()) {
    targets.sort();
  }

  let nextIndex = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const componentOf = new Map<string, number>();
  const visit = (id: string): void => {
    index.set(id, nextIndex);
    low.set(id, nextIndex);
    nextIndex += 1;
    stack.push(id);
    onStack.add(id);
    for (const target of outgoing.get(id) ?? []) {
      if (!index.has(target)) {
        visit(target);
        low.set(id, Math.min(low.get(id) ?? 0, low.get(target) ?? 0));
      } else if (onStack.has(target)) {
        low.set(id, Math.min(low.get(id) ?? 0, index.get(target) ?? 0));
      }
    }
    if (low.get(id) !== index.get(id)) {
      return;
    }
    const component = new Set<string>();
    while (stack.length) {
      const member = stack.pop();
      if (member === undefined) {
        break;
      }
      onStack.delete(member);
      component.add(member);
      if (member === id) {
        break;
      }
    }
    const componentIndex = new Set(componentOf.values()).size;
    for (const member of component) {
      componentOf.set(member, componentIndex);
    }
  };
  for (const node of members) {
    if (!index.has(node.id)) {
      visit(node.id);
    }
  }

  const componentCount = new Set(componentOf.values()).size;
  const dag = new Map<number, Set<number>>(Array.from({ length: componentCount }, (_, value) => [value, new Set()]));
  const indegree = new Map<number, number>(Array.from({ length: componentCount }, (_, value) => [value, 0]));
  for (const edge of edges) {
    const from = componentOf.get(edge.from);
    const to = componentOf.get(edge.to);
    if (from === undefined || to === undefined || from === to || dag.get(from)?.has(to)) {
      continue;
    }
    dag.get(from)?.add(to);
    indegree.set(to, (indegree.get(to) ?? 0) + 1);
  }
  const queue = [...indegree].filter(([, value]) => value === 0).map(([value]) => value).sort((a, b) => a - b);
  const componentRank = new Map<number, number>();
  while (queue.length) {
    const current = queue.shift();
    if (current === undefined) {
      continue;
    }
    for (const target of [...(dag.get(current) ?? [])].sort((a, b) => a - b)) {
      componentRank.set(target, Math.max(componentRank.get(target) ?? 0, (componentRank.get(current) ?? 0) + 1));
      indegree.set(target, (indegree.get(target) ?? 0) - 1);
      if (indegree.get(target) === 0) {
        queue.push(target);
        queue.sort((a, b) => a - b);
      }
    }
  }
  return new Map(members.map((node) => [node.id, componentRank.get(componentOf.get(node.id) ?? 0) ?? 0]));
}

/**
 * A tight grid for a section with no relationship to follow. Cards with no
 * edges do not need routing lanes between them, so they are packed close in a
 * block roughly `TARGET_ASPECT` wide, and the frame ends up the size of its
 * contents rather than the size of the lanes it does not use.
 */
function placeIsolated(
  members: readonly DiagramNode[],
  widthOf: (id: string) => number,
  heightOf: (id: string) => number,
  spacing: ResolvedSpreadSpacing,
): { nodes: LayoutNode[]; width: number; height: number } {
  const ordered = [...members].sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
  const cellWidth = Math.max(1, ...ordered.map((node) => widthOf(node.id)));
  const cellHeight = Math.max(1, ...ordered.map((node) => heightOf(node.id)));
  // A squarish grid with a slight landscape lean, so a section of four or five
  // reads as a small block rather than a tall single file.
  const columns = Math.max(1, Math.min(ordered.length, 5, Math.round(Math.sqrt(ordered.length * TARGET_ASPECT))));
  const nodes = ordered.map((node, position) => ({
    node,
    x: (position % columns) * (cellWidth + spacing.isolatedGapX),
    y: Math.floor(position / columns) * (cellHeight + spacing.isolatedGapY),
    width: widthOf(node.id),
    height: heightOf(node.id),
  }));
  const rows = Math.ceil(ordered.length / columns);
  return {
    nodes,
    width: columns * cellWidth + Math.max(0, columns - 1) * spacing.isolatedGapX,
    height: rows * cellHeight + Math.max(0, rows - 1) * spacing.isolatedGapY,
  };
}

/** The community's members, best connected first and then outwards from it. */
function breadthFirst(
  bucket: readonly DiagramNode[],
  adjacency: ReadonlyMap<string, string[]>,
  degreeOf: (id: string) => number,
): DiagramNode[] {
  const inside = new Map(bucket.map((node) => [node.id, node]));
  const byReach = (left: string, right: string): number =>
    degreeOf(right) - degreeOf(left) || left.localeCompare(right);

  const ordered: DiagramNode[] = [];
  const seen = new Set<string>();
  for (const start of [...bucket].sort((left, right) => byReach(left.id, right.id))) {
    if (seen.has(start.id)) {
      continue;
    }
    const queue = [start.id];
    seen.add(start.id);
    while (queue.length) {
      const id = queue.shift();
      const node = id === undefined ? undefined : inside.get(id);
      if (id === undefined || !node) {
        continue;
      }
      ordered.push(node);
      const neighbours = [...new Set(adjacency.get(id) ?? [])]
        .filter((neighbour) => inside.has(neighbour) && !seen.has(neighbour))
        .sort(byReach);
      for (const neighbour of neighbours) {
        seen.add(neighbour);
        queue.push(neighbour);
      }
    }
  }
  return ordered;
}

/**
 * The order the blocks are packed in.
 *
 * Largest first, then whichever unplaced community shares the most
 * relationships with the ones already placed. Shelf packing lays blocks down in
 * the order it is given, so an order that follows the relationships puts
 * related blocks side by side without the packing needing to know anything
 * about them.
 */
function orderClusters(clusters: readonly Cluster[], edges: readonly DiagramEdge[]): Cluster[] {
  const bySize = (left: Cluster, right: Cluster): number =>
    right.members.length - left.members.length || left.key.localeCompare(right.key);
  if (clusters.length < 3) {
    return [...clusters].sort(bySize);
  }

  const clusterOf = new Map<string, string>();
  for (const cluster of clusters) {
    for (const member of cluster.members) {
      clusterOf.set(member.id, cluster.key);
    }
  }
  const ties = new Map<string, Map<string, number>>();
  for (const edge of edges) {
    const from = clusterOf.get(edge.from);
    const to = clusterOf.get(edge.to);
    if (!from || !to || from === to) {
      continue;
    }
    for (const [one, other] of [[from, to], [to, from]] as const) {
      const row = ties.get(one) ?? new Map<string, number>();
      row.set(other, (row.get(other) ?? 0) + 1);
      ties.set(one, row);
    }
  }

  const remaining = new Map(clusters.map((cluster) => [cluster.key, cluster]));
  const scores = new Map<string, number>();
  const placed: Cluster[] = [];
  let next = [...clusters].sort(bySize)[0];

  while (next) {
    placed.push(next);
    remaining.delete(next.key);
    for (const [other, count] of ties.get(next.key) ?? []) {
      if (remaining.has(other)) {
        scores.set(other, (scores.get(other) ?? 0) + count);
      }
    }
    next = [...remaining.values()].sort((left, right) =>
      (scores.get(right.key) ?? 0) - (scores.get(left.key) ?? 0) || bySize(left, right))[0];
  }
  return placed;
}

/**
 * Shelf packing, in the order given, onto rows about as wide as the canvas.
 *
 * The width to aim for cannot be computed from the area, because the gaps and
 * the ragged end of each shelf are most of the difference on a handful of
 * blocks. So several widths are tried and the arrangement whose shape is
 * closest to the canvas is kept — that is the one `fit` can fill.
 */
function packClusters(key: string, clusters: readonly Cluster[], aspect: number, groupGap: number): Block {
  const wanted = clamp(aspect, 0.4, 3);
  const area = clusters.reduce((total, cluster) => total + cluster.width * cluster.height, 0);
  const widest = Math.max(1, ...clusters.map((cluster) => cluster.width));
  const square = Math.sqrt(Math.max(1, area) * wanted);

  let best: Block | undefined;
  let bestError = Number.POSITIVE_INFINITY;
  for (const factor of PACK_FACTORS) {
    const candidate = shelve(key, clusters, Math.max(widest, square * factor), groupGap);
    const error = Math.abs(Math.log((candidate.width / Math.max(1, candidate.height)) / wanted));
    if (error < bestError) {
      bestError = error;
      best = candidate;
    }
  }
  return best ?? shelve(key, clusters, Math.max(widest, square), groupGap);
}

function shelve(key: string, clusters: readonly Cluster[], target: number, groupGap: number): Block {
  const nodes: LayoutNode[] = [];
  const groups: LayoutGroup[] = [];
  let x = 0;
  let y = 0;
  let shelfHeight = 0;
  let width = 0;

  for (const cluster of clusters) {
    if (x > 0 && x + cluster.width > target) {
      y += shelfHeight + groupGap;
      x = 0;
      shelfHeight = 0;
    }
    groups.push({
      key: cluster.key,
      label: cluster.label,
      ...(cluster.detail ? { detail: cluster.detail } : {}),
      count: cluster.members.length,
      nodeIds: cluster.members.map((node) => node.id),
      x,
      y,
      width: cluster.width,
      height: cluster.height,
    });
    cluster.positions.forEach((positioned) => {
      nodes.push({
        node: positioned.node,
        x: x + GROUP_PADDING + positioned.x,
        y: y + GROUP_PADDING + GROUP_HEADER + positioned.y,
        width: positioned.width,
        height: positioned.height,
      });
    });
    x += cluster.width + groupGap;
    width = Math.max(width, x - groupGap);
    shelfHeight = Math.max(shelfHeight, cluster.height);
  }

  return {
    key,
    width: Math.max(1, width),
    height: Math.max(1, y + shelfHeight),
    nodes,
    groups,
    bends: new Map(),
  };
}

/**
 * The area frames laid into a grid with the core in the middle cell.
 *
 * A schema divides into a handful of areas held together by a few shared
 * entities. Once those entities are carved into a core (`carveCore`), putting
 * that core at the centre and the areas around it turns every crossing
 * relationship into a single spoke — which is how anyone drawing this by hand
 * arranges it, and what keeps the crossing lines from piling up along one edge.
 */
function packAroundCore(key: string, coreParts: readonly Cluster[], ring: readonly Cluster[], groupGap: number): Block {
  // The core is capped to one frame's worth of members, so it never splits; a
  // stray extra part (should the cap ever change) just joins the ring.
  const [core, ...extraCore] = coreParts;
  if (!core) {
    return packClusters(key, [...ring], TARGET_ASPECT, groupGap);
  }
  const ringAll = [...extraCore, ...ring];

  // At least three columns, so the centre column has a frame either side of the
  // core rather than the core landing in a corner of a two-wide grid.
  const cols = clamp(Math.round(Math.sqrt(ringAll.length + 1)), 3, 4);
  const estRows = Math.max(1, Math.ceil((ringAll.length + 1) / cols));
  const centreRow = Math.floor(estRows / 2);
  const centreCol = Math.floor(cols / 2);

  // Row-major cells, stepping over the one the core is reserved.
  const cells: Array<{ cluster: Cluster; row: number; col: number }> = [];
  let slot = 0;
  for (const cluster of ringAll) {
    if (Math.floor(slot / cols) === centreRow && slot % cols === centreCol) {
      slot += 1;
    }
    cells.push({ cluster, row: Math.floor(slot / cols), col: slot % cols });
    slot += 1;
  }
  cells.push({ cluster: core, row: centreRow, col: centreCol });

  const rows = Math.max(...cells.map((cell) => cell.row)) + 1;
  const colWidth = Array.from({ length: cols }, () => 0);
  const rowHeight = Array.from({ length: rows }, () => 0);
  for (const { cluster, row, col } of cells) {
    colWidth[col] = Math.max(colWidth[col] ?? 0, cluster.width);
    rowHeight[row] = Math.max(rowHeight[row] ?? 0, cluster.height);
  }

  const colX: number[] = [];
  let cx = 0;
  for (let c = 0; c < cols; c += 1) {
    colX.push(cx);
    cx += (colWidth[c] ?? 0) + groupGap;
  }
  const rowY: number[] = [];
  let ry = 0;
  for (let r = 0; r < rows; r += 1) {
    rowY.push(ry);
    ry += (rowHeight[r] ?? 0) + groupGap;
  }

  const nodes: LayoutNode[] = [];
  const groups: LayoutGroup[] = [];
  for (const { cluster, row, col } of cells) {
    const x = (colX[col] ?? 0) + ((colWidth[col] ?? cluster.width) - cluster.width) / 2;
    const y = (rowY[row] ?? 0) + ((rowHeight[row] ?? cluster.height) - cluster.height) / 2;
    groups.push({
      key: cluster.key,
      label: cluster.label,
      ...(cluster.detail ? { detail: cluster.detail } : {}),
      count: cluster.members.length,
      nodeIds: cluster.members.map((node) => node.id),
      x,
      y,
      width: cluster.width,
      height: cluster.height,
    });
    cluster.positions.forEach((positioned) => {
      nodes.push({
        node: positioned.node,
        x: x + GROUP_PADDING + positioned.x,
        y: y + GROUP_PADDING + GROUP_HEADER + positioned.y,
        width: positioned.width,
        height: positioned.height,
      });
    });
  }

  return {
    key,
    width: Math.max(1, cx - groupGap),
    height: Math.max(1, ry - groupGap),
    nodes,
    groups,
    bends: new Map(),
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
