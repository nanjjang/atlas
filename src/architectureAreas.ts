import type { DiagramEdge, DiagramGraph, DiagramNode, SourceRef } from './model';

/** A whole architecture canvas stops reading well around this many modules. */
export const ARCHITECTURE_MODULE_TARGET = 24;
export const ARCHITECTURE_AREA_PREFIX = 'codraw-architecture-area:';
export const ARCHITECTURE_LINK_PREFIX = 'codraw-architecture-link:';
const EXTERNAL_AREA = '__external_packages__';

export interface ArchitectureNeighbour {
  key: string;
  label: string;
  count: number;
}

export interface ArchitectureArea {
  key: string;
  label: string;
  moduleIds: string[];
  moduleLabels: string[];
  modules: number;
  files: number;
  internalDependencies: number;
  crossDependencies: number;
  neighbours: ArchitectureNeighbour[];
  source?: SourceRef;
}

export interface ArchitectureMap {
  areas: ArchitectureArea[];
  areaOf: ReadonlyMap<string, string>;
  modules: number;
  externalPackages: DiagramNode[];
  usesAreas: boolean;
}

/**
 * Builds navigable repository areas from path boundaries developers already use.
 * No graph-shape clustering is involved, so an area always has a source meaning.
 */
export function buildArchitectureMap(graph: DiagramGraph): ArchitectureMap {
  const modules = graph.nodes.filter((node) => node.kind === 'module');
  const externalPackages = graph.nodes.filter((node) => node.kind === 'external-package');
  const areaOf = new Map<string, string>();
  const members = new Map<string, DiagramNode[]>();
  for (const node of modules) {
    const key = architectureArea(node.label);
    areaOf.set(node.id, key);
    members.set(key, [...(members.get(key) ?? []), node]);
  }

  // A broad `src` root is not a useful map. When it is the only boundary,
  // use the next declared folder level without inventing graph communities.
  if (members.size < 2 && modules.length > 1) {
    members.clear();
    for (const node of modules) {
      const key = architectureArea(node.label, true);
      areaOf.set(node.id, key);
      members.set(key, [...(members.get(key) ?? []), node]);
    }
  }

  const internal = new Map<string, number>();
  const between = new Map<string, Map<string, number>>();
  const link = (from: string, to: string): void => {
    const row = between.get(from) ?? new Map<string, number>();
    row.set(to, (row.get(to) ?? 0) + 1);
    between.set(from, row);
  };
  for (const edge of graph.edges) {
    const from = areaOf.get(edge.from);
    const to = areaOf.get(edge.to);
    if (!from || !to) continue;
    if (from === to) internal.set(from, (internal.get(from) ?? 0) + 1);
    else {
      link(from, to);
      link(to, from);
    }
  }

  const areas = [...members].map(([key, nodes]): ArchitectureArea => {
    const neighbours = [...(between.get(key) ?? new Map<string, number>())]
      .map(([other, count]) => ({ key: other, label: other, count }))
      .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
    return {
      key,
      label: key,
      moduleIds: nodes.map((node) => node.id),
      moduleLabels: nodes.map((node) => node.label),
      modules: nodes.length,
      files: nodes.reduce((total, node) => total + (Number(node.metadata.Files) || 0), 0),
      internalDependencies: internal.get(key) ?? 0,
      crossDependencies: neighbours.reduce((total, neighbour) => total + neighbour.count, 0),
      neighbours,
      ...(nodes.find((node) => node.source)?.source ? { source: nodes.find((node) => node.source)!.source } : {}),
    };
  }).sort((left, right) => right.files - left.files || left.label.localeCompare(right.label));

  return {
    areas,
    areaOf,
    modules: modules.length,
    externalPackages,
    usesAreas: modules.length > ARCHITECTURE_MODULE_TARGET && areas.length >= 2,
  };
}

/** One card per repository area, with repeated module imports aggregated. */
export function architectureOverviewGraph(graph: DiagramGraph, map: ArchitectureMap): DiagramGraph {
  const nodes: DiagramNode[] = map.areas.map((area) => ({
    id: ARCHITECTURE_AREA_PREFIX + area.key,
    kind: 'architecture-area',
    label: area.label,
    subtitle: `${area.modules} modules · ${area.files} files`,
    ...(area.source ? { source: area.source } : {}),
    confidence: 'inferred',
    metadata: {
      Modules: area.moduleLabels,
      Files: String(area.files),
      'Dependencies inside': String(area.internalDependencies),
      'Dependencies leaving': String(area.crossDependencies),
    },
  }));

  if (map.externalPackages.length) {
    nodes.push({
      id: ARCHITECTURE_AREA_PREFIX + EXTERNAL_AREA,
      kind: 'architecture-external-area',
      label: 'External packages',
      subtitle: `${map.externalPackages.length} detected packages`,
      confidence: 'exact',
      metadata: { Packages: map.externalPackages.map((node) => node.label) },
    });
  }

  const moduleIds = new Set(map.areaOf.keys());
  const aggregate = new Map<string, { from: string; to: string; count: number; source?: SourceRef; confidence: DiagramEdge['confidence'] }>();
  for (const edge of graph.edges) {
    const fromArea = map.areaOf.get(edge.from);
    const toArea = map.areaOf.get(edge.to);
    const external = !moduleIds.has(edge.to) && map.externalPackages.some((node) => node.id === edge.to);
    const from = fromArea;
    const to = external ? EXTERNAL_AREA : toArea;
    if (!from || !to || from === to) continue;
    const key = `${from}\u0000${to}`;
    const existing = aggregate.get(key);
    if (existing) existing.count += 1;
    else aggregate.set(key, { from, to, count: 1, ...(edge.source ? { source: edge.source } : {}), confidence: edge.confidence });
  }
  const edges = [...aggregate.values()]
    .sort((left, right) => `${left.from}/${left.to}`.localeCompare(`${right.from}/${right.to}`))
    .map((edge): DiagramEdge => ({
      id: `codraw-architecture-area-edge:${edge.from}--${edge.to}`,
      from: ARCHITECTURE_AREA_PREFIX + edge.from,
      to: ARCHITECTURE_AREA_PREFIX + edge.to,
      kind: 'area-imports',
      label: `${edge.count} ${edge.count === 1 ? 'dependency' : 'dependencies'}`,
      confidence: edge.confidence,
      ...(edge.source ? { source: edge.source } : {}),
      metadata: { Dependencies: String(edge.count) },
    }));
  return { kind: 'architecture', nodes, edges, emptyMessage: graph.emptyMessage };
}

