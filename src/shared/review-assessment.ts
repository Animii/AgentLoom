import type { StepRun, ReviewAssessment } from './types.js';
import { isPlanningStep } from './planning.js';
export function canAssessReview(step: StepRun) {
  return !isPlanningStep(step.definition) && step.definition.access === 'read-only' && /review|verif/i.test(step.definition.role + ' ' + step.definition.name) && ['blocked','waiting_approval','completed'].includes(step.status) && !!step.output.trim();
}
export const assessmentAdvice: Record<NonNullable<ReviewAssessment['category']>, {label: string; advice: string}> = {
  code_fix: {label:'Code fix',advice:'Send the findings to the implementer, then repeat validation and review.'},
  missing_requirement: {label:'Missing requirement',advice:'Clarify the requirement with the reviewer or planner before assigning implementation work.'},
  environment: {label:'Environment blocker',advice:'Resolve missing dependencies, tools, permissions or services, then rerun validation. A code revision may not be needed.'},
  mixed: {label:'Mixed blockers',advice:'Separate code fixes from decisions and environment work; resolve each before another review.'},
  no_blocker: {label:'No blocker identified',advice:'Check the review evidence yourself before deciding whether to approve.'},
  unclear: {label:'Jev is uncertain',advice:'Jev could not confidently classify this review. This is not a confirmed blocker or a measure of code quality. Review the evidence before deciding.'},
};

export function uncertainAssessmentToken(step: StepRun | undefined): string | undefined {
  const assessment=step?.assessment;
  if(!assessment || assessment.attempt!==step?.attempt || assessment.status!=='ready')return;
  if(assessment.category!=='unclear' && (assessment.confidence??1)>=0.6)return;
  return `${assessment.attempt}:${assessment.output}:${assessment.createdAt}`;
}
