import type { ProviderId, StepRun, PlanningToolCall } from './types.js';

export interface CouncilMember { id: string; name: string; focus: string; provider: ProviderId; model: string; effort: string }
export interface CouncilFinding { id: string; criterion: string; severity: 'blocker' | 'warning'; summary: string; evidence: string[] }
export interface CouncilReport {
  verdict: 'PASS' | 'BLOCKED' | 'NEEDS_EVIDENCE';
  summary: string;
  criteria: { id: string; status: 'met' | 'unmet' | 'unknown'; evidence: string[] }[];
  findings: CouncilFinding[];
  resolutions: { findingId: string; evidence: string }[];
}
export interface CouncilReview {
  member: CouncilMember; status: 'pending' | 'running' | 'completed' | 'failed';
  report?: CouncilReport; output: string; toolCalls?: PlanningToolCall[]; error?: string; costUsd: number | null;
  startedAt?: string; finishedAt?: string;
}
export interface CouncilChair { output?: string; toolCalls?: PlanningToolCall[]; startedAt?: string; status: 'running' | 'completed' | 'failed'; summary?: string; disputes?: string[]; error?: string; costUsd: number | null }
export interface CouncilEvidence {
  resumeRequested?: boolean;
  obligations?: {memberId:string;findings:CouncilFinding[]}[];
  changes?: { baseline:string; added:string[]; modified:string[]; deleted:string[] };
  attempt: number; source: string; bundleHash: string; bundle: string;
  status: 'running' | 'pass' | 'blocked' | 'needs_evidence' | 'stale' | 'simulated';
  reviewers: CouncilReview[]; chair?: CouncilChair;
  challenge?: { question: string; requested: boolean; reviewers: CouncilReview[]; chair?: CouncilChair };
  issues: string[]; startedAt: string; finishedAt?: string;
}

export function councilReviews(evidence: CouncilEvidence): CouncilReview[] {
  return evidence.challenge && !evidence.challenge.requested ? evidence.challenge.reviewers : evidence.reviewers;
}
export function councilReady(step: StepRun): boolean {
  return !!step.council && step.council.attempt === step.attempt && step.council.status === 'pass';
}
