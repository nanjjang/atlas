import assert from 'node:assert/strict';
import test from 'node:test';
import type { DiagramEdge, DiagramGraph, DiagramNode } from '../src/model';
import {
  AREA_ENTITY_TARGET,
  AREA_LINK_PREFIX,
  AREA_NODE_PREFIX,
  areaKeyOfNodeId,
  areaOverviewGraph,
  buildDatabaseMap,
  subjectAreaGraph,
} from '../src/subjectAreas';

const entity = (id: string, group: string, metadata: Record<string, string | string[]> = {}): DiagramNode => ({
  id,
  kind: 'entity',
  label: id,
  group,
  source: { file: group.split(':')[1] ?? group, line: 1 },
  confidence: 'exact',
  metadata,
});

const relation = (from: string, to: string, localField = `${to}_id`): DiagramEdge => ({
  id: `${from}->${to}`,
  from,
  to,
  kind: 'foreign-key',
  label: `foreign-key: ${localField} → id`,
  confidence: 'exact',
  metadata: { 'Local fields': [localField], References: ['id'] },
});

const graphOf = (nodes: DiagramNode[], edges: DiagramEdge[]): DiagramGraph => ({
  kind: 'database',
  nodes,
  edges,
  emptyMessage: 'nothing here',
});

/** `count` tables declared in one schema file, named `<prefix>0…`. */
const tables = (prefix: string, group: string, count: number, metadata?: (index: number) => Record<string, string>): DiagramNode[] =>
  Array.from({ length: count }, (_unused, index) => entity(`${prefix}${index}`, group, metadata?.(index) ?? {}));

const areaFor = (databaseMap: ReturnType<typeof buildDatabaseMap>, label: string) => {
  const area = databaseMap.areas.find((candidate) => candidate.label === label);
  assert.ok(area, `expected a subject area called ${label}`);
  return area;
};

test('each schema file becomes a subject area named after itself', () => {
  const databaseMap = buildDatabaseMap(graphOf(
    [
      entity('invoices', 'SQL:packages/db/billing.sql'),
      entity('payments', 'SQL:packages/db/billing.sql'),
      entity('users', 'SQL:packages/db/auth.sql'),
      entity('sessions', 'SQL:packages/db/auth.sql'),
    ],
    [relation('payments', 'invoices'), relation('sessions', 'users')],
  ));

  assert.deepEqual(databaseMap.areas.map((area) => area.label).sort(), ['auth.sql', 'billing.sql']);
  assert.equal(areaFor(databaseMap, 'billing.sql').origin, 'SQL · packages/db/billing.sql');
  assert.equal(databaseMap.areaOf.get('invoices'), 'SQL:packages/db/billing.sql');
});

test('a small schema is not cut up: it already fits in one diagram', () => {
  const databaseMap = buildDatabaseMap(graphOf(
    [entity('users', 'SQL:db/auth.sql'), entity('invoices', 'SQL:db/billing.sql')],
    [],
  ));

  assert.equal(databaseMap.areas.length, 2);
  assert.equal(databaseMap.usesAreas, false);
});

test('a schema past one diagram is read area by area', () => {
  const databaseMap = buildDatabaseMap(graphOf(
    [...tables('billing_', 'SQL:db/billing.sql', 20), ...tables('auth_', 'SQL:db/auth.sql', 20)],
    [],
  ));

  assert.equal(databaseMap.entities, 40);
  assert.equal(databaseMap.usesAreas, true);
});

test('relationships are counted as inside an area or as leaving it', () => {
  const databaseMap = buildDatabaseMap(graphOf(
    [
      entity('invoices', 'SQL:db/billing.sql'),
      entity('payments', 'SQL:db/billing.sql'),
      entity('users', 'SQL:db/auth.sql'),
    ],
    [
      relation('payments', 'invoices'),
      relation('invoices', 'users'),
      relation('payments', 'users'),
    ],
  ));

  const billing = areaFor(databaseMap, 'billing.sql');
  assert.equal(billing.internalRelations, 1);
  assert.equal(billing.crossRelations, 2);
  assert.deepEqual(billing.neighbours.map((neighbour) => [neighbour.label, neighbour.count]), [['auth.sql', 2]]);
  assert.equal(databaseMap.crossRelations, 2);
});

