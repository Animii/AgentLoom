# AgentLoom

A local workflow board for Claude Code, Codex and OpenCode. Define roles and steps, start tasks, inspect output and files, and approve or revise each handoff. Docker Compose runs the API, React UI, SQLite store and CLI adapters on your machine.

## Start

Requires Docker Desktop (Linux containers).

```sh
docker compose up -d --build --wait
```

Open **http://localhost:4317**. Choose **Try a demo** to exercise the complete workflow without provider credentials or charges. Live runs call your configured providers and may incur charges.

The three starter workflows are:

- **Review, Build and Verify:** Codex planning, Claude design, Flash implementation, Codex review. Approval follows every step.
- **Quick Review:** two read-only reviewers, automatically handed off.
- **Fix and Verify:** Flash implementation followed by Codex verification, with approval gates.

The default implementer is `deepseek/deepseek-flash` at **max** effort. Its instructions prohibit product/scope decisions and require `BLOCKED` when requirements are missing. The designer uses `claude-fable-5-1`; Codex uses its CLI default model. Model availability depends on your provider account; change models in **Workflows**.

Each step's **Model** field is a searchable list. Expanding a step loads that provider's catalog: Codex models come from the App Server `model/list` method, OpenCode models from `opencode models`, and Claude Code offers its `sonnet`, `opus` and `haiku` aliases. When discovery fails or is unavailable, the built-in suggestions (`gpt-5.6-sol` for Codex, `opencode/gpt-5.1-codex` for OpenCode) remain selectable, and you can always type a custom identifier, keep **CLI default**, or use **Refresh models**. Catalog membership does not guarantee account access.

## Connect providers

The **Agents** page checks installed CLI versions. It deliberately does not equate installation with authentication. Log in inside the container:

```sh
docker compose exec platform claude auth login
docker compose exec platform codex login --device-auth
docker compose exec platform opencode auth login
```

Credentials persist in the `agent_home` Docker volume. Alternatively copy `.env.example` to `.env`, fill the provider keys you use, and recreate the service with `docker compose up -d`. Never commit `.env` or credential files. `OPENAI_API_KEY` is mapped to the Codex child process's `CODEX_API_KEY`. OpenCode can use its stored provider login or `DEEPSEEK_API_KEY`.

Existing CLI credential files can be copied into their corresponding container locations with `docker compose cp`; use only your own credentials and keep file permissions private. The platform does not expose a credential-reading API.

Provider calls send task context and relevant project content to those providers. Run history, files and credentials are stored locally.

## Jev settings and evaluations

Open **Agents → Jev (TypeSafe)**. Paste your TypeSafe API key into **Jev API key**, then choose **Save API key**. The field clears after saving. **Test connection** sends a small sample to TypeSafe and verifies a real response; saving alone does not verify authentication. **Remove saved key** deletes the stored credential.

The key is encrypted with AES-256-GCM under `/data/secrets` and persists in the Compose `data` volume. Its local encryption key is in the same volume, so this is not protection against someone who controls the host or that volume. The server returns configuration status only, never the saved key. Do not back up or share the secrets folder publicly. Optional `TYPESAFE_API_KEY` in `.env` is used when no saved key exists; removing a saved key does not erase this environment fallback. Jev credentials are not inherited by the CLI agents.

Use **Evaluate with Jev** for a Choice, Score, or Noul probability question. The default model is `jev-latest`. Evaluations send the supplied text and question to TypeSafe and may incur usage. Results are advisory: this panel does not approve handoffs, edit files, or make workflow/product decisions. Jev is an API evaluator, not an additional coding CLI.

