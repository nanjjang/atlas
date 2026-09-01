import { analyzeDatabase } from './databaseAnalyzer';
import { analyzeFlows } from './flowAnalyzer';
import { analyzeInterfaces } from './interfaceAnalyzer';
import type {
  AnalysisDiagnostic,
  AnalyzeOptions,
  DiagramEdge,
  DiagramGraph,
  DiagramNode,
  ProjectSnapshot,
  FileRole,
  StructureNode,
  WorkspaceFile,
} from './model';

const CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte',
  'py', 'java', 'kt', 'kts', 'go', 'rs', 'cs', 'php', 'rb', 'dart', 'swift',
  'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'hxx',
]);

const TEXT_ANALYSIS_EXTENSIONS = new Set([
  ...CODE_EXTENSIONS,
  'json', 'toml', 'yaml', 'yml', 'xml', 'gradle', 'sql', 'prisma',
  // Interface declarations: a service contract, a schema, and the settings a
  // port is written in are not code, and none of them were being read.
  'proto', 'graphql', 'gql', 'properties', 'conf', 'ini',
]);

const TEXT_ANALYSIS_FILENAMES = new Set([
  'dockerfile', 'go.mod', 'cargo.toml', 'gemfile', 'pipfile',
  'requirements.txt', 'package.json', 'pom.xml', 'build.gradle',
  'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts',
  'pnpm-workspace.yaml', 'pyproject.toml', 'pubspec.yaml', 'pubspec.yml',
  'cmakelists.txt', 'package.swift', 'meson.build',
  'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml',
  'procfile',
]);

const SOURCE_EXTENSIONS = [
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte', 'json',
  'py', 'java', 'kt', 'kts', 'go', 'rs', 'cs', 'php', 'rb', 'dart', 'swift',
  'h', 'hpp', 'hh', 'hxx', 'c', 'cc', 'cpp', 'cxx',
];

/** A package declared by a manifest, and the directory that manifest sits in. */
interface PackageRoot {
  name: string;
  directory: string;
}

/**
 * What the manifests in the workspace declare.
 *
 * Go and Dart both name their own packages in an import — `example.com/app/store`
 * and `package:app/store.dart` — so neither can be resolved by path alone. The
 * manifest is what says which prefix belongs to this workspace and where it
 * starts, and both languages allow more than one in a repository, so both are
 * kept as lists and matched longest name first.
 */
interface PackageIndex {
  goModules: PackageRoot[];
  dartPackages: PackageRoot[];
  /**
   * Directory to the Go files in it. A Go import names a package, and a Go
   * package is a directory: `import ".../store"` reaches every file in
   * `store/`, which is why resolving it to a single file finds nothing.
   */
  goPackageFiles: Map<string, string[]>;
  /**
   * Directories a C or C++ `#include` is resolved against, deepest first: the
   * `include` trees a project publishes its headers from. A quoted include is
   * tried against the including file's own directory before any of these.
   */
  includeRoots: string[];
  /**
   * Swift module name to the files in it. Swift imports a module, not a file,
   * and a SwiftPM target is a directory under `Sources`, so that layout is what
   * the module name is read from.
   */
  swiftModules: Map<string, string[]>;
}

