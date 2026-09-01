import {
  chooseSidebarFocus,
  graphHealth,
  sidebarNeighbourhood,
  type SidebarArea,
  type SidebarRelation,
} from '../src/sidebarModel';
import type {
  AnalysisDiagnostic,
  DiagramEdge,
  DiagramGraph,
  DiagramNode,
  ProjectSnapshot,
  SourceRef,
} from '../src/model';

/**
 * A narrow sidebar should answer a narrow question. Instead of duplicating the
 * Explorer or compressing a whole graph into a heatmap, this view follows the
 * file being edited and draws only the immediate code/data neighbourhood. The
 * second screen turns uncertain static-analysis evidence into a review queue.
 */

interface VsCodeApi<State> {
  postMessage(message: unknown): void;
  getState(): State | undefined;
  setState(state: State): void;
}

declare function acquireVsCodeApi<State>(): VsCodeApi<State>;

type ToolView = 'map' | 'checks';

interface PersistedState {
  view?: ToolView;
  area?: SidebarArea;
  following?: boolean;
  focus?: Partial<Record<SidebarArea, string>>;
}

interface ActiveContext {
  path: string;
  moduleNodeId: string;
  structureNodeId: string;
}

interface HostMessage {
  type: 'analysisStarted' | 'analysisStale' | 'analysisError' | 'snapshot' | 'activeContext';
  message?: string;
  snapshot?: ProjectSnapshot;
  active?: ActiveContext | null;
}

const SUPPORTED_SCHEMA_VERSION: number = 1;
const SVG_NS = 'http://www.w3.org/2000/svg';
const MAX_MAP_NEIGHBOURS = 4;
const MAX_CHECK_ITEMS = 20;

const vscode = acquireVsCodeApi<PersistedState>();
const saved = vscode.getState() ?? {};

const projectLabel = findElement<HTMLElement>('ov-project');
const summaryLabel = findElement<HTMLElement>('ov-summary');
const openButton = findElement<HTMLButtonElement>('ov-open');
const refreshButton = findElement<HTMLButtonElement>('ov-refresh');
const mapTab = findElement<HTMLButtonElement>('ov-tab-map');
const checksTab = findElement<HTMLButtonElement>('ov-tab-checks');
const checkCount = findElement<HTMLElement>('ov-check-count');
const mapView = findElement<HTMLElement>('ov-map-view');
const checksView = findElement<HTMLElement>('ov-checks-view');
const currentCard = findElement<HTMLElement>('ov-current');
const codeButton = findElement<HTMLButtonElement>('ov-code');
const dataButton = findElement<HTMLButtonElement>('ov-data');
const followButton = findElement<HTMLButtonElement>('ov-follow');
const searchInput = findElement<HTMLInputElement>('ov-search');
const suggestions = findElement<HTMLElement>('ov-suggestions');
const mapContainer = findElement<HTMLElement>('ov-map');
const focusCard = findElement<HTMLElement>('ov-focus-card');
const checksContainer = findElement<HTMLElement>('ov-checks');
const stateView = findElement<HTMLElement>('ov-state');

let snapshot: ProjectSnapshot | undefined;
let active: ActiveContext | undefined;
let view: ToolView = isToolView(saved.view) ? saved.view : 'map';
let area: SidebarArea = isSidebarArea(saved.area) ? saved.area : 'code';
let following = saved.following ?? true;
const focus: Partial<Record<SidebarArea, string>> = { ...saved.focus };

wireEvents();
renderShell();
vscode.postMessage({ type: 'ready' });

