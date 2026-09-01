import assert from 'node:assert/strict';
import test from 'node:test';
import {
  architectureAreaGraph,
  architectureAreaKeyOfNodeId,
  architectureOverviewGraph,
  buildArchitectureMap,
  ARCHITECTURE_AREA_PREFIX,
} from '../src/architectureAreas';
import type { DiagramEdge, DiagramGraph, DiagramNode } from '../src/model';

function moduleNode(id: string, label: string): DiagramNode {
  return {
    id,
    kind: 'module',
    label,
    subtitle: '1 file',
    source: { file: `${label}/index.ts`, line: 1 },
    confidence: 'inferred',
    metadata: { Files: '1', Languages: ['TypeScript'] },
  };
}

function edge(id: string, from: string, to: string): DiagramEdge {
  return { id, from, to, kind: 'imports', label: '1 import', confidence: 'inferred' };
}

test('large architectures open as repository areas without losing module inventory', () => {
  const nodes = Array.from({ length: 30 }, (_, index) => moduleNode(
    `m${index}`,
    `${index < 15 ? 'apps/web' : 'packages/api'}/feature-${index}`,
  ));
  const graph: DiagramGraph = {
    kind: 'architecture',
    nodes,
    edges: [edge('cross-1', 'm0', 'm15'), edge('cross-2', 'm1', 'm16'), edge('inside', 'm0', 'm1')],
    emptyMessage: 'empty',
  };
  const map = buildArchitectureMap(graph);
  assert.equal(map.usesAreas, true);
  assert.equal(map.areas.length, 2);
  assert.equal(map.areas.reduce((sum, area) => sum + area.modules, 0), 30);

  const overview = architectureOverviewGraph(graph, map);
  assert.equal(overview.nodes.length, 2);
  assert.equal(overview.edges.length, 1, 'repeated cross-area imports should be one labelled hand-off');
  assert.equal(overview.edges[0]?.metadata?.Dependencies, '2');
  assert.equal(architectureAreaKeyOfNodeId(ARCHITECTURE_AREA_PREFIX + 'apps/web'), 'apps/web');
});

test('an area keeps every local dependency and folds only its boundary', () => {
  const external: DiagramNode = {
    id: 'react', kind: 'external-package', label: 'react', subtitle: '2 usages', confidence: 'exact',
    metadata: { 'Import usages': '2' },
  };
  const graph: DiagramGraph = {
    kind: 'architecture',
    nodes: [
      moduleNode('web-a', 'apps/web/a'), moduleNode('web-b', 'apps/web/b'),
      moduleNode('api-a', 'packages/api/a'), moduleNode('api-b', 'packages/api/b'), external,
    ],
    edges: [
      edge('inside', 'web-a', 'web-b'), edge('cross-a', 'web-a', 'api-a'),
      edge('cross-b', 'web-a', 'api-b'), { ...edge('external', 'web-b', 'react'), confidence: 'exact' },
    ],
    emptyMessage: 'empty',
  };
  const map = buildArchitectureMap(graph);
  const scoped = architectureAreaGraph(graph, map, 'apps/web');
  assert.ok(scoped.nodes.some((node) => node.id === 'web-a'));
  assert.ok(scoped.nodes.some((node) => node.id === 'web-b'));
  assert.ok(scoped.nodes.some((node) => node.id === 'react'));
  assert.ok(!scoped.nodes.some((node) => node.id === 'api-a'));
  assert.equal(scoped.nodes.filter((node) => node.kind === 'architecture-area-link').length, 1);
  assert.equal(scoped.edges.filter((candidate) => candidate.kind === 'area-boundary').length, 1);
  assert.ok(scoped.edges.some((candidate) => candidate.id === 'inside'));
  assert.ok(scoped.edges.some((candidate) => candidate.id === 'external'));
});