test('unresolved relation targets are counted apart from declared tables', () => {
  const placeholder: DiagramNode = {
    id: 'missing',
    kind: 'unresolved-entity',
    label: 'tenants',
    group: 'SQL:db/billing.sql',
    confidence: 'unresolved',
    metadata: {},
  };
  const databaseMap = buildDatabaseMap(graphOf(
    [entity('invoices', 'SQL:db/billing.sql'), placeholder],
    [relation('invoices', 'missing')],
  ));

  const billing = areaFor(databaseMap, 'billing.sql');
  assert.equal(billing.entities, 1);
  assert.equal(billing.unresolved, 1);
  assert.equal(databaseMap.entities, 1);
});

test('an area larger than one diagram says so', () => {
  const databaseMap = buildDatabaseMap(graphOf(
    [
      ...tables('billing_', 'SQL:db/billing.sql', AREA_ENTITY_TARGET + 1),
      ...tables('auth_', 'SQL:db/auth.sql', 5),
    ],
    [],
  ));

  assert.equal(areaFor(databaseMap, 'billing.sql').oversized, true);
  assert.equal(areaFor(databaseMap, 'auth.sql').oversized, false);
});

test('an oversized area is divided by a namespace its own tables declare', () => {
  const databaseMap = buildDatabaseMap(graphOf(
    tables('t', 'SQL:db/schema.sql', AREA_ENTITY_TARGET + 2, (index) => ({
      Namespace: index % 2 === 0 ? 'billing' : 'auth',
    })),
    [],
  ));

  assert.deepEqual(databaseMap.areas.map((area) => area.label).sort(), ['auth', 'billing']);
  assert.equal(areaFor(databaseMap, 'billing').origin, 'SQL · db/schema.sql · schema billing');
});

test('an oversized area with no declared namespace is left whole rather than guessed at', () => {
  const databaseMap = buildDatabaseMap(graphOf(
    [
      ...tables('t', 'SQL:db/schema.sql', AREA_ENTITY_TARGET + 2, (index): Record<string, string> => (
        index === 0 ? {} : { Namespace: index % 2 === 0 ? 'billing' : 'auth' }
      )),
      ...tables('auth_', 'SQL:db/auth.sql', 3),
    ],
    [],
  ));

  assert.equal(areaFor(databaseMap, 'schema.sql').entities, AREA_ENTITY_TARGET + 2);
  assert.equal(areaFor(databaseMap, 'schema.sql').oversized, true);
});

test('tiny sibling schema files fold into the directory holding them', () => {
  const databaseMap = buildDatabaseMap(graphOf(
    [
      entity('invoices', 'SQL:db/parts/billing.sql'),
      entity('users', 'SQL:db/parts/auth.sql'),
      entity('carts', 'SQL:db/parts/shop.sql'),
      ...tables('event_', 'SQL:db/events.sql', 6),
    ],
    [],
  ));

  assert.deepEqual(databaseMap.areas.map((area) => area.label).sort(), ['events.sql', 'parts']);
  assert.equal(areaFor(databaseMap, 'parts').entities, 3);
});

test('the area map draws one card per area and one line per boundary', () => {
  const databaseMap = buildDatabaseMap(graphOf(
    [
      entity('invoices', 'SQL:db/billing.sql'),
      entity('payments', 'SQL:db/billing.sql'),
      entity('users', 'SQL:db/auth.sql'),
    ],
    [relation('payments', 'invoices'), relation('invoices', 'users'), relation('payments', 'users')],
  ));
  const overview = areaOverviewGraph(databaseMap);

  assert.equal(overview.nodes.length, 2);
  assert.equal(overview.edges.length, 1);
  assert.equal(overview.edges[0]?.label, '2 relationships');
  const billing = overview.nodes.find((node) => node.label === 'billing.sql');
  assert.ok(billing);
  assert.equal(billing.kind, 'subject-area');
  assert.equal(billing.id, `${AREA_NODE_PREFIX}SQL:db/billing.sql`);
  assert.equal(areaKeyOfNodeId(billing.id), 'SQL:db/billing.sql');
  // The table names travel with the card so a search for one finds its area.
  assert.deepEqual(billing.metadata.Tables, ['invoices', 'payments']);
});