The request/response integration follows the [TypeSafe API reference](https://docs.typesafe.ai/api). `npm run test:jev-ui` verifies key save/removal, persistence through a server restart, all three evaluation types, and mobile layout using a deterministic upstream fixture. A real account connection is verified by the **Test connection** button after you provide your key.

## Working with projects and runs

Open **Projects → Connect folder** to browse a real host folder and register it. Connected projects default to **Work directly in folder**. Choose **Use isolated copies** for a separate working copy per run. The Projects page shows paths, availability, mode and history, and supports renaming, archiving/restoring and disconnecting/reconnecting without deleting files. **Import a copy** remains available for browser uploads.

Direct runs execute in the registered source folder, so implementation edits appear in your editor immediately. Planning remains read-only. Isolated runs copy source into `workspaces/runs/<run-id>/`; those changes must be copied or merged back manually. Each run records its folder and mode at creation. The **Files** tab of a direct run shows current folder contents, not a historical snapshot. `.git`, `node_modules`, common credential/config data folders and `.env` files are excluded from snapshots; `.env.example` is allowed. This is not a general secret scanner: keep confidential material out of projects supplied to agents.

An approval gate pauses **after** a step produces output and before the next agent starts. **Request revision** reruns the same step with feedback and its previous output. **Approve and continue** accepts the current result. **Cancel** stops the owned process. Failures require **Retry step**; the service never silently retries or auto-approves. A leading `BLOCKED` response requires revision instead of approval.

Workflow edits affect new runs only. Running tasks retain their original definition. Two runs may execute concurrently. After a service restart, active/queued tasks become **Interrupted** and require review and an explicit retry; pending approvals remain pending. A retry continues in the run's recorded workspace, so inspect partial changes first. Live direct runs reserve their folder across approval gates; overlapping live runs are rejected. Finish or cancel active runs before changing project access or archiving/disconnecting.

Demo runs are explicitly labeled and do not execute CLIs or make file changes.

## Runtime boundaries

This is a **trusted, single-user local platform**, not a multi-tenant service. Compose publishes only to `127.0.0.1`; the API also validates Host/Origin, rejects unknown request fields, and restricts file browsing to run directories. Do not expose it through a public reverse proxy without adding authentication and stronger isolation.

Agents run as the non-root `node` user. Claude and OpenCode receive file tools with shell/subagent access disabled. Codex uses its `read-only` or `workspace-write` sandbox and never automatically approves escalation. Compose relaxes the outer seccomp/AppArmor profiles so Codex can construct its inner bubblewrap sandbox; it does not use privileged mode or add Linux capabilities. On hosts that forbid unprivileged user namespaces, Codex may still need host configuration.

Run copies are separate folders, not separate OS/container identities. The agents share a container user, runtime and credential volume. Do not use this v1 for adversarial repositories, mutually untrusted users, or strict per-agent data isolation. Approval gates control handoffs; they cannot undo an already executed step or prove its claims. Review the output and tests before approving.

CLI processes use argument arrays without a shell, a ten-minute default timeout, an output cap, and owned-process cancellation. Nonzero exits, malformed streams, empty output and reported output-length truncation fail the step. Provider-reported cost is shown where supplied; missing cost is not zero.

## Development and verification

Requires Node 24 and npm. From this directory:

```sh
npm ci
npm run typecheck
npm test
npm run build
npm start
```

For hot reload run `npm run dev` and `npm run dev:web` in separate terminals; Vite uses port 5173 and proxies the API to 4317. Stop the Compose service first if using the same API port.

Browser end-to-end tests target the running Compose service:

```sh
npx playwright install chromium
npm run test:ui
```

`E2E_BASE_URL` overrides the target URL. These tests create clearly named demo runs and edit a workflow description. The recovery browser test also creates a temporary project in `E2E_WORKSPACE_ROOT` (default `workspaces`), which must match the server's mounted workspace. Run them on a development instance. `node scripts/live-smoke.mjs` additionally creates three real provider tasks, including a small file write by Flash, and leaves their results for review; it requires authentication and incurs normal usage. An exit-zero CLI or waiting approval alone does not establish task correctness: inspect its output and files.

`node scripts/start-pilot.mjs` starts the four-stage live slug-utility pilot and leaves each handoff for manual review. `node scripts/check-restart.mjs <waiting-run-id>` tests restart recovery and approval persistence by restarting the entire Compose service; use only when other work may safely be interrupted.

`docker compose logs -f platform` shows server logs. `docker compose restart` preserves history and credentials. `docker compose down` preserves volumes; `docker compose down -v` deletes history and credentials.

See [validation report](docs/VALIDATION.md) for the actual acceptance results and limitations.

## Interface

AgentLoom uses one simple interface: a searchable run list, a dedicated review page, and expandable workflow and provider settings. The global **New run** button starts a task. **Needs attention** finds approvals, blocked steps and failed or interrupted runs. Open a run to read the output, inspect files and approve or request a revision. Approval controls follow the output and explain what happens next.

The run overview groups attention items first, then in-progress work, then completed and cancelled history. Each row shows its current step and agent, completed-step progress, status and last update. Search, project and live/demo filters apply across the groups and are preserved when returning from a run. Each group initially shows eight rows with a **Show more** control. Failed and interrupted runs stay in **Needs attention**, rather than being buried in finished history. Progress counts completed steps; it does not estimate elapsed work or treat pending approval as completion.

Technical step details and Jev settings expand when needed. Workflow drafts survive switching primary pages. On mobile, selecting a run opens its review page directly; Back to runs restores the search and filter.

The earlier three-design comparison has been retired. Historical rationales remain in `docs/designs`. See [UX review](docs/UX-REVIEW.md) for findings and changes. `tests/ui/ux.spec.ts` checks the simplified interactions alongside the platform regression suite.

## Adapter documentation

- [Codex non-interactive execution](https://developers.openai.com/codex/noninteractive)
- [Codex sandboxing](https://developers.openai.com/codex/security)
- [Claude Code headless usage](https://code.claude.com/docs/en/headless)
- [OpenCode CLI](https://opencode.ai/docs/cli/)
- [OpenCode permissions](https://opencode.ai/docs/permissions/)

### Planning conversations

The Plan step supports a saved conversation. The planner asks questions, you reply in **Message the planner**, and the agent proposes an updated plan. You can keep clarifying a proposed plan before selecting **Approve plan and continue**. Only that approval starts the next step. Runs needing an answer appear under **Needs attention** with **Your reply needed**.

Enable **Planning conversation** on any workflow step to use this behavior with Claude Code, Codex or OpenCode. Planning always uses read-only access and requires approval. Existing default Plan steps also support chat. Every turn replays the saved chronological conversation, including after a server restart; it does not depend on provider session resumption. Failed replies require an explicit retry and retain accepted messages. Approved conversations remain readable in the run.

The planner reports `PLAN_QUESTIONS` or `PLAN_READY` on a final standalone line; missing markers keep the run waiting for input. These markers never approve a plan. Messages are limited to 8,000 characters; conversations to 80 messages / 80,000 serialized characters and full planning prompts to 120,000 characters. Oversized context is rejected rather than silently dropping earlier answers. The proposed plan carries the agreed requirements to downstream agents.

### Live replies and the ask tool

Chat and run output use Streamdown for Markdown, including tables, lists, code blocks and unfinished streamed formatting. Wide tables scroll horizontally inside the message. Semantic components use the app's own CSS. Provider HTML remains inert; links and images remain text rather than loading external resources.

Planner MCP project tools appear in the conversation as expandable calls with their state, requested path/query and a bounded result summary. These calls are saved per turn and survive reload. Older project-tool log entries also appear when available, without arguments that were not recorded. Raw file contents and MCP connection URLs are not copied into these tool cards. Native Codex, Claude Code and OpenCode tool events also appear as expandable cards in Output for implementation, design and review steps, with arguments and completion/error summaries. Raw tool result bodies remain out of the cards. Saved Activity JSON can recover older calls; truncated completions are labeled result unavailable. Other provider diagnostics remain in Activity.

Open runs receive server-sent updates, with polling as a fallback and a fresh saved snapshot after reconnecting. Claude emits partial text through `--include-partial-messages`; Codex and OpenCode CLI adapters show each text event as their CLIs emit it (which can be complete message blocks). The chat smooths text already received with a short adaptive display buffer; completion and reduced-motion preferences show the exact text immediately. Replies keep the same message element when completed. Text preceding an ask-tool question is retained in the conversation.

The composer stays beneath the scrollable conversation. You can draft while the agent replies; sending waits until the reply is complete. **Enter** sends, **Shift + Enter** inserts a new line. The conversation follows new text while you are at the bottom. Scrolling up pauses following; **Jump to latest** resumes it. This improves display continuity but cannot make a CLI deliver text before it emits an event.

Planning agents have a real `agentloom.ask_user` MCP tool with 1-3 questions and optional 2-4 choices per question. A panel above the composer shows one question at a time, with option descriptions, recommendations, custom answers and optional multiple selections. Single-choice answers advance automatically; multiple selections use **Next question**. Use **Back** to edit, then **Submit answers** to send the complete batch. Number keys select options while focused in the question panel, except while typing. Draft answers survive reload in the same browser tab; failed submissions retain them. **Reply in chat instead** allows a clarification or change of direction. The tool saves the questions, acknowledges that no answer is available yet, and tells the agent to end its turn. The user's answer starts the next turn with the saved conversation. An outstanding question always blocks plan approval, even if the agent emits `PLAN_READY`. Saved questions survive provider failure and server restart.

The MCP endpoint is private to one planning turn, bound to loopback with an unguessable path, rejects browser origins and closes when the provider exits. It exposes `ask_user` plus `list_project_files`, `read_project_file` and `search_project` for read-only inspection of the run's selected workspace. Direct runs read the connected folder; isolated runs read their copy. Listings are paginated, reads include line numbers (up to 1 MB per file), and literal searches return bounded excerpts. The file tools reject paths outside the project, symlinks and excluded credential/config folders. They cannot approve runs, execute commands or change files. Claude, Codex and OpenCode planning configurations explicitly enable these tools. Question panels expand with their contents; long questions use page scrolling rather than a clipped, independently scrolling widget.

Configuration references: [Codex MCP](https://developers.openai.com/codex/mcp), [Claude MCP](https://code.claude.com/docs/en/mcp), [OpenCode MCP](https://opencode.ai/docs/mcp-servers/), [MCP HTTP transport](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports).

### Add a project from a folder

In **Projects** or **New run**, choose **Import a copy**, then **Choose folder**. The system folder picker can select a folder anywhere on your computer; no extra Docker mounts are needed. Review the suggested project name and file count, then select **Create project**. The project is imported and selected automatically, and the task draft is preserved.

This imports a copy into `workspaces/projects/<project-name>`; it is not a live link to the original folder. Imported projects default to isolated copies. Files under `.git`, `node_modules`, `.auth`, `.data`, and `.env` files are excluded; `.env.example` is retained. Imports support non-empty folders, at most 10,000 files/folders, 100 MB total and 10 MB per file. Empty subfolders and file permissions are not transferred by the browser picker. Existing project names are never overwritten.

Uploads are staged with progress and cancellation. A project becomes available after all files arrive. Cancellation waits for the current file and removes the staged import. Inactive sessions expire after an hour; abandoned staging folders from a restart are removed after 24 hours when another import begins. Folder selection uses the browser directory picker, supported by current Chrome and Edge.

### Connected host folders in Docker

`PROJECTS_FOLDER` in `.env` selects the host parent directory for the folder browser. Compose mounts it read/write at `/host-projects`; the default is `..`, the directory containing AgentLoom. This installation is configured to `C:/Users/jonat/OneDrive/Documents/Projects`. Set another parent path and run `docker compose up -d` to change it. The browser accepts relative paths or full host paths within that directory. Direct connections do not upload or copy source files and are not subject to the import size limits.

Only real directories within that mount can be connected; shortcuts, symlinks and traversal outside it are rejected. Disconnect preserves files and output history but revokes the file browser for past direct runs. Isolated run snapshots remain inspectable. Archived/disconnected/unavailable projects cannot start new runs. Existing imported projects are registered automatically and retain isolated mode; disconnect records are kept so they do not reappear automatically. Project settings are stored in the existing SQLite data volume.

### Bookmarkable navigation

The URL preserves the selected run, historical step, detail tab, open file, activity scope, run filters, project selection and workflow selection. Refreshing or opening the URL in another tab restores that view; browser Back and Forward navigate between selections. Search text updates the current history entry. Chat drafts, credentials and unsaved workflow edits are not included in URLs.

### Resolve review findings

On a blocked review or a review waiting for approval, **Send to implementer** returns the findings to the nearest completed writable step. It reuses the run workspace, repeats the intervening validation/review steps, preserves existing approval gates, and always requires approval of the fresh review. Earlier outputs remain expandable under **Previous attempt** and survive refresh and restart. This is an explicit handoff, not an automatic repair loop. The implementer must stay within approved scope and report BLOCKED when a decision is needed. Read-only workflows without a prior implementation do not offer this action. **Request revision** still reruns the current step to clarify or reconsider its output.


### Shell and Docker access

Agents have full shell execution inside the Linux runner: Claude exposes Bash with permission checks bypassed, Codex uses danger-full-access with no approval prompts, and OpenCode allows Bash and external directory access. Workflow access labels describe source-editing responsibilities, not a shell sandbox. Planning and review must preserve source; installing dependencies and generating validation artifacts are allowed. The current user-authorized execution policy also applies to saved runs and supersedes older shell/install prohibitions in their prompts. Scope decisions and workflow approvals still belong to the user.

The runner includes Docker CLI and Compose and connects to Docker Desktop through `/var/run/docker.sock`. This grants control over the host Docker daemon. Test stacks must use distinct project names/ports and must not replace the active platform. Docker bind paths refer to the daemon host; use the platform container mount mappings to resolve run workspace paths. Agent processes receive `AGENTLOOM_PLATFORM_CONTAINER` and `AGENTLOOM_WORKSPACE` for this purpose. Development dependencies are not suppressed by the platform's production NODE_ENV. Windows host PowerShell is not provided by the Linux container.

### Chat on every step

Plan, design, implementation and review each have a chat composer. Enter sends; Shift+Enter inserts a newline. Messages are saved with the step, and drafts survive refresh in the same browser tab. You can draft during execution and send when the agent stops. Follow-up replies always wait for approval. Sending to an earlier completed step reopens it and invalidates downstream results and approvals; prior downstream conversations and outputs remain in attempt history. Steps that have not started cannot accept messages yet. Model, effort and execution access are displayed in the composer.


### Agent time limits

`CLI_TIMEOUT_MS` controls the total runtime per agent turn (default `3600000`, one hour; maximum 24 hours). `CLI_IDLE_TIMEOUT_MS` separately detects a provider that produces no output while no tool is running (default `600000`, ten minutes; `0` disables idle detection). Output resets the idle timer. Reported running tools suspend it, so quiet builds can continue up to the total runtime limit. Set these values in `.env` and recreate the Compose service to apply them. Failed runs require an explicit retry; workspace changes remain available.


### Jev review advice

When a live review finishes, Jev uses the configured TypeSafe key to classify the task and review text as a code fix, missing requirement, environment blocker, mixed blockers, no blocker, or unclear. No workspace files are uploaded. Results are saved with the review, display confidence, and never approve, advance or restart work. Confidence below 60% is shown as needing clarification. Missing credentials and upstream errors leave the workflow usable; the review panel offers a manual retry. Demo runs do not trigger automatic evaluations.

For environment or requirement issues, **Draft follow-up** prepares an editable step-chat message without sending it. Code-fix advice points to the existing explicit **Send to implementer** handoff. Older reviews can be classified with **Classify with Jev**. Late responses are ignored if the attempt or output has changed.

When Jev is uncertain (classification confidence below 60%, or an unclear classification), approval requires explicitly checking the acknowledgment beside the approval button. The server requires an acknowledgment tied to that assessment; stale acknowledgments are rejected. Reclassification or refresh clears the checkbox. Approval records the acknowledgment in Activity. Approval also waits for an in-progress assessment to finish. Classification confidence does not measure code correctness.


### Git worktrees and draft pull requests

In **Projects**, choose **Git worktree (branch per run)**. The source must be the repository root, with an initial commit, a checked-out branch and no uncommitted changes. Each new run starts from the current committed HEAD on `agentloom/<run-id>`. Existing runs retain their original workspace mode.

AgentLoom keeps a managed bare Git repository in its data volume and creates real worktrees under `workspaces/runs`. This leaves the original checkout and its Git metadata unchanged and supports concurrent runs. Worktrees and branches remain available after failures and completion; they are not automatically deleted. Git commands for these worktrees run inside the platform container because their metadata paths belong to that environment.

For PRs, configure a GitHub `origin` on the source before starting the run and sign in once:

```powershell
docker compose exec platform gh auth login --hostname github.com --git-protocol https --web
```

After every workflow step is approved, expand **Branch / Diff and draft PR**, inspect the patch, edit the title and description, and choose **Create draft PR**. The platform snapshots and commits the previewed files, pushes only the run branch, and creates a draft against the source branch. It never force-pushes or merges. Changed files invalidate an old preview; refresh it before publishing. Potential credential filenames are rejected. Authentication failures can be retried, and a previously created PR is recovered without creating a duplicate. The PR link is saved with the run. Published runs require a new run for follow-up implementation.

Direct-folder and isolated-copy runs cannot publish through this action. A GitHub remote and authentication are only required for publishing, not for local worktree runs.


### Approved Task to Verified Delivery

Select this workflow for: approved task -> cheap implementation -> recorded validation and Jev signals -> strong review -> human approval. Codex GPT-6-Astra handles planning and review; OpenCode uses deepseek/deepseek-flash with max effort for implementation. Models remain editable under Workflows.

Before creating a run, expand **Tests and Jev signals** in Workflows and configure the exact validation programs, arguments (one per line), and time limits. The defaults are npm run typecheck, npm test and npm run build, suitable for this project. Other repositories need their own commands. The run snapshots the commands; the planning agent presents them for approval. Commands execute directly, without interpreting shell operators. A validation step runs commands itself, never asks the coding model to report whether they passed.

Each attempt records exit codes, bounded output, start/end times, source fingerprints and Jev signals. Expand the validation step or **Validation evidence and Jev signals** under the review to inspect them. Jev receives bounded task, approved-plan, implementation-report and command-output excerpts, not source files. Its probabilities are advisory. A transient Jev failure is retried once; missing credentials or a continuing failure are shown explicitly to the reviewer.

Failed or timed-out commands and source changes during validation prevent final approval, even if the reviewer claims success. The approval API rechecks the source fingerprint. Review blockers, including Markdown-formatted BLOCKED verdicts, also prevent approval. Send findings to the implementer to repair, rerun validation and obtain a fresh review. Prior evidence remains in attempt history. Re-running validation through its chat repeats the same approved commands; changing the command contract requires a new run.

Fingerprints cover up to 20,000 files / 100 MB and reject source symlinks. Git metadata, dependencies, standard build/cache/coverage/report directories, artifacts, and local .env secrets are excluded. Fingerprints establish freshness within that scope; test coverage and correctness still require review. Output is limited to the last 64,000 characters per command and is marked when truncated.


## Outcome council (opt-in)

Choose **Approved Task with Outcome Council** under Workflows. This preserves the approved-task / cheap-implementer / recorded-tests-and-Jev pipeline and replaces the final review with three independent reviewers followed by a product-owner chair. Configure each reviewer provider/model/effort and focus in the council step; the step's main model is the chair. Defaults use Codex GPT-6-Astra for correctness, adversarial verification and chair, and Claude Fable 5.1 for product/UX. The same configured implementer model cannot grade its own work.

A run-start file-hash manifest records added, modified and deleted source paths for scope review. Completed reports survive interruption; retry only resumes unfinished members and retains a completed chair. Unresolved blocker IDs also carry through repair handoffs until a reviewer retains or explicitly resolves them. Each first-pass reviewer receives a separate source copy made from the same in-memory snapshot, with the same task, approved outputs, recorded commands/results and Jev signals. First-pass reports are hidden from peers. Reports carry criterion IDs, evidence references and findings; malformed, failed or missing reports never count as passes. The chair identifies disputes but cannot outvote a blocker. Jev signals are advisory and have no approval vote.

The quiet Council panel streams each expanded member and the chair, with tool groups separated by response text. It shows statuses, exact-duplicate finding groups and expandable evidence. **Request evidence** runs one focused challenge on the same revision. Reviewers must retain their own prior blockers or explicitly cite counter-evidence for resolving them. Initial reports remain visible. Remaining blockers/disputes require a repair or clarified new run. **Send to implementer** repeats implementation, validation and a fresh council round, preserving history. Final approval requires all checks and council reports to pass against current source and evidence.

Source fingerprints share the recorded-validation exclusions (dependencies, build outputs, runtime data, credentials in .env files). Snapshot limits are 20,000 files / 100 MB; evidence bundles are limited to 240,000 characters. Each council copy excludes Git metadata and dependencies; reviewers rely on the approved scope and supplied evidence and may run focused probes. This is not a Git-diff security audit. Source copies are retained under the data directory's council/run-id folder. Full-shell providers remain trusted processes: these copies and read-only instructions are not a security sandbox. Mutation of a reviewer's source copy invalidates its report; mutation of the run source invalidates approval. Evidence references and resolutions are model claims that the chair and user must inspect, not executable proof.

Automatic repair routing and work-package/model/skill selection are a separate [research proposal](docs/WORK_PACKAGES_PROPOSAL.md), not enabled by the council.
