# AgentLoom acceptance record

Validation performed locally on 19 September 2026, using Docker Desktop Linux containers and the platform at http://localhost:4317.

## Automated platform checks

- TypeScript strict typecheck passed.
- Production build passed locally and in Docker.
- 32 Node tests passed: engine state transitions, approval blocking, revisions, BLOCKED handling, failure/retry, cancellation, interrupted-run recovery, two-run concurrency, immutable workflow snapshots, workspace exclusions/path/symlink boundaries, strict HTTP validation, local Host/Origin restrictions, actual HTTP responses, provider stream parsing and real subprocess handling.
- Process checks cover Unicode, literal multiline arguments, explicit working directory, max effort, denied shell permissions, empty/malformed/error/truncated output, output cap, timeout and cancellation.
- All 4 browser tests passed against the real Compose service: four-step gated demo with revision/activity/files, automatic review, cancellation, workflow save/reload, provider discovery, 390px layout, and a failed workspace recovered with the Retry button.
- Docker healthcheck passed. Three installed CLIs were verified: Claude Code 2.1.277, Codex 0.155.1, OpenCode 1.18.31.

## Real provider checks

These used actual authenticated CLI processes inside Docker, not mocked responses:

- Claude / `claude-fable-5-1`: read the starter workspace and produced design criteria.
- Codex / CLI default: read README.md and returned a correct project summary after the container sandbox configuration was corrected.
- OpenCode / `deepseek/deepseek-flash`, **max**: wrote `pilot-result.json` exactly as specified and read it back. The product owner separately fetched and compared the file contents before approving.

The initial Codex attempt could not start its bubblewrap sandbox. Compose now permits inner namespace creation without privileged mode or additional capabilities. The initial OpenCode attempt used inherited `/app` context; the adapter now supplies `--dir` and `PWD` explicitly. Both original results were held for review, revised after the fixes, and only approved once the real operations succeeded.

## Complete live delivery pilot

The **Unicode slug utility** run completed all four real stages: Codex plan, Claude design, Flash implementation at max effort, and Codex review. The product owner reviewed and approved every handoff. A design revision made the seventh test mandatory and corrected documentation wording; a review revision clarified that Git history is deliberately absent from run copies.

Flash created exactly the approved utility, seven tests and README update. All seven tests passed both on the host and through `docker compose exec`. The product owner independently checked additional edge cases and 200 deterministic Unicode inputs for valid output, length and idempotence. The original source project remained unchanged. Codex's final verdict was PASS, and the run is Completed.

The reviewer's nested `node --test` invocation reported one file-level pass; direct `node slugify.test.mjs` reported all seven individual passes. Independent execution of the specified test command outside the reviewer's nested runner reported seven passes as expected. No result was accepted solely from the model's claim.

See [machine-readable pilot receipt](live-pilot-result.json) for providers, models, effort, attempts and handoff counts. Reported costs are for the final attempt only and exclude retries or providers that do not supply cost.

## Persistence and recovery results

An eight-step demo was interrupted by `docker compose restart`. After startup it was marked **Interrupted**, with no silent rerun. A separate live run's pending design approval and output survived unchanged. Explicit retry completed all eight demo steps. This is a real process/container restart, in addition to the engine unit tests.

## Review findings corrected during development

- Concurrent workspace initialization race.
- UI action endpoint/body mismatch.
- File-browser response-shape mismatch.
- Fastify response hook failing to complete actual HTTP requests.
- Workflow save confirmation disappearing immediately after parent refresh.
- Container sandbox compatibility and OpenCode working-directory propagation.
- Large Flash assignments exhausting output limits without writing files. Work was split into smaller approved assignments; truncation is now treated as failure even if the CLI exits zero.

## Scope of assurance

These checks establish a working local single-user v1. They do not establish hostile-repository isolation, multi-tenant security, unattended correctness, provider uptime, or universal model/account availability. Tests that use injected executors are identified as engine/API tests; demo browser flows do not claim to invoke providers. Live provider tests are listed separately above.

