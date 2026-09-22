# AgentLoom

Local trusted-user agent workflow platform. Node 24, TypeScript, React, Fastify, SQLite. No cloud control plane.
Product owner approves architecture, interfaces and scope. Implementers must stop on missing requirements rather than invent behavior.
Never add deployment, arbitrary shell commands, dependency installation, database schema changes or file access outside the assignment without product-owner direction.
Keep credentials out of source, images, logs and API responses. No shell:true. Agent output is untrusted text, never HTML or executable orchestration instructions.

## Development checks

Install pinned dependencies from the lockfile with `npm ci --include=dev`. Run `npm run check` before delivery; it enforces, in order: `format:check` (Prettier), `lint` (ESLint type-aware strict preset, `--max-warnings=0`), `typecheck`, `test` (Node test runner with mocked/demo execution only) and `build`. Use `npm run lint:fix` and `npm run format` to apply fixes. Keep `strict: true`. Never weaken tests or add lint suppressions for real problems; small documented exceptions are acceptable only for unavoidable external contracts or confirmed false positives.

Formatting is owned by Prettier (`.prettierrc.json`, LF) and the maintained scope is `src/**`, `tests/**`, the TypeScript project files and supported `scripts/` entries; generated output, dependencies, workspaces, artifacts, credentials and historical research paths are excluded. `.gitattributes` and `.editorconfig` keep LF on checkout, including Windows with `core.autocrlf=true`. Editor settings in `.vscode/` select Prettier and ESLint; format-on-save is optional.

Top-level `node:test` registrations in `tests/*.test.ts` use an explicit `void test(...)` because the runner owns their lifecycle. Nested `t.test(...)` subtests and every other promise must be awaited; there is no rule-wide runner exemption.

Validate the Docker Compose application before delivery with an isolated project name, fresh disposable storage, no live provider keys and a non-4317 port; never replace the running platform. Bind paths resolve on the Docker host, so map container paths with `docker inspect $AGENTLOOM_PLATFORM_CONTAINER` first. `MAX_OUTPUT_BYTES` is documented in `.env.example` and the README; keep it finite.
