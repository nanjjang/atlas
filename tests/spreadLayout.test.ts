import assert from 'node:assert/strict';
import test from 'node:test';
import { layoutGraph, type LayoutNode, type LayoutResult } from '../src/graphLayout';
import type { DiagramEdge, DiagramNode } from '../src/model';

const node = (id: string): DiagramNode => ({ id, kind: 'table', label: id, metadata: {} });

const edge = (from: string, to: string): DiagramEdge => ({
  id: `${from}->${to}`,
  from,
  to,
  kind: 'foreign-key',
  confidence: 'exact',
});

const layout = (
  nodes: readonly DiagramNode[],
  edges: readonly DiagramEdge[],
  overrides: { flow?: 'flow' | 'spread' | 'auto'; viewportWidth?: number; viewportHeight?: number } = {},
): LayoutResult =>
  layoutGraph(nodes, edges, {
    viewportWidth: overrides.viewportWidth ?? 1400,
    viewportHeight: overrides.viewportHeight ?? 860,
    fitPadding: 64,
    maxScale: 1.25,
    measure: () => ({ width: 210, minWidth: 170, height: 46 }),
    ...(overrides.flow ? { flow: overrides.flow } : {}),
  });

const at = (result: LayoutResult, id: string): LayoutNode => {
  const positioned = result.nodeById.get(id);
  assert.ok(positioned, `${id} must be placed`);
  return positioned;
};

const centre = (positioned: LayoutNode): { x: number; y: number } => ({
  x: positioned.x + positioned.width / 2,
  y: positioned.y + positioned.height / 2,
});

const assertNoOverlaps = (result: LayoutResult): void => {
  for (let left = 0; left < result.nodes.length; left += 1) {
    for (let right = left + 1; right < result.nodes.length; right += 1) {
      const one = result.nodes[left];
      const other = result.nodes[right];
      assert.ok(one && other);
      const apart = one.x >= other.x + other.width
        || other.x >= one.x + one.width
        || one.y >= other.y + other.height
        || other.y >= one.y + one.height;
      assert.ok(apart, `${one.node.id} overlaps ${other.node.id}`);
    }
  }
};

/** Mean distance an edge covers, measured over its routed path. */
const meanEdgeLength = (result: LayoutResult, edges: readonly DiagramEdge[]): number => {
  let total = 0;
  let counted = 0;
  for (const link of edges) {
    const from = result.nodeById.get(link.from);
    const to = result.nodeById.get(link.to);
    if (!from || !to) {
      continue;
    }
    const points = [centre(from), ...(result.bends.get(link.id) ?? []), centre(to)];
    for (let index = 0; index + 1 < points.length; index += 1) {
      const one = points[index];
      const next = points[index + 1];
      if (one && next) {
        total += Math.hypot(next.x - one.x, next.y - one.y);
      }
    }
    counted += 1;
  }
  return counted ? total / counted : 0;
};

/** A schema shaped the way real ones are: a few tables everything references. */
function hubbedSchema(tables: number): { nodes: DiagramNode[]; edges: DiagramEdge[] } {
  const nodes = ['tenants', 'users', ...Array.from({ length: tables }, (_, index) => `t${index}`)].map(node);
  const edges: DiagramEdge[] = [];
  for (let index = 0; index < tables; index += 1) {
    edges.push(edge(`t${index}`, 'tenants'));
    if (index % 2 === 0) {
      edges.push(edge(`t${index}`, 'users'));
    }
    if (index % 3 === 0 && index + 1 < tables) {
      edges.push(edge(`t${index}`, `t${index + 1}`));
    }
  }
  return { nodes, edges };
}

test('a graph with a hub everything references is spread, not ranked', () => {
  const { nodes, edges } = hubbedSchema(60);
  assert.equal(layout(nodes, edges).flow, 'spread');
});

test('a handful of modules keeps its columns', () => {
  const nodes = ['a', 'b', 'c', 'd', 'e'].map(node);
  const edges = [edge('a', 'b'), edge('b', 'c'), edge('c', 'd'), edge('d', 'e')];
  assert.equal(layout(nodes, edges).flow, 'flow');
});

