# Five-task PR machine evidence

See [the results and limitations](../../PR_MACHINE_PILOT_RESULTS.md).

- [outcomes.json](outcomes.json): per-task PR, focused test count, timing,
  automatic repairs, operator decisions and partial charges.
- [records.json](records.json): frozen briefs, approved plans, recorded command
  exits/freshness, reviews and focused challenges, retained clarifications,
  Jev routing decisions, provider attempts and the intervention log.
- [github-verification.json](github-verification.json): real GitHub state,
  exactly three permitted files, unique PR per branch and approved-tree equality.
- [restart-verification.json](restart-verification.json): fingerprints, interrupted
  steps and preserved repair budgets across the deliberate server restart.
- [p5-publication-recovery.json](p5-publication-recovery.json): identical step
  hashes and approved tree across publication-only recovery.
- [cli-integration-125.json](cli-integration-125.json),
  [cli-integration-3.json](cli-integration-3.json),
  [cli-integration-4.json](cli-integration-4.json): executable checks of all five
  final tools using the real app, run evidence, checkout and GitHub metadata.
- [deployment.json](deployment.json): healthy main image and preservation of all
  190 existing run states.
- [viewer-upgrade.json](viewer-upgrade.json): final pilot viewer upgrade preserved
  all five completed runs, step hashes and publication identities.
- [validation.json](validation.json): platform checks and retained failed reruns.

Full run snapshots, event/tool transcripts, raw validation logs and browser traces
remain in the local pilot data and `artifacts/single-review/`. This directory
includes approved tasks/plans and explicit review clarifications, while omitting
raw provider streams, command output and authentication data.
Model reports are evidence to inspect, not an independent escaped-defect estimate.
Some early operator-log entries were reconstructed from persisted run messages
after a local PowerShell serialization error; those entries carry a provenance
note. Original run histories remained intact.

The live runner scripts under `scripts/pilots/` create paid provider work and real
draft PRs; do not rerun them just to read these records. The report script reads
saved run IDs from local artifacts and queries the existing pilot API. All PRs
target `feat/single-reviewer-pr-machine` and remain draft; merging is manual.
