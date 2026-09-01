import { runTests } from '@vscode/test-electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDirectory = path.dirname(fileURLToPath(import.meta.url));
const extensionDevelopmentPath = path.resolve(testsDirectory, '..');
const extensionTestsPath = path.resolve(extensionDevelopmentPath, 'dist-test/tests/integration/suite/index.js');
const fixturePath = path.resolve(testsDirectory, 'fixtures/polyglot-workspace');
const vscodeExecutablePath = '/Applications/Visual Studio Code.app/Contents/MacOS/Code';

try {
  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [fixturePath, '--skip-welcome', '--skip-release-notes'],
  });
} catch (error) {
  console.error('VS Code Extension Host integration test failed.');
  console.error(error);
  process.exitCode = 1;
}