test('a long sparse chain keeps its columns however many links it has', () => {
  const nodes = Array.from({ length: 40 }, (_, index) => node(`n${index}`));
  const edges = nodes.slice(1).map((target, index) => edge(`n${index}`, target.id));
  assert.equal(layout(nodes, edges).flow, 'flow');
});

test('spreading keeps hub edges bounded while reserving clear routing channels', () => {
  const { nodes, edges } = hubbedSchema(80);
  const ranked = meanEdgeLength(layout(nodes, edges, { flow: 'flow' }), edges);
  const spread = meanEdgeLength(layout(nodes, edges, { flow: 'spread' }), edges);
  assert.ok(
    spread < ranked * 1.2,
    // The overview collapses boundary-crossing member edges into section
    // summaries. Raw centre distance may rise a little because the layout now
    // keeps real lanes between sections, but it must remain bounded.
    `the roomy map stretched hub edges too far: ranked ${Math.round(ranked)}px, spread ${Math.round(spread)}px`,
  );
});

test('a spread graph spends space on lanes without becoming unbounded', () => {
  // Empty space is now deliberate: it is where labels and orthogonal routes
  // remain readable. Keep a generous ceiling so a regression cannot turn the
  // diagram into an arbitrarily sparse force field.
  const { nodes, edges } = hubbedSchema(80);
  const result = layout(nodes, edges, { flow: 'spread' });
  const boxes = result.nodes.reduce((total, positioned) => total + positioned.width * positioned.height, 0);
  const canvas = (result.maxX - result.minX) * (result.maxY - result.minY);
  assert.ok(canvas / boxes < 18, `the drawing is ${(canvas / boxes).toFixed(1)}x the area of its own nodes`);
});

test('a spread graph is packed to the shape of the canvas rather than into a strip', () => {
  // What a strip actually costs is zoom: `fit` scales to whichever side runs
  // out first, so both things are checked here — that the arrangement is near
  // the canvas's own shape, and that it is one `fit` can still open at a
  // useful size. The shape is measured against the canvas rather than against
  // a square, because the canvas is not a square either.
  const { nodes, edges } = hubbedSchema(80);
  const result = layout(nodes, edges, { flow: 'spread' });
  const width = result.maxX - result.minX;
  const height = result.maxY - result.minY;
  const ratio = (width / height) / (1400 / 860);
  assert.ok(
    ratio > 1 / 2.2 && ratio < 2.2,
    `the drawing came out ${ratio.toFixed(2)} times the canvas's own shape`,
  );
  const fit = Math.min((1400 - 64) / width, (860 - 64) / height);
  assert.ok(fit > 0.4, `fit could only open the drawing at ${fit.toFixed(3)}`);
});

test('nodes never overlap once they have been spread', () => {
  const { nodes, edges } = hubbedSchema(70);
  const result = layout(nodes, edges, { flow: 'spread' });
  assert.equal(result.nodes.length, nodes.length);
  assertNoOverlaps(result);
});

test('a spread graph still fits a viewport far too small for it', () => {
  const { nodes, edges } = hubbedSchema(70);
  const result = layout(nodes, edges, { flow: 'spread', viewportWidth: 380, viewportHeight: 260 });
  assert.equal(result.nodes.length, nodes.length);
  assertNoOverlaps(result);
});

test('the same graph is always spread the same way', () => {
  const { nodes, edges } = hubbedSchema(40);
  const first = layout(nodes, edges, { flow: 'spread' });
  const shuffled = [...nodes].reverse();
  const second = layout(shuffled, [...edges].reverse(), { flow: 'spread' });
  for (const positioned of first.nodes) {
    const other = at(second, positioned.node.id);
    assert.ok(
      Math.abs(positioned.x - other.x) < 0.001 && Math.abs(positioned.y - other.y) < 0.001,
      `${positioned.node.id} moved when the input order changed`,
    );
  }
});

