import type {
  AnalysisDiagnostic,
  DiagramEdge,
  DiagramGraph,
  DiagramNode,
  FlowCatalog,
  FlowUnit,
  WorkspaceFile,
} from './model';

const FLOW_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte',
  'py', 'java', 'kt', 'kts', 'go', 'rs', 'cs', 'php', 'rb', 'dart', 'swift',
  'c', 'cc', 'cpp', 'cxx',
]);

const MAX_FILE_UNITS = 180;
const MAX_SERVICE_NODES = 64;
const MAX_FILE_NODES = 42;
const MAX_DECISIONS_PER_CALLABLE = 4;
const MAX_EXTERNAL_ACTIONS = 8;
/** Steps listed on a callable's card before it stops being a card. */
const MAX_STEP_ROWS = 6;
/** Chains a synthetic `Start here` / `End` can gather before it is a hub. */
const MAX_BOUNDARY_FAN = 8;
/**
 * A project flow is an overview, not a second copy of the architecture map.
 * Below this size the modules themselves are already a readable overview;
 * above it they are folded into repository areas before any hand-off is drawn.
 */
const MAX_PROJECT_MODULES = 18;

interface DefinitionFact {
  name: string;
  line: number;
  endLine: number;
}

interface RouteFact {
  label: string;
  line: number;
  handler?: string;
}

interface DecisionFact {
  label: string;
  line: number;
}

interface CallFact {
  name: string;
  label: string;
  line: number;
}

interface FileFlow {
  file: WorkspaceFile;
  graph: DiagramGraph;
  score: number;
}

export interface FlowAnalysisResult {
  catalog: FlowCatalog;
  diagnostics: AnalysisDiagnostic[];
}

/**
 * Builds bounded, source-backed flow scopes without executing workspace code.
 * The project view is based on already-resolved module imports. Narrower views
 * read explicit routes, callable declarations, branch statements and calls.
 */
export function analyzeFlows(
  files: WorkspaceFile[],
  projectName: string,
  architecture: DiagramGraph,
  moduleByPath: ReadonlyMap<string, string>,
): FlowAnalysisResult {
  const codeFiles = files.filter((file) => FLOW_EXTENSIONS.has(extensionOf(file.path)));
  const analyzed = codeFiles
    .map(buildFileFlow)
    .filter((result): result is FileFlow => Boolean(result));

  const diagnostics: AnalysisDiagnostic[] = [];
  if (analyzed.length) {
    diagnostics.push({
      code: 'FLOW_STATIC_HEURISTIC',
      severity: 'info',
      message: 'Flow diagrams are inferred from explicit routes, callables, branches, calls, and imports. Runtime dispatch, dependency injection, reflection, and generated code are not executed.',
    });
  }

  const projectUnit = buildProjectUnit(projectName, architecture);
  const byService = new Map<string, FileFlow[]>();
  for (const fileFlow of analyzed) {
    const service = moduleByPath.get(normalizePath(fileFlow.file.path)) ?? '(root)';
    const group = byService.get(service) ?? [];
    group.push(fileFlow);
    byService.set(service, group);
  }

  const serviceUnits = [...byService.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([service, serviceFiles]) => buildServiceUnit(service, serviceFiles))
    .filter((unit): unit is FlowUnit => Boolean(unit));

  const rankedFiles = [...analyzed].sort((left, right) =>
    right.score - left.score || left.file.path.localeCompare(right.file.path));
  const visibleFiles = rankedFiles.slice(0, MAX_FILE_UNITS);
  if (rankedFiles.length > visibleFiles.length) {
    diagnostics.push({
      code: 'FLOW_FILE_LIMIT',
      severity: 'info',
      message: `Flow scopes are shown for the ${visibleFiles.length} most connected source files; ${rankedFiles.length - visibleFiles.length} lower-signal files were omitted to keep the snapshot responsive.`,
    });
  }

  const fileUnits: FlowUnit[] = visibleFiles
    .sort((left, right) => left.file.path.localeCompare(right.file.path))
    .map(({ file, graph }) => ({
      id: stableId('flow-unit', 'file', file.path),
      label: file.path,
      kind: 'file',
      description: 'Routes, branches, and statically visible calls in this file',
      source: { file: file.path, line: 1 },
      graph,
    }));

  const units = [
    ...(projectUnit ? [projectUnit] : []),
    ...serviceUnits,
    ...fileUnits,
  ];
  return {
    catalog: {
      units,
      emptyMessage: 'No explicit routes or callable declarations were found in supported source files.',
    },
    diagnostics,
  };
}

