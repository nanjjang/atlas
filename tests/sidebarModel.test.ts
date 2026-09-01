import assert from 'node:assert/strict';
import test from 'node:test';
import type { DiagramEdge, DiagramGraph, DiagramNode } from '../src/model.js';
import { chooseSidebarFocus, graphHealth, sidebarNeighbourhood } from '../src/sidebarModel.js';

const node = (id: string, kind = 'module'): DiagramNode => ({
  id,
  kind,
  label: id,
  metadata: {},
});

const edge = (
  id: string,
  from: string,
  to: string,
  confidence: DiagramEdge['confidence'] = 'exact',
): DiagramEdge => ({ id, from, to, kind: 'uses', confidence });

const graph = (nodes: DiagramNode[], edges: DiagramEdge[]): DiagramGraph => ({
  kind: 'architecture',
  nodes,
  edges,
  emptyMessage: 'empty',
});

test('sidebar focus follows a valid preferred node and otherwise chooses a connected workspace node', () => {
  const value = graph(
    [node('quiet'), node('busy'), node('leaf'), node('package', 'external-package')],
    [edge('a', 'busy', 'leaf'), edge('b', 'busy', 'package')],
  );
  assert.equal(chooseSidebarFocus(value, 'quiet'), 'quiet');
  assert.equal(chooseSidebarFocus(value, 'missing'), 'busy');
});

test('sidebar neighbourhood folds duplicate neighbours and reports overflow', () => {
  const value = graph(
    [node('focus'), node('a'), node('b'), node('c'), node('d')],
    [
      edge('a1', 'a', 'focus', 'inferred'),
      edge('a2', 'a', 'focus', 'exact'),
      edge('b', 'b', 'focus'),
      edge('c', 'focus', 'c'),
      edge('d', 'focus', 'd'),
    ],
  );
  const result = sidebarNeighbourhood(value, 'focus', 1);
  assert.ok(result);
  assert.deepEqual(result.incoming.map((relation) => relation.node.id), ['a']);
  assert.equal(result.incoming[0]?.edge.confidence, 'exact');
  assert.equal(result.hiddenIncoming, 1);
  assert.deepEqual(result.outgoing.map((relation) => relation.node.id), ['c']);
  assert.equal(result.hiddenOutgoing, 1);
});

test('graph health separates evidence levels and ignores isolated external packages', () => {
  const value = graph(
    [node('connected'), node('target'), node('isolated'), node('package', 'external-package')],
    [edge('inferred', 'connected', 'target', 'inferred'), edge('unresolved', 'target', 'missing', 'unresolved')],
  );
  const health = graphHealth(value);
  assert.deepEqual(health.inferred.map((item) => item.id), ['inferred']);
  assert.deepEqual(health.unresolved.map((item) => item.id), ['unresolved']);
  assert.deepEqual(health.isolated.map((item) => item.id), ['isolated']);
});
