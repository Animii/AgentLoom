# Developing AgentLoom

Contributor workflow for this repository. Repository rules for coding agents
live in [`AGENTS.md`](../AGENTS.md); test fixtures and examples are in
[Testing](TESTING.md); module boundaries are in [Architecture](ARCHITECTURE.md).

## Toolchain

Requires Node 24 and npm. Install the pinned toolchain from the lockfile:

```sh
npm ci --include=dev
```

The production server uses the built-in `node:sqlite` module and the Node
version pinned in `engines`. Older Node releases are not supported; several
automation tests fail under Node 22.

## Checks

Prettier is the single formatting authority and ESLint enforces the type-aware
`strictTypeChecked` preset with `--max-warnings=0`. The maintained scope is
`src/**`, `tests/**`, the TypeScript project files and the supported scripts in
`scripts/`; generated output, dependencies, workspaces, artifacts, credentials
and historical research paths are excluded.

```sh
npm run check         # format:check -> lint -> typecheck -> test -> build
npm run lint          # ESLint, zero warnings allowed
npm run lint:fix      # ESLint with autofixes
npm run format        # write Prettier formatting
npm run format:check  # verify formatting without writing
npm run typecheck
npm test
npm run build
npm start
```

Run `npm run check` before delivery; the TypeScript strict flag stays enabled.
Top-level `node:test` registrations in `tests/*.test.ts` use an explicit
`void test(...)` because the runner owns their lifecycle. Nested `t.test(...)`
subtests must be awaited, and other promises must be handled explicitly.

Editor settings in `.vscode/` select Prettier as the formatter and run ESLint
fixes on save. Format-on-save is optional. `.editorconfig` and `.gitattributes`
keep LF endings on every checkout, including Windows with `core.autocrlf=true`.

## Hot reload

Run the API and the Vite dev server in separate terminals:

```sh
npm run dev       # tsx watch, API on 127.0.0.1:4317
npm run dev:web   # Vite on 127.0.0.1:5173, proxies /api to 4317
```

Stop the Compose service first if it uses the same API port. Without `DATA_DIR`
and `WORKSPACE_ROOT`, local data goes to `.data/` and `workspaces/` (both
gitignored).

## Tests

```sh
npm run test:unit         # pure policy tests
npm run test:integration  # remaining backend tests, incl. SQLite and Git adapters
npm run test:watch
npm run test:coverage     # c8 source-mapped LCOV in artifacts/coverage/
npm run test:ui           # builds, then runs Playwright against a disposable app
npm run test:ui:docker    # same browser suite inside a Node 24 + Chromium image
```

The test helpers provide disposable app fixtures, scripted agents, bounded
waits, and explicit fake external services. Workflow policy can run against an
in-memory repository; adapter contracts exercise temporary SQLite and Git
repositories.

The browser command builds the app, starts a fresh temporary server on an
assigned local port, and cleans up its database and workspace when it finishes.
It does not reuse the running platform; caller-supplied `E2E_BASE_URL` and
workspace overrides are rejected. Install Chromium with
`npx playwright install chromium` for native browser tests, or use the Docker
browser command for matching Linux libraries. CI runs the checks and browser
suite without provider credentials.

Crate delivery and the PR machine validate through `npm run check`, so future
AgentLoom tasks must pass formatting, lint, types, backend tests and build
before review. Browser tests remain an additional gate for interaction changes.

## Validate the Compose application

Build and run an isolated stack that never replaces the running platform:

```sh
docker compose -p agentloom-validate -f compose.validation.yaml up -d --build --wait
docker compose -p agentloom-validate -f compose.validation.yaml ps
curl http://127.0.0.1:4318/api/health
docker compose -p agentloom-validate -f compose.validation.yaml down -v
```

The standalone validation configuration binds port 4318, explicitly clears all
provider keys, and uses only project-scoped disposable volumes. It mounts
neither host projects nor the Docker socket and does not reuse production
credentials or data. Use a unique project name if another validation stack
exists; port 4318 must be free. The final command removes only that validation
project's volumes. Open http://localhost:4318 and use demo mode for manual smoke
checks.

## Operating the Compose service

- `docker compose logs -f platform` shows server logs.
- `docker compose restart` preserves history and credentials.
- `docker compose down` preserves volumes; `docker compose down -v` deletes
  history and credentials.

## Live experiments

Scripts such as `node scripts/live-smoke.mjs` are separate live experiments:
they create provider tasks, require authentication, and may incur charges. They
are not part of the default test commands. An exit-zero CLI or waiting approval
alone does not establish task correctness; inspect the output and recorded
evidence.

`node scripts/start-pilot.mjs` starts the four-stage live slug-utility pilot and
leaves each handoff for manual review. `node scripts/check-restart.mjs
<waiting-run-id>` tests restart recovery and approval persistence by restarting
the entire Compose service; use only when other work may safely be interrupted.

See the [validation report](VALIDATION.md) and the pilot results
([PR machine](PR_MACHINE_PILOT_RESULTS.md),
[reliable delivery](RELIABLE_DELIVERY_RESULTS.md)) for recorded acceptance
results and limitations.
