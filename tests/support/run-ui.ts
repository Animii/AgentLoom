import { createRequire } from 'node:module';
import path from 'node:path';
import { runUiChild, withUiApp } from './ui-harness.js';

const require = createRequire(import.meta.url);
const cli = path.join(
  path.dirname(require.resolve('@playwright/test/package.json')),
  'cli.js',
);
const controller = new AbortController();
let exitCode: number | undefined;
const interrupt = () => {
  exitCode = 130;
  controller.abort();
};
const terminate = () => {
  exitCode = 143;
  controller.abort();
};
process.on('SIGINT', interrupt);
process.on('SIGTERM', terminate);
try {
  const code = await withUiApp(process.env, ({ address, workspace, root }) =>
    runUiChild(
      [cli, 'test', ...process.argv.slice(2)],
      {
        ...process.env,
        E2E_BASE_URL: address,
        E2E_WORKSPACE_ROOT: workspace,
        AGENTLOOM_TEST_ROOT: root,
      },
      controller.signal,
    ),
  );
  process.exitCode = exitCode ?? code;
} finally {
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', terminate);
}
