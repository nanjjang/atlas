import * as vscode from 'vscode';
import { ActiveEditorTracker } from './activeEditor';
import { AnalysisService } from './analysisService';
import type { CodrawContext } from './codrawContext';
import { CodrawOverviewProvider } from './overviewView';
import { CodrawPanel } from './panel';
import { exportSchemaDocumentation } from './schemaExport';

export interface CodrawApi {
  getStatus(): {
    panelOpen: boolean;
    analysisReady: boolean;
    renderReady: boolean;
    projectName?: string;
    files?: number;
    modules?: number;
    flowUnits?: number;
    databaseEntities?: number;
    activePath?: string;
    activeModuleNodeId?: string;
  };
}

export function activate(context: vscode.ExtensionContext): CodrawApi {
  const service = new AnalysisService();
  // Which module a file belongs to depends on where its project begins, and
  // only the analysis knows that, so the tracker reads it from the latest one.
  const tracker = new ActiveEditorTracker(() => service.snapshot?.projectRoots ?? []);
  const codraw: CodrawContext = { extension: context, service, tracker };
  const overview = new CodrawOverviewProvider(codraw);

  context.subscriptions.push(
    service,
    tracker,
    service.onDidChange((event) => {
      if (event.type === 'snapshot') {
        tracker.refresh();
      }
    }),
    vscode.window.registerWebviewViewProvider(CodrawOverviewProvider.viewType, overview, {
      // The sidebar list is cheap to keep alive and expensive to rebuild, and
      // holding it means switching away and back is instant.
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('codraw.open', () => {
      CodrawPanel.createOrShow(codraw);
    }),
    vscode.commands.registerCommand('codraw.refresh', async () => {
      await CodrawPanel.refreshCurrent(codraw);
    }),
    vscode.commands.registerCommand('codraw.exportSchemaDocs', async () => {
      await exportSchemaDocumentation(codraw);
    }),
    vscode.window.registerWebviewPanelSerializer(CodrawPanel.viewType, {
      deserializeWebviewPanel(panel: vscode.WebviewPanel): Promise<void> {
        CodrawPanel.revive(codraw, panel);
        return Promise.resolve();
      },
    }),
  );

  return {
    getStatus: () => {
      const snapshot = service.snapshot;
      const panel = CodrawPanel.getStatus(snapshot);
      const active = tracker.current;
      return {
        panelOpen: panel.panelOpen,
        analysisReady: Boolean(snapshot),
        renderReady: panel.renderReady,
        ...(snapshot ? {
          projectName: snapshot.projectName,
          files: snapshot.stats.files,
          modules: snapshot.stats.modules,
          flowUnits: snapshot.stats.flowUnits,
          databaseEntities: snapshot.stats.databaseEntities,
        } : {}),
        ...(active ? {
          activePath: active.path,
          activeModuleNodeId: active.moduleNodeId,
        } : {}),
      };
    },
  };
}

export function deactivate(): void {
  // VS Code disposes registered commands, views and panels through their subscriptions.
}