Agents share one container identity. Run folders separate edits, while approvals separate handoffs. Source changes are not automatically merged. A provider's confident response is not sufficient evidence of correctness: the live pilot includes independent file and executable-test verification.


## Jev integration (20 September 2026)

Added an Agents-page Jev evaluator and write-only API-key settings. Credentials are AES-256-GCM encrypted in the persistent server data volume; the encryption key is local in the same volume. Saved credentials override the optional environment fallback. Removing the saved key does not remove environment configuration.

Validation: 42 automated tests passed, including Jev key encryption, restart persistence, removal, corrupt-key failure, all three typed answer formats, request validation, upstream authentication/rate-limit/network/timeout failures, response-size limits, and secret-free responses. CLI child-process tests verify that TYPESAFE_API_KEY is not inherited.

The dedicated browser test passes through the real compiled frontend and API: save key, clear input, restart server, verify persistence, test connection, evaluate Noul/Choice/Score, check mobile layout, and remove key. Its remote TypeSafe endpoint is replaced by a deterministic fixture. No real Jev API key was supplied or used during this test; live authentication must be verified with Test connection after the user saves their own key.

Jev evaluations remain manual and advisory. They do not alter workflow state, approve agent handoffs, or edit files.


## Git worktrees and draft PRs (20 September 2026)

Implemented a project worktree mode, managed bare repositories, per-run branches, diff snapshots and approval-gated draft PR publishing. The original checkout stays unchanged. Interrupted setup preserves the pinned base, stale snapshots cannot publish, and retries recover an existing PR.

Validation: typecheck and production build passed; the full backend suite passed 80/80 before concurrent model-catalog edits. Targeted browser coverage passed for worktree approval/publishing/reload/mobile layout, project management, review rework and step chat. A final isolated Linux Compose container passed 27/27 Git, engine and project regression tests. Health returned 200; GitHub CLI was present. Real temporary repositories exercised parallel worktrees, recovery, tracked/untracked diffs, credential-path rejection, stale preview rejection, authentication failure, a real push to a local bare remote, and PR idempotency. GitHub API/CLI responses were simulated; no real GitHub PR was published.

Logs: artifacts/worktree-tests.log, artifacts/worktree-ui.log, artifacts/worktree-ui-final.log, artifacts/worktree-container-regression.log and artifacts/worktree-compose-build-retry.log. The intermediate Windows regression rerun encountered Linux esbuild binaries installed by the concurrently running user agent; the same targeted regressions passed in the isolated Linux container. An initial Docker export cache error succeeded on retry.

The new image is built and validated. The live platform was not restarted because run 93b9ef82-ba48-4146-9e90-15e37dbefa80 was still executing and editing this checkout. After that work is complete and reviewed, rebuild and recreate the platform to include the final combined changes. The current AgentLoom checkout has no initial commit or GitHub origin, so it needs repository setup and gh login before it can publish a real PR.


## Approved Task to Verified Delivery (20 September 2026)

Added an upgrade-safe workflow template: approved planning -> OpenCode cheap implementation at max effort -> direct validation commands plus Jev signals -> GPT-6-Astra review -> final human approval. Command contracts are snapshotted at run creation. Commands record exit codes, timing and bounded output; a source fingerprint checks freshness. Failed commands, source changes during/after validation, and Markdown BLOCKED verdicts cannot be approved. Validation histories survive repair and refresh. Jev is advisory, with one transient retry and an explicit unavailable/failed fallback.

Validation: typecheck, production build, 100/100 backend tests, and targeted browser scenarios for the evidence workflow, rework and step chat passed. Browser coverage also verified command editing with multiline arguments, persisted workflow settings, unchanged existing run contracts and mobile layout. Tests cover failures despite confident reviewer prose, repair and revalidation, stale source rejection, Jev outages, command startup failures, timeout/cancellation, bounded/redacted output and Markdown blocker variants. Docker image built successfully.