test('an area is drawn with its own tables and its own relationships', () => {
  const graph = graphOf(
    [
      entity('invoices', 'SQL:db/billing.sql'),
      entity('payments', 'SQL:db/billing.sql'),
      entity('users', 'SQL:db/auth.sql'),
    ],
    [relation('payments', 'invoices'), relation('invoices', 'users')],
  );
  const databaseMap = buildDatabaseMap(graph);
  const billing = subjectAreaGraph(graph, databaseMap, 'SQL:db/billing.sql');

  assert.deepEqual(
    billing.nodes.filter((node) => node.kind === 'entity').map((node) => node.label),
    ['invoices', 'payments'],
  );
  assert.ok(billing.edges.some((edge) => edge.id === 'payments->invoices'));
});

test('a relationship leaving the area ends on one card standing for the area it enters', () => {
  const graph = graphOf(
    [
      entity('invoices', 'SQL:db/billing.sql'),
      entity('payments', 'SQL:db/billing.sql'),
      entity('users', 'SQL:db/auth.sql'),
      entity('roles', 'SQL:db/auth.sql'),
    ],
    [
      relation('invoices', 'users', 'owner_id'),
      relation('invoices', 'roles', 'role_id'),
      relation('payments', 'users', 'payer_id'),
    ],
  );
  const databaseMap = buildDatabaseMap(graph);
  const billing = subjectAreaGraph(graph, databaseMap, 'SQL:db/billing.sql');

  const links = billing.nodes.filter((node) => node.kind === 'area-link');
  assert.equal(links.length, 1);
  const link = links[0];
  assert.ok(link);
  assert.equal(link.id, `${AREA_LINK_PREFIX}SQL:db/auth.sql`);
  assert.equal(link.label, 'auth.sql');
  assert.equal(link.subtitle, '3 relationships across the boundary');
  assert.deepEqual(link.metadata.Tables, ['roles', 'users']);

  // Three relationships leave, but only two lines: one per table that crosses.
  const boundary = billing.edges.filter((edge) => edge.kind === 'area-boundary');
  assert.equal(boundary.length, 2);
  const fromInvoices = boundary.find((edge) => edge.from === 'invoices');
  assert.ok(fromInvoices);
  assert.equal(fromInvoices.to, link.id);
  assert.equal(fromInvoices.label, '2 relationships');
  // The columns are kept so the card still marks its foreign keys with the far
  // table off screen.
  assert.deepEqual(fromInvoices.metadata?.['Local fields'], ['owner_id', 'role_id']);
});

test('a boundary line claims no more than the weakest relationship folded into it', () => {
  const inferred: DiagramEdge = { ...relation('invoices', 'users'), confidence: 'inferred' };
  const graph = graphOf(
    [
      entity('invoices', 'SQL:db/billing.sql'),
      entity('users', 'SQL:db/auth.sql'),
      entity('roles', 'SQL:db/auth.sql'),
    ],
    [inferred, { ...relation('invoices', 'roles'), id: 'invoices->roles' }],
  );
  const databaseMap = buildDatabaseMap(graph);
  const billing = subjectAreaGraph(graph, databaseMap, 'SQL:db/billing.sql');

  const boundary = billing.edges.find((edge) => edge.kind === 'area-boundary');
  assert.ok(boundary);
  assert.equal(boundary.confidence, 'inferred');
});

test('asking for an area that is no longer there says so instead of drawing nothing', () => {
  const graph = graphOf([entity('invoices', 'SQL:db/billing.sql')], []);
  const empty = subjectAreaGraph(graph, buildDatabaseMap(graph), 'SQL:db/gone.sql');

  assert.equal(empty.nodes.length, 0);
  assert.match(empty.emptyMessage, /not in the current analysis/);
});
