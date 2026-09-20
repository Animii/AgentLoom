# PR machine

The PR machine is an opt-in delivery mode for **Live** runs: the platform works in a managed
Git worktree under an approved plan, Jev routes concrete evidence between implementation and
review, and the platform creates **one draft pull request**. Merging is always manual.

## 1. Choose a worktree and an outcome-council workflow

- The project must use the **Git worktree** workspace mode. Worktrees start from committed
  code, so commit or stash local changes first. Each run gets a dedicated branch
  `agentloom/<runId>` created from the base commit on the branch that was checked out.
- The workflow must start with a planning step, end with a step that has an outcome council,
  and have no approval gates between them. The seeded **Approved Task with Outcome Council**
  workflow qualifies. The engine refuses automation otherwise.
- In **New run**, set **Delivery** to **PR machine · automatic draft PR**. The selector appears
  only when the run is eligible (Live + Git worktree + final council step). Leave it on
  **Manual approval gates** for the standard handoff workflow.

## 2. Approving the plan authorizes the run

- A new PR machine run shows **PR machine · awaiting plan**. Approve the initial plan with
  **Approve plan and continue**.
- That approval records the authorization and a contract hash over the task, the approved
  plan, and the step definitions. The panel then reads **Working within the approved plan.**
  and **0 of 2 repairs used · Automatically create a draft PR after successful review ·
  Merge remains manual.**
- Routing does nothing until the plan is approved; controller approval is refused without it.
- If the task, plan, or workflow definitions change, the contract hash stops matching and
  automation pauses with **The approved plan or workflow changed. Review and approve the plan
  again.**
- After a server restart, any PR machine that was not awaiting a plan or done is set to
  **paused**: **Server restarted. Inspect the preserved run and resume automation.**

## 3. Routing, the two-repair cap, and recovery

At each stop (a blocked step or a waiting step with validation and council evidence) Jev
receives a bounded state — task, plan, recorded validation, council reports, and the repair
budget — and returns one choice with a confidence. Only concrete in-scope repairs are
automatic.

- **Automatic repair** requires all of: choice `return_to_implementer`, confidence at least
  0.6, at least one council **blocker**, and fewer than two repairs used. The findings go to
  the implementer (the same path as **Send to implementer**); validation and council then run
  again on the same approved plan. The run stops for review again, and the authorized
  controller can complete it only when the fresh council passes.
- **Two-repair cap**: the counter can reach 2 and is never reset by resume, retry, or
  **Repeat validation and review**. After the cap, a blocker pauses the run with
  **Clarification, missing evidence, or repair limit requires your attention.** The panel shows
  **N of 2 repairs used**.
- **Low-confidence pause**: confidence below 0.6 always pauses the run with
  **Low routing confidence; review the evidence.** Each decision is listed under
  **Routing decisions** with its action, confidence, and reason.
- **Completion** requires choice `complete` with confidence at least 0.6 while the run is
  waiting for approval and the council status is pass. The controller approves the final step,
  which re-checks validation and council freshness first. Missing requirements, contradictory
  evidence, or uncertainty stay paused for the operator.
- If the routing evidence exceeds 30,000 characters, automation pauses and asks for a manual
  review instead of guessing.

Manual takeover and recovery:

- Once the plan is approved, manual actions — approve, revise, rework, retry, cancel, or
  sending a message — pause automation with **You took control of this run. Resume automation
  when ready.** Before plan approval there is no automation to pause.
- A pause is refused with a 409 only while the PR machine itself is publishing
  (`PR machine · publishing`), and the pause does not proceed. This covers both **Pause
  automation** and the pause triggered by a manual action; since **Pause automation** is
  rendered only for the **active** and **deciding** statuses, that refusal during publication
  is reached through the API. Manual publication is outside the guard: **Create draft PR** sets
  the separate diff lock without entering the publishing status, so a pause requested while
  that manual run is in progress is accepted; the engine still refuses **Repeat validation and
  review** and new messages while that lock is set. **Pause automation** stops future decisions;
  agent work already running may finish, but no next decision is applied.
