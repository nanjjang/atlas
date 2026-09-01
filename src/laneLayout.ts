import type { DiagramEdge, DiagramNode, ResolutionConfidence } from './model';

/**
 * Lane assignment for the compact list view, modelled on the commit graph in the
 * Source Control view: one node per row, and every relationship drawn as a line
 * in a narrow gutter to the left of the labels.
 *
 * A canvas needs room in two dimensions; a sidebar only has one. Rows give the
 * vertical axis away for free, so the only thing the layout has to solve is how
 * few columns the relationships can be packed into.
 */

/** A gutter wider than this stops being readable in a sidebar. */
export const MAX_LANES = 8;

export type LaneLineKind =
  /** Crosses the row untouched, on its way further down. */
  | 'pass'
  /** Arrives at this row's dot from above. */
  | 'enter'
  /** Leaves this row's dot on its way down. */
  | 'exit';

export interface LaneLine {
  kind: LaneLineKind;
  /** Lane the line occupies at the top edge of the row. */
  fromLane: number;
  /** Lane the line occupies at the bottom edge of the row. */
  toLane: number;
  edgeId: string;
  confidence: ResolutionConfidence;
}

export interface LaneRow {
  node: DiagramNode;
  /** Column the row's own dot sits in. */
  lane: number;
  lines: LaneLine[];
  /** Relationships arriving at and leaving this node, counting both directions. */
  incoming: number;
  outgoing: number;
}

export interface LaneLayout {
  rows: LaneRow[];
  /** Columns actually used, so the gutter can be sized to the content. */
  laneCount: number;
  /**
   * Edges the gutter cannot draw: self references, and the back edges a cycle
   * forces. They are reported so the row can still show that they exist.
   */
  unroutedEdgeIds: string[];
}

interface OpenLane {
  edgeId: string;
  targetId: string;
  confidence: ResolutionConfidence;
}

/**
 * Orders nodes so a relationship generally points downwards: rank by longest
 * path from a root, then by label. Cycles cannot be ranked consistently, so the
 * edges that close them are reported as unrouted rather than drawn upwards.
 */
export function orderNodes(nodes: readonly DiagramNode[], edges: readonly DiagramEdge[]): DiagramNode[] {
  const ids = new Set(nodes.map((node) => node.id));
  const indegree = new Map(nodes.map((node) => [node.id, 0]));
  const successors = new Map<string, string[]>();

  for (const edge of edges) {
    if (edge.from === edge.to || !ids.has(edge.from) || !ids.has(edge.to)) {
      continue;
    }
    successors.set(edge.from, [...(successors.get(edge.from) ?? []), edge.to]);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }

  const rank = new Map<string, number>();
  let frontier = nodes
    .filter((node) => (indegree.get(node.id) ?? 0) === 0)
    .map((node) => node.id);
  for (const id of frontier) {
    rank.set(id, 0);
  }

  const remaining = new Map(indegree);
  while (frontier.length) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const target of successors.get(id) ?? []) {
        rank.set(target, Math.max(rank.get(target) ?? 0, (rank.get(id) ?? 0) + 1));
        const left = (remaining.get(target) ?? 0) - 1;
        remaining.set(target, left);
        if (left === 0) {
          next.push(target);
        }
      }
    }
    frontier = next;
  }

  // Anything still unranked sits on a cycle; park it below the ranked nodes.
  const unranked = nodes.filter((node) => !rank.has(node.id)).length;
  const fallback = nodes.length + unranked;

  return [...nodes].sort((left, right) => {
    const leftRank = rank.get(left.id) ?? fallback;
    const rightRank = rank.get(right.id) ?? fallback;
    return leftRank - rightRank || left.label.localeCompare(right.label);
  });
}