test('a node with no relationships is still placed, clear of the rest', () => {
  const { nodes, edges } = hubbedSchema(30);
  const result = layout([...nodes, node('orphan')], edges, { flow: 'spread' });
  assert.ok(result.nodeById.has('orphan'));
  assertNoOverlaps(result);
});

test('spreading an empty graph does not throw', () => {
  const result = layout([], [], { flow: 'spread' });
  assert.deepEqual(result.nodes, []);
});

/** A graph with real neighbourhoods: families that reference each other. */
function familiedSchema(families: number, perFamily: number): { nodes: DiagramNode[]; edges: DiagramEdge[] } {
  const nodes: DiagramNode[] = [node('tenants')];
  const edges: DiagramEdge[] = [];
  for (let family = 0; family < families; family += 1) {
    for (let member = 0; member < perFamily; member += 1) {
      const id = `f${family}m${member}`;
      nodes.push(node(id));
      edges.push(edge(id, 'tenants'));
      if (member > 0) {
        edges.push(edge(`f${family}m${member - 1}`, id));
      }
      if (member > 1) {
        edges.push(edge(`f${family}m0`, id));
      }
    }
  }
  return { nodes, edges };
}

test('a spread graph is laid out as groups, not as a field of boxes', () => {
  const { nodes, edges } = familiedSchema(5, 8);
  const result = layout(nodes, edges, { flow: 'spread' });
  assert.ok(result.groups.length >= 2, `expected several groups, got ${result.groups.length}`);
  assert.equal(
    result.groups.reduce((total, group) => total + group.count, 0),
    nodes.length,
    'every node belongs to exactly one group',
  );
});

test('one group never overlaps another', () => {
  const { nodes, edges } = familiedSchema(6, 7);
  const { groups } = layout(nodes, edges, { flow: 'spread' });
  for (let left = 0; left < groups.length; left += 1) {
    for (let right = left + 1; right < groups.length; right += 1) {
      const one = groups[left];
      const other = groups[right];
      assert.ok(one && other);
      const apart = one.x >= other.x + other.width - 0.001
        || other.x >= one.x + one.width - 0.001
        || one.y >= other.y + other.height - 0.001
        || other.y >= one.y + one.height - 0.001;
      assert.ok(apart, `${one.label} overlaps ${other.label}`);
    }
  }
});

test('every node is drawn inside the frame that names it', () => {
  const { nodes, edges } = familiedSchema(5, 8);
  const result = layout(nodes, edges, { flow: 'spread' });
  for (const positioned of result.nodes) {
    const holder = result.groups.find((group) =>
      positioned.x >= group.x - 0.001
      && positioned.y >= group.y - 0.001
      && positioned.x + positioned.width <= group.x + group.width + 0.001
      && positioned.y + positioned.height <= group.y + group.height + 0.001);
    assert.ok(holder, `${positioned.node.id} sits outside every group frame`);
  }
});

test('relationships inside a section run left to right through wide lanes', () => {
  const nodes = Array.from({ length: 8 }, (_, index) => ({ ...node(`step-${index}`), group: 'workflow' }));
  const edges = nodes.slice(1).map((current, index) => edge(`step-${index}`, current.id));
  const result = layoutGraph(nodes, edges, {
    viewportWidth: 1400,
    viewportHeight: 860,
    fitPadding: 64,
    maxScale: 1.25,
    measure: () => ({ width: 210, minWidth: 170, height: 46 }),
    flow: 'spread',
    groupOf: (candidate) => candidate.group,
  });

  for (const link of edges) {
    const from = at(result, link.from);
    const to = at(result, link.to);
    assert.ok(to.x - (from.x + from.width) >= 200, `${link.id} has no readable horizontal lane`);
  }
});

