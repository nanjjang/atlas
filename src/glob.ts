/**
 * A small matcher for the glob subset VS Code accepts in `files.exclude`-style
 * settings. `vscode.workspace.findFiles` applies `repogram.exclude` for us,
 * but `createFileSystemWatcher` cannot take an exclude pattern, so the watcher
 * has to answer "is this path excluded?" on its own.
 *
 * Supported: `**`, `*`, `?`, `{a,b}` (nestable), and `[abc]` / `[!abc]` classes.
 */

/** Kept in sync with the `repogram.exclude` default in package.json. */
export const DEFAULT_EXCLUDE =
  '**/{node_modules,.git,.hg,.svn,dist,dist-test,build,out,coverage,.next,.nuxt,.svelte-kit,target,vendor,.venv,venv,__pycache__,.turbo,.nx,.cache,.parcel-cache,.gradle,.pnpm-store,.yarn,.vercel,.output,.angular,.dart_tool,.vscode-test,.vscode-test-web,bin,obj}/**';

/** Installed dependencies and VCS internals are never authored project code. */
export const REQUIRED_EXCLUDE =
  '**/{node_modules,.git,.hg,.svn,.venv,venv,__pycache__,.gradle,.pnpm-store,.yarn,.dart_tool}/**';

/** Keeps required dependency exclusions even when a workspace overrides the setting. */
export function withRequiredExclude(configured: string): string {
  if (!configured || configured === REQUIRED_EXCLUDE) {
    return REQUIRED_EXCLUDE;
  }
  return `{${REQUIRED_EXCLUDE},${configured}}`;
}

const compiled = new Map<string, RegExp | undefined>();

const REGEXP_SPECIAL = new Set(['.', '+', '^', '$', '(', ')', '|', '\\', '/']);

function globToRegExpSource(pattern: string): string {
  let source = '';
  let index = 0;
  let braceDepth = 0;

  while (index < pattern.length) {
    const character = pattern[index];

    if (character === '*') {
      if (pattern[index + 1] === '*') {
        if (pattern[index + 2] === '/') {
          // `**/` spans zero or more whole path segments.
          source += '(?:[^/]*/)*';
          index += 3;
          continue;
        }
        source += '.*';
        index += 2;
        continue;
      }
      source += '[^/]*';
      index += 1;
      continue;
    }

    if (character === '?') {
      source += '[^/]';
      index += 1;
      continue;
    }

    if (character === '{') {
      braceDepth += 1;
      source += '(?:';
      index += 1;
      continue;
    }

    if (character === '}' && braceDepth > 0) {
      braceDepth -= 1;
      source += ')';
      index += 1;
      continue;
    }

    if (character === ',' && braceDepth > 0) {
      source += '|';
      index += 1;
      continue;
    }

    if (character === '[') {
      const close = pattern.indexOf(']', index + 1);
      if (close > index + 1) {
        const body = pattern.slice(index + 1, close);
        source += `[${body.startsWith('!') ? `^${body.slice(1)}` : body}]`;
        index = close + 1;
        continue;
      }
      source += '\\[';
      index += 1;
      continue;
    }

    if (character === undefined) {
      break;
    }
    source += REGEXP_SPECIAL.has(character) ? `\\${character}` : character;
    index += 1;
  }

  return source;
}

/**
 * Compiles `pattern` once and caches it. An unparseable pattern yields a matcher
 * that never matches, so a typo in the setting cannot silently hide the whole
 * workspace from the watcher.
 */
export function globMatcher(pattern: string): (path: string) => boolean {
  if (!compiled.has(pattern)) {
    let expression: RegExp | undefined;
    try {
      expression = new RegExp(`^${globToRegExpSource(pattern)}$`);
    } catch {
      expression = undefined;
    }
    compiled.set(pattern, expression);
  }
  const expression = compiled.get(pattern);
  if (!expression) {
    return () => false;
  }
  return (path: string) => expression.test(normalizeGlobPath(path));
}

export function matchesGlob(pattern: string, path: string): boolean {
  return globMatcher(pattern)(path);
}

function normalizeGlobPath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\/+/, '');
}
