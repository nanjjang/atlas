import type { StructureNode } from './model';

/**
 * What a file is written in, as far as the tree is concerned.
 *
 * Related extensions share a bucket, because the question an icon and a colour
 * answer is "what part of the project is this", and `.ts` beside `.tsx` is one
 * answer. Shared by both webviews: the diagram panel colours its file names by
 * this and the sidebar picks its icons from it, and two tables that drifted
 * apart would have the same file drawn two ways in one window.
 */
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts', 'd.ts': 'ts',
  js: 'js', jsx: 'js', mjs: 'js', cjs: 'js',
  py: 'py', pyi: 'py',
  java: 'jvm', kt: 'jvm', kts: 'jvm', scala: 'jvm', groovy: 'jvm',
  go: 'go',
  rs: 'rust',
  rb: 'ruby', erb: 'ruby',
  php: 'php',
  cs: 'dotnet', fs: 'dotnet', vb: 'dotnet',
  c: 'native', h: 'native', cc: 'native', cpp: 'native', hpp: 'native', cxx: 'native',
  m: 'native', mm: 'native', swift: 'native',
  dart: 'dart',
  sql: 'schema', prisma: 'schema', graphql: 'schema', gql: 'schema', proto: 'schema',
  json: 'config', yaml: 'config', yml: 'config', toml: 'config', ini: 'config',
  env: 'config', lock: 'config', conf: 'config', properties: 'config',
  md: 'docs', mdx: 'docs', txt: 'docs', rst: 'docs', adoc: 'docs',
  css: 'style', scss: 'style', sass: 'style', less: 'style', styl: 'style',
  html: 'markup', htm: 'markup', vue: 'markup', svelte: 'markup', xml: 'markup', astro: 'markup',
  png: 'asset', jpg: 'asset', jpeg: 'asset', gif: 'asset', svg: 'asset', ico: 'asset',
  webp: 'asset', woff: 'asset', woff2: 'asset', ttf: 'asset', mp4: 'asset',
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell', ps1: 'shell',
};

export const LANGUAGE_LABELS: Record<string, string> = {
  ts: 'TypeScript',
  js: 'JavaScript',
  py: 'Python',
  jvm: 'JVM',
  go: 'Go',
  rust: 'Rust',
  ruby: 'Ruby',
  php: 'PHP',
  dotnet: '.NET',
  native: 'C-family',
  dart: 'Dart',
  schema: 'Schema',
  config: 'Config',
  docs: 'Docs',
  style: 'Styles',
  markup: 'Markup',
  asset: 'Assets',
  shell: 'Shell',
  other: 'Other',
};

/** Answers are kept: a redraw asks for every visible file's, and the legend
    asks for every file's in the workspace. */
const languageCache = new Map<string, string>();

/**
 * A folder takes whatever it mostly holds, so a closed one still says what is
 * inside it rather than going blank.
 */
export function languageOf(node: StructureNode): string {
  const remembered = languageCache.get(node.id);
  if (remembered !== undefined) {
    return remembered;
  }
  let language = 'other';
  if (node.kind === 'file') {
    const extension = node.label.slice(node.label.lastIndexOf('.') + 1).toLowerCase();
    language = LANGUAGE_BY_EXTENSION[extension] ?? 'other';
  } else {
    const totals = new Map<string, number>();
    const walk = (current: StructureNode): void => {
      if (current.kind === 'file') {
        const found = languageOf(current);
        totals.set(found, (totals.get(found) ?? 0) + 1);
        return;
      }
      for (const child of current.children) {
        walk(child);
      }
    };
    walk(node);
    let best = 0;
    // Sorted first, so a tie between two languages resolves the same way every
    // time rather than by whichever the walk happened to reach first.
    for (const [candidate, count] of [...totals].sort((left, right) => left[0].localeCompare(right[0]))) {
      if (count > best) {
        best = count;
        language = candidate;
      }
    }
  }
  languageCache.set(node.id, language);
  return language;
}
