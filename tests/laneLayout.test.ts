import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_LANES, layoutLanes, orderNodes } from '../src/laneLayout';
import type { DiagramEdge, DiagramNode } from '../src/model';

const node = (id: string): DiagramNode => ({ id, kind: 'module', label: id, metadata: {} });

const edge = (from: string, to: string): DiagramEdge => ({
  id: `${from}->${to}`,
  from,
  to,
  kind: 'imports',
  confidence: 'exact',
});

const labels = (nodes: readonly DiagramNode[]): string[] => nodes.map((entry) => entry.label);

test('orders nodes so a dependency points down the list', () => {
  const nodes = [node('c'), node('a'), node('b')];
  const edges = [edge('a', 'b'), edge('b', 'c')];
  assert.deepEqual(labels(orderNodes(nodes, edges)), ['a', 'b', 'c']);
});

test('nodes without relationships keep a stable alphabetical order', () => {
  const nodes = [node('zeta'), node('alpha'), node('mu')];
  assert.deepEqual(labels(orderNodes(nodes, [])), ['alpha', 'mu', 'zeta']);
  assert.deepEqual(labels(orderNodes([...nodes].reverse(), [])), ['alpha', 'mu', 'zeta']);
});

test('a straight chain stays in one lane', () => {
  const layout = layoutLanes([node('a'), node('b'), node('c')], [edge('a', 'b'), edge('b', 'c')]);
  assert.equal(layout.laneCount, 1);
  assert.deepEqual(layout.rows.map((row) => row.lane), [0, 0, 0]);
  assert.deepEqual(layout.unroutedEdgeIds, []);
});

test('an edge that skips a row passes through it in its own lane', () => {
  const layout = layoutLanes(
    [node('a'), node('b'), node('c')],
    [edge('a', 'b'), edge('a', 'c'), edge('b', 'c')],
  );
  assert.equal(layout.laneCount, 2);

  const [first, middle, last] = layout.rows;
  assert.ok(first && middle && last);
  // The long hop leaves `a` sideways into the second lane.
  assert.deepEqual(
    first.lines.filter((line) => line.kind === 'exit').map((line) => [line.fromLane, line.toLane]),
    [[0, 0], [0, 1]],
  );
  // It then crosses `b` untouched, while the short hop lands on its dot.
  assert.deepEqual(
    middle.lines.map((line) => line.kind).sort(),
    ['enter', 'exit', 'pass'],
  );
  const passing = middle.lines.find((line) => line.kind === 'pass');
  assert.equal(passing?.edgeId, 'a->c');
  assert.deepEqual([passing?.fromLane, passing?.toLane], [1, 1]);
  // Both relationships arrive at `c`, one of them merging in from lane 1.
  assert.deepEqual(
    last.lines.filter((line) => line.kind === 'enter').map((line) => [line.fromLane, line.toLane]).sort(),
    [[0, 0], [1, 0]],
  );
});

test('counts every relationship on the row it belongs to', () => {
  const layout = layoutLanes(
    [node('a'), node('b'), node('c')],
    [edge('a', 'b'), edge('a', 'c'), edge('b', 'c')],
  );
  const byLabel = new Map(layout.rows.map((row) => [row.node.label, row]));
  assert.deepEqual([byLabel.get('a')?.outgoing, byLabel.get('a')?.incoming], [2, 0]);
  assert.deepEqual([byLabel.get('c')?.outgoing, byLabel.get('c')?.incoming], [0, 2]);
});

test('a self reference and a cycle are reported instead of drawn upwards', () => {
  const layout = layoutLanes(
    [node('a'), node('b'), node('c')],
    [edge('a', 'a'), edge('a', 'b'), edge('b', 'c'), edge('c', 'a')],
  );
  assert.deepEqual(layout.unroutedEdgeIds.sort(), ['a->a', 'c->a']);
  for (const row of layout.rows) {
    for (const line of row.lines) {
      assert.notEqual(line.edgeId, 'a->a');
      assert.notEqual(line.edgeId, 'c->a');
    }
  }
});

test('the gutter never grows past the lane cap', () => {
  const nodes = [node('root'), ...Array.from({ length: 40 }, (_, index) => node(`leaf${String(index).padStart(2, '0')}`))];
  const edges = nodes.slice(1).map((leaf) => edge('root', leaf.id));
  const layout = layoutLanes(nodes, edges);
  assert.ok(layout.laneCount <= MAX_LANES, `${layout.laneCount} lanes exceeds the cap`);
  for (const row of layout.rows) {
    for (const line of row.lines) {
      assert.ok(line.fromLane < MAX_LANES && line.toLane < MAX_LANES);
    }
  }
});

test('an empty graph produces no rows', () => {
  const layout = layoutLanes([], []);
  assert.deepEqual(layout.rows, []);
  assert.deepEqual(layout.unroutedEdgeIds, []);
});

test('an edge pointing outside the node set is ignored', () => {
  const layout = layoutLanes([node('a')], [edge('a', 'missing')]);
  assert.equal(layout.rows.length, 1);
  assert.deepEqual(layout.rows[0]?.lines, []);
  assert.deepEqual(layout.unroutedEdgeIds, []);
});