function buildProjectUnit(projectName: string, architecture: DiagramGraph): FlowUnit | undefined {
  const modules = architecture.nodes.filter((node) => node.kind === 'module');
  if (!modules.length) {
    return undefined;
  }
  const moduleIds = new Set(modules.map((node) => node.id));
  const moduleEdges = architecture.edges.filter((edge) => moduleIds.has(edge.from) && moduleIds.has(edge.to));
  const summarized = modules.length > MAX_PROJECT_MODULES
    ? summarizeProjectAreas(modules, moduleEdges)
    : {
      nodes: modules.map((node): DiagramNode => ({
        ...node,
        kind: 'service',
        subtitle: 'Service / module',
        metadata: { ...node.metadata, Scope: 'Project flow' },
      })),
      edges: moduleEdges.map((edge): DiagramEdge => ({
        ...edge,
        kind: 'hands-off',
        label: edge.label ?? 'hands off',
      })),
    };
  const { nodes, edges } = summarized;

  addBoundaryNodes(nodes, edges, stableId('flow', 'project', projectName), projectName);
  return {
    id: stableId('flow-unit', 'project', projectName),
    label: `${projectName} · project`,
    kind: 'project',
    description: modules.length > MAX_PROJECT_MODULES
      ? `Static hand-off between ${nodes.filter((node) => node.metadata.Synthetic !== 'true').length} repository areas`
      : 'Static hand-off between workspace services/modules',
    graph: {
      kind: 'flow',
      nodes,
      edges,
      emptyMessage: 'No module hand-off was found for this project.',
    },
  };
}

/**
 * Folds a large module map into boundaries that a developer can navigate to.
 * External packages are deliberately absent: they are dependencies, not steps
 * in the product's operation, and were the largest source of unreadable fans.
 */
function summarizeProjectAreas(
  modules: readonly DiagramNode[],
  edges: readonly DiagramEdge[],
): { nodes: DiagramNode[]; edges: DiagramEdge[] } {
  const areaByModule = new Map(modules.map((node) => [node.id, projectArea(node.label)]));
  const members = new Map<string, DiagramNode[]>();
  for (const node of modules) {
    const area = areaByModule.get(node.id) ?? node.label;
    members.set(area, [...(members.get(area) ?? []), node]);
  }

  // If the first pass found one broad root such as `src`, its second path
  // segment is the boundary that carries useful meaning.
  if (members.size < 2 && modules.length > 1) {
    members.clear();
    for (const node of modules) {
      const area = projectArea(node.label, true);
      areaByModule.set(node.id, area);
      members.set(area, [...(members.get(area) ?? []), node]);
    }
  }

  const nodes = [...members.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([area, areaModules]): DiagramNode => {
      const files = areaModules.reduce((total, node) => total + (Number(node.metadata.Files) || 0), 0);
      const source = areaModules.find((node) => node.source)?.source;
      return {
        id: stableId('flow-project-area', area),
        kind: 'service',
        label: area,
        subtitle: `${areaModules.length} module${areaModules.length === 1 ? '' : 's'} · ${files} file${files === 1 ? '' : 's'}`,
        group: 'Project areas',
        ...(source ? { source } : {}),
        confidence: 'inferred',
        metadata: {
          Scope: 'Project flow summary',
          Modules: String(areaModules.length),
          Files: String(files),
          Examples: areaModules.slice(0, 5).map((node) => node.label),
        },
      };
    });

  const aggregated = new Map<string, { from: string; to: string; count: number; source?: DiagramEdge['source'] }>();
  for (const edge of edges) {
    const fromArea = areaByModule.get(edge.from);
    const toArea = areaByModule.get(edge.to);
    if (!fromArea || !toArea || fromArea === toArea) {
      continue;
    }
    const from = stableId('flow-project-area', fromArea);
    const to = stableId('flow-project-area', toArea);
    const key = `${from}\u0000${to}`;
    const current = aggregated.get(key);
    if (current) {
      current.count += 1;
    } else {
      aggregated.set(key, { from, to, count: 1, ...(edge.source ? { source: edge.source } : {}) });
    }
  }
  const summarizedEdges = [...aggregated.values()]
    .sort((left, right) => `${left.from}/${left.to}`.localeCompare(`${right.from}/${right.to}`))
    .map((edge): DiagramEdge => ({
      id: stableId('flow-project-edge', edge.from, edge.to),
      from: edge.from,
      to: edge.to,
      kind: 'hands-off',
      label: edge.count === 1 ? '1 hand-off' : `${edge.count} hand-offs`,
      confidence: 'inferred',
      ...(edge.source ? { source: edge.source } : {}),
      metadata: { Relationships: String(edge.count) },
    }));
  return { nodes, edges: summarizedEdges };
}