- **Resume automation** requires an approved plan and no decision in flight. It is refused
  for failed, interrupted, or cancelled runs; recover failed or interrupted work with
  **Retry step** first. Resuming does not change the repair counter.
- **Retry step** re-runs a failed or interrupted step. For a council step, completed reviews
  are preserved and only unfinished reviews are retried.
- **Repeat validation and review** appears on a paused run that has no PR and is completed,
  blocked, or waiting for approval. It preserves history, deletes the stored approved Git
  tree, and restarts from the first validation step with the message
  **Repeating validation and council. Resume automation after inspecting the new results.**
  A new PR then requires fresh passing validation, a fresh council pass, and a new final
  approval.

## 4. Exact-tree publication and retries

- At final approval the platform records the exact Git tree of the worktree. Publication
  refuses to proceed while the current tree differs: **Files changed after approval.
  Revalidate and approve the current files.**
- Before publishing, it also re-checks the recorded validation fingerprint, council evidence
  freshness, and scans changed tracked files and non-ignored untracked files for credential
  **filenames**: `.env` and `.env.*` (except `.env.example`), `.auth`, `.data`,
  `secret`/`secrets`, `credential`/`credentials`, `id_rsa`, `id_ed25519`, and names ending in
  `.pem`, `.key`, `.p12`, or `.pfx`. A match stops publication with **Potential credential
  files are changed. Remove them from the PR before continuing.** This is a filename check
  only, with no content inspection; it does not cover every credential pattern (for example
  `.envrc`, `.environment`, or an extensionless key named `id_dsa`), so review the diff
  yourself before publishing.
- **Automatic draft delivery**: once the run is completed, the approved branch is pushed
  without force and `gh pr create --draft` opens a draft PR against the base branch recorded
  when the worktree was created (in this pilot, `feat/pr-machine`). The preview title and body
  are used. **Draft PR ready. Merge remains manual.**
- **Duplicate prevention**: the platform lists PRs for the run branch. An existing open PR on
  the same base containing the approved tree is reused. Any existing PR with a different
  state, base, or tree stops publication for manual inspection.
- **GitHub failures never rerun agents**: a failed push or PR creation pauses with
  **Publication failed. Resume to retry without rerunning agents.** On a completed run the
  button becomes **Retry publication**, which repeats only the preview, push, and PR calls.
  If the tree no longer matches the approval, revalidate and approve first.
- **Manual delivery**: an API-only policy — create the run with
  `automation: {"publication": "manual"}`; **New run** offers only **PR machine · automatic
  draft PR**, so there is no Delivery option for it. With manual publication, completion shows
  **Review complete. Create the draft PR when ready.** Use **Create draft PR** in the Git panel
  after reviewing the patch and description; the preview token binds that exact diff. Sign in
  once with
  `docker compose exec platform gh auth login --hostname github.com --git-protocol https --web`
  (shown under **GitHub authentication**). Never paste keys or tokens into task text, plans, or
  PRs.
- The platform only pushes the run's dedicated branch and only creates a draft PR. It never
  merges and never updates the base branch; review and merge the PR yourself on GitHub.

## Implementation map

- `src/server/automation.ts` — routing loop, two-repair cap, low-confidence pause, takeover
  and resume, publication retry, restart pause.
- `src/server/engine.ts` — worktree/plan contract, controller approval, rework, revalidate,
  retry, final-tree recording, publication freshness checks.
- `src/server/git-workspaces.ts` — worktree creation, preview and token, sensitive-file check,
  draft PR push/create, duplicate-PR handling.
- `src/client/AutomationPanel.tsx`, `src/client/GitRunPanel.tsx`, `src/client/NewRunDialog.tsx`
  — operator controls and labels.
