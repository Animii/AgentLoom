import type { Workflow } from '../shared/types.js';

const seededAt = new Date().toISOString();

export const initialWorkflows: Workflow[] = [
  {
    id: 'review-build',
    allowSplit: true,
    name: 'Review, Build and Verify',
    description:
      'Full delivery path: plan the change, design the solution, implement it, then review the result. Approval, where enabled, means the run pauses AFTER the step produces its output and BEFORE the next step starts so the user (the final approver) can accept, request a revision or stop. Every step must stop with BLOCKED if its approved requirements are missing.',
    steps: [
      {
        id: 'plan',
        planning: true,
        name: 'Plan',
        role: 'product owner',
        provider: 'codex',
        model: '',
        effort: 'high',
        access: 'read-only',
        approval: true,
        instructions:
          'Act as the product owner. Read the task and the repository, then produce a concise, approvable specification: goal, scope, non-goals, user-visible behavior, interfaces and acceptance criteria. List every open decision and missing requirement explicitly. Do not write or modify files. If the request is ambiguous, contradictory or an approved requirement is missing, stop with BLOCKED and state exactly what is needed. The user is the final approver and must accept this plan before design begins.',
      },
      {
        id: 'design',
        name: 'Design',
        role: 'designer',
        provider: 'claude',
        model: 'claude-fable-5-1',
        effort: 'high',
        access: 'read-only',
        approval: true,
        instructions:
          'Act as the designer. Turn the approved specification into an implementation-ready design: files to change, data shapes, control flow, edge cases, error handling and the exact validation steps. Read the repository as needed but do not modify files. Respect the project rules in AGENTS.md. If the approved specification is missing or contradictory, stop with BLOCKED and list the gaps instead of guessing. Approval happens after this design is output and before implementation starts.',
      },
      {
        id: 'build',
        name: 'Implement',
        role: 'implementer',
        provider: 'opencode',
        model: 'deepseek/deepseek-flash',
        effort: 'max',
        access: 'workspace-write',
        approval: true,
        instructions:
          'Act as the implementer. Implement exactly the approved design and specification using file tools and shell commands. Install dependencies and run validation as needed; stay within the approved assignment. Keep credentials out of source, images, logs and responses. If an approved requirement is missing, contradictory or underspecified, stop with BLOCKED and state what is needed rather than inventing behavior. When finished, report the files changed, how to validate them and any deviations from the design. Approval happens after this output and before the reviewer starts.',
      },
      {
        id: 'review',
        name: 'Review',
        role: 'reviewer',
        provider: 'codex',
        model: '',
        effort: 'high',
        access: 'read-only',
        approval: true,
        instructions:
          'Act as the reviewer. Compare the implementation against the approved specification and design. Inspect the workspace read-only and do not modify files. Report concrete findings with file references, severity and a clear verdict, and confirm whether any BLOCKED report is accurate. The user is the final approver and decides whether to accept the result, request a revision or stop.',
      },
    ],
    updatedAt: seededAt,
  },
  {
    id: 'quick-review',
    name: 'Quick Review',
    description:
      'Fast second opinion on an existing change: inspect first, then review the findings independently. Both steps are read-only with no approval gates; the user remains the final approver of any follow-up work.',
    steps: [
      {
        id: 'inspect',
        name: 'Inspect',
        role: 'reviewer',
        provider: 'codex',
        model: '',
        effort: 'high',
        access: 'read-only',
        approval: false,
        instructions:
          'Inspect the requested change or files read-only. Summarize what the change does and list concrete risks, bugs, regressions and missing tests with file references. Do not modify files. If the target is missing or the request is unclear, state BLOCKED and say exactly what is needed.',
      },
      {
        id: 'review',
        name: 'Review',
        role: 'reviewer',
        provider: 'claude',
        model: 'claude-fable-5-1',
        effort: 'high',
        access: 'read-only',
        approval: false,
        instructions:
          'Independently review the inspection findings and the actual workspace. Confirm or challenge each finding, add anything the inspection missed and give a short verdict with severity per issue. Do not modify files. The user is the final approver and decides what to act on.',
      },
    ],
    updatedAt: seededAt,
  },
  {
    id: 'fix-verify',
    name: 'Fix and Verify',
    description:
      'Implement a fix, then verify it independently. Approval, where enabled, means the run pauses AFTER the step produces its output and BEFORE the next step starts so the user (the final approver) can accept, request a revision or stop. Every step must stop with BLOCKED if its approved requirements are missing.',
    steps: [
      {
        id: 'build',
        name: 'Implement',
        role: 'implementer',
        provider: 'opencode',
        model: 'deepseek/deepseek-flash',
        effort: 'max',
        access: 'workspace-write',
        approval: true,
        instructions:
          'Act as the implementer. Implement the approved fix inside the workspace using file tools and shell commands. Install dependencies and run validation as needed; stay within the approved assignment. Keep credentials out of source, images, logs and responses. If the bug report lacks reproduction steps, acceptance criteria or any other approved requirement, stop with BLOCKED and state what is needed instead of guessing. Report the files changed, the validation steps and any remaining uncertainty. Approval happens after this output and before verification starts.',
      },
      {
        id: 'verify',
        name: 'Verify',
        role: 'reviewer',
        provider: 'codex',
        model: '',
        effort: 'high',
        access: 'read-only',
        approval: true,
        instructions:
          'Act as the verifier. Independently verify the fix against the reported bug and its acceptance criteria: reproduce the original failure where possible, inspect the change read-only and run only the repository documented validation commands (typecheck, tests, build). Preserve project source files; dependency installation and generated validation artifacts are allowed. Report the evidence, any remaining risk and a clear verdict. If acceptance criteria are missing, stop with BLOCKED. The user is the final approver and decides whether to accept or request a revision.',
      },
    ],
    updatedAt: seededAt,
  },
];