function wireEvents(): void {
  refreshButton.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
  openButton.addEventListener('click', () => openFullDiagram());
  mapTab.addEventListener('click', () => setView('map'));
  checksTab.addEventListener('click', () => setView('checks'));
  codeButton.addEventListener('click', () => setArea('code'));
  dataButton.addEventListener('click', () => setArea('data'));
  followButton.addEventListener('click', () => {
    following = !following;
    if (following && active) {
      focus.code = active.moduleNodeId;
    }
    persist();
    render();
  });

  searchInput.addEventListener('input', () => renderSuggestions());
  searchInput.addEventListener('focus', () => renderSuggestions());
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      searchInput.value = '';
      suggestions.hidden = true;
    } else if (event.key === 'Enter') {
      const first = suggestions.querySelector<HTMLButtonElement>('.ov-suggestion');
      if (first) {
        event.preventDefault();
        first.click();
      }
    }
  });
  searchInput.addEventListener('blur', () => {
    window.setTimeout(() => {
      suggestions.hidden = true;
    }, 120);
  });

  window.addEventListener('message', (event: MessageEvent<unknown>) => {
    const message = parseHostMessage(event.data);
    if (!message) {
      return;
    }
    if (message.type === 'analysisStarted') {
      refreshButton.disabled = true;
      if (!snapshot) {
        showState('Analyzing workspace…');
      }
    } else if (message.type === 'analysisStale') {
      refreshButton.classList.add('needs-attention');
      refreshButton.title = 'The workspace changed. Re-analyze.';
    } else if (message.type === 'analysisError') {
      refreshButton.disabled = false;
      showState(message.message ?? 'Workspace analysis failed.');
    } else if (message.type === 'activeContext') {
      active = message.active ?? undefined;
      if (following && active) {
        focus.code = active.moduleNodeId;
      }
      render();
    } else if (message.type === 'snapshot' && message.snapshot) {
      const received: number = message.snapshot.schemaVersion;
      if (received !== SUPPORTED_SCHEMA_VERSION) {
        showState(`This view expects snapshot schema ${SUPPORTED_SCHEMA_VERSION} but received ${received}. Reload the window.`);
        return;
      }
      snapshot = message.snapshot;
      active = message.active === undefined ? active : message.active ?? undefined;
      if (following && active) {
        focus.code = active.moduleNodeId;
      }
      refreshButton.disabled = false;
      refreshButton.classList.remove('needs-attention');
      refreshButton.title = 'Re-analyze the workspace';
      showState(undefined);
      render();
      vscode.postMessage({ type: 'rendered', revision: snapshot.revision });
    }
  });
}

function setView(next: ToolView): void {
  view = next;
  persist();
  renderShell();
}

function setArea(next: SidebarArea): void {
  if (area === next) {
    return;
  }
  area = next;
  searchInput.value = '';
  suggestions.hidden = true;
  persist();
  render();
}

function render(): void {
  renderShell();
  if (!snapshot) {
    return;
  }
  projectLabel.textContent = snapshot.projectName;
  projectLabel.title = snapshot.projectName;
  summaryLabel.textContent = `${snapshot.stats.modules} modules · ${snapshot.stats.dependencies} links · ${snapshot.stats.databaseEntities} entities`;
  renderCurrentContext();
  renderRelationshipMap();
  renderChecks();
}

function renderShell(): void {
  const mapSelected = view === 'map';
  mapTab.setAttribute('aria-selected', String(mapSelected));
  checksTab.setAttribute('aria-selected', String(!mapSelected));
  mapTab.tabIndex = mapSelected ? 0 : -1;
  checksTab.tabIndex = mapSelected ? -1 : 0;
  mapView.hidden = !mapSelected;
  checksView.hidden = mapSelected;

  codeButton.setAttribute('aria-pressed', String(area === 'code'));
  dataButton.setAttribute('aria-pressed', String(area === 'data'));
  followButton.setAttribute('aria-pressed', String(following));
  followButton.textContent = following ? 'Follows editor' : 'Pinned here';
  followButton.disabled = area === 'data';
  followButton.title = area === 'data'
    ? 'Data entities are selected manually.'
    : following ? 'The center changes with the active editor. Click to keep this module centered.' : 'This module stays centered. Click to follow the active editor.';
  searchInput.placeholder = area === 'code' ? 'Find a module' : 'Find an entity';
}

function renderCurrentContext(): void {
  clearElement(currentCard);
  currentCard.append(element('span', 'ov-eyebrow', 'Working context'));
  if (!active || !snapshot) {
    currentCard.append(
      element('strong', 'ov-current-title', 'No workspace file is active'),
      element('span', 'ov-current-path', 'Open a source file to follow its module here.'),
    );
    return;
  }

  const moduleNode = snapshot.architecture.nodes.find((node) => node.id === active?.moduleNodeId);
  const title = element('strong', 'ov-current-title', moduleNode?.label ?? 'Current module');
  const path = element('span', 'ov-current-path', active.path);
  path.title = active.path;
  const action = document.createElement('button');
  action.type = 'button';
  action.classList.add('ov-text-action');
  action.textContent = area === 'code' && focus.code === active.moduleNodeId ? 'Centered' : 'Center';
  action.disabled = area === 'code' && focus.code === active.moduleNodeId;
  action.addEventListener('click', () => {
    area = 'code';
    following = true;
    focus.code = active?.moduleNodeId;
    view = 'map';
    persist();
    render();
  });
  currentCard.append(title, path, action);
}