const CFAMILY_EXTENSIONS = new Set(['c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'hxx']);

interface ImportFact {
  specifier: string;
  line: number;
}

interface MutableStructureNode {
  label: string;
  path: string;
  kind: 'folder' | 'file';
  metrics?: FileMetrics;
  children: Map<string, MutableStructureNode>;
}

/** What was measured about one file, for the Files view to rank it by. */
interface FileMetrics {
  bytes: number;
  lines?: number;
  imports: number;
  importedBy: number;
  role: FileRole;
}

interface ExternalModuleUse {
  count: number;
  source: string;
  line: number;
}

interface ExternalDependency {
  count: number;
  modules: Map<string, ExternalModuleUse>;
  source: string;
  line: number;
}

interface SymbolIndex {
  java: Map<string, string>;
  php: Map<string, string>;
  csharpNamespaces: Map<string, string[]>;
}

interface ArchitectureResult {
  graph: DiagramGraph;
  diagnostics: AnalysisDiagnostic[];
  moduleByPath: Map<string, string>;
  /**
   * Which file imports which, before the modules swallow it.
   *
   * The architecture graph deliberately collapses this: a diagram of 1100 file
   * nodes is not a diagram. But the same resolution answers questions the
   * module view cannot — which file the rest of the project leans on, and which
   * file nothing reaches — so it is kept on the way past rather than recomputed.
   */
  fileImports: Map<string, Set<string>>;
}

export function isTextAnalysisPath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  const name = lower.split('/').at(-1) ?? lower;
  if (name.startsWith('.env')) {
    return false;
  }
  if (TEXT_ANALYSIS_FILENAMES.has(name) || name.startsWith('dockerfile.')) {
    return true;
  }
  return TEXT_ANALYSIS_EXTENSIONS.has(extensionOf(lower));
}

export function isRelevantChange(filePath: string): boolean {
  return isTextAnalysisPath(filePath);
}

export function analyzeWorkspace(files: WorkspaceFile[], options: AnalyzeOptions): ProjectSnapshot {
  const sortedFiles = [...files].sort((left, right) => left.path.localeCompare(right.path));
  const architecture = analyzeArchitecture(sortedFiles);
  const flow = analyzeFlows(sortedFiles, options.projectName, architecture.graph, architecture.moduleByPath);
  const database = analyzeDatabase(sortedFiles);
  const interfaces = analyzeInterfaces(sortedFiles, architecture.moduleByPath);
  const structure = buildStructure(sortedFiles, options.projectName, architecture.fileImports);
  const diagnostics = [
    ...(options.diagnostics ?? []),
    ...architecture.diagnostics,
    ...flow.diagnostics,
    ...database.diagnostics,
    ...interfaces.diagnostics,
  ];

  return {
    schemaVersion: 1,
    revision: options.revision ?? Date.now(),
    projectName: options.projectName,
    generatedAt: new Date().toISOString(),
    technologies: detectTechnologies(sortedFiles),
    projectRoots: projectRootsOf(sortedFiles),
    stats: {
      files: sortedFiles.length,
      codeFiles: sortedFiles.filter((file) => CODE_EXTENSIONS.has(extensionOf(file.path))).length,
      modules: architecture.graph.nodes.filter((node) => node.kind === 'module').length,
      dependencies: architecture.graph.edges.length,
      flowUnits: flow.catalog.units.length,
      databaseEntities: database.graph.nodes.length,
      databaseRelations: database.graph.edges.length,
      protocols: interfaces.catalog.surfaces.length,
      endpoints: interfaces.catalog.surfaces.reduce(
        (total, surface) => total + surface.endpoints.length + surface.hiddenEndpoints,
        0,
      ),
      ports: interfaces.catalog.ports.length,
    },
    architecture: architecture.graph,
    structure,
    flow: flow.catalog,
    database: database.graph,
    interfaces: interfaces.catalog,
    diagnostics: deduplicateDiagnostics(diagnostics),
  };
}

function analyzeArchitecture(files: WorkspaceFile[]): ArchitectureResult {
  const codeFiles = files.filter((file) => CODE_EXTENSIONS.has(extensionOf(file.path)));
  const fileIndex = new Set(files.map((file) => normalizePath(file.path)));
  const symbols = buildSymbolIndex(codeFiles);
  const packages = indexPackages(files, codeFiles);
  const projectRoots = projectRootsOf(files);
  const moduleFiles = new Map<string, WorkspaceFile[]>();
  const moduleByPath = new Map<string, string>();

  for (const file of codeFiles) {
    const moduleName = moduleForPath(file.path, projectRoots);
    moduleByPath.set(normalizePath(file.path), moduleName);
    const group = moduleFiles.get(moduleName) ?? [];
    group.push(file);
    moduleFiles.set(moduleName, group);
  }

  const edgeCounts = new Map<string, { from: string; to: string; count: number; sources: string[]; line: number }>();
  const externalCounts = new Map<string, ExternalDependency>();
  const fileImports = new Map<string, Set<string>>();
  let unresolvedLocalImports = 0;

  for (const file of codeFiles) {
    const sourceModule = moduleForPath(file.path, projectRoots);
    const imports = extractImports(file);
    for (const imported of imports) {
      const targets = resolveImportTargets(file, imported.specifier, fileIndex, symbols, packages);
      if (targets.length) {
        const reached = fileImports.get(normalizePath(file.path)) ?? new Set<string>();
        for (const target of targets) {
          const normalized = normalizePath(target);
          // A file importing a sibling of its own is still a self-reference at
          // this level; counting it would make every barrel file look load-bearing.
          if (normalized !== normalizePath(file.path)) {
            reached.add(normalized);
          }
        }
        fileImports.set(normalizePath(file.path), reached);
        // One statement counts once per module it reaches, so a package wildcard
        // resolving to five sibling types is still a single import of that module.
        const targetModules = unique(targets.map((target) => moduleForPath(target, projectRoots))).sort();
        for (const targetModule of targetModules) {
          if (sourceModule === targetModule) {
            continue;
          }
          const key = `${sourceModule}\u0000${targetModule}`;
          const existing = edgeCounts.get(key) ?? {
            from: sourceModule,
            to: targetModule,
            count: 0,
            sources: [],
            line: imported.line,
          };
          existing.count += 1;
          if (existing.sources.length < 5 && !existing.sources.includes(file.path)) {
            existing.sources.push(file.path);
          }
          edgeCounts.set(key, existing);
        }
        continue;
      }

      if (isLocalSpecifier(imported.specifier, file.path)) {
        unresolvedLocalImports += 1;
        continue;
      }

      {
        const packageName = externalPackageFor(file.path, imported.specifier);
        if (packageName) {
          const existing = externalCounts.get(packageName) ?? {
            count: 0,
            modules: new Map<string, ExternalModuleUse>(),
            source: file.path,
            line: imported.line,
          };
          existing.count += 1;
          // Each module keeps its own first usage so the edge points at a file
          // that module actually contains.
          const moduleUse = existing.modules.get(sourceModule)
            ?? { count: 0, source: file.path, line: imported.line };
          moduleUse.count += 1;
          existing.modules.set(sourceModule, moduleUse);
          externalCounts.set(packageName, existing);
        }
      }
    }
  }

  const nodes: DiagramNode[] = [...moduleFiles.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([moduleName, moduleSourceFiles]) => {
      const languages = unique(moduleSourceFiles.map((file) => languageFor(file.path))).sort();
      const representative = moduleSourceFiles[0];
      return {
        id: moduleId(moduleName),
        kind: 'module',
        label: moduleName,
        subtitle: `${moduleSourceFiles.length} file${moduleSourceFiles.length === 1 ? '' : 's'}`,
        group: 'Workspace modules',
        ...(representative ? { source: { file: representative.path, line: 1 } } : {}),
        confidence: 'inferred' as const,
        metadata: {
          Files: String(moduleSourceFiles.length),
          Languages: languages,
          Examples: moduleSourceFiles.slice(0, 5).map((file) => file.path),
        },
      };
    });

  const edges: DiagramEdge[] = [...edgeCounts.values()]
    .sort((left, right) => `${left.from}/${left.to}`.localeCompare(`${right.from}/${right.to}`))
    .map((edge) => ({
      id: stableId('architecture-edge', edge.from, edge.to),
      from: moduleId(edge.from),
      to: moduleId(edge.to),
      kind: 'imports',
      label: edge.count === 1 ? '1 import' : `${edge.count} imports`,
      confidence: 'inferred',
      source: edge.sources[0] ? { file: edge.sources[0], line: edge.line } : undefined,
      metadata: { Sources: edge.sources },
    }));

  const topExternal = [...externalCounts.entries()]
    .sort((left, right) => right[1].count - left[1].count || left[0].localeCompare(right[0]))
    .slice(0, 18);

  for (const [packageName, dependency] of topExternal) {
    const nodeId = externalId(packageName);
    nodes.push({
      id: nodeId,
      kind: 'external-package',
      label: packageName,
      subtitle: `${dependency.count} usage${dependency.count === 1 ? '' : 's'}`,
      group: 'External packages',
      source: { file: dependency.source, line: dependency.line },
      confidence: 'exact',
      metadata: { 'Import usages': String(dependency.count) },
    });

    for (const [sourceModule, use] of [...dependency.modules.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      edges.push({
        id: stableId('external-edge', sourceModule, packageName),
        from: moduleId(sourceModule),
        to: nodeId,
        kind: 'uses',
        label: use.count === 1 ? '1 use' : `${use.count} uses`,
        confidence: 'exact',
        source: { file: use.source, line: use.line },
      });
    }
  }

  const diagnostics: AnalysisDiagnostic[] = [];
  if (unresolvedLocalImports > 0) {
    diagnostics.push({
      code: 'UNRESOLVED_IMPORT',
      severity: 'info',
      message: `${unresolvedLocalImports} local import${unresolvedLocalImports === 1 ? '' : 's'} could not be resolved statically. Aliases, generated files, or dynamic resolution may be involved.`,
    });
  }
  if (externalCounts.size > topExternal.length) {
    diagnostics.push({
      code: 'EXTERNAL_DEPENDENCY_LIMIT',
      severity: 'info',
      message: `Only the ${topExternal.length} most-used external JavaScript packages are shown to keep the architecture graph readable.`,
    });
  }

  return {
    graph: {
      kind: 'architecture',
      nodes,
      edges,
      emptyMessage: 'No supported source files were found in this workspace.',
    },
    diagnostics,
    moduleByPath,
    fileImports,
  };
}

function buildStructure(
  files: WorkspaceFile[],
  projectName: string,
  fileImports: Map<string, Set<string>>,
): StructureNode {
  const root: MutableStructureNode = {
    label: projectName,
    path: '',
    kind: 'folder',
    children: new Map(),
  };

  const importedBy = new Map<string, number>();
  for (const targets of fileImports.values()) {
    for (const target of targets) {
      importedBy.set(target, (importedBy.get(target) ?? 0) + 1);
    }
  }
  const projectRoots = projectRootsOf(files);

  for (const file of files) {
    const normalized = normalizePath(file.path);
    const parts = normalized.split('/').filter(Boolean);
    let current = root;
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      if (!part) {
        continue;
      }
      const isFile = index === parts.length - 1;
      const childPath = parts.slice(0, index + 1).join('/');
      let child = current.children.get(part);
      if (!child) {
        child = {
          label: part,
          path: childPath,
          kind: isFile ? 'file' : 'folder',
          children: new Map(),
        };
        current.children.set(part, child);
      }
      if (isFile) {
        child.metrics = {
          bytes: file.size,
          ...(file.content ? { lines: countLines(file.content) } : {}),
          imports: fileImports.get(normalized)?.size ?? 0,
          importedBy: importedBy.get(normalized) ?? 0,
          role: roleForPath(normalized, projectRoots),
        };
      }
      current = child;
    }
  }

  return freezeStructure(root);
}

function freezeStructure(node: MutableStructureNode): StructureNode {
  const children = [...node.children.values()]
    .sort((left, right) => {
      if (left.kind !== right.kind) {
        return left.kind === 'folder' ? -1 : 1;
      }
      return left.label.localeCompare(right.label);
    })
    .map(freezeStructure);

  const metrics = node.metrics;
  return {
    id: stableId('structure', node.path || '.'),
    label: node.label,
    path: node.path,
    kind: node.kind,
    ...(node.kind === 'file' ? { source: { file: node.path, line: 1 } } : {}),
    ...(metrics
      ? {
        bytes: metrics.bytes,
        ...(metrics.lines === undefined ? {} : { lines: metrics.lines }),
        imports: metrics.imports,
        importedBy: metrics.importedBy,
        role: metrics.role,
      }
      : {}),
    children,
  };
}

/**
 * Lines of text, counted the way an editor's status bar counts them: a file
 * ending in a newline has not gained a line by doing so.
 */
function countLines(content: string): number {
  if (!content) {
    return 0;
  }
  let lines = 1;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === '\n') {
      lines += 1;
    }
  }
  return content.endsWith('\n') ? lines - 1 : lines;
}

/**
 * Directory and file names that mean "this proves the code works" rather than
 * "this is the code". Matched as whole path segments, so `src/protester/` is
 * not a test directory and `contest.ts` is not a test file.
 */
const TEST_DIRECTORIES = new Set(['test', 'tests', '__tests__', 'spec', 'specs', 'testing', 'e2e', 'it']);

/**
 * Filenames that start a program rather than being reached from one.
 *
 * Only counted near a project root, because `index.ts` is the most common file
 * name in a TypeScript project and almost none of them are entry points. Two
 * segments of slack covers `src/main.ts`, `cmd/main.go` and `app/main.py`
 * without reaching down into feature folders.
 */
