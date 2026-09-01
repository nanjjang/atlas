import assert from 'node:assert/strict';
import test from 'node:test';
import { NODE_GAP_Y, layoutGraph, type LayoutNode } from '../src/graphLayout';
import type { DiagramEdge, DiagramNode } from '../src/model';

const node = (id: string, group?: string): DiagramNode => ({
  id,
  kind: 'module',
  label: id,
  metadata: {},
  ...(group ? { group } : {}),
});

const edge = (from: string, to: string): DiagramEdge => ({
  id: `${from}->${to}`,
  from,
  to,
  kind: 'imports',
  confidence: 'exact',
});

const layout = (
  nodes: readonly DiagramNode[],
  edges: readonly DiagramEdge[],
  overrides: { viewportWidth?: number; viewportHeight?: number } = {},
): ReturnType<typeof layoutGraph> =>
  layoutGraph(nodes, edges, {
    viewportWidth: overrides.viewportWidth ?? 1200,
    viewportHeight: overrides.viewportHeight ?? 750,
    fitPadding: 64,
    maxScale: 1.25,
    measure: () => ({ width: 200, height: 64 }),
  });

const centre = (positioned: LayoutNode): number => positioned.y + positioned.height / 2;

const at = (result: ReturnType<typeof layoutGraph>, id: string): LayoutNode => {
  const positioned = result.nodeById.get(id);
  assert.ok(positioned, `${id} must be placed`);
  return positioned;
};

const overlaps = (left: LayoutNode, right: LayoutNode): boolean =>
  left.x < right.x + right.width
  && right.x < left.x + left.width
  && left.y < right.y + right.height
  && right.y < left.y + left.height;

const assertNoOverlaps = (result: ReturnType<typeof layoutGraph>): void => {
  for (let left = 0; left < result.nodes.length; left += 1) {
    for (let right = left + 1; right < result.nodes.length; right += 1) {
      const one = result.nodes[left];
      const other = result.nodes[right];
      assert.ok(one && other);
      assert.equal(overlaps(one, other), false, `${one.node.id} overlaps ${other.node.id}`);
    }
  }
};

test('a dependency runs left to right, one rank per column', () => {
  const result = layout([node('c'), node('a'), node('b')], [edge('a', 'b'), edge('b', 'c')]);
  assert.ok(at(result, 'a').x < at(result, 'b').x, 'a must sit in a column left of b');
  assert.ok(at(result, 'b').x < at(result, 'c').x, 'b must sit in a column left of c');
});

test('a chain is placed on one line, so its edges run straight', () => {
  const result = layout([node('a'), node('b'), node('c'), node('d')], [
    edge('a', 'b'),
    edge('b', 'c'),
    edge('c', 'd'),
  ]);
  const centres = ['a', 'b', 'c', 'd'].map((id) => centre(at(result, id)));
  for (const value of centres) {
    assert.ok(Math.abs(value - (centres[0] ?? 0)) < 0.5, `expected one line, got ${centres.join(', ')}`);
  }
});

test('a node with two dependants is centred between them', () => {
  const result = layout([node('root'), node('left'), node('right')], [
    edge('left', 'root'),
    edge('right', 'root'),
  ]);
  assert.ok(
    Math.abs(centre(at(result, 'root')) - (centre(at(result, 'left')) + centre(at(result, 'right'))) / 2) < 0.5,
    'the shared target must sit level with the middle of its sources',
  );
});

test('an edge that skips a column bends around what stands in it', () => {
  const result = layout([node('a'), node('b'), node('c')], [edge('a', 'b'), edge('b', 'c'), edge('a', 'c')]);
  const bends = result.bends.get('a->c');
  assert.ok(bends?.length, 'the skipping edge must be routed');

  const middle = at(result, 'b');
  for (const point of bends) {
    assert.ok(
      point.x >= middle.x && point.x <= middle.x + middle.width,
      'the bend belongs in the column it is crossing',
    );
    assert.ok(
      point.y < middle.y || point.y > middle.y + middle.height,
      `the bend at y=${point.y} is inside the node it should be going around`,
    );
  }
  assert.equal(result.bends.get('a->b'), undefined, 'an edge to the next column needs no bend');
});

test('nodes never overlap, however the parts are packed', () => {
  const nodes = Array.from({ length: 40 }, (_, index) => node(`n${index}`));
  const edges = nodes.slice(1).map((target, index) => edge(`n${index}`, target.id));
  // A narrow, short viewport is what forces the parts to wrap.
  const result = layout(nodes, edges, { viewportWidth: 420, viewportHeight: 320 });
  assert.equal(result.nodes.length, nodes.length);
  assertNoOverlaps(result);
});

test('nodes sharing a column keep the full gap between them', () => {
  const nodes = [node('root'), ...Array.from({ length: 6 }, (_, index) => node(`leaf${index}`))];
  const result = layout(nodes, nodes.slice(1).map((leaf) => edge('root', leaf.id)));
  const columns = new Map<number, LayoutNode[]>();
  for (const positioned of result.nodes) {
    columns.set(positioned.x, [...(columns.get(positioned.x) ?? []), positioned]);
  }
  for (const column of columns.values()) {
    const stacked = [...column].sort((left, right) => left.y - right.y);
    for (let index = 1; index < stacked.length; index += 1) {
      const above = stacked[index - 1];
      const below = stacked[index];
      assert.ok(above && below);
      assert.ok(
        below.y - (above.y + above.height) >= NODE_GAP_Y - 0.001,
        `${above.node.id} and ${below.node.id} are ${below.y - (above.y + above.height)}px apart`,
      );
    }
  }
});