function projectArea(label: string, forceSecond = false): string {
  const parts = normalizePath(label).split('/').filter(Boolean);
  if (parts.length < 2) {
    return parts[0] ?? label;
  }
  const first = parts[0] ?? label;
  if (forceSecond || ['apps', 'packages', 'services', 'libs', 'src'].includes(first)) {
    return parts.slice(0, 2).join('/');
  }
  return first;
}

function buildServiceUnit(service: string, files: FileFlow[]): FlowUnit | undefined {
  const ranked = [...files].sort((left, right) => right.score - left.score || left.file.path.localeCompare(right.file.path));
  const nodes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];
  const included = new Set<string>();

  for (const file of ranked) {
    const candidates = file.graph.nodes.filter((node) => node.metadata.Synthetic !== 'true');
    if (nodes.length > 0 && nodes.length + candidates.length > MAX_SERVICE_NODES) {
      continue;
    }
    for (const node of candidates) {
      nodes.push(node);
      included.add(node.id);
    }
  }
  for (const file of ranked) {
    for (const edge of file.graph.edges) {
      if (included.has(edge.from) && included.has(edge.to)) {
        edges.push(edge);
      }
    }
  }
  if (!nodes.length) {
    return undefined;
  }
  addBoundaryNodes(nodes, edges, stableId('flow', 'service', service), service);
  const source = nodes.find((node) => node.source)?.source;
  return {
    id: stableId('flow-unit', 'service', service),
    label: service,
    kind: 'service',
    description: `${files.length} source file${files.length === 1 ? '' : 's'} · explicit routes, branches, and calls`,
    ...(source ? { source } : {}),
    graph: {
      kind: 'flow',
      nodes,
      edges,
      emptyMessage: 'No statically visible operation flow was found in this service.',
    },
  };
}

