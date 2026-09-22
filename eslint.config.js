import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    name: 'agentloom/ignores',
    ignores: [
      'node_modules/',
      'dist/',
      '.data/',
      'artifacts/',
      'workspaces/',
      'playwright-report/',
      'test-results/',
      'docs/',
      'scripts/',
    ],
  },
  {
    // node:test owns the lifecycle of top-level registrations, so tests use an
    // explicit `void test(...)` (documented in the developer guide). Nested
    // `t.test(...)` subtests and all other promises must be awaited; there is
    // deliberately no rule-wide exemption for the test runner.
    name: 'agentloom/typescript',
    files: [
      'src/**/*.{ts,tsx}',
      'tests/**/*.ts',
      'vite.config.ts',
      'playwright.config.ts',
    ],
    extends: [js.configs.recommended, ...tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    name: 'agentloom/config-scripts',
    files: ['eslint.config.js'],
    extends: [js.configs.recommended],
  },
  prettier,
);
