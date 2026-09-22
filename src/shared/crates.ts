import type { Run } from './types.js';

export interface CrateTriage {
  key: string;
  action: 'approve' | 'repair' | 'clarify' | 'dismiss';
  reason: string;
  at: string;
}
export interface CrateFeedback {
  id: string;
  head: string;
  kind: 'review' | 'ci';
  summary: string;
  state: 'pending' | 'repair' | 'dismissed';
}
export interface CrateState {
  allowSplit?: boolean;
  parentId?: string;
  childIds: string[];
  join?: 'waiting' | 'joined';
  joining?: boolean;
  triage: CrateTriage[];
  feedback: CrateFeedback[];
  prState?: 'OPEN' | 'CLOSED' | 'MERGED';
  prHead?: string;
  syncedAt?: string;
  syncError?: string;
  updatingPr?: boolean;
}
export const newCrate = (): CrateState => ({
  childIds: [],
  triage: [],
  feedback: [],
});
// Include evidence content: a new attempt or changed review invalidates earlier triage.
export function triageKey(run: Run): string {
  const step = run.steps.at(run.currentStep);
  return JSON.stringify([
    step?.definition.id,
    step?.attempt,
    step?.output,
    step?.council,
    step?.assessment,
  ]);
}
export function needsTriage(run: Run): boolean {
  const step = run.steps.at(run.currentStep);
  return (
    !!run.crate &&
    run.currentStep === run.steps.length - 1 &&
    ['waiting_approval', 'blocked'].includes(run.status) &&
    !!step &&
    !step.definition.planning &&
    step.definition.access === 'read-only' &&
    !step.definition.validation
  );
}
export function triagePassed(run: Run): boolean {
  return (
    run.crate?.triage.filter((t) => t.key === triageKey(run)).at(-1)?.action ===
    'approve'
  );
}
export function crateStatus(run: Run): string {
  if (run.crate?.prState === 'MERGED') return 'Merged';
  if (run.crate?.prState === 'CLOSED') return 'PR closed';
  if (run.crate?.join === 'waiting') return 'Waiting for children';
  if (
    run.crate?.feedback.some(
      (f) => f.state === 'pending' && f.head === run.crate?.prHead,
    )
  )
    return 'Needs triage';
  if (needsTriage(run))
    return triagePassed(run) ? 'Your approval' : 'Needs triage';
  if (run.git?.prUrl && run.status === 'completed')
    return run.crate?.updatingPr ? 'Ready to update PR' : 'Watching PR';
  return (
    {
      waiting_input: 'Needs input',
      waiting_approval: 'Your approval',
      completed: 'Approved',
      running: 'Working',
      queued: 'Queued',
      failed: 'Failed',
      blocked: 'Blocked',
      cancelled: 'Cancelled',
      interrupted: 'Interrupted',
    } as const
  )[run.status];
}
