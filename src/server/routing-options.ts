import { councilReady, reviewEvidenceComplete } from '../shared/council.js';
import { canEscalate } from '../shared/automation.js';
import { reworkTarget } from '../shared/rework.js';
import type { Run } from '../shared/types.js';
import { unresolvedCouncilFindings } from './council.js';

export function routingOptions(run: Run): { criteria: Record<string, string>; reason: string } {
  const criteria: Record<string, string> = { request_clarification: 'Missing decision, contradictory evidence, or uncertainty. Pause for the user.' };
  const step = run.steps[run.currentStep], policy = run.automation, evidence = step?.council;
  if (!policy?.approvedAt || !evidence || evidence.attempt !== step.attempt || evidence.status === 'stale') return { criteria, reason: 'Review evidence is missing or stale.' };
  if (!reviewEvidenceComplete(evidence, step.definition)) return { criteria, reason: 'A required review or acceptance criterion needs evidence.' };
  const validation = run.steps.filter(s => s.definition.validation);
  const passing = validation.length > 0 && validation.every(s => s.validation?.attempt === s.attempt
    && s.validation.status === 'passed' && s.validation.before === evidence.source && s.validation.after === evidence.source
    && s.validation.commands.length === s.definition.validation!.commands.length
    && s.validation.commands.every((c, i) => c.status === 'passed' && c.exitCode === 0
      && JSON.stringify(c.command) === JSON.stringify(s.definition.validation!.commands[i])));
  if (run.status === 'waiting_approval' && passing && councilReady(step) && !unresolvedCouncilFindings(evidence).length) {
    criteria.complete = 'All approved criteria are supported by current passing validation and independent review. Non-blocking warnings do not require a repair.';
    return { criteria, reason: 'Current validation and independent review support completion.' };
  }
  if (reworkTarget(run) >= 0 && unresolvedCouncilFindings(evidence).length) {
    if (policy.repairsUsed < policy.maxRepairs && !policy.escalation?.used) criteria.return_to_implementer = 'Concrete repairable in-scope blocker. Return to the approved implementer; no product decision is required.';
    else if (canEscalate(run)) criteria.escalate_to_fable = 'Two Flash repairs are used. Give the preapproved Fable implementer one rescue attempt on concrete in-scope blockers, then rerun validation and independent Astra review.';
    return { criteria, reason: Object.keys(criteria).length > 1 ? 'Concrete findings can be repaired within the approved budget.' : 'The repair limit is reached or the independent Fable rescue is unavailable. Unresolved blockers need your attention.' };
  }
  return { criteria, reason: passing ? 'The review has unresolved evidence or disputes, without an eligible code repair.' : 'Current recorded validation must pass. Missing evidence cannot be treated as a repair or completion.' };
}