export const evidenceWorkflow: Workflow = {
  id: 'evidence-delivery',
  name: 'Approved Task to Verified Delivery',
  description:
    'Approve the task, let a cheap implementer work, record validation commands and Jev signals, then get a strong review before final human approval. Configure validation commands before creating a run.',
  updatedAt: seededAt,
  steps: [
    {
      id: 'plan',
      name: 'Approve task',
      role: 'product owner',
      provider: 'codex',
      model: 'gpt-6-astra',
      effort: 'high',
      access: 'read-only',
      approval: true,
      planning: true,
      instructions:
        'Agree on the task with the user. Read the project, define exact scope, implementation constraints and measurable acceptance criteria. Include the configured validation commands from the system context in the plan. Resolve missing decisions through questions. Do not edit source. The user must approve before implementation.',
    },
    {
      id: 'build',
      name: 'Implement',
      role: 'implementer',
      provider: 'opencode',
      model: 'deepseek/deepseek-flash',
      effort: 'max',
      access: 'workspace-write',
      approval: false,
      instructions:
        'Implement only the approved task. Do not make product, architecture or scope decisions. Report BLOCKED when a decision is missing. Add meaningful tests and install required project dependencies. The platform will execute the approved validation commands independently after you finish. Report files changed and any claims that require verification. Do not change the configured validation contract or weaken tests to make them pass.',
    },
    {
      id: 'validate',
      name: 'Tests and Jev signals',
      role: 'validation runner',
      provider: 'opencode',
      model: '',
      effort: '',
      access: 'read-only',
      approval: false,
      instructions:
        'Execute the configured commands and record their actual exit codes and output. Jev signals are advisory. Failed validation remains visible to the independent reviewer.',
      validation: {
        commands: [
          { executable: 'npm', args: ['run', 'typecheck'], timeoutMs: 600000 },
          { executable: 'npm', args: ['test'], timeoutMs: 600000 },
          { executable: 'npm', args: ['run', 'build'], timeoutMs: 600000 },
        ],
      },
    },
    {
      id: 'review',
      name: 'Strong review',
      role: 'reviewer',
      provider: 'codex',
      model: 'gpt-6-astra',
      effort: 'high',
      access: 'read-only',
      approval: true,
      instructions:
        'Independently inspect the change against the approved task. Use the platform-recorded validation evidence and Jev signals. Do not treat implementer claims or Jev probabilities as proof. Check acceptance criteria, meaningful test coverage, scope and regressions. Preserve source files. Report BLOCKED with concrete findings when any requirement or validation remains unresolved. Otherwise provide a concise verdict with evidence references for the user to approve.',
    },
  ],
};
initialWorkflows.push(evidenceWorkflow);

