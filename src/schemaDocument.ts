import { parseFormattedField } from './databaseAnalyzer';
import type { DiagramEdge, DiagramGraph, DiagramNode, ProjectSnapshot } from './model';
import {
  AREA_ENTITY_TARGET,
  AREA_LINK_PREFIX,
  areaKeyOfNodeId,
  buildDatabaseMap,
  entityCountLabel,
  subjectAreaGraph,
  type DatabaseMap,
  type SubjectArea,
} from './subjectAreas';

/**
 * The schema, written out as a document.
 *
 * The reason a huge ERD gets printed and pinned to a wall is that there is
 * nowhere else for the knowledge to live. It is the wrong container: nobody
 * reads a wall, nobody searches one, and nobody can tell whether the one on the
 * wall still matches the database. What people actually use is a document they
 * can open beside the code, search for a column name in, and read a diff of when
 * the schema moves.
 *
 * So this writes Markdown, not an image: the subject areas and what crosses
 * between them, then every area with a small diagram and the full list of its
 * tables and columns. It is the same material the Data view draws, in the form
 * that survives being shared.
 */

/** Relationships past which the small area diagram drops its edge labels. */
const LABELLED_EDGE_LIMIT = 40;

export interface SchemaDocumentOptions {
  /** Written into the header so a stale copy can be recognised as one. */
  generatedAt?: string;
}

export function buildSchemaDocument(snapshot: ProjectSnapshot, options: SchemaDocumentOptions = {}): string {
  const graph = snapshot.database;
  const databaseMap = buildDatabaseMap(graph);
  const lines: string[] = [];

  lines.push(`# ${snapshot.projectName} — database schema`, '');
  lines.push(summaryLine(snapshot, databaseMap), '');
  lines.push(
    '> Read statically from the schema files and ORM declarations in this workspace by',
    '> [Codraw](https://github.com/nanjjang/codraw). No database was connected and no',
    '> project code was run, so this describes what the source declares, not what a',
    '> running database contains. Relationships the analyzer could not resolve are listed',
    '> at the end rather than guessed at.',
    '',
  );

  if (databaseMap.areas.length === 0) {
    lines.push(graph.emptyMessage, '');
    return lines.join('\n');
  }

  lines.push(...areaIndex(databaseMap));
  lines.push(...crossings(databaseMap));
  for (const area of databaseMap.areas) {
    lines.push(...areaSection(graph, databaseMap, area));
  }
  lines.push(...unresolvedSection(graph));
  lines.push(...notesSection(snapshot));

  const generatedAt = options.generatedAt ?? snapshot.generatedAt;
  if (generatedAt) {
    lines.push('---', '', `Generated ${generatedAt} · revision ${snapshot.revision}`, '');
  }
  return lines.join('\n');
}

function summaryLine(snapshot: ProjectSnapshot, databaseMap: DatabaseMap): string {
  return [
    entityCountLabel(databaseMap.entities, databaseMap.noun),
    `${snapshot.database.edges.length} relationships`,
    `${databaseMap.areas.length} subject ${databaseMap.areas.length === 1 ? 'area' : 'areas'}`,
    ...(databaseMap.crossRelations ? [`${databaseMap.crossRelations} crossing an area boundary`] : []),
  ].join(' · ');
}

function areaIndex(databaseMap: DatabaseMap): string[] {
  const lines = ['## Subject areas', ''];
  lines.push('| Area | Tables | Inside | Leaving | Declared by |');
  lines.push('| --- | ---: | ---: | ---: | --- |');
  for (const area of databaseMap.areas) {
    lines.push([
      '',
      `[${cell(area.label)}](#${anchor(area.label)})`,
      String(area.entities),
      String(area.internalRelations),
      String(area.crossRelations),
      `\`${cell(area.origin)}\``,
      '',
    ].join(' | ').trim());
  }
  lines.push('');
  return lines;
}

function crossings(databaseMap: DatabaseMap): string[] {
  const pairs: Array<{ left: SubjectArea; right: string; count: number }> = [];
  const drawn = new Set<string>();
  for (const area of databaseMap.areas) {
    for (const neighbour of area.neighbours) {
      if (drawn.has(`${neighbour.key}\u0000${area.key}`)) continue;
      drawn.add(`${area.key}\u0000${neighbour.key}`);
      pairs.push({ left: area, right: neighbour.label, count: neighbour.count });
    }
  }
  if (pairs.length === 0) {
    return [];
  }
  const lines = ['## Where the areas meet', ''];
  lines.push('| Area | Area | Relationships |');
  lines.push('| --- | --- | ---: |');
  for (const pair of pairs) {
    lines.push(`| ${cell(pair.left.label)} | ${cell(pair.right)} | ${pair.count} |`);
  }
  lines.push('');
  return lines;
}