/**
 * Draws every module inside one area. Cross-area dependencies terminate at one
 * boundary card per neighbour; external package cards remain individually usable.
 */
export function architectureAreaGraph(graph: DiagramGraph, map: ArchitectureMap, key: string): DiagramGraph {
  const area = map.areas.find((candidate) => candidate.key === key);
  if (!area) return { kind: 'architecture', nodes: [], edges: [], emptyMessage: 'That repository area is no longer present.' };
  const inside = new Set(area.moduleIds);
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const nodes = graph.nodes.filter((node) => inside.has(node.id));
  const edges: DiagramEdge[] = [];
  const touchedAreas = new Map<string, Set<string>>();
  const crossings = new Map<string, { local: string; other: string; outgoing: boolean; edges: DiagramEdge[] }>();

  for (const edge of graph.edges) {
    const fromInside = inside.has(edge.from);
    const toInside = inside.has(edge.to);
    if (fromInside && toInside) {
      edges.push(edge);
      continue;
    }
    if (fromInside === toInside) continue;
    const local = fromInside ? edge.from : edge.to;
    const far = fromInside ? edge.to : edge.from;
    const externalNode = byId.get(far);
    if (externalNode?.kind === 'external-package') {
      if (!nodes.some((node) => node.id === far)) nodes.push(externalNode);
      edges.push(edge);
      continue;
    }
    const other = map.areaOf.get(far);
    if (!other || other === key) continue;
    const crossingKey = `${local}\u0000${other}\u0000${fromInside ? 'out' : 'in'}`;
    const existing = crossings.get(crossingKey);
    if (existing) existing.edges.push(edge);
    else crossings.set(crossingKey, { local, other, outgoing: fromInside, edges: [edge] });
    const labels = touchedAreas.get(other) ?? new Set<string>();
    labels.add(byId.get(far)?.label ?? far);
    touchedAreas.set(other, labels);
  }

  for (const [other, labels] of [...touchedAreas].sort(([left], [right]) => left.localeCompare(right))) {
    const neighbour = map.areas.find((candidate) => candidate.key === other);
    nodes.push({
      id: ARCHITECTURE_LINK_PREFIX + other,
      kind: 'architecture-area-link',
      label: neighbour?.label ?? other,
      subtitle: `${labels.size} connected ${labels.size === 1 ? 'module' : 'modules'} beyond this area`,
      ...(neighbour?.source ? { source: neighbour.source } : {}),
      confidence: 'inferred',
      metadata: { Modules: [...labels].sort(), 'Repository area': other },
    });
  }

  for (const crossing of [...crossings.values()].sort((left, right) =>
    `${left.local}/${left.other}/${left.outgoing}`.localeCompare(`${right.local}/${right.other}/${right.outgoing}`))) {
    const first = crossing.edges[0];
    if (!first) continue;
    const count = crossing.edges.length;
    edges.push({
      id: `codraw-architecture-cross:${crossing.local}--${crossing.other}--${crossing.outgoing ? 'out' : 'in'}`,
      from: crossing.outgoing ? crossing.local : ARCHITECTURE_LINK_PREFIX + crossing.other,
      to: crossing.outgoing ? ARCHITECTURE_LINK_PREFIX + crossing.other : crossing.local,
      kind: 'area-boundary',
      label: `${count} ${count === 1 ? 'dependency' : 'dependencies'}`,
      confidence: crossing.edges.some((edge) => edge.confidence === 'unresolved') ? 'unresolved'
        : crossing.edges.some((edge) => edge.confidence === 'inferred') ? 'inferred' : 'exact',
      ...(first.source ? { source: first.source } : {}),
      metadata: { Dependencies: String(count), 'Crosses into': crossing.other },
    });
  }

  return { kind: 'architecture', nodes, edges, emptyMessage: 'This repository area has no modules.' };
}

export function architectureAreaKeyOfNodeId(nodeId: string): string | undefined {
  if (nodeId.startsWith(ARCHITECTURE_AREA_PREFIX)) return nodeId.slice(ARCHITECTURE_AREA_PREFIX.length);
  if (nodeId.startsWith(ARCHITECTURE_LINK_PREFIX)) return nodeId.slice(ARCHITECTURE_LINK_PREFIX.length);
  return undefined;
}

function architectureArea(label: string, deep = false): string {
  const parts = label.split('/').filter(Boolean);
  if (!parts.length) return 'Workspace';
  if (['apps', 'packages', 'services', 'libs'].includes(parts[0] ?? '') && parts.length >= 2) {
    return parts.slice(0, 2).join('/');
  }
  return parts.slice(0, deep ? Math.min(2, parts.length) : 1).join('/');
}
