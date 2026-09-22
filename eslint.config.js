import path from 'node:path';

const root = import.meta.dirname;
const nodeIo = new Set([
  'fs',
  'process',
  'child_process',
  'sqlite',
  'net',
  'http',
  'https',
  'http2',
  'dns',
  'dgram',
  'tls',
  'cluster',
  'worker_threads',
  'readline',
  'repl',
  'tty',
]);
const engineAdapters = new Set([
  'store',
  'projects',
  'git-workspaces',
  'providers',
  'provider-process',
  'workspaces',
  'validation',
  'council',
  'evidence-packet',
  'engine-runtime',
  'ask-tool',
]);
const inside = (file, directory) =>
  file === directory || file.startsWith(`${directory}/`);
const relative = (file) => path.relative(root, file).split(path.sep).join('/');

const importBoundaries = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      boundary: '{{layer}} must not import {{source}}. {{guidance}}',
    },
  },
  create(context) {
    const file = relative(context.filename);
    const client = inside(file, 'src/client');
    const shared = inside(file, 'src/shared');
    const domain = inside(file, 'src/server/domain');
    const ports = inside(file, 'src/server/ports');
    const engine = file === 'src/server/engine.ts';
    if (!client && !shared && !domain && !ports && !engine) return {};
    function check(node) {
      if (!node || typeof node.value !== 'string') return;
      const source = node.value;
      const specifier = source.replaceAll('\\', '/');
      const target =
        specifier.startsWith('.') || path.isAbsolute(specifier)
          ? relative(path.resolve(path.dirname(context.filename), specifier))
          : source;
      const builtin = source.replace(/^node:/, '').split('/')[0];
      let guidance;
      if (client && inside(target, 'src/server'))
        guidance = 'Use shared contracts and the HTTP API.';
      if (
        (shared || domain) &&
        (inside(target, 'src/client') ||
          (inside(target, 'src/server') &&
            !(domain && inside(target, 'src/server/domain'))) ||
          nodeIo.has(builtin))
      )
        guidance =
          'Keep shared policy pure; inject effects through application ports.';
      if (
        ports &&
        (inside(target, 'src/client') ||
          (inside(target, 'src/server') &&
            !inside(target, 'src/server/ports')) ||
          nodeIo.has(builtin))
      )
        guidance =
          'Define contracts with shared types, without concrete adapters.';
      const serverModule = target
        .replace(/^src\/server\//, '')
        .replace(/\.(?:[cm]?[jt]sx?)$/, '');
      if (
        engine &&
        (nodeIo.has(builtin) ||
          (inside(target, 'src/server') && engineAdapters.has(serverModule)))
      )
        guidance =
          'Inject effects through EngineEffects; compose adapters in engine-runtime or app.';
      if (guidance)
        context.report({
          node,
          messageId: 'boundary',
          data: {
            layer: client
              ? 'Client code'
              : shared || domain
                ? 'Pure policy'
                : ports
                  ? 'Application ports'
                  : 'Engine',
            source,
            guidance,
          },
        });
    }
    return {
      ImportDeclaration: (node) => check(node.source),
      ExportNamedDeclaration: (node) => check(node.source),
      ExportAllDeclaration: (node) => check(node.source),
      ImportExpression: (node) => check(node.source),
      CallExpression: (node) => {
        if (node.callee.type === 'Identifier' && node.callee.name === 'require')
          check(node.arguments[0]);
      },
    };
  },
};

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
  {
    name: 'agentloom/import-boundaries',
    files: ['src/**/*.{ts,tsx}'],
    plugins: {
      agentloom: { rules: { 'import-boundaries': importBoundaries } },
    },
    rules: { 'agentloom/import-boundaries': 'error' },
  },
  prettier,
);
