import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeWorkspace } from '../src/analyzer';
import { analyzeFlows } from '../src/flowAnalyzer';
import type { DiagramGraph, DiagramNode, WorkspaceFile } from '../src/model';

function file(path: string, content: string): WorkspaceFile {
  return { path, content, size: new TextEncoder().encode(content).byteLength };
}

test('builds project, service, and file flow scopes from static evidence', () => {
  const snapshot = analyzeWorkspace([
    file('package.json', '{}'),
    file('src/api/users.ts', `
      import { saveUser } from '../service/users';
      export function registerRoutes(router: Router) {
        router.post('/users', createUser);
      }
      async function createUser(input: Input) {
        if (input.email) {
          return saveUser(input);
        }
        return redirect('/signup');
      }
    `),
    file('src/service/users.ts', `
      export async function saveUser(input: Input) {
        return repository.save(input);
      }
    `),
  ], { projectName: 'flow-demo', revision: 1 });

  assert.ok(snapshot.stats.flowUnits >= 4, 'project, service, and two file scopes should be available');
  assert.ok(snapshot.flow.units.some((unit) => unit.kind === 'project'));
  assert.ok(snapshot.flow.units.some((unit) => unit.kind === 'service' && unit.label === 'src/api'));

  const apiFile = snapshot.flow.units.find((unit) => unit.kind === 'file' && unit.label === 'src/api/users.ts');
  assert.ok(apiFile);
  assert.ok(apiFile.graph.nodes.some((node) => node.kind === 'start' && node.label === 'POST /users'));
  assert.ok(apiFile.graph.nodes.some((node) => node.kind === 'decision' && node.label.includes('input.email')));
  assert.ok(apiFile.graph.nodes.some((node) => node.kind === 'external-action' && node.label === 'redirect'));
  assert.ok(apiFile.graph.edges.some((edge) => edge.label === 'dispatches'));
});

test('a condition that forks nothing is listed on the callable, not drawn as a diamond', () => {
  const snapshot = analyzeWorkspace([
    file('package.json', '{}'),
    file('src/render.ts', `
      export function render(state: State) {
        if (state.hidden) {
          return null;
        }
        if (!state.rows.length) {
          return empty;
        }
        return state.rows.map(paint);
      }
      function paint(row: Row) {
        return row;
      }
    `),
  ], { projectName: 'quiet-branches', revision: 1 });

  const unit = snapshot.flow.units.find((candidate) => candidate.kind === 'file');
  assert.ok(unit);
  assert.equal(
    unit.graph.nodes.filter((node) => node.kind === 'decision').length,
    0,
    'neither condition leads anywhere the diagram can draw, so neither earns a diamond',
  );

  const render = unit.graph.nodes.find((node) => node.label === 'render');
  assert.deepEqual(render?.metadata.Steps, ['if state.hidden', 'if !state.rows.length', 'rows.map()']);
});

test('a condition that does fork keeps its diamond and labels both sides', () => {
  const snapshot = analyzeWorkspace([
    file('package.json', '{}'),
    file('src/send.ts', `
      export function send(input: Input) {
        if (input.valid) {
          return client.post(input);
        } else {
          return client.get(input);
        }
      }
    `),
  ], { projectName: 'forking', revision: 1 });

  const unit = snapshot.flow.units.find((candidate) => candidate.kind === 'file');
  const decision = unit?.graph.nodes.find((node) => node.kind === 'decision');
  assert.ok(decision, 'the branch reaches two external calls, so it is a real fork');

  const branches = unit?.graph.edges.filter((edge) => edge.from === decision.id) ?? [];
  assert.ok(branches.some((edge) => edge.label === 'Yes'));
  assert.ok(branches.some((edge) => edge.label === 'No'));
  // The view inks a fork's label and holds every other one back, so which edges
  // are forks has to be recorded rather than read off the English.
  assert.ok(branches.every((edge) => edge.kind === 'branch'), 'a fork leaving a decision is marked as one');
  const plain = unit?.graph.edges.filter((edge) => edge.from !== decision.id) ?? [];
  assert.ok(plain.length > 0 && plain.every((edge) => edge.kind !== 'branch'), 'nothing else is');
});

test('keeps flow output deterministic and source-backed', () => {
  const files = [
    file('src/main.ts', `
      export function main() { return load(); }
      function load() { return fetch('/api'); }
    `),
  ];
  const first = analyzeWorkspace(files, { projectName: 'deterministic', revision: 2 });
  const second = analyzeWorkspace([...files].reverse(), { projectName: 'deterministic', revision: 2 });

  assert.deepEqual(first.flow, second.flow);
  const unit = first.flow.units.find((candidate) => candidate.kind === 'file');
  assert.ok(unit?.graph.nodes.some((node) => node.label === 'main' && node.source?.file === 'src/main.ts'));
  assert.ok(unit?.graph.edges.some((edge) => edge.label === 'calls'));
});

test('summarizes a large project flow by repository area and leaves packages out', () => {
  const modules: DiagramNode[] = Array.from({ length: 30 }, (_, index) => ({
    id: `module-${index}`,
    kind: 'module',
    label: `apps/app-${index % 5}/feature-${index}`,
    subtitle: '1 file',
    confidence: 'inferred',
    metadata: { Files: '1' },
  }));
  const external: DiagramNode = {
    id: 'external-react',
    kind: 'external-package',
    label: 'react',
    subtitle: '30 usages',
    confidence: 'exact',
    metadata: { 'Import usages': '30' },
  };
  const architecture: DiagramGraph = {
    kind: 'architecture',
    nodes: [...modules, external],
    edges: [
      ...modules.slice(1).map((node, index) => ({
        id: `edge-${index}`,
        from: node.id,
        to: modules[index]!.id,
        kind: 'imports',
        confidence: 'inferred' as const,
      })),
      ...modules.map((node, index) => ({
        id: `package-edge-${index}`,
        from: node.id,
        to: external.id,
        kind: 'uses',
        confidence: 'exact' as const,
      })),
    ],
    emptyMessage: 'empty',
  };

  const result = analyzeFlows([], 'large-project', architecture, new Map());
  const project = result.catalog.units.find((unit) => unit.kind === 'project');
  assert.ok(project);
  const realNodes = project.graph.nodes.filter((node) => node.metadata.Synthetic !== 'true');
  assert.deepEqual(realNodes.map((node) => node.label), [
    'apps/app-0',
    'apps/app-1',
    'apps/app-2',
    'apps/app-3',
    'apps/app-4',
  ]);
  assert.ok(project.graph.nodes.every((node) => node.label !== 'react'));
  assert.ok(project.graph.edges.length < architecture.edges.length / 4, 'repeated module links should become area hand-offs');
  assert.match(project.description, /5 repository areas/);
});
