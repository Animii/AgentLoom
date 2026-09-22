import type { Run, StepDefinition, Workflow } from './types.js';

export const FABLE_REPAIR = {
  provider: 'claude' as const,
  model: 'claude-fable-5-1',
  effort: 'high',
};

export function supportsEscalation(workflow: Pick<Workflow, 'steps'>): boolean {
  const writers = workflow.steps.filter((s) => s.access === 'workspace-write');
  const final = workflow.steps.at(-1);
  return (
    writers.length === 1 &&
    writers[0].provider === 'opencode' &&
    writers[0].model === 'deepseek/deepseek-flash' &&
    final?.council?.reviewers.length === 1 &&
    final.council.reviewers[0].provider === 'codex' &&
    final.council.reviewers[0].model === 'gpt-6-astra' &&
    final.provider === 'codex' &&
    final.model === 'gpt-6-astra'
  );
}

export function canEscalate(run: Run): boolean {
  const policy = run.automation;
  const review = run.steps.at(run.currentStep);
  if (
    !policy?.escalation ||
    policy.escalation.used ||
    policy.repairsUsed !== policy.maxRepairs
  )
    return false;
  const escalation = policy.escalation;
  if (!supportsEscalation({ steps: run.steps.map((s) => s.definition) }))
    return false;
  // A model that has already reviewed this run cannot become its implementer.
  return ![
    review?.council,
    ...(review?.history ?? []).map((a) => a.council),
  ].some(
    (e) =>
      e &&
      [...e.reviewers, ...(e.challenge?.reviewers ?? [])].some(
        (r) =>
          r.member.provider === escalation.provider &&
          r.member.model === escalation.model,
      ),
  );
}

export function implementationDefinition(
  run: Run,
  definition: StepDefinition,
): StepDefinition {
  const escalation = run.automation?.escalation;
  return escalation?.used && escalation.stepId === definition.id
    ? {
        ...definition,
        provider: escalation.provider,
        model: escalation.model,
        effort: escalation.effort,
      }
    : definition;
}

export function secondOpinionAvailable(run: Run): boolean {
  const member = run.steps.at(-1)?.definition.council?.secondOpinion;
  return (
    !!member &&
    !run.steps.some((s) =>
      [s, ...(s.history ?? [])].some(
        (a) =>
          s.definition.access === 'workspace-write' &&
          a.execution?.provider === member.provider &&
          a.execution.model === member.model,
      ),
    )
  );
}
