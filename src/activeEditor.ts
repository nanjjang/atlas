import * as vscode from 'vscode';
import { isTextAnalysisPath, moduleNodeIdForPath, structureNodeIdForPath } from './analyzer';

/** Where the editor currently is, expressed in the diagram's own identifiers. */
export interface ActiveContext {
  path: string;
  moduleNodeId: string;
  structureNodeId: string;
}

/**
 * Follows the active editor.
 *
 * A whole-project map is something you consult once. Kept open beside the code
 * it goes stale the moment you start typing, because nothing in it moves with
 * you. This turns the file under the cursor into a position on the diagram, so
 * the views can show where you are instead of where the project is.
 */
export class ActiveEditorTracker implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly emitter = new vscode.EventEmitter<ActiveContext | undefined>();
  private latest: ActiveContext | undefined;

  readonly onDidChange = this.emitter.event;

  /**
   * `projectRoots` says where each project inside the workspace begins, which
   * is what decides a file's module. Only the analysis knows them, and it
   * arrives after this is built, so it is read on each use rather than kept —
   * and `refresh` re-answers once the first analysis has landed.
   */
  constructor(private readonly projectRoots: () => readonly string[] = () => []) {
    this.latest = this.contextFor(vscode.window.activeTextEditor);
    this.disposables.push(
      this.emitter,
      vscode.window.onDidChangeActiveTextEditor((editor) => this.update(this.contextFor(editor))),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('repogram.followActiveEditor')) {
          this.update(this.contextFor(vscode.window.activeTextEditor));
        }
      }),
    );
  }

  /** Recomputes where the editor is, for when what a module means has changed. */
  refresh(): void {
    const next = this.contextFor(vscode.window.activeTextEditor);
    if (next?.moduleNodeId === this.latest?.moduleNodeId && next?.path === this.latest?.path) {
      return;
    }
    this.latest = next;
    this.emitter.fire(next);
  }

  get current(): ActiveContext | undefined {
    return this.latest;
  }

  private update(next: ActiveContext | undefined): void {
    if (next?.path === this.latest?.path) {
      return;
    }
    this.latest = next;
    this.emitter.fire(next);
  }

  dispose(): void {
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }

  private contextFor(editor: vscode.TextEditor | undefined): ActiveContext | undefined {
    if (!editor || !vscode.workspace.getConfiguration('repogram').get<boolean>('followActiveEditor', true)) {
      return undefined;
    }
    const uri = editor.document.uri;
    // Output channels, diff views and settings editors are text editors too.
    if (!vscode.workspace.getWorkspaceFolder(uri)) {
      return undefined;
    }
    const path = vscode.workspace.asRelativePath(uri, false).replaceAll('\\', '/');
    if (!isTextAnalysisPath(path)) {
      return undefined;
    }
    return {
      path,
      moduleNodeId: moduleNodeIdForPath(path, this.projectRoots()),
      structureNodeId: structureNodeIdForPath(path),
    };
  }
}


