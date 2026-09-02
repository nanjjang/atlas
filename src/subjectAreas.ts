import { coalesceGroups } from './graphLayout';
import type { DiagramEdge, DiagramGraph, DiagramNode, SourceRef } from './model';

/**
 * Subject areas for the data view.
 *
 * A schema drawn whole is a poster, not a diagram. Past a hundred tables the
 * only thing the picture communicates is that the database is large: everyone
 * says "wow", nobody reads it twice, and the questions people actually bring to
 * a schema — what is billing made of, what does it hand to inventory — are no
 * easier to answer than they were before it was drawn.
 *
 * What a reader works with is one subject area at a time: the tables it is made
 * of, the relationships inside it, and the handful of lines that leave it. Small
 * enough to read at a legible zoom, and small enough to check.
 *
 * The areas are not invented from the shape of the graph. They are the boundary
 * the schema already declares — the file a table was written in, the schema or
 * package it was qualified with — so a frame around one is something the reader
 * can verify against the source. A declared area too small to be worth its own
 * diagram is folded into its parent directory; one so large that it is a poster
 * in its own right is divided by a namespace its tables already carry. Nothing
 * here is grouped by guesswork.
 */

/**
 * Tables one diagram holds and still reads. Roughly the size people who
 * maintain schema documentation for a living recommend per subject-area
 * diagram; past it the reader is panning rather than reading.
 */
export const AREA_ENTITY_TARGET = 30;

/** Prefix of the synthetic node standing for a whole area on the area map. */
export const AREA_NODE_PREFIX = 'repogram-area:';
/** Prefix of the synthetic node standing for a *neighbouring* area, inside one. */
export const AREA_LINK_PREFIX = 'repogram-area-link:';

/** Where entities land that declare no schema boundary at all. */
const UNSCOPED_KEY = 'Unscoped';

/** Node kinds a document store produces, as against a relational schema. */
const DOCUMENT_KINDS = new Set(['collection', 'embedded']);

/**
 * What to call the things in a diagram: a document store has collections, not
 * tables, and a reader told otherwise will look for a table that does not exist.
 * Decided by majority so a workspace holding both still gets one honest word.
 */
export function entityNoun(nodes: readonly DiagramNode[]): 'table' | 'collection' {
  let documents = 0;
  let relational = 0;
  for (const node of nodes) {
    if (DOCUMENT_KINDS.has(node.kind)) documents += 1;
    else if (node.kind !== 'unresolved-entity') relational += 1;
  }
  return documents > relational ? 'collection' : 'table';
}

