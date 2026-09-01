import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const shared = {
  bundle: true,
  minify: production,
  sourcemap: production ? false : 'inline',
  logLevel: 'info',
};

const extensionOptions = {
  ...shared,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
};

const webviewOptions = {
  ...shared,
  entryPoints: [
    'webview-src/main.ts',
    'webview-src/styles.css',
    'webview-src/overview.ts',
    'webview-src/overview.css',
  ],
  outdir: 'dist/webview',
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
};

if (watch) {
  const extensionContext = await esbuild.context(extensionOptions);
  const webviewContext = await esbuild.context(webviewOptions);
  await Promise.all([extensionContext.watch(), webviewContext.watch()]);
  console.log('Codraw is watching for changes.');
} else {
  await Promise.all([esbuild.build(extensionOptions), esbuild.build(webviewOptions)]);
}
