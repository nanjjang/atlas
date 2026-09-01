import {
  layoutGraph,
  type LayoutFlow,
  type LayoutNode,
  type LayoutGroup,
  type LayoutResult,
  type NodeMetrics,
  type Point,
} from '../src/graphLayout';
import { buildTree, connector, countFiles, type TreeRow } from '../src/treeLayout';
import { ICON_BY_LANGUAGE } from '../src/icons';
import { LANGUAGE_LABELS, languageOf } from '../src/language';
import { routeOrthogonally } from '../src/orthogonalRouter';
import {
  architectureAreaGraph,
  architectureAreaKeyOfNodeId,
  architectureOverviewGraph,
  buildArchitectureMap,
  ARCHITECTURE_AREA_PREFIX,
  ARCHITECTURE_LINK_PREFIX,
  ARCHITECTURE_MODULE_TARGET,
  type ArchitectureArea,
  type ArchitectureMap,
} from '../src/architectureAreas';
import {
  areaKeyOfNodeId,
  areaOverviewGraph,
  buildDatabaseMap,
  entityCountLabel,
  subjectAreaGraph,
  AREA_ENTITY_TARGET,
  type DatabaseMap,
  type SubjectArea,
} from '../src/subjectAreas';
import type {
  DiagramGraph,
  DiagramNode,
  PortBinding,
  ProjectSnapshot,
  ProtocolEndpoint,
  ProtocolSurface,
  SourceRef,
  StructureNode,
} from '../src/model';

interface VsCodeApi<State> {
  postMessage(message: unknown): void;
  getState(): State | undefined;
  setState(state: State): void;
}

declare function acquireVsCodeApi<State>(): VsCodeApi<State>;

type ViewMode = 'architecture' | 'structure' | 'flow' | 'database' | 'interfaces';

interface Camera {
  x: number;
  y: number;
  scale: number;
}

interface PersistedState {
  view?: ViewMode;
  selectedId?: string;
  query?: string;
  flowUnitId?: string;
  /** Architecture level: all modules, the repository-area map, or one area. */
  architectureScope?: string;
  /** The data view's scope: `WHOLE_SCHEMA`, `AREA_MAP`, or a subject-area key. */
  dataScope?: string;
  cameras?: Partial<Record<ViewMode, Camera>>;
  focusMode?: boolean;
  /** Folders shut in the structure view. Everything else is open. */
  collapsed?: string[];
  /** The structure view's text size, as a multiple of the default. */
  treeScale?: number;
}

/** Where the editor is, in this diagram's identifiers. */
interface ActiveContext {
  path: string;
  moduleNodeId: string;
  structureNodeId: string;
}

interface HostMessage {
  type: 'analysisStarted' | 'analysisStale' | 'analysisError' | 'snapshot' | 'activeContext';
  message?: string;
  snapshot?: ProjectSnapshot;
  /** Set when the sidebar opened this panel on one particular node. */
  focusNodeId?: string;
  /** Null clears the marker; undefined means the message carries no opinion. */
  active?: ActiveContext | null;
}

const vscode = acquireVsCodeApi<PersistedState>();
const SVG_NS = 'http://www.w3.org/2000/svg';
// Typed as a plain number: the guard below protects against a host/webview
// version skew that the compile-time literal type cannot see.
const SUPPORTED_SCHEMA_VERSION: number = 1;

/** The furthest in the camera is ever allowed to be, restored or otherwise. */
const MAX_CAMERA_SCALE = 4;
/** How far the structure view's text may be taken from the editor's own size. */
const MIN_TREE_SCALE = 0.7;
const MAX_TREE_SCALE = 2;
/**
 * Rows the structure view will draw before it stops and says so. A tree is one
 * element per entry, and a workspace exists that would make that a hundred
 * thousand of them; the search narrows it, which is what it is there for.
 */
const MAX_TREE_ROWS = 6000;
/** The data view's scope when the reader wants every table on one canvas. */
const WHOLE_SCHEMA = '__whole__';
/** …and when they want the map of the subject areas instead. */
const AREA_MAP = '__map__';
const WHOLE_ARCHITECTURE = '__architecture_whole__';
const ARCHITECTURE_MAP = '__architecture_map__';
const saved = vscode.getState() ?? {};

const projectName = findElement<HTMLElement>('project-name');
const projectSummary = findElement<HTMLElement>('project-summary');
const refreshButton = findElement<HTMLButtonElement>('refresh-button');
const architectureScopeLabel = findElement<HTMLElement>('architecture-scope-label');
const architectureScopeSelect = findElement<HTMLSelectElement>('architecture-scope');
const flowScopeLabel = findElement<HTMLElement>('flow-scope-label');
const flowScopeSelect = findElement<HTMLSelectElement>('flow-scope');
const dataScopeLabel = findElement<HTMLElement>('data-scope-label');
const dataScopeSelect = findElement<HTMLSelectElement>('data-scope');
const exportButton = findElement<HTMLButtonElement>('export-button');
const searchInput = findElement<HTMLInputElement>('search-input');
const zoomOutButton = findElement<HTMLButtonElement>('zoom-out');
const zoomInButton = findElement<HTMLButtonElement>('zoom-in');
const fitButton = findElement<HTMLButtonElement>('fit-button');
const focusButton = findElement<HTMLButtonElement>('focus-button');
const foldButton = findElement<HTMLButtonElement>('fold-button');
const canvasPanel = findElement<HTMLElement>('canvas-panel');
const graphCanvas = findElement<SVGSVGElement>('graph-canvas');
const viewportGroup = findElement<SVGGElement>('viewport-group');
const structureDashboard = findElement<HTMLElement>('structure-dashboard');
const interfaceDashboard = findElement<HTMLElement>('interface-dashboard');
const interfaceGrid = findElement<HTMLElement>('interface-grid');
const dashGrid = findElement<HTMLElement>('dash-grid');
const structureTree = findElement<HTMLElement>('structure-tree');
const stateView = findElement<HTMLElement>('state-view');
const stateMessage = findElement<HTMLElement>('state-message');
const detailsContent = findElement<HTMLElement>('details-content');
const statusText = findElement<HTMLElement>('status-text');
const technologyList = findElement<HTMLElement>('technology-list');
const announcer = findElement<HTMLElement>('announcer');
const viewGuideTitle = findElement<HTMLElement>('view-guide-title');
const viewGuideDescription = findElement<HTMLElement>('view-guide-description');
const viewGuideLegend = findElement<HTMLElement>('view-guide-legend');
const tabCounts: Record<ViewMode, HTMLElement> = {
  architecture: findElement<HTMLElement>('tab-count-architecture'),
  structure: findElement<HTMLElement>('tab-count-structure'),
  flow: findElement<HTMLElement>('tab-count-flow'),
  database: findElement<HTMLElement>('tab-count-database'),
  interfaces: findElement<HTMLElement>('tab-count-interfaces'),
};
const tabs = [...document.querySelectorAll<HTMLButtonElement>('.view-tab')];

let snapshot: ProjectSnapshot | undefined;
let activeView: ViewMode = isViewMode(saved.view) ? saved.view : 'architecture';
let selectedId = saved.selectedId;
let flowUnitId = saved.flowUnitId;
let architectureScope = saved.architectureScope;
let architectureMap: ArchitectureMap | undefined;
let scopedArchitecture: { key: string; graph: DiagramGraph } | undefined;
/**
 * What the data view is showing: the whole schema, the map of its subject
 * areas, or one area. Defaults to the map once a schema is too large to be read
 * in one piece, which is the size at which drawing it in one piece stopped
 * telling anybody anything.
 */
let dataScope = saved.dataScope;
/** The subject areas of the current snapshot's schema; see `src/subjectAreas.ts`. */
let databaseMap: DatabaseMap | undefined;
/** The last graph cut out of the schema, kept for the redraw that asks repeatedly. */
let scopedGraph: { key: string; graph: DiagramGraph } | undefined;
let searchQuery = saved.query ?? '';
let currentLayout: LayoutResult | undefined;
let isPanning = false;
let panPointerId: number | undefined;
let panOrigin = { x: 0, y: 0 };
let cameraOrigin = { x: 0, y: 0 };
const cameras: Record<ViewMode, Camera> = {
  architecture: normalizeCamera(saved.cameras?.architecture),
  flow: normalizeCamera(saved.cameras?.flow),
  database: normalizeCamera(saved.cameras?.database),
  structure: normalizeCamera(saved.cameras?.structure),
  interfaces: normalizeCamera(saved.cameras?.interfaces),
};
const needsFit = new Set<ViewMode>();
let active: ActiveContext | undefined;
// On by default: a diagram kept open beside the code is there to answer "what
// does this file touch", and the whole graph drowns that out.
let focusMode = saved.focusMode ?? true;
let framedNodeId: string | undefined;
/** The box `fit` works to, whichever view drew it. */
let contentBounds: { minX: number; minY: number; maxX: number; maxY: number } | undefined;
/**
 * The structure view opens everything, the way `tree` does, and remembers what
 * the reader shut rather than what they opened: a workspace whose shape you
 * cannot see until you have clicked twenty folders open has not shown you its
 * shape.
 */
const collapsedPaths = new Set<string>(saved.collapsed ?? []);
let treeScale = clamp(saved.treeScale ?? 1, MIN_TREE_SCALE, MAX_TREE_SCALE);
/** The file the tree last opened itself for; see `applyActiveStyles`. */
let revealedPath: string | undefined;
/**
 * Whether an entity card is showing its columns.
 *
 * A card listing ten columns is five times the area of one showing a name, and
 * on a schema of a hundred and fifty entities that difference is the whole
 * diagram: with the columns drawn, `fit` lands at a zoom where none of them can
 * be read anyway. So above a certain size the cards become names, the columns
 * move to the details panel, and what the canvas shows is the map.
 */
let detailedCards = true;
/**
 * Whether an entity card is showing its keys.
 *
 * Between the two extremes there is a card worth drawing: the primary key and
 * the foreign keys and nothing else. That is what a reader traces a
 * relationship with, it is what the line arriving at the card refers to, and it
 * costs three rows instead of fifteen.
 */
let keyedCards = true;
/** Columns that carry a relationship, per node, taken from the edges. */
let keyColumns = new Map<string, Set<string>>();

/**
 * How each diagram is laid out.
 *
 * This is a property of the diagram, not a preference: a flowchart *is* its
 * direction, so it is ranked into columns with the arrows pointing one way,
 * which is the whole of what makes it followable. A module map and a schema have
 * no reading order to lose — nearly every table points at the same few tables —
 * so they are spread over the plane by neighbourhood, where the frames around
 * related things are the thing worth seeing.
 *
 * It used to be a three-way toggle in the toolbar. Every setting other than
 * these was worse for the diagram it was applied to, so the control only offered
 * the reader ways to make the picture harder to read.
 */
const ARRANGEMENT_BY_KIND: Record<DiagramGraph['kind'], LayoutFlow> = {
  flow: 'flow',
  architecture: 'spread',
  database: 'spread',
};

searchInput.value = searchQuery;
focusButton.setAttribute('aria-pressed', String(focusMode));
renderFoldButton();
wireEvents();
renderTabs();
showState('Analyzing workspace…', 'loading');
vscode.postMessage({ type: 'ready' });

function wireEvents(): void {
  refreshButton.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
  architectureScopeSelect.addEventListener('change', () => setArchitectureScope(architectureScopeSelect.value));
  flowScopeSelect.addEventListener('change', () => {
    flowUnitId = flowScopeSelect.value || undefined;
    selectedId = undefined;
    needsFit.add('flow');
    render();
    persistState();
  });
  dataScopeSelect.addEventListener('change', () => setDataScope(dataScopeSelect.value));
  exportButton.addEventListener('click', () => vscode.postMessage({ type: 'exportSchema' }));
  fitButton.addEventListener('click', () => fitCurrentGraph());
  focusButton.addEventListener('click', () => {
    focusMode = !focusMode;
    focusButton.setAttribute('aria-pressed', String(focusMode));
    framedNodeId = undefined;
    applyFocusStyles();
    fitCurrentGraph();
    persistState();
    renderViewGuide();
    announce(focusMode ? 'Showing the focus item and its direct neighbours.' : 'Showing the complete current scope.');
  });
  foldButton.addEventListener('click', () => toggleWholeTree());
  zoomInButton.addEventListener('click', () => zoomBy(1.2));
  zoomOutButton.addEventListener('click', () => zoomBy(1 / 1.2));

  for (const tab of tabs) {
    tab.addEventListener('click', () => {
      const view = tab.dataset.view;
      if (!isViewMode(view)) {
        return;
      }
      activeView = view;
      selectedId = undefined;
      render();
      persistState();
    });
    tab.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
        return;
      }
      event.preventDefault();
      const index = tabs.indexOf(tab);
      const direction = event.key === 'ArrowRight' ? 1 : -1;
      const next = tabs[(index + direction + tabs.length) % tabs.length];
      next?.focus();
      next?.click();
    });
  }

  searchInput.addEventListener('input', () => {
    searchQuery = searchInput.value;
    if (isBoardView(activeView)) {
      scheduleBoardSearch();
    } else {
      applyGraphSearch();
    }
    persistState();
  });
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      searchInput.value = '';
      searchQuery = '';
      render();
      persistState();
    } else if (event.key === 'Enter') {
      focusFirstSearchMatch();
    }
  });

  window.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      searchInput.focus();
      searchInput.select();
    }
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLButtonElement) {
      return;
    }
    if (event.key === '+' || event.key === '=') zoomBy(1.2);
    if (event.key === '-') zoomBy(1 / 1.2);
    if (event.key.toLowerCase() === 'f') fitCurrentGraph();
  });

  wireStructureEvents();
  wireInterfaceEvents();

  graphCanvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    const rect = graphCanvas.getBoundingClientRect();
    zoomBy(event.deltaY < 0 ? 1.12 : 1 / 1.12, event.clientX - rect.left, event.clientY - rect.top);
  }, { passive: false });

  graphCanvas.addEventListener('pointerdown', (event) => {
    const target = event.target;
    if (target instanceof Element && target.closest('.graph-node')) {
      return;
    }
    isPanning = true;
    panPointerId = event.pointerId;
    panOrigin = { x: event.clientX, y: event.clientY };
    const camera = graphCamera();
    cameraOrigin = { x: camera.x, y: camera.y };
    graphCanvas.setPointerCapture(event.pointerId);
    graphCanvas.classList.add('is-panning');
  });

  graphCanvas.addEventListener('pointermove', (event) => {
    if (!isPanning || panPointerId !== event.pointerId) {
      return;
    }
    const camera = graphCamera();
    camera.x = cameraOrigin.x + event.clientX - panOrigin.x;
    camera.y = cameraOrigin.y + event.clientY - panOrigin.y;
    applyCamera();
  });

  const stopPan = (event: PointerEvent): void => {
    if (panPointerId !== event.pointerId) {
      return;
    }
    isPanning = false;
    panPointerId = undefined;
    graphCanvas.classList.remove('is-panning');
    persistState();
  };
  graphCanvas.addEventListener('pointerup', stopPan);
  graphCanvas.addEventListener('pointercancel', stopPan);

  window.addEventListener('message', (event: MessageEvent<unknown>) => {
    const message = parseHostMessage(event.data);
    if (!message) {
      return;
    }
    if (message.type === 'analysisStarted') {
      refreshButton.disabled = true;
      showState('Analyzing workspace…', 'loading');
    } else if (message.type === 'analysisStale') {
      statusText.textContent = 'Workspace changed while this view was hidden. Re-analyze to update.';
      refreshButton.classList.add('needs-attention');
    } else if (message.type === 'analysisError') {
      refreshButton.disabled = false;
      showState(message.message ?? 'Workspace analysis failed.', 'error');
    } else if (message.type === 'activeContext') {
      active = message.active ?? undefined;
      applyActiveStyles();
    } else if (message.type === 'snapshot' && message.snapshot) {
      const receivedSchema: number = message.snapshot.schemaVersion;
      if (receivedSchema !== SUPPORTED_SCHEMA_VERSION) {
        refreshButton.disabled = false;
        showState(
          `This view expects snapshot schema ${SUPPORTED_SCHEMA_VERSION} but received ${receivedSchema}. Reload the window to pick up the matching webview bundle.`,
          'error',
        );
        return;
      }
      snapshot = message.snapshot;
      refreshButton.disabled = false;
      refreshButton.classList.remove('needs-attention');
      needsFit.add('architecture');
      needsFit.add('flow');
      needsFit.add('database');
      needsFit.add('structure');
      needsFit.add('interfaces');
      if (message.active !== undefined) {
        active = message.active ?? undefined;
      }
      databaseMap = buildDatabaseMap(snapshot.database);
      architectureMap = buildArchitectureMap(snapshot.architecture);
      renderArchitectureScopeOptions();
      renderFlowScopeOptions();
      renderDataScopeOptions();
      render();
      if (message.focusNodeId) {
        focusOnNode(message.focusNodeId);
      }
      vscode.postMessage({ type: 'rendered', revision: message.snapshot.revision });
    }
  });

  new ResizeObserver(() => {
    // The board views are text in a scroller, so they reflow on their own.
    if (graphCanvas.clientWidth <= 0 || isBoardView(activeView)) {
      return;
    }
    if (currentLayout) {
      applyCamera();
    }
  }).observe(canvasPanel);
}

/**
 * Filtering the tree rebuilds every row, so it waits for a pause in the typing
 * rather than doing it between two keystrokes.
 */
const scheduleBoardSearch = debounce(() => {
  if (activeView === 'structure') {
    renderStructure();
  } else if (activeView === 'interfaces') {
    renderInterfaces();
  }
}, 120);

function render(): void {
  renderTabs();
  if (!snapshot) {
    return;
  }
  projectName.textContent = snapshot.projectName;
  projectSummary.textContent = [
    `${snapshot.stats.files} files`,
    `${snapshot.stats.codeFiles} source`,
    `${snapshot.stats.modules} modules`,
    `${snapshot.stats.dependencies} dependencies`,
    `${snapshot.stats.flowUnits} flows`,
    `${snapshot.stats.databaseEntities} entities`,
    `${snapshot.stats.databaseRelations} relations`,
    `${snapshot.stats.endpoints} endpoints`,
  ].join(' · ');
  technologyList.textContent = snapshot.technologies.length ? snapshot.technologies.join(' · ') : 'No framework signature detected';

  // The Files and Interfaces views are scrollable pages, not camera canvases.
  const structural = activeView === 'structure';
  const board = isBoardView(activeView);
  architectureScopeLabel.hidden = activeView !== 'architecture';
  flowScopeLabel.hidden = activeView !== 'flow';
  dataScopeLabel.hidden = activeView !== 'database';
  // Only where it means something: what it writes out is the schema.
  setHidden(exportButton, activeView !== 'database' || snapshot.database.nodes.length === 0);
  setHidden(zoomOutButton, board);
  setHidden(zoomInButton, board);
  setHidden(fitButton, board);
  setHidden(focusButton, board);
  focusButton.disabled = !['architecture', 'database'].includes(activeView) || !focusTargetNodeId();
  renderFoldButton();
  setHidden(graphCanvas, board);
  setHidden(structureDashboard, !structural);
  setHidden(interfaceDashboard, activeView !== 'interfaces');
  stateView.hidden = true;

  if (structural) {
    renderStructure();
  } else if (activeView === 'interfaces') {
    renderInterfaces();
  } else {
    const graph = currentGraph();
    if (graph) {
      renderGraph(graph);
    }
  }
  renderDetails();
  renderStatus();
  applyActiveStyles();
  persistState();
}

/**
 * Marks where the editor is and, in focus mode, pushes everything more than one
 * relationship away into the background. The point of the diagram sitting beside
 * the code is the neighbourhood of the file being edited, not the whole map.
 */
