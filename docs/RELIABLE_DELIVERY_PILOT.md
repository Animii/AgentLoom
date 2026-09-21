# Reliable delivery pilot protocol

This follow-up to the [first five deliveries](PR_MACHINE_PILOT_RESULTS.md) tests
automatic evidence handoffs, valid Jev actions, and one preapproved Fable rescue
after two Flash repairs. The target is five draft PRs with zero **unplanned**
post-approval interventions. Merging remains manual.

The completed [results](RELIABLE_DELIVERY_RESULTS.md) retain the missed
zero-intervention target and every recovery action.

The isolated server uses port 4320, its own data volume, and fresh worktrees
from a committed source revision. Old pilot results and production runs are
preserved. `scripts/pilots/reliable/tasks.mjs` defines five new developer tools,
each restricted to a script, meaningful native tests, and documentation:

1. Routing decision export.
2. Exact-byte evidence hash verification.
3. Known/unreported run cost summary, with a planned server restart/recovery.
4. Reviewed change summary, with a deliberate fault after each Flash attempt
   to exercise both repairs and the Fable rescue. This is an orchestration
   exercise, **not evidence that Flash naturally failed these three attempts**.
5. Recorded check summary, with one deliberate publication transport failure.

Each run independently records its focused tests, typecheck, full backend
suite, build, and a Compose smoke receipt against its fresh build. The Compose
helper starts a unique stack with empty temporary data and no published ports
or credentials; it checks health, the empty run API and HTML delivery, then
removes that stack. It does not certify browser behavior or CLI correctness;
the separately recorded tests cover those scopes.

Initial plan approval is expected. Every later operator action is logged as
planned recovery or unplanned intervention, with before/after identities.
Measure approval-to-draft elapsed time, repair/escalation counts, partial
reported charges, unresolved outcomes and exact Git tree equality. Do not
discard failed attempts, rerun a task under a new ID to improve the score, or
count unknown costs as zero. Five small tooling tasks do not establish a
production success rate or prove that a larger council has no value.

The pilot runner creates paid work and real draft PRs. Do not invoke it just
to inspect results. Fault injection exists only in the isolated server entry
point, never in the production app.
