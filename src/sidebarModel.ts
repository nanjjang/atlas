import type { DiagramEdge, DiagramGraph, DiagramNode } from './model';

export type SidebarArea = 'code' | 'data';
export type RelationDirection = 'incoming' | 'outgoing';

export interface SidebarRelation {
  node: DiagramNode;
  edge: DiagramEdge;
  direction: RelationDirection;
}

export interface SidebarNeighbourhood {
  focus: DiagramNode;
  incoming: SidebarRelation[];
  outgoing: SidebarRelation[];
  hiddenIncoming: number;
  hiddenOutgoing: number;
}

export interface GraphHealth {
  inferred: DiagramEdge[];
  unresolved: DiagramEdge[];
  isolated: DiagramNode[];
}

/**
 * Picks a useful starting point for the sidebar's small relationship map.
 * A valid active/pinned node wins; otherwise the busiest workspace node wins.
 * External packages are leaves added for context, not useful places to start.
 */
export function chooseSidebarFocus(graph: DiagramGraph, preferredId?: string): string | undefined {
  if (preferredId && graph.nodes.some((node) => node.id === preferredId)) {
    return preferredId;
  }
  const degree = degreeByNode(graph);
  return [...graph.nodes]
    .sort((left, right) =>
      Number(right.kind !== 'external-package') - Number(left.kind !== 'external-package')
      || (degree.get(right.id) ?? 0) - (degree.get(left.id) ?? 0)
      || left.label.localeCompare(right.label))[0]?.id;
}

/**
 * The sidebar has room for a local map, not a whole-project graph. Duplicate
 * edges to the same neighbour are folded into one route and the remainder is
 * reported separately so the view never becomes a miniature hairball.
 */
export function sidebarNeighbourhood(
  graph: DiagramGraph,
  focusId: string,
  limitPerSide = 4,
): SidebarNeighbourhood | undefined {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const focus = byId.get(focusId);
  if (!focus) {
    return undefined;
  }

  const incoming = uniqueRelations(graph.edges, focusId, 'incoming', byId);
  const outgoing = uniqueRelations(graph.edges, focusId, 'outgoing', byId);
  return {
    focus,
    incoming: incoming.slice(0, limitPerSide),
    outgoing: outgoing.slice(0, limitPerSide),
    hiddenIncoming: Math.max(0, incoming.length - limitPerSide),
    hiddenOutgoing: Math.max(0, outgoing.length - limitPerSide),
  };
}

/** Static-analysis signals that are useful while coding, without pretending
 * inferred or incomplete evidence is a confirmed defect. */
export function graphHealth(graph: DiagramGraph): GraphHealth {
  const degree = degreeByNode(graph);
  return {
    inferred: graph.edges.filter((edge) => edge.confidence === 'inferred'),
    unresolved: graph.edges.filter((edge) => edge.confidence === 'unresolved'),
    isolated: graph.nodes
      .filter((node) => node.kind !== 'external-package' && (degree.get(node.id) ?? 0) === 0)
      .sort((left, right) => left.label.localeCompare(right.label)),
  };
}

export function degreeByNode(graph: DiagramGraph): Map<string, number> {
  const degree = new Map(graph.nodes.map((node) => [node.id, 0]));
  for (const edge of graph.edges) {
    if (edge.from === edge.to) {
      degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
      continue;
    }
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
  }
  return degree;
}

function uniqueRelations(
  edges: readonly DiagramEdge[],
  focusId: string,
  direction: RelationDirection,
  byId: ReadonlyMap<string, DiagramNode>,
): SidebarRelation[] {
  const candidates = direction === 'incoming'
    ? edges.filter((edge) => edge.to === focusId && edge.from !== focusId)
    : edges.filter((edge) => edge.from === focusId && edge.to !== focusId);
  const byNeighbour = new Map<string, SidebarRelation>();
  for (const edge of candidates) {
    const neighbourId = direction === 'incoming' ? edge.from : edge.to;
    const node = byId.get(neighbourId);
    if (!node) {
      continue;
    }
    const previous = byNeighbour.get(neighbourId);
    // Prefer the strongest evidence when several parsed relationships collapse
    // onto the same pair of cards.
    if (!previous || confidenceRank(edge.confidence) > confidenceRank(previous.edge.confidence)) {
      byNeighbour.set(neighbourId, { node, edge, direction });
    }
  }
  return [...byNeighbour.values()].sort((left, right) =>
    confidenceRank(right.edge.confidence) - confidenceRank(left.edge.confidence)
    || left.node.label.localeCompare(right.node.label));
}

function confidenceRank(confidence: DiagramEdge['confidence']): number {
  return confidence === 'exact' ? 2 : confidence === 'inferred' ? 1 : 0;
}