const ENTRY_BASENAMES = new Set([
  'main', 'index', 'app', 'server', 'cli', 'extension', 'program', 'application', 'bootstrap',
]);

/** Entry points regardless of depth: the name alone settles what they are. */
const ENTRY_FILENAMES = new Set([
  'manage.py', '__main__.py', 'wsgi.py', 'asgi.py', 'conftest.py',
]);

/** How far below its project root a file may sit and still read as an entry. */
const ENTRY_DEPTH = 2;

function roleForPath(filePath: string, projectRoots: readonly string[]): FileRole {
  const normalized = normalizePath(filePath);
  const name = normalized.split('/').at(-1) ?? '';
  const extension = extensionOf(name);
  const segments = normalized.split('/');

  if (isTestPath(normalized, name, segments)) {
    return 'test';
  }
  if (CODE_EXTENSIONS.has(extension)) {
    // A build script is code, but it is not the code the project is about, and
    // listing `vite.config.ts` beside the application's own modules is noise.
    if (isBuildScript(name)) {
      return 'config';
    }
    return isEntryPath(normalized, name, projectRoots) ? 'entry' : 'source';
  }
  if (TEXT_ANALYSIS_FILENAMES.has(name) || CONFIG_EXTENSIONS.has(extension)) {
    return 'config';
  }
  return 'other';
}

/** Stems that name a build script rather than a module of the project. */
const BUILD_SCRIPT_STEMS = new Set([
  'esbuild', 'gulpfile', 'gruntfile', 'karma', 'jest', 'babel', 'metro', 'nuxt', 'next',
]);

function isBuildScript(name: string): boolean {
  const stem = basenameWithoutExtension(name).toLowerCase();
  return /\.(config|conf|setup)$/.test(stem) || BUILD_SCRIPT_STEMS.has(stem);
}

const CONFIG_EXTENSIONS = new Set([
  'json', 'yaml', 'yml', 'toml', 'ini', 'env', 'lock', 'conf', 'cfg', 'properties', 'gradle',
]);

function isTestPath(normalized: string, name: string, segments: readonly string[]): boolean {
  if (segments.slice(0, -1).some((segment) => TEST_DIRECTORIES.has(segment.toLowerCase()))) {
    return true;
  }
  const stem = basenameWithoutExtension(name).toLowerCase();
  return /\.(test|spec)$/.test(stem)
    || /_test$/.test(stem)
    || stem.startsWith('test_')
    || /(test|tests|spec)$/.test(stem) && ['java', 'kt', 'cs', 'go', 'rb'].includes(extensionOf(name))
    || normalized.toLowerCase().includes('__mocks__');
}

function isEntryPath(normalized: string, name: string, projectRoots: readonly string[]): boolean {
  if (ENTRY_FILENAMES.has(name.toLowerCase())) {
    return true;
  }
  if (!ENTRY_BASENAMES.has(basenameWithoutExtension(name).toLowerCase())) {
    return false;
  }
  const root = [...projectRoots]
    .filter((candidate) => !candidate || normalized.startsWith(`${candidate}/`))
    .sort((left, right) => right.length - left.length)[0] ?? '';
  const relative = root ? normalized.slice(root.length + 1) : normalized;
  return relative.split('/').length <= ENTRY_DEPTH;
}