test('a section is built around its hub, with its peers to either side', () => {
  const nodes = ['left', 'middle', 'right', 'root'].map((id) => ({ ...node(id), group: 'workflow' }));
  const edges = ['left', 'middle', 'right'].map((id) => edge(id, 'root'));
  const result = layoutGraph(nodes, edges, {
    viewportWidth: 1400,
    viewportHeight: 860,
    fitPadding: 64,
    maxScale: 1.25,
    measure: () => ({ width: 210, minWidth: 170, height: 46 }),
    flow: 'spread',
    groupOf: (candidate) => candidate.group,
  });
  const hub = centre(at(result, 'root')).x;
  const peers = ['left', 'middle', 'right'].map((id) => at(result, id));
  // Stacked in one column beside the hub, each of these relationships is the
  // same horizontal line at a different height. Split either side of it they
  // point inwards, and the card the section is about is the one in the middle.
  assert.ok(peers.some((peer) => centre(peer).x < hub), 'no peer was placed before the hub');
  assert.ok(peers.some((peer) => centre(peer).x > hub), 'no peer was placed after the hub');

  for (const side of [-1, 1]) {
    const column = peers
      .filter((peer) => Math.sign(centre(peer).x - hub) === side)
      .sort((one, other) => one.y - other.y);
    for (let index = 1; index < column.length; index += 1) {
      const previous = column[index - 1];
      const current = column[index];
      assert.ok(previous && current);
      assert.ok(
        current.y - (previous.y + previous.height) >= 30,
        'peers sharing a side are packed too tightly to tell apart',
      );
    }
  }
});

test('a handful of strays is folded in rather than framed on its own', () => {
  const { nodes, edges } = familiedSchema(5, 8);
  const { groups } = layout(nodes, edges, { flow: 'spread' });
  // One pair in a frame of its own is chrome, not a grouping.
  const tiny = groups.filter((group) => group.count < 3);
  assert.ok(tiny.length <= 1, `${tiny.length} groups came out too small to be worth a frame`);
});

test('a group is named after the node it is built around', () => {
  const { nodes, edges } = familiedSchema(4, 9);
  const { groups, nodes: placed } = layout(nodes, edges, { flow: 'spread' });
  const labels = new Set(placed.map((positioned) => positioned.node.label));
  for (const group of groups) {
    assert.ok(labels.has(group.label), `${group.label} is not one of the nodes`);
  }
});

test('a ranked graph reports no groups, having found none', () => {
  const nodes = ['a', 'b', 'c', 'd', 'e'].map(node);
  const result = layout(nodes, [edge('a', 'b'), edge('b', 'c'), edge('c', 'd'), edge('d', 'e')]);
  assert.equal(result.flow, 'flow');
  assert.deepEqual(result.groups, []);
});

/** The same graph, but with each node declaring the file it came from. */
function declaredSchema(): { nodes: DiagramNode[]; edges: DiagramEdge[] } {
  const files = ['billing', 'auth', 'chat'];
  const nodes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];
  for (const [index, file] of files.entries()) {
    for (let member = 0; member < 9; member += 1) {
      const id = `${file}_${member}`;
      nodes.push({
        ...node(id),
        source: { file: `packages/db/${file}.sql`, line: member + 1 },
      });
      // A foreign key usually points inside its own file, and one does not.
      if (member > 0) {
        edges.push(edge(id, `${file}_${member - 1}`));
      }
      if (member === 0 && index > 0) {
        edges.push(edge(id, `${files[index - 1] ?? ''}_0`));
      }
    }
  }
  return { nodes, edges };
}

test('a declared grouping is used in place of one read off the edges', () => {
  const { nodes, edges } = declaredSchema();
  const result = layoutGraph(nodes, edges, {
    viewportWidth: 1400,
    viewportHeight: 860,
    fitPadding: 64,
    maxScale: 1.25,
    measure: () => ({ width: 210, minWidth: 170, height: 46 }),
    flow: 'spread',
    groupOf: (candidate) => candidate.source?.file,
  });

  assert.deepEqual(
    result.groups.map((group) => group.label).sort(),
    ['auth.sql', 'billing.sql', 'chat.sql'],
    'the frames must be named after the files the tables were declared in',
  );
  for (const group of result.groups) {
    assert.equal(group.count, 9);
    assert.ok(group.detail?.startsWith('packages/db/'), 'the whole path is kept for the tooltip');
  }
});