A real isolated Compose pilot used GPT-6-Astra planning/review, deepseek/deepseek-flash with max effort, actual npm commands and jev-1.13.0. The first implementation passed 10 tests but the reviewer found signed-zero behavior that violated unchanged in-range values. We returned findings to implementation. A Git baseline from the untouched disposable fixture was attached to resolve the reviewer's initial inability to verify change scope. The repaired run passed 12 tests and both syntax checks, returned real Jev signals, received an independent PASS and completed through the approval API. Test approval applied only to this disposable fixture.

Pilot id: 68efb82f-b31d-4d5c-9391-1ead7328e770. Evidence is in artifacts/evidence-workflow/live-evidence-pilot-completed.json; logs and mobile screenshot are alongside it. The first Jev request failed transiently; a diagnostic retry succeeded, and the repaired validation produced persisted signals. This pilot demonstrates the full path and a useful review catch, not general model accuracy.

Deployment completed after the user's active review finished. The main Compose service is healthy and /api/workflows contains evidence-delivery with the expected four stages and command contract. The actual localhost:4317 UI displayed all three editable validation commands without browser errors. The disposable pilot stack was stopped; copied Jev credentials were removed from its private data volume. Main credentials and user runs were preserved.

The council extension is documented separately in docs/COUNCIL_PROPOSAL.md as a proposal only.


## Outcome council candidate - 2026-09-21

- Host typecheck/build passed; 117 backend tests passed. Five targeted browser tests passed (council, streaming council, evidence workflow, rework, step chat), including 390px layout and refresh.
- Real pre-PR council reviews identified generic-revision and interrupted-review blocker-retention defects. These were reproduced and fixed with API/engine regressions, including completed initial and challenge reports, persisted streaming text/tool calls, and unresolved obligations across repair handoffs. Completed reviewers/chair are retained on retry; only unfinished work resumes.
- The rebuilt Docker Compose app is healthy at localhost:4317. Real running council cards were checked with Playwright: streamed text, two interleaved tool groups, no page errors.
- First verification runs: 80730214-ad64-44e9-bd29-c3f27fe0d469 and e36daa40-1a3a-464c-94e1-803e025c5ca6. Their blocking reports are retained. A fresh final candidate verification is required before the PR is opened.
- Jev routing experiment: 12 scenarios repeated three times (one reversed option ordering), 33/36 expected choices, zero unsafe completes and no upstream errors. All three mismatches routed stale evidence to implementation rather than clarification. These are small synthetic checks, not a production quality estimate.
- Isolated live pilot e7355812-a0ab-473d-9ee7-77040e0d1da5: Jev returned a seeded signed-zero defect to Flash, independent validation/council passed after repair, and Jev completed the disposable run after controller authority was made explicit. Initial authorization ambiguities caused conservative stops and are retained in the experiment record. A fresh uninterrupted trial is running separately.

## PR machine verification - 2026-09-21

The clean isolated Jev trial `3ad6c244-0129-4188-bb81-6039454c605e` completed without intervention: Jev started implementation, returned the seeded defect for one repair, then completed after passing recorded validation and council. Its decisions and probabilities remain in the isolated server and `artifacts/jev-routing/`.

The production controller adds explicit initial-plan authorization, a two-repair budget, conservative routing, persistent pause/resume and publication-only recovery. Final approval binds an exact Git tree; publication pushes the immutable approved commit rather than a mutable local branch. Real Git tests advance the branch immediately before push and verify that only the approved content reaches the remote. PR reconciliation verifies the remote head tree and preserves its actual commit identity.

Live reviews found and prompted fixes for stale challenge obligations, missing findings in repair prompts, streamed transcript replacement, double offset adjustment after truncation, and resolution of known prior warnings. Regressions cover those cases, hard-restart reviewer indicators and bounded repairs. The candidate at `43b85fa` passed typecheck/build, focused backend suites and four browser scenarios. A further browser test exercises the Delivery selector, plan gate, low-confidence pause, resume, automatic draft link, refresh and mobile layout; it passes. The actual isolated pilot UI was also checked at desktop and 390px with no page errors.