function extractImports(file: WorkspaceFile): ImportFact[] {
  const extension = extensionOf(file.path);
  const facts: ImportFact[] = [];
  const seen = new Set<string>();
  // A commented-out include is not an include, and C files carry more of them
  // than any other language here.
  const masked = CFAMILY_EXTENSIONS.has(extension) ? maskLineComments(file.content) : file.content;

  const addMatches = (expression: RegExp, group = 1): void => {
    for (const match of masked.matchAll(expression)) {
      const specifier = match[group]?.trim();
      if (!specifier) {
        continue;
      }
      const line = lineAt(masked, match.index ?? 0);
      const key = `${specifier}\u0000${line}`;
      if (!seen.has(key)) {
        facts.push({ specifier, line });
        seen.add(key);
      }
    }
  };

  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte'].includes(extension)) {
    // The clause between `import` and `from` may run over several lines — most
    // named-import lists in a formatted project do — so it cannot be matched
    // line by line. It is held to the characters an import clause is made of
    // (names, braces, commas, `*`, `as`) rather than "anything but a newline",
    // which is what keeps a lazy match from running past the statement it
    // started in and stealing the next one's specifier.
    addMatches(/(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:[\w$*,{}\s]*?\s+from\s*)?['"]([^'"]+)['"]/g);
    addMatches(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g);
    addMatches(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g);
  } else if (extension === 'py') {
    addMatches(/(?:^|\n)\s*from\s+([.\w]+)\s+import\s+/g);
    for (const match of file.content.matchAll(/(?:^|\n)\s*import\s+([^#\n]+)/g)) {
      const imports = match[1]?.split(',') ?? [];
      for (const item of imports) {
        const specifier = item.trim().split(/\s+as\s+/)[0];
        if (specifier) {
          facts.push({ specifier, line: lineAt(file.content, match.index ?? 0) });
        }
      }
    }
  } else if (extension === 'java' || extension === 'kt' || extension === 'kts') {
    addMatches(/(?:^|\n)\s*import\s+(?:static\s+)?([\w.*]+)(?:\s+as\s+\w+)?\s*;?/g);
  } else if (extension === 'cs') {
    addMatches(/(?:^|\n)\s*(?:global\s+)?using\s+(?:static\s+)?(?:[A-Za-z_]\w*\s*=\s*)?([\w.]+)\s*;/g);
  } else if (extension === 'rs') {
    // `mod foo;` declares a child module, which is the same target `self::foo` names.
    for (const match of file.content.matchAll(/(?:^|\n)\s*(?:pub(?:\s*\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)\s*;/g)) {
      const name = match[1];
      if (name) {
        facts.push({ specifier: `self::${name}`, line: lineAt(file.content, match.index ?? 0) });
      }
    }
    addMatches(/(?:^|\n)\s*(?:pub(?:\s*\([^)]*\))?\s+)?use\s+((?:crate|self|super)(?:::[\w*{}, ]+)*)\s*(?:as\s+\w+\s*)?;/g);
    // A `use` whose root is not `crate`, `self` or `super` names another crate.
    // Without this an entire Rust project reported no dependencies at all.
    addMatches(/(?:^|\n)\s*(?:pub(?:\s*\([^)]*\))?\s+)?use\s+((?!(?:crate|self|super)\b)[A-Za-z_]\w*(?:::[\w*{}, ]+)*)\s*(?:as\s+\w+\s*)?;/g);
    addMatches(/(?:^|\n)\s*(?:pub\s+)?extern\s+crate\s+([A-Za-z_]\w*)\s*(?:as\s+\w+\s*)?;/g);
  } else if (extension === 'php') {
    addMatches(/(?:^|\n)\s*use\s+(?:function\s+|const\s+)?\\?([\w\\]+)(?:\s+as\s+\w+)?\s*;/g);
    addMatches(/\b(?:require|require_once|include|include_once)\s*\(?\s*['"]([^'"]+)['"]/g);
  } else if (extension === 'rb') {
    for (const match of file.content.matchAll(/(?:^|\n)\s*require_relative\s+['"]([^'"]+)['"]/g)) {
      const target = match[1];
      if (target) {
        // Normalized to a relative specifier so it resolves like every other one.
        facts.push({ specifier: target.startsWith('.') ? target : `./${target}`, line: lineAt(file.content, match.index ?? 0) });
      }
    }
    addMatches(/(?:^|\n)\s*require\s+['"]([^'"]+)['"]/g);
  } else if (CFAMILY_EXTENSIONS.has(extension)) {
    // A quoted include is relative to the file that writes it, so it is
    // normalised the way every other relative specifier in here is. An angled
    // one names a header on the include path and is left as it stands.
    for (const match of masked.matchAll(/(?:^|\n)\s*#\s*include\s+"([^"]+)"/g)) {
      const target = match[1];
      if (target) {
        facts.push({
          specifier: target.startsWith('.') ? target : `./${target}`,
          line: lineAt(file.content, match.index ?? 0),
        });
      }
    }
    addMatches(/(?:^|\n)\s*#\s*include\s+<([^>]+)>/g);
  } else if (extension === 'swift') {
    addMatches(/(?:^|\n)\s*(?:@testable\s+)?import\s+(?:(?:typealias|struct|class|enum|protocol|let|var|func)\s+)?([A-Za-z_][\w.]*)/g);
  } else if (extension === 'dart') {
    // `import`, `export` and `part` all name a file; `part of` names the file
    // this one belongs to, which is the same relationship read backwards.
    addMatches(/(?:^|\n)\s*(?:import|export|part)\s+(?:of\s+)?r?['"]([^'"]+)['"]/g);
  } else if (extension === 'go') {
    addMatches(/(?:^|\n)\s*import\s+(?:\w+\s+)?["`]([^"`]+)["`]/g);
    for (const block of file.content.matchAll(/(?:^|\n)\s*import\s*\(([\s\S]*?)\)/g)) {
      const body = block[1] ?? '';
      for (const entry of body.matchAll(/(?:\w+\s+)?["`]([^"`]+)["`]/g)) {
        const specifier = entry[1];
        if (specifier) {
          facts.push({ specifier, line: lineAt(file.content, block.index ?? 0) });
        }
      }
    }
  }

  return facts.sort((left, right) => left.line - right.line || left.specifier.localeCompare(right.specifier));
}

/**
 * Resolves one import statement to the workspace files it can reach. Most
 * specifiers name exactly one file, but a package wildcard (`import a.b.*`) or a
 * C# namespace import legitimately reaches several, so the result is a list.
 */
function resolveImportTargets(
  sourceFile: WorkspaceFile,
  specifier: string,
  fileIndex: Set<string>,
  symbols: SymbolIndex,
  packages: PackageIndex,
): string[] {
  const extension = extensionOf(sourceFile.path);
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte'].includes(extension)) {
    let base: string | undefined;
    if (specifier.startsWith('.')) {
      base = joinPath(dirname(sourceFile.path), specifier);
    } else if (specifier.startsWith('@/')) {
      base = joinPath(workspacePrefix(sourceFile.path), 'src', specifier.slice(2));
    } else if (specifier.startsWith('~/')) {
      base = joinPath(workspacePrefix(sourceFile.path), specifier.slice(2));
    }
    return listed(base ? resolveFileCandidate(base, fileIndex) : undefined);
  }

  if (extension === 'py') {
    const prefix = workspacePrefix(sourceFile.path);
    if (specifier.startsWith('.')) {
      const dots = specifier.match(/^\.+/)?.[0].length ?? 1;
      const remainder = specifier.slice(dots).replaceAll('.', '/');
      let baseDirectory = dirname(sourceFile.path);
      for (let level = 1; level < dots; level += 1) {
        baseDirectory = dirname(baseDirectory);
      }
      return listed(resolvePythonCandidate(joinPath(baseDirectory, remainder), fileIndex));
    }
    const modulePath = specifier.replaceAll('.', '/');
    return listed(resolvePythonCandidate(joinPath(prefix, modulePath), fileIndex)
      ?? resolvePythonCandidate(joinPath(prefix, 'src', modulePath), fileIndex));
  }

  if (extension === 'java' || extension === 'kt' || extension === 'kts') {
    const direct = symbols.java.get(specifier);
    if (direct) {
      return [direct];
    }
    if (specifier.endsWith('.*')) {
      // A package wildcard pulls in every type declared in that package, not
      // just whichever one happens to be indexed first.
      const prefix = `${specifier.slice(0, -2)}.`;
      return unique(
        [...symbols.java.entries()]
          .filter(([qualifiedName]) => qualifiedName.startsWith(prefix))
          .map(([, path]) => path),
      ).sort();
    }
    return [];
  }

  if (extension === 'cs') {
    // C# `using` names a namespace, which several files may contribute to.
    return [...(symbols.csharpNamespaces.get(specifier) ?? [])].sort();
  }

  if (extension === 'php') {
    if (specifier.startsWith('.')) {
      return listed(resolveFileCandidate(joinPath(dirname(sourceFile.path), specifier), fileIndex, ['php']));
    }
    const qualified = specifier.replaceAll('\\\\', '\\').replace(/^\\/, '');
    return listed(symbols.php.get(qualified));
  }

  if (extension === 'rb') {
    if (specifier.startsWith('.')) {
      return listed(resolveFileCandidate(joinPath(dirname(sourceFile.path), specifier), fileIndex, ['rb']));
    }
    const prefix = workspacePrefix(sourceFile.path);
    return listed(resolveFileCandidate(joinPath(prefix, 'lib', specifier), fileIndex, ['rb'])
      ?? resolveFileCandidate(joinPath(prefix, specifier), fileIndex, ['rb']));
  }

  if (extension === 'rs') {
    return listed(resolveRustTarget(sourceFile.path, specifier, fileIndex));
  }

  if (extension === 'go') {
    const root = packages.goModules.find((module) =>
      specifier === module.name || specifier.startsWith(`${module.name}/`));
    if (!root) {
      return [];
    }
    const inside = specifier === root.name ? '' : specifier.slice(root.name.length + 1);
    const directory = normalizePath(joinPath(root.directory, inside));
    return packages.goPackageFiles.get(directory) ?? [];
  }

  if (CFAMILY_EXTENSIONS.has(extension)) {
    const target = specifier.replace(/^\.\//, '');
    const roots = specifier.startsWith('.')
      // Quoted: the file's own directory first, which is what the form means,
      // then the include trees, because plenty of projects quote those too.
      ? [dirname(sourceFile.path), ...packages.includeRoots]
      : packages.includeRoots;
    for (const root of roots) {
      const found = resolveFileCandidate(joinPath(root, target), fileIndex, []);
      if (found) {
        return [found];
      }
    }
    return [];
  }

  if (extension === 'swift') {
    return packages.swiftModules.get(specifier.split('.')[0] ?? specifier) ?? [];
  }

  if (extension === 'dart') {
    // The SDK is not in the workspace and never will be.
    if (specifier.startsWith('dart:')) {
      return [];
    }
    if (specifier.startsWith('package:')) {
      const rest = specifier.slice('package:'.length);
      const divider = rest.indexOf('/');
      if (divider < 0) {
        return [];
      }
      const root = packages.dartPackages.find((entry) => entry.name === rest.slice(0, divider));
      // `package:app/x.dart` is `lib/x.dart`: the package's public surface is
      // its `lib` directory, and the import path is taken from inside it.
      return root
        ? listed(resolveFileCandidate(joinPath(root.directory, 'lib', rest.slice(divider + 1)), fileIndex, ['dart']))
        : [];
    }
    return listed(resolveFileCandidate(joinPath(dirname(sourceFile.path), specifier), fileIndex, ['dart']));
  }

  return [];
}

function listed(value: string | undefined): string[] {
  return value ? [value] : [];
}

/**
 * `use crate::a::b::Type` names a path whose tail may be an item rather than a
 * module, so progressively shorter module paths are tried before giving up.
 */
function resolveRustTarget(sourcePath: string, specifier: string, fileIndex: Set<string>): string | undefined {
  const [root = '', ...rest] = specifier.split('::');
  const segments = rest
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && !segment.startsWith('{') && segment !== '*');
  if (!segments.length) {
    return undefined;
  }

  let baseDirectory: string;
  if (root === 'crate') {
    const prefix = workspacePrefix(sourcePath);
    baseDirectory = joinPath(prefix, 'src');
  } else if (root === 'super') {
    baseDirectory = dirname(dirname(sourcePath));
  } else {
    baseDirectory = dirname(sourcePath);
  }

  for (let length = segments.length; length > 0; length -= 1) {
    const candidate = joinPath(baseDirectory, segments.slice(0, length).join('/'));
    const resolved = [`${candidate}.rs`, `${candidate}/mod.rs`].find((path) => fileIndex.has(path));
    if (resolved) {
      return resolved;
    }
  }
  return undefined;
}

function resolveFileCandidate(base: string, fileIndex: Set<string>, extensions = SOURCE_EXTENSIONS): string | undefined {
  const normalized = normalizePath(base);
  const candidates = [normalized];
  for (const extension of extensions) {
    candidates.push(`${normalized}.${extension}`);
  }
  for (const extension of extensions) {
    candidates.push(`${normalized}/index.${extension}`);
  }
  return candidates.find((candidate) => fileIndex.has(candidate));
}

function resolvePythonCandidate(base: string, fileIndex: Set<string>): string | undefined {
  const normalized = normalizePath(base);
  return [`${normalized}.py`, `${normalized}/__init__.py`].find((candidate) => fileIndex.has(candidate));
}

/**
 * Namespace-style languages are resolved through declared package names rather
 * than paths, because their directory layout is a convention, not a rule.
 */
function buildSymbolIndex(files: WorkspaceFile[]): SymbolIndex {
  const java = new Map<string, string>();
  const php = new Map<string, string>();
  const csharpNamespaces = new Map<string, string[]>();

  for (const file of files) {
    const extension = extensionOf(file.path);
    const typeName = basenameWithoutExtension(file.path);

    if (['java', 'kt', 'kts'].includes(extension)) {
      const packageName = file.content.match(/(?:^|\n)\s*package\s+([\w.]+)/)?.[1];
      if (packageName && typeName) {
        java.set(`${packageName}.${typeName}`, file.path);
      }
      continue;
    }

    if (extension === 'php') {
      const namespaceName = file.content.match(/(?:^|\n)\s*namespace\s+([\w\\]+)\s*[;{]/)?.[1];
      if (namespaceName && typeName) {
        php.set(`${namespaceName}\\${typeName}`, file.path);
      }
      continue;
    }

    if (extension === 'cs') {
      // Both block-scoped and file-scoped namespace declarations count.
      for (const match of file.content.matchAll(/(?:^|\n)\s*namespace\s+([\w.]+)\s*[;{]/g)) {
        const namespaceName = match[1];
        if (!namespaceName) {
          continue;
        }
        const paths = csharpNamespaces.get(namespaceName) ?? [];
        if (!paths.includes(file.path)) {
          paths.push(file.path);
        }
        csharpNamespaces.set(namespaceName, paths);
      }
    }
  }

  return { java, php, csharpNamespaces };
}

function indexPackages(files: WorkspaceFile[], codeFiles: WorkspaceFile[]): PackageIndex {
  const goModules: PackageRoot[] = [];
  const dartPackages: PackageRoot[] = [];

  for (const file of files) {
    const name = normalizePath(file.path).split('/').at(-1)?.toLowerCase() ?? '';
    if (name === 'go.mod') {
      const module = file.content.match(/(?:^|\n)\s*module\s+(\S+)/)?.[1];
      if (module) {
        goModules.push({ name: module, directory: dirname(file.path) });
      }
    } else if (name === 'pubspec.yaml' || name === 'pubspec.yml') {
      // A top-level key, so anchored to the start of the line: `name:` nested
      // under a dependency means something else entirely.
      const declared = file.content.match(/^name:\s*['"]?([A-Za-z_]\w*)['"]?/m)?.[1];
      if (declared) {
        dartPackages.push({ name: declared, directory: dirname(file.path) });
      }
    }
  }

  // Longest first, so a nested module wins over the repository root that
  // contains it rather than whichever was scanned first.
  const byLength = (left: PackageRoot, right: PackageRoot): number =>
    right.name.length - left.name.length || left.name.localeCompare(right.name);
  goModules.sort(byLength);
  dartPackages.sort(byLength);

  const goPackageFiles = new Map<string, string[]>();
  for (const file of codeFiles) {
    const filePath = normalizePath(file.path);
    // A test file belongs to the package but is not reachable by importing it.
    if (!filePath.endsWith('.go') || filePath.endsWith('_test.go')) {
      continue;
    }
    const directory = dirname(filePath);
    const group = goPackageFiles.get(directory);
    if (group) {
      group.push(filePath);
    } else {
      goPackageFiles.set(directory, [filePath]);
    }
  }
  for (const group of goPackageFiles.values()) {
    group.sort();
  }

  const includeRoots: string[] = [];
  const swiftModules = new Map<string, string[]>();
  const directories = new Set<string>();
  for (const file of files) {
    const parts = normalizePath(file.path).split('/');
    for (let depth = 1; depth < parts.length; depth += 1) {
      directories.add(parts.slice(0, depth).join('/'));
    }
  }
  for (const directory of directories) {
    const name = directory.split('/').at(-1)?.toLowerCase();
    if (name === 'include' || name === 'inc' || name === 'headers') {
      includeRoots.push(directory);
    }
  }
  // Deepest first: a header published by a nested library belongs to that
  // library rather than to whatever include tree happens to sit above it.
  includeRoots.sort((left, right) => right.split('/').length - left.split('/').length
    || left.localeCompare(right));
  includeRoots.push('');

  for (const file of codeFiles) {
    const filePath = normalizePath(file.path);
    if (!filePath.endsWith('.swift')) {
      continue;
    }
    const parts = filePath.split('/');
    // `Sources/<Target>/…` is SwiftPM's layout, and the target is the module.
    const marker = parts.findIndex((part) => part === 'Sources' || part === 'Source');
    const moduleName = marker >= 0 ? parts[marker + 1] : undefined;
    if (moduleName === undefined || marker + 2 > parts.length - 1) {
      continue;
    }
    const group = swiftModules.get(moduleName);
    if (group) {
      group.push(filePath);
    } else {
      swiftModules.set(moduleName, [filePath]);
    }
  }
  for (const group of swiftModules.values()) {
    group.sort();
  }

  return { goModules, dartPackages, goPackageFiles, includeRoots, swiftModules };
}

/** Blanks out `//` comments so a commented-out include is not read as one. */
function maskLineComments(text: string): string {
  return text.replace(/\/\/[^\n]*/g, (comment) => ' '.repeat(comment.length));
}

function detectTechnologies(files: WorkspaceFile[]): string[] {
  const technologies = new Set<string>();
  const add = (technology: string): void => {
    technologies.add(technology);
  };

  const dependencyMap: Record<string, string> = {
    react: 'React',
    next: 'Next.js',
    vue: 'Vue',
    svelte: 'Svelte',
    express: 'Express',
    fastify: 'Fastify',
    '@nestjs/core': 'NestJS',
    typeorm: 'TypeORM',
    prisma: 'Prisma',
    '@prisma/client': 'Prisma',
    sequelize: 'Sequelize',
    drizzle_orm: 'Drizzle ORM',
    'drizzle-orm': 'Drizzle ORM',
    mongoose: 'Mongoose',
    '@typegoose/typegoose': 'Typegoose',
    mongodb: 'MongoDB',
    dynamoose: 'Dynamoose',
    '@aws-sdk/client-dynamodb': 'DynamoDB',
    'firebase-admin': 'Firebase',
    redis: 'Redis',
    ioredis: 'Redis',
  };

  // Matched as a prefix of a `require` line, because a Go module path carries
  // its major version: `github.com/labstack/echo/v4` is still Echo.
  const goModuleMap: Record<string, string> = {
    'github.com/gin-gonic/gin': 'Gin',
    'github.com/labstack/echo': 'Echo',
    'github.com/gofiber/fiber': 'Fiber',
    'github.com/go-chi/chi': 'chi',
    'github.com/gorilla/mux': 'Gorilla',
    'gorm.io/gorm': 'GORM',
    'entgo.io/ent': 'Ent',
    'github.com/uptrace/bun': 'Bun',
    'github.com/jmoiron/sqlx': 'sqlx',
    'go.mongodb.org/mongo-driver': 'MongoDB',
    'github.com/redis/go-redis': 'Redis',
  };

  const pubPackageMap: Record<string, string> = {
    flutter: 'Flutter',
    drift: 'Drift',
    moor: 'Drift',
    floor: 'Floor',
    isar: 'Isar',
    objectbox: 'ObjectBox',
    sqflite: 'sqflite',
    riverpod: 'Riverpod',
    flutter_riverpod: 'Riverpod',
    hooks_riverpod: 'Riverpod',
    bloc: 'Bloc',
    flutter_bloc: 'Bloc',
    provider: 'Provider',
    get: 'GetX',
  };

  for (const file of files) {
    const lowerPath = file.path.toLowerCase();
    const extension = extensionOf(lowerPath);
    if (CODE_EXTENSIONS.has(extension)) {
      const language = languageFor(file.path);
      if (language !== 'Other') {
        add(language);
      }
    }
    if (extension === 'prisma') add('Prisma');
    if (extension === 'sql') add('SQL');
    if (lowerPath.endsWith('dockerfile') || lowerPath.includes('docker-compose') || lowerPath.endsWith('compose.yaml') || lowerPath.endsWith('compose.yml')) add('Docker');
    if (lowerPath.endsWith('go.mod')) {
      add('Go modules');
      for (const [module, technology] of Object.entries(goModuleMap)) {
        if (file.content.includes(module)) add(technology);
      }
    }
    if (lowerPath.endsWith('pubspec.yaml') || lowerPath.endsWith('pubspec.yml')) {
      // Dependency names are the keys one level under `dependencies:`, so they
      // are the two-space entries — matching anywhere would also pick up `sdk`
      // and every other setting in the file.
      for (const entry of file.content.matchAll(/^ {2}([a-z_][a-z0-9_]*):/gm)) {
        const technology = pubPackageMap[entry[1] ?? ''];
        if (technology) add(technology);
      }
      if (/\bsdk:\s*flutter\b/.test(file.content)) add('Flutter');
    }
    if (lowerPath.endsWith('cargo.toml')) add('Cargo');
    if (lowerPath.endsWith('package.swift')) add('SwiftPM');
    if (lowerPath.endsWith('cmakelists.txt')) add('CMake');
    if (lowerPath.endsWith('meson.build')) add('Meson');
    if (lowerPath.endsWith('pom.xml') || lowerPath.endsWith('build.gradle') || lowerPath.endsWith('build.gradle.kts')) add('JVM build');

    if (lowerPath.endsWith('package.json')) {
      try {
        const manifest = JSON.parse(file.content) as {
          dependencies?: Record<string, unknown>;
          devDependencies?: Record<string, unknown>;
          workspaces?: unknown;
        };
        const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
        for (const dependency of Object.keys(dependencies)) {
          const technology = dependencyMap[dependency];
          if (technology) add(technology);
        }
        if (manifest.workspaces) add('JavaScript monorepo');
      } catch {
        // Malformed manifests remain visible in the structure view but are not executed.
      }
    }

    if (/\b(?:from\s+django|import\s+django|models\.Model)\b/.test(file.content)) add('Django');
    if (/\b(?:from\s+fastapi|import\s+fastapi)\b/.test(file.content)) add('FastAPI');
    if (/\b(?:from\s+flask|import\s+flask)\b/.test(file.content)) add('Flask');
    if (/\b(?:sqlalchemy|declarative_base)\b/.test(file.content)) add('SQLAlchemy');
    if (/\bSpringBootApplication\b|org\.springframework/.test(file.content)) add('Spring Boot');
    if (/\b(?:jakarta|javax)\.persistence\b/.test(file.content)) add('JPA');
    if (/\bmongoengine\b/.test(file.content)) add('MongoEngine');
    if (/\bfrom\s+beanie\b|\bimport\s+beanie\b/.test(file.content)) add('Beanie');
    if (/\b(?:from\s+pymongo|import\s+pymongo|import\s+motor)\b/.test(file.content)) add('MongoDB');
    if (/org\.springframework\.data\.mongodb/.test(file.content)) add('Spring Data MongoDB');
  }

  return [...technologies].sort((left, right) => left.localeCompare(right));
}

/**
 * The files that say "a project starts here".
 *
 * A repository with a Go service and a Flutter client in it is two projects,
 * and the modules worth drawing are inside each of them rather than being the
 * two directories they live in. The manifest is what marks the boundary,
 * because it is the thing the language's own tooling looks for.
 */
const PROJECT_MANIFESTS = new Set([
  'go.mod', 'package.json', 'pubspec.yaml', 'pubspec.yml', 'cargo.toml',
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'pyproject.toml', 'setup.py',
  'composer.json', 'gemfile', 'package.swift', 'cmakelists.txt', 'build.zig',
]);

/**
 * Where each project inside the workspace begins, deepest first so the nearest
 * one wins. The workspace root is always a project and is left implicit.
 */
function projectRootsOf(files: readonly WorkspaceFile[]): string[] {
  const roots = new Set<string>();
  for (const file of files) {
    const normalized = normalizePath(file.path);
    const name = normalized.split('/').at(-1)?.toLowerCase() ?? '';
    if (PROJECT_MANIFESTS.has(name)) {
      const directory = dirname(normalized);
      if (directory) {
        roots.add(directory);
      }
    }
  }
  return [...roots].sort((left, right) =>
    right.split('/').length - left.split('/').length || left.localeCompare(right));
}

const NESTING_ROOTS = [
  'apps', 'packages', 'services', 'modules', 'src', 'app', 'lib',
  // Go's standard layout, where the first segment is a role and the second is
  // the thing itself: `cmd/api` and `internal/store` are the modules, `cmd` and
  // `internal` are conventions.
  'cmd', 'internal', 'pkg',
  // SwiftPM's, where a target is a directory under `Sources`.
  'sources', 'source', 'tests', 'test',
  // And the C family's, where a library publishes its headers under one tree.
  'include', 'inc', 'headers',
];

/**
 * The module a file belongs to. Container directories like `src` say nothing on
 * their own, so they borrow the next path segment — but only when that segment is
 * a directory. `src/analyzer.ts` belongs to `src`; treating the file itself as a
 * module inflates the graph with one-file nodes and deepens every rank.
 */
function moduleForPath(filePath: string, projectRoots: readonly string[] = []): string {
  const parts = normalizePath(filePath).split('/').filter(Boolean);
  if (parts.length <= 1) {
    return '(root)';
  }
  // Directories only: the file's own name is never a module.
  const directories = parts.slice(0, -1);
  const root = projectRoots.find((candidate) => isUnder(directories, candidate));
  const depth = root ? root.split('/').filter(Boolean).length : 0;
  const inside = directories.slice(depth);
  if (!inside.length) {
    // A file sitting directly in a nested project: the project is the module.
    return root ?? '(root)';
  }
  const container = inside[0];
  const take = inside.length >= 2 && container && NESTING_ROOTS.includes(container.toLowerCase()) ? 2 : 1;
  return [...directories.slice(0, depth), ...inside.slice(0, take)].join('/');
}

/** Whether `directories` sits at or below `root`. */
function isUnder(directories: readonly string[], root: string): boolean {
  const parts = root.split('/').filter(Boolean);
  if (parts.length > directories.length) {
    return false;
  }
  return parts.every((part, index) => directories[index] === part);
}

function workspacePrefix(filePath: string): string {
  const normalized = normalizePath(filePath);
  const parts = normalized.split('/');
  const marker = parts.findIndex((part) => ['src', 'app', 'lib', 'test', 'tests'].includes(part));
  if (marker > 0) {
    return parts.slice(0, marker).join('/');
  }
  return '';
}

/**
 * Whether an unresolved specifier was meant to point inside the workspace. These
 * are worth reporting as a diagnostic; an unresolved third-party name is not.
 */
function isLocalSpecifier(specifier: string, sourcePath: string): boolean {
  if (specifier.startsWith('.') || specifier.startsWith('@/') || specifier.startsWith('~/')) {
    return true;
  }
  const extension = extensionOf(sourcePath);
  if (extension === 'rs') {
    return specifier.startsWith('crate::') || specifier.startsWith('self::') || specifier.startsWith('super::');
  }
  if (extension === 'dart') {
    // A bare `user.dart` is a sibling file, not a package: Dart writes its
    // relative imports without a leading `./`.
    return specifier.endsWith('.dart') && !specifier.startsWith('package:') && !specifier.startsWith('dart:');
  }
  return false;
}

/**
 * The distributable package an import names, or nothing when it names something
 * the workspace does not depend on — a relative path, or a standard library.
 *
 * Every language spells this differently, and getting it wrong is not a cosmetic
 * problem: reading `github.com/gin-gonic/gin` as `github.com` files every Go
 * dependency in the workspace under one node called after a hosting site.
 */
function externalPackageFor(filePath: string, specifier: string): string | undefined {
  switch (extensionOf(filePath)) {
    case 'go':
      return externalGoPackage(specifier);
    case 'dart':
      return externalDartPackage(specifier);
    case 'py':
      return externalPythonPackage(specifier);
    case 'java':
    case 'kt':
    case 'kts':
      return externalJvmPackage(specifier);
    case 'cs':
      return externalDotnetPackage(specifier);
    case 'rs':
      return externalRustCrate(specifier);
    case 'rb':
      return externalRubyGem(specifier);
    case 'php':
      return externalPhpVendor(specifier);
    case 'swift':
      return externalSwiftModule(specifier);
    case 'c':
    case 'h':
    case 'cc':
    case 'cpp':
    case 'cxx':
    case 'hpp':
    case 'hh':
    case 'hxx':
      return externalCHeader(specifier);
    default:
      return isJavaScriptLike(filePath) ? externalPackageName(specifier) : undefined;
  }
}

/**
 * What ships with the language.
 *
 * Importing one of these is not a dependency on anything, and listing them
 * would bury the handful of names that are: `os` and `System.Text` appear in
 * nearly every file of their language and say nothing about the project.
 *
 * A name missing from these lists shows up as a dependency that is not one.
 * That is the failure worth having — a stray node the reader can dismiss beats
 * a real dependency silently filtered away by an over-broad rule.
 */
const PYTHON_STDLIB = new Set([
  'abc', 'argparse', 'ast', 'asyncio', 'base64', 'binascii', 'bisect', 'builtins', 'bz2',
  'calendar', 'cgi', 'cmath', 'cmd', 'codecs', 'collections', 'colorsys', 'concurrent',
  'configparser', 'contextlib', 'contextvars', 'copy', 'csv', 'ctypes', 'dataclasses',
  'datetime', 'decimal', 'difflib', 'dis', 'doctest', 'email', 'enum', 'errno', 'faulthandler',
  'filecmp', 'fileinput', 'fnmatch', 'fractions', 'ftplib', 'functools', 'gc', 'getopt',
  'getpass', 'gettext', 'glob', 'graphlib', 'gzip', 'hashlib', 'heapq', 'hmac', 'html', 'http',
  'imaplib', 'importlib', 'inspect', 'io', 'ipaddress', 'itertools', 'json', 'keyword',
  'linecache', 'locale', 'logging', 'lzma', 'mailbox', 'math', 'mimetypes', 'mmap',
  'multiprocessing', 'netrc', 'numbers', 'operator', 'os', 'pathlib', 'pickle', 'pkgutil',
  'platform', 'plistlib', 'poplib', 'pprint', 'profile', 'pstats', 'queue', 'quopri', 'random',
  're', 'readline', 'reprlib', 'resource', 'sched', 'secrets', 'select', 'selectors', 'shelve',
  'shlex', 'shutil', 'signal', 'site', 'smtplib', 'socket', 'socketserver', 'sqlite3', 'ssl',
  'stat', 'statistics', 'string', 'stringprep', 'struct', 'subprocess', 'symtable', 'sys',
  'sysconfig', 'tarfile', 'tempfile', 'textwrap', 'threading', 'time', 'timeit', 'tkinter',
  'token', 'tokenize', 'tomllib', 'trace', 'traceback', 'tracemalloc', 'types', 'typing',
  'unicodedata', 'unittest', 'urllib', 'uuid', 'venv', 'warnings', 'wave', 'weakref',
  'webbrowser', 'wsgiref', 'xml', 'xmlrpc', 'zipapp', 'zipfile', 'zipimport', 'zlib',
  '__future__',
]);

const RUBY_STDLIB = new Set([
  'abbrev', 'base64', 'benchmark', 'bigdecimal', 'cgi', 'csv', 'date', 'delegate', 'digest',
  'English', 'erb', 'etc', 'fcntl', 'fileutils', 'find', 'forwardable', 'getoptlong', 'io',
  'ipaddr', 'json', 'logger', 'monitor', 'net', 'nkf', 'objspace', 'observer', 'open-uri',
  'open3', 'openssl', 'optparse', 'ostruct', 'pathname', 'pp', 'prettyprint', 'pstore', 'psych',
  'racc', 'rdoc', 'readline', 'resolv', 'ripper', 'securerandom', 'set', 'shellwords',
  'singleton', 'socket', 'stringio', 'strscan', 'tempfile', 'time', 'timeout', 'tmpdir',
  'tsort', 'uri', 'weakref', 'yaml', 'zlib',
]);

/**
 * The headers a C or C++ toolchain ships with, plus the POSIX ones every Unix
 * has. A header not on this list and not found in the workspace is taken to be
 * a library the project depends on, which is what `<boost/asio.hpp>` is.
 */
const C_STANDARD_HEADERS = new Set([
  // C++
  'algorithm', 'any', 'array', 'atomic', 'barrier', 'bit', 'bitset', 'charconv', 'chrono',
  'compare', 'complex', 'concepts', 'condition_variable', 'coroutine', 'deque', 'exception',
  'execution', 'expected', 'filesystem', 'format', 'forward_list', 'fstream', 'functional',
  'future', 'initializer_list', 'iomanip', 'ios', 'iosfwd', 'iostream', 'istream', 'iterator',
  'latch', 'limits', 'list', 'locale', 'map', 'memory', 'memory_resource', 'mutex', 'new',
  'numbers', 'numeric', 'optional', 'ostream', 'print', 'queue', 'random', 'ranges', 'ratio',
  'regex', 'scoped_allocator', 'semaphore', 'set', 'shared_mutex', 'source_location', 'span',
  'spanstream', 'sstream', 'stack', 'stacktrace', 'stdexcept', 'stdfloat', 'stop_token',
  'streambuf', 'string', 'string_view', 'strstream', 'syncstream', 'system_error', 'thread',
  'tuple', 'type_traits', 'typeindex', 'typeinfo', 'unordered_map', 'unordered_set', 'utility',
  'valarray', 'variant', 'vector', 'version',
  'cassert', 'cctype', 'cerrno', 'cfenv', 'cfloat', 'cinttypes', 'climits', 'clocale', 'cmath',
  'csetjmp', 'csignal', 'cstdarg', 'cstddef', 'cstdint', 'cstdio', 'cstdlib', 'cstring', 'ctime',
  'cuchar', 'cwchar', 'cwctype',
  // C
  'assert.h', 'complex.h', 'ctype.h', 'errno.h', 'fenv.h', 'float.h', 'inttypes.h', 'iso646.h',
  'limits.h', 'locale.h', 'math.h', 'setjmp.h', 'signal.h', 'stdalign.h', 'stdarg.h',
  'stdatomic.h', 'stdbool.h', 'stddef.h', 'stdint.h', 'stdio.h', 'stdlib.h', 'stdnoreturn.h',
  'string.h', 'tgmath.h', 'threads.h', 'time.h', 'uchar.h', 'wchar.h', 'wctype.h',
  // POSIX
  'aio.h', 'dirent.h', 'dlfcn.h', 'fcntl.h', 'fnmatch.h', 'ftw.h', 'glob.h', 'grp.h',
  'ifaddrs.h', 'langinfo.h', 'libgen.h', 'monetary.h', 'mqueue.h', 'ndbm.h', 'netdb.h',
  'nl_types.h', 'poll.h', 'pthread.h', 'pwd.h', 'regex.h', 'sched.h', 'search.h',
  'semaphore.h', 'spawn.h', 'strings.h', 'syslog.h', 'tar.h', 'termios.h', 'ucontext.h',
  'ulimit.h', 'unistd.h', 'utime.h', 'utmpx.h', 'wordexp.h',
]);

/** Include directories the platform owns rather than any one library. */
const C_PLATFORM_DIRECTORIES = new Set(['sys', 'bits', 'linux', 'asm', 'asm-generic', 'net', 'netinet', 'arpa', 'rpc', 'gnu', 'machine']);

/** Frameworks that come with the Apple platforms or the Swift toolchain. */
const SWIFT_PLATFORM = new Set([
  'Swift', 'Foundation', 'Dispatch', 'Darwin', 'Glibc', 'ObjectiveC', 'os', 'OSLog',
  'PackageDescription', 'CompilerPluginSupport',
  'Observation', 'Synchronization', 'XCTest', 'Testing', 'Combine', 'SwiftUI', 'SwiftData',
  'UIKit', 'AppKit', 'WatchKit', 'TVUIKit', 'CarPlay', 'WidgetKit', 'ActivityKit',
  'CoreData', 'CoreGraphics', 'CoreImage', 'CoreLocation', 'CoreML', 'CoreMedia', 'CoreMotion',
  'CoreText', 'CoreVideo', 'CoreAudio', 'CoreBluetooth', 'CoreTelephony', 'CoreHaptics',
  'AVFoundation', 'AVKit', 'AudioToolbox', 'VideoToolbox', 'Photos', 'PhotosUI', 'Vision',
  'MapKit', 'WebKit', 'StoreKit', 'CloudKit', 'HealthKit', 'HomeKit', 'ARKit', 'RealityKit',
  'SpriteKit', 'SceneKit', 'GameplayKit', 'Metal', 'MetalKit', 'Accelerate', 'Charts',
  'Contacts', 'ContactsUI', 'EventKit', 'EventKitUI', 'MessageUI', 'Messages', 'Intents',
  'IntentsUI', 'UserNotifications', 'BackgroundTasks', 'LocalAuthentication', 'PassKit',
  'QuickLook', 'SafariServices', 'Security', 'CryptoKit', 'Social', 'Speech', 'Network',
  'SystemConfiguration', 'MobileCoreServices', 'UniformTypeIdentifiers', 'TabularData',
]);

/** Namespace roots the platform owns, matched as a whole first segment. */
const JVM_PLATFORM = new Set(['java', 'javax', 'jakarta', 'kotlin', 'kotlinx', 'scala', 'groovy', 'android', 'dalvik']);
const DOTNET_PLATFORM = new Set(['System', 'Windows', 'Internal']);
const RUST_PLATFORM = new Set(['std', 'core', 'alloc', 'proc_macro', 'test']);

/** The first dotted segment: `django.db.models` is a dependency on `django`. */
function externalPythonPackage(specifier: string): string | undefined {
  const root = specifier.split('.')[0];
  return root && !PYTHON_STDLIB.has(root) ? root : undefined;
}

/**
 * A JVM import ends in the type it names, which belongs to no artifact of its
 * own, so it is dropped before the package is read. Three segments is where a
 * reverse-domain package stops being the vendor and starts being the library:
 * `org.springframework.boot`, `com.google.common`.
 */
function externalJvmPackage(specifier: string): string | undefined {
  const parts = specifier.split('.').filter(Boolean);
  const root = parts[0];
  if (!root || JVM_PLATFORM.has(root)) {
    return undefined;
  }
  const last = parts[parts.length - 1];
  const withoutType = last && (/^[A-Z]/.test(last) || last === '*') ? parts.slice(0, -1) : parts;
  return withoutType.length ? withoutType.slice(0, 3).join('.') : undefined;
}

/** C# namespaces are not reverse-domain, so the vendor is the first two parts. */
function externalDotnetPackage(specifier: string): string | undefined {
  const parts = specifier.split('.').filter(Boolean);
  const root = parts[0];
  if (!root || DOTNET_PLATFORM.has(root)) {
    return undefined;
  }
  return parts.slice(0, 2).join('.');
}

/** `use serde::Deserialize` is a dependency on the `serde` crate. */
function externalRustCrate(specifier: string): string | undefined {
  const root = specifier.split('::')[0]?.trim();
  return root && !RUST_PLATFORM.has(root) ? root : undefined;
}

/**
 * An angled include the workspace could not supply. `<boost/asio.hpp>` is the
 * `boost` library; `<vector>` and `<sys/stat.h>` are the platform.
 */
function externalCHeader(specifier: string): string | undefined {
  if (specifier.startsWith('.') || C_STANDARD_HEADERS.has(specifier)) {
    return undefined;
  }
  const parts = specifier.split('/').filter(Boolean);
  const root = parts[0];
  if (!root || C_PLATFORM_DIRECTORIES.has(root)) {
    return undefined;
  }
  // A library published as a directory is named by it; a loose header keeps its
  // own name, which is the only thing there is to call it.
  return parts.length > 1 ? root : root.replace(/\.(?:h|hpp|hh|hxx)$/, '');
}

/** `import Alamofire` is a dependency; `import Foundation` is the platform. */
function externalSwiftModule(specifier: string): string | undefined {
  const root = specifier.split('.')[0];
  return root && !SWIFT_PLATFORM.has(root) ? root : undefined;
}

/** `require 'active_support/core_ext'` is the `active_support` gem. */
function externalRubyGem(specifier: string): string | undefined {
  const root = specifier.split('/')[0];
  return root && !RUBY_STDLIB.has(root) ? root : undefined;
}

/**
 * A Composer package publishes under a vendor namespace, so the first two
 * segments of a `use` are what identifies it: `Symfony\\Component`.
 */
function externalPhpVendor(specifier: string): string | undefined {
  if (specifier.startsWith('.') || specifier.includes('/')) {
    // A relative `require` that did not resolve is a missing file, not a package.
    return undefined;
  }
  const parts = specifier.replace(/^\\+/, '').split('\\').filter(Boolean);
  return parts.length ? parts.slice(0, 2).join('\\') : undefined;
}

/**
 * Go's own rule: an import path whose first segment is a domain is a module to
 * be fetched, and one without a dot is the standard library. `net/http` is not
 * a dependency; `github.com/gin-gonic/gin` is.
 *
 * Three segments is where a module path ends on every hosting site that matters
 * — `github.com/owner/repo`, `golang.org/x/sync` — and a shorter path keeps
 * whatever it has, which is what `gopkg.in/yaml.v3` needs.
 */
function externalGoPackage(specifier: string): string | undefined {
  const parts = specifier.split('/').filter(Boolean);
  const host = parts[0];
  if (!host?.includes('.')) {
    return undefined;
  }
  return parts.slice(0, 3).join('/');
}

/** `package:flutter/material.dart` is the `flutter` package; `dart:async` is the SDK. */
function externalDartPackage(specifier: string): string | undefined {
  if (!specifier.startsWith('package:')) {
    return undefined;
  }
  return specifier.slice('package:'.length).split('/')[0] || undefined;
}

function externalPackageName(specifier: string): string | undefined {
  if (!specifier || specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('@/') || specifier.startsWith('~/')) {
    return undefined;
  }
  const parts = specifier.split('/');
  if (specifier.startsWith('@')) {
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier;
  }
  return parts[0];
}

function isJavaScriptLike(filePath: string): boolean {
  return ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte'].includes(extensionOf(filePath));
}

function languageFor(filePath: string): string {
  const extension = extensionOf(filePath);
  const languages: Record<string, string> = {
    ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
    vue: 'Vue', svelte: 'Svelte', py: 'Python', java: 'Java', kt: 'Kotlin', kts: 'Kotlin',
    go: 'Go', rs: 'Rust', cs: 'C#', php: 'PHP', rb: 'Ruby', dart: 'Dart', swift: 'Swift',
    c: 'C', h: 'C', cc: 'C++', cpp: 'C++', cxx: 'C++', hpp: 'C++', hh: 'C++', hxx: 'C++',
  };
  return languages[extension] ?? 'Other';
}

function extensionOf(filePath: string): string {
  const name = filePath.toLowerCase().split('/').at(-1) ?? '';
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1) : '';
}

function basenameWithoutExtension(filePath: string): string {
  const name = normalizePath(filePath).split('/').at(-1) ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

function dirname(filePath: string): string {
  const parts = normalizePath(filePath).split('/');
  parts.pop();
  return parts.join('/');
}

function joinPath(...parts: string[]): string {
  return normalizePath(parts.filter(Boolean).join('/'));
}

function normalizePath(filePath: string): string {
  const output: string[] = [];
  for (const part of filePath.replaceAll('\\', '/').split('/')) {
    if (!part || part === '.') {
      continue;
    }
    if (part === '..') {
      output.pop();
    } else {
      output.push(part);
    }
  }
  return output.join('/');
}

function lineAt(content: string, index: number): number {
  return content.slice(0, index).split('\n').length;
}

function moduleId(moduleName: string): string {
  return stableId('module', moduleName);
}

/**
 * The architecture node a workspace file belongs to, and its row in the
 * structure tree. Both are exported so the views can map the file being edited
 * onto the diagram without re-deriving the id scheme from the outside.
 */
export function moduleNodeIdForPath(filePath: string, projectRoots: readonly string[] = []): string {
  return moduleId(moduleForPath(filePath, projectRoots));
}

export function structureNodeIdForPath(filePath: string): string {
  return stableId('structure', normalizePath(filePath) || '.');
}

function externalId(packageName: string): string {
  return stableId('external', packageName);
}

function stableId(...parts: string[]): string {
  return parts.map((part) => encodeURIComponent(part)).join(':');
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function deduplicateDiagnostics(diagnostics: AnalysisDiagnostic[]): AnalysisDiagnostic[] {
  const uniqueDiagnostics = new Map<string, AnalysisDiagnostic>();
  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.code}\u0000${diagnostic.message}\u0000${diagnostic.source?.file ?? ''}\u0000${diagnostic.source?.line ?? ''}`;
    uniqueDiagnostics.set(key, diagnostic);
  }
  return [...uniqueDiagnostics.values()].sort((left, right) => left.code.localeCompare(right.code) || left.message.localeCompare(right.message));
}