/** `3 tables`, `1 collection` — the count with the right noun beside it. */
export function entityCountLabel(count: number, noun: 'table' | 'collection'): string {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

export interface AreaNeighbour {
  key: string;
  label: string;
  /** Relationships crossing between the two areas, in either direction. */
  count: number;
}

export interface SubjectArea {
  /** The declared grouping this area was formed from; stable across analyses. */
  key: string;
  /** What the frame is called: the schema file, package, or namespace. */
  label: string;
  /** The same boundary spelled out, so the label can be checked against source. */
  origin: string;
  nodeIds: string[];
  /** Names of the entities in the area, in the order they are drawn. */
  entityLabels: string[];
  /** Entities actually declared here. */
  entities: number;
  /** What the entities in this area are: tables, or a document store's collections. */
  noun: 'table' | 'collection';
  /** Relation targets referenced from here that no declaration was found for. */
  unresolved: number;
  /** Relationships with both ends inside the area. */
  internalRelations: number;
  /** Relationships with exactly one end inside it. */
  crossRelations: number;
  neighbours: AreaNeighbour[];
  source?: SourceRef;
  /** More tables than one diagram reads well at; see `AREA_ENTITY_TARGET`. */
  oversized: boolean;
}

export interface DatabaseMap {
  areas: SubjectArea[];
  /** Entity node id → the key of the area holding it. */
  areaOf: ReadonlyMap<string, string>;
  entities: number;
  /** What this schema's entities are called, across the whole graph. */
  noun: 'table' | 'collection';
  crossRelations: number;
  /**
   * Whether this schema is worth reading area by area. A schema that already
   * fits in one diagram is not improved by being cut into pieces, so the data
   * view only takes the reader's scope over when the whole thing would not fit
   * and there is more than one declared area to cut it along.
   */
  usesAreas: boolean;
}

export function buildDatabaseMap(graph: DiagramGraph): DatabaseMap {
  const declared = (node: DiagramNode): string => node.group ?? node.source?.file ?? UNSCOPED_KEY;
  // Areas are sized in tables. A placeholder standing for a relation target no
  // declaration was found for is a reference, not a table, and counting them
  // here would keep a one-table file from folding into the directory with it.
  const tables = graph.nodes.filter((node) => node.kind !== 'unresolved-entity');
  const keyOf = divideOversized(tables, coalesceGroups(tables, declared));

  const areaOf = new Map<string, string>();
  const members = new Map<string, DiagramNode[]>();
  const place = (node: DiagramNode, key: string): void => {
    areaOf.set(node.id, key);
    const existing = members.get(key);
    if (existing) existing.push(node);
    else members.set(key, [node]);
  };
  for (const node of tables) {
    place(node, keyOf(node) ?? UNSCOPED_KEY);
  }
  // An unresolved target belongs wherever it is referenced from, which the
  // edges say and its own (empty) declaration does not.
  const unresolved = graph.nodes.filter((node) => node.kind === 'unresolved-entity');
  if (unresolved.length) {
    const referrers = new Map<string, string>();
    for (const edge of graph.edges) {
      for (const [placeholder, referrer] of [[edge.to, edge.from], [edge.from, edge.to]] as const) {
        const key = areaOf.get(referrer);
        if (key !== undefined && !referrers.has(placeholder)) referrers.set(placeholder, key);
      }
    }
    for (const node of unresolved) {
      place(node, referrers.get(node.id) ?? (members.has(declared(node)) ? declared(node) : UNSCOPED_KEY));
    }
  }

  const internal = new Map<string, number>();
  /** area key → neighbouring area key → relationships between the two. */
  const between = new Map<string, Map<string, number>>();
  const link = (from: string, to: string): void => {
    const row = between.get(from) ?? new Map<string, number>();
    row.set(to, (row.get(to) ?? 0) + 1);
    between.set(from, row);
  };
  let crossRelations = 0;
  for (const edge of graph.edges) {
    const from = areaOf.get(edge.from);
    const to = areaOf.get(edge.to);
    if (from === undefined || to === undefined) continue;
    if (from === to) {
      internal.set(from, (internal.get(from) ?? 0) + 1);
      continue;
    }
    crossRelations += 1;
    link(from, to);
    link(to, from);
  }

  const labels = describeAreas([...members.keys()]);
  const areas: SubjectArea[] = [...members].map(([key, nodes]) => {
    const described = labels.get(key) ?? { label: key, origin: key };
    const neighbours: AreaNeighbour[] = [...(between.get(key) ?? new Map<string, number>())]
      .map(([other, count]) => ({ key: other, label: labels.get(other)?.label ?? other, count }))
      .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
    const declaredEntities = nodes.filter((node) => node.kind !== 'unresolved-entity');
    return {
      key,
      label: described.label,
      origin: described.origin,
      nodeIds: nodes.map((node) => node.id),
      entityLabels: nodes.map((node) => node.label),
      entities: declaredEntities.length,
      noun: entityNoun(nodes),
      unresolved: nodes.length - declaredEntities.length,
      internalRelations: internal.get(key) ?? 0,
      crossRelations: neighbours.reduce((total, neighbour) => total + neighbour.count, 0),
      neighbours,
      ...(nodes[0]?.source ? { source: nodes[0].source } : {}),
      oversized: declaredEntities.length > AREA_ENTITY_TARGET,
    };
  });
  // Busiest first: on a schema nobody has seen before, the area holding half the
  // tables is the one to open, and alphabetical order buries it.
  areas.sort((left, right) => right.entities - left.entities || left.label.localeCompare(right.label));

  const entities = graph.nodes.filter((node) => node.kind !== 'unresolved-entity').length;
  return {
    areas,
    areaOf,
    entities,
    noun: entityNoun(graph.nodes),
    crossRelations,
    usesAreas: areas.length >= 2 && entities > AREA_ENTITY_TARGET,
  };
}

/**
 * The map of the whole schema: one card per subject area, one line per pair of
 * areas carrying the number of relationships that cross between them.
 *
 * This is the diagram the huge ERD was meant to be. It fits on a screen, it says
 * where the schema's seams are, and every card on it opens into a diagram small
 * enough to read.
 */
export function areaOverviewGraph(databaseMap: DatabaseMap): DiagramGraph {
  const nodes: DiagramNode[] = databaseMap.areas.map((area) => ({
    id: AREA_NODE_PREFIX + area.key,
    kind: 'subject-area',
    label: area.label,
    subtitle: `${entityCountLabel(area.entities, area.noun)}`
      + ` · ${area.internalRelations} inside · ${area.crossRelations} leaving`,
    ...(area.source ? { source: area.source } : {}),
    confidence: 'exact' as const,
    metadata: {
      // Doubles as the area's table list in the details panel and as the text a
      // search runs over, so looking a table name up finds the area holding it.
      Tables: area.entityLabels,
      'Declared by': area.origin,
      'Relationships inside': String(area.internalRelations),
      'Relationships leaving': String(area.crossRelations),
      ...(area.unresolved ? { 'Unresolved targets': String(area.unresolved) } : {}),
    },
  }));

  const edges: DiagramEdge[] = [];
  const drawn = new Set<string>();
  for (const area of databaseMap.areas) {
    for (const neighbour of area.neighbours) {
      if (drawn.has(`${neighbour.key}\u0000${area.key}`)) continue;
      drawn.add(`${area.key}\u0000${neighbour.key}`);
      edges.push({
        id: `repogram-area-edge:${area.key}--${neighbour.key}`,
        from: AREA_NODE_PREFIX + area.key,
        to: AREA_NODE_PREFIX + neighbour.key,
        kind: 'area-relation',
        label: `${neighbour.count} ${neighbour.count === 1 ? 'relationship' : 'relationships'}`,
        confidence: 'exact',
        metadata: { Relationships: String(neighbour.count) },
      });
    }
  }

  return {
    kind: 'database',
    nodes,
    edges,
    emptyMessage: 'No supported database schemas or ORM entities were found in this workspace.',
  };
}

/**
 * One subject area, drawn on its own.
 *
 * Everything inside it is drawn as it always was. Everything outside it is not
 * drawn at all: the relationships that leave collapse onto one card per
 * neighbouring area, carrying the count and the tables on the far side. The
 * lines that remain are the ones a reader of this area has a reason to follow,
 * and the card at the end of a boundary line says where to go next.
 */
export function subjectAreaGraph(graph: DiagramGraph, databaseMap: DatabaseMap, key: string): DiagramGraph {
  const area = databaseMap.areas.find((candidate) => candidate.key === key);
  if (!area) {
    return {
      kind: 'database',
      nodes: [],
      edges: [],
      emptyMessage: 'That subject area is not in the current analysis. Pick another one.',
    };
  }
  const inside = new Set(area.nodeIds);
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const areaByKey = new Map(databaseMap.areas.map((candidate) => [candidate.key, candidate]));
  const nodes = graph.nodes.filter((node) => inside.has(node.id));
  const edges: DiagramEdge[] = [];

  interface Crossing {
    localId: string;
    otherKey: string;
    outgoing: boolean;
    edges: DiagramEdge[];
    farLabels: string[];
  }
  const crossings = new Map<string, Crossing>();
  /** Neighbouring area key → the tables on its side that this area touches. */
  const touched = new Map<string, string[]>();

  for (const edge of graph.edges) {
    const fromInside = inside.has(edge.from);
    const toInside = inside.has(edge.to);
    if (fromInside && toInside) {
      edges.push(edge);
      continue;
    }
    if (fromInside === toInside) continue;
    const localId = fromInside ? edge.from : edge.to;
    const farId = fromInside ? edge.to : edge.from;
    const otherKey = databaseMap.areaOf.get(farId);
    if (otherKey === undefined) continue;
    const farLabel = byId.get(farId)?.label ?? farId;
    const crossingKey = `${localId}\u0000${otherKey}\u0000${fromInside ? 'out' : 'in'}`;
    const existing = crossings.get(crossingKey);
    if (existing) {
      existing.edges.push(edge);
      if (!existing.farLabels.includes(farLabel)) existing.farLabels.push(farLabel);
    } else {
      crossings.set(crossingKey, {
        localId,
        otherKey,
        outgoing: fromInside,
        edges: [edge],
        farLabels: [farLabel],
      });
    }
    const far = touched.get(otherKey) ?? [];
    if (!far.includes(farLabel)) far.push(farLabel);
    touched.set(otherKey, far);
  }

  for (const [otherKey, farLabels] of [...touched].sort((left, right) => left[0].localeCompare(right[0]))) {
    const other = areaByKey.get(otherKey);
    const count = area.neighbours.find((neighbour) => neighbour.key === otherKey)?.count ?? farLabels.length;
    nodes.push({
      id: AREA_LINK_PREFIX + otherKey,
      kind: 'area-link',
      label: other?.label ?? otherKey,
      subtitle: `${count} ${count === 1 ? 'relationship' : 'relationships'} across the boundary`,
      ...(other?.source ? { source: other.source } : {}),
      confidence: 'exact',
      metadata: {
        'Subject area': other?.origin ?? otherKey,
        Relationships: String(count),
        Tables: [...farLabels].sort((left, right) => left.localeCompare(right)),
      },
    });
  }

  const ordered = [...crossings.values()].sort((left, right) =>
    left.localId.localeCompare(right.localId)
    || left.otherKey.localeCompare(right.otherKey)
    || Number(right.outgoing) - Number(left.outgoing));
  for (const crossing of ordered) {
    const first = crossing.edges[0];
    if (!first) continue;
    const linkId = AREA_LINK_PREFIX + crossing.otherKey;
    const count = crossing.edges.length;
    edges.push({
      id: `repogram-area-cross:${crossing.localId}--${crossing.otherKey}--${crossing.outgoing ? 'out' : 'in'}`,
      from: crossing.outgoing ? crossing.localId : linkId,
      to: crossing.outgoing ? linkId : crossing.localId,
      kind: 'area-boundary',
      label: count === 1 ? first.label ?? 'relationship' : `${count} relationships`,
      // A boundary line is only as certain as the least certain relationship
      // folded into it, so the weakest evidence sets what the line claims.
      confidence: crossing.edges.some((edge) => edge.confidence === 'unresolved') ? 'unresolved'
        : crossing.edges.some((edge) => edge.confidence === 'inferred') ? 'inferred'
          : 'exact',
      ...(first.source ? { source: first.source } : {}),
      metadata: {
        'Crosses into': areaByKey.get(crossing.otherKey)?.label ?? crossing.otherKey,
        // Kept so the local card still marks the column the relationship is
        // declared over, exactly as it would if the far table were on screen.
        'Local fields': unique(crossing.edges.flatMap((edge) => asArray(edge.metadata?.['Local fields']))),
        References: unique(crossing.edges.flatMap((edge) => asArray(edge.metadata?.References))),
        Tables: crossing.farLabels,
      },
    });
  }

  return {
    kind: 'database',
    nodes,
    edges,
    emptyMessage: 'This subject area has no entities left in the current analysis.',
  };
}

/** The area key a synthetic overview or boundary node stands for, if it is one. */
export function areaKeyOfNodeId(nodeId: string): string | undefined {
  if (nodeId.startsWith(AREA_NODE_PREFIX)) return nodeId.slice(AREA_NODE_PREFIX.length);
  if (nodeId.startsWith(AREA_LINK_PREFIX)) return nodeId.slice(AREA_LINK_PREFIX.length);
  return undefined;
}

/**
 * Divides an area that is still a poster after coalescing, using the namespace
 * its own tables were qualified with — a SQL schema, a JPA package, a Django app
 * label. Only when every table in the area carries one and they differ, so the
 * split is something the reader can read straight off the source rather than a
 * line drawn to make the picture fit.
 */
function divideOversized(
  nodes: readonly DiagramNode[],
  keyOf: (node: DiagramNode) => string | undefined,
): (node: DiagramNode) => string | undefined {
  const buckets = new Map<string, DiagramNode[]>();
  for (const node of nodes) {
    const key = keyOf(node);
    if (key === undefined) continue;
    const existing = buckets.get(key);
    if (existing) existing.push(node);
    else buckets.set(key, [node]);
  }
  const divided = new Set<string>();
  for (const [key, members] of buckets) {
    if (members.length <= AREA_ENTITY_TARGET) continue;
    const namespaces = new Set(members.map(namespaceOf));
    if (namespaces.has('') || namespaces.size < 2) continue;
    divided.add(key);
  }
  if (!divided.size) return keyOf;
  return (node) => {
    const key = keyOf(node);
    if (key === undefined || !divided.has(key)) return key;
    return `${key}#${namespaceOf(node)}`;
  };
}

function namespaceOf(node: DiagramNode): string {
  const value = node.metadata.Namespace;
  return typeof value === 'string' ? value : '';
}

/**
 * Names the areas, and makes sure no two are called the same thing.
 *
 * The analyzers key a schema boundary as `<Source>:<path>`, optionally with the
 * `#<namespace>` the divider added, so the obvious name is the file: `billing.sql`
 * says more on a card than `SQL:packages/db/billing.sql` does. But a migrations
 * directory is twenty files all called `migration.sql`, and three frames with
 * the same name on them is worse than a long name — a reader cannot tell which
 * one they are looking at. So each area takes the shortest name in its own path
 * that nothing else in this schema answers to.
 */
function describeAreas(keys: readonly string[]): Map<string, { label: string; origin: string }> {
  const candidates = new Map(keys.map((key) => [key, labelCandidates(key)] as const));
  const depth = new Map<string, number>(keys.map((key) => [key, 0]));
  const nameOf = (key: string): string => {
    const list = candidates.get(key) ?? [key];
    return list[Math.min(depth.get(key) ?? 0, list.length - 1)] ?? key;
  };
  for (let pass = 0; pass < 8; pass += 1) {
    const groups = new Map<string, string[]>();
    for (const key of keys) {
      const name = nameOf(key);
      groups.set(name, [...(groups.get(name) ?? []), key]);
    }
    let widened = false;
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      for (const key of group) {
        const room = (candidates.get(key)?.length ?? 1) - 1;
        const current = depth.get(key) ?? 0;
        if (current < room) {
          depth.set(key, current + 1);
          widened = true;
        }
      }
    }
    if (!widened) break;
  }
  return new Map(keys.map((key) => [key, { label: nameOf(key), origin: originOf(key) }] as const));
}

