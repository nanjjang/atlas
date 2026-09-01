import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/** Globals available to the Node scripts in this repository. */
const nodeGlobals = {
  console: 'readonly',
  process: 'readonly',
  Buffer: 'readonly',
  __dirname: 'readonly',
  URL: 'readonly',
};

export default tseslint.config(
  {
    ignores: ['dist/**', 'dist-test/**', '.vscode-test/**', 'node_modules/**', 'tests/fixtures/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        // Both projects are listed so the test sources are type-aware too.
        project: ['./tsconfig.json', './tsconfig.test.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      // `node:test` returns a promise callers are meant to ignore.
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },
  {
    files: ['**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      globals: nodeGlobals,
    },
  },
);