export function layoutLanes(nodes: readonly DiagramNode[], edges: readonly DiagramEdge[]): LaneLayout {
  const order = orderNodes(nodes, edges);
  const rowOf = new Map(order.map((node, index) => [node.id, index]));

  const outgoing = new Map<string, DiagramEdge[]>();
  const unroutedEdgeIds: string[] = [];
  const incomingCount = new Map<string, number>();
  const outgoingCount = new Map<string, number>();

  for (const edge of edges) {
    const from = rowOf.get(edge.from);
    const to = rowOf.get(edge.to);
    if (from === undefined || to === undefined) {
      continue;
    }
    outgoingCount.set(edge.from, (outgoingCount.get(edge.from) ?? 0) + 1);
    incomingCount.set(edge.to, (incomingCount.get(edge.to) ?? 0) + 1);
    if (from >= to) {
      // A self reference or a back edge: the gutter only draws downwards.
      unroutedEdgeIds.push(edge.id);
      continue;
    }
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge]);
  }

  // Shorter hops first, so a long dependency does not sit in the lane a
  // neighbouring one could have closed immediately.
  for (const [id, list] of outgoing) {
    outgoing.set(id, [...list].sort((left, right) =>
      (rowOf.get(left.to) ?? 0) - (rowOf.get(right.to) ?? 0) || left.id.localeCompare(right.id)));
  }

  const lanes: (OpenLane | undefined)[] = [];
  const rows: LaneRow[] = [];
  let laneCount = 1;

  const claimFree = (): number => {
    const free = lanes.findIndex((slot) => slot === undefined);
    if (free >= 0) {
      return free;
    }
    // Past the cap, extra relationships share the last lane rather than pushing
    // the gutter wider than the sidebar can show.
    return lanes.length < MAX_LANES ? lanes.length : MAX_LANES - 1;
  };

  const claimLane = (preferred: number): number =>
    preferred < lanes.length && lanes[preferred] === undefined ? preferred : claimFree();

  for (const node of order) {
    const lines: LaneLine[] = [];
    const ending: number[] = [];
    for (let lane = 0; lane < lanes.length; lane += 1) {
      if (lanes[lane]?.targetId === node.id) {
        ending.push(lane);
      }
    }
    const ownLane = ending.length ? Math.min(...ending) : claimLane(0);

    for (let lane = 0; lane < lanes.length; lane += 1) {
      const slot = lanes[lane];
      if (!slot) {
        continue;
      }
      if (slot.targetId === node.id) {
        lines.push({ kind: 'enter', fromLane: lane, toLane: ownLane, edgeId: slot.edgeId, confidence: slot.confidence });
      } else {
        lines.push({ kind: 'pass', fromLane: lane, toLane: lane, edgeId: slot.edgeId, confidence: slot.confidence });
      }
    }
    for (const lane of ending) {
      lanes[lane] = undefined;
    }

    // Only the first outgoing edge inherits the row's own lane; the rest take
    // whichever lane a closed relationship has freed up.
    let inheritsOwnLane = true;
    for (const edge of outgoing.get(node.id) ?? []) {
      const lane = inheritsOwnLane ? claimLane(ownLane) : claimFree();
      inheritsOwnLane = false;
      const displaced = lanes[lane];
      if (displaced) {
        // Only reachable once every lane up to the cap is busy.
        unroutedEdgeIds.push(displaced.edgeId);
      }
      lanes[lane] = { edgeId: edge.id, targetId: edge.to, confidence: edge.confidence };
      lines.push({ kind: 'exit', fromLane: ownLane, toLane: lane, edgeId: edge.id, confidence: edge.confidence });
      laneCount = Math.max(laneCount, lane + 1);
    }

    laneCount = Math.max(laneCount, ownLane + 1);
    rows.push({
      node,
      lane: ownLane,
      lines,
      incoming: incomingCount.get(node.id) ?? 0,
      outgoing: outgoingCount.get(node.id) ?? 0,
    });
  }

  return { rows, laneCount: Math.min(laneCount, MAX_LANES), unroutedEdgeIds };
}
