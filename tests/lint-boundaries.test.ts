import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { ESLint } from 'eslint';

const rule = 'agentloom/import-boundaries';
const root = path.resolve(import.meta.dirname, '..');

function boundaryLinter() {
  // Exercise the real configured rule/layer selectors without building the
  // whole TypeScript program: import boundaries are syntax-only diagnostics.
  return new ESLint({
    cwd: root,
    ruleFilter: ({ ruleId }) => ruleId === rule,
    overrideConfig: {
      languageOptions: {
        parserOptions: { projectService: false, project: null },
      },
    },
  });
}

void test('architecture boundaries reject effects and adapters at the configured layers', async () => {
  const eslint = boundaryLinter();
  const cases = [
    ['src/client/App.tsx', "import '../server/store.js';"],
    ['src/client/App.tsx', "import '../server';"],
    ['src/client/App.tsx', "export * from '../server/app.js';"],
    ['src/client/App.tsx', "void import('../server/engine.js');"],
    ['src/shared/types.ts', "import '../client/App.js';"],
    ['src/shared/types.ts', "import '../server/store.js';"],
    ['src/shared/types.ts', "import 'node:fs/promises';"],
    ['src/shared/types.ts', "import 'child_process';"],
    ['src/shared/types.ts', "import 'node:process';"],
    ['src/shared/types.ts', "import 'node:https';"],
    ['src/server/ports/repository.ts', "import '../store.js';"],
    ['src/server/ports/repository.ts', "import '../engine-runtime.js';"],
    ['src/server/ports/repository.ts', "import 'node:sqlite';"],
    ...[
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
    ].map((adapter) => ['src/server/engine.ts', `import './${adapter}.js';`]),
    ['src/server/engine.ts', "import 'node:fs';"],
    ['src/server/engine.ts', "void import('./workspaces.js');"],
    ['src/server/engine.ts', "require('node:child_process');"],
  ];
  for (const [filePath, source] of cases) {
    const [result] = await eslint.lintText(source, { filePath });
    assert.ok(result);
    assert.equal(result.fatalErrorCount, 0, JSON.stringify(result.messages));
    assert.equal(
      result.messages.filter((message) => message.ruleId === rule).length,
      1,
      `${filePath}: ${source}\n${JSON.stringify(result.messages)}`,
    );
  }
});

void test('architecture boundaries allow composition and shared contracts', async () => {
  const eslint = boundaryLinter();
  const cases = [
    ['src/client/App.tsx', "import '../shared/types.js';"],
    ['src/shared/types.ts', "import './planning.js';"],
    ['src/server/ports/repository.ts', "import '../../shared/types.js';"],
    ['src/server/ports/repository.ts', "import './execution.js';"],
    ['src/server/engine.ts', "import './ports/repository.js';"],
    ['src/server/engine.ts', "import '../shared/workflow-policy.js';"],
    ['src/server/engine.ts', "import 'node:path';"],
    ['src/shared/types.ts', "import 'node:crypto';"],
    ['src/server/app.ts', "import './store.js'; import './engine-runtime.js';"],
  ];
  for (const [filePath, source] of cases) {
    const [result] = await eslint.lintText(source, { filePath });
    assert.ok(result);
    assert.equal(result.fatalErrorCount, 0, JSON.stringify(result.messages));
    assert.deepEqual(
      result.messages.filter((message) => message.ruleId === rule),
      [],
      `${filePath}: ${source}`,
    );
  }
});

void test('boundary resolution handles native and portable paths plus normalized traversal', async () => {
  const eslint = boundaryLinter();
  const filenames = new Set([
    path.join(root, 'src', 'client', 'App.tsx'),
    path.join(root, 'src', 'client', 'App.tsx').replaceAll('\\', '/'),
  ]);
  for (const filePath of filenames) {
    const [result] = await eslint.lintText(
      "import '../shared/../server/store.js';",
      { filePath },
    );
    assert.ok(result);
    assert.equal(result.fatalErrorCount, 0, JSON.stringify(result.messages));
    assert.equal(
      result.messages.filter((message) => message.ruleId === rule).length,
      1,
    );
  }
});
