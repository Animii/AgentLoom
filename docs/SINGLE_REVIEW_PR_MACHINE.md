# PR machine with independent review

Choose **PR machine**, connect a clean Git project using **Git worktree**, and
select automatic draft publication. The planner produces an approval gate with
explicit AC1, AC2, ... criteria. Approving it authorizes Flash implementation,
recorded validation, an independent Astra review, and bounded Jev routing.
Jev may request at most two Flash repairs or complete the approved task. For
the standard Flash/Astra workflow, New run also offers one Fable rescue after
those repairs. The checkbox and plan approval authorize that extra attempt;
existing runs keep their original budget. Fable works within the same scope,
then all validation and independent Astra review run again. Remaining blockers
pause delivery. Missing evidence, low confidence or changed source also pause it.
Draft publication uses the exact approved Git tree. Merging stays manual.

The default final step has one structured reviewer and no chair call. Every
approved criterion plus SCOPE must appear in its report. Required tests,
source freshness and unresolved findings remain platform gates; a model's
PASS text cannot bypass them. Older workflows retain their configured council.

**Get another opinion** adds Fable to the same frozen evidence when the outcome
is disputed. Enter the concrete question to check. The original review stays
visible, and a chair summarizes both reports. Each reviewer must resolve its
own blockers with evidence; a second PASS cannot outvote the first review.
The additional reviewer and unresolved findings persist through later repairs.
Taking control pauses automation; inspect the new evidence before resuming.
Fable cannot both implement and independently review the same run. A previously
requested Fable opinion prevents automatic Fable rescue; a used Fable rescue
disables its second-opinion button. Existing reviewer obligations are retained.

Jev receives only currently available actions. Warnings cannot trigger code
repair, failed checks cannot offer completion, and exhausted budgets cannot
offer another implementation attempt. If clarification is the only valid
action, the controller pauses directly without spending a Jev call. Routing
history records the offered actions alongside the chosen action and confidence.

Every agent handoff includes a SHA-256-pinned validation evidence file with
the complete *recorded* command outputs, source fingerprints and historical
failures. Reviewer copies receive `.data/agentloom/validation.json`; implementers
receive an assigned immutable file under the platform data directory. Existing
64,000-character command capture limits still apply and truncation is explicit.
Docker receipts travel in this file when Docker checks are configured as
validation commands. A missing Docker check is never fabricated, and a prior
passing result cannot certify changed source. Small output tails remain inline
for readability; agents can read the full recorded evidence file.

If a provider or server stops, recover the failed/interrupted step and then
resume automation. Previously recorded attempts remain inspectable. A failed
GitHub publication can be resumed without rerunning implementation or review.
Changes after approval require validation and review again.

## Five-task live pilot

`scripts/pilots/pr-machine-five.mjs` freezes five real developer-tool tasks:
platform health, run status, validation export, Git readiness, and draft-PR
identity verification. Each changes a script, native tests and dedicated docs
on its own worktree branch. The script creates runs on port 4319 and records
local run snapshots; it never approves a plan or merges a PR.

`scripts/pilots/pr-machine-server.mjs` is an isolated test entry point using
real provider calls, Jev, Git and GitHub. Its labelled, one-time test faults
inject a runtime throw into task 4 before validation and reject task 5's first
publication attempt. Task 3 is interrupted by a deliberate server restart.
These are recovery exercises, not spontaneous model failures. No fault switch
is present in the normal production entry point. Run only with
`AGENTLOOM_LIVE_PILOT=five-tasks` and isolated data/workspace volumes.

Report actual outcomes, all manual interventions beyond plan approval, repair
counts, elapsed time, and partial reported costs. Missing provider costs must
remain unknown. Five tooling tasks are an operational pilot, not a statistical
claim about arbitrary application development.