function applyActiveStyles(): void {
  if (activeView === 'interfaces') {
    // Nothing here belongs to one file the way a module or a tree row does: an
    // endpoint is a declaration, and the editor being inside the file holding it
    // does not make it the reader's place in this view.
    return;
  }
  if (activeView === 'structure') {
    // The file being edited may be inside a folder the reader shut, and opening
    // the way to it rebuilds the rows. Only when the file itself changes,
    // though: doing it on every redraw would mean a folder holding the open
    // file could not be collapsed at all, because the next redraw reopened it.
    const following = active && active.path !== revealedPath ? active.path : undefined;
    revealedPath = active?.path;
    if (following !== undefined && revealAncestors(following)) {
      renderStructure();
    } else {
      applyStructureSelection();
    }
    if (active) {
      ensureRowVisible(active.structureNodeId);
    }
    return;
  }
  for (const element of viewportGroup.querySelectorAll<SVGGElement>('.graph-node')) {
    element.classList.toggle('is-current', element.dataset.nodeId === currentGraphNodeId());
  }
  applyFocusStyles();
  const currentId = currentGraphNodeId();
  if (focusMode && currentId) {
    // Reframing only when the module changes keeps the camera still while you
    // move between files that live in the same one.
    if (currentId !== framedNodeId) {
      framedNodeId = currentId;
      fitCurrentGraph();
    }
  } else {
    framedNodeId = undefined;
    ensureCurrentNodeVisible();
  }
}

/** The active file's node, but only in the view that actually contains it. */
function currentGraphNodeId(): string | undefined {
  if (!active || activeView !== 'architecture') {
    return undefined;
  }
  const activeModuleId = active.moduleNodeId;
  if (architectureScope === ARCHITECTURE_MAP) {
    const area = architectureMap?.areaOf.get(activeModuleId);
    return area ? ARCHITECTURE_AREA_PREFIX + area : undefined;
  }
  const graph = currentGraph();
  if (graph?.nodes.some((node) => node.id === activeModuleId)) return activeModuleId;
  const area = architectureMap?.areaOf.get(activeModuleId);
  return area && graph?.nodes.some((node) => node.id === ARCHITECTURE_LINK_PREFIX + area)
    ? ARCHITECTURE_LINK_PREFIX + area : undefined;
}

function applyFocusStyles(): void {
  const currentId = focusTargetNodeId();
  const engaged = focusMode && Boolean(currentId) && (activeView === 'architecture' || activeView === 'database');
  viewportGroup.classList.toggle('is-focused', engaged);
  if (!engaged || !currentId || !snapshot) {
    for (const element of viewportGroup.querySelectorAll<Element>('.graph-node, .graph-edge')) {
      element.classList.remove('is-out-of-focus');
    }
    return;
  }

  const neighbourhood = new Set<string>([currentId]);
  for (const edge of currentGraph()?.edges ?? []) {
    if (edge.from === currentId) neighbourhood.add(edge.to);
    if (edge.to === currentId) neighbourhood.add(edge.from);
  }
  for (const element of viewportGroup.querySelectorAll<SVGGElement>('.graph-node')) {
    const id = element.dataset.nodeId;
    element.classList.toggle('is-out-of-focus', !id || !neighbourhood.has(id));
  }
  for (const element of viewportGroup.querySelectorAll<SVGGElement>('.graph-edge')) {
    const touches = element.dataset.from === currentId || element.dataset.to === currentId;
    element.classList.toggle('is-out-of-focus', !touches);
  }
}

/** Active module when available; otherwise the selected architecture/data node. */
function focusTargetNodeId(): string | undefined {
  const current = currentGraphNodeId();
  if (current) return current;
  if ((activeView === 'architecture' || activeView === 'database')
    && selectedId && currentGraph()?.nodes.some((node) => node.id === selectedId)) {
    return selectedId;
  }
  return undefined;
}

/**
 * Pans to the active node only when it is off screen. Recentring on every file
 * switch would move the diagram under the reader for no reason.
 */
function ensureCurrentNodeVisible(): void {
  const currentId = currentGraphNodeId();
  const positioned = currentId ? currentLayout?.nodeById.get(currentId) : undefined;
  if (!positioned) {
    return;
  }
  const width = graphCanvas.clientWidth;
  const height = graphCanvas.clientHeight;
  if (width <= 0 || height <= 0) {
    return;
  }
  const camera = graphCamera();
  const left = positioned.x * camera.scale + camera.x;
  const top = positioned.y * camera.scale + camera.y;
  const right = left + positioned.width * camera.scale;
  const bottom = top + positioned.height * camera.scale;
  const margin = 24;
  if (left >= margin && top >= margin && right <= width - margin && bottom <= height - margin) {
    return;
  }
  camera.x = width / 2 - (positioned.x + positioned.width / 2) * camera.scale;
  camera.y = height / 2 - (positioned.y + positioned.height / 2) * camera.scale;
  applyCamera();
  persistState();
}

/** Scrolls the tree to a row, but only when the row is not already on screen. */
function ensureRowVisible(nodeId: string): void {
  const row = structureTree.querySelector<HTMLElement>(`[data-node-id="${escapeAttribute(nodeId)}"]`);
  if (!row) {
    return;
  }
  const view = structureTree.getBoundingClientRect();
  const box = row.getBoundingClientRect();
  if (box.top >= view.top && box.bottom <= view.bottom) {
    return;
  }
  row.scrollIntoView({ block: 'center' });
}

/**
 * Folds the structure view's file tree. It belongs to that view alone: a graph
 * has no folders to shut, and its arrangement is no longer something the reader
 * is asked to choose.
 */
function renderFoldButton(): void {
  // The full tree belongs to Explorer/the sidebar. The Files view is now an
  // overview dashboard, so there is no folder hierarchy here to fold.
  setHidden(foldButton, true);
}

function renderTabs(): void {
  for (const tab of tabs) {
    const selected = tab.dataset.view === activeView;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  renderViewGuide();
}

/**
 * Explains each canvas in the same place. The diagrams use compact visual
 * conventions; keeping their meaning visible is more useful than asking a
 * first-time reader to discover it from hover text.
 */
function renderViewGuide(): void {
  const guides: Record<ViewMode, { title: string; description: string; search: string; legend: string }> = {
    architecture: {
      title: 'Module relationships',
      description: 'Folders group modules. An arrow points from the module using code to the module it uses.',
      search: 'Search modules',
      legend: 'confidence',
    },
    structure: {
      title: 'Codebase overview',
      description: 'Where the project starts, what it leans on, where its weight and its gaps are. Click a row to inspect it, double-click to open the file.',
      search: 'Search files, modules or dependencies',
      legend: 'files',
    },
    flow: {
      title: 'Detected code flow',
      description: 'Follow declared routes, calls, and branches. This is static analysis, not a runtime trace.',
      search: 'Search flow steps',
      legend: 'confidence',
    },
    database: {
      title: 'Data relationships',
      description: 'Explore schema areas and declared entity links. No live database connection is used.',
      search: 'Search tables or entities',
      legend: 'confidence',
    },
    interfaces: {
      title: 'Protocols, ports, and endpoints',
      description: 'What this project exposes at its edges, and where. Click a row to see the declaration behind it, double-click to open it.',
      search: 'Search endpoints, topics or ports',
      legend: 'none',
    },
  };
  const guide = guides[activeView];
  viewGuideTitle.textContent = guide.title;
  viewGuideDescription.textContent = guide.description;
  viewGuideLegend.hidden = guide.legend !== 'confidence';
  searchInput.placeholder = guide.search;

  focusButton.textContent = focusMode ? 'Nearby' : 'Whole scope';
  focusButton.title = focusMode
    ? 'Showing the active or selected item and direct neighbours. Click to show the complete current scope.'
    : 'Showing the complete current scope. Click to focus on the active or selected item and direct neighbours.';

  if (!snapshot) {
    return;
  }
  tabCounts.architecture.textContent = String(snapshot.stats.modules);
  tabCounts.structure.textContent = String(snapshot.stats.files);
  tabCounts.flow.textContent = String(snapshot.stats.flowUnits);
  tabCounts.database.textContent = String(snapshot.stats.databaseEntities);
  tabCounts.interfaces.textContent = String(snapshot.stats.endpoints || snapshot.stats.ports);
}

function renderArchitectureScopeOptions(): void {
  if (!snapshot || !architectureMap) return;
  const known = architectureScope === WHOLE_ARCHITECTURE
    || architectureScope === ARCHITECTURE_MAP
    || architectureMap.areas.some((area) => area.key === architectureScope);
  if (!known) architectureScope = architectureMap.usesAreas ? ARCHITECTURE_MAP : WHOLE_ARCHITECTURE;
  if (architectureScope === ARCHITECTURE_MAP && architectureMap.areas.length < 2) {
    architectureScope = WHOLE_ARCHITECTURE;
  }
  clearElement(architectureScopeSelect);
  const add = (parent: HTMLElement | HTMLSelectElement, value: string, label: string, title?: string): void => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    option.selected = value === architectureScope;
    if (title) option.title = title;
    parent.append(option);
  };
  if (architectureMap.areas.length >= 2) {
    add(architectureScopeSelect, ARCHITECTURE_MAP, `Repository map (${architectureMap.areas.length} areas)`,
      'A readable overview with repeated module dependencies combined between repository areas.');
  }
  add(architectureScopeSelect, WHOLE_ARCHITECTURE, `All modules (${architectureMap.modules})`,
    architectureMap.modules > ARCHITECTURE_MODULE_TARGET
      ? 'The complete module graph. Use the repository map or one area when this view becomes dense.'
      : 'Every detected module on one canvas.');
  if (architectureMap.areas.length) {
    const group = document.createElement('optgroup');
    group.label = 'Repository areas';
    for (const area of architectureMap.areas) {
      add(group, area.key, `${area.label} — ${area.modules} modules · ${area.files} files`);
    }
    architectureScopeSelect.append(group);
  }
  architectureScopeSelect.disabled = architectureMap.modules === 0;
}

function setArchitectureScope(scope: string, selectId?: string): void {
  architectureScope = scope;
  selectedId = selectId;
  framedNodeId = undefined;
  needsFit.add('architecture');
  renderArchitectureScopeOptions();
  render();
  if (selectId) centerNode(selectId);
  persistState();
}

function openArchitectureArea(key: string, selectId?: string): void {
  const area = architectureMap?.areas.find((candidate) => candidate.key === key);
  setArchitectureScope(area ? key : ARCHITECTURE_MAP, selectId);
  announce(area
    ? `${area.label}: ${area.modules} modules, ${area.crossDependencies} dependencies crossing the boundary.`
    : 'Repository area map.');
}

function currentArchitectureArea(): ArchitectureArea | undefined {
  if (architectureScope === WHOLE_ARCHITECTURE || architectureScope === ARCHITECTURE_MAP) return undefined;
  return architectureMap?.areas.find((area) => area.key === architectureScope);
}

function renderFlowScopeOptions(): void {
  if (!snapshot) {
    return;
  }
  const units = snapshot.flow.units;
  if (!units.some((unit) => unit.id === flowUnitId)) {
    flowUnitId = recommendedFlowUnit(units)?.id;
  }
  clearElement(flowScopeSelect);
  const labels: Record<(typeof units)[number]['kind'], string> = {
    project: 'Overview',
    service: 'Service flows',
    file: 'Focused code flows',
  };
  for (const kind of ['file', 'service', 'project'] as const) {
    const matching = units.filter((unit) => unit.kind === kind);
    if (!matching.length) {
      continue;
    }
    const group = document.createElement('optgroup');
    group.label = labels[kind];
    for (const unit of matching) {
      const option = document.createElement('option');
      option.value = unit.id;
      option.textContent = unit.label;
      option.selected = unit.id === flowUnitId;
      group.append(option);
    }
    flowScopeSelect.append(group);
  }
  flowScopeSelect.disabled = units.length === 0;
}

/** Prefer the smallest source-backed flow that still has a path to follow. */
function recommendedFlowUnit(units: ProjectSnapshot['flow']['units']) {
  const readable = units
    .filter((unit) => unit.kind === 'file' && unit.graph.edges.length > 0 && unit.graph.nodes.length <= 20)
    .sort((left, right) => {
      const leftBranches = left.graph.nodes.filter((node) => node.kind === 'decision' || node.kind === 'start').length;
      const rightBranches = right.graph.nodes.filter((node) => node.kind === 'decision' || node.kind === 'start').length;
      return rightBranches - leftBranches
        || right.graph.edges.length - left.graph.edges.length
        || left.graph.nodes.length - right.graph.nodes.length
        || left.label.localeCompare(right.label);
    });
  return readable[0]
    ?? units.find((unit) => unit.kind === 'file' && unit.graph.edges.length > 0)
    ?? units.find((unit) => unit.kind === 'service')
    ?? units.find((unit) => unit.kind === 'project')
    ?? units[0];
}

function selectedFlowUnit() {
  return snapshot?.flow.units.find((unit) => unit.id === flowUnitId)
    ?? snapshot?.flow.units[0];
}

/**
 * The scopes the data view offers.
 *
 * A schema small enough to read whole opens whole, and the areas are there for
 * anyone who wants them. Past that size the map of the areas comes first, and
 * the whole schema stays on the list as what it actually is — every table at
 * once, which is a thing to look at rather than a thing to read.
 */
function renderDataScopeOptions(): void {
  if (!snapshot || !databaseMap) {
    return;
  }
  const known = dataScope === WHOLE_SCHEMA
    || dataScope === AREA_MAP
    || databaseMap.areas.some((area) => area.key === dataScope);
  if (!known) {
    dataScope = databaseMap.usesAreas ? AREA_MAP : WHOLE_SCHEMA;
  } else if (dataScope === AREA_MAP && databaseMap.areas.length < 2) {
    dataScope = WHOLE_SCHEMA;
  }
  clearElement(dataScopeSelect);
  const add = (parent: HTMLElement | HTMLSelectElement, value: string, text: string, title?: string): void => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    if (title) option.title = title;
    option.selected = value === dataScope;
    parent.append(option);
  };
  if (databaseMap.areas.length >= 2) {
    add(dataScopeSelect, AREA_MAP, `All areas — map (${databaseMap.areas.length})`,
      'One card per subject area, and the relationships that cross between them.');
  }
  add(dataScopeSelect, WHOLE_SCHEMA, `Whole schema (${entityCountLabel(databaseMap.entities, databaseMap.noun)})`,
    databaseMap.entities > AREA_ENTITY_TARGET
      ? `Every ${databaseMap.noun} at once. Past about ${AREA_ENTITY_TARGET} of them this is a picture of the schema's size, not a diagram of it.`
      : `Every ${databaseMap.noun} at once.`);
  if (databaseMap.areas.length) {
    const group = document.createElement('optgroup');
    group.label = 'Subject areas';
    for (const area of databaseMap.areas) {
      add(group, area.key,
        `${area.label} — ${entityCountLabel(area.entities, area.noun)}${area.oversized ? ' ⚠' : ''}`,
        area.origin);
    }
    dataScopeSelect.append(group);
  }
  dataScopeSelect.disabled = snapshot.database.nodes.length === 0;
}

/** Moves the data view to another scope, keeping the reader's place in it. */
function setDataScope(scope: string, selectId?: string): void {
  dataScope = scope;
  selectedId = selectId;
  needsFit.add('database');
  renderDataScopeOptions();
  render();
  if (selectId !== undefined) centerNode(selectId);
  persistState();
}

/**
 * Opens one subject area's diagram, from a card on the map or from the card a
 * boundary line runs to. `key` may name an area a later analysis dropped, in
 * which case there is still somewhere sensible to land: the map.
 */
function openArea(key: string, selectId?: string): void {
  const area = databaseMap?.areas.find((candidate) => candidate.key === key);
  setDataScope(area ? key : AREA_MAP, selectId);
  announce(area
    ? `${area.label}: ${area.entities} tables, ${area.crossRelations} relationships leaving the area.`
    : 'Subject area map.');
}

/** The subject area the data view is scoped to, if it is scoped to one. */
function currentArea(): SubjectArea | undefined {
  if (dataScope === WHOLE_SCHEMA || dataScope === AREA_MAP) {
    return undefined;
  }
  return databaseMap?.areas.find((area) => area.key === dataScope);
}

function currentGraph(): DiagramGraph | undefined {
  if (!snapshot || isBoardView(activeView)) {
    return undefined;
  }
  if (activeView === 'architecture') {
    if (!architectureMap || architectureScope === undefined || architectureScope === WHOLE_ARCHITECTURE) {
      return snapshot.architecture;
    }
    const cacheKey = `${snapshot.revision}\u0000${architectureScope}`;
    if (scopedArchitecture?.key !== cacheKey) {
      scopedArchitecture = {
        key: cacheKey,
        graph: architectureScope === ARCHITECTURE_MAP
          ? architectureOverviewGraph(snapshot.architecture, architectureMap)
          : architectureAreaGraph(snapshot.architecture, architectureMap, architectureScope),
      };
    }
    return scopedArchitecture.graph;
  }
  if (activeView === 'flow') {
    return selectedFlowUnit()?.graph ?? {
      kind: 'flow',
      nodes: [],
      edges: [],
      emptyMessage: snapshot.flow.emptyMessage,
    };
  }
  if (!databaseMap || dataScope === undefined || dataScope === WHOLE_SCHEMA) {
    return snapshot.database;
  }
  // Held on to: a redraw asks for the current graph half a dozen times over
  // (status, details, selection, search), and cutting one out of the schema
  // walks every relationship in it each time.
  const cacheKey = `${snapshot.revision}\u0000${dataScope}`;
  if (scopedGraph?.key !== cacheKey) {
    scopedGraph = {
      key: cacheKey,
      graph: dataScope === AREA_MAP
        ? areaOverviewGraph(databaseMap)
        : subjectAreaGraph(snapshot.database, databaseMap, dataScope),
    };
  }
  return scopedGraph.graph;
}

function renderGraph(graph: DiagramGraph): void {
  clearElement(viewportGroup);
  currentLayout = undefined;
  contentBounds = undefined;
  if (!graph.nodes.length) {
    showState(graph.emptyMessage, 'empty');
    setHidden(graphCanvas, true);
    return;
  }
  setHidden(graphCanvas, false);
  stateView.hidden = true;
  const layout = layoutGraphFor(graph);
  currentLayout = layout;
  const routes = routeGraph(layout, graph);
  contentBounds = boundsOver(layout, routes);

  const edgeLayer = createSvgElement('g');
  edgeLayer.classList.add('edge-layer', `flow-${layout.flow}`);
  // On a dense graph a label on every edge is noise, so they are held back and
  // revealed for the selected node's own relationships instead. A flowchart is
  // the exception in both of the next two: `Yes` and `No` are not annotations
  // on the line, they are the only thing that says which way the flow went, and
  // a line the reader cannot follow is a flowchart that does not work. So a
  // flow keeps its labels and its full-strength lines however many there are.
  const tracing = graph.kind === 'flow';
  edgeLayer.classList.toggle('labels-on-demand', !tracing && graph.edges.length > 24);
  // Past a few dozen relationships no reader is following an individual line
  // out of the tangle, so the lines step back to a texture and only the ones
  // belonging to the node under the pointer are drawn at full strength.
  edgeLayer.classList.toggle('is-quiet', !tracing && graph.edges.length > QUIET_EDGE_COUNT);
  edgeLayer.classList.toggle('is-flowchart', tracing);
  edgeLayer.classList.toggle('has-group-summary', graph.kind !== 'flow' && layout.groups.length > 1);
  const nodeLayer = createSvgElement('g');
  nodeLayer.classList.add('node-layer');
  // Behind the lines: the frames are the ground the diagram is drawn on, and a
  // line crossing one has not left the neighbourhood it names.
  const groupEdges = graph.kind === 'flow' ? createSvgElement('g') : renderGroupEdges(layout, graph);
  viewportGroup.append(renderGroups(layout.groups), groupEdges, edgeLayer, nodeLayer);

  const externalIds = new Set(
    graph.nodes.filter((node) => node.kind === 'external-package').map((node) => node.id),
  );
  const membership = groupMembership(layout.groups);

  for (const edge of graph.edges) {
    const from = layout.nodeById.get(edge.from);
    const to = layout.nodeById.get(edge.to);
    if (!from || !to) {
      continue;
    }
    const points = routes.get(edge.id);
    if (!points?.length) {
      continue;
    }
    const edgeGroup = createSvgElement('g');
    edgeGroup.classList.add('graph-edge', `confidence-${edge.confidence}`);
    // A package chip already says how many modules import it. Drawing every one
    // of those lines buries the module graph the diagram is actually about, so
    // they stay faint until the module or the package is picked out.
    edgeGroup.classList.toggle('is-leaf-edge', externalIds.has(edge.to) || externalIds.has(edge.from));
    // A relationship half the graph has says nothing about any one node in it.
    // Drawn at full strength it is the only thing on the canvas, so it is drawn
    // as a wash and comes back at full strength under the pointer.
    edgeGroup.classList.toggle('is-ambient-edge', layout.ambient.has(edge.from) || layout.ambient.has(edge.to));
    edgeGroup.classList.toggle('is-cross-group-edge', crossesGroupBoundary(membership, edge.from, edge.to));
    edgeGroup.dataset.edgeId = edge.id;
    edgeGroup.dataset.edgeKind = edge.kind;
    edgeGroup.dataset.from = edge.from;
    edgeGroup.dataset.to = edge.to;
    const path = createSvgElement('path');
    path.setAttribute('d', orthogonalPath(points));
    path.setAttribute('marker-end', 'url(#arrow)');
    edgeGroup.append(path);

    // On a flowchart only a fork is worth writing on the line. `Yes` and `No`
    // are the branch itself; `starts`, `dispatches` and `calls` name a kind of
    // line the arrow already shows, and repeating them on every edge is most of
    // the text on the canvas saying nothing. They stay in the details panel.
    const branch = edge.kind === 'branch';
    if (edge.label && (!tracing || branch)) {
      const label = createSvgElement('text');
      const point = labelPointOn(points);
      label.setAttribute('x', String(point.x));
      label.setAttribute('y', String(point.y));
      label.textContent = edge.label;
      edgeGroup.append(label);
      edgeGroup.classList.add('has-label');
      // Which way the flow went, rather than a note about the line: drawn as a
      // chip on the line the way a flowchart draws it.
      edgeGroup.classList.toggle('is-branch', tracing && branch);
    }
    edgeLayer.append(edgeGroup);
  }

  const references = new Map<string, number>();
  for (const edge of graph.edges) {
    references.set(edge.to, (references.get(edge.to) ?? 0) + 1);
    references.set(edge.from, (references.get(edge.from) ?? 0) + 1);
  }
  for (const positioned of layout.nodes) {
    nodeLayer.append(renderGraphNode(
      positioned,
      graph.kind,
      layout.ambient.has(positioned.node.id) ? references.get(positioned.node.id) ?? 0 : 0,
    ));
  }
  applySelectionStyles();
  applyGraphSearch();
  applyCamera();
  if (needsFit.has(activeView)) {
    needsFit.delete(activeView);
    requestAnimationFrame(() => fitCurrentGraph());
  }
}

