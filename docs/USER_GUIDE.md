# AgentLoom user guide

Operating reference for AgentLoom. The [README](../README.md) has the overview,
quickstart and architecture; [Development](DEVELOPMENT.md) covers checks, tests
and the Docker validation stack.

- [Runs and demo mode](#runs-and-demo-mode)
- [Built-in workflows](#built-in-workflows)
- [Models and providers](#models-and-providers)
- [Projects and workspaces](#projects-and-workspaces)
- [Approval gates, revisions and retries](#approval-gates-revisions-and-retries)
- [Planning conversations and the ask tool](#planning-conversations-and-the-ask-tool)
- [Live output and chat on every step](#live-output-and-chat-on-every-step)
- [Resolve review findings](#resolve-review-findings)
- [Git worktrees and draft pull requests](#git-worktrees-and-draft-pull-requests)
- [Approved task to verified delivery](#approved-task-to-verified-delivery)
- [Outcome council (opt-in)](#outcome-council-opt-in)
- [PR machine (opt-in)](#pr-machine-opt-in)
- [Jev settings, evaluations and review advice](#jev-settings-evaluations-and-review-advice)
- [MCP endpoint reference](#mcp-endpoint-reference)
- [Agent time limits and output caps](#agent-time-limits-and-output-caps)
- [Runtime boundaries](#runtime-boundaries)
- [Interface and navigation](#interface-and-navigation)
- [Adapter documentation](#adapter-documentation)

## Runs and demo mode

Open **New run** (or **New crate** on the Crates page), describe the task, pick a
project and workflow, and choose a **Mode**:

- **Live** runs execute the configured agent CLIs and may incur provider charges.
- **Demo** runs are explicitly labelled, simulate every agent (the demo planner
  even asks clarifying questions), and never execute CLIs or change files. Use
  them to try the complete approval flow without credentials.

Two runs execute concurrently; further runs wait in the queue. Workflow edits
affect new runs only: a run keeps the workflow snapshot it was created with.

## Built-in workflows

`*` marks a step with an approval gate. Every model, effort level, role and gate
is editable under **Workflows**.

| Workflow                           | Steps                                                                                  |
| ---------------------------------- | -------------------------------------------------------------------------------------- |
| Review, Build and Verify           | Plan\* (Codex) → Design\* (Claude) → Implement\* (OpenCode) → Review\* (Codex)         |
| Quick Review                       | Inspect (Codex) → Review (Claude), read-only, automatic handoff                        |
| Fix and Verify                     | Implement\* (OpenCode) → Verify\* (Codex)                                              |
| Approved Task to Verified Delivery | Approve task\* → Implement → Tests and Jev signals → Strong review\*                   |
| Crate delivery                     | Approve task\* → Implement → Tests and Jev signals → Strong review\* (plus triage)     |
| Approved Task with Outcome Council | Approve task\* → Implement → Tests and Jev signals → Outcome council\*                 |
| PR machine                         | Approve task\* → Implement → Tests and Jev signals → Independent review\* (Jev-routed) |

The default implementer is `deepseek/deepseek-flash` through OpenCode at **max**
effort. Its instructions prohibit product/scope decisions and require `BLOCKED`
when requirements are missing. The designer uses `claude-fable-5-1`; Codex uses
its CLI default model in the starter workflows and `gpt-6-astra` in the delivery
workflows. Model availability depends on your provider account.

## Models and providers

Each step's **Model** field is a searchable list. Expanding a step loads that
provider's catalog: Codex models come from the App Server `model/list` method,
OpenCode models from `opencode models`, and Claude Code offers its `sonnet`,
`opus` and `haiku` aliases. When discovery fails or is unavailable, the built-in
suggestions (`gpt-5.6-sol` for Codex, `opencode/gpt-5.1-codex` for OpenCode)
remain selectable, and you can always type a custom identifier, keep **CLI
default**, or use **Refresh models**. Catalog membership does not guarantee
account access.

### Connect providers

The **Agents** page checks installed CLI versions. It deliberately does not
equate installation with authentication. Log in inside the container:

```sh
docker compose exec platform claude auth login
docker compose exec platform codex login --device-auth
docker compose exec platform opencode auth login
```

Credentials persist in the `agent_home` Docker volume. Alternatively copy
`.env.example` to `.env`, fill the provider keys you use, and recreate the
service with `docker compose up -d`. Never commit `.env` or credential files.
`OPENAI_API_KEY` is mapped to the Codex child process's `CODEX_API_KEY`.
OpenCode can use its stored provider login or `DEEPSEEK_API_KEY`.

Existing CLI credential files can be copied into their corresponding container
locations with `docker compose cp`; use only your own credentials and keep file
permissions private. The platform does not expose a credential-reading API.

Provider calls send task context and relevant project content to those
providers. Run history, files and credentials are stored locally.

## Projects and workspaces

Each run records its project folder and workspace mode at creation.

| Mode                          | Where agents work                         | Notes                                                                   |
| ----------------------------- | ----------------------------------------- | ----------------------------------------------------------------------- |
| Work directly in folder       | The registered source folder              | Edits appear in your editor immediately. Default for connected folders. |
| Use isolated copies           | `workspaces/runs/<run-id>/`               | Changes must be copied or merged back manually. Default for imports.    |
| Git worktree (branch per run) | A worktree on branch `agentloom/<run-id>` | Required for draft PRs and the PR machine. See below.                   |

### Connect a host folder

Open **Projects → Connect folder** to browse a real host folder and register it.
The Projects page shows paths, availability, mode and history, and supports
renaming, archiving/restoring and disconnecting/reconnecting without deleting
files.

In Docker, `PROJECTS_FOLDER` in `.env` selects the host parent directory for the
folder browser. Compose mounts it read/write at `/host-projects`; the default is
`..`, the directory containing AgentLoom. Set another parent path and run
`docker compose up -d` to change it. The browser accepts relative paths or full
host paths within that directory. Direct connections do not upload or copy
source files and are not subject to the import size limits.

Only real directories within that mount can be connected; shortcuts, symlinks
and traversal outside it are rejected. Disconnect preserves files and output
history but revokes the file browser for past direct runs. Isolated run
snapshots remain inspectable. Archived/disconnected/unavailable projects cannot
start new runs. Existing imported projects are registered automatically and
retain isolated mode; disconnect records are kept so they do not reappear
automatically. Project settings are stored in the SQLite data volume.

Planning remains read-only in every mode. The **Files** tab of a direct run
shows current folder contents, not a historical snapshot. `.git`,
`node_modules`, common credential/config data folders and `.env` files are
excluded from snapshots; `.env.example` is allowed. This is not a general secret
scanner: keep confidential material out of projects supplied to agents.

Live direct runs reserve their folder across approval gates; overlapping live
runs are rejected. Finish or cancel active runs before changing project access
or archiving/disconnecting.

### Import a copy from the browser

In **Projects** or **New run**, choose **Import a copy**, then **Choose
folder**. The system folder picker can select a folder anywhere on your
computer; no extra Docker mounts are needed. Review the suggested project name
and file count, then select **Create project**. The project is imported and
selected automatically, and the task draft is preserved.

This imports a copy into `workspaces/projects/<project-name>`; it is not a live
link to the original folder. Files under `.git`, `node_modules`, `.auth`,
`.data`, and `.env` files are excluded; `.env.example` is retained. Imports
support non-empty folders, at most 10,000 files/folders, 100 MB total and 10 MB
per file. Empty subfolders and file permissions are not transferred by the
browser picker. Existing project names are never overwritten.

Uploads are staged with progress and cancellation. A project becomes available
after all files arrive. Cancellation waits for the current file and removes the
staged import. Inactive sessions expire after an hour; abandoned staging folders
from a restart are removed after 24 hours when another import begins. Folder
selection uses the browser directory picker, supported by current Chrome and
Edge.

## Approval gates, revisions and retries

An approval gate pauses **after** a step produces output and before the next
agent starts.

- **Approve and continue** accepts the current result and queues the next step.
- **Request revision** reruns the same step with your feedback and its previous
  output.
- **Cancel** stops the owned process.

Failures require **Retry step**; the service never silently retries or
auto-approves. A leading `BLOCKED` response requires revision instead of
approval. The server also refuses approval while planner questions are open,
while a Jev classification is still running, while an uncertain Jev assessment
has not been acknowledged, and (on the final step) while recorded validation is
failing or its source fingerprint is stale.

After a service restart, active/queued tasks become **Interrupted** and require
review and an explicit retry; pending approvals remain pending. A retry
continues in the run's recorded workspace, so inspect partial changes first.

Approval gates control handoffs; they cannot undo an already executed step or
prove its claims. Review the output and tests before approving.

## Planning conversations and the ask tool

The Plan step supports a saved conversation. The planner asks questions, you
reply in **Message the planner**, and the agent proposes an updated plan. You
can keep clarifying a proposed plan before selecting **Approve plan and
continue**. Only that approval starts the next step. Runs needing an answer
appear under **Needs attention** with **Your reply needed**.

Enable **Planning conversation** on any workflow step to use this behavior with
Claude Code, Codex or OpenCode. Planning always uses read-only access and
requires approval. Every turn replays the saved chronological conversation,
including after a server restart; it does not depend on provider session
resumption. Failed replies require an explicit retry and retain accepted
messages. Approved conversations remain readable in the run.

The planner reports `PLAN_QUESTIONS` or `PLAN_READY` on a final standalone line;
missing markers keep the run waiting for input. These markers never approve a
plan. Messages are limited to 8,000 characters; conversations to 80 messages /
80,000 serialized characters and full planning prompts to 120,000 characters.
Oversized context is rejected rather than silently dropping earlier answers. The
proposed plan carries the agreed requirements to downstream agents.

### The ask tool

Planning agents have a real `agentloom.ask_user` MCP tool with 1-3 questions and
optional 2-4 choices per question. A panel above the composer shows one question
at a time, with option descriptions, recommendations, custom answers and
optional multiple selections. Single-choice answers advance automatically;
multiple selections use **Next question**. Use **Back** to edit, then **Submit
answers** to send the complete batch. Number keys select options while focused
in the question panel, except while typing. Draft answers survive reload in the
same browser tab; failed submissions retain them. **Reply in chat instead**
allows a clarification or change of direction. The tool saves the questions,
acknowledges that no answer is available yet, and tells the agent to end its
turn. The user's answer starts the next turn with the saved conversation. An
outstanding question always blocks plan approval, even if the agent emits
`PLAN_READY`. Saved questions survive provider failure and server restart.

This planning MCP endpoint is private to one planning turn, bound to loopback
with an unguessable path, rejects browser origins and closes when the provider
exits. It exposes `ask_user` plus `list_project_files`, `read_project_file` and
`search_project` for read-only inspection of the run's selected workspace.
Direct runs read the connected folder; isolated runs read their copy. Listings
are paginated, reads include line numbers (up to 1 MB per file), and literal
searches return bounded excerpts. The file tools reject paths outside the
project, symlinks and excluded credential/config folders. They cannot approve
runs, execute commands or change files. Claude, Codex and OpenCode planning
configurations explicitly enable these tools.

## Live output and chat on every step

Chat and run output use Streamdown for Markdown, including tables, lists, code
blocks and unfinished streamed formatting. Provider HTML remains inert; links
and images remain text rather than loading external resources.

Planner MCP project tools appear in the conversation as expandable calls with
their state, requested path/query and a bounded result summary. Native Codex,
Claude Code and OpenCode tool events also appear as expandable cards in Output
for implementation, design and review steps, with arguments and
completion/error summaries. Raw tool result bodies remain out of the cards.
Other provider diagnostics remain in Activity.

Open runs receive server-sent updates, with polling as a fallback and a fresh
saved snapshot after reconnecting. Claude emits partial text through
`--include-partial-messages`; Codex and OpenCode CLI adapters show each text
event as their CLIs emit it (which can be complete message blocks). The chat
smooths text already received with a short adaptive display buffer; completion
and reduced-motion preferences show the exact text immediately.

Plan, design, implementation and review each have a chat composer. **Enter**
sends; **Shift + Enter** inserts a newline. Messages are saved with the step, and
drafts survive refresh in the same browser tab. You can draft during execution
and send when the agent stops. Follow-up replies always wait for approval.
Sending to an earlier completed step reopens it and invalidates downstream
results and approvals; prior downstream conversations and outputs remain in
attempt history. Model, effort and execution access are displayed in the
composer.

## Resolve review findings

On a blocked review or a review waiting for approval, **Send to implementer**
returns the findings to the nearest completed writable step. It reuses the run
workspace, repeats the intervening validation/review steps, preserves existing
approval gates, and always requires approval of the fresh review. Earlier
outputs remain expandable under **Previous attempt** and survive refresh and
restart. This is an explicit handoff, not an automatic repair loop. Read-only
workflows without a prior implementation do not offer this action. **Request
revision** still reruns the current step to clarify or reconsider its output.

## Git worktrees and draft pull requests

In **Projects**, choose **Git worktree (branch per run)**. The source must be the
repository root, with an initial commit, a checked-out branch and no uncommitted
changes. Each new run starts from the current committed HEAD on
`agentloom/<run-id>`. Existing runs retain their original workspace mode.

AgentLoom keeps a managed bare Git repository in its data volume and creates
real worktrees under `workspaces/runs`. This leaves the original checkout and
its Git metadata unchanged and supports concurrent runs. Worktrees and branches
remain available after failures and completion; they are not automatically
deleted. Git commands for these worktrees run inside the platform container
because their metadata paths belong to that environment.

For PRs, configure a GitHub `origin` on the source before starting the run and
sign in once:

```sh
docker compose exec platform gh auth login --hostname github.com --git-protocol https --web
```

After every workflow step is approved, expand **Branch … · Diff and draft PR**,
inspect the patch, edit the title and description, and choose **Create draft
PR**. The platform snapshots and commits the previewed files, pushes only the
run branch, and creates a draft against the source branch. It never force-pushes
or merges. Changed files invalidate an old preview; refresh it before
publishing. Potential credential filenames are rejected. Authentication failures
can be retried, and a previously created PR is recovered without creating a
duplicate. The PR link is saved with the run.

Direct-folder and isolated-copy runs cannot publish through this action. A
GitHub remote and authentication are only required for publishing, not for
local worktree runs.

## Approved task to verified delivery

Select **Approved Task to Verified Delivery** for: approved task → cheap
implementation → recorded validation and Jev signals → strong review → human
approval.

Before creating a run, expand **Tests and Jev signals** in Workflows and
configure the exact validation programs, arguments (one per line), and time
limits. The defaults are `npm run typecheck`, `npm test` and `npm run build`;
other repositories need their own commands. The run snapshots the commands; the
planning agent presents them for approval. Commands execute directly, without
interpreting shell operators. A validation step runs commands itself; it never
asks the coding model to report whether they passed.

Each attempt records exit codes, bounded output, start/end times, source
fingerprints and Jev signals. Expand the validation step or **Validation
evidence and Jev signals** under the review to inspect them. Jev receives
bounded task, approved-plan, implementation-report and command-output excerpts,
not source files. Its probabilities are advisory.

Failed or timed-out commands and source changes during validation prevent final
approval, even if the reviewer claims success. The approval API rechecks the
source fingerprint. Review blockers, including Markdown-formatted `BLOCKED`
verdicts, also prevent approval. Send findings to the implementer to repair,
rerun validation and obtain a fresh review.

Fingerprints cover up to 20,000 files / 100 MB and reject source symlinks. Git
metadata, dependencies, standard build/cache/coverage/report directories,
artifacts, and local `.env` secrets are excluded. Output is limited to the last
64,000 characters per command and is marked when truncated.

## Outcome council (opt-in)

Choose **Approved Task with Outcome Council** under Workflows. This replaces the
final review with three independent reviewers (correctness, product/UX,
adversarial verification) followed by a product-owner chair. The same
configured implementer model cannot grade its own work.

A run-start file-hash manifest records added, modified and deleted source paths
for scope review. Each first-pass reviewer receives a separate source copy made
from the same snapshot, with the same task, approved outputs, recorded
commands/results and Jev signals. First-pass reports are hidden from peers.
Reports carry criterion IDs, evidence references and findings; malformed, failed
or missing reports never count as passes. The chair identifies disputes but
cannot outvote a blocker. Completed reports survive interruption; retry only
resumes unfinished members.

**Request evidence** runs one focused challenge on the same revision. Remaining
blockers/disputes require a repair or clarified new run. Final approval requires
all checks and council reports to pass against current source and evidence.
Full-shell providers remain trusted processes: these copies and read-only
instructions are not a security sandbox. See the [council
proposal](COUNCIL_PROPOSAL.md) for the rationale.

## PR machine (opt-in)

For a live Git-worktree project using an approved-plan workflow with a final
structured review, choose **PR machine · automatic draft PR** under **Delivery**
when creating the run. Review and approve the initial plan. That approval
authorizes Jev to route up to two in-scope repairs and complete the run when
current validation and review evidence pass. Existing runs and the default
delivery choice retain manual approval gates. See [PR machine with independent
review](SINGLE_REVIEW_PR_MACHINE.md).

The PR-machine panel shows policy, repair count and recorded routing decisions.
Low confidence, missing evidence or a product decision pauses automation.
**Pause automation** lets current work finish without applying the next
decision. Manual messages and run actions take control; **Resume automation**
restores routing when the run is ready. A server restart pauses automation and
preserves run history.

Routing receives recorded validation status and the last 500 characters of
passing command output, or 2,000 for failed commands. Evidence exceeding the
30,000-character routing budget pauses for manual review rather than silently
dropping criteria or reports. Final approval binds the exact Git tree; changed
files must be revalidated and approved. Publication creates a draft on the run's
dedicated branch and never merges it.

Crates (split/join, PR feedback polling) are described in [Crates](CRATES.md).
Work-package routing remains a [research proposal](WORK_PACKAGES_PROPOSAL.md).

## Jev settings, evaluations and review advice

Jev is an optional evaluator reached through the TypeSafe API. It is not an
additional coding CLI, and it never approves, advances or restarts work.

Open **Agents → Jev (TypeSafe)**. Paste your API key into **Jev API key**, then
choose **Save API key**. **Test connection** sends a small sample and verifies a
real response; saving alone does not verify authentication. **Remove saved key**
deletes the stored credential.

The key is encrypted with AES-256-GCM under `/data/secrets` and persists in the
Compose `data` volume. Its local encryption key is in the same volume, so this is
not protection against someone who controls the host or that volume. The server
returns configuration status only, never the saved key. Optional
`TYPESAFE_API_KEY` in `.env` is used when no saved key exists. Jev credentials
are not inherited by the CLI agents.

**Try an evaluation** answers a Choice, Score, or Noul probability question
(default model `jev-latest`). When a live review finishes, Jev classifies the
task and review text as a code fix, missing requirement, environment blocker,
mixed blockers, no blocker, or unclear. No workspace files are uploaded. When
Jev is uncertain (confidence below 60%, or an unclear classification), approval
requires explicitly checking the acknowledgment beside the approval button; the
server rejects stale acknowledgments. Classification confidence does not measure
code correctness. Demo runs do not trigger automatic evaluations.

`npm run test:jev-ui` verifies key save/removal, persistence through a server
restart, all three evaluation types, and mobile layout using a deterministic
upstream fixture.

## MCP endpoint reference

AgentLoom serves an MCP endpoint at `http://127.0.0.1:4317/mcp` (Streamable
HTTP). Tools are prefixed `agentloom_`:

| Area      | Tools                                                                                                                                                                        |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflows | `list_workflows`, `save_workflow`, `list_providers`                                                                                                                          |
| Projects  | `list_projects`, `browse_project_folders`, `connect_project`, `update_project`                                                                                               |
| Runs      | `search_runs`, `get_run`, `start_run`, `respond_to_run` (approve, revise, reply, rework, revalidate, second opinion, retry, automation pause/resume, reassess), `cancel_run` |
| Results   | `list_run_files`, `read_run_file`, `get_run_diff`, `publish_pull_request`                                                                                                    |

Each tool calls the same HTTP API as the web UI in-process, so validation,
approval rules and state checks are identical. A manual action on an automated
run pauses its automation, as in the UI. Publishing requires the
`preview_token` from `get_run_diff`, so the pull request contains exactly the
previewed files. Responses are concise by default and bounded (outputs, diffs,
file reads and event lists are truncated with guidance on narrowing). Tools
carry read-only/destructive annotations so clients can ask before cancelling
runs, overwriting workflows or disconnecting projects. Jev settings and browser
folder imports are not exposed.

The endpoint has the same boundary as the rest of the API: loopback-only,
Host/Origin validated, no authentication. Anything that can reach it can act as
you. Step output returned by the tools is agent-generated text; clients should
treat it as data.

Configuration references: [Codex MCP](https://developers.openai.com/codex/mcp),
[Claude MCP](https://code.claude.com/docs/en/mcp),
[OpenCode MCP](https://opencode.ai/docs/mcp-servers/),
[MCP HTTP transport](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports).

## Agent time limits and output caps

`CLI_TIMEOUT_MS` controls the total runtime per agent turn (default `3600000`,
one hour; maximum 24 hours). `CLI_IDLE_TIMEOUT_MS` separately detects a provider
that produces no output while no tool is running (default `600000`, ten minutes;
`0` disables idle detection). Output resets the idle timer. Reported running
tools suspend it, so quiet builds can continue up to the total runtime limit.

`MAX_OUTPUT_BYTES` caps the captured bytes per agent process: both Compose and
the server default to `2097152` (2 MiB); keep it finite. Larger tasks can opt
into a higher cap such as `8388608` (8 MiB). Set these values in `.env` and
recreate the Compose service to apply them. Failed runs require an explicit
retry; workspace changes remain available.

## Runtime boundaries

This is a **trusted, single-user local platform**, not a multi-tenant service.
Compose publishes only to `127.0.0.1`; the API also validates Host/Origin,
rejects unknown request fields, and restricts file browsing to run directories.
Do not expose it through a public reverse proxy without adding authentication
and stronger isolation.

Agents run as the non-root `node` user with full shell access inside the Linux
runner: Claude exposes Bash with permission checks bypassed, Codex uses
`danger-full-access` with no approval prompts, and OpenCode allows Bash and
external directory access. Workflow access labels describe source-editing
responsibilities, not a shell sandbox. Planning, design and review roles must
preserve project source, while implementation may change source within the
approved task. Those role rules and handoff approvals are workflow controls,
not operating-system isolation. See `src/server/execution-policy.ts` for the
instructions sent to every agent.

The production Compose service mounts `/var/run/docker.sock`, which grants
control over the host Docker daemon. Test stacks must use distinct project
names/ports and must not replace the active platform. Docker bind paths refer to
the daemon host; agent processes receive `AGENTLOOM_PLATFORM_CONTAINER` and
`AGENTLOOM_WORKSPACE` to resolve run workspace paths.

Run copies are separate folders, not separate OS/container identities. The
agents share a container user, runtime and credential volume. Do not use this
version for adversarial repositories, mutually untrusted users, or strict
per-agent data isolation.

CLI processes use argument arrays without a shell, a one-hour default total
timeout, an output cap, and owned-process cancellation. Nonzero exits, malformed
streams, empty output and reported output-length truncation fail the step.
Provider-reported cost is shown where supplied; missing cost is not zero.

## Interface and navigation

The run overview groups attention items first, then in-progress work, then
completed and cancelled history. Each row shows its current step and agent,
completed-step progress, status and last update. Search, project and live/demo
filters apply across the groups and are preserved when returning from a run.
Failed and interrupted runs stay in **Needs attention** rather than being buried
in finished history. Progress counts completed steps; it does not estimate
elapsed work or treat pending approval as completion.

The URL preserves the selected run, historical step, detail tab, open file,
activity scope, run filters, project selection and workflow selection.
Refreshing or opening the URL in another tab restores that view; browser Back
and Forward navigate between selections. Chat drafts, credentials and unsaved
workflow edits are not included in URLs. On mobile, selecting a run opens its
review page directly.

The earlier three-design comparison has been retired; historical rationales
remain in [`docs/designs`](designs/). See the [UX review](UX-REVIEW.md) for
findings and changes.

## Adapter documentation

- [Codex non-interactive execution](https://developers.openai.com/codex/noninteractive)
- [Codex sandboxing](https://developers.openai.com/codex/security)
- [Claude Code headless usage](https://code.claude.com/docs/en/headless)
- [OpenCode CLI](https://opencode.ai/docs/cli/)
- [OpenCode permissions](https://opencode.ai/docs/permissions/)