function areaSection(graph: DiagramGraph, databaseMap: DatabaseMap, area: SubjectArea): string[] {
  const scoped = subjectAreaGraph(graph, databaseMap, area.key);
  const lines = [`## ${area.label}`, ''];
  lines.push(`\`${cell(area.origin)}\``, '');
  lines.push([
    entityCountLabel(area.entities, area.noun),
    `${area.internalRelations} relationships inside`,
    `${area.crossRelations} leaving`,
    ...(area.unresolved ? [`${area.unresolved} unresolved targets`] : []),
  ].join(' · '), '');

  if (area.oversized) {
    lines.push(
      `> This area holds more than ${AREA_ENTITY_TARGET} tables, which is more than one diagram`,
      '> reads well at, and the schema declares no finer boundary inside it. The table list',
      '> below is the part of this section to read; no diagram is drawn for it.',
      '',
    );
  } else {
    lines.push(...areaDiagram(scoped));
  }

  if (area.neighbours.length) {
    lines.push('Borders ' + area.neighbours
      .map((neighbour) => `**${cell(neighbour.label)}** (${neighbour.count})`)
      .join(', '), '');
  }

  lines.push(...tableList(scoped, area));
  return lines;
}

/**
 * A small diagram for one area, as Mermaid so it renders wherever the document
 * is read rather than being an image that has to be regenerated.
 *
 * A flowchart rather than an `erDiagram`: Mermaid's ER syntax makes every line
 * state a cardinality, and this analyzer does not always know one — a SQL
 * foreign key says which column points where, not how many rows do. What the
 * source did declare is written on the arrow instead.
 */
function areaDiagram(scoped: DiagramGraph): string[] {
  if (scoped.nodes.length === 0) {
    return [];
  }
  const ids = new Map(scoped.nodes.map((node, index) => [node.id, `n${index}`]));
  const labelled = scoped.edges.length <= LABELLED_EDGE_LIMIT;
  const lines = ['```mermaid', 'flowchart LR'];
  for (const node of scoped.nodes) {
    const id = ids.get(node.id) ?? node.id;
    // Three shapes, because three different things: a table that was declared,
    // a name a relationship points at that no declaration was found for, and
    // the card standing for a whole neighbouring area.
    if (node.id.startsWith(AREA_LINK_PREFIX)) {
      lines.push(`  ${id}(["${mermaid(node.label)} · ${mermaid(String(node.metadata.Relationships ?? ''))}"])`);
    } else if (node.kind === 'unresolved-entity') {
      lines.push(`  ${id}{{"${mermaid(node.label)} — not declared"}}`);
    } else {
      lines.push(`  ${id}["${mermaid(node.label)}"]`);
    }
  }
  for (const edge of scoped.edges) {
    const from = ids.get(edge.from);
    const to = ids.get(edge.to);
    if (!from || !to) continue;
    lines.push(labelled && edge.label
      ? `  ${from} -->|"${mermaid(edge.label)}"| ${to}`
      : `  ${from} --> ${to}`);
  }
  lines.push('```', '');
  return lines;
}