function renderRelationshipMap(): void {
  if (!snapshot) {
    return;
  }
  const graph = graphForArea(area);
  const preferred = area === 'code' && following ? active?.moduleNodeId : focus[area];
  const selected = chooseSidebarFocus(graph, preferred);
  if (selected) {
    focus[area] = selected;
  }
  clearElement(mapContainer);
  clearElement(focusCard);

  if (!selected) {
    mapContainer.append(element('div', 'ov-empty', graph.emptyMessage));
    return;
  }
  const neighbourhood = sidebarNeighbourhood(graph, selected, MAX_MAP_NEIGHBOURS);
  if (!neighbourhood) {
    mapContainer.append(element('div', 'ov-empty', 'This item is no longer in the latest analysis.'));
    return;
  }

  const rowCount = Math.max(neighbourhood.incoming.length, neighbourhood.outgoing.length, 1);
  const height = Math.max(190, rowCount * 48 + 44);
  const svg = createSvg('svg');
  svg.classList.add('ov-graph');
  svg.setAttribute('viewBox', `0 0 300 ${height}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `${neighbourhood.focus.label} relationship map`);
  svg.append(buildArrowDefinition());

  const centreY = height / 2 - 20;
  const incomingPositions = positions(neighbourhood.incoming.length, height);
  const outgoingPositions = positions(neighbourhood.outgoing.length, height);
  const edgeLayer = createSvg('g');
  edgeLayer.classList.add('ov-edge-layer');
  neighbourhood.incoming.forEach((relation, index) => {
    const y = incomingPositions[index] ?? centreY;
    edgeLayer.append(buildEdge(91, y + 18, 105, centreY + 20, relation.edge));
  });
  neighbourhood.outgoing.forEach((relation, index) => {
    const y = outgoingPositions[index] ?? centreY;
    edgeLayer.append(buildEdge(195, centreY + 20, 209, y + 18, relation.edge));
  });
  svg.append(edgeLayer);

  neighbourhood.incoming.forEach((relation, index) => {
    svg.append(buildMapNode(relation, 3, incomingPositions[index] ?? centreY));
  });
  svg.append(buildMapFocus(neighbourhood.focus, 105, centreY));
  neighbourhood.outgoing.forEach((relation, index) => {
    svg.append(buildMapNode(relation, 209, outgoingPositions[index] ?? centreY));
  });

  if (!neighbourhood.incoming.length) {
    svg.append(svgText(47, centreY + 22, 'no incoming', 'ov-empty-label'));
  } else if (neighbourhood.hiddenIncoming) {
    svg.append(svgText(47, height - 8, `+${neighbourhood.hiddenIncoming} more`, 'ov-more-label'));
  }
  if (!neighbourhood.outgoing.length) {
    svg.append(svgText(253, centreY + 22, 'no outgoing', 'ov-empty-label'));
  } else if (neighbourhood.hiddenOutgoing) {
    svg.append(svgText(253, height - 8, `+${neighbourhood.hiddenOutgoing} more`, 'ov-more-label'));
  }
  mapContainer.append(svg);
  renderFocusCard(graph, neighbourhood.focus);
}

function buildArrowDefinition(): SVGDefsElement {
  const defs = createSvg('defs');
  const marker = createSvg('marker');
  marker.id = 'ov-arrow';
  marker.setAttribute('viewBox', '0 0 8 8');
  marker.setAttribute('refX', '7');
  marker.setAttribute('refY', '4');
  marker.setAttribute('markerWidth', '6');
  marker.setAttribute('markerHeight', '6');
  marker.setAttribute('orient', 'auto');
  const arrow = createSvg('path');
  arrow.setAttribute('d', 'M 0 0 L 8 4 L 0 8 z');
  marker.append(arrow);
  defs.append(marker);
  return defs;
}

function buildEdge(x1: number, y1: number, x2: number, y2: number, edge: DiagramEdge): SVGPathElement {
  const path = createSvg('path');
  const middle = (x1 + x2) / 2;
  path.setAttribute('d', `M ${x1} ${y1} C ${middle} ${y1}, ${middle} ${y2}, ${x2} ${y2}`);
  path.setAttribute('marker-end', 'url(#ov-arrow)');
  path.classList.add('ov-edge', `is-${edge.confidence}`);
  return path;
}

function buildMapNode(relation: SidebarRelation, x: number, y: number): SVGGElement {
  return buildNodeGroup(relation.node, x, y, false, () => {
    focus[area] = relation.node.id;
    if (area === 'code') {
      following = false;
    }
    searchInput.value = '';
    persist();
    render();
  });
}

function buildMapFocus(node: DiagramNode, x: number, y: number): SVGGElement {
  return buildNodeGroup(node, x, y, true, () => openNodeSource(node));
}

function buildNodeGroup(node: DiagramNode, x: number, y: number, centre: boolean, activate: () => void): SVGGElement {
  const group = createSvg('g');
  group.classList.add('ov-map-node');
  if (centre) {
    group.classList.add('is-focus');
  }
  if (node.kind === 'external-package') {
    group.classList.add('is-external');
  }
  group.setAttribute('transform', `translate(${x} ${y})`);
  group.setAttribute('role', 'button');
  group.setAttribute('tabindex', '0');
  group.setAttribute('aria-label', centre ? `Open ${node.label} source` : `Center map on ${node.label}`);
  const rect = createSvg('rect');
  rect.setAttribute('width', centre ? '90' : '88');
  rect.setAttribute('height', '40');
  rect.setAttribute('rx', '5');
  const label = svgText(centre ? 45 : 44, 17, shorten(node.label, centre ? 15 : 13), 'ov-node-label');
  const kind = svgText(centre ? 45 : 44, 31, shortKind(node), 'ov-node-kind');
  group.append(rect, label, kind);
  group.addEventListener('click', activate);
  group.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      activate();
    }
  });
  const title = createSvg('title');
  title.textContent = node.label;
  group.prepend(title);
  return group;
}

function renderFocusCard(graph: DiagramGraph, node: DiagramNode): void {
  const incoming = graph.edges.filter((edge) => edge.to === node.id && edge.from !== node.id).length;
  const outgoing = graph.edges.filter((edge) => edge.from === node.id && edge.to !== node.id).length;
  const heading = document.createElement('div');
  heading.classList.add('ov-focus-heading');
  const text = document.createElement('div');
  text.append(
    element('strong', 'ov-focus-title', node.label),
    element('span', 'ov-focus-subtitle', node.subtitle ?? node.group ?? node.kind),
  );
  const metrics = document.createElement('div');
  metrics.classList.add('ov-metrics');
  metrics.append(metric('←', incoming, area === 'code' ? 'used by' : 'incoming'), metric('→', outgoing, area === 'code' ? 'uses' : 'outgoing'));
  heading.append(text, metrics);

  const actions = document.createElement('div');
  actions.classList.add('ov-actions');
  const source = actionButton('Open source', () => openNodeSource(node));
  source.disabled = !node.source;
  actions.append(source, actionButton('Open diagram', () => openFullDiagram(node.id)));

  focusCard.append(heading);
  const metadata = Object.entries(node.metadata).filter(([, value]) => String(value).length > 0).slice(0, 3);
  if (metadata.length) {
    const list = document.createElement('dl');
    list.classList.add('ov-metadata');
    for (const [key, value] of metadata) {
      list.append(element('dt', '', key), element('dd', '', Array.isArray(value) ? value.join(', ') : value));
    }
    focusCard.append(list);
  }
  focusCard.append(actions);
}

function renderSuggestions(): void {
  clearElement(suggestions);
  if (!snapshot || document.activeElement !== searchInput) {
    suggestions.hidden = true;
    return;
  }
  const query = normalize(searchInput.value);
  const graph = graphForArea(area);
  const matches = graph.nodes
    .filter((node) => node.kind !== 'external-package' || query.length > 0)
    .filter((node) => !query || normalize(`${node.label} ${node.subtitle ?? ''} ${node.group ?? ''}`).includes(query))
    .sort((left, right) => left.label.localeCompare(right.label))
    .slice(0, 8);
  for (const node of matches) {
    const button = document.createElement('button');
    button.type = 'button';
    button.classList.add('ov-suggestion');
    button.setAttribute('role', 'option');
    button.append(element('strong', '', node.label), element('span', '', node.subtitle ?? node.kind));
    button.addEventListener('click', () => {
      focus[area] = node.id;
      if (area === 'code') {
        following = false;
      }
      searchInput.value = '';
      suggestions.hidden = true;
      persist();
      render();
    });
    suggestions.append(button);
  }
  suggestions.hidden = matches.length === 0;
}

function renderChecks(): void {
  if (!snapshot) {
    return;
  }
  clearElement(checksContainer);
  const code = graphHealth(snapshot.architecture);
  const data = graphHealth(snapshot.database);
  const uncertain = [
    ...code.unresolved.map((edge) => ({ area: 'code' as const, edge })),
    ...data.unresolved.map((edge) => ({ area: 'data' as const, edge })),
    ...code.inferred.map((edge) => ({ area: 'code' as const, edge })),
    ...data.inferred.map((edge) => ({ area: 'data' as const, edge })),
  ];
  const isolated = [
    ...code.isolated.map((node) => ({ area: 'code' as const, node })),
    ...data.isolated.map((node) => ({ area: 'data' as const, node })),
  ];
  const attentionCount = snapshot.diagnostics.length + uncertain.length + isolated.length;
  checkCount.textContent = attentionCount ? String(attentionCount) : '';
  checkCount.hidden = attentionCount === 0;

  const summary = document.createElement('div');
  summary.classList.add('ov-health-summary');
  summary.append(
    healthTile(String(snapshot.diagnostics.length), 'analyzer notes', snapshot.diagnostics.length ? 'is-note' : 'is-clear'),
    healthTile(String(uncertain.length), 'links to review', uncertain.length ? 'is-warning' : 'is-clear'),
    healthTile(String(isolated.length), 'unconnected', isolated.length ? 'is-note' : 'is-clear'),
  );
  checksContainer.append(summary);

  const diagnostics = snapshot.diagnostics.slice(0, MAX_CHECK_ITEMS).map((diagnostic) => diagnosticCheck(diagnostic));
  appendCheckSection(
    'Analyzer notes',
    'Files or syntax the analyzer could not fully interpret.',
    diagnostics,
    snapshot.diagnostics.length - diagnostics.length,
  );

  const relationChecks = uncertain.slice(0, MAX_CHECK_ITEMS).map(({ area: relationArea, edge }) => relationCheck(relationArea, edge));
  appendCheckSection(
    'Links to review',
    'Dashed links were inferred or could not be matched to a target with certainty.',
    relationChecks,
    uncertain.length - relationChecks.length,
  );

  const isolatedChecks = isolated.slice(0, MAX_CHECK_ITEMS).map(({ area: nodeArea, node }) => nodeCheck(nodeArea, node));
  appendCheckSection(
    'Unconnected items',
    'No relationship was detected. Standalone modules and entities can be completely valid.',
    isolatedChecks,
    isolated.length - isolatedChecks.length,
  );

  if (!snapshot.diagnostics.length && !uncertain.length && !isolated.length) {
    checksContainer.append(element('div', 'ov-all-clear', 'No review signals in the current snapshot.'));
  }
}

function diagnosticCheck(diagnostic: AnalysisDiagnostic): HTMLElement {
  const button = checkButton(
    diagnostic.message,
    `${diagnostic.severity === 'warning' ? 'May affect the diagram' : 'For your information'} · ${diagnostic.code}`,
    diagnostic.severity === 'warning' ? 'warning' : 'info',
  );
  const source = diagnostic.source;
  if (source) {
    button.addEventListener('click', () => openSourceRef(source));
  } else {
    button.disabled = true;
  }
  return button;
}

function relationCheck(relationArea: SidebarArea, edge: DiagramEdge): HTMLElement {
  if (!snapshot) {
    return document.createElement('div');
  }
  const graph = graphForArea(relationArea);
  const labels = new Map(graph.nodes.map((node) => [node.id, node.label]));
  const from = labels.get(edge.from) ?? edge.from;
  const to = labels.get(edge.to) ?? edge.to;
  const confidence = edge.confidence === 'unresolved'
    ? 'Target not found'
    : 'Inferred from nearby code';
  const button = checkButton(`${from} → ${to}`, `${confidence} · ${readableKind(edge.kind)}${edge.label ? ` · ${edge.label}` : ''}`, edge.confidence);
  button.addEventListener('click', () => {
    if (edge.source) {
      openSourceRef(edge.source);
    } else {
      centreNode(relationArea, edge.from);
    }
  });
  return button;
}

function nodeCheck(nodeArea: SidebarArea, node: DiagramNode): HTMLElement {
  const button = checkButton(node.label, `${nodeArea === 'code' ? 'Module' : 'Entity'} · no connections detected`, 'info');
  button.addEventListener('click', () => centreNode(nodeArea, node.id));
  return button;
}

function appendCheckSection(title: string, description: string, items: HTMLElement[], remaining: number): void {
  const section = document.createElement('section');
  section.classList.add('ov-check-section');
  section.append(element('h2', '', title), element('p', '', description));
  if (items.length) {
    section.append(...items);
    if (remaining > 0) {
      section.append(element('div', 'ov-check-rest', `+${remaining} more in the full diagram`));
    }
  } else {
    section.append(element('div', 'ov-check-empty', 'None'));
  }
  checksContainer.append(section);
}

function centreNode(nextArea: SidebarArea, nodeId: string): void {
  area = nextArea;
  focus[nextArea] = nodeId;
  if (nextArea === 'code') {
    following = false;
  }
  view = 'map';
  persist();
  render();
}

function openNodeSource(node: DiagramNode): void {
  if (node.source) {
    vscode.postMessage({ type: 'openSource', nodeId: node.id });
  }
}

function openSourceRef(source: SourceRef): void {
  const normalized = source.file.replaceAll('\\', '/').replace(/^\.\//, '');
  vscode.postMessage({ type: 'openSource', nodeId: `structure:${encodeURIComponent(normalized)}` });
}

function openFullDiagram(nodeId = focus[area]): void {
  vscode.postMessage({ type: 'openDiagram', ...(nodeId ? { nodeId } : {}) });
}

function graphForArea(target: SidebarArea): DiagramGraph {
  if (!snapshot) {
    throw new Error('The sidebar graph was requested before analysis completed.');
  }
  return target === 'code' ? snapshot.architecture : snapshot.database;
}

function positions(count: number, height: number): number[] {
  if (!count) {
    return [];
  }
  const usable = height - 44;
  return Array.from({ length: count }, (_, index) => 12 + ((index + 0.5) * usable) / count);
}

function shortKind(node: DiagramNode): string {
  if (node.kind === 'external-package') {
    return 'package';
  }
  return shorten(node.subtitle ?? node.kind.replaceAll('-', ' '), 14);
}

function readableKind(value: string): string {
  return value.replaceAll('-', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function shorten(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, Math.max(1, length - 1))}…`;
}

function metric(symbol: string, value: number, label: string): HTMLElement {
  const item = document.createElement('span');
  item.classList.add('ov-metric');
  item.append(element('b', '', `${symbol} ${value}`), element('small', '', label));
  return item;
}

function healthTile(value: string, label: string, state: string): HTMLElement {
  const tile = document.createElement('div');
  tile.classList.add('ov-health-tile', state);
  tile.append(element('strong', '', value), element('span', '', label));
  return tile;
}

function checkButton(title: string, subtitle: string, state: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.classList.add('ov-check', `is-${state}`);
  const copy = element('span', 'ov-check-copy');
  copy.append(element('strong', '', title), element('small', '', subtitle));
  button.append(element('i', 'ov-check-dot'), copy);
  return button;
}

function actionButton(label: string, action: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.classList.add('ov-action');
  button.textContent = label;
  button.addEventListener('click', action);
  return button;
}

function showState(message: string | undefined): void {
  stateView.textContent = message ?? '';
  stateView.hidden = !message;
}

function persist(): void {
  vscode.setState({ view, area, following, focus: { ...focus } });
}

function element<Tag extends keyof HTMLElementTagNameMap>(tag: Tag, className = '', text = ''): HTMLElementTagNameMap[Tag] {
  const value = document.createElement(tag);
  if (className) {
    value.className = className;
  }
  value.textContent = text;
  return value;
}

function createSvg<Tag extends keyof SVGElementTagNameMap>(tag: Tag): SVGElementTagNameMap[Tag] {
  return document.createElementNS(SVG_NS, tag);
}

function svgText(x: number, y: number, value: string, className: string): SVGTextElement {
  const text = createSvg('text');
  text.setAttribute('x', String(x));
  text.setAttribute('y', String(y));
  text.setAttribute('text-anchor', 'middle');
  text.classList.add(className);
  text.textContent = value;
  return text;
}

function clearElement(value: Element): void {
  value.replaceChildren();
}

function normalize(value: string): string {
  return value.toLowerCase().trim();
}

function findElement<ElementType extends HTMLElement>(id: string): ElementType {
  const value = document.getElementById(id);
  if (!value) {
    throw new Error(`Missing sidebar element #${id}`);
  }
  return value as ElementType;
}

function isToolView(value: unknown): value is ToolView {
  return value === 'map' || value === 'checks';
}

function isSidebarArea(value: unknown): value is SidebarArea {
  return value === 'code' || value === 'data';
}

function parseHostMessage(value: unknown): HostMessage | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  if (!['analysisStarted', 'analysisStale', 'analysisError', 'snapshot', 'activeContext'].includes(String(candidate.type))) {
    return undefined;
  }
  return candidate as unknown as HostMessage;
}
