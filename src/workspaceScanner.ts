import * as vscode from 'vscode';
import { isTextAnalysisPath } from './analyzer';
import { DEFAULT_EXCLUDE } from './glob';
import type { AnalysisDiagnostic, WorkspaceFile } from './model';

export interface WorkspaceScanResult {
  files: WorkspaceFile[];
  uriByPath: Map<string, vscode.Uri>;
  projectName: string;
  diagnostics: AnalysisDiagnostic[];
}

export async function scanWorkspace(): Promise<WorkspaceScanResult> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    throw new Error('Open a folder or workspace before running Repogram.');
  }

  const configuration = vscode.workspace.getConfiguration('repogram');
  const maxFiles = clamp(configuration.get<number>('maxFiles', 2500), 100, 20000);
  const maxFileSizeKb = clamp(configuration.get<number>('maxFileSizeKb', 1024), 16, 10240);
  const maxFileSize = maxFileSizeKb * 1024;
  const exclude = configuration.get<string>('exclude', DEFAULT_EXCLUDE);

  const discovered = await vscode.workspace.findFiles('**/*', exclude, maxFiles + 1);
  const limited = discovered.length > maxFiles;
  const selectedUris = discovered.slice(0, maxFiles).sort((left, right) => left.toString().localeCompare(right.toString()));
  const multiRoot = folders.length > 1;
  const files: WorkspaceFile[] = [];
  const uriByPath = new Map<string, vscode.Uri>();
  let oversizedFiles = 0;
  let unreadableFiles = 0;
  let cursor = 0;

  const workers = Array.from({ length: Math.min(16, Math.max(1, selectedUris.length)) }, async () => {
    while (cursor < selectedUris.length) {
      const index = cursor;
      cursor += 1;
      const uri = selectedUris[index];
      if (!uri) {
        continue;
      }
      const folder = vscode.workspace.getWorkspaceFolder(uri);
      if (!folder) {
        continue;
      }
      const relative = vscode.workspace.asRelativePath(uri, false).replaceAll('\\', '/');
      const displayPath = multiRoot ? `${folder.name}/${relative}` : relative;

      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if ((stat.type & vscode.FileType.Directory) !== 0) {
          continue;
        }
        let content = '';
        if (isTextAnalysisPath(displayPath)) {
          if (stat.size > maxFileSize) {
            oversizedFiles += 1;
          } else {
            const data = await vscode.workspace.fs.readFile(uri);
            content = new TextDecoder('utf-8').decode(data);
          }
        }
        files.push({ path: displayPath, content, size: stat.size });
        uriByPath.set(displayPath, uri);
      } catch {
        unreadableFiles += 1;
      }
    }
  });

  await Promise.all(workers);
  files.sort((left, right) => left.path.localeCompare(right.path));

  const diagnostics: AnalysisDiagnostic[] = [];
  if (limited) {
    diagnostics.push({
      code: 'SCAN_LIMIT_REACHED',
      severity: 'warning',
      message: `The workspace contains more than ${maxFiles} files. The diagram is based on the first ${maxFiles} matching files. Increase repogram.maxFiles to scan more.`,
    });
  }
  if (oversizedFiles > 0) {
    diagnostics.push({
      code: 'FILE_SIZE_LIMIT',
      severity: 'info',
      message: `${oversizedFiles} text file${oversizedFiles === 1 ? ' was' : 's were'} included in the structure view but not parsed because the ${maxFileSizeKb} KiB size limit was exceeded.`,
    });
  }
  if (unreadableFiles > 0) {
    diagnostics.push({
      code: 'UNREADABLE_FILE',
      severity: 'warning',
      message: `${unreadableFiles} file${unreadableFiles === 1 ? ' could' : 's could'} not be read through the workspace file system.`,
    });
  }

  return {
    files,
    uriByPath,
    projectName: multiRoot ? `${folders.length} workspace folders` : folders[0]?.name ?? 'Workspace',
    diagnostics,
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return minimum;
  }
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}
