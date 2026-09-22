import type {
  ProviderId,
  StepRun,
  StepDefinition,
  PlanningToolCall,
} from './types.js';

export interface CouncilMember {
  id: string;
  name: string;
  focus: string;
  provider: ProviderId;
  model: string;
  effort: string;
}
export interface CouncilFinding {
  id: string;
  criterion: string;
  severity: 'blocker' | 'warning';
  summary: string;
  evidence: string[];
}
export interface CouncilReport {
  verdict: 'PASS' | 'BLOCKED' | 'NEEDS_EVIDENCE';
  summary: string;
  criteria: {
    id: string;
    status: 'met' | 'unmet' | 'unknown';
    evidence: string[];
  }[];
  findings: CouncilFinding[];
  resolutions: { findingId: string; evidence: string }[];
}
export interface CouncilReview {
  member: CouncilMember;
  status: 'pending' | 'running' | 'completed' | 'failed';
  report?: CouncilReport;
  output: string;
  toolCalls?: PlanningToolCall[];
  error?: string;
  costUsd: number | null;
  startedAt?: string;
  finishedAt?: string;
}
export interface CouncilChair {
  output?: string;
  toolCalls?: PlanningToolCall[];
  startedAt?: string;
  status: 'running' | 'completed' | 'failed';
  summary?: string;
  disputes?: string[];
  error?: string;
  costUsd: number | null;
}
export interface CouncilEvidence {
  validationPacketHash?: string;
  reviewClarifications?: { attempt: number; question: string }[];
  secondOpinion?: { member: CouncilMember; question: string };
  resumeRequested?: boolean;
  obligations?: { memberId: string; findings: CouncilFinding[] }[];
  changes?: {
    baseline: string;
    added: string[];
    modified: string[];
    deleted: string[];
  };
  attempt: number;
  source: string;
  bundleHash: string;
  bundle: string;
  status:
    'running' | 'pass' | 'blocked' | 'needs_evidence' | 'stale' | 'simulated';
  reviewers: CouncilReview[];
  chair?: CouncilChair;
  challenge?: {
    question: string;
    requested: boolean;
    reviewers: CouncilReview[];
    chair?: CouncilChair;
  };
  issues: string[];
  startedAt: string;
  finishedAt?: string;
}

export function councilReviews(evidence: CouncilEvidence): CouncilReview[] {
  return evidence.challenge && !evidence.challenge.requested
    ? evidence.challenge.reviewers
    : evidence.reviewers;
}
export function councilReady(step: StepRun): boolean {
  return (
    !!step.council &&
    step.council.attempt === step.attempt &&
    step.council.status === 'pass' &&
    reviewEvidenceComplete(step.council, step.definition) &&
    councilReviews(step.council).every((r) => r.report?.verdict === 'PASS') &&
    !(
      step.council.challenge && !step.council.challenge.requested
        ? step.council.challenge.chair
        : step.council.chair
    )?.disputes?.length
  );
}

export function reviewEvidenceComplete(
  evidence: CouncilEvidence,
  definition: StepDefinition,
): boolean {
  const configured = definition.council;
  if (!configured || ![1, 3].includes(configured.reviewers.length))
    return false;
  if (
    evidence.secondOpinion &&
    (!configured.secondOpinion ||
      JSON.stringify(configured.secondOpinion) !==
        JSON.stringify(evidence.secondOpinion.member))
  )
    return false;
  const expected = [
    ...configured.reviewers,
    ...(evidence.secondOpinion && configured.secondOpinion
      ? [configured.secondOpinion]
      : []),
  ];
  const reviews = councilReviews(evidence);
  if (
    reviews.length !== expected.length ||
    new Set(reviews.map((r) => r.member.id)).size !== expected.length
  )
    return false;
  if (
    !reviews.every(
      (r) =>
        expected.some((m) => JSON.stringify(m) === JSON.stringify(r.member)) &&
        r.status === 'completed' &&
        r.report &&
        r.report.verdict !== 'NEEDS_EVIDENCE' &&
        r.report.criteria.every((c) => c.status !== 'unknown'),
    )
  )
    return false;
  const chair =
    evidence.challenge && !evidence.challenge.requested
      ? evidence.challenge.chair
      : evidence.chair;
  return reviews.length === 1 || chair?.status === 'completed';
}
