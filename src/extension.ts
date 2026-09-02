import * as vscode from 'vscode';
import { ActiveEditorTracker } from './activeEditor';
import { AnalysisService } from './analysisService';
import type { RepogramContext } from './repogramContext';
import { RepogramOverviewProvider } from './overviewView';
import { RepogramPanel } from './panel';
import { exportSchemaDocumentation } from './schemaExport';

export interface RepogramApi {
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

export function activate(context: vscode.ExtensionContext): RepogramApi {
  const service = new AnalysisService();
  // Which module a file belongs to depends on where its project begins, and
  // only the analysis knows that, so the tracker reads it from the latest one.
  const tracker = new ActiveEditorTracker(() => service.snapshot?.projectRoots ?? []);
  const repogram: RepogramContext = { extension: context, service, tracker };
  const overview = new RepogramOverviewProvider(repogram);

  context.subscriptions.push(
    service,
    tracker,
    service.onDidChange((event) => {
      if (event.type === 'snapshot') {
        tracker.refresh();
      }
    }),
    vscode.window.registerWebviewViewProvider(RepogramOverviewProvider.viewType, overview, {
      // The sidebar list is cheap to keep alive and expensive to rebuild, and
      // holding it means switching away and back is instant.
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('repogram.open', () => {
      RepogramPanel.createOrShow(repogram);
    }),
    vscode.commands.registerCommand('repogram.refresh', async () => {
      await RepogramPanel.refreshCurrent(repogram);
    }),
    vscode.commands.registerCommand('repogram.exportSchemaDocs', async () => {
      await exportSchemaDocumentation(repogram);
    }),
    vscode.window.registerWebviewPanelSerializer(RepogramPanel.viewType, {
      deserializeWebviewPanel(panel: vscode.WebviewPanel): Promise<void> {
        RepogramPanel.revive(repogram, panel);
        return Promise.resolve();
      },
    }),
  );

  return {
    getStatus: () => {
      const snapshot = service.snapshot;
      const panel = RepogramPanel.getStatus(snapshot);
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
