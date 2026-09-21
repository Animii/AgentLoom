# Reliable delivery pilot results

21 September 2026. Five fresh tooling tasks produced **five open draft PRs**.
Every final recorded check and independent Astra review passed. Each remote tree
matched its approved tree, each PR contained exactly three authorized files,
and independent probes passed against real run data. No PR was merged.

The zero-intervention target was **not achieved**: one operator approval was
needed after Jev paused at low confidence. Two planned recovery actions are
counted separately. Four tasks needed no unplanned post-approval intervention.

| Task | Draft | Focused tests | Flash repairs | Fable rescue | Unplanned decisions | Approval to draft | Reported implementation USD |
|---|---|---:|---:|---:|---:|---:|---:|
| Routing export | [#10](https://github.com/Animii/AgentLoom/pull/10) | 73 | 2 | 0 | 0 | 20.5 min | $0.0360 |
| Evidence hash | [#9](https://github.com/Animii/AgentLoom/pull/9) | 16 | 0 | 0 | 0 | 6.5 min | $0.0173 |
| Cost summary | [#13](https://github.com/Animii/AgentLoom/pull/13) | 17 | 0 | 0 | 0 | 6.3 min | $0.0143 + unknown interrupted attempt |
| Change summary / forced rescue | [#11](https://github.com/Animii/AgentLoom/pull/11) | 15 | 2 forced | 1 forced | 1 | 32.8 min | $1.1416 |
| Test-results summary | [#12](https://github.com/Animii/AgentLoom/pull/12) | 14 | 2 | 0 | 0 | 32.9 min | $0.0453 |

The six automatic Flash repair decisions comprise three real code corrections,
one validation-only retry, and two harness-forced repairs. Initial plan approvals
are the intended gate. Times include queues, checks, reviews and operator waiting;
the runs overlap, so their times cannot be summed as wall-clock duration.

## Findings

**Flash quality.** Astra found two successive routing-export defects: explicit
null fields were incorrectly treated as absent, then sparse arrays bypassed
validation. It found another sparse-array bypass in the test-results export.
These were real defects the implementer's passing tests had missed. Flash fixed
all three automatically. The hash tool passed first time; the cost tool passed
its first completed implementation after the planned interruption.

**Validation recovery.** Test-results attempt 2 passed focused tests, typecheck,
build and Compose, but the existing cancellation test failed: 148/149 passed.
Astra correctly blocked completion and distinguished this from a demonstrated
utility regression. Jev spent a repair slot. Flash inspected the timing race,
kept all deliverables byte-identical, and the platform recorded 149/149 passing
on the same source hash in attempt 3. The old failure remains. The platform
branch subsequently fixes the test to await the agent's abort listener instead
of assuming it exists 30 ms after the run becomes active.

**Rescue orchestration.** The harness reinserted a throw after each Flash attempt
in task 4. After two repairs, Jev selected the preapproved Fable rescue. Fable
removed the injected defect; all recorded checks and a separate Astra review
passed. These forced failures do not measure natural Flash quality or establish
Fable's superiority. Fable did not review its own work.

**The manual decision.** Jev chose completion for the rescued task with confidence
0.22, below the 0.60 threshold. Completion probability was 0.61, a different
quantity. The guard paused correctly. All five checks and Astra's criteria passed
without unresolved findings. The operator checked source identity, exact scope,
projection, non-mutation and sparse/duplicate rejection, then approved and resumed
publication. This counts as one unplanned decision. The threshold was unchanged;
Jev was not rerun until it gave a favorable answer. Advisory signals appeared
inconsistent with direct evidence; their causal role has not been established.

## Recovery and history

Task 3 was restarted after Flash wrote only the script. Its file hash, source
fingerprint, Git base/branch, approved contract, transcript and repair budget
matched before and after restart. The operator retried that step and resumed the
same policy. No new run or altered task scope was substituted.

The final audit found that the tested runtime omitted this ordinary interrupted
attempt from structured history when retry began. The operator snapshot retained
its transcript, tool count, timestamps and unknown cost. The versioned report
includes it with explicit supplemental provenance; the live run was not rewritten.
The platform fix now archives ordinary attempts, tools, provider identity and null
costs before clearing current output. A shutdown/restart/retry regression verifies
this with actual partial files and persisted state.

Task 5's first publication failed by design after review approval. Resume retried
publication without rerunning agents: all step records and the approved tree were
unchanged. GitHub has exactly one PR for its branch, with the approved remote tree.

## Is Flash worth keeping?

Flash reported **$0.141344514** for eleven completed implementation attempts.
The interrupted Flash attempt has no reported charge. Fable's one rescue reported
**$1.113095**. Known charges sum to $1.254439514. The 17 Astra planning/review
attempts, Jev calls, operator work and interrupted Flash call are not fully priced.
These are CLI-reported amounts, not a reconciled invoice or total workflow price.

This supports keeping Flash for small, explicit work packages with independent
tests and strong review. It does not prove the lowest total cost per accepted
production change: repeated review cycles consumed much more time than initial
implementation. The forced Fable task is not a matched comparison. A fair cost
comparison needs identical tasks and complete accounting.

The next useful improvements are separating validation-only recovery from code
repair budgets and investigating Jev's signals using this preserved case. One
Astra reviewer caught all three observed natural code defects; that does not
establish a recall rate or exclude unseen defects. Five utilities do not represent
complex product development or justify adding a larger council.

The [first pilot](PR_MACHINE_PILOT_RESULTS.md) needed nine unplanned decisions;
this one needed one. Different tasks and injected faults prevent treating that
change as a controlled reliability estimate.

See the [protocol](RELIABLE_DELIVERY_PILOT.md),
[versioned evidence](evaluations/reliable-delivery/README.md), and
[platform validation](VALIDATION.md). Runs remain inspectable on
[localhost:4320](http://localhost:4320); the normal platform is
[localhost:4317](http://localhost:4317).
