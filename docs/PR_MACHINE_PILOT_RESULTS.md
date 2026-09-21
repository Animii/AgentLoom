# Five-task PR machine pilot

Date: 21 September 2026. This is an operational pilot of real development and
GitHub delivery, following the earlier council comparison. It is not a new
comparison of reviewer models or a statistical estimate of production quality.

## Results

**Five of five tasks produced real, open draft PRs.** Each final recorded command
passed, the independent review passed, and GitHub's published tree matched the
approved tree. Each PR contains exactly its three authorized files. No PR was
merged. All five tools also passed a direct integration check against the live
application, recorded run data, clean source checkout or real GitHub PR metadata.

| Tool | Draft PR | Task tests | Automatic repairs | Extra operator decisions | Approval to draft |
|---|---|---:|---:|---:|---:|
| Platform health | [#5](https://github.com/Animii/AgentLoom/pull/5) | 16 | 1 | 3 | 44.1 min |
| Run status | [#3](https://github.com/Animii/AgentLoom/pull/3) | 21 | 1 | 1 | 22.6 min |
| Validation export | [#6](https://github.com/Animii/AgentLoom/pull/6) | 15 | 1 | 0 | 15.8 min |
| Git readiness | [#7](https://github.com/Animii/AgentLoom/pull/7) | 15 | 2 | 4 | 70.3 min |
| Draft identity verification | [#4](https://github.com/Animii/AgentLoom/pull/4) | 14 | 0 | 1 | 28.5 min |

The five tasks used **five automatic repairs and nine extra operator decisions**
after plan approval. The operator was the coordinating assistant. Those decisions
include supplying evidence, clarifying protocol, one documentation repair,
revalidation after the platform fix, and four extra Git repairs. Three task-level
recovery actions are counted separately: retrying tasks 3 and 4 after the planned
restart, and resuming task 5's planned publication failure. Pre-approval setup
clarifications and the five initial approvals are also excluded from the decision
column. This was assisted delivery, not five unattended successes.

Reported agent charges total **$0.2906**, all from Flash implementation attempts.
Codex and Jev dollar costs are unavailable, so this is not a total price. Per-task
charges, both creation-to-draft and approval-to-draft timing, every recorded
validation/review attempt and the intervention log are in the
[versioned evidence](evaluations/pr-machine-five/README.md). Timing includes
queueing and operator work; the runs overlap and their times must not be added as
wall-clock duration.

The deployed platform is at [localhost:4317](http://localhost:4317); the completed
pilot runs remain inspectable on [localhost:4319](http://localhost:4319). After
all five deliveries, the pilot viewer was upgraded to `a32cf08` without changing
any step history, completed state or publication identity.

## Protocol

Five standalone developer tools each receive a separate Git worktree and an
approved contract limiting edits to one script, its tests and its documentation.
The source baseline is `550761e1d43c2c4b2a49dd6ca4d8d74ff421cddc` in the private
`Animii/AgentLoom` repository. None of the task implementations modifies existing
application code, tests, dependencies or workflows.

The real workflow is Astra planning with explicit AC IDs, product-owner approval,
OpenCode `deepseek/deepseek-flash` at maximum effort, recorded task tests plus
typecheck/test/build, one independent `gpt-6-astra` reviewer at high effort, and
`jev-1.13.0` routing under the platform's evidence guards. Jev can return concrete
findings for at most two automatic repairs. Completion publishes a draft of the
exact approved Git tree. Merging remains manual.

The coordinating assistant acts as product owner and operator. Its clarifications,
extra repair decisions and recovery actions count as interventions. Initial plan
approval is the intended gate, not an autonomous action. No operator patches a
task's source files. Full council and Fable second opinion remain available, but
neither is invoked for these five live tasks.

Task 4 receives one labelled runtime throw from the isolated test harness before
recorded validation. Task 5's first publication attempt is deliberately rejected
before the GitHub transport. A server restart interrupts tasks 3 and 4. These are
controlled faults and must not be counted as spontaneous provider failures.

## What required intervention

The first plans lacked an explicit central Docker validation arrangement. The
operator clarified this before approval for tasks 1 and 2, then included it in
later task briefs. Actual Compose receipts were initially missing from some
review contexts; the operator supplied measured evidence for tasks 1, 2 and 5.
Task 3 received the receipt before approval. Tests and source checks were not
waived. Separating the post-publication retry experiment from the tool's acceptance
criteria removed a circular gate in task 5.

Task 1 exposed a platform defect: a review clarification disappeared from the next
review's context after implementation repair. Runtime `88faf8f` retains those
clarifications in the frozen evidence, without clearing findings or replacing
current validation. The operator requested fresh validation after deploying the
fix, without pasting the receipt again. The new Astra review explicitly used the
retained receipt and passed. A regression also verifies that retained clarification
cannot erase a blocker.

Task 1 additionally needed an operator-authorized documentation correction. Jev
requested repair for a warning-only result; the controller refused an automatic
repair because there was no eligible blocker. Task 4 exhausted its two automatic
repairs while a real submodule-filter defect remained. The operator authorized
further same-scope repairs; the automatic budget stayed at two.

Task 4 later exposed a separate failure path: oversized Git configuration caused
filter discovery to fail, and swallowing that error allowed a filter to run.
The operator authorized a third manual repair after the budget was exhausted.
Its previous recorded full suite also hit the known close-stdin fixture failure
in the pinned baseline. Both findings stayed blocking until new implementation,
regression coverage and a fresh full recorded validation were available. The
baseline failure is retained; a later passing run does not prove it was fixed in
the task branch. The platform branch contains the fixture fix.

A fourth manual repair addressed another concrete case: Git status lazily fetched
missing objects in a partial clone and wrote pack/index/promisor files. This is a
read-only contract violation even when the CLI ultimately returns not ready.

## Evidence and recovery

Recorded validation includes exit codes and matching before/after source hashes.
Every final review must account for each approved acceptance criterion and SCOPE.
GitHub verification checks the open/draft state, expected base and head, exactly
three permitted files, one PR per run branch, and a remote tree identical to the
platform's approved tree. Tool prose alone is not accepted as validation.

The planned restart stopped task 3 during implementation and task 4 during review.
Both became Interrupted with automation paused. Source fingerprints, branches,
plans and repair budgets matched before and after restart. Explicit retry/resume
continued the same runs. Previously completed tasks 2 and 5 stayed completed and
were not published again. The runtime was upgraded from `550761e` to `88faf8f`
during this restart; task worktrees remained pinned to the original source.

Task 5's publication recovery retained an identical approved tree and identical
hash of all step records before and after resume. No implementation, validation or
review reran. Its real draft PR was then created successfully.

The new platform candidate passes typecheck, build, 144 backend tests and 26
browser tests. Targeted checks also cover single-review streaming, optional second
opinion, reload, mobile layout and draft publication. Jev settings/key-persistence
browser tests use a deterministic upstream fixture; the pilot's Jev routing calls
are real. A real completed pilot run was inspected at desktop and 390px widths.

The final deployment check found a real delayed-loading UI race: opening New run
before workflows arrived left its selection empty while the browser displayed
the first old template. The dialog now selects PR machine once the list arrives,
without replacing entered task text or an explicit workflow choice. A browser
regression deliberately holds that response until after the dialog opens.
Completed reviews now say Review passed instead of suggesting another approval
is still required after publication.

A concurrent Windows rerun had several short-deadline process-test failures, and
one browser scenario timed out while publication was still progressing. These
logs remain under `artifacts/single-review/`; they are not counted as passes.
The unchanged browser scenario passed separately. The final full backend suite
passed in an isolated Linux container with its original parallel test command,
matching the platform's deployment OS. No deadlines or assertions were relaxed.

The earlier Linux model-catalog regression was traced to its fake CLI closing fd 0
while leaving Node's stdin stream active. Replacing that fixture operation with
`process.stdin.destroy()` passed ten consecutive Linux catalog suites, with no
relaxed assertion, larger timeout or changed production process behavior. The full
backend suite now passes with its original parallel test command.

## Interpretation

The strong reviewer found concrete defects after task tests already passed: URL
normalization and credential-bearing error output, malformed-JSON excerpt leakage,
sparse-array handling, and Git configuration/submodule behavior that violated the
read-only contract. The Git task required deeper repair than the cheap implementer
managed within its automatic budget. Passing self-written tests was insufficient.

This supports the default of cheap implementation followed by deterministic tests
and one strong reviewer, with bounded repair and an operator escape path. It does
not establish unattended correctness or superiority over an untested alternative.
The five tasks share a repository and narrow tool scope; outcomes are correlated.
The pilot also changed runtime partway through to fix a demonstrated defect.

For subsequent work, attach external validation receipts to the approved task
before implementation, keep the two-repair limit, and escalate Git/infrastructure
work to a stronger implementer when that limit is reached. Repeated manual repair
authorizations in this pilot are evidence of a work-package/model mismatch, not
an argument for an unlimited automatic loop. Optional second opinion remains for
disputed evidence; this pilot did not measure its incremental benefit.

Elapsed time includes concurrent scheduling, plan gates, operator work and deliberate
recovery pauses. Reported dollar charges cover only attempts with supplied billing;
Codex and Jev dollar costs are unknown. Partial charges are not total cost or an ROI
estimate. Earlier failed/blocked attempts are retained, not replaced by final PASS.