test('a diagram that asks for more room between its steps is given it', () => {
  const nodes = [node('one'), node('two'), node('three')];
  const edges = [edge('one', 'two'), edge('one', 'three')];
  const spaced = layoutGraph(nodes, edges, {
    viewportWidth: 1200,
    viewportHeight: 750,
    fitPadding: 64,
    measure: () => ({ width: 200, height: 64 }),
    spacing: { nodeGapY: 54, rankGapX: 190 },
  });

  const two = at(spaced, 'two');
  const three = at(spaced, 'three');
  const [above, below] = two.y <= three.y ? [two, three] : [three, two];
  assert.ok(
    below.y - (above.y + above.height) >= 54 - 0.001,
    `the requested row gap should be kept, not the default ${NODE_GAP_Y}`,
  );
  assert.equal(two.x - (at(spaced, 'one').x + 200), 190, 'and the requested column gap too');
});

test('the column is as wide as its widest node asks for', () => {
  const result = layoutGraph([node('short'), node('a-much-longer-name')], [edge('short', 'a-much-longer-name')], {
    viewportWidth: 1200,
    viewportHeight: 750,
    fitPadding: 64,
    maxScale: 1.25,
    measure: (candidate) => ({ width: candidate.label.length * 10, height: 64 }),
  });
  assert.equal(at(result, 'short').width, 'short'.length * 10);
  assert.equal(at(result, 'a-much-longer-name').width, 'a-much-longer-name'.length * 10);
});

test('a width the viewport cannot afford falls back to the compact one', () => {
  const nodes = Array.from({ length: 8 }, (_, index) => node(`n${index}`));
  const edges = nodes.slice(1).map((target, index) => edge(`n${index}`, target.id));
  const measure = (): { width: number; minWidth: number; height: number } =>
    ({ width: 400, minWidth: 120, height: 64 });

  const roomy = layoutGraph(nodes, edges, {
    viewportWidth: 6000,
    viewportHeight: 2400,
    fitPadding: 64,
    maxScale: 1.25,
    measure,
  });
  // The same graph in a viewport too narrow for 400px columns: room for the
  // label is not worth a diagram that no longer fits.
  const squeezed = layoutGraph(nodes, edges, {
    viewportWidth: 360,
    viewportHeight: 240,
    fitPadding: 64,
    maxScale: 1.25,
    measure,
  });
  assert.equal(roomy.nodes[0]?.width, 400, 'a viewport with room must keep the roomy width');
  assert.equal(squeezed.nodes[0]?.width, 120, 'a viewport without room must fall back');
});

test('parts with no relationship between them are packed, not spread across ranks', () => {
  const connected = [node('a'), node('b')];
  const loose = Array.from({ length: 24 }, (_, index) => node(`loose${index}`));
  const result = layout([...connected, ...loose], [edge('a', 'b')]);

  assert.equal(result.nodes.length, 26);
  assertNoOverlaps(result);
  // 26 unrelated 200px nodes laid out in one row would be over 5,000px wide.
  assert.ok(result.maxX - result.minX < 2200, `packed width was ${result.maxX - result.minX}`);
  // The one real relationship must stay a short hop, not a reach across the map.
  const gap = at(result, 'b').x - (at(result, 'a').x + at(result, 'a').width);
  assert.ok(gap < 200, `the connected pair ended up ${gap}px apart`);
});

test('the external lane is placed alongside without landing on the graph', () => {
  const nodes = [node('a'), node('b')];
  const lane = [node('pkg-1'), node('pkg-2'), node('pkg-3')];
  const result = layoutGraph(nodes, [edge('a', 'b')], {
    viewportWidth: 1200,
    viewportHeight: 750,
    fitPadding: 64,
    maxScale: 1.25,
    measure: () => ({ width: 200, height: 64 }),
    lane: { nodes: lane, width: 168, height: 44 },
  });
  assert.equal(result.nodes.length, 5);
  assertNoOverlaps(result);
  for (const id of ['pkg-1', 'pkg-2', 'pkg-3']) {
    assert.equal(at(result, id).width, 168);
  }
});

test('crossing reduction beats the order the nodes arrived in', () => {
  // Two ranks wired so the alphabetical order crosses every edge.
  const sources = ['s0', 's1', 's2', 's3'].map((id) => node(id));
  const targets = ['t0', 't1', 't2', 't3'].map((id) => node(id));
  const edges = [edge('s0', 't3'), edge('s1', 't2'), edge('s2', 't1'), edge('s3', 't0')];
  const result = layout([...sources, ...targets], edges);

  for (const left of edges) {
    for (const right of edges) {
      if (left === right) continue;
      const crosses = (centre(at(result, left.from)) - centre(at(result, right.from)))
        * (centre(at(result, left.to)) - centre(at(result, right.to))) < 0;
      assert.equal(crosses, false, `${left.id} still crosses ${right.id}`);
    }
  }
});

test('a cycle is laid out rather than dropped', () => {
  const nodes = [node('a'), node('b'), node('c')];
  const result = layout(nodes, [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')]);
  assert.equal(result.nodes.length, 3);
  assertNoOverlaps(result);
});

test('an empty graph is laid out without throwing', () => {
  const result = layout([], []);
  assert.deepEqual(result.nodes, []);
  assert.equal(result.maxX > result.minX, true);
});
