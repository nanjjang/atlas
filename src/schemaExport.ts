import * as vscode from 'vscode';
import type { RepogramContext } from './repogramContext';
import { buildSchemaDocument } from './schemaDocument';

/**
 * Writing the schema out as a file the reader chooses.
 *
 * A save dialog rather than a fixed path: where a project keeps its
 * documentation is the project's business, and a command that silently drops a
 * file into the workspace root has made that decision for it. It is also the
 * confirmation — the extension does not otherwise write anything, and this is
 * the one place it does.
 */
export async function exportSchemaDocumentation(repogram: RepogramContext): Promise<vscode.Uri | undefined> {
  const snapshot = await repogram.service.ensure();
  if (!snapshot) {
    void vscode.window.showWarningMessage('Repogram has no analysis to export yet.');
    return undefined;
  }
  if (snapshot.database.nodes.length === 0) {
    void vscode.window.showInformationMessage(`Repogram: ${snapshot.database.emptyMessage}`);
    return undefined;
  }

  const target = await vscode.window.showSaveDialog({
    defaultUri: defaultTarget(snapshot.projectName),
    filters: { Markdown: ['md'] },
    saveLabel: 'Export',
    title: 'Export schema documentation',
  });
  if (!target) {
    return undefined;
  }

  try {
    const document = buildSchemaDocument(snapshot);
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(document));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`Repogram could not write the schema document: ${message}`);
    return undefined;
  }

  const opened = await vscode.workspace.openTextDocument(target);
  await vscode.window.showTextDocument(opened, { preview: false });
  return target;
}

/**
 * Where the dialog opens. Beside the workspace, under a name that says what the
 * file is and which project it came from, because these end up in a docs folder
 * next to other people's.
 */
function defaultTarget(projectName: string): vscode.Uri | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return undefined;
  }
  return vscode.Uri.joinPath(folder.uri, `${fileNameFor(projectName)}-schema.md`);
}

export function fileNameFor(projectName: string): string {
  const cleaned = projectName
    .normalize('NFKD')
    .replaceAll(/[^\w.-]+/g, '-')
    .replaceAll(/-{2,}/g, '-')
    .replace(/^[-.]+/, '')
    .replace(/[-.]+$/, '')
    .toLowerCase();
  return cleaned || 'project';
}
