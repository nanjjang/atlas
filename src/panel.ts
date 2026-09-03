import * as vscode from 'vscode';
import type { RepogramContext } from './repogramContext';
import type { ProjectSnapshot } from './model';
import { iconSprite } from './icons';
import { bundleUri, contentSecurityPolicy, createNonce, webviewOptionsFor } from './webviewHtml';

type WebviewMessage =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'exportSchema' }
  | { type: 'rendered'; revision: number }
  | { type: 'openSource'; nodeId: string };

export class RepogramPanel implements vscode.Disposable {
  private static current: RepogramPanel | undefined;

  private readonly disposables: vscode.Disposable[] = [];
  private renderedRevision: number | undefined;
  private pendingFocus: string | undefined;
  private disposed = false;

  static readonly viewType = 'repogram.diagram';

  static webviewOptions(context: vscode.ExtensionContext): vscode.WebviewOptions & vscode.WebviewPanelOptions {
    return {
      ...webviewOptionsFor(context),
      retainContextWhenHidden: false,
    };
  }

  static createOrShow(repogram: RepogramContext): RepogramPanel {
    const current = RepogramPanel.current;
    if (current) {
      current.panel.reveal(vscode.ViewColumn.Beside, true);
      void current.refresh();
      return current;
    }

    const panel = vscode.window.createWebviewPanel(
      RepogramPanel.viewType,
      'Repogram',
      // The diagram is meant to sit beside the code, so opening it leaves the
      // cursor where it was rather than pulling focus out of the editor.
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      RepogramPanel.webviewOptions(repogram.extension),
    );
    return RepogramPanel.adopt(repogram, panel);
  }

  /**
   * Opens the panel on a particular node, which is how a row in the sidebar
   * hands off to the full diagram.
   */
  static revealNode(repogram: RepogramContext, nodeId: string): void {
    const panel = RepogramPanel.createOrShow(repogram);
    panel.focusNode(nodeId);
  }

  /**
   * Rebuilds the panel VS Code restored after a window reload. The webview keeps
   * its own view, selection, and camera in `setState`, so it only needs a fresh
   * snapshot, which its `ready` handshake requests.
   */
  static revive(repogram: RepogramContext, panel: vscode.WebviewPanel): void {
    if (RepogramPanel.current) {
      panel.dispose();
      return;
    }
    panel.webview.options = RepogramPanel.webviewOptions(repogram.extension);
    RepogramPanel.adopt(repogram, panel);
  }

  private static adopt(repogram: RepogramContext, panel: vscode.WebviewPanel): RepogramPanel {
    const repogramPanel = new RepogramPanel(repogram, panel);
    RepogramPanel.current = repogramPanel;
    void vscode.commands.executeCommand('setContext', 'repogram.panelOpen', true);
    return repogramPanel;
  }

  static async refreshCurrent(repogram: RepogramContext): Promise<void> {
    const panel = RepogramPanel.current ?? RepogramPanel.createOrShow(repogram);
    await panel.refresh();
  }

  /** Panel-side half of the status the integration test reads. */
  static getStatus(snapshot: ProjectSnapshot | undefined): { panelOpen: boolean; renderReady: boolean } {
    const current = RepogramPanel.current;
    return {
      panelOpen: Boolean(current),
      renderReady: Boolean(snapshot && current?.renderedRevision === snapshot.revision),
    };
  }

  private constructor(
    private readonly repogram: RepogramContext,
    private readonly panel: vscode.WebviewPanel,
  ) {
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (value: unknown) => this.handleMessage(value),
      undefined,
      this.disposables,
    );
    // Attach the host listener before loading the script. A fast webview can
    // post its initial `ready` message as soon as `html` is assigned.
    this.panel.webview.html = this.getHtml(this.panel.webview);

    this.repogram.tracker.onDidChange(
      (active) => {
        void this.panel.webview.postMessage({ type: 'activeContext', active: active ?? null });
      },
      undefined,
      this.disposables,
    );

    this.repogram.service.onDidChange(
      (event) => {
        if (this.disposed) {
          return;
        }
        if (event.type === 'started') {
          this.renderedRevision = undefined;
          void this.panel.webview.postMessage({ type: 'analysisStarted', requestId: event.requestId });
        } else if (event.type === 'snapshot') {
          void this.post(event.snapshot);
        } else if (event.type === 'error') {
          void this.panel.webview.postMessage({ type: 'analysisError', message: event.message });
        } else if (this.panel.visible) {
          void this.refresh();
        } else {
          void this.panel.webview.postMessage({ type: 'analysisStale' });
        }
      },
      undefined,
      this.disposables,
    );

