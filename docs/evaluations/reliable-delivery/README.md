# Recorded reliable-delivery pilot

- [Results and interpretation](../../RELIABLE_DELIVERY_RESULTS.md)
- [Outcome measurements and attempt charges](outcomes.json)
- [Plans, validation, reviews, decisions, interventions and independent checks](records.json)

Five real runs used frozen Git base
`d247f07e83a6ab66de57dbd6ed08b5c9cb45b9fa` and isolated runtime
`0c38c4ba5fe7410a545ebb437b0650a990bb19c2`. Source fingerprints, evidence packet
hashes, exit codes and Compose image/container receipts are included. Fault
injection exists only in `scripts/pilots/reliable/server.mjs`.

Unknown costs remain unknown. Task 3's interrupted attempt comes from its
pre-retry operator snapshot because the tested runtime omitted it from ordinary
attempt history. Its supplemental provenance is explicit in both exports. It
was not removed from the experiment or counted as free.

Full local API snapshots, process logs, screenshots and recovery records are under
`artifacts/reliable-delivery/`. Immutable validation packets remain in the isolated
data volume. Process output can already be truncated at the capture limit; its
flag is retained. A packet cannot reconstruct discarded bytes. This export omits
raw provider logs and tool payloads while retaining failed validation tails.

`node scripts/pilots/reliable/report.mjs` regenerates these files from local
snapshots only: no model calls, runs or PRs. The live task runner spends provider
credit and publishes real drafts; do not invoke it to inspect results.