/**
 * `references` is set only for a node the rest of the graph leans on, and is
 * the count its faded relationships would otherwise have shown.
 */
/**
 * The frames around the neighbourhoods the layout found.
 *
 * Placing related nodes together only helps if the reader can see where one
 * group stops and the next begins — without a boundary a tidy arrangement still
 * reads as one field of boxes. The name is the group's best connected member,
 * which is what anyone would call that part of the schema anyway.
 */
function renderGroups(groups: readonly LayoutGroup[]): SVGGElement {
  const layer = createSvgElement('g');
  layer.classList.add('group-layer');
  for (const group of groups) {
    // A frame round one box is chrome, not information.
    if (group.count < 2) {
      continue;
    }
    const element = createSvgElement('g');
    element.classList.add('graph-group');
    element.setAttribute('transform', `translate(${round(group.x)} ${round(group.y)})`);

    const frame = createSvgElement('rect');
    frame.classList.add('group-frame');
    frame.setAttribute('width', String(round(group.width)));
    frame.setAttribute('height', String(round(group.height)));
    frame.setAttribute('rx', '10');
    element.append(frame);

    const label = createSvgElement('text');
    label.classList.add('group-label');
    label.setAttribute('x', '14');
    label.setAttribute('y', '20');
    label.textContent = `${shorten(group.label, Math.floor((group.width - 60) / 6.4))} · ${group.count}`;
    element.append(label);

    const title = createSvgElement('title');
    title.textContent = `${group.count} nodes, grouped around ${group.label}`;
    element.append(title);
    layer.append(element);
  }
  return layer;
}

/**
 * One calm connector per pair of areas replaces dozens of boundary-crossing
 * lines in the overview. The individual relationships remain in the SVG and
 * return at full strength when their node is hovered or selected.
 */
function renderGroupEdges(layout: LayoutResult, graph: DiagramGraph): SVGGElement {
  const layer = createSvgElement('g');
  layer.classList.add('group-edge-layer');
  if (layout.groups.length < 2) {
    return layer;
  }

  const groupOf = groupMembership(layout.groups);
  const byId = new Map(layout.groups.map((group) => [group.key, group]));
  const summaries = new Map<string, { id: string; from: string; to: string; count: number }>();
  for (const edge of graph.edges) {
    const from = groupOf.get(edge.from);
    const to = groupOf.get(edge.to);
    if (!from || !to || from === to) {
      continue;
    }
    // A boundary summary says that two areas communicate. The details panel and
    // revealed member edges carry direction, so reciprocal relationships share
    // one overview connector instead of being drawn on top of one another.
    const [left, right] = from.localeCompare(to) <= 0 ? [from, to] : [to, from];
    const id = `group:${left}:${right}`;
    const summary = summaries.get(id) ?? { id, from: left, to: right, count: 0 };
    summary.count += 1;
    summaries.set(id, summary);
  }
  if (!summaries.size) {
    return layer;
  }

  const routes = routeOrthogonally(
    layout.groups.map((group) => ({
      id: group.key,
      x: group.x,
      y: group.y,
      width: group.width,
      height: group.height,
    })),
    [...summaries.values()].map(({ id, from, to }) => ({ id, from, to })),
    {
      clearance: GROUP_ROUTE_CLEARANCE,
      turnCost: GROUP_ROUTE_TURN_COST,
      congestionCost: GROUP_ROUTE_CONGESTION_COST,
      maxLines: GROUP_ROUTE_MAX_LINES,
    },
  );

  for (const summary of summaries.values()) {
    if (!byId.has(summary.from) || !byId.has(summary.to)) {
      continue;
    }
    const points = routes.get(summary.id);
    if (!points?.length) {
      continue;
    }
    const connector = createSvgElement('g');
    connector.classList.add('group-edge');
    const path = createSvgElement('path');
    path.setAttribute('d', orthogonalPath(points));
    connector.append(path);

    const badgePoint = labelPointOn(points);
    const badge = createSvgElement('g');
    badge.classList.add('group-edge-badge');
    badge.setAttribute('transform', `translate(${round(badgePoint.x)} ${round(badgePoint.y + 7)})`);
    const width = 18 + String(summary.count).length * 7;
    const background = createSvgElement('rect');
    background.setAttribute('x', String(-width / 2));
    background.setAttribute('y', '-10');
    background.setAttribute('width', String(width));
    background.setAttribute('height', '18');
    background.setAttribute('rx', '9');
    const label = createSvgElement('text');
    label.setAttribute('y', '3');
    label.textContent = String(summary.count);
    badge.append(background, label);
    connector.append(badge);

    const title = createSvgElement('title');
    title.textContent = `${byId.get(summary.from)?.label ?? summary.from} ↔ ${byId.get(summary.to)?.label ?? summary.to}: ${summary.count} relationships`;
    connector.append(title);
    layer.append(connector);
  }
  return layer;
}

function groupMembership(groups: readonly LayoutGroup[]): Map<string, string> {
  const membership = new Map<string, string>();
  for (const group of groups) {
    for (const nodeId of group.nodeIds) {
      membership.set(nodeId, group.key);
    }
  }
  return membership;
}

function crossesGroupBoundary(groups: ReadonlyMap<string, string>, from: string, to: string): boolean {
  const left = groups.get(from);
  const right = groups.get(to);
  return Boolean(left && right && left !== right);
}

function renderGraphNode(positioned: LayoutNode, kind: DiagramGraph['kind'], references: number): SVGGElement {
  const { node, x, y, width, height } = positioned;
  const group = createSvgElement('g');
  group.classList.add('graph-node', `node-${safeClass(node.kind)}`, `confidence-${node.confidence ?? 'inferred'}`);
  group.classList.toggle('is-ambient', references > 0);
  group.dataset.nodeId = node.id;
  group.dataset.kind = node.kind;
  group.dataset.searchText = searchableNodeText(node);
  group.setAttribute('transform', `translate(${x} ${y})`);
  group.setAttribute('role', 'button');
  group.setAttribute('tabindex', '0');
  const opensDataArea = areaKeyOfNodeId(node.id) !== undefined;
  const opensArchitectureArea = architectureAreaKeyOfNodeId(node.id) !== undefined;
  const opensArea = opensDataArea || opensArchitectureArea;
  group.setAttribute('aria-label', opensArea
    ? `${node.label}, area, ${node.subtitle ?? ''}. Opens this area's diagram.`
    : `${node.label}, ${node.kind}${node.source ? `, ${node.source.file}` : ''}`);

  const title = createSvgElement('title');
  title.textContent = `${node.label}${node.subtitle ? ` — ${node.subtitle}` : ''}`
    + (opensArea ? ' — double-click to open this area' : '')
    + (references ? ` — ${references} relationships, drawn faintly` : '');
  group.append(title);

  const decision = kind === 'flow' && node.kind === 'decision';
  // The diagram's own two marks, not steps the source declares — a declared
  // route is `start`, and it is drawn as a card like every other step.
  const boundary = kind === 'flow' && (node.kind === 'flow-start' || node.kind === 'flow-end');
  const background = decision ? createSvgElement('polygon') : createSvgElement('rect');
  background.classList.add('node-background');
  if (background instanceof SVGPolygonElement) {
    background.setAttribute('points', `${width / 2},0 ${width},${height / 2} ${width / 2},${height} 0,${height / 2}`);
  } else {
    background.setAttribute('width', String(width));
    background.setAttribute('height', String(height));
    background.setAttribute('rx', boundary ? String(height / 2) : '6');
  }
  group.append(background);

  const rows = decision || boundary ? [] : cardRows(node, kind);
  const listed = rows.length > 0;
  // On a flowchart every step is a titled box, the way a hand-drawn one is: the
  // name sits in a bar across the top and whatever was read inside it hangs
  // underneath. Only the steps that happened to have something to list used to
  // get that bar, which made them look like a different kind of thing from the
  // routes and calls beside them — when they are all one kind: a step.
  const headed = listed || (kind === 'flow' && !decision && !boundary);
  group.classList.toggle('is-headed', headed);
  if (headed) {
    const header = createSvgElement('rect');
    header.classList.add('node-header');
    header.setAttribute('width', String(width));
    header.setAttribute('height', '48');
    header.setAttribute('rx', '6');
    group.append(header);
  }

  // Rows are placed off the actual node height so a compact chip and a full
  // module card both stay vertically centred.
  const compact = height <= 56;
  const labelY = decision ? height / 2 - 4 : headed ? 21 : compact ? 20 : 27;
  const subtitleY = decision ? height / 2 + 14 : headed ? 39 : compact ? 34 : 49;
  const charBudget = Math.floor((width - 24) / 6.4);

  const label = createSvgElement('text');
  label.classList.add('node-label');
  label.setAttribute('x', decision ? String(width / 2) : '14');
  label.setAttribute('y', String(labelY));
  if (decision) label.setAttribute('text-anchor', 'middle');
  label.textContent = shorten(node.label, charBudget);
  group.append(label);

  const subtitle = createSvgElement('text');
  subtitle.classList.add('node-subtitle');
  subtitle.setAttribute('x', decision ? String(width / 2) : '14');
  subtitle.setAttribute('y', String(subtitleY));
  if (decision) subtitle.setAttribute('text-anchor', 'middle');
  subtitle.textContent = shorten(node.subtitle ?? node.group ?? node.kind, charBudget + 4);
  group.append(subtitle);

  // The count the faded lines are no longer carrying, put back on the card.
  if (references) {
    const badge = createSvgElement('text');
    badge.classList.add('node-references');
    badge.setAttribute('x', String(width - 12));
    badge.setAttribute('y', String(labelY));
    badge.textContent = `↦ ${references}`;
    group.append(badge);
  }

  if (listed) {
    const fields = rows;
    const visibleFields = fields.slice(0, FIELD_ROWS);
    visibleFields.forEach((field, index) => {
      const rowY = 69 + index * 22;
      const separator = createSvgElement('line');
      separator.classList.add('field-separator');
      separator.setAttribute('x1', '0');
      separator.setAttribute('x2', String(width));
      separator.setAttribute('y1', String(rowY - 15));
      separator.setAttribute('y2', String(rowY - 15));
      group.append(separator);
      const fieldText = createSvgElement('text');
      fieldText.classList.add('field-label');
      fieldText.setAttribute('x', '14');
      fieldText.setAttribute('y', String(rowY));
      fieldText.textContent = truncate(field, Math.floor((width - 24) / 6.1));
      group.append(fieldText);
    });
    if (fields.length > visibleFields.length) {
      const more = createSvgElement('text');
      more.classList.add('field-label', 'field-more');
      more.setAttribute('x', '14');
      more.setAttribute('y', String(69 + visibleFields.length * 22));
      more.textContent = `… ${fields.length - visibleFields.length} more`;
      group.append(more);
    }
  }

  // Hovering is the cheapest way to ask "what does this one touch?", and on a
  // dense graph it is the only way that answers without changing the selection.
  group.addEventListener('pointerenter', () => highlightNeighbourhood(node.id));
  group.addEventListener('pointerleave', () => highlightNeighbourhood(undefined));
  group.addEventListener('focus', () => highlightNeighbourhood(node.id));
  group.addEventListener('blur', () => highlightNeighbourhood(undefined));
  group.addEventListener('click', (event) => {
    event.stopPropagation();
    selectNode(node.id);
  });
  group.addEventListener('dblclick', (event) => {
    event.stopPropagation();
    // On a card standing for a whole area, the thing behind it is the area's
    // own diagram, not the line of source one of its tables happens to start on.
    const areaKey = areaKeyOfNodeId(node.id);
    if (areaKey !== undefined) {
      openArea(areaKey);
      return;
    }
    const architectureKey = architectureAreaKeyOfNodeId(node.id);
    if (architectureKey !== undefined && architectureKey !== '__external_packages__') {
      openArchitectureArea(architectureKey);
      return;
    }
    if (node.source) vscode.postMessage({ type: 'openSource', nodeId: node.id });
  });
  group.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const areaKey = areaKeyOfNodeId(node.id);
      if (areaKey !== undefined) openArea(areaKey);
      else if (architectureAreaKeyOfNodeId(node.id) !== undefined
        && architectureAreaKeyOfNodeId(node.id) !== '__external_packages__') {
        openArchitectureArea(architectureAreaKeyOfNodeId(node.id)!);
      }
      else selectNode(node.id);
    } else if (event.key.toLowerCase() === 'o' && node.source) {
      event.preventDefault();
      vscode.postMessage({ type: 'openSource', nodeId: node.id });
    }
  });
  return group;
}

/**
 * The structure view.
 *
 * A tree, drawn the way `tree` and `git log --graph` draw one: a row per entry,
 * folders before files, and a line running down from each folder to the last
 * thing inside it. Those lines are the whole point — an indent alone leaves a
 * reader four levels deep counting spaces to work out which folder a file is
 * actually in, and that is the question this view exists to answer.
 *
 * It is a scrolling list rather than something on the graph canvas, because a
 * tree is text: it wants the editor's font, native scrolling and selectable
 * rows, and it has no size that `fit` could sensibly shrink it to.
 */
function renderStructure(): void {
  if (!snapshot) {
    return;
  }
  currentLayout = undefined;
  contentBounds = undefined;
  const query = normalizeSearch(searchQuery);
  const rowMatches = (text: string): boolean => !query || normalizeSearch(text).includes(query);

  // Keep a bounded tree model for sidebar hand-off and file-search matches,
  // but do not draw it by default: Explorer already provides that list.
  const treeQuery = query
    ? (node: StructureNode): boolean => normalizeSearch(`${node.label} ${node.path}`).includes(query)
    : undefined;
  const tree = buildTree(snapshot.structure, {
    isOpen: (node) => !collapsedPaths.has(node.path),
    limit: MAX_TREE_ROWS,
    ...(treeQuery ? { match: treeQuery } : {}),
  });
  treeRows = tree.rows;

  const modules = snapshot.architecture.nodes.filter((node) => node.kind === 'module');
  if (!modules.length && !treeRows.length) {
    showState(query ? 'Nothing here matches that search.' : 'Nothing was scanned.', 'empty');
    return;
  }
  stateView.hidden = true;
  setHidden(graphCanvas, true);
  setHidden(structureDashboard, false);
  structureDashboard.style.setProperty('--codraw-tree-scale', String(treeScale));

  clearElement(dashGrid);
  // While a search is on, the view is a filter: only the cards that can hold a
  // match are drawn, so the summary and the flow strip do not push them down.
  if (!query) {
    dashGrid.append(renderSummaryCard());
  } else {
    const fileMatches = renderFileMatchesCard(treeRows.filter((row) => row.match && !row.folder));
    if (fileMatches) dashGrid.append(fileMatches);
  }

  // The orientation band. These five answer the questions somebody actually
  // opens an unfamiliar repository with — where does it start, what holds it
  // up, where is the weight, what is not wired to anything, what is untested —
  // and they come before the inventory because the inventory cannot answer them.
  const fileMatch = (node: StructureNode): boolean => rowMatches(node.path);
  for (const card of [
    renderEntryPointsCard(fileMatch),
    renderLoadBearingCard(fileMatch),
    renderLargestFilesCard(fileMatch),
    renderUnreferencedCard(fileMatch),
    renderUntestedCard(fileMatch),
  ]) {
    if (card) dashGrid.append(card);
  }

  const groups = [...groupModules(modules).entries()]
    .map(([name, nodes]) => ({ name, nodes, files: nodes.reduce((sum, node) => sum + moduleFileCount(node), 0) }))
    .sort((left, right) => right.files - left.files || left.name.localeCompare(right.name));
  for (const group of groups) {
    const visible = query ? group.nodes.filter((node) => rowMatches(`${node.label} ${node.subtitle ?? ''}`)) : group.nodes;
    if (!visible.length) {
      continue;
    }
    const { card, body } = makeCard(group.name, `${visible.length} module${visible.length === 1 ? '' : 's'} · ${group.files} files`);
    const list = document.createElement('div');
    list.className = 'dash-list';
    for (const node of [...visible].sort((left, right) => left.label.localeCompare(right.label))) {
      list.append(renderDashRow({
        label: moduleShortLabel(node, group.name),
        title: node.label,
        count: String(moduleFileCount(node)),
        lang: LANGUAGE_BUCKET[metadataArray(node, 'Languages')[0] ?? ''] ?? 'other',
        nodeId: node.id,
      }));
    }
    body.append(list);
    dashGrid.append(card);
  }

  const hotspotCard = renderHotspotCard(rowMatches, Boolean(query));
  if (hotspotCard) dashGrid.append(hotspotCard);

  const dependencyCard = renderDependencyCard(rowMatches, Boolean(query));
  if (dependencyCard) {
    dashGrid.append(dependencyCard);
  }
  dashGrid.append(renderDataCard(rowMatches, Boolean(query)));
  if (!query) {
    dashGrid.append(renderFlowCard());
  }

  renderLanguageLegend();
  renderFoldButton();
  applyStructureSelection();
  if (query) {
    announce(`${tree.matches} file${tree.matches === 1 ? '' : 's'} match.`);
  }
}

function renderFileMatchesCard(rows: readonly TreeRow[]): HTMLElement | undefined {
  const shown = rows.slice(0, DASH_LIST_LIMIT);
  if (!shown.length) return undefined;
  const { card, body } = makeCard('Matching source files', String(rows.length));
  const list = document.createElement('div');
  list.className = 'dash-list';
  for (const row of shown) {
    list.append(renderDashRow({
      label: row.node.path,
      path: row.node.path,
      title: row.node.path,
      lang: languageOf(row.node),
      nodeId: row.node.id,
    }));
  }
  body.append(list);
  return card;
}

/**
 * Every file in the snapshot, flattened once per analysis.
 *
 * The orientation cards each want the whole file list ranked a different way,
 * and walking a 1100-node tree five times per redraw is five times the walk for
 * one answer that never changes between them.
 */
let fileCache: { revision: number; files: StructureNode[] } | undefined;

function allFiles(): StructureNode[] {
  const snap = snapshot;
  if (!snap) {
    return [];
  }
  if (fileCache?.revision === snap.revision) {
    return fileCache.files;
  }
  const files: StructureNode[] = [];
  const walk = (node: StructureNode): void => {
    if (node.kind === 'file') {
      files.push(node);
      return;
    }
    for (const child of node.children) {
      walk(child);
    }
  };
  walk(snap.structure);
  fileCache = { revision: snap.revision, files };
  return files;
}

