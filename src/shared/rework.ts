import type { Run } from './types.js';
import { isPlanningStep } from './planning.js';

/** A read-only review can return to the nearest completed writer without crossing planning. */
export function reworkTarget(run: Run): number {
  const review = run.steps[run.currentStep];
  if (!['blocked', 'waiting_approval'].includes(run.status) || !review || review.definition.access !== 'read-only' || isPlanningStep(review.definition)) return -1;
  for (let i = run.currentStep - 1; i >= 0; i--) {
    const step = run.steps[i];
    if (isPlanningStep(step.definition)) return -1;
    if (step.definition.access === 'workspace-write') return step.status === 'completed' ? i : -1;
  }
  return -1;
}