/**
 * The names an area could go by, shortest first: the file, the directory holding
 * it, then progressively more of the path. A namespace the divider split on
 * leads, because that is the name the tables themselves carry.
 */
function labelCandidates(key: string): string[] {
  const [scope, namespace] = splitOnce(key, '#');
  const [source, path] = splitOnce(scope, ':');
  if (path === undefined) {
    return [basename(scope), scope];
  }
  const segments = path.split('/').filter((part) => part.length > 0 && part !== '.');
  const paths = segments.length === 0
    ? [source]
    : [
      segments[segments.length - 1] ?? source,
      ...(segments.length > 1 ? [segments[segments.length - 2] ?? source] : []),
      ...segments.map((_unused, index) => segments.slice(segments.length - index - 1).join('/')).slice(1),
      scope,
    ];
  const unique = [...new Set(paths)];
  return namespace ? [namespace, ...unique.map((name) => `${name} · ${namespace}`)] : unique;
}

/** The boundary spelled out in full, which is what the card carries underneath. */
function originOf(key: string): string {
  const [scope, namespace] = splitOnce(key, '#');
  const [source, path] = splitOnce(scope, ':');
  if (path === undefined) return scope;
  const rooted = path === '' || path === '.';
  return [source, rooted ? '' : path, namespace ? `schema ${namespace}` : ''].filter(Boolean).join(' · ') || scope;
}

function splitOnce(value: string, separator: string): [string, string | undefined] {
  const index = value.indexOf(separator);
  return index < 0 ? [value, undefined] : [value.slice(0, index), value.slice(index + separator.length)];
}

function basename(path: string): string {
  const parts = path.split('/').filter((part) => part.length > 0 && part !== '.');
  return parts[parts.length - 1] ?? path;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function asArray(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value;
  return typeof value === 'string' && value ? [value] : [];
}