/** Rows a file card lists before it says how many more there are. */
const FILE_LIST_LIMIT = 8;
/**
 * Where a file stops being one screenful and starts being a chapter. Not a
 * defect threshold — it is the point past which "open it and read it" stops
 * being a plan, which is the only claim this view is in a position to make.
 */
const HEAVY_FILE_LINES = 400;
/** Below this a project has too few source files for a ranking to mean much. */
const RANKING_FLOOR = 3;

function fileRow(node: StructureNode, spec: { count?: string; meta?: string; tone?: 'warn' }): HTMLElement {
  const row = renderDashRow({
    label: node.path,
    path: node.path,
    title: fileTitle(node),
    lang: languageOf(node),
    nodeId: node.id,
    ...(spec.count === undefined ? {} : { count: spec.count }),
    ...(spec.meta === undefined ? {} : { meta: spec.meta }),
  });
  if (spec.tone) {
    row.classList.add(`is-${spec.tone}`);
  }
  return row;
}

/**
 * The whole of what was measured about a file, spelled out.
 *
 * Each card shows the one or two figures it ranked by; the row's tooltip is
 * where the rest of them live, so a reader who wants to know why a file is
 * where it is does not have to visit four cards to find out.
 */
function fileTitle(node: StructureNode): string {
  const parts = [node.path];
  if (node.lines !== undefined) {
    parts.push(`${node.lines} line${node.lines === 1 ? '' : 's'}`);
  }
  if (node.importedBy !== undefined) {
    parts.push(`imported by ${node.importedBy}`);
  }
  if (node.imports !== undefined) {
    parts.push(`imports ${node.imports}`);
  }
  return parts.join(' · ');
}

/** `1240` reads as a phone number at a glance; `1.2k` reads as a size. */
function formatCount(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

function linesLabel(node: StructureNode): string | undefined {
  return node.lines === undefined ? undefined : `${formatCount(node.lines)} lines`;
}

/** Adds the list, and the "+N more" line when the list was cut short. */
function appendFileList(body: HTMLElement, rows: readonly HTMLElement[], total: number): void {
  const list = document.createElement('div');
  list.className = 'dash-list';
  list.append(...rows);
  body.append(list);
  if (total > rows.length) {
    const more = document.createElement('p');
    more.className = 'flow-more';
    more.textContent = `+${total - rows.length} more`;
    body.append(more);
  }
}

function cardNote(body: HTMLElement, text: string): void {
  const note = document.createElement('p');
  note.className = 'dash-empty dash-card-note';
  note.textContent = text;
  body.append(note);
}

/**
 * Where the project starts running.
 *
 * The first question about an unfamiliar repository is which file the machine
 * reaches first, and the Explorer cannot answer it: `src/extension.ts` and
 * `src/icons.ts` are the same kind of row in a file tree.
 */
function renderEntryPointsCard(matches: (node: StructureNode) => boolean): HTMLElement | undefined {
  const entries = allFiles()
    .filter((node) => node.role === 'entry')
    .filter(matches)
    .sort((left, right) => (right.imports ?? 0) - (left.imports ?? 0) || left.path.localeCompare(right.path));
  if (!entries.length) {
    return undefined;
  }
  const { card, body } = makeCard('Start here', String(entries.length));
  cardNote(body, 'Files that begin a program rather than being reached from one. The number is how many project files each one pulls in directly.');
  appendFileList(
    body,
    entries.slice(0, FILE_LIST_LIMIT).map((node) => fileRow(node, {
      count: `→${node.imports ?? 0}`,
      ...(linesLabel(node) === undefined ? {} : { meta: linesLabel(node)! }),
    })),
    entries.length,
  );
  return card;
}

/**
 * What the rest of the project leans on, file by file.
 *
 * The module hotspot card below answers the same question one level up. Both
 * are worth having: a module says which area to be careful in, a file says
 * which editor tab the care applies to.
 */
function renderLoadBearingCard(matches: (node: StructureNode) => boolean): HTMLElement | undefined {
  const ranked = allFiles()
    .filter((node) => (node.importedBy ?? 0) > 0)
    .filter(matches)
    .sort((left, right) => (right.importedBy ?? 0) - (left.importedBy ?? 0) || left.path.localeCompare(right.path));
  if (ranked.length < RANKING_FLOOR) {
    return undefined;
  }
  const { card, body } = makeCard('Most depended on', String(ranked.length));
  cardNote(body, 'How many project files import each one. These are where a change is felt furthest.');
  appendFileList(
    body,
    ranked.slice(0, FILE_LIST_LIMIT).map((node) => fileRow(node, {
      count: `←${node.importedBy ?? 0}`,
      ...(linesLabel(node) === undefined ? {} : { meta: linesLabel(node)! }),
    })),
    ranked.length,
  );
  return card;
}

/** Where the volume of the project actually sits. */
function renderLargestFilesCard(matches: (node: StructureNode) => boolean): HTMLElement | undefined {
  const measured = allFiles()
    .filter((node) => (node.role === 'source' || node.role === 'entry') && node.lines !== undefined)
    .filter(matches)
    .sort((left, right) => (right.lines ?? 0) - (left.lines ?? 0) || left.path.localeCompare(right.path));
  if (measured.length < RANKING_FLOOR) {
    return undefined;
  }
  const heavy = measured.filter((node) => (node.lines ?? 0) >= HEAVY_FILE_LINES).length;
  const { card, body } = makeCard('Largest source files', `${heavy} over ${HEAVY_FILE_LINES} lines`);
  cardNote(body, 'Length is not a defect. It is where reading time goes, and where a split usually pays for itself first.');
  appendFileList(
    body,
    measured.slice(0, FILE_LIST_LIMIT).map((node) => fileRow(node, {
      count: formatCount(node.lines ?? 0),
      ...((node.importedBy ?? 0) > 0 ? { meta: `←${node.importedBy}` } : {}),
      ...((node.lines ?? 0) >= HEAVY_FILE_LINES ? { tone: 'warn' as const } : {}),
    })),
    measured.length,
  );
  return card;
}

/**
 * Source files no other scanned file imports.
 *
 * Deliberately not called "unused". Static imports are all this analysis sees,
 * so a build entry point, a route loaded by convention, and a class resolved by
 * a container all land here beside code that really is dead — and the note says
 * so, because a list like this is only useful if the reader trusts what it means.
 */
function renderUnreferencedCard(matches: (node: StructureNode) => boolean): HTMLElement | undefined {
  const orphans = allFiles()
    .filter((node) => node.role === 'source' && node.importedBy === 0)
    .filter(matches)
    // Nothing in and nothing out is the strongest signal there is here, so it
    // goes first; below that, the biggest file is the one worth resolving.
    .sort((left, right) => (left.imports ?? 0) - (right.imports ?? 0)
      || (right.lines ?? 0) - (left.lines ?? 0)
      || left.path.localeCompare(right.path));
  if (!orphans.length) {
    return undefined;
  }
  const unresolved = snapshot!.diagnostics.find((entry) => entry.code === 'UNRESOLVED_IMPORT');
  const { card, body } = makeCard('Nothing imports these', String(orphans.length));
  cardNote(body, unresolved
    ? 'Candidates to look at, not dead code. Build entry points, files loaded by convention, and dynamic imports look the same from here — and some imports in this workspace could not be resolved at all.'
    : 'Candidates to look at, not dead code. Build entry points, files loaded by convention, and files reached dynamically all look the same from here.');
  appendFileList(
    body,
    orphans.slice(0, FILE_LIST_LIMIT).map((node) => fileRow(node, {
      count: `→${node.imports ?? 0}`,
      ...(linesLabel(node) === undefined ? {} : { meta: linesLabel(node)! }),
    })),
    orphans.length,
  );
  return card;
}

/**
 * Source files with no test file named after them.
 *
 * Matched on the name rather than the folder, because a project's tests sit
 * beside the code in some ecosystems and in a separate tree in others, and the
 * one thing both conventions agree on is that `analyzer`'s test is called
 * something containing `analyzer`.
 */
function renderUntestedCard(matches: (node: StructureNode) => boolean): HTMLElement | undefined {
  const files = allFiles();
  const tested = new Set<string>();
  for (const node of files) {
    if (node.role === 'test') {
      tested.add(testSubjectOf(node.label));
    }
  }
  const source = files.filter((node) => node.role === 'source' || node.role === 'entry');
  if (!tested.size) {
    // Listing every source file would be a wall of rows saying one thing, so
    // the card says that one thing instead.
    if (source.length < RANKING_FLOOR) {
      return undefined;
    }
    const { card, body } = makeCard('No test named after them', `0/${source.length} covered`);
    cardNote(body, 'No test files were found in this workspace. Tests kept outside it, or named by a convention this scan does not know, would not be counted.');
    return card;
  }
  const untested = source
    .filter((node) => !tested.has(stemOf(node.label)))
    .filter(matches)
    .sort((left, right) => (right.lines ?? 0) - (left.lines ?? 0) || left.path.localeCompare(right.path));
  if (!untested.length || source.length < RANKING_FLOOR) {
    return undefined;
  }
  const covered = source.length - untested.length;
  const { card, body } = makeCard('No test named after them', `${covered}/${source.length} covered`);
  cardNote(body, 'Matched by file name, so a file exercised only through another one’s tests still appears here. Largest first: that is where the gap costs most.');
  appendFileList(
    body,
    untested.slice(0, FILE_LIST_LIMIT).map((node) => fileRow(node, {
      ...(node.lines === undefined ? {} : { count: formatCount(node.lines) }),
      ...((node.importedBy ?? 0) > 0 ? { meta: `←${node.importedBy}` } : {}),
    })),
    untested.length,
  );
  return card;
}

/** A file name with its extension taken off, lowercased. */
function stemOf(label: string): string {
  const dot = label.lastIndexOf('.');
  return (dot > 0 ? label.slice(0, dot) : label).toLowerCase();
}

/** The name a test file is claiming to be about: `user.test.ts` is about `user`. */
function testSubjectOf(label: string): string {
  let stem = stemOf(label);
  stem = stem.replace(/\.(test|spec)$/, '');
  stem = stem.replace(/^test[_-]/, '');
  stem = stem.replace(/[_-]?(test|tests|spec|specs)$/, '');
  return stem;
}

/** Display-name (from the analyzer) to the shared language-palette bucket. */
const LANGUAGE_BUCKET: Record<string, string> = {
  TypeScript: 'ts', JavaScript: 'js', Python: 'py', Java: 'jvm', Kotlin: 'jvm',
  Go: 'go', Rust: 'rust', 'C#': 'dotnet', PHP: 'php', Ruby: 'ruby', Dart: 'dart',
  Swift: 'native', C: 'native', 'C++': 'native', Vue: 'markup', Svelte: 'markup',
};

/** How many steps the flow strip lists before it says how many more there are. */
const FLOW_STRIP_LIMIT = 8;
/** Rows a dependency or data card lists before the same. */
const DASH_LIST_LIMIT = 12;

function moduleFileCount(node: DiagramNode): number {
  return Number(node.metadata.Files) || 0;
}

/** A module label with the group it is already filed under taken off the front. */
function moduleShortLabel(node: DiagramNode, group: string): string {
  return node.label.startsWith(`${group}/`) ? node.label.slice(group.length + 1) : node.label;
}

function groupModules(modules: DiagramNode[]): Map<string, DiagramNode[]> {
  const groups = new Map<string, DiagramNode[]>();
  for (const node of modules) {
    const key = declaredGroupOf(node, 'architecture') ?? 'Workspace';
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(node);
    } else {
      groups.set(key, [node]);
    }
  }
  return groups;
}

function makeCard(title: string, count?: string): { card: HTMLDivElement; body: HTMLDivElement } {
  const card = document.createElement('div');
  card.className = 'dash-card';
  const head = document.createElement('div');
  head.className = 'dash-card__head';
  const heading = document.createElement('h3');
  heading.textContent = title;
  head.append(heading);
  if (count !== undefined) {
    const badge = document.createElement('span');
    badge.className = 'dash-card__count';
    badge.textContent = count;
    head.append(badge);
  }
  card.append(head);
  const body = document.createElement('div');
  card.append(body);
  return { card, body };
}

function renderDashRow(spec: { label: string; title?: string; count?: string; meta?: string; lang?: string; nodeId?: string; path?: string }): HTMLElement {
  const row = document.createElement('div');
  row.className = 'dash-row';
  if (spec.lang) {
    row.classList.add(`lang-${spec.lang}`);
    const swatch = document.createElement('span');
    swatch.className = 'dash-swatch';
    row.append(swatch);
  }
  if (spec.nodeId) {
    row.dataset.nodeId = spec.nodeId;
  }
  row.title = spec.title ?? spec.label;
  const label = document.createElement('span');
  label.className = 'label';
  if (spec.path) {
    label.append(...pathLabel(spec.path));
  } else {
    label.textContent = spec.label;
  }
  row.append(label);
  // A second figure, in the quieter column: the row's headline number stays the
  // one the card ranked by, and this says what the other axis was worth.
  if (spec.meta !== undefined) {
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = spec.meta;
    row.append(meta);
  }
  if (spec.count !== undefined) {
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = spec.count;
    row.append(count);
  }
  return row;
}

/**
 * A file path as two runs: the folders it is in, and the file itself.
 *
 * A row is one line wide and a path is not, so something has to be dropped.
 * Dropping the end is the wrong half — in a vendored tree every path shares the
 * first forty characters and differs only in the last ten — so the name is kept
 * whole and the folders give up the room, losing their front rather than their
 * back, because the folder nearest the file says the most about it.
 */
function pathLabel(path: string): Node[] {
  const cut = path.lastIndexOf('/');
  if (cut < 0) {
    const only = document.createElement('span');
    only.className = 'name';
    only.textContent = path;
    return [only];
  }
  const dir = document.createElement('span');
  dir.className = 'dir';
  // The mark keeps the run reading left to right inside a box laid out right to
  // left, which is what puts the ellipsis at the front instead of the end. The
  // separator goes with the name rather than the folders, because a lone `/` at
  // the end of that run is a neutral character and lands on the wrong side of it.
  dir.textContent = `\u200e${path.slice(0, cut)}`;
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = path.slice(cut);
  return [dir, name];
}

/** The full-width card at the top: what the project is, in numbers and names. */
function renderSummaryCard(): HTMLElement {
  const snap = snapshot!;
  const card = document.createElement('div');
  card.className = 'dash-card dash-card--summary';

  const name = document.createElement('p');
  name.className = 'dash-name';
  name.textContent = snap.projectName;
  card.append(name);

  const kind = document.createElement('p');
  kind.className = 'dash-kind';
  kind.textContent = snap.technologies.slice(0, 4).join(' · ') || 'Source project';
  card.append(kind);

  const metrics = document.createElement('div');
  metrics.className = 'dash-metrics';
  const tiles: Array<[number, string]> = [
    [snap.stats.files, 'files'],
    [snap.stats.codeFiles, 'source'],
    [snap.stats.modules, 'modules'],
    [snap.stats.dependencies, 'dependencies'],
    [snap.stats.flowUnits, 'flows'],
    [snap.stats.databaseEntities, 'entities'],
    [snap.stats.databaseRelations, 'relations'],
  ];
  for (const [value, unit] of tiles) {
    const tile = document.createElement('div');
    tile.className = 'dash-metric';
    const strong = document.createElement('strong');
    strong.textContent = String(value);
    const span = document.createElement('span');
    span.textContent = unit;
    tile.append(strong, span);
    metrics.append(tile);
  }
  card.append(metrics);

  const composition = renderCompositionBar();
  if (composition) {
    card.append(composition);
  }

  if (snap.technologies.length) {
    const tech = document.createElement('div');
    tech.className = 'dash-tech';
    for (const technology of snap.technologies) {
      const chip = document.createElement('span');
      chip.className = 'technology-badge';
      chip.textContent = technology;
      tech.append(chip);
    }
    card.append(tech);
  }
  return card;
}

/**
 * What the repository is made of, as one bar rather than a column of numbers.
 *
 * The status-bar legend already names the languages and counts them; a
 * proportion is the part it cannot show, and the proportion is the thing a
 * reader is actually after — "mostly TypeScript with a Python service in it"
 * is a fact about the shape of the bar, not about any of its numbers.
 */
function renderCompositionBar(): HTMLElement | undefined {
  const files = allFiles();
  if (files.length < RANKING_FLOOR) {
    return undefined;
  }
  const totals = new Map<string, number>();
  for (const node of files) {
    const language = languageOf(node);
    totals.set(language, (totals.get(language) ?? 0) + 1);
  }
  // `other` is a leftovers bucket, not a language, so it is ranked last however
  // big it grows: a bar that opens with "Other 31%" says nothing about what the
  // project is written in, which is the only question the bar exists to answer.
  const ordered = [...totals].sort((left, right) => Number(left[0] === 'other') - Number(right[0] === 'other')
    || right[1] - left[1]
    || left[0].localeCompare(right[0]));
  if (ordered.length < 2) {
    return undefined;
  }

  const wrapper = document.createElement('div');
  wrapper.className = 'dash-composition';
  const bar = document.createElement('div');
  bar.className = 'dash-bar';
  bar.setAttribute('role', 'img');
  bar.setAttribute('aria-label', ordered
    .slice(0, COMPOSITION_SEGMENTS)
    .map(([language, count]) => `${LANGUAGE_LABELS[language] ?? 'Other'} ${percentOf(count, files.length)}`)
    .join(', '));

  // Everything past the named segments is one segment, so a project with a long
  // tail of one-off file types still gets a bar that adds up to the whole.
  const shown = ordered.slice(0, COMPOSITION_SEGMENTS).filter(([language]) => language !== 'other');
  const rest = ordered.slice(shown.length).reduce((sum, [, count]) => sum + count, 0);
  const segments: Array<[string, number]> = rest ? [...shown, ['other', rest]] : shown;
  for (const [language, count] of segments) {
    const segment = document.createElement('span');
    segment.className = `dash-bar__part lang-${language}`;
    segment.style.flexGrow = String(count);
    segment.title = `${LANGUAGE_LABELS[language] ?? 'Other'} · ${count} file${count === 1 ? '' : 's'} · ${percentOf(count, files.length)}`;
    bar.append(segment);
  }
  wrapper.append(bar);

  const keys = document.createElement('div');
  keys.className = 'dash-bar__keys';
  for (const [language, count] of segments.slice(0, COMPOSITION_KEYS)) {
    const key = document.createElement('span');
    key.className = `dash-bar__key lang-${language}`;
    const swatch = document.createElement('span');
    swatch.className = 'dash-swatch';
    key.append(swatch, document.createTextNode(`${LANGUAGE_LABELS[language] ?? 'Other'} ${percentOf(count, files.length)}`));
    keys.append(key);
  }
  wrapper.append(keys);
  return wrapper;
}

/** Segments the composition bar names before it folds the rest into one. */
const COMPOSITION_SEGMENTS = 7;
/** Of those, how many get a written key underneath. */
const COMPOSITION_KEYS = 5;

function percentOf(part: number, whole: number): string {
  const share = whole ? (part / whole) * 100 : 0;
  return share < 1 ? '<1%' : `${Math.round(share)}%`;
}

function renderDependencyCard(rowMatches: (text: string) => boolean, filtering: boolean): HTMLElement | undefined {
  const packages = snapshot!.architecture.nodes
    .filter((node) => node.kind === 'external-package')
    .filter((node) => !filtering || rowMatches(node.label))
    .sort((left, right) => usageCount(right) - usageCount(left) || left.label.localeCompare(right.label));
  if (!packages.length) {
    return undefined;
  }
  const shown = packages.slice(0, DASH_LIST_LIMIT);
  const { card, body } = makeCard('External dependencies', String(packages.length));
  const list = document.createElement('div');
  list.className = 'dash-list';
  for (const node of shown) {
    const uses = usageCount(node);
    list.append(renderDashRow({
      label: node.label,
      count: uses ? `${uses}` : undefined,
      nodeId: node.id,
    }));
  }
  body.append(list);
  if (packages.length > shown.length) {
    const more = document.createElement('p');
    more.className = 'flow-more';
    more.textContent = `+${packages.length - shown.length} more`;
    body.append(more);
  }
  return card;
}

