import type * as vscode from 'vscode';
import type { AnalysisService } from './analysisService';
import type { ActiveEditorTracker } from './activeEditor';

/**
 * What every view needs: the extension it lives in, the one analysis they all
 * share, and where the editor currently is. Passed as one value so adding a
 * collaborator does not mean re-threading every entry point.
 */
export interface RepogramContext {
  readonly extension: vscode.ExtensionContext;
  readonly service: AnalysisService;
  readonly tracker: ActiveEditorTracker;
}