export const crateWorkflow: Workflow = {
  ...structuredClone(evidenceWorkflow),
  id: 'crate-delivery',
  name: 'Crate delivery',
  allowSplit: true,
  description:
    'Plan a crate, optionally split approved scopes into child worktrees, integrate, validate and review. Explicit triage routes findings before human approval. PR feedback returns to the same crate.',
};
initialWorkflows.push(crateWorkflow);

export const councilWorkflow: Workflow = {
  ...structuredClone(evidenceWorkflow),
  id: 'council-delivery',
  name: 'Approved Task with Outcome Council',
  description:
    'Opt-in council: approved task, cheap implementation, recorded tests and Jev signals, three independent reviews and a chair synthesis, then your approval. One focused challenge round; no majority vote can clear blockers.',
};
councilWorkflow.steps[0].instructions +=
  ' Assign stable acceptance criterion IDs (AC1, AC2, etc.) and explicitly define scope.';
councilWorkflow.steps[3] = {
  ...councilWorkflow.steps[3],
  name: 'Outcome council',
  role: 'council reviewer',
  instructions:
    'Review all approved criteria, scope, correctness and product behavior against frozen source and recorded evidence. The chair summarizes contradictions; only the user approves.',
  council: {
    reviewers: [
      {
        id: 'correctness',
        name: 'Correctness',
        focus: 'Requirements, edge cases, state transitions and regressions.',
        provider: 'codex',
        model: 'gpt-6-astra',
        effort: 'high',
      },
      {
        id: 'product',
        name: 'Product and UX',
        focus:
          'Approved acceptance criteria, scope, user-visible behavior and interaction quality. For non-UI work review contracts and integration.',
        provider: 'claude',
        model: 'claude-fable-5-1',
        effort: 'high',
      },
      {
        id: 'adversarial',
        name: 'Adversarial verification',
        focus:
          'Challenge coverage and claims. Construct minimal counterexamples and regression probes. Report concrete evidence, not hypothetical concerns.',
        provider: 'codex',
        model: 'gpt-6-astra',
        effort: 'high',
      },
    ],
  },
};
initialWorkflows.push(councilWorkflow);

// A new template avoids changing existing runs or user-edited workflows.
export const singleReviewWorkflow: Workflow = {
  ...structuredClone(evidenceWorkflow),
  id: 'single-review-delivery',
  name: 'PR machine',
  description:
    'Approved task, Flash implementation, recorded tests, one Astra review and bounded Jev routing. Optional second opinion; merging remains manual.',
};
singleReviewWorkflow.steps[0].instructions +=
  ' Assign explicit stable acceptance IDs AC1, AC2, etc. Define scope and exact tests. The final reviewer must account for every approved criterion and SCOPE.';
singleReviewWorkflow.steps[3] = {
  ...singleReviewWorkflow.steps[3],
  name: 'Independent review',
  instructions:
    'Inspect the approved criteria, scope, changed source and recorded validation independently. Report concrete blockers with reproducible evidence or NEEDS_EVIDENCE for missing checks. Preserve source. Optional suggestions are warnings. Delivery follows the approved run policy; this report is evidence, not authorization.',
  council: {
    reviewers: [
      {
        id: 'correctness',
        name: 'Astra review',
        focus:
          'Independently inspect all approved criteria, source changes, recorded tests, edge cases and scope. Report only concrete in-scope defects; optional suggestions are warnings.',
        provider: 'codex',
        model: 'gpt-6-astra',
        effort: 'high',
      },
    ],
    secondOpinion: {
      id: 'second-opinion',
      name: 'Fable second opinion',
      focus:
        'Independently assess the approved criteria and disputed outcome. Seek reproducible counterexamples, preserve scope and separate optional suggestions from blockers.',
      provider: 'claude',
      model: 'claude-fable-5-1',
      effort: 'high',
    },
  },
};
initialWorkflows.unshift(singleReviewWorkflow);
