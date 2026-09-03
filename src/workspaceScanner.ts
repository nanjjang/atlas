import * as vscode from 'vscode';
import { isTextAnalysisPath } from './analyzer';
import { DEFAULT_EXCLUDE, withRequiredExclude } from './glob';
import type { AnalysisDiagnostic, WorkspaceFile } from './model';

/**
 * File-searching a whole workspace makes a large repository wait on assets,
 * caches and binary documents before it can read a single source file. The
 * diagram only consumes these source/configuration shapes, so search them
 * directly. `isTextAnalysisPath` remains the final guard for filenames and
 * future extension changes.
 */
const ANALYSIS_FILE_GLOB =
  '**/*.{ts,tsx,js,jsx,mjs,cjs,vue,svelte,py,java,kt,kts,go,rs,cs,php,rb,dart,swift,c,h,cc,cpp,cxx,hpp,hh,hxx,json,toml,yaml,yml,xml,gradle,sql,prisma,proto,graphql,gql,properties,conf,ini}';
const ANALYSIS_NAME_GLOB =
  '**/{Dockerfile,dockerfile,go.mod,Cargo.toml,Gemfile,Pipfile,requirements.txt,package.json,pom.xml,build.gradle,build.gradle.kts,settings.gradle,settings.gradle.kts,pnpm-workspace.yaml,pyproject.toml,pubspec.yaml,pubspec.yml,CMakeLists.txt,Package.swift,meson.build,docker-compose.yml,docker-compose.yaml,compose.yml,compose.yaml,Procfile,procfile}';

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
  const maxFiles = clamp(configuration.get<number>('maxFiles', 10000), 100, 20000);
  const maxFileSizeKb = clamp(configuration.get<number>('maxFileSizeKb', 1024), 16, 10240);
  const maxFileSize = maxFileSizeKb * 1024;
  const exclude = configuration.get<string>('exclude', DEFAULT_EXCLUDE);
  const scanExclude = withRequiredExclude(exclude);

  // Searching only eligible files is the critical fast path for large
  // workspaces: `**/*` made VS Code enumerate every image, archive and
  // generated artifact before this extension could start reading code.
  // Dependency folders are a non-negotiable exclusion. A workspace may have a
  // user-specific `repogram.exclude` value, but that must never re-enable
  // `node_modules` and make the scanner walk installed package trees.
  const candidates = await Promise.all([
    vscode.workspace.findFiles(ANALYSIS_FILE_GLOB, scanExclude, maxFiles + 1),
    vscode.workspace.findFiles(ANALYSIS_NAME_GLOB, scanExclude, maxFiles + 1),
  ]);
  const discovered = [...new Map(
    candidates.flat().map((uri) => [uri.toString(), uri]),
  ).values()].sort((left, right) => left.toString().localeCompare(right.toString()));
  const limited = discovered.length > maxFiles;
  const selectedUris = discovered.slice(0, maxFiles);
  const multiRoot = folders.length > 1;
  const files: WorkspaceFile[] = [];
  const uriByPath = new Map<string, vscode.Uri>();
  let oversizedFiles = 0;
  let unreadableFiles = 0;
  let cursor = 0;

  // File reads dominate a large local or remote workspace scan. More workers
  // make a 10,000-file index responsive without turning every file into a
  // simultaneous request, which is especially costly for remote providers.
  const workers = Array.from({ length: Math.min(32, Math.max(1, selectedUris.length)) }, async () => {
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
        // The targeted glob is deliberately broad enough for every supported
        // extension, while this guard protects the contract if VS Code returns
        // a case variant or the include list changes later.
        if (!isTextAnalysisPath(displayPath)) {
          continue;
        }
        let content = '';
        if (stat.size > maxFileSize) {
          oversizedFiles += 1;
        } else {
          const data = await vscode.workspace.fs.readFile(uri);
          content = new TextDecoder('utf-8').decode(data);
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