/** Modules that carry the most architectural coupling, not merely the most files. */
function renderHotspotCard(rowMatches: (text: string) => boolean, filtering: boolean): HTMLElement | undefined {
  const modules = snapshot!.architecture.nodes.filter((node) => node.kind === 'module');
  const moduleIds = new Set(modules.map((node) => node.id));
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, number>();
  for (const edge of snapshot!.architecture.edges) {
    if (!moduleIds.has(edge.from) || !moduleIds.has(edge.to)) continue;
    const weight = Number((edge.label ?? '').match(/\d+/)?.[0]) || 1;
    outgoing.set(edge.from, (outgoing.get(edge.from) ?? 0) + weight);
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + weight);
  }
  const ranked = modules
    .filter((node) => !filtering || rowMatches(`${node.label} ${node.subtitle ?? ''}`))
    .map((node) => ({ node, incoming: incoming.get(node.id) ?? 0, outgoing: outgoing.get(node.id) ?? 0 }))
    .filter((entry) => entry.incoming + entry.outgoing > 0)
    .sort((left, right) => (right.incoming + right.outgoing) - (left.incoming + left.outgoing)
      || right.incoming - left.incoming || left.node.label.localeCompare(right.node.label));
  if (!ranked.length) return undefined;
  const { card, body } = makeCard('Dependency hotspots', `${ranked.length} connected modules`);
  const note = document.createElement('p');
  note.className = 'dash-empty dash-card-note';
  note.textContent = 'Modules with the most incoming and outgoing imports. High coupling is a review signal, not automatically a defect.';
  body.append(note);
  const list = document.createElement('div');
  list.className = 'dash-list';
  for (const entry of ranked.slice(0, DASH_LIST_LIMIT)) {
    list.append(renderDashRow({
      label: entry.node.label,
      title: `${entry.incoming} incoming imports · ${entry.outgoing} outgoing imports`,
      count: `←${entry.incoming} →${entry.outgoing}`,
      nodeId: entry.node.id,
    }));
  }
  body.append(list);
  return card;
}

function usageCount(node: DiagramNode): number {
  return Number(node.metadata['Import usages']) || Number((node.subtitle ?? '').replace(/\D+/g, '')) || 0;
}

function renderDataCard(rowMatches: (text: string) => boolean, filtering: boolean): HTMLElement {
  const { card, body } = makeCard('Data', `${snapshot!.stats.databaseEntities} entities`);
  const entities = snapshot!.database.nodes
    .filter((node) => node.kind !== 'external-action' && !node.kind.includes('boundary'))
    .filter((node) => !filtering || rowMatches(`${node.label} ${node.subtitle ?? ''}`));
  if (!snapshot!.database.nodes.length) {
    const empty = document.createElement('p');
    empty.className = 'dash-empty';
    empty.textContent = 'No database schema detected.';
    body.append(empty);
    return card;
  }
  const metrics = document.createElement('div');
  metrics.className = 'dash-metrics';
  for (const [value, unit] of [
    [snapshot!.stats.databaseEntities, 'entities'],
    [snapshot!.stats.databaseRelations, 'relations'],
  ] as Array<[number, string]>) {
    const tile = document.createElement('div');
    tile.className = 'dash-metric';
    const strong = document.createElement('strong');
    strong.textContent = String(value);
    const span = document.createElement('span');
    span.textContent = unit;
    tile.append(strong, span);
    metrics.append(tile);
  }
  body.append(metrics);

  const shown = entities.slice(0, DASH_LIST_LIMIT);
  if (shown.length) {
    const list = document.createElement('div');
    list.className = 'dash-list';
    for (const node of shown) {
      list.append(renderDashRow({ label: node.label, title: node.subtitle ?? node.label, nodeId: node.id }));
    }
    body.append(list);
  }
  if (entities.length > shown.length) {
    const more = document.createElement('p');
    more.className = 'flow-more';
    more.textContent = `+${entities.length - shown.length} more`;
    body.append(more);
  }
  return card;
}

/** The little top-to-bottom diagram: the project's flow if one was traced. */
function renderFlowCard(): HTMLElement {
  const { card, body } = makeCard('Flow');
  const unit = snapshot!.flow.units.find((candidate) => candidate.kind === 'project') ?? snapshot!.flow.units[0];
  const steps = unit ? orderFlowNodes(unit.graph) : fallbackFlowSteps();
  if (!steps.length) {
    const empty = document.createElement('p');
    empty.className = 'dash-empty';
    empty.textContent = 'No flow was traced.';
    body.append(empty);
    return card;
  }
  if (!unit) {
    const caption = document.createElement('p');
    caption.className = 'dash-empty';
    caption.textContent = 'Module groups, by how much the rest of the project leans on them.';
    body.append(caption);
  }
  const strip = document.createElement('div');
  strip.className = 'dash-flow';
  const shown = steps.slice(0, FLOW_STRIP_LIMIT);
  shown.forEach((step, index) => {
    if (index > 0) {
      const arrow = document.createElement('div');
      arrow.className = 'flow-arrow';
      arrow.textContent = '↓';
      strip.append(arrow);
    }
    const box = document.createElement('div');
    box.className = 'flow-step';
    box.textContent = step;
    strip.append(box);
  });
  body.append(strip);
  if (steps.length > shown.length) {
    const more = document.createElement('p');
    more.className = 'flow-more';
    more.textContent = `+${steps.length - shown.length} more steps`;
    body.append(more);
  }
  return card;
}

/** A flow graph flattened to a reading order: from its roots, breadth first. */
function orderFlowNodes(graph: DiagramGraph): string[] {
  if (!graph.nodes.length) {
    return [];
  }
  const label = new Map<string, string>(graph.nodes.map((node): [string, string] => [node.id, node.label]));
  const incoming = new Map<string, number>(graph.nodes.map((node): [string, number] => [node.id, 0]));
  const next = new Map<string, string[]>(graph.nodes.map((node): [string, string[]] => [node.id, []]));
  for (const edge of graph.edges) {
    if (!label.has(edge.from) || !label.has(edge.to)) {
      continue;
    }
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
    next.get(edge.from)?.push(edge.to);
  }
  const roots = graph.nodes.filter((node) => (incoming.get(node.id) ?? 0) === 0).map((node) => node.id);
  const queue = roots.length ? [...roots] : [graph.nodes[0]!.id];
  const seen = new Set<string>();
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    order.push(label.get(id) ?? id);
    for (const target of next.get(id) ?? []) {
      if (!seen.has(target)) {
        queue.push(target);
      }
    }
  }
  for (const node of graph.nodes) {
    if (!seen.has(node.id)) {
      order.push(node.label);
    }
  }
  return order;
}

/** With no traced flow, the module groups ranked by how much depends on them. */
function fallbackFlowSteps(): string[] {
  if (!snapshot) {
    return [];
  }
  const groupById = new Map<string, string>();
  for (const node of snapshot.architecture.nodes) {
    if (node.kind === 'module') {
      groupById.set(node.id, declaredGroupOf(node, 'architecture') ?? 'Workspace');
    }
  }
  const dependedOn = new Map<string, number>();
  for (const edge of currentGraph()?.edges ?? []) {
    const from = groupById.get(edge.from);
    const to = groupById.get(edge.to);
    if (!from || !to || from === to) {
      continue;
    }
    dependedOn.set(to, (dependedOn.get(to) ?? 0) + 1);
  }
  return [...new Set(groupById.values())]
    .sort((left, right) => (dependedOn.get(right) ?? 0) - (dependedOn.get(left) ?? 0) || left.localeCompare(right))
    .slice(0, FLOW_STRIP_LIMIT);
}

// Kept for the hidden sidebar hand-off tree; the dashboard does not invoke it.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function renderTreeRow(row: TreeRow, filtering: boolean): HTMLElement {
  const { node } = row;
  const element = document.createElement('div');
  element.className = 'tree-row';
  element.classList.add(...(row.folder ? ['is-folder'] : ['is-file', `lang-${languageOf(node)}`]));
  element.classList.toggle('is-open', row.open);
  // The entry that answered the search, as against the folders around it, which
  // are drawn to say where it is rather than because they were asked for.
  element.classList.toggle('is-match', filtering && row.match);
  element.dataset.nodeId = node.id;
  element.dataset.depth = String(row.depth);
  element.tabIndex = -1;
  element.setAttribute('role', 'treeitem');
  element.setAttribute('aria-level', String(row.depth + 1));
  if (row.hasChildren) {
    element.setAttribute('aria-expanded', String(row.open));
  }
  element.title = node.path || node.label;

  const guides = document.createElement('span');
  guides.className = 'tree-guides';
  guides.setAttribute('aria-hidden', 'true');
  guides.textContent = connector(row);
  element.append(guides);

  // Every row keeps both of these columns whether or not it has anything to put
  // in them: the lines drawn to the left only meet if each row spends the same
  // width before its name.
  const twisty = document.createElement('span');
  twisty.className = 'tree-twisty';
  if (row.hasChildren) {
    twisty.append(useIcon(row.open ? 'chevron-down' : 'chevron-right'));
    twisty.title = row.open ? 'Collapse — alt-click for everything inside' : 'Expand — alt-click for everything inside';
  }
  element.append(twisty);

  const icon = document.createElement('span');
  icon.className = 'tree-icon';
  icon.append(useIcon(row.folder
    ? (row.open ? 'folder-open' : 'folder')
    : ICON_BY_LANGUAGE[languageOf(node)] ?? 'file'));
  element.append(icon);

  const name = document.createElement('span');
  name.className = 'tree-name';
  name.textContent = node.label;
  element.append(name);

  // What a folder is holding. It is the one thing the old treemap said that an
  // indented list does not, and it costs a column of small grey digits.
  if (row.folder) {
    const count = document.createElement('span');
    count.className = 'tree-count';
    count.textContent = String(row.files);
    count.title = `${row.files} file${row.files === 1 ? '' : 's'} inside`;
    element.append(count);
  }
  return element;
}

/**
 * One set of listeners on the container rather than three on each of several
 * thousand rows, which is also what lets the tree be rebuilt on every keystroke
 * of the search without re-wiring anything.
 */
function wireStructureEvents(): void {
  structureTree.addEventListener('click', (event) => {
    const element = treeElementFrom(event.target);
    const row = rowFor(element);
    if (!element || !row) {
      return;
    }
    element.focus({ preventScroll: true });
    selectNode(row.node.id);
    if (row.folder) {
      toggleFolder(row.node, event.altKey);
    }
  });

  structureTree.addEventListener('dblclick', (event) => {
    const row = rowFor(treeElementFrom(event.target));
    if (row && !row.folder) {
      vscode.postMessage({ type: 'openSource', nodeId: row.node.id });
    }
  });

  structureTree.addEventListener('keydown', (event) => onStructureKey(event));

  // A row in a group card, or a listed dependency or entity: the same selection
  // the tree makes, so the details panel and the other views follow along.
  dashGrid.addEventListener('click', (event) => {
    const row = event.target instanceof Element ? event.target.closest<HTMLElement>('.dash-row[data-node-id]') : null;
    if (row?.dataset.nodeId) {
      selectNode(row.dataset.nodeId);
    }
  });
  dashGrid.addEventListener('dblclick', (event) => {
    const row = event.target instanceof Element ? event.target.closest<HTMLElement>('.dash-row[data-node-id]') : null;
    if (row?.dataset.nodeId) {
      vscode.postMessage({ type: 'openSource', nodeId: row.dataset.nodeId });
    }
  });

  // The dashboard scrolls, so plain wheel belongs to the scroller; only the
  // gesture that means "zoom" everywhere else is taken. One listener on the
  // whole panel covers the tree nested inside it.
  structureDashboard.addEventListener('wheel', (event) => {
    if (!event.ctrlKey && !event.metaKey) {
      return;
    }
    event.preventDefault();
    scaleTree(event.deltaY < 0 ? 1.1 : 1 / 1.1);
  }, { passive: false });
}

/** One reference to a symbol in the sprite the host put in the document. */
function useIcon(name: string): SVGSVGElement {
  const svg = createSvgElement('svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = createSvgElement('use');
  use.setAttribute('href', `#codraw-${name}`);
  svg.append(use);
  return svg;
}

/** The row element an event landed in. */
function treeElementFrom(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>('.tree-row') : null;
}

/** A drawn row paired back up with the entry it was built from. */
function rowFor(element: HTMLElement | null): TreeRow | undefined {
  const id = element?.dataset.nodeId;
  return id ? treeRows.find((candidate) => candidate.node.id === id) : undefined;
}

function onStructureKey(event: KeyboardEvent): void {
  const elements = [...structureTree.querySelectorAll<HTMLElement>('.tree-row')];
  const focused = document.activeElement instanceof HTMLElement
    ? document.activeElement.closest<HTMLElement>('.tree-row')
    : null;
  const index = focused ? elements.indexOf(focused) : -1;
  const row = rowFor(focused);

  const moveTo = (next: number): void => {
    const target = elements[clamp(next, 0, elements.length - 1)];
    if (!target?.dataset.nodeId) {
      return;
    }
    event.preventDefault();
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'nearest' });
    selectNode(target.dataset.nodeId);
  };

  if (event.key === 'ArrowDown') {
    moveTo(index + 1);
  } else if (event.key === 'ArrowUp') {
    moveTo(index === -1 ? 0 : index - 1);
  } else if (event.key === 'Home') {
    moveTo(0);
  } else if (event.key === 'End') {
    moveTo(elements.length - 1);
  } else if (event.key === 'ArrowRight' && row) {
    event.preventDefault();
    if (row.hasChildren && !row.open) {
      toggleFolder(row.node, false);
    } else if (row.open) {
      moveTo(index + 1);
    }
  } else if (event.key === 'ArrowLeft' && row) {
    event.preventDefault();
    if (row.open) {
      toggleFolder(row.node, false);
    } else {
      // Out to the folder holding this row: the nearest row above it drawn
      // further left.
      let parent = index - 1;
      while (parent >= 0 && Number(elements[parent]?.dataset.depth) >= row.depth) {
        parent -= 1;
      }
      if (parent >= 0) {
        moveTo(parent);
      }
    }
  } else if ((event.key === 'Enter' || event.key === ' ') && row) {
    event.preventDefault();
    if (row.folder) {
      toggleFolder(row.node, event.altKey);
    } else {
      vscode.postMessage({ type: 'openSource', nodeId: row.node.id });
    }
  } else if (event.key.toLowerCase() === 'o' && row && !row.folder) {
    event.preventDefault();
    vscode.postMessage({ type: 'openSource', nodeId: row.node.id });
  }
}

/** Opens or shuts one folder — or, with `deep`, the whole branch under it. */
function toggleFolder(node: StructureNode, deep: boolean): void {
  const closing = !collapsedPaths.has(node.path);
  const apply = (target: StructureNode): void => {
    if (target.kind !== 'folder') {
      return;
    }
    if (closing) {
      collapsedPaths.add(target.path);
    } else {
      collapsedPaths.delete(target.path);
    }
    if (deep) {
      for (const child of target.children) {
        apply(child);
      }
    }
  };
  apply(node);
  persistState();
  redrawTree(node.id);
}

/** The toolbar's fold: everything shut, or everything open again. */
function toggleWholeTree(): void {
  if (!snapshot) {
    return;
  }
  const collapsing = anyFolderOpen();
  collapsedPaths.clear();
  if (collapsing) {
    const shut = (node: StructureNode): void => {
      for (const child of node.children) {
        if (child.kind === 'folder' && child.children.length) {
          collapsedPaths.add(child.path);
          shut(child);
        }
      }
    };
    shut(snapshot.structure);
  }
  persistState();
  redrawTree(selectedId);
  announce(collapsing ? 'Tree collapsed.' : 'Tree expanded.');
}

/** Whether the fold still has anything left to shut. */
function anyFolderOpen(): boolean {
  if (!snapshot) {
    return true;
  }
  const walk = (node: StructureNode): boolean => node.children.some((child) =>
    child.kind === 'folder'
    && child.children.length > 0
    && (!collapsedPaths.has(child.path) || walk(child)));
  return walk(snapshot.structure);
}

/**
 * Opens the folders between the root and a path. Following the editor into a
 * file the reader had folded away is the one time the tree opens itself.
 */
function revealAncestors(path: string): boolean {
  const parts = path.split('/');
  let opened = false;
  for (let depth = parts.length - 1; depth > 0; depth -= 1) {
    if (collapsedPaths.delete(parts.slice(0, depth).join('/'))) {
      opened = true;
    }
  }
  if (opened) {
    persistState();
  }
  return opened;
}

/** Rebuilds the rows, putting the keyboard back where it was. */
function redrawTree(focusNodeId: string | undefined): void {
  renderStructure();
  if (!focusNodeId) {
    return;
  }
  structureTree
    .querySelector<HTMLElement>(`[data-node-id="${escapeAttribute(focusNodeId)}"]`)
    ?.focus({ preventScroll: true });
  ensureRowVisible(focusNodeId);
}

/** The view's answer to zoom: the text itself, against the editor's own size. */
function scaleTree(factor: number): void {
  const next = clamp(treeScale * factor, MIN_TREE_SCALE, MAX_TREE_SCALE);
  if (next === treeScale) {
    return;
  }
  treeScale = next;
  structureDashboard.style.setProperty('--codraw-tree-scale', String(treeScale));
  interfaceDashboard.style.setProperty('--codraw-tree-scale', String(treeScale));
  persistState();
}

/**
 * What the workspace is written in, named and counted, along the status bar.
 *
 * The tree tints each file name by language, and without this the reader can
 * see that the project is two thirds one colour with no way to find out which
 * language that is — which is most of what the colour had to say.
 */
function renderLanguageLegend(): void {
  if (!snapshot) {
    return;
  }
  const totals = new Map<string, number>();
  const walk = (node: StructureNode): void => {
    if (node.kind === 'file') {
      const language = languageOf(node);
      totals.set(language, (totals.get(language) ?? 0) + 1);
      return;
    }
    for (const child of node.children) {
      walk(child);
    }
  };
  walk(snapshot.structure);

  clearElement(technologyList);
  const ordered = [...totals]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 8);
  for (const [language, count] of ordered) {
    const item = document.createElement('span');
    item.className = `legend-item lang-${language}`;
    const swatch = document.createElement('span');
    swatch.className = 'legend-swatch';
    item.append(swatch, document.createTextNode(`${LANGUAGE_LABELS[language] ?? 'Other'} ${count}`));
    technologyList.append(item);
  }
}

/**
 * The interfaces view.
 *
 * Three questions in the order somebody actually asks them: what does this
 * project speak, where is it reached, and what can be called. So the protocols
 * are named first as chips, the ports come next as one list, and each protocol
 * then gets its own card holding the operations it exposes.
 *
 * Not a diagram. An endpoint has no neighbours to lay out — the relationships
 * that matter here are "these belong to the same protocol" and "these answer on
 * the same port", and both are better said by putting the rows next to each
 * other than by drawing a line between two boxes.
 */

/** Endpoint rows one protocol's card lists before it says how many more. */
const ENDPOINT_ROWS = 60;

/**
 * The colour a verb is read in. Grouped by what the operation does rather than
 * by protocol, so `GET`, `subscribe` and `query` — three protocols, one act of
 * reading — look alike down a page that mixes them.
 */
const OPERATION_TONE: Record<string, string> = {
  GET: 'read', HEAD: 'read', OPTIONS: 'read', QUERY: 'read', SUBSCRIBE: 'read', CONSUME: 'read',
  ON: 'read', STREAM: 'read',
  POST: 'write', PUBLISH: 'write', EMIT: 'write', MUTATION: 'write', SEND: 'write',
  PUT: 'change', PATCH: 'change', MESSAGE: 'change', EVENT: 'change',
  DELETE: 'remove',
  RPC: 'listen', SUBSCRIPTION: 'listen', CONNECT: 'listen', DECLARE: 'listen',
  RESOURCE: 'listen', ANY: 'listen',
};

/** What a port declaration is worth, in one word, tinted the same way. */
const PORT_KIND_TONE: Record<PortBinding['kind'], string> = {
  listen: 'listen',
  expose: 'read',
  published: 'write',
  config: 'change',
};

const PORT_KIND_LABEL: Record<PortBinding['kind'], string> = {
  listen: 'binds',
  expose: 'exposes',
  published: 'publishes',
  config: 'setting',
};

