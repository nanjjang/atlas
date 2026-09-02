import assert from 'node:assert/strict';
import * as vscode from 'vscode';

interface RepogramTestApi {
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

export async function run(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  assert.ok(folders?.length, 'The integration fixture workspace must be open.');
  assert.equal(folders[0]?.name, 'polyglot-workspace');

  // Found by package name rather than by full id, so changing the publisher —
  // which the Marketplace listing decides — does not break the test.
  const extension = vscode.extensions.all.find((candidate) => candidate.id.endsWith('.repogram'));
  assert.ok(extension, 'The Repogram development extension must be discoverable.');
  await extension.activate();
  assert.equal(extension.isActive, true, 'The Repogram extension must activate.');
  const api = extension.exports as RepogramTestApi;
  assert.equal(typeof api.getStatus, 'function', 'The extension must expose its read-only status API.');

  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes('repogram.open'), 'repogram.open must be registered.');
  assert.ok(commands.includes('repogram.refresh'), 'repogram.refresh must be registered.');
  assert.ok(
    commands.includes('repogram.exportSchemaDocs'),
    'repogram.exportSchemaDocs must be registered.',
  );

  // The sidebar has to stand on its own: opening the view container is the
  // whole interaction, with no command run first and no diagram panel involved.
  assert.equal(api.getStatus().panelOpen, false, 'No panel may be open before the overview is revealed.');
  await vscode.commands.executeCommand('repogram.overview.focus');
  await waitFor(
    () => api.getStatus().analysisReady,
    10000,
    'Revealing the sidebar view did not analyze the workspace on its own.',
  );
  assert.equal(api.getStatus().panelOpen, false, 'The sidebar must render without opening the diagram panel.');
  assert.equal(api.getStatus().projectName, 'polyglot-workspace');

  await vscode.commands.executeCommand('repogram.open');
  await waitFor(() => allTabLabels().includes('Repogram'), 5000, 'Repogram webview tab did not open.');
  await waitFor(
    () => api.getStatus().analysisReady && api.getStatus().renderReady,
    5000,
    'The webview did not complete its ready handshake, workspace analysis, and render pass.',
  );

  const status = api.getStatus();
  assert.equal(status.panelOpen, true);
  assert.equal(status.renderReady, true);
  assert.equal(status.projectName, 'polyglot-workspace');
  assert.ok((status.files ?? 0) >= 6, 'The fixture files must be scanned.');
  assert.ok((status.modules ?? 0) >= 3, 'The fixture modules must be analyzed.');
  assert.ok((status.flowUnits ?? 0) >= 3, 'Project, service, and file flow scopes must be analyzed.');
  assert.ok((status.databaseEntities ?? 0) >= 4, 'Prisma and Django entities must be analyzed.');

  // Following the editor is what makes the diagram worth keeping open beside
  // the code, so opening a file has to move the marker onto that file's module.
  const target = vscode.Uri.joinPath(folders[0].uri, 'src', 'api', 'users.ts');
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target));
  await waitFor(
    () => api.getStatus().activePath === 'src/api/users.ts',
    5000,
    'Opening a workspace file did not register as the active editor.',
  );
  assert.equal(
    api.getStatus().activeModuleNodeId,
    'module:src%2Fapi',
    'The active file must resolve to the module node id the diagram uses.',
  );

  await vscode.commands.executeCommand('repogram.refresh');
  await new Promise((resolve) => setTimeout(resolve, 500));

  assert.ok(allTabLabels().includes('Repogram'), 'Repogram webview tab closed unexpectedly after refresh.');
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
}

function allTabLabels(): string[] {
  return vscode.window.tabGroups.all.flatMap((group) => group.tabs.map((tab) => tab.label));
}

async function waitFor(predicate: () => boolean, timeoutMs: number, failureMessage: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(failureMessage);
}