    this.panel.onDidChangeViewState(
      ({ webviewPanel }) => {
        const snapshot = this.repogram.service.snapshot;
        if (webviewPanel.visible && snapshot) {
          void this.post(snapshot);
        }
      },
      undefined,
      this.disposables,
    );
  }

  async refresh(): Promise<void> {
    await this.repogram.service.refresh();
  }

  /** Queued until the webview has a snapshot to select the node in. */
  focusNode(nodeId: string): void {
    this.pendingFocus = nodeId;
    const snapshot = this.repogram.service.snapshot;
    if (snapshot) {
      void this.post(snapshot);
    }
  }

  private async post(snapshot: ProjectSnapshot): Promise<void> {
    const focusNodeId = this.pendingFocus;
    this.pendingFocus = undefined;
    await this.panel.webview.postMessage({
      type: 'snapshot',
      requestId: snapshot.revision,
      snapshot,
      active: this.repogram.tracker.current ?? null,
      ...(focusNodeId ? { focusNodeId } : {}),
    });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    RepogramPanel.current = undefined;
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
    void vscode.commands.executeCommand('setContext', 'repogram.panelOpen', false);
  }

  private handleMessage(value: unknown): void {
    const message = parseWebviewMessage(value);
    if (!message) {
      return;
    }
    if (message.type === 'ready') {
      const snapshot = this.repogram.service.snapshot;
      if (snapshot) {
        void this.post(snapshot);
      } else {
        void this.repogram.service.ensure();
      }
    } else if (message.type === 'refresh') {
      void this.refresh();
    } else if (message.type === 'exportSchema') {
      // The command owns the save dialog and the write, so the toolbar button
      // and the Command Palette end up in exactly the same place.
      void vscode.commands.executeCommand('repogram.exportSchemaDocs');
    } else if (message.type === 'rendered') {
      if (this.repogram.service.snapshot?.revision === message.revision) {
        this.renderedRevision = message.revision;
      }
    } else if (message.type === 'openSource') {
      void this.repogram.service.openSource(message.nodeId);
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = createNonce();
    const scriptUri = bundleUri(this.repogram.extension, webview, 'main.js');
    const styleUri = bundleUri(this.repogram.extension, webview, 'styles.css');
    const csp = contentSecurityPolicy(webview, nonce);

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>Repogram</title>
</head>
<body>
  ${iconSprite()}
  <div id="repogram-app" class="repogram-app">
    <header class="app-header">
      <div class="project-heading">
        <div>
          <h1 id="project-name">Repogram</h1>
          <p id="project-summary">Preparing workspace analysis…</p>
        </div>
        <button id="refresh-button" class="toolbar-button" type="button" title="Read the workspace again">Re-analyze</button>
      </div>
      <div class="toolbar" role="toolbar" aria-label="Diagram controls">
        <div class="view-tabs" role="tablist" aria-label="Diagram view">
          <button id="tab-architecture" class="view-tab" type="button" role="tab" aria-selected="true" data-view="architecture">Architecture <span id="tab-count-architecture" class="tab-count"></span></button>
          <button id="tab-structure" class="view-tab" type="button" role="tab" aria-selected="false" data-view="structure">Files <span id="tab-count-structure" class="tab-count"></span></button>
          <button id="tab-flow" class="view-tab" type="button" role="tab" aria-selected="false" data-view="flow">Flows <span id="tab-count-flow" class="tab-count"></span></button>
          <button id="tab-database" class="view-tab" type="button" role="tab" aria-selected="false" data-view="database">Data model <span id="tab-count-database" class="tab-count"></span></button>
          <button id="tab-interfaces" class="view-tab" type="button" role="tab" aria-selected="false" data-view="interfaces">Interfaces <span id="tab-count-interfaces" class="tab-count"></span></button>
        </div>
        <label id="architecture-scope-label" class="scope-label is-compact" for="architecture-scope" hidden>
          <span class="scope-caption">Level</span>
          <select id="architecture-scope" class="scope-select" title="Move between the repository-area map, one area's modules, and the complete module graph."></select>
        </label>
        <label id="flow-scope-label" class="scope-label" for="flow-scope" hidden>
          <span class="scope-caption">Scope</span>
          <select id="flow-scope" class="scope-select"></select>
        </label>
        <label id="data-scope-label" class="scope-label is-compact" for="data-scope" hidden>
          <span class="scope-caption">Area</span>
          <select id="data-scope" class="scope-select" title="A schema reads one subject area at a time. Pick the area, or the map of all of them."></select>
        </label>
        <button id="export-button" class="toolbar-button" type="button" title="Write the schema out as a Markdown document: the subject areas, a small diagram for each, and every table and column" hidden>Export</button>
        <label class="search-label" for="search-input">Search</label>
        <input id="search-input" class="search-input" type="search" placeholder="Search modules" autocomplete="off">
        <div class="zoom-controls" aria-label="Graph zoom">
          <button id="zoom-out" class="toolbar-button" type="button" aria-label="Zoom out">−</button>
          <button id="fit-button" class="toolbar-button" type="button" title="Fit the whole diagram in the available space">Fit view</button>
          <button id="focus-button" class="toolbar-button" type="button" aria-pressed="true" title="Show the active module and its direct neighbours">Nearby</button>
          <button id="fold-button" class="toolbar-button" type="button" aria-label="Collapse every folder" hidden>Collapse</button>
          <button id="zoom-in" class="toolbar-button" type="button" aria-label="Zoom in">+</button>
        </div>
      </div>
      <div id="view-guide" class="view-guide" role="note">
        <strong id="view-guide-title">Module relationships</strong>
        <span id="view-guide-description">Folders group modules. Arrows point from the module using code to the module it uses.</span>
        <span id="view-guide-legend" class="view-guide-legend"><i class="legend-line"></i> detected directly <i class="legend-line is-dashed"></i> inferred</span>
      </div>
    </header>
    <div id="workspace" class="workspace">
      <main id="canvas-panel" class="canvas-panel" aria-live="polite">
        <svg id="graph-canvas" class="graph-canvas" role="img" aria-labelledby="graph-title graph-description">
          <title id="graph-title">Project diagram</title>
          <desc id="graph-description">Interactive workspace relationship diagram.</desc>
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path class="arrow-head" d="M 0 0 L 10 5 L 0 10 z"></path>
            </marker>
          </defs>
          <g id="viewport-group"></g>
        </svg>
        <div id="interface-dashboard" class="board-view interface-dashboard" tabindex="0" hidden>
          <div id="interface-grid" class="dash-grid"></div>
        </div>
        <div id="structure-dashboard" class="board-view structure-dashboard" tabindex="0" hidden>
          <div id="dash-grid" class="dash-grid"></div>
          <!-- Kept as an interaction target for selections arriving from the
               sidebar. The Files view itself is a repository dashboard; the
               Explorer already owns the full file tree. -->
          <div id="structure-tree" hidden></div>
        </div>
        <div id="state-view" class="state-view" role="status">
          <div class="loading-indicator" aria-hidden="true"></div>
          <p id="state-message">Analyzing workspace…</p>
        </div>
      </main>
      <aside id="details-panel" class="details-panel" aria-labelledby="details-title">
        <div class="details-header">
          <h2 id="details-title">Selection details</h2>
          <button id="details-toggle" class="details-toggle" type="button" aria-controls="details-content" aria-expanded="true" title="Collapse selection details">‹</button>
        </div>
        <div id="details-content" class="details-content">
          <p>Select an item to see why it appears here and open the source behind it.</p>
        </div>
      </aside>
    </div>
    <footer class="status-bar">
      <span id="status-text">Waiting for analysis</span>
      <span id="technology-list"></span>
    </footer>
    <div id="announcer" class="sr-only" aria-live="polite"></div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function parseWebviewMessage(value: unknown): WebviewMessage | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.type === 'ready' || candidate.type === 'refresh' || candidate.type === 'exportSchema') {
    return { type: candidate.type };
  }
  if (candidate.type === 'rendered' && typeof candidate.revision === 'number' && Number.isSafeInteger(candidate.revision)) {
    return { type: 'rendered', revision: candidate.revision };
  }
  if (candidate.type === 'openSource' && typeof candidate.nodeId === 'string' && candidate.nodeId.length < 1000) {
    return { type: 'openSource', nodeId: candidate.nodeId };
  }
  return undefined;
}