function renderInterfaces(): void {
  if (!snapshot) {
    return;
  }
  currentLayout = undefined;
  contentBounds = undefined;
  const catalog = snapshot.interfaces;
  if (!catalog.surfaces.length && !catalog.ports.length) {
    showState(catalog.emptyMessage, 'empty');
    return;
  }

  const query = normalizeSearch(searchQuery);
  const matches = (text: string): boolean => !query || normalizeSearch(text).includes(query);
  const filtered = catalog.surfaces.map((surface) => ({
    surface,
    endpoints: surface.endpoints.filter((endpoint) => matches(endpointSearchText(endpoint))),
  }));
  const ports = catalog.ports.filter((port) => matches(portSearchText(port)));
  const shown = filtered.filter(({ surface, endpoints }) => endpoints.length || (!query && !surface.hiddenEndpoints));
  if (query && !ports.length && !shown.some(({ endpoints }) => endpoints.length)) {
    showState('Nothing here matches that search.', 'empty');
    return;
  }

  stateView.hidden = true;
  setHidden(graphCanvas, true);
  setHidden(interfaceDashboard, false);
  interfaceDashboard.style.setProperty('--codraw-tree-scale', String(treeScale));
  clearElement(interfaceGrid);

  if (!query) {
    interfaceGrid.append(renderProtocolSummaryCard(catalog.surfaces, catalog.ports));
  }
  if (ports.length) {
    interfaceGrid.append(renderPortsCard(ports, catalog.ports.length));
  }
  for (const { surface, endpoints } of shown) {
    interfaceGrid.append(renderProtocolCard(surface, endpoints, Boolean(query)));
  }

  applyInterfaceSelection();
  if (query) {
    const total = shown.reduce((sum, entry) => sum + entry.endpoints.length, 0);
    announce(`${total} endpoint${total === 1 ? '' : 's'} and ${ports.length} port${ports.length === 1 ? '' : 's'} match.`);
  }
}

/** What the project speaks, before any of it is listed. */
function renderProtocolSummaryCard(
  surfaces: readonly ProtocolSurface[],
  ports: readonly PortBinding[],
): HTMLElement {
  const card = document.createElement('div');
  card.className = 'dash-card dash-card--summary';

  const name = document.createElement('p');
  name.className = 'dash-name';
  name.textContent = 'Outside edges';
  card.append(name);

  const kind = document.createElement('p');
  kind.className = 'dash-kind';
  kind.textContent = surfaces.map((surface) => surface.label).join(' · ') || 'No protocol detected';
  card.append(kind);

  const metrics = document.createElement('div');
  metrics.className = 'dash-metrics';
  const endpoints = surfaces.reduce((total, surface) => total + surface.endpoints.length + surface.hiddenEndpoints, 0);
  const listening = ports.filter((port) => port.kind === 'listen' || port.kind === 'expose').length;
  for (const [value, unit] of [
    [surfaces.length, 'protocols'],
    [endpoints, 'endpoints'],
    [ports.length, 'port declarations'],
    [listening, 'bound or exposed'],
  ] as Array<[number, string]>) {
    const tile = document.createElement('div');
    tile.className = 'dash-metric';
    const strong = document.createElement('strong');
    strong.textContent = String(value);
    const span = document.createElement('span');
    span.textContent = unit;
    tile.append(strong, span);
    metrics.append(tile);
  }
  card.append(metrics);

  const chips = document.createElement('div');
  chips.className = 'if-chips';
  for (const surface of surfaces) {
    const found = surface.endpoints.length + surface.hiddenEndpoints;
    const chip = document.createElement('span');
    chip.className = 'if-chip';
    chip.textContent = surface.label;
    const count = document.createElement('span');
    count.className = 'if-chip__count';
    count.textContent = found ? String(found) : '—';
    chip.title = found
      ? `${found} endpoint${found === 1 ? '' : 's'} declared`
      : 'A port points at this protocol, but no endpoint declaration was readable.';
    chip.append(count);
    chips.append(chip);
  }
  card.append(chips);

  const note = document.createElement('p');
  note.className = 'dash-empty dash-card-note';
  note.textContent = 'Read from declarations in the source: routers, annotations, schema files, container manifests, and settings. Routes registered at run time, ports from environment files, and addresses built out of variables are not visible here.';
  card.append(note);
  return card;
}

function renderPortsCard(ports: readonly PortBinding[], total: number): HTMLElement {
  const { card, body } = makeCard('Ports', `${total}`);
  card.classList.add('dash-card--ports');
  cardNote(body, 'Where the project is reached. A binding in code is the program itself opening the port; an image or compose file says which port the outside world sees; a setting is a default something else reads.');
  const list = document.createElement('div');
  list.className = 'dash-list';
  for (const port of ports) {
    list.append(renderInterfaceRow({
      tag: PORT_KIND_LABEL[port.kind],
      tone: PORT_KIND_TONE[port.kind],
      label: portLabel(port),
      meta: `${port.source.file}:${port.source.line}`,
      count: port.note ?? protocolLabelOf(port.protocol),
      title: `${port.evidence}\n${port.source.file}:${port.source.line}`,
      nodeId: port.id,
      // Marked only where the number itself is missing. A port read from a
      // settings file is a real number; it is the `listen(PORT)` with nothing
      // to resolve `PORT` against that the reader has to treat as a name.
      inferred: port.port === undefined,
    }));
  }
  body.append(list);
  return card;
}

function renderProtocolCard(
  surface: ProtocolSurface,
  endpoints: readonly ProtocolEndpoint[],
  filtering: boolean,
): HTMLElement {
  const found = surface.endpoints.length + surface.hiddenEndpoints;
  const { card, body } = makeCard(surface.label, filtering
    ? `${endpoints.length} of ${found}`
    : `${found} endpoint${found === 1 ? '' : 's'}`);
  card.classList.add('dash-card--protocol');
  // Sized by what the protocol holds rather than by what a search left of it:
  // an address does not get shorter when it is filtered, and a card that
  // narrows under a search cuts the very rows the reader went looking for.
  if (found > 8) {
    card.classList.add('is-wide');
  }
  cardNote(body, surface.frameworks.length
    ? `${surface.description} Read from: ${surface.frameworks.join(', ')}.`
    : surface.description);

  if (!endpoints.length) {
    const empty = document.createElement('p');
    empty.className = 'dash-empty';
    empty.textContent = 'A port points at this protocol, but no endpoint declaration could be read.';
    body.append(empty);
    return card;
  }

  const shown = endpoints.slice(0, ENDPOINT_ROWS);
  const list = document.createElement('div');
  list.className = 'dash-list';
  for (const endpoint of shown) {
    list.append(renderInterfaceRow({
      tag: endpoint.operation,
      tone: OPERATION_TONE[endpoint.operation.toUpperCase()] ?? 'listen',
      label: endpoint.address,
      ...(endpoint.handler ? { meta: endpoint.handler } : {}),
      title: `${endpoint.operation} ${endpoint.address}\n${endpoint.source.file}:${endpoint.source.line}`,
      nodeId: endpoint.id,
      inferred: endpoint.confidence !== 'exact',
    }));
  }
  body.append(list);
  const hidden = endpoints.length - shown.length + (filtering ? 0 : surface.hiddenEndpoints);
  if (hidden > 0) {
    const more = document.createElement('p');
    more.className = 'flow-more';
    more.textContent = `+${hidden} more`;
    body.append(more);
  }
  return card;
}

function renderInterfaceRow(spec: {
  tag: string;
  tone?: string;
  label: string;
  meta?: string;
  count?: string;
  title: string;
  nodeId: string;
  inferred?: boolean;
}): HTMLElement {
  const row = renderDashRow({
    label: spec.label,
    title: spec.title,
    nodeId: spec.nodeId,
    ...(spec.meta === undefined ? {} : { meta: spec.meta }),
    ...(spec.count === undefined ? {} : { count: spec.count }),
  });
  row.classList.add('if-row');
  if (spec.inferred) {
    row.classList.add('is-inferred');
  }
  const tag = document.createElement('span');
  tag.className = 'if-tag';
  if (spec.tone) {
    tag.dataset.tone = spec.tone;
  }
  tag.textContent = spec.tag;
  row.prepend(tag);
  return row;
}

/** `8080`, `18080 → 8080` for a published mapping, or the name it was read from. */
function portLabel(port: PortBinding): string {
  if (port.port === undefined) {
    return port.declaredAs ?? 'unknown';
  }
  const transport = port.transport === 'udp' ? '/udp' : '';
  return port.hostPort === undefined
    ? `${port.port}${transport}`
    : `${port.hostPort} → ${port.port}${transport}`;
}

function protocolLabelOf(protocol: PortBinding['protocol']): string {
  return snapshot?.interfaces.surfaces.find((surface) => surface.protocol === protocol)?.label ?? protocol;
}

function endpointSearchText(endpoint: ProtocolEndpoint): string {
  return `${endpoint.operation} ${endpoint.address} ${endpoint.handler ?? ''} ${endpoint.module ?? ''} ${endpoint.source.file}`;
}

function portSearchText(port: PortBinding): string {
  return `${port.port ?? ''} ${port.hostPort ?? ''} ${port.declaredAs ?? ''} ${port.note ?? ''} ${port.evidence} ${port.source.file}`;
}

/** The reader's row, marked on whichever protocol card holds it. */
function applyInterfaceSelection(): void {
  for (const element of interfaceGrid.querySelectorAll<HTMLElement>('.dash-row[data-node-id]')) {
    element.classList.toggle('is-selected', element.dataset.nodeId === selectedId);
  }
}

function wireInterfaceEvents(): void {
  interfaceGrid.addEventListener('click', (event) => {
    const row = event.target instanceof Element ? event.target.closest<HTMLElement>('.dash-row[data-node-id]') : null;
    if (row?.dataset.nodeId) {
      selectNode(row.dataset.nodeId);
    }
  });
  interfaceGrid.addEventListener('dblclick', (event) => {
    const row = event.target instanceof Element ? event.target.closest<HTMLElement>('.dash-row[data-node-id]') : null;
    if (row?.dataset.nodeId) {
      vscode.postMessage({ type: 'openSource', nodeId: row.dataset.nodeId });
    }
  });
  interfaceDashboard.addEventListener('wheel', (event) => {
    if (!event.ctrlKey && !event.metaKey) {
      return;
    }
    event.preventDefault();
    scaleTree(event.deltaY < 0 ? 1.1 : 1 / 1.1);
  }, { passive: false });
}

/**
 * An endpoint or a port, in the shape the details panel reads. Neither is a
 * graph node, but both answer the same three questions a node does — what is
 * this, what was it read from, and where is it — so they are described the same
 * way rather than given a second panel of their own.
 */
function selectedInterfaceDetails(id: string): {
  id: string;
  label: string;
  kind: string;
  subtitle?: string;
  source?: SourceRef;
  metadata: Record<string, string | string[]>;
} | undefined {
  const catalog = snapshot?.interfaces;
  if (!catalog) {
    return undefined;
  }
  for (const surface of catalog.surfaces) {
    const endpoint = surface.endpoints.find((candidate) => candidate.id === id);
    if (endpoint) {
      return {
        id: endpoint.id,
        label: `${endpoint.operation} ${endpoint.address}`,
        kind: `${surface.label} endpoint`,
        ...(endpoint.handler ? { subtitle: `Handled by ${endpoint.handler}` } : {}),
        source: endpoint.source,
        metadata: {
          Protocol: surface.label,
          Operation: endpoint.operation,
          Address: endpoint.address,
          ...(endpoint.handler ? { Handler: endpoint.handler } : {}),
          ...(endpoint.module ? { Module: endpoint.module } : {}),
          ...(endpoint.framework ? { 'Read from': endpoint.framework } : {}),
          Evidence: endpoint.confidence === 'exact' ? 'Declared literally' : 'Assembled from the declaration',
          ...(endpoint.metadata ?? {}),
        },
      };
    }
  }
  const port = catalog.ports.find((candidate) => candidate.id === id);
  if (!port) {
    return undefined;
  }
  return {
    id: port.id,
    label: portLabel(port),
    kind: `${protocolLabelOf(port.protocol)} port`,
    subtitle: port.evidence,
    source: port.source,
    metadata: {
      Declaration: PORT_KIND_LABEL[port.kind],
      Protocol: protocolLabelOf(port.protocol),
      ...(port.port === undefined ? {} : { Port: String(port.port) }),
      ...(port.hostPort === undefined ? {} : { 'Published as': String(port.hostPort) }),
      ...(port.declaredAs ? { 'Declared as': port.declaredAs } : {}),
      ...(port.transport ? { Transport: port.transport.toUpperCase() } : {}),
      ...(port.note ? { 'Usually serves': port.note } : {}),
      Evidence: port.confidence === 'exact' ? 'A literal port in the declaration' : 'Read from a name rather than a number',
    },
  };
}

function renderDetails(): void {
  clearElement(detailsContent);
  if (!snapshot) {
    appendParagraph(detailsContent, 'Waiting for workspace analysis.');
    return;
  }
  const selected = findSelectedNode();
  if (!selected) {
    // With a subject area open and nothing picked inside it, the useful thing
    // to say is what the area is: the boundary it was read off, what it holds,
    // and what it hands to its neighbours.
    const scopedData = activeView === 'database' ? currentArea() : undefined;
    if (scopedData) {
      renderAreaDetails(scopedData);
      return;
    }
    const scopedArchitectureArea = activeView === 'architecture' ? currentArchitectureArea() : undefined;
    if (scopedArchitectureArea) {
      renderArchitectureAreaDetails(scopedArchitectureArea);
      return;
    }
    appendParagraph(detailsContent, 'Select an item to see why it appears here and open the source behind it.');
    if (snapshot.diagnostics.length) {
      const heading = document.createElement('h3');
      heading.textContent = 'Analysis notes';
      detailsContent.append(heading);
      const list = document.createElement('ul');
      list.className = 'diagnostic-list';
      for (const diagnostic of snapshot.diagnostics.slice(0, 12)) {
        const item = document.createElement('li');
        const code = document.createElement('code');
        code.textContent = diagnostic.code;
        item.append(code, document.createTextNode(` ${diagnostic.message}`));
        list.append(item);
      }
      detailsContent.append(list);
    }
    return;
  }

  const areaKey = activeView === 'database' ? areaKeyOfNodeId(selected.id) : undefined;
  const area = areaKey === undefined ? undefined : databaseMap?.areas.find((candidate) => candidate.key === areaKey);
  if (area) {
    renderAreaDetails(area);
    return;
  }
  const architectureKey = activeView === 'architecture' ? architectureAreaKeyOfNodeId(selected.id) : undefined;
  const architectureArea = architectureKey === undefined
    ? undefined : architectureMap?.areas.find((candidate) => candidate.key === architectureKey);
  if (architectureArea) {
    renderArchitectureAreaDetails(architectureArea);
    return;
  }

  const heading = document.createElement('h3');
  heading.textContent = selected.label;
  detailsContent.append(heading);
  const kind = document.createElement('p');
  kind.className = 'detail-kind';
  kind.textContent = selected.kind;
  detailsContent.append(kind);
  if (selected.subtitle) appendParagraph(detailsContent, selected.subtitle);

  if (selected.source) {
    const source = document.createElement('p');
    source.className = 'source-location';
    source.textContent = `${selected.source.file}:${selected.source.line}`;
    detailsContent.append(source);
    const openButton = document.createElement('button');
    openButton.type = 'button';
    openButton.className = 'primary-button';
    openButton.textContent = 'Open source';
    openButton.addEventListener('click', () => vscode.postMessage({ type: 'openSource', nodeId: selected.id }));
    detailsContent.append(openButton);
  }

  if (Object.keys(selected.metadata).length) {
    const metadataHeading = document.createElement('h3');
    metadataHeading.textContent = 'Evidence';
    detailsContent.append(metadataHeading);
    const definitionList = document.createElement('dl');
    definitionList.className = 'metadata-list';
    for (const [label, value] of Object.entries(selected.metadata)) {
      const term = document.createElement('dt');
      term.textContent = label;
      const description = document.createElement('dd');
      if (Array.isArray(value)) {
        const list = document.createElement('ul');
        for (const itemValue of value) {
          const item = document.createElement('li');
          item.textContent = itemValue;
          list.append(item);
        }
        description.append(list);
      } else {
        description.textContent = value;
      }
      definitionList.append(term, description);
    }
    detailsContent.append(definitionList);
  }

  const graph = currentGraph();
  if (graph) renderRelations(graph, selected.id);
}

/** Tables the details panel lists for an area before it says how many more. */
const AREA_TABLE_ROWS = 120;

function renderArchitectureAreaDetails(area: ArchitectureArea): void {
  const heading = document.createElement('h3');
  heading.textContent = area.label;
  detailsContent.append(heading);
  const kind = document.createElement('p');
  kind.className = 'detail-kind';
  kind.textContent = 'repository area';
  detailsContent.append(kind);
  appendParagraph(detailsContent, `${area.modules} modules · ${area.files} files · `
    + `${area.internalDependencies} dependencies inside · ${area.crossDependencies} crossing the boundary`);

  const scoped = currentArchitectureArea()?.key === area.key;
  const action = document.createElement('button');
  action.type = 'button';
  action.className = 'primary-button';
  action.textContent = scoped ? 'Back to repository map' : 'Open this area';
  action.addEventListener('click', () => scoped
    ? setArchitectureScope(ARCHITECTURE_MAP)
    : openArchitectureArea(area.key));
  detailsContent.append(action);

  if (area.neighbours.length) {
    const neighbourHeading = document.createElement('h3');
    neighbourHeading.textContent = 'Connected areas';
    detailsContent.append(neighbourHeading);
    const list = document.createElement('ul');
    list.className = 'relation-list';
    for (const neighbour of area.neighbours) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'relation-button';
      button.textContent = `↔ ${neighbour.label} · ${neighbour.count}`;
      button.addEventListener('click', () => openArchitectureArea(neighbour.key));
      item.append(button);
      list.append(item);
    }
    detailsContent.append(list);
  }

  const moduleHeading = document.createElement('h3');
  moduleHeading.textContent = 'Modules';
  detailsContent.append(moduleHeading);
  const modules = document.createElement('ul');
  modules.className = 'relation-list';
  for (let index = 0; index < area.moduleIds.length; index += 1) {
    const nodeId = area.moduleIds[index];
    const label = area.moduleLabels[index];
    if (!nodeId || !label) continue;
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'relation-button';
    button.textContent = label;
    button.addEventListener('click', () => {
      if (currentArchitectureArea()?.key === area.key) {
        selectNode(nodeId);
        centerNode(nodeId);
      } else openArchitectureArea(area.key, nodeId);
    });
    item.append(button);
    modules.append(item);
  }
  detailsContent.append(modules);
}

/**
 * What a subject area is, in the panel beside its diagram.
 *
 * A diagram on its own does not document a schema — it shows shape, and leaves
 * the reader to guess what the shape is of. So the area is written out too: the
 * boundary it was read off, every table in it by name, and what it hands to the
 * areas next to it. That list is the part someone actually reads twice.
 */