/** The data dictionary: every table in the area, its columns, its relationships. */
function tableList(scoped: DiagramGraph, area: SubjectArea): string[] {
  const lines: string[] = [];
  const byId = new Map(scoped.nodes.map((node) => [node.id, node]));
  const tables = scoped.nodes.filter((node) => node.kind !== 'area-link' && node.kind !== 'unresolved-entity');
  for (const table of tables) {
    lines.push(`### ${table.label}`, '');
    const facts = [
      ...(table.source ? [`\`${cell(table.source.file)}:${table.source.line}\``] : []),
      ...(physicalName(table) ? [`table \`${cell(physicalName(table))}\``] : []),
      ...(namespaceOf(table) ? [`schema \`${cell(namespaceOf(table))}\``] : []),
    ];
    if (facts.length) lines.push(facts.join(' · '), '');

    const fields = metadataArray(table, 'Fields');
    if (fields.length) {
      lines.push('| Column | Type | Notes |');
      lines.push('| --- | --- | --- |');
      for (const field of fields) {
        const parsed = parseFormattedField(field);
        const name = parsed.column ? `${parsed.name} → ${parsed.column}` : parsed.name;
        lines.push(`| ${cell(name)} | ${parsed.type ? `\`${cell(parsed.type)}\`` : ''} | ${cell(parsed.flags.join(', '))} |`);
      }
      lines.push('');
    } else {
      lines.push('No columns were read from this declaration.', '');
    }

    const relations = scoped.edges
      .filter((edge) => edge.from === table.id || edge.to === table.id)
      .map((edge) => describeRelation(edge, table.id, byId))
      .filter((text): text is string => text !== undefined);
    if (relations.length) {
      lines.push(...relations.map((text) => `- ${text}`), '');
    }
  }

  // By name: the same missing table referenced from two schema files is two
  // placeholder nodes, and naming it twice in one sentence says nothing extra.
  const missing = [...new Set(scoped.nodes
    .filter((node) => node.kind === 'unresolved-entity')
    .map((node) => node.label))].sort((left, right) => left.localeCompare(right));
  if (missing.length) {
    lines.push(
      'Referenced from this area but not declared anywhere the analyzer read: '
      + missing.map((label) => `\`${cell(label)}\``).join(', '),
      '',
    );
  }
  if (tables.length === 0 && missing.length === 0) {
    lines.push(`No tables remain in ${cell(area.label)}.`, '');
  }
  return lines;
}

function describeRelation(edge: DiagramEdge, tableId: string, byId: ReadonlyMap<string, DiagramNode>): string | undefined {
  const incoming = edge.to === tableId;
  const other = byId.get(incoming ? edge.from : edge.to);
  if (!other) return undefined;
  const arrow = incoming ? '←' : '→';
  const name = areaKeyOfNodeId(other.id) !== undefined ? `${other.label} (subject area)` : other.label;
  const confidence = edge.confidence === 'exact' ? '' : ` _(${edge.confidence})_`;
  return `${arrow} **${cell(name)}**${edge.label ? ` · ${cell(edge.label)}` : ''}${confidence}`;
}

function unresolvedSection(graph: DiagramGraph): string[] {
  const missing = graph.nodes.filter((node) => node.kind === 'unresolved-entity');
  if (missing.length === 0) {
    return [];
  }
  const lines = ['## Unresolved relationship targets', ''];
  lines.push(
    'Relationships in the source point at these names, and no declaration matching them was',
    'found in the files that were read. They are reported rather than invented: the table may',
    'live outside this workspace, or be named in a way the analyzer does not resolve.',
    '',
  );
  for (const node of [...missing].sort((left, right) => left.label.localeCompare(right.label))) {
    const from = node.metadata['Referenced from'];
    lines.push(`- \`${cell(node.label)}\`${typeof from === 'string' && from ? ` — referenced from \`${cell(from)}\`` : ''}`);
  }
  lines.push('');
  return lines;
}

function notesSection(snapshot: ProjectSnapshot): string[] {
  const notes = snapshot.diagnostics.filter((diagnostic) => diagnostic.code.startsWith('DB_'));
  if (notes.length === 0) {
    return [];
  }
  const lines = ['## Analysis notes', ''];
  for (const note of notes) {
    const where = note.source ? ` (\`${cell(note.source.file)}:${note.source.line}\`)` : '';
    lines.push(`- \`${note.code}\` ${cell(note.message)}${where}`);
  }
  lines.push('');
  return lines;
}

function physicalName(node: DiagramNode): string {
  const value = node.metadata['Physical name'];
  return typeof value === 'string' && value !== node.label ? value : '';
}

function namespaceOf(node: DiagramNode): string {
  const value = node.metadata.Namespace;
  return typeof value === 'string' ? value : '';
}

function metadataArray(node: DiagramNode, key: string): string[] {
  const value = node.metadata[key];
  if (Array.isArray(value)) return value;
  return typeof value === 'string' && value ? [value] : [];
}

/** A value safe to drop into a Markdown table cell. */
function cell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll(/\s*\n\s*/g, ' ').trim();
}

/** A label safe inside a Mermaid quoted string. */
function mermaid(value: string): string {
  return value.replaceAll('"', "'").replaceAll(/[\n\r]+/g, ' ').trim();
}

/** GitHub's heading anchor, so the index links land on the area sections. */
function anchor(label: string): string {
  return label
    .toLowerCase()
    .replaceAll(/[^\w\- ]+/g, '')
    .replaceAll(' ', '-');
}
