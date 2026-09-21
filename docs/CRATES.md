# Crates

Crates use the existing durable run ID. Conversation, attempts, files, validation, review and Git metadata remain attached to that identity. The Crates workspace is the new home; Runs and existing run/filter bookmarks remain available. Existing runs retain their execution policy until explicitly enabled as crates.

## Delivery

The **Crate delivery** template plans, implements, records validation and independently reviews. Crates require final approval. Triage is a separate, recorded routing action: proceed to approval, return findings to the implementer, or request clarification. Reviewers do not implement fixes. Changed review evidence invalidates an earlier triage decision. Existing authorized Jev automation retains its bounded policy and visible decision history.

## Split and join

Workflows opt in with `allowSplit`; this policy is copied into new crates. At the initial planning gate, the user can approve two to four child scopes. Splitting approves the parent plan and starts independent children using the same workflow snapshot. The parent waits. Initial delivery supports one level of children and manual delivery policies; live splitting requires Git worktrees.

Each child retains its own plan approval, conversation, tests and review. Children do not publish separate PRs. Joining requires every child to be approved, current validation, matching bases and unchanged approved trees. Git builds the combined merge off-index before changing the clean parent worktree. Conflicts leave parent files unchanged. After joining, child results are frozen and the parent resumes implementation/integration, validation and independent review. Integration is not equivalent to final approval.

## PR feedback

Crates with a PR poll GitHub every minute using the platform's existing `gh` authentication. Manual refresh is also available. Review feedback includes inline comments; failed GitHub checks are collected from the PR status rollup. No inbound webhook or externally exposed server is required.

Feedback is keyed by event identity and commit. Duplicate and old-commit events do not start repairs. A triage decision requires a reason. Routing a fix rechecks the open PR and exact published commit, then returns work to the existing implementer and repeats validation and review. After fresh triage and approval, **Update draft PR** publishes to the same dedicated branch and PR. No force push or automatic merge. Changes made externally to the branch require inspection rather than being overwritten. Closed and merged PRs stop polling.

This release routes PR repairs through human triage. It does not autonomously deploy, roll back deployments, or interpret arbitrary GitHub comments as permission to execute commands. Deployment jobs reported as GitHub checks appear with other failed checks; separate deployment-environment events are not subscribed to.

## Validation

`tests/crates.test.ts` exercises triage, split/join guards and PR event deduplication. `tests/git-workspaces.test.ts` exercises actual Git tree integration, conflict preservation and updating one PR. `tests/ui/crates.spec.ts` exercises creation, conversation, repair, approval, child navigation, URL restoration, mobile layout and reduced motion. Provider output and GitHub writes in tests are fixtures; Git operations and application state transitions are real.