function renderAreaDetails(area: SubjectArea): void {
  const heading = document.createElement('h3');
  heading.textContent = area.label;
  detailsContent.append(heading);
  const kind = document.createElement('p');
  kind.className = 'detail-kind';
  kind.textContent = 'subject area';
  detailsContent.append(kind);
  appendParagraph(detailsContent, area.origin);
  appendParagraph(detailsContent, [
    entityCountLabel(area.entities, area.noun),
    `${area.internalRelations} ${area.internalRelations === 1 ? 'relationship' : 'relationships'} inside`,
    `${area.crossRelations} leaving`,
    ...(area.unresolved ? [`${area.unresolved} unresolved targets`] : []),
  ].join(' · '));

  if (area.oversized) {
    const note = document.createElement('p');
    note.className = 'detail-note';
    note.textContent = `This area holds more than ${AREA_ENTITY_TARGET} tables, which is more than one diagram`
      + ' reads well at. The schema declares no finer boundary inside it, so narrow it with the search box'
      + ' or follow one table\'s relationships from the list below.';
    detailsContent.append(note);
  }

  const scoped = currentArea()?.key === area.key;
  const action = document.createElement('button');
  action.type = 'button';
  action.className = 'primary-button';
  action.textContent = scoped ? 'Back to the area map' : 'Open this area';
  action.addEventListener('click', () => (scoped ? setDataScope(AREA_MAP) : openArea(area.key)));
  detailsContent.append(action);

  if (area.neighbours.length) {
    const neighbourHeading = document.createElement('h3');
    neighbourHeading.textContent = 'Borders';
    detailsContent.append(neighbourHeading);
    const list = document.createElement('ul');
    list.className = 'relation-list';
    for (const neighbour of area.neighbours) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'relation-button';
      button.textContent = `↔ ${neighbour.label} · ${neighbour.count}`;
      button.addEventListener('click', () => openArea(neighbour.key));
      item.append(button);
      list.append(item);
    }
    detailsContent.append(list);
  }

  const tableHeading = document.createElement('h3');
  tableHeading.textContent = 'Tables';
  detailsContent.append(tableHeading);
  const tables = document.createElement('ul');
  tables.className = 'relation-list';
  const shown = Math.min(area.nodeIds.length, AREA_TABLE_ROWS);
  for (let index = 0; index < shown; index += 1) {
    const nodeId = area.nodeIds[index];
    const label = area.entityLabels[index];
    if (nodeId === undefined || label === undefined) continue;
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'relation-button';
    button.textContent = label;
    button.addEventListener('click', () => {
      if (currentArea()?.key === area.key) {
        selectNode(nodeId);
        centerNode(nodeId);
      } else {
        openArea(area.key, nodeId);
      }
    });
    item.append(button);
    tables.append(item);
  }
  detailsContent.append(tables);
  if (area.nodeIds.length > shown) {
    appendParagraph(detailsContent, `… ${area.nodeIds.length - shown} more`);
  }
}

function renderRelations(graph: DiagramGraph, nodeId: string): void {
  const relations = graph.edges.filter((edge) => edge.from === nodeId || edge.to === nodeId);
  if (!relations.length) {
    return;
  }
  const heading = document.createElement('h3');
  heading.textContent = 'Relationships';
  detailsContent.append(heading);
  const list = document.createElement('ul');
  list.className = 'relation-list';
  for (const edge of relations) {
    const incoming = edge.to === nodeId;
    const otherId = incoming ? edge.from : edge.to;
    const other = graph.nodes.find((node) => node.id === otherId);
    if (!other) continue;
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'relation-button';
    button.textContent = `${incoming ? '←' : '→'} ${other.label}${edge.label ? ` · ${edge.label}` : ''}`;
    button.addEventListener('click', () => {
      selectNode(other.id);
      centerNode(other.id);
    });
    item.append(button);
    list.append(item);
  }
  detailsContent.append(list);
}

function renderStatus(): void {
  if (!snapshot) return;
  const graph = currentGraph();
  const base = graph
    ? `${graph.nodes.length} nodes · ${graph.edges.length} relationships`
      + (activeView === 'flow' && selectedFlowUnit() ? ` · ${selectedFlowUnit()?.label}` : '')
      + architectureScopeNote()
      + dataScopeNote()
    : activeView === 'interfaces'
      ? `${snapshot.stats.protocols} protocol${snapshot.stats.protocols === 1 ? '' : 's'}`
        + ` · ${snapshot.stats.endpoints} endpoints · ${snapshot.stats.ports} port declarations`
      : `${snapshot.stats.files} files`;
  const warnings = snapshot.diagnostics.filter((diagnostic) => diagnostic.severity === 'warning').length;
  const analyzedAt = formatTime(snapshot.generatedAt);
  statusText.textContent = [
    base,
    ...(warnings ? [`${warnings} warnings`] : []),
    ...(analyzedAt ? [`analyzed ${analyzedAt}`] : []),
    'static analysis',
  ].join(' · ');
}

function architectureScopeNote(): string {
  if (activeView !== 'architecture' || !architectureMap) return '';
  if (architectureScope === ARCHITECTURE_MAP) {
    return ` · ${architectureMap.areas.length} repository areas · ${architectureMap.modules} modules in all`;
  }
  const area = currentArchitectureArea();
  if (area) return ` · ${area.label} · ${area.modules} modules`;
  return architectureMap.modules > ARCHITECTURE_MODULE_TARGET
    ? ` · complete graph · over ${ARCHITECTURE_MODULE_TARGET} modules`
    : ' · complete graph';
}

/** What the status bar says about the scope the data view is reading at. */
function dataScopeNote(): string {
  if (activeView !== 'database' || !databaseMap) {
    return '';
  }
  if (dataScope === AREA_MAP) {
    return ` · ${databaseMap.areas.length} subject areas · ${databaseMap.entities} tables in all`;
  }
  const area = currentArea();
  if (area) {
    return ` · ${area.label}${area.oversized ? ` · over ${AREA_ENTITY_TARGET} tables` : ''}`;
  }
  return databaseMap.entities > AREA_ENTITY_TARGET
    ? ` · whole schema · over ${AREA_ENTITY_TARGET} tables`
    : ' · whole schema';
}

/**
 * Switches to whichever view owns the node before selecting it, so a row picked
 * in the sidebar lands on something visible rather than selecting silently in a
 * view that is not on screen.
 */
function focusOnNode(nodeId: string): void {
  if (!snapshot) {
    return;
  }
  const owner: ViewMode | undefined =
    snapshot.architecture.nodes.some((node) => node.id === nodeId) ? 'architecture'
      : snapshot.flow.units.some((unit) => unit.graph.nodes.some((node) => node.id === nodeId)) ? 'flow'
        : snapshot.database.nodes.some((node) => node.id === nodeId) ? 'database'
          : findStructureNode(snapshot.structure, nodeId) ? 'structure'
            : undefined;
  if (!owner) {
    return;
  }
  let rescoped = false;
  if (owner === 'flow') {
    flowUnitId = snapshot.flow.units.find((unit) => unit.graph.nodes.some((node) => node.id === nodeId))?.id;
    renderFlowScopeOptions();
  }
  if (owner === 'architecture' && architectureScope !== WHOLE_ARCHITECTURE) {
    const key = architectureMap?.areaOf.get(nodeId);
    if (key !== undefined && key !== architectureScope) {
      architectureScope = key;
      renderArchitectureScopeOptions();
      needsFit.add('architecture');
      rescoped = true;
    }
  }
  if (owner === 'database' && dataScope !== WHOLE_SCHEMA) {
    // A row handed over from the sidebar names a table, not an area, and the
    // data view may be scoped to a different one. Follow it to the area it is
    // actually in rather than selecting it somewhere it cannot be seen.
    const key = databaseMap?.areaOf.get(nodeId);
    if (key !== undefined && key !== dataScope) {
      dataScope = key;
      renderDataScopeOptions();
      needsFit.add('database');
      rescoped = true;
    }
  }
  if (owner !== activeView) {
    activeView = owner;
    render();
  } else if (rescoped) {
    render();
  }
  selectNode(nodeId);
  if (owner === 'structure') {
    // A row handed over from the sidebar may be inside folders this view has
    // shut, in which case there is nothing yet to scroll to.
    const node = findStructureNode(snapshot.structure, nodeId);
    if (node && revealAncestors(node.path)) {
      renderStructure();
    }
    ensureRowVisible(nodeId);
  }
}

function selectNode(nodeId: string): void {
  selectedId = nodeId;
  if (activeView === 'structure') applyStructureSelection();
  else if (activeView === 'interfaces') applyInterfaceSelection();
  else applySelectionStyles();
  focusButton.disabled = !['architecture', 'database'].includes(activeView) || !focusTargetNodeId();
  if (activeView === 'architecture' || activeView === 'database') {
    applyFocusStyles();
    if (focusMode) fitCurrentGraph();
  }
  renderDetails();
  persistState();
}

/** Brings one node's relationships forward out of the texture. */
function highlightNeighbourhood(nodeId: string | undefined): void {
  for (const element of viewportGroup.querySelectorAll<SVGGElement>('.graph-edge')) {
    const highlighted = Boolean(nodeId) && (element.dataset.from === nodeId || element.dataset.to === nodeId);
    element.classList.toggle('is-highlighted', highlighted);
    // SVG has no dependable z-index. Moving the few traced lines to the end of
    // their layer keeps them visible above the background bundle.
    if (highlighted) element.parentElement?.append(element);
  }
}

function applySelectionStyles(): void {
  for (const element of viewportGroup.querySelectorAll<SVGGElement>('.graph-node')) {
    element.classList.toggle('is-selected', element.dataset.nodeId === selectedId);
  }
  for (const element of viewportGroup.querySelectorAll<SVGGElement>('.graph-edge')) {
    const connected = Boolean(selectedId) && (element.dataset.from === selectedId || element.dataset.to === selectedId);
    element.classList.toggle('is-connected', connected);
    if (connected) element.parentElement?.append(element);
  }
}

/** The reader's row, and the editor's, marked on whichever rows are drawn. */
function applyStructureSelection(): void {
  for (const element of structureTree.querySelectorAll<HTMLElement>('.tree-row')) {
    element.classList.toggle('is-selected', element.dataset.nodeId === selectedId);
    element.classList.toggle('is-current', element.dataset.nodeId === active?.structureNodeId);
  }
  for (const element of dashGrid.querySelectorAll<HTMLElement>('.dash-row[data-node-id]')) {
    const id = element.dataset.nodeId;
    element.classList.toggle('is-selected', id === selectedId);
    element.classList.toggle('is-current', Boolean(id) && (id === active?.moduleNodeId || id === active?.structureNodeId));
  }
}

function applyGraphSearch(): void {
  const query = normalizeSearch(searchQuery);
  let matches = 0;
  for (const element of viewportGroup.querySelectorAll<SVGGElement>('.graph-node')) {
    const match = !query || (element.dataset.searchText ?? '').includes(query);
    element.classList.toggle('is-search-match', Boolean(query) && match);
    element.classList.toggle('is-dimmed', Boolean(query) && !match);
    if (query && match) matches += 1;
  }
  if (query) announce(`${matches} graph matches.`);
}

function focusFirstSearchMatch(): void {
  const query = normalizeSearch(searchQuery);
  if (!query || !snapshot) {
    return;
  }
  if (activeView === 'interfaces') {
    renderInterfaces();
    const first = interfaceGrid.querySelector<HTMLElement>('.dash-row[data-node-id]');
    if (first?.dataset.nodeId) {
      selectNode(first.dataset.nodeId);
      first.scrollIntoView({ block: 'nearest' });
    }
    return;
  }
  if (activeView === 'structure') {
    // Typing is debounced, so the rows on screen may still be the ones from
    // before this query; Enter is an instruction to act on what was typed.
    renderStructure();
    const first = treeRows.find((row) => row.match);
    if (first) {
      selectNode(first.node.id);
      structureTree
        .querySelector<HTMLElement>(`[data-node-id="${escapeAttribute(first.node.id)}"]`)
        ?.focus({ preventScroll: true });
      ensureRowVisible(first.node.id);
    }
    return;
  }
  const graph = currentGraph();
  if (!graph) {
    return;
  }
  const match = graph.nodes.find((node) => searchableNodeText(node).includes(query));
  if (match) {
    selectNode(match.id);
    centerNode(match.id);
    viewportGroup.querySelector<SVGGElement>(`[data-node-id="${escapeAttribute(match.id)}"]`)?.focus();
  }
}

function findSelectedNode(): { id: string; label: string; kind: string; subtitle?: string; source?: SourceRef; metadata: Record<string, string | string[]> } | undefined {
  if (!snapshot || !selectedId) return undefined;
  if (activeView === 'architecture') return snapshot.architecture.nodes.find((node) => node.id === selectedId);
  if (activeView === 'flow') return selectedFlowUnit()?.graph.nodes.find((node) => node.id === selectedId);
  // The scoped graph, not the whole schema: an area card and a boundary card
  // exist only in the diagram the data view is currently showing.
  if (activeView === 'database') return currentGraph()?.nodes.find((node) => node.id === selectedId);
  if (activeView === 'interfaces') return selectedInterfaceDetails(selectedId);
  const structureNode = findStructureNode(snapshot.structure, selectedId);
  if (structureNode) {
    return {
      id: structureNode.id,
      label: structureNode.label,
      kind: structureNode.kind,
      subtitle: structureNode.path || snapshot.projectName,
      source: structureNode.source,
      metadata: structureNode.kind === 'folder' ? { Files: String(countFiles(structureNode)) } : {},
    };
  }
  // A row picked in one of the dashboard's cards: a module, a dependency, or a
  // database entity, each of which lives in a graph rather than the file tree.
  return snapshot.architecture.nodes.find((node) => node.id === selectedId)
    ?? snapshot.database.nodes.find((node) => node.id === selectedId);
}

function findStructureNode(node: StructureNode, id: string): StructureNode | undefined {
  if (node.id === id) return node;
  for (const child of node.children) {
    const found = findStructureNode(child, id);
    if (found) return found;
  }
  return undefined;
}

const FIT_PADDING = 64;
/** Past this many relationships the lines are drawn as texture, not as lines. */
const QUIET_EDGE_COUNT = 24;
/** Below roughly this scale the labels stop being legible. */
const MIN_FIT_SCALE = 0.42;
/** Past this, `fit` stops magnifying, so the layout gains nothing by shrinking. */
const MAX_FIT_SCALE = 1.25;
const CHIP_WIDTH = 168;
const CHIP_HEIGHT = 44;
/** Past this many entities the cards list their keys rather than every column. */
const FIELD_LIST_LIMIT = 40;
/** …and past this, not even the keys: a name is all that reads at that zoom. */
const KEY_LIST_LIMIT = 220;
/** Columns a card will show before it says how many more there are. */
const FIELD_ROWS = 10;
/** Steps a flow card will list. The analyzer already caps what it records. */
const STEP_ROWS = 6;
/**
 * A flowchart is read along its arrows, so it is given room the module map does
 * not need. The column gap has to hold an arrow, its head, and a `Yes` or `No`
 * beside it and still read as a gap; the row gap has to keep two steps from
 * looking like one stack. At the default 108/26 all three landed on top of each
 * other and the diagram became a wall of boxes.
 */
const FLOW_SPACING = { nodeGapY: 54, rankGapX: 190, blockGap: 190 };
/**
 * Room for the map views — the module map and the schema.
 *
 * Both are read by looking at one area and then at what it connects to, and
 * both were packing their cards close enough that an area read as one block of
 * text rather than as a handful of things with relationships between them. The
 * grid gaps are the ones that were most obviously too tight: they were sized
 * for cards with no edges to route between them, which is true of the cards but
 * not of what the reader is doing — telling them apart.
 */
const MAP_SPACING = {
  isolatedGapX: 54,
  isolatedGapY: 40,
  satelliteGapY: 40,
  hubGapX: 150,
  groupGap: 160,
};
/** …and the same, for the parts of a map still small enough to rank. */
const MAP_RANK_SPACING = { nodeGapY: 40, rankGapX: 150 };
/** Space a routed line keeps from the boxes it passes. */
const ROUTE_CLEARANCE = 12;
/** What a corner costs the router, against a pixel of line. */
const ROUTE_TURN_COST = 40;
/** What taking a stretch another line already took costs. */
const ROUTE_CONGESTION_COST = 30;
/** Most routing lines per axis; see `routeOrthogonally`. */
const ROUTE_MAX_LINES = 260;
/** Extra room and stronger separation for the small group-level graph. */
const GROUP_ROUTE_CLEARANCE = 34;
const GROUP_ROUTE_TURN_COST = 90;
const GROUP_ROUTE_CONGESTION_COST = 180;
const GROUP_ROUTE_MAX_LINES = 160;
/** How far back from a corner a line starts turning. */
const CORNER_RADIUS = 7;

/** The rows the structure view is currently showing, in the order it drew them. */
let treeRows: TreeRow[] = [];

/**
 * Splits the external packages off into a lane of their own before the graph is
 * laid out. They are single-edge leaves and there are usually more of them than
 * there are modules, so ranked alongside them they dictate the diagram's size
 * and the module graph stops being the subject.
 */
function layoutGraphFor(graph: DiagramGraph): LayoutResult {
  detailedCards = graph.nodes.length <= FIELD_LIST_LIMIT;
  keyedCards = graph.nodes.length <= KEY_LIST_LIMIT;
  keyColumns = foreignKeyColumns(graph);
  const sorted = [...graph.nodes].sort((left, right) => left.label.localeCompare(right.label));
  const external = sorted.filter((node) => node.kind === 'external-package');
  const core = external.length && external.length < sorted.length
    ? sorted.filter((node) => node.kind !== 'external-package')
    : sorted;
  return layoutGraph(core, graph.edges, {
    viewportWidth: graphCanvas.clientWidth,
    viewportHeight: graphCanvas.clientHeight,
    fitPadding: FIT_PADDING,
    maxScale: MAX_FIT_SCALE,
    measure: (node) => measureNode(node, graph.kind),
    flow: ARRANGEMENT_BY_KIND[graph.kind],
    ...(graph.kind === 'flow'
      ? { spacing: FLOW_SPACING }
      : { spacing: MAP_RANK_SPACING, spreadSpacing: MAP_SPACING }),
    groupOf: (node) => declaredGroupOf(node, graph.kind),
    ...(core === sorted ? {} : { lane: { nodes: external, width: CHIP_WIDTH, height: CHIP_HEIGHT } }),
  });
}

/**
 * How much room a node's own text wants. One fixed width truncated most module
 * names; a width that follows the longest name in the column shows them, and
 * the clamp keeps a single `InterviewWorkflowController` from setting the width
 * of a column of six-letter names.
 */
/**
 * The grouping the graph came with.
 *
 * A table was declared in a schema file and a module lives in a directory.
 * Either is a grouping the reader can check against the source, which is what
 * makes a frame round it mean something — where a grouping read out of the
 * edges only ever means "these came out near each other".
 */
function declaredGroupOf(node: DiagramNode, kind: DiagramGraph['kind']): string | undefined {
  if (kind === 'database') {
    // The area map is already one card per area, so framing it by area would
    // draw a box around every card. What is left to group it by is the kind of
    // schema each area was read out of, which is what `SQL:…` records.
    if (dataScope === AREA_MAP) {
      return node.metadata['Declared by']?.toString().split(' · ')[0];
    }
    // Inside one area every table shares the area's key, so the frames that are
    // left to draw are the namespaces the tables were qualified with, if any.
    if (currentArea()) {
      const namespace = node.metadata.Namespace;
      return typeof namespace === 'string' && namespace ? namespace : undefined;
    }
    // ORM and migration analyzers already name their schema boundary. JPA
    // entities each live in a different source file, so grouping by file would
    // create one frame per table and communicate nothing.
    return databaseMap?.areaOf.get(node.id) ?? node.group ?? node.source?.file;
  }
  if (kind === 'flow') {
    return node.group;
  }
  // Monorepo roots are the boundaries developers navigate by. Grouping
  // `apps/web/src/app` with `apps/web/src/lib` under `apps/web`, rather than
  // making a frame for every immediate parent, keeps the map stable as folders
  // are added and turns package boundaries into the visible structure.
  const parts = node.label.split('/').filter(Boolean);
  if (parts.length >= 2 && ['apps', 'packages', 'services', 'libs'].includes(parts[0] ?? '')) {
    return parts.slice(0, 2).join('/');
  }
  return parts.length > 1 ? parts[0] : 'Workspace';
}

