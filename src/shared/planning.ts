import type { StepDefinition } from './types.js';

// Preserve existing saved planning workflows without rewriting user definitions.
export function isPlanningStep(step: StepDefinition): boolean {
  return (
    step.planning ??
    (step.id === 'plan' &&
      ['product owner', 'planner'].includes(step.role.toLowerCase().trim()))
  );
}