test('entities whose keys reach into two other areas are framed in a centre of their own', () => {
  const areas = ['orders', 'catalog', 'inventory', 'support', 'analytics', 'users'];
  const nodes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];
  for (const area of areas) {
    for (let member = 0; member < 4; member += 1) {
      nodes.push({ ...node(`${area}_${member}`), group: area });
      if (member > 0) {
        edges.push(edge(`${area}_${member}`, `${area}_${member - 1}`));
      }
    }
  }
  // Two tables that between them tie all six areas into one graph, each reaching
  // into three areas other than its own; every target takes just one of these
  // keys, so no other table crosses more than a single boundary.
  nodes.push({ ...node('bridge_a'), group: 'orders' });
  nodes.push({ ...node('bridge_b'), group: 'catalog' });
  edges.push(edge('bridge_a', 'inventory_1'), edge('bridge_a', 'support_1'), edge('bridge_a', 'analytics_1'));
  edges.push(edge('bridge_b', 'analytics_2'), edge('bridge_b', 'users_1'), edge('bridge_b', 'support_2'));

  const result = layoutGraph(nodes, edges, {
    viewportWidth: 1400,
    viewportHeight: 860,
    fitPadding: 64,
    maxScale: 1.25,
    measure: () => ({ width: 210, minWidth: 170, height: 46 }),
    flow: 'spread',
    groupOf: (candidate) => candidate.group,
  });

  const core = result.groups.find((group) => group.label === 'Integration Core');
  assert.ok(core, 'the cross-area entities must be gathered into an Integration Core frame');
  assert.deepEqual(new Set(core.nodeIds), new Set(['bridge_a', 'bridge_b']));

  // Every other table still sits in the frame named after its own area.
  for (const candidate of nodes) {
    if (candidate.id.startsWith('bridge_')) {
      continue;
    }
    const home = result.groups.find((group) => group.nodeIds.includes(candidate.id));
    assert.equal(home?.label, candidate.group, `${candidate.id} left its own area`);
  }

  // The core sits inside the ring, not out on an edge of it.
  const ring = result.groups.filter((group) => group !== core);
  const ringCentres = ring.map((group) => ({ x: group.x + group.width / 2, y: group.y + group.height / 2 }));
  const coreCentre = { x: core.x + core.width / 2, y: core.y + core.height / 2 };
  assert.ok(
    coreCentre.x > Math.min(...ringCentres.map((c) => c.x)) && coreCentre.x < Math.max(...ringCentres.map((c) => c.x)),
    'the core is horizontally between the areas',
  );
  assert.ok(
    coreCentre.y > Math.min(...ringCentres.map((c) => c.y)) && coreCentre.y < Math.max(...ringCentres.map((c) => c.y)),
    'the core is vertically between the areas',
  );
});

test('several useful declared areas choose a grouped map even when dependencies are sparse', () => {
  const nodes = Array.from({ length: 30 }, (_, index) => ({
    ...node(`n${index}`),
    group: `area-${Math.floor(index / 10)}`,
  }));
  const edges = [edge('n0', 'n10'), edge('n10', 'n20')];
  const result = layoutGraph(nodes, edges, {
    viewportWidth: 1400,
    viewportHeight: 860,
    fitPadding: 64,
    maxScale: 1.25,
    measure: () => ({ width: 210, minWidth: 170, height: 46 }),
    flow: 'auto',
    groupOf: (candidate) => candidate.group,
  });

  assert.equal(result.flow, 'spread');
  assert.deepEqual(result.groups.map((group) => group.label).sort(), ['area-0', 'area-1', 'area-2']);
  assert.deepEqual(
    new Set(result.groups.flatMap((group) => group.nodeIds)),
    new Set(nodes.map((candidate) => candidate.id)),
  );
});

