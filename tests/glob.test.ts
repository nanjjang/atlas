import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_EXCLUDE, matchesGlob, withRequiredExclude } from '../src/glob';

test('the default exclude pattern hides build output from the file watcher', () => {
  for (const excluded of [
    'node_modules/react/index.js',
    'dist/extension.js',
    'dist/webview/main.js',
    'build/classes/Main.java',
    'out/app.js',
    'coverage/lcov-report/index.html',
    '.vscode-test/user-data/Cache/Cache_Data/index',
    '.vscode-test-web/extensions/extensions.json',
    'dist-test/src/analyzer.js',
    'target/debug/app.rs',
    '.venv/lib/python3.12/site-packages/x.py',
    'packages/ui/node_modules/left-pad/index.js',
    'apps/web/.next/server/page.js',
    // A nested directory whose name is in the list is excluded too, exactly as
    // `findFiles` treats it — the watcher must not disagree with the scanner.
    'src/build/pipeline.ts',
  ]) {
    assert.equal(matchesGlob(DEFAULT_EXCLUDE, excluded), true, `${excluded} must be excluded`);
  }
});

test('the default exclude pattern keeps real source files', () => {
  for (const included of [
    'src/analyzer.ts',
    'src/panel.ts',
    'package.json',
    'prisma/schema.prisma',
    'app/models.py',
    'distribution/notes.md',
    'src/outbox/queue.ts',
  ]) {
    assert.equal(matchesGlob(DEFAULT_EXCLUDE, included), false, `${included} must not be excluded`);
  }
});

test('supports the glob syntax VS Code accepts in exclude settings', () => {
  assert.equal(matchesGlob('**/*.log', 'a/b/c.log'), true);
  assert.equal(matchesGlob('**/*.log', 'a/b/c.txt'), false);
  assert.equal(matchesGlob('src/*.ts', 'src/index.ts'), true);
  assert.equal(matchesGlob('src/*.ts', 'src/deep/index.ts'), false, 'a single star must not cross a separator');
  assert.equal(matchesGlob('src/**/*.ts', 'src/deep/index.ts'), true);
  assert.equal(matchesGlob('src/**/*.ts', 'src/index.ts'), true, 'a double star must also match zero segments');
  assert.equal(matchesGlob('**/{a,b}/**', 'x/b/y.ts'), true);
  assert.equal(matchesGlob('**/{a,b}/**', 'x/c/y.ts'), false);
  assert.equal(matchesGlob('file?.ts', 'file1.ts'), true);
  assert.equal(matchesGlob('file?.ts', 'file12.ts'), false);
  assert.equal(matchesGlob('log[0-9].txt', 'log7.txt'), true);
  assert.equal(matchesGlob('log[!0-9].txt', 'log7.txt'), false);
});

test('normalizes separators and leading path noise', () => {
  assert.equal(matchesGlob('**/dist/**', 'a\\dist\\b.js'), true);
  assert.equal(matchesGlob('**/dist/**', './dist/b.js'), true);
  assert.equal(matchesGlob('**/dist/**', '/dist/b.js'), true);
});

test('a malformed pattern excludes nothing instead of everything', () => {
  assert.equal(matchesGlob('**/[unclosed/**', 'src/index.ts'), false);
  assert.equal(matchesGlob('', 'src/index.ts'), false);
});

test('a workspace override cannot re-enable installed dependencies', () => {
  const exclude = withRequiredExclude('**/generated/**');
  assert.equal(matchesGlob(exclude, 'packages/ui/node_modules/react/index.js'), true);
  assert.equal(matchesGlob(exclude, 'generated/client.ts'), true);
  assert.equal(matchesGlob(exclude, 'src/index.ts'), false);
});
