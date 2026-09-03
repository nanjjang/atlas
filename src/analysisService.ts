import * as vscode from 'vscode';
import { analyzeWorkspace, isRelevantChange } from './analyzer';
import { DEFAULT_EXCLUDE, matchesGlob, withRequiredExclude } from './glob';
import type { ProjectSnapshot, SourceRef, StructureNode } from './model';
import { scanWorkspace } from './workspaceScanner';

export type AnalysisEvent =
  | { type: 'started'; requestId: number }
  | { type: 'snapshot'; snapshot: ProjectSnapshot }
  | { type: 'stale' }
  | { type: 'error'; message: string };

/**
 * One analysis for the whole extension.
 *
 * The panel used to own the scan, the parse, the file watcher and the source
 * map. With a second view showing the same workspace, keeping that inside one
 * view would mean scanning the workspace twice and drifting apart between the
 * two. The views are now subscribers: they render what this publishes.
 */
export class AnalysisService implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly emitter = new vscode.EventEmitter<AnalysisEvent>();
  private readonly sourceUris = new Map<string, vscode.Uri>();
  private latest: ProjectSnapshot | undefined;
  private inFlight: Promise<ProjectSnapshot | undefined> | undefined;
  private requestSequence = 0;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  readonly onDidChange = this.emitter.event;

  constructor() {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    const handleChange = (uri: vscode.Uri): void => {
      if (!this.affectsAnalysis(uri)) {
        return;
      }
      if (this.refreshTimer) {
        clearTimeout(this.refreshTimer);
      }
      this.refreshTimer = setTimeout(() => {
        this.refreshTimer = undefined;
        // Whether to act on this is the subscriber's call: a hidden view marks
        // itself stale, a visible one asks for a refresh.
        this.emitter.fire({ type: 'stale' });
      }, 800);
    };
    watcher.onDidCreate(handleChange, undefined, this.disposables);
    watcher.onDidChange(handleChange, undefined, this.disposables);
    watcher.onDidDelete(handleChange, undefined, this.disposables);
    this.disposables.push(watcher, this.emitter);
  }

  get snapshot(): ProjectSnapshot | undefined {
    return this.latest;
  }

  /** Analyzes once. A snapshot that already exists is reused as it is. */
  async ensure(): Promise<ProjectSnapshot | undefined> {
    if (this.latest) {
      return this.latest;
    }
    return this.refresh();
  }

  /**
   * Re-analyzes the workspace. Concurrent callers share one run, so two visible
   * views reacting to the same file change do not scan the workspace twice.
   */
  async refresh(): Promise<ProjectSnapshot | undefined> {
    if (this.inFlight) {
      return this.inFlight;
    }
    const run = this.analyze();
    this.inFlight = run;
    try {
      return await run;
    } finally {
      if (this.inFlight === run) {
        this.inFlight = undefined;
      }
    }
  }

  private async analyze(): Promise<ProjectSnapshot | undefined> {
    const requestId = ++this.requestSequence;
    this.emitter.fire({ type: 'started', requestId });
    try {
      // Both halves stay inside one progress scope: parsing is the expensive,
      // synchronous half, so leaving it outside hid the indicator exactly when
      // the extension host was busiest.
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'Repogram: analyzing workspace' },
        async (progress) => {
          progress.report({ message: 'scanning files' });
          const scan = await scanWorkspace();
          if (requestId !== this.requestSequence || this.disposed) {
            return undefined;
          }
          progress.report({ message: `parsing ${scan.files.length} files` });
          // Let the host paint the progress message before the parsers block it.
          await new Promise((resolve) => setTimeout(resolve, 0));
          return { scan, snapshot: analyzeWorkspace(scan.files, {
            projectName: scan.projectName,
            revision: requestId,
            diagnostics: scan.diagnostics,
          }) };
        },
      );
      if (!result || requestId !== this.requestSequence || this.disposed) {
        return undefined;
      }
      this.latest = result.snapshot;
      this.sourceUris.clear();
      for (const [path, uri] of result.scan.uriByPath) {
        this.sourceUris.set(path, uri);
      }
      this.emitter.fire({ type: 'snapshot', snapshot: result.snapshot });
      return result.snapshot;
    } catch (error) {
      if (requestId !== this.requestSequence || this.disposed) {
        return undefined;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.emitter.fire({ type: 'error', message });
      void vscode.window.showErrorMessage(`Repogram: ${message}`);
      return undefined;
    }
  }

  /**
   * A file system watcher cannot take an exclude pattern, so `repogram.exclude`
   * has to be applied here. Without it, writes into `dist/`, `out/`, `target/` and
   * friends re-analyze the whole workspace even though those files are never scanned.
   */
  private affectsAnalysis(uri: vscode.Uri): boolean {
    const configuration = vscode.workspace.getConfiguration('repogram');
    if (!configuration.get<boolean>('autoRefresh', true)) {
      return false;
    }
    if (!vscode.workspace.getWorkspaceFolder(uri)) {
      return false;
    }
    const relative = vscode.workspace.asRelativePath(uri, false).replaceAll('\\', '/');
    if (!isRelevantChange(relative)) {
      return false;
    }
    return !matchesGlob(
      withRequiredExclude(configuration.get<string>('exclude', DEFAULT_EXCLUDE)),
      relative,
    );
  }

  /** Reveals the declaration a diagram node was built from. */
  async openSource(nodeId: string): Promise<void> {
    const source = this.latest ? findSource(this.latest, nodeId) : undefined;
    if (!source) {
      void vscode.window.showWarningMessage('Repogram could not find a source location for this item.');
      return;
    }
    const uri = this.sourceUris.get(source.file);
    if (!uri) {
      void vscode.window.showWarningMessage(`Repogram source is no longer available: ${source.file}`);
      return;
    }
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      const line = Math.max(0, Math.min(document.lineCount - 1, source.line - 1));
      const editor = await vscode.window.showTextDocument(document, { preview: true, preserveFocus: false });
      const position = new vscode.Position(line, 0);
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`Repogram could not open ${source.file}: ${message}`);
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.requestSequence += 1;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }
}

function findSource(snapshot: ProjectSnapshot, nodeId: string): SourceRef | undefined {
  const flowNodes = snapshot.flow.units.flatMap((unit) => unit.graph.nodes);
  const graphNode = [...snapshot.architecture.nodes, ...flowNodes, ...snapshot.database.nodes]
    .find((node) => node.id === nodeId);
  if (graphNode?.source) {
    return graphNode.source;
  }
  // Endpoints and ports are declarations rather than nodes, but the request is
  // the same one: show me where this was read from.
  const endpoint = snapshot.interfaces.surfaces
    .flatMap((surface) => surface.endpoints)
    .find((candidate) => candidate.id === nodeId);
  if (endpoint) {
    return endpoint.source;
  }
  const port = snapshot.interfaces.ports.find((candidate) => candidate.id === nodeId);
  if (port) {
    return port.source;
  }
  return findStructureSource(snapshot.structure, nodeId);
}

function findStructureSource(node: StructureNode, nodeId: string): SourceRef | undefined {
  if (node.id === nodeId) {
    return node.source;
  }
  for (const child of node.children) {
    const source = findStructureSource(child, nodeId);
    if (source) {
      return source;
    }
  }
  return undefined;
}