The real private-GitHub delivery pilot is `e03415bc-3960-4b3a-a181-e3bf42746fb1` on localhost:4319. It deliberately uses separate run/project data and no host-project mount. The first documentation report contained an overbroad credential-filter claim; Jev paused at low confidence and the coordinator manually returned the concrete correction. A focused council challenge exposed another inaccurate publication-state claim, which Jev returned automatically for repair. Report-recovery fixes and a clarification distinguishing optional warnings from blocking disputes were exercised. This is a recovery test, not an uninterrupted autonomous-success claim.

The pilot completed and automatically created draft PR [#1](https://github.com/Animii/AgentLoom/pull/1), targeting `feat/pr-machine`. All three final reports passed and the chair returned no blocking disputes. Jev selected completion at 0.70 confidence (0.80 completion probability). The run used one automatic repair, plus the documented manual recovery. GitHub confirms the PR is open and draft, with only `docs/PR_MACHINE.md` changed. Published commit `f2eb5f4a0746aff1f5cccad65f4045f14fd88193` has tree `19d0854b89ba7ae5ae38057d299f2bae21818eb4`, exactly matching the stored approved tree. The completed UI survives reload and 390px layout without page errors; full evidence is retained in the run and `artifacts/real-pr-machine-completed.json`.

Frozen candidate `fb1e988` verification: `5e62a8de-632a-4c79-a174-dd6ac2aec6fa` on localhost:4317 is completed. Typecheck, 136 backend tests, production build and five browser scenarios pass. Fresh recorded Linux validation also passes all four commands. All three independent reviewers and the chair return PASS, with no blocking disputes; optional coverage/usability warnings remain visible. Prior blocked verification runs are retained rather than overwritten. Merging is never automated.

## Single-review PR machine and five-task pilot - 2026-09-21

Candidate `a32cf08` makes PR machine the new-run default: explicit plan approval,
Flash at max effort, recorded commands and Jev signals, one structured Astra
review, bounded routing and automatic draft delivery for eligible worktrees.
Existing workflows retain their configuration. An optional Fable second opinion
preserves the original report and requires evidence to resolve disagreements.
Review clarifications survive later repairs; unresolved findings and current
validation remain mandatory.

Final typecheck and production build pass. The exact final source passed all
144 backend tests in an isolated Linux container with the normal parallel test
command (`artifacts/single-review/linux-delivery-tests.log`). An earlier Windows
run also passed 144/144. A later concurrent Windows run had short-deadline process
failures; it is retained as a failed run, not counted as passing evidence.
The former Linux model-catalog close-stdin fixture was corrected without changing
production timeouts or assertions and passed ten consecutive Linux catalog runs.

The full browser suite passed 26/26. Subsequent targeted coverage passed for the
single reviewer, council, automation, and the delayed-workflow response regression.
One publication UI timeout during concurrent backend testing passed unchanged
when run separately; its original trace remains under
`artifacts/single-review/ui-status-first/`. Jev settings browser checks passed
with a deterministic upstream fixture. Real Jev calls are separately recorded
in the live pilot.

Docker Compose was rebuilt and is healthy on localhost:4317. After the final
restart, all 190 existing run IDs, statuses and current-step positions matched
the saved pre-deployment states. The actual deployed UI selects the PR machine
and renders the live pilot at desktop and 390px width without page errors.
The delayed-loading fix preserves text entered before workflows arrive.
The temporary browser-fixture server on port 4321 was stopped.

See [five-task pilot results](PR_MACHINE_PILOT_RESULTS.md) for the real providers,
frozen source, draft PRs, manual interventions, recovery proofs and partial cost
accounting. Pilot runs use the separate localhost:4319 server and data volumes;
merging remains manual.
