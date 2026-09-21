# Work packages and Jev routing

Status: research proposal, not implemented. This is separate from the outcome council.

The strong planner defines independently verifiable work packages. Jev recommends how to execute them. The user approves scope, interfaces and acceptance criteria.

Flow: planning chat → proposed packages → Jev recommendations → approval → implementation → recorded validation → reviewer or council → final user approval.

## Proposed experience

Add a compact Proposed work panel above planning approval. Example:

| Package | Size | Suggested profile | Readiness |
| --- | --- | --- | --- |
| Filter the run list | Small | Focused implementation / Flash | Ready |
| Persist filters in the URL | Small | Focused implementation / Flash | After package 1 |
| Restore deleted projects | Needs discovery | Strong planner | Needs a decision |

Expand a row for scope, exclusions, criterion IDs, expected files and interfaces, dependencies, exact validation commands and configured skills/tools. Primary actions: Edit, Ask planner, Approve packages. A Why this setup disclosure shows routing evidence and policy overrides without a probability dashboard.

Sizing rubric: Small, Medium, Split first, Needs discovery. Split by independently testable outcomes and interfaces, not file count or unsupported time estimates.

## What Jev can do

AgentLoom supports Jev choice, score and noul questions. Jev can select an existing execution profile, score complexity and flag missing decisions. The planner generates package descriptions, boundaries and explanations. Jev does not generate new skill instructions or arbitrary tool setups.

Start with three versioned profiles: Focused implementation (cheap model), Complex implementation (strong model with approved design), and Discovery (read-only planner). Each pins provider, model, effort, curated skill IDs/versions, configured tools, access, validation and budget.

Filter candidates for available providers/models/tools and project policy before evaluating them. Ask atomic questions about requirements, unresolved product decisions, coupling, validation adequacy and profile suitability. Apply deterministic policy to the answers. Confidence measures answer-distribution concentration, not the probability of successful implementation.

Approval snapshots package content, source revision, profile, skills, tools, policy and rubric versions. Any scope change invalidates approval and downstream evidence. Start with sequential packages in one managed worktree; parallel integration is a later feature.

Full shell access currently means a hidden tool is not an enforced permission boundary. Label profiles as configured capabilities. Restricted profiles would require actual adapter/runtime enforcement; do not silently remove the user's authorized shell/Docker access.

## Bounded automatic repair

Jev's existing review categories can recommend returning code fixes to the implementer. An opt-in policy may automate that handoff only when concrete findings reference the approved criteria, no requirement/interface/scope decision is needed, and the repair budget remains. Missing requirements, environment blockers, mixed or uncertain classifications go to the user. A confidence threshold alone is insufficient.

Proposed default limit: two repair attempts, with recorded validation and independent review after each. No automatic permission expansion, model downgrade, final approval, PR publication or merge. Record each routing decision and policy reason. The cheap implementer still stops when an approved decision is missing.

## Evaluation and precedents

Run 20–30 representative packages in recommendation-only mode. Compare fixed cheap, fixed strong and Jev-routed implementations using isolated worktrees and the same strong review. Include ambiguous requests, mechanical edits, subtle bugs, coupled refactors, unavailable models/tools, misleading text and Jev outages. Measure accepted quality, escaped defects, repair attempts, total cost including rework, latency and user corrections to package boundaries.

- [TypeSafe primitives](https://docs.typesafe.ai/introduction), [confidence](https://docs.typesafe.ai/confidence) and [patterns](https://docs.typesafe.ai/patterns) document atomic decisions and confidence-gated composition.
- [pi-jev](https://github.com/iefnaf/pi-jev) is a concrete cheap/strong routing implementation with conservative fallback. Its thresholds need local calibration.
- [RouteLLM](https://github.com/lm-sys/RouteLLM) illustrates routing and threshold calibration.
- [AOrchestra](https://arxiv.org/abs/2602.03786) represents delegated agents through instructions, context, tools and model, a useful precedent for execution profiles.
- [Anthropic workflow patterns](https://www.anthropic.com/engineering/building-effective-agents) distinguish routing and decomposition; [Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills) describes progressive disclosure.

These sources motivate a design and experiment; they do not establish that routing improves AgentLoom's cost or quality.
