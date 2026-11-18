# Testing AgentLoom

Use Node 24 and install the pinned development dependencies with `npm ci --include=dev`. The default test environment uses temporary directories and explicit fake providers. It never needs an API key, a logged-in CLI, GitHub credentials, or the running AgentLoom application.

## Commands

| Command                    | Purpose                                                                     |
| -------------------------- | --------------------------------------------------------------------------- |
| `npm run check`            | Format, strict lint, typecheck, all backend tests, production build         |
| `npm test`                 | All `tests/*.test.ts` with Node's test runner                               |
| `npm run test:unit`        | Reviewed pure tests with no application/database setup                      |
| `npm run test:integration` | Every other backend test, including local adapter contracts                 |
| `npm run test:watch`       | All backend tests, rerun by Node when their dependencies change             |
| `npm run test:coverage`    | Source coverage summary and `artifacts/coverage/lcov.info`                  |
| `npm run test:ui`          | Build and run the full browser suite against a disposable application       |
| `npm run test:ui:docker`   | Build a Node 24/Chromium test image and run the same isolated browser suite |

Focus a test without changing a configuration file:

```sh
node --import tsx --test --test-name-pattern="approval gates" tests/engine.test.ts
npm run test:unit -- --test-name-pattern="tool"
npm run test:ui -- tests/ui/workflow-archive.spec.ts
```

The pure test list lives in `tests/support/run-tests.ts`. Add a file there only when its tests are pure. Integration is the complement of that list over every `tests/*.test.ts`, so a new file is always included in the full suite and in integration until deliberately classified. Tests remain on Node's built-in runner; browser interactions use Playwright.

Coverage is a diagnostic, not a percentage gate. The pinned `c8` adapter maps V8 coverage through `tsx` source maps back to the original TypeScript lines; the test runner remains Node. Fixture, generated, and test code are excluded by the `src/**/*.ts` / `src/**/*.tsx` include filters. The report covers source loaded by backend tests, including server-rendered component tests; it does not measure browser interaction coverage or claim unimported modules were exercised. Inspect the source paths and uncovered lines in the LCOV report when adding behavior. A green coverage command alone does not prove a feature is tested. Native Node coverage with this tsx version reports generated coordinates, which is why the source-map-aware adapter is required ([c8 source-map support](https://github.com/bcoe/c8#source-map-support)).

## Pure policy tests

Put decisions in a pure function and test meaningful outcomes without starting an app. Top-level registrations explicitly use `void test(...)`; await nested `t.test(...)` calls.

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidModelId } from '../src/shared/model-catalog.js';

void test('model IDs cannot be interpreted as CLI flags', () => {
  assert.equal(isValidModelId('--unsafe-option'), false);
  assert.equal(isValidModelId('provider/example-model'), true);
});
```

Use the existing domain builders and exact function signature for the policy you change. `tests/crates.test.ts` demonstrates complete typed runs and triage transitions.

## Application integration tests

`createAppFixture(t, options)` owns its temporary SQLite database, project directory, application, and teardown. The Node test context registers cleanup before setup; setup failures clean up too. `restart()` preserves the database and reinstalls the fake dependencies. Explicit `close()` is idempotent.

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppFixture } from './helpers/app-fixture.js';
import { agentResult, scriptedAgent } from './helpers/scripted-agent.js';
import type { Run } from '../src/shared/types.js';

void test('an approved review records the agent result', async (t) => {
  const agent = scriptedAgent([
    agentResult('Reviewed the requested scope.'),
    agentResult('Confirmed the independent review.'),
  ]);
  const f = await createAppFixture(t, { options: { execute: agent.execute } });
  const created = await f.request<Run>('/api/runs', {
    method: 'POST',
    expectedStatus: 201,
    payload: {
      title: 'Fixture review',
      task: 'Review the fixture.',
      project: 'welcome',
      workflowId: 'quick-review',
      mode: 'live',
    },
  });
  const completed = await f.wait(created.id, 'completed');
  assert.equal(completed.steps[0].output, 'Reviewed the requested scope.');
  assert.equal(agent.calls.length, 2);
});
```

`scriptedAgent` consumes a finite sequence of results, errors, or typed execution functions. An unexpected extra call fails instead of silently succeeding. `waitForRun` accepts a status or predicate, has a bounded timeout, and reports the last run/step/error state.

`createTestApp(config, overrides)` and `createBrowserTestApp(config, overrides)` support existing custom fixtures. Both default to deterministic provider status/catalogs and reject unexpected provider execution, Jev requests, Git operations, and GitHub reads/publication. Override only the effect your test needs. Temporary local Git contract tests explicitly opt in through `localGitEffects`; publication and remote PR reads still require separate fakes. Never enable real providers to make a default test pass.

## Browser tests

Install a browser once for native runs:

```sh
npx playwright install --with-deps chromium
npm run test:ui
```

The harness starts its own built app on an ephemeral loopback port, seeds a Welcome project, and passes the same absolute workspace path to the app and browser worker. It refuses port 4317 and caller-supplied `E2E_BASE_URL`, `E2E_WORKSPACE_ROOT`, or `AGENTLOOM_TEST_ROOT`. A generated marker ties Playwright to that disposable app. Direct `playwright test` without the harness fails with instructions; it never falls back to the live platform.

```ts
import { test, expect } from '@playwright/test';

test('workflows are available', async ({ page }) => {
  await page.goto('/?view=workflows&workflow=quick-review');
  await expect(page.getByLabel('Workflow name', { exact: true })).toBeVisible();
});
```

Tests requiring special fake behavior can create their own `createAppFixture(undefined, { built: true, options: { ... } })`, listen on port 0, and close it in `finally`. See `tests/ui/model-picker.spec.ts` and `tests/ui/workflow-archive.spec.ts`. All other self-hosting browser tests use the safe wrapper too.

The harness closes its listener and deletes its workspace after success, assertion failure, or graceful interruption. SIGINT/SIGTERM are forwarded to the browser runner; a runner that ignores termination is killed after three seconds. An OS-level forced kill or power loss cannot execute JavaScript cleanup. Native Windows process termination does not deliver POSIX SIGTERM; use Ctrl+C for graceful interruption.

### Docker and CI

`npm run test:ui:docker` uses the dedicated Compose project `agentloom-tests` and `compose.tests.yaml`. The image installs the Playwright version pinned in the lockfile and its matching Chromium/system dependencies. It exposes no port, mounts no source workspace, credentials, Docker socket, or production data, and creates all application state inside the disposable container. Only `test-results/` and `playwright-report/` are mounted to retain diagnostics. Remove the test network after use with:

```sh
docker compose -p agentloom-tests -f compose.tests.yaml down
```

CI runs `npm run check` and the full isolated browser suite without credentials. Failed browser runs retain traces, screenshots, and the HTML report. The Compose application smoke test is separate; follow the isolated `compose.validation.yaml` recipe in [Development](DEVELOPMENT.md#validate-the-compose-application).
