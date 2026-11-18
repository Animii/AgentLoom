# Outcome council proposal

Status: opt-in first version implemented in the council-delivery workflow. See the [user guide](USER_GUIDE.md#outcome-council-opt-in) for operation and limitations.

Keep the approved plan, recorded test results and source fingerprint as the common evidence bundle. A council extends the strong-review stage after implementation and validation. It never replaces executable checks or the final user decision.

## Recommended first version

Three independently prompted reviewers inspect the same frozen source version and evidence bundle:

1. Correctness reviewer (Codex): requirements, edge cases, state transitions, regressions and implementation correctness.
2. Product/UX reviewer (Claude Fable 5.1): acceptance criteria, scope, user-visible behavior and interaction quality. For non-UI tasks this becomes contract and integration review.
3. Adversarial verifier (a separately configured strong model): challenge claimed coverage and construct minimal counterexamples or regression probes. Do not let the implementer grade its own work as an independent vote.

Use separate contexts and hide other members' initial reports. Each returns PASS, BLOCKED or NEEDS_EVIDENCE, with criterion IDs, concrete findings, severity and links to evidence. Persist reports against the same revision and attempt. A missing or failed reviewer is unknown, never a passing vote.

Jev can identify duplicate findings, classify disagreements and prioritize claims for verification. It has no approval vote. A product-owner chair compiles the evidence and contradictions. Allow one focused challenge round; unresolved disputes go to the user instead of an open-ended debate.

Do not approve by simple majority or average confidence. A reproducible blocker remains a blocker even if two reviewers miss it. Code enforces passing recorded validation and freshness. The chair recommends an outcome; the user approves or sends concrete findings back to implementation. Any code change invalidates the council round.

## Quiet UI

One Council panel: recommendation, three reviewer statuses, unique findings and disputed findings. Expand a finding to see each reviewer's evidence. Actions: request missing evidence, send findings to implementer, or approve when deterministic gates pass. No wall of debate messages.

## Evaluation before enabling it by default

Replay the signed-zero pilot, a deliberately failing test, a scope violation, a stale validation result, an irrelevant complaint, and a correct change. Compare against the current single-reviewer workflow: unique defects caught, false blockers, disagreement resolution, token cost and time to approval. Start opt-in for higher-risk changes.

Research cautions against assuming that more judges automatically improve evaluation. The study [Judging with Many Minds](https://arxiv.org/abs/2505.19477) examines position, verbosity, chain-of-thought and bandwagon bias in multi-agent judging. [Anthropic's agent-evaluation guidance](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) describes combining grader types and evaluating outcomes and execution evidence. These motivate independent first passes, executable evidence and measuring this council against our own baseline; they do not establish its effectiveness for AgentLoom.