test('a large disconnected declared area is split into scan-sized sections', () => {
  const nodes = Array.from({ length: 12 }, (_, index) => ({
    ...node(`isolated-${index}`),
    group: 'billing',
  }));
  const result = layoutGraph(nodes, [], {
    viewportWidth: 1400,
    viewportHeight: 860,
    fitPadding: 64,
    maxScale: 1.25,
    measure: () => ({ width: 210, minWidth: 170, height: 46 }),
    flow: 'spread',
    groupOf: (candidate) => candidate.group,
  });

  assert.equal(result.groups.length, 2);
  assert.ok(result.groups.every((group) => group.label.startsWith('billing')));
  assert.ok(result.groups.every((group) => group.count <= 6));
  assert.deepEqual(
    new Set(result.groups.flatMap((group) => group.nodeIds)),
    new Set(nodes.map((candidate) => candidate.id)),
  );
});

test('tiny sibling areas fold up a path level instead of each getting a frame', () => {
  // A monorepo: several one- and two-module packages, and one real one.
  const declared: Record<string, number> = {
    'apps/web': 2,
    'apps/api': 2,
    'apps/mobile': 3,
    'packages/ui': 1,
    'packages/i18n': 2,
    'packages/db': 8,
  };
  const nodes: DiagramNode[] = [];
  for (const [group, count] of Object.entries(declared)) {
    for (let member = 0; member < count; member += 1) {
      nodes.push({ ...node(`${group.replace(/\//g, '-')}-${member}`), group });
    }
  }
  const result = layoutGraph(nodes, [], {
    viewportWidth: 1400,
    viewportHeight: 860,
    fitPadding: 64,
    maxScale: 1.25,
    measure: () => ({ width: 210, minWidth: 170, height: 46 }),
    flow: 'spread',
    groupOf: (candidate) => candidate.group,
  });

  const labels = result.groups.map((group) => group.label);
  // apps/web + apps/api + apps/mobile -> one "apps" area; the small packages
  // fold into "packages"; packages/db is big enough to keep its own frame.
  assert.ok(labels.some((label) => label === 'apps' || label.startsWith('apps ')), `expected an apps frame, got ${labels.join(', ')}`);
  assert.ok(labels.some((label) => label === 'db' || label.startsWith('db ')), `expected db to keep its frame, got ${labels.join(', ')}`);
  assert.ok(!labels.includes('web') && !labels.includes('api'), `tiny areas should not each get a frame: ${labels.join(', ')}`);
  assert.equal(
    result.groups.reduce((total, group) => total + group.count, 0),
    nodes.length,
    'every node still lands in exactly one frame',
  );
});

test('every table sits in the frame of the file that declares it', () => {
  const { nodes, edges } = declaredSchema();
  const result = layoutGraph(nodes, edges, {
    viewportWidth: 1400,
    viewportHeight: 860,
    fitPadding: 64,
    maxScale: 1.25,
    measure: () => ({ width: 210, minWidth: 170, height: 46 }),
    flow: 'spread',
    groupOf: (candidate) => candidate.source?.file,
  });

  for (const positioned of result.nodes) {
    const holder = result.groups.find((group) =>
      positioned.x >= group.x && positioned.y >= group.y
      && positioned.x + positioned.width <= group.x + group.width
      && positioned.y + positioned.height <= group.y + group.height);
    assert.ok(holder, `${positioned.node.id} sits outside every frame`);
    assert.equal(
      holder.label,
      `${positioned.node.id.split('_')[0]}.sql`,
      `${positioned.node.id} was framed under ${holder.label}`,
    );
  }
});

test('a grouping too partial to trust is left for the edges to decide', () => {
  const { nodes, edges } = familiedSchema(5, 8);
  const result = layoutGraph(nodes, edges, {
    viewportWidth: 1400,
    viewportHeight: 860,
    fitPadding: 64,
    maxScale: 1.25,
    measure: () => ({ width: 210, minWidth: 170, height: 46 }),
    flow: 'spread',
    // Only a couple of nodes declare anything, which groups nothing.
    groupOf: (candidate) => (candidate.id === 'f0m0' ? 'a.sql' : undefined),
  });
  assert.ok(result.groups.length >= 2, 'the layout must still find its own groups');
  assert.equal(result.groups.some((group) => group.label === 'a.sql'), false);
});