function buildFileFlow(file: WorkspaceFile): FileFlow | undefined {
  const lines = file.content.split(/\r?\n/);
  const { definitions, routes } = extractDefinitionsAndRoutes(lines, extensionOf(file.path));
  if (!definitions.length && !routes.length) {
    return undefined;
  }

  const nodes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];
  const definitionByName = new Map(definitions.map((definition) => [definition.name, definition]));
  const routedHandlers = new Set(routes.map((route) => route.handler).filter((handler): handler is string => Boolean(handler)));
  const visibleDefinitions = [...definitions]
    .sort((left, right) => Number(routedHandlers.has(right.name)) - Number(routedHandlers.has(left.name)) || left.line - right.line)
    .slice(0, Math.max(1, MAX_FILE_NODES - Math.min(12, routes.length)));

  for (const definition of visibleDefinitions) {
    nodes.push({
      id: definitionId(file.path, definition),
      kind: routedHandlers.has(definition.name) || isConventionalEntry(definition.name) ? 'entry' : 'action',
      label: definition.name,
      subtitle: `Callable · line ${definition.line}`,
      group: file.path,
      source: { file: file.path, line: definition.line },
      confidence: 'exact',
      metadata: { File: file.path, Declaration: definition.name },
    });
  }

  for (const route of routes.slice(0, Math.min(12, MAX_FILE_NODES - nodes.length))) {
    const routeId = stableId('flow-route', file.path, String(route.line), route.label);
    nodes.push({
      id: routeId,
      kind: 'start',
      label: route.label,
      subtitle: 'Route / event entry',
      group: file.path,
      source: { file: file.path, line: route.line },
      confidence: 'exact',
      metadata: { File: file.path, Trigger: route.label },
    });
    const target = route.handler ? definitionByName.get(route.handler) : undefined;
    if (target && nodes.some((node) => node.id === definitionId(file.path, target))) {
      edges.push(flowEdge(routeId, definitionId(file.path, target), 'dispatches', file.path, route.line, 'exact'));
    }
  }

  let externalActions = 0;
  for (const definition of definitions) {
    const fromId = definitionId(file.path, definition);
    const owner = nodes.find((node) => node.id === fromId);
    if (!owner) {
      continue;
    }
    // Include the declaration line: concise functions and arrow handlers often
    // contain their complete operation on that same line.
    const body = lines.slice(definition.line - 1, definition.endLine);
    const decisions = extractDecisions(body, definition.line - 1).slice(0, MAX_DECISIONS_PER_CALLABLE);
    const decisionIdOf = (decision: DecisionFact): string =>
      stableId('flow-decision', file.path, definition.name, String(decision.line));

    /**
     * A condition earns a diamond only once something is seen to happen on one
     * of its branches. A diamond with nothing leaving it asks the reader to
     * follow a fork that was never drawn, and a file of them is a wall of
     * questions with no answers — so the diamond is cut here, and the condition
     * is listed on the callable's own card instead by `foldedSteps` below.
     */
    const forked = new Set<string>();
    const anchorFor = (branch: DecisionFact | undefined): string => {
      if (!branch) {
        return fromId;
      }
      const id = decisionIdOf(branch);
      if (forked.has(id)) {
        return id;
      }
      if (nodes.length >= MAX_FILE_NODES) {
        // Out of room for the fork itself; the branch still happens, so it is
        // drawn leaving the callable rather than dropped.
        return fromId;
      }
      forked.add(id);
      nodes.push({
        id,
        kind: 'decision',
        label: branch.label,
        subtitle: `Branch in ${definition.name}`,
        group: file.path,
        source: { file: file.path, line: branch.line },
        confidence: 'inferred',
        metadata: { File: file.path, 'Static branch': branch.label },
      });
      edges.push(flowEdge(fromId, id, 'checks', file.path, branch.line, 'inferred'));
      return id;
    };

    const steps: Array<{ line: number; text: string }> = [];
    for (const call of extractCalls(body, definition.line - 1)) {
      if (call.name === definition.name) {
        continue;
      }
      const target = definitionByName.get(call.name);
      const branch = nearestDecision(decisions, call.line);
      if (target && nodes.some((node) => node.id === definitionId(file.path, target))) {
        const anchor = anchorFor(branch);
        edges.push(flowEdge(
          anchor,
          definitionId(file.path, target),
          branch ? branchLabel(lines, branch.line, call.line) : 'calls',
          file.path,
          call.line,
          branch ? 'inferred' : 'exact',
          branch ? 'branch' : 'flows-to',
        ));
      } else if (nodes.length < MAX_FILE_NODES && externalActions < MAX_EXTERNAL_ACTIONS && isSignificantExternalCall(call.label)) {
        const externalId = stableId('flow-external', file.path, call.label);
        if (!nodes.some((node) => node.id === externalId)) {
          nodes.push({
            id: externalId,
            kind: 'external-action',
            label: call.label,
            subtitle: 'External I/O call',
            group: file.path,
            source: { file: file.path, line: call.line },
            confidence: 'inferred',
            metadata: { File: file.path, Call: call.label },
          });
          externalActions += 1;
        }
        const anchor = anchorFor(branch);
        edges.push(flowEdge(
          anchor,
          externalId,
          branch ? branchLabel(lines, branch.line, call.line) : 'calls',
          file.path,
          call.line,
          'inferred',
          branch ? 'branch' : 'flows-to',
        ));
      } else if (call.label.includes('.')) {
        // Not a step the diagram can draw its own box for, but still one of the
        // things this callable does, so the card says so rather than losing it.
        steps.push({ line: call.line, text: `${call.label}()` });
      }
    }

    for (const decision of decisions) {
      if (!forked.has(decisionIdOf(decision))) {
        steps.push({ line: decision.line, text: `if ${decision.label.replace(/\?$/, '')}` });
      }
    }
    const listed = orderedSteps(steps);
    if (listed.length) {
      owner.metadata.Steps = listed;
    }
  }

  deduplicateGraph(nodes, edges);
  addBoundaryNodes(nodes, edges, stableId('flow', 'file', file.path), basename(file.path));
  const score = routes.length * 12 + edges.length * 3 + definitions.length;
  return {
    file,
    score,
    graph: {
      kind: 'flow',
      nodes,
      edges,
      emptyMessage: 'No statically visible operation flow was found in this file.',
    },
  };
}