function measureNode(node: DiagramNode, kind: DiagramGraph['kind']): NodeMetrics {
  // Character width for the 12px label, matched to the budget renderGraphNode
  // truncates against. Only the label and the field rows are measured: the
  // subtitle is a source path with a tooltip behind it, and letting one widen
  // every box shrank the whole diagram at `fit` to show text nobody reads.
  const label = node.label.length * 6.6;
  if (kind === 'flow') {
    if (node.kind === 'decision') {
      return { width: clamp(Math.ceil(label) + 70, 210, 320), minWidth: 210, height: 104 };
    }
    // The diagram's own begin/finish marks are small: they carry a word, not a
    // step's worth of evidence. A declared route falls through to the card sizes
    // below, because that is what it is drawn as.
    if (node.kind === 'flow-start' || node.kind === 'flow-end') {
      return { width: clamp(Math.ceil(label) + 44, 170, 260), minWidth: 170, height: 54 };
    }
    // A step that has something to list is measured on the list, the same way
    // an entity card is: the rows are the reason to draw the card at all, and a
    // card too narrow for them shows a column of ellipses.
    const steps = cardRows(node, kind);
    if (!steps.length) {
      // Nothing to list, so the card is its title bar and no more. Left taller
      // it carried an empty band under the header that read as a list the
      // analysis had failed to fill, rather than as a step with nothing inside.
      return { width: clamp(Math.ceil(label) + 34, 200, 310), minWidth: 190, height: 48 };
    }
    const widest = Math.max(label, ...steps.map((step) => step.length * 6.1));
    return {
      width: clamp(Math.ceil(widest) + 30, 220, 330),
      minWidth: clamp(Math.ceil(label) + 34, 200, 260),
      height: 54 + steps.length * 22,
    };
  }
  if (kind !== 'database') {
    return { width: clamp(Math.ceil(label) + 30, 190, 300), minWidth: 190, height: 64 };
  }
  // An area card stands for a whole diagram, so it is drawn like a place on a
  // map rather than like one more table: wider, taller, and — unlike every
  // other card here — measured on its subtitle too, because on these the
  // subtitle is the counts, which is half of what the card is for.
  if (node.kind === 'subject-area' || node.kind === 'area-link') {
    const caption = (node.subtitle ?? '').length * 5.7;
    // The floor is the width itself: there are a handful of these cards, and a
    // card that says "68 relationships across the bou…" has lost the one number
    // it was drawn to carry.
    const width = clamp(Math.ceil(Math.max(label, caption)) + 44, 250, 380);
    return { width, minWidth: width, height: node.kind === 'subject-area' ? 76 : 68 };
  }
  if (!detailedCards) {
    const keys = keyFieldsOf(node);
    if (!keyedCards || !keys.length) {
      return { width: clamp(Math.ceil(label) + 30, 190, 280), minWidth: 168, height: 52 };
    }
    const widest = Math.max(label, ...keys.map((field) => field.length * 6.1));
    return {
      width: clamp(Math.ceil(widest) + 30, 210, 300),
      minWidth: clamp(Math.ceil(label) + 30, 190, 250),
      height: 54 + keys.length * 22,
    };
  }
  const fields = metadataArray(node, 'Fields');
  const widest = Math.max(label, ...fields.slice(0, FIELD_ROWS).map((field) => field.length * 6.1));
  const visibleRows = Math.min(FIELD_ROWS, fields.length) + (fields.length > FIELD_ROWS ? 1 : 0);
  return {
    width: clamp(Math.ceil(widest) + 30, 230, 300),
    // The width the previous fixed-size card used, kept as the fallback for an
    // entity list too wide to fit any other way.
    minWidth: clamp(Math.ceil(label) + 30, 200, 250),
    height: 54 + Math.max(1, visibleRows) * 22,
  };
}

/**
 * Where each relationship's line runs.
 *
 * The lines are the diagram. A curve drawn between two centres crosses whatever
 * stands between them, and a dozen of them leaving one table leave from the
 * same point, so the reader cannot tell one from another at either end. Right
 * angles, one port per line, and a route that goes around what is in the way is
 * what every tool people actually read schemas in does, and the reason is that
 * it is the version you can follow with a finger.
 *
 * The relationships that are drawn as a wash rather than as lines are bent once
 * instead of routed: searching a careful path for a line at a tenth opacity
 * costs most of the routing budget and makes the wash denser, not clearer.
 */
function routeGraph(layout: LayoutResult, graph: DiagramGraph): Map<string, Point[]> {
  const boxes = layout.nodes.map((positioned) => ({
      id: positioned.node.id,
      x: positioned.x,
      y: positioned.y,
      width: positioned.width,
      height: positioned.height,
  }));
  const boxById = new Map(boxes.map((box) => [box.id, box]));
  const membership = groupMembership(layout.groups);
  const partitions = new Map<string, typeof graph.edges>();
  const cross: typeof graph.edges = [];
  for (const edge of graph.edges) {
    const fromGroup = membership.get(edge.from);
    const toGroup = membership.get(edge.to);
    if (fromGroup && toGroup && fromGroup !== toGroup) {
      cross.push(edge);
      continue;
    }
    const key = fromGroup && fromGroup === toGroup ? fromGroup : '__ungrouped__';
    partitions.set(key, [...(partitions.get(key) ?? []), edge]);
  }

  const routes = new Map<string, Point[]>();
  const route = (nodeIds: ReadonlySet<string>, edges: readonly typeof graph.edges[number][], direct: boolean): void => {
    const found = routeOrthogonally(
      boxes.filter((box) => nodeIds.has(box.id)),
      edges.map((edge) => ({
        id: edge.id,
        from: edge.from,
        to: edge.to,
        direct: direct || layout.ambient.has(edge.from) || layout.ambient.has(edge.to),
      })),
      {
      clearance: ROUTE_CLEARANCE,
      turnCost: ROUTE_TURN_COST,
      congestionCost: ROUTE_CONGESTION_COST,
      maxLines: ROUTE_MAX_LINES,
      },
    );
    for (const [id, points] of found) {
      routes.set(id, points);
    }
  };

  for (const [group, edges] of partitions) {
    const nodeIds = group === '__ungrouped__'
      ? new Set(boxes.map((box) => box.id))
      : new Set(layout.groups.find((candidate) => candidate.key === group)?.nodeIds ?? []);
    route(nodeIds, edges, false);
  }
  // Hidden overview edges only need a quick route. They come forward on demand,
  // where their endpoints and relation details make the one-bend path clear.
  route(new Set(boxById.keys()), cross, true);
  return routes;
}

/** The layout's box, opened out to whatever the routes needed around it. */
function boundsOver(
  layout: LayoutResult,
  routes: ReadonlyMap<string, Point[]>,
): { minX: number; minY: number; maxX: number; maxY: number } {
  const bounds = { minX: layout.minX, minY: layout.minY, maxX: layout.maxX, maxY: layout.maxY };
  for (const points of routes.values()) {
    for (const point of points) {
      bounds.minX = Math.min(bounds.minX, point.x);
      bounds.minY = Math.min(bounds.minY, point.y);
      bounds.maxX = Math.max(bounds.maxX, point.x);
      bounds.maxY = Math.max(bounds.maxY, point.y);
    }
  }
  return bounds;
}

/**
 * The route as a path, with its corners rounded off.
 *
 * A rounded corner is not decoration: at a sharp one the two segments meet in a
 * point that reads as a third mark, and on a diagram with three hundred corners
 * that is three hundred marks competing with the arrowheads. The radius gives
 * way on a short segment so a tight staircase stays a staircase.
 */
function orthogonalPath(points: readonly Point[]): string {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) {
    return '';
  }
  const parts = [`M ${round(first.x)} ${round(first.y)}`];
  for (let index = 1; index + 1 < points.length; index += 1) {
    const before = points[index - 1];
    const corner = points[index];
    const after = points[index + 1];
    if (!before || !corner || !after) {
      continue;
    }
    const incoming = Math.hypot(corner.x - before.x, corner.y - before.y);
    const outgoing = Math.hypot(after.x - corner.x, after.y - corner.y);
    if (incoming < 0.01 || outgoing < 0.01) {
      continue;
    }
    const radius = Math.min(CORNER_RADIUS, incoming / 2, outgoing / 2);
    const enter = {
      x: corner.x + ((before.x - corner.x) / incoming) * radius,
      y: corner.y + ((before.y - corner.y) / incoming) * radius,
    };
    const leave = {
      x: corner.x + ((after.x - corner.x) / outgoing) * radius,
      y: corner.y + ((after.y - corner.y) / outgoing) * radius,
    };
    parts.push(`L ${round(enter.x)} ${round(enter.y)}`);
    parts.push(`Q ${round(corner.x)} ${round(corner.y)}, ${round(leave.x)} ${round(leave.y)}`);
  }
  parts.push(`L ${round(last.x)} ${round(last.y)}`);
  return parts.join(' ');
}

/** The middle of the route's longest straight, which is where a label fits. */
/**
 * The columns a card shows: all of them on a small schema, the keys on a large
 * one, and none at all past the point where a card is drawn smaller than its
 * own text.
 */
function cardRows(node: DiagramNode, kind: DiagramGraph['kind']): string[] {
  // A flow step's card carries what the analyzer could read inside it but had
  // no box to draw: the conditions that fork nothing, and the calls that reach
  // outside what the scope can resolve. A step that says only its own name
  // makes the reader open the file to learn anything at all.
  if (kind === 'flow') {
    return metadataArray(node, 'Steps').slice(0, STEP_ROWS);
  }
  if (kind !== 'database') {
    return [];
  }
  if (detailedCards) {
    return metadataArray(node, 'Fields');
  }
  return keyedCards ? keyFieldsOf(node) : [];
}

/** The primary key and the columns some relationship is declared over. */
function keyFieldsOf(node: DiagramNode): string[] {
  const references = keyColumns.get(node.id);
  return metadataArray(node, 'Fields').filter((field) => {
    const markers = /\[([^\]]*)\]\s*$/.exec(field)?.[1] ?? '';
    if (/\bPK\b/.test(markers)) {
      return true;
    }
    const name = field.split(/\s*(?:->|:)\s*/)[0]?.trim() ?? '';
    const column = /->\s*([^:]+):/.exec(field)?.[1]?.trim() ?? name;
    return Boolean(references?.has(name) || references?.has(column));
  }).slice(0, FIELD_ROWS);
}

/**
 * Which columns carry a relationship, read off the edges.
 *
 * A foreign key is a property of the relationship rather than of the column, so
 * the column itself never says it is one. The edges do, in the fields they were
 * declared over.
 */
function foreignKeyColumns(graph: DiagramGraph): Map<string, Set<string>> {
  const columns = new Map<string, Set<string>>();
  const add = (nodeId: string, names: readonly string[]): void => {
    const existing = columns.get(nodeId) ?? new Set<string>();
    for (const name of names) {
      if (name) {
        existing.add(name);
      }
    }
    columns.set(nodeId, existing);
  };
  for (const edge of graph.edges) {
    const local = edge.metadata?.['Local fields'];
    const target = edge.metadata?.References;
    add(edge.from, Array.isArray(local) ? local : local ? [local] : []);
    add(edge.to, Array.isArray(target) ? target : target ? [target] : []);
  }
  return columns;
}

function labelPointOn(points: readonly Point[]): { x: number; y: number } {
  let best = { x: points[0]?.x ?? 0, y: (points[0]?.y ?? 0) - 7 };
  let longest = -1;
  for (let index = 0; index + 1 < points.length; index += 1) {
    const one = points[index];
    const next = points[index + 1];
    if (!one || !next) {
      continue;
    }
    const length = Math.hypot(next.x - one.x, next.y - one.y);
    if (length > longest) {
      longest = length;
      best = { x: (one.x + next.x) / 2, y: (one.y + next.y) / 2 - 7 };
    }
  }
  return best;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function fitCurrentGraph(): void {
  if (activeView === 'interfaces') {
    treeScale = 1;
    interfaceDashboard.style.setProperty('--codraw-tree-scale', '1');
    interfaceDashboard.scrollTop = 0;
    persistState();
    return;
  }
  // The dashboard has no size to fit a viewport to, so `fit` puts its text back
  // to the editor's own and returns to whatever the reader was looking at.
  if (activeView === 'structure') {
    treeScale = 1;
    structureDashboard.style.setProperty('--codraw-tree-scale', '1');
    if (active) {
      ensureRowVisible(active.structureNodeId);
    } else {
      structureDashboard.scrollTop = 0;
    }
    persistState();
    return;
  }
  if (!contentBounds) return;
  const width = graphCanvas.clientWidth;
  const height = graphCanvas.clientHeight;
  if (width <= 0 || height <= 0) return;
  // Fit what is actually legible. In focus mode the rest of the graph is dimmed
  // almost to nothing, and fitting it anyway leaves the part being read as a
  // small patch in the corner of an empty canvas.
  const area = focusedBounds() ?? contentBounds;
  const contentWidth = Math.max(1, area.maxX - area.minX);
  const contentHeight = Math.max(1, area.maxY - area.minY);
  // A graph that cannot fit legibly is shown readably and panned, rather than
  // shrunk into a smudge.
  const naturalScale = Math.min((width - FIT_PADDING) / contentWidth, (height - FIT_PADDING) / contentHeight);
  // A flowchart is read step-by-step. Shrinking its labels to overview scale
  // defeats that purpose, so a long flow starts at a readable scale and pans.
  const readableScale = activeView === 'flow' ? 0.6 : MIN_FIT_SCALE;
  // Clamp up to a readable minimum — but only while that still shows most of the
  // map. Once the graph is far larger than that, a legible corner with edges
  // running off every side is worse than the whole shape shrunk to where its
  // structure still reads and then zoomed into by hand.
  //
  // A flowchart is the exception: its shape is a line of steps, and seeing the
  // whole of that line at a size where no step can be read answers nothing. It
  // is entered at the left, where the layout put the first step, and followed.
  const minimumScale = activeView === 'flow' || naturalScale >= readableScale * 0.66
    ? readableScale
    : naturalScale;
  const scale = clamp(
    naturalScale,
    minimumScale,
    MAX_FIT_SCALE,
  );
  const camera = graphCamera();
  camera.scale = scale;
  if (naturalScale < minimumScale) {
    // At readable scale the whole map is larger than the viewport. Start at its
    // title-bearing top-left instead of cropping every edge around the middle;
    // the reader can then move right and down through complete areas.
    camera.x = FIT_PADDING / 2 - area.minX * scale;
    camera.y = FIT_PADDING / 2 - area.minY * scale;
  } else {
    camera.x = (width - contentWidth * scale) / 2 - area.minX * scale;
    camera.y = (height - contentHeight * scale) / 2 - area.minY * scale;
  }
  applyCamera();
  persistState();
}

/** The box around the active module and its direct neighbours, if focused. */
function focusedBounds(): { minX: number; minY: number; maxX: number; maxY: number } | undefined {
  const currentId = focusTargetNodeId();
  if (!focusMode || !currentId || !currentLayout || !snapshot) {
    return undefined;
  }
  const neighbourhood = new Set<string>([currentId]);
  for (const edge of currentGraph()?.edges ?? []) {
    if (edge.from === currentId) neighbourhood.add(edge.to);
    if (edge.to === currentId) neighbourhood.add(edge.from);
  }
  const visible = currentLayout.nodes.filter((positioned) => neighbourhood.has(positioned.node.id));
  if (!visible.length) {
    return undefined;
  }
  return {
    minX: Math.min(...visible.map((positioned) => positioned.x)),
    minY: Math.min(...visible.map((positioned) => positioned.y)),
    maxX: Math.max(...visible.map((positioned) => positioned.x + positioned.width)),
    maxY: Math.max(...visible.map((positioned) => positioned.y + positioned.height)),
  };
}

function centerNode(nodeId: string): void {
  const positioned = currentLayout?.nodeById.get(nodeId);
  if (!positioned || isBoardView(activeView)) return;
  const camera = graphCamera();
  camera.scale = Math.max(camera.scale, 0.75);
  camera.x = graphCanvas.clientWidth / 2 - (positioned.x + positioned.width / 2) * camera.scale;
  camera.y = graphCanvas.clientHeight / 2 - (positioned.y + positioned.height / 2) * camera.scale;
  applyCamera();
  persistState();
}

function zoomBy(factor: number, pointerX = graphCanvas.clientWidth / 2, pointerY = graphCanvas.clientHeight / 2): void {
  // A page's equivalent of zooming is its type size; there is no camera.
  if (isBoardView(activeView)) {
    scaleTree(factor);
    return;
  }
  const camera = graphCamera();
  const nextScale = clamp(camera.scale * factor, 0.15, 3.5);
  const ratio = nextScale / camera.scale;
  camera.x = pointerX - (pointerX - camera.x) * ratio;
  camera.y = pointerY - (pointerY - camera.y) * ratio;
  camera.scale = nextScale;
  applyCamera();
  persistState();
}

function applyCamera(): void {
  const camera = graphCamera();
  viewportGroup.setAttribute('transform', `translate(${camera.x} ${camera.y}) scale(${camera.scale})`);
}

function graphCamera(): Camera {
  return cameras[activeView];
}

function showState(message: string, kind: 'loading' | 'empty' | 'error'): void {
  stateMessage.textContent = message;
  stateView.dataset.kind = kind;
  stateView.hidden = false;
  setHidden(graphCanvas, true);
  setHidden(structureDashboard, true);
  setHidden(interfaceDashboard, true);
}

function persistState(): void {
  vscode.setState({
    view: activeView,
    selectedId,
    query: searchQuery,
    flowUnitId,
    architectureScope,
    dataScope,
    cameras,
    focusMode,
    collapsed: [...collapsedPaths],
    treeScale,
  });
}

function parseHostMessage(value: unknown): HostMessage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Record<string, unknown>;
  if (!['analysisStarted', 'analysisStale', 'analysisError', 'snapshot', 'activeContext'].includes(String(candidate.type))) return undefined;
  if (candidate.type === 'snapshot' && (!candidate.snapshot || typeof candidate.snapshot !== 'object')) return undefined;
  return {
    type: candidate.type as HostMessage['type'],
    ...(typeof candidate.message === 'string' ? { message: candidate.message } : {}),
    ...(candidate.snapshot && typeof candidate.snapshot === 'object' ? { snapshot: candidate.snapshot as ProjectSnapshot } : {}),
    ...(typeof candidate.focusNodeId === 'string' && candidate.focusNodeId.length < 1000
      ? { focusNodeId: candidate.focusNodeId }
      : {}),
    ...(candidate.active === null
      ? { active: null }
      : candidate.active && typeof candidate.active === 'object'
        ? { active: candidate.active as ActiveContext }
        : {}),
  };
}

function metadataArray(node: DiagramNode, key: string): string[] {
  const direct = node.metadata[key] ?? node.metadata[key.toLowerCase()] ?? node.metadata[key.toUpperCase()];
  if (Array.isArray(direct)) return direct;
  return typeof direct === 'string' && direct ? [direct] : [];
}

function searchableNodeText(node: DiagramNode): string {
  const metadata = Object.values(node.metadata).flatMap((value) => Array.isArray(value) ? value : [value]);
  return normalizeSearch([node.label, node.subtitle, node.group, node.kind, node.source?.file, ...metadata].filter(Boolean).join(' '));
}

function normalizeSearch(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase();
}

function createSvgElement<K extends keyof SVGElementTagNameMap>(name: K): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NS, name);
}

function findElement<T extends Element>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Codraw UI element #${id} is missing.`);
  return element as unknown as T;
}

function clearElement(element: Element): void {
  while (element.firstChild) element.firstChild.remove();
}

function setHidden(element: Element, hidden: boolean): void {
  element.toggleAttribute('hidden', hidden);
}

function appendParagraph(parent: Element, text: string): void {
  const paragraph = document.createElement('p');
  paragraph.textContent = text;
  parent.append(paragraph);
}

function announce(message: string): void {
  announcer.textContent = '';
  requestAnimationFrame(() => {
    announcer.textContent = message;
  });
}

/**
 * Shortens a label to fit its node. A path is elided in the middle because its
 * tail is what tells two otherwise identical entities apart; anything else is cut
 * at the end as usual.
 */
function shorten(value: string, limit: number): string {
  if (value.length <= limit || limit < 8) {
    return truncate(value, limit);
  }
  if (!value.includes('/')) {
    return truncate(value, limit);
  }
  const head = Math.ceil((limit - 1) / 2);
  const tail = limit - 1 - head;
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(1, limit - 1))}…`;
}

/** Runs `action` once the calls have stopped coming for `delayMs`. */
function debounce(action: () => void, delayMs: number): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    timer = setTimeout(action, delayMs);
  };
}

function formatTime(isoTimestamp: string): string {
  const parsed = new Date(isoTimestamp);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toLocaleTimeString();
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function normalizeCamera(camera: Camera | undefined): Camera {
  if (!camera || !Number.isFinite(camera.x) || !Number.isFinite(camera.y) || !Number.isFinite(camera.scale)) {
    return { x: 40, y: 40, scale: 1 };
  }
  return { x: camera.x, y: camera.y, scale: clamp(camera.scale, 0.15, MAX_CAMERA_SCALE) };
}

function safeClass(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9_-]/g, '-');
}

function escapeAttribute(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function isViewMode(value: unknown): value is ViewMode {
  return value === 'architecture' || value === 'structure' || value === 'flow'
    || value === 'database' || value === 'interfaces';
}

/**
 * The two views that are pages rather than canvases. They scroll, they have no
 * camera, and the toolbar's zoom means their type size instead of a scale.
 */
function isBoardView(view: ViewMode): boolean {
  return view === 'structure' || view === 'interfaces';
}
