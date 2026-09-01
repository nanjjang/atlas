import assert from 'node:assert/strict';
import test from 'node:test';
import { parseFormattedField } from '../src/databaseAnalyzer';
import type { DiagramEdge, DiagramNode, ProjectSnapshot } from '../src/model';
import { buildSchemaDocument } from '../src/schemaDocument';
import { AREA_ENTITY_TARGET } from '../src/subjectAreas';

const entity = (id: string, group: string, fields: string[] = [], extra: Record<string, string | string[]> = {}): DiagramNode => ({
  id,
  kind: 'entity',
  label: id,
  group,
  source: { file: group.split(':')[1] ?? group, line: 1 },
  confidence: 'exact',
  metadata: { Fields: fields, ...extra },
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

const snapshotOf = (nodes: DiagramNode[], edges: DiagramEdge[], overrides: Partial<ProjectSnapshot> = {}): ProjectSnapshot => ({
  schemaVersion: 1,
  revision: 7,
  projectName: 'shop',
  generatedAt: '2026-08-31T00:00:00.000Z',
  technologies: [],
  projectRoots: [],
  stats: {
    files: 0,
    codeFiles: 0,
    modules: 0,
    dependencies: 0,
    flowUnits: 0,
    databaseEntities: nodes.length,
    databaseRelations: edges.length,
    protocols: 0,
    endpoints: 0,
    ports: 0,
  },
  architecture: { kind: 'architecture', nodes: [], edges: [], emptyMessage: '' },
  structure: { id: 'root', label: 'shop', path: '', kind: 'folder', children: [] },
  flow: { units: [], emptyMessage: '' },
  database: { kind: 'database', nodes, edges, emptyMessage: 'No supported database schemas were found.' },
  interfaces: { surfaces: [], ports: [], emptyMessage: '' },
  diagnostics: [],
  ...overrides,
});

const tables = (prefix: string, group: string, count: number): DiagramNode[] =>
  Array.from({ length: count }, (_unused, index) => entity(`${prefix}${index}`, group));

test('the document opens with what it is and what it is not', () => {
  const document = buildSchemaDocument(snapshotOf(
    [entity('invoices', 'SQL:db/billing.sql'), entity('users', 'SQL:db/auth.sql')],
    [],
  ));

  assert.match(document, /^# shop — database schema/);
  assert.match(document, /2 tables · 0 relationships · 2 subject areas/);
  assert.match(document, /No database was connected/);
  assert.match(document, /Generated 2026-08-31T00:00:00\.000Z · revision 7/);
});

test('the subject areas are indexed with their counts and their declared origin', () => {
  const document = buildSchemaDocument(snapshotOf(
    [
      entity('invoices', 'SQL:db/billing.sql'),
      entity('payments', 'SQL:db/billing.sql'),
      entity('users', 'SQL:db/auth.sql'),
    ],
    [relation('payments', 'invoices'), relation('invoices', 'users')],
  ));

  assert.match(document, /\| \[billing\.sql\]\(#billingsql\) \| 2 \| 1 \| 1 \| `SQL · db\/billing\.sql` \|/);
  assert.match(document, /## Where the areas meet/);
  assert.match(document, /\| billing\.sql \| auth\.sql \| 1 \|/);
});

test('an area with no boundary crossings gets no "where the areas meet" table', () => {
  const document = buildSchemaDocument(snapshotOf(
    [entity('invoices', 'SQL:db/billing.sql'), entity('users', 'SQL:db/auth.sql')],
    [],
  ));

  assert.equal(document.includes('## Where the areas meet'), false);
});

test('a table is written out as a column table and a list of its relationships', () => {
  const document = buildSchemaDocument(snapshotOf(
    [
      entity('invoices', 'SQL:db/billing.sql', [
        'id: uuid [PK, NOT NULL]',
        'ownerId -> owner_id: uuid [NOT NULL]',
      ], { 'Physical name': 'billing_invoices', Namespace: 'billing' }),
      entity('users', 'SQL:db/billing.sql', ['id: uuid [PK]']),
    ],
    [relation('invoices', 'users', 'owner_id')],
  ));

  assert.match(document, /### invoices/);
  assert.match(document, /`db\/billing\.sql:1` · table `billing_invoices` · schema `billing`/);
  assert.match(document, /\| id \| `uuid` \| PK, NOT NULL \|/);
  assert.match(document, /\| ownerId → owner_id \| `uuid` \| NOT NULL \|/);
  assert.match(document, /- → \*\*users\*\* · foreign-key: owner_id → id/);
  assert.match(document, /- ← \*\*invoices\*\* · foreign-key: owner_id → id/);
});

test('a small area gets a diagram; one too big to read gets the table list and a reason', () => {
  const small = buildSchemaDocument(snapshotOf(
    [entity('invoices', 'SQL:db/billing.sql'), entity('payments', 'SQL:db/billing.sql')],
    [relation('payments', 'invoices')],
  ));
  assert.match(small, /```mermaid\nflowchart LR/);
  assert.match(small, /-->\|"foreign-key: invoices_id → id"\|/);

  const huge = buildSchemaDocument(snapshotOf(
    [...tables('t', 'SQL:db/big.sql', AREA_ENTITY_TARGET + 1), ...tables('a', 'SQL:db/small.sql', 5)],
    [],
  ));
  const bigSection = huge.slice(huge.indexOf('## big.sql'), huge.indexOf('## small.sql'));
  assert.equal(bigSection.includes('```mermaid'), false);
  assert.match(bigSection, new RegExp(`more than ${AREA_ENTITY_TARGET} tables`));
});

test('an unresolved target is drawn and named as one, never as a table', () => {
  const placeholder: DiagramNode = {
    id: 'missing',
    kind: 'unresolved-entity',
    label: 'tenants',
    group: 'SQL:db/billing.sql',
    confidence: 'unresolved',
    metadata: { 'Referenced from': 'db/billing.sql' },
  };
  const document = buildSchemaDocument(snapshotOf(
    [entity('invoices', 'SQL:db/billing.sql'), entity('payments', 'SQL:db/billing.sql'), placeholder],
    [{ ...relation('invoices', 'missing', 'tenant_id'), confidence: 'unresolved' }],
  ));

  assert.match(document, /\{\{"tenants — not declared"\}\}/);
  assert.equal(document.includes('### tenants'), false);
  assert.match(document, /Referenced from this area but not declared anywhere the analyzer read: `tenants`/);
  assert.match(document, /## Unresolved relationship targets/);
  assert.match(document, /- `tenants` — referenced from `db\/billing\.sql`/);
  assert.match(document, /_\(unresolved\)_/);
});

test('a schema with nothing in it says so instead of printing empty headings', () => {
  const document = buildSchemaDocument(snapshotOf([], []));

  assert.match(document, /No supported database schemas were found\./);
  assert.equal(document.includes('## Subject areas'), false);
});

test('a value carrying a table separator or a quote cannot break the cell it sits in', () => {
  const document = buildSchemaDocument(snapshotOf(
    [
      entity('settings', 'SQL:db/app.sql', ['mode: "light" | "dark" [NOT NULL]']),
      entity('users', 'SQL:db/app.sql'),
    ],
    [],
  ));

  assert.match(document, /\| mode \| `"light" \\\| "dark"` \|/);
  // Nothing inside a Mermaid label may be a double quote, which would end it.
  const diagram = document.slice(document.indexOf('```mermaid'), document.indexOf('```', document.indexOf('```mermaid') + 3));
  for (const line of diagram.split('\n').slice(2)) {
    assert.ok((line.match(/"/g)?.length ?? 0) % 2 === 0, `unbalanced quotes in ${line}`);
  }
});

test('the field parser is the inverse of the string the analyzer writes', () => {
  assert.deepEqual(parseFormattedField('id: uuid [PK, NOT NULL]'), {
    name: 'id',
    type: 'uuid',
    flags: ['PK', 'NOT NULL'],
  });
  assert.deepEqual(parseFormattedField('ownerId -> owner_id: String? (Uuid)'), {
    name: 'ownerId',
    column: 'owner_id',
    type: 'String? (Uuid)',
    flags: [],
  });
  // Total: anything it does not recognise keeps its text rather than vanishing.
  assert.deepEqual(parseFormattedField('a bare name'), { name: 'a bare name', type: '', flags: [] });
});