function extractDefinitionsAndRoutes(lines: string[], extension: string): { definitions: DefinitionFact[]; routes: RouteFact[] } {
  const starts: Array<{ name: string; line: number }> = [];
  const routes: RouteFact[] = [];
  let pendingRoutes: RouteFact[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? '';
    const line = index + 1;
    const routeFacts = routesOnLine(raw, line);
    for (const route of routeFacts) {
      if (route.handler) {
        routes.push(route);
      } else {
        pendingRoutes.push(route);
      }
    }

    const name = declaredCallableOnLine(raw, extension);
    if (!name) {
      continue;
    }
    starts.push({ name, line });
    for (const route of pendingRoutes) {
      routes.push({ ...route, handler: name });
    }
    pendingRoutes = [];
  }

  const definitions = starts.map((start, index) => ({
    ...start,
    endLine: (starts[index + 1]?.line ?? lines.length + 1) - 1,
  }));
  return { definitions, routes };
}

function routesOnLine(raw: string, line: number): RouteFact[] {
  const facts: RouteFact[] = [];
  const annotation = raw.match(/@(Get|Post|Put|Delete|Patch|Request)Mapping\s*\(\s*(?:value\s*=\s*)?["']([^"']*)/i)
    ?? raw.match(/@(GET|POST|PUT|DELETE|PATCH)\s*\(\s*["']([^"']*)/i);
  if (annotation) {
    facts.push({ label: `${annotation[1]?.toUpperCase()} ${annotation[2] || '/'}`, line });
  }
  const python = raw.match(/@(?:app|router|blueprint)\.(?:route|get|post|put|delete|patch)\s*\(\s*["']([^"']+)["']/i);
  if (python) {
    const verb = raw.match(/\.(get|post|put|delete|patch)\s*\(/i)?.[1]?.toUpperCase() ?? 'ROUTE';
    facts.push({ label: `${verb} ${python[1]}`, line });
  }
  const direct = raw.match(/\b(?:app|router|server)\.(get|post|put|delete|patch|use|on)\s*\(\s*["'`]([^"'`]+)["'`]\s*,\s*([A-Za-z_$][\w$]*)/i);
  if (direct) {
    facts.push({ label: `${direct[1]?.toUpperCase()} ${direct[2]}`, line, handler: direct[3] });
  }
  const dotnet = raw.match(/\.Map(Get|Post|Put|Delete|Patch)\s*\(\s*["']([^"']+)["']\s*,\s*([A-Za-z_]\w*)/i);
  if (dotnet) {
    facts.push({ label: `${dotnet[1]?.toUpperCase()} ${dotnet[2]}`, line, handler: dotnet[3] });
  }
  return facts;
}

/**
 * The name of the callable declared on this line, if it declares one.
 *
 * Shared with the interface analyzer, which needs exactly the same answer: a
 * route annotation says which HTTP method and path, and the declaration on the
 * next line says which function answers it.
 */
export function declaredCallableOnLine(raw: string, extension: string): string | undefined {
  const line = raw.replace(/\/\/.*$/, '').trim();
  if (!line || line.startsWith('#') || line.startsWith('*')) {
    return undefined;
  }
  const directPatterns = [
    /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/,
    /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
    /^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/,
    /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/,
    /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)\s*\(/,
    /^(?:(?:public|private|protected|internal|open|override|static|final|suspend|async|virtual)\s+)*fun\s+([A-Za-z_]\w*)\s*\(/,
    /^(?:(?:public|private|fileprivate|internal|open|override|static|class|mutating|async)\s+)*func\s+([A-Za-z_]\w*)\s*\(/,
  ];
  for (const pattern of directPatterns) {
    const match = line.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'java', 'cs', 'dart', 'php', 'c', 'cc', 'cpp', 'cxx'].includes(extension)) {
    const method = line.match(/^(?:(?:public|private|protected|internal|static|final|abstract|virtual|override|async|readonly|extern|inline)\s+)*(?:[A-Za-z_$][\w$<>,.?[\]:]*\s+)?([A-Za-z_$][\w$]*)\s*\([^;=]*\)\s*(?::[^={]+)?\s*(?:\{|=>)/);
    const name = method?.[1];
    if (name && !['if', 'for', 'while', 'switch', 'catch', 'with', 'return', 'new'].includes(name)) {
      return name;
    }
  }
  return undefined;
}

function extractDecisions(lines: string[], lineOffset: number): DecisionFact[] {
  const decisions: DecisionFact[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]?.trim() ?? '';
    const condition = raw.match(/\bif\s*\(([^)]+)\)/)?.[1]
      ?? raw.match(/^(?:else\s+)?if\s+(.+?)(?::|\{)?$/)?.[1]
      ?? raw.match(/\b(?:switch|when)\s*\(([^)]+)\)/)?.[1];
    if (condition) {
      decisions.push({ label: `${truncate(condition.trim(), 44)}?`, line: lineOffset + index + 1 });
    }
  }
  return decisions;
}

function extractCalls(lines: string[], lineOffset: number): CallFact[] {
  const calls: CallFact[] = [];
  const ignored = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'typeof', 'sizeof', 'super', 'this']);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = (lines[index] ?? '').replace(/\/\/.*$/, '').replace(/#.*$/, '');
    for (const match of raw.matchAll(/\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*\(/g)) {
      const label = match[1];
      if (!label) {
        continue;
      }
      const name = label.split('.').at(-1) ?? label;
      if (!ignored.has(name)) {
        calls.push({ name, label, line: lineOffset + index + 1 });
      }
    }
  }
  return calls;
}

function nearestDecision(decisions: DecisionFact[], callLine: number): DecisionFact | undefined {
  return [...decisions]
    .reverse()
    .find((decision) => decision.line <= callLine && callLine - decision.line <= 8);
}

/**
 * Which side of the fork the call sits on. The words are kept to one each: a
 * branch label is read at the same moment as the two boxes it sits between, and
 * "Yes / branch" spends that moment on the half that says nothing.
 */
function branchLabel(lines: string[], decisionLine: number, callLine: number): string {
  const between = lines.slice(Math.max(0, decisionLine - 1), Math.max(0, callLine)).join('\n');
  return /\belse\b/.test(between) ? 'No' : 'Yes';
}

/**
 * The steps folded onto a callable's card: source order, no repeats, and capped
 * at what a card can show without becoming a listing of the function.
 */
function orderedSteps(steps: readonly { line: number; text: string }[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const step of [...steps].sort((left, right) => left.line - right.line)) {
    if (seen.has(step.text)) {
      continue;
    }
    seen.add(step.text);
    ordered.push(truncate(step.text, 40));
    if (ordered.length >= MAX_STEP_ROWS) {
      break;
    }
  }
  return ordered;
}

function isSignificantExternalCall(label: string): boolean {
  return /(?:^|\.)(?:fetch|request|get|post|put|patch|delete|query|execute|save|insert|update|remove|publish|emit|send|dispatch|enqueue|navigate|redirect)$/i.test(label)
    || /(?:repository|database|client|gateway|queue|producer|http|axios)\./i.test(label);
}

function isConventionalEntry(name: string): boolean {
  return /^(?:main|run|start|bootstrap|handle|handler|execute|process|on[A-Z_]|.*Controller)$/i.test(name);
}

function addBoundaryNodes(nodes: DiagramNode[], edges: DiagramEdge[], prefix: string, label: string): void {
  const realNodes = nodes.filter((node) => node.metadata.Synthetic !== 'true');
  if (!realNodes.length) {
    return;
  }
  const incoming = new Map(realNodes.map((node) => [node.id, 0]));
  const outgoing = new Map(realNodes.map((node) => [node.id, 0]));
  for (const edge of edges) {
    if (incoming.has(edge.to)) incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
    if (outgoing.has(edge.from)) outgoing.set(edge.from, (outgoing.get(edge.from) ?? 0) + 1);
  }
  const leadsSomewhere = (node: DiagramNode): boolean => (outgoing.get(node.id) ?? 0) > 0;
  const camefromSomewhere = (node: DiagramNode): boolean => (incoming.get(node.id) ?? 0) > 0;
  const declaredEntry = (node: DiagramNode): boolean => node.kind === 'start' || node.kind === 'entry';

  // `Start` belongs in front of the steps a chain actually begins at, and every
  // one of them — a cap here does not tidy the fan, it just leaves the steps
  // past it with no line at all. A callable that neither calls nor is called is
  // not on a path, so wiring it to both boundaries would draw a flow through it
  // that the source does not have; it stands on its own instead.
  const starts = realNodes
    .filter((node) => declaredEntry(node) || (!camefromSomewhere(node) && leadsSomewhere(node)));
  const ends = realNodes
    .filter((node) => node.kind !== 'decision' && !leadsSomewhere(node) && camefromSomewhere(node));

  // A boundary node earns its place by giving the reader one place to enter the
  // diagram from. Tied to two dozen steps it stops doing that and becomes the
  // busiest thing on the canvas, saying only "these are the routes" — which the
  // route pills already say. So past a handful it is left out, and the declared
  // entries are the beginning, which is what they are in the source anyway.
  if (starts.length && starts.length <= MAX_BOUNDARY_FAN) {
    const startId = `${prefix}:start`;
    nodes.push({
      id: startId,
      // Not `start`: that is a route the source declares, and this is the
      // diagram's own mark for where to begin reading. Sharing one kind drew
      // every route as the same pill as this marker, so a reader could not tell
      // the thing that exists in the code from the thing the drawing added.
      kind: 'flow-start',
      label: 'Start here',
      subtitle: label,
      confidence: 'inferred',
      metadata: { Synthetic: 'true', Scope: label },
    });
    for (const target of starts) {
      if (target.id !== startId && !edges.some((edge) => edge.from === startId && edge.to === target.id)) {
        edges.push(flowEdge(startId, target.id, 'starts', target.source?.file, target.source?.line, 'inferred'));
      }
    }
  }

  if (ends.length && ends.length <= MAX_BOUNDARY_FAN) {
    const endId = `${prefix}:end`;
    nodes.push({
      id: endId,
      kind: 'flow-end',
      label: 'End',
      subtitle: label,
      confidence: 'inferred',
      metadata: { Synthetic: 'true', Scope: label },
    });
    for (const terminal of ends) {
      edges.push(flowEdge(terminal.id, endId, 'finishes', terminal.source?.file, terminal.source?.line, 'inferred'));
    }
  }
}

function definitionId(filePath: string, definition: DefinitionFact): string {
  return stableId('flow-step', filePath, definition.name, String(definition.line));
}

/**
 * `kind` separates a fork from every other line. Both carry a label, but only a
 * fork's label is part of the drawing: `Yes` and `No` *are* the branch, where
 * `calls`, `dispatches` and `starts` only name a kind of line the shape of the
 * diagram already shows. Recording which is which here lets the view ink the one
 * and keep the other for the details panel, rather than matching on English.
 */
function flowEdge(
  from: string,
  to: string,
  label: string,
  file: string | undefined,
  line: number | undefined,
  confidence: DiagramEdge['confidence'],
  kind: string = 'flows-to',
): DiagramEdge {
  return {
    id: stableId('flow-edge', from, to, label, String(line ?? 0)),
    from,
    to,
    kind,
    label,
    confidence,
    ...(file && line ? { source: { file, line } } : {}),
  };
}

function deduplicateGraph(nodes: DiagramNode[], edges: DiagramEdge[]): void {
  const uniqueNodes = new Map(nodes.map((node) => [node.id, node]));
  const uniqueEdges = new Map<string, DiagramEdge>();
  for (const edge of edges) {
    const key = `${edge.from}\u0000${edge.to}\u0000${edge.label ?? ''}`;
    if (!uniqueEdges.has(key)) {
      uniqueEdges.set(key, edge);
    }
  }
  nodes.splice(0, nodes.length, ...uniqueNodes.values());
  edges.splice(0, edges.length, ...uniqueEdges.values());
}

function extensionOf(filePath: string): string {
  const name = filePath.toLowerCase().split('/').at(-1) ?? '';
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1) : '';
}

function basename(filePath: string): string {
  return normalizePath(filePath).split('/').at(-1) ?? filePath;
}

function normalizePath(filePath: string): string {
  return filePath.replaceAll('\\', '/').replace(/^\.\//, '');
}

function stableId(...parts: string[]): string {
  return parts.map((part) => encodeURIComponent(part)).join(':');
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(1, limit - 1))}…`;
}
