import type { CouncilEvidence } from './council.js';
import { councilReviews } from './council.js';
import type { Run } from './types.js';

export function aggregateCouncil(evidence: CouncilEvidence): void {
  const reviews = councilReviews(evidence);
  const chair =
    evidence.challenge && !evidence.challenge.requested
      ? evidence.challenge.chair
      : evidence.chair;
  const issues: string[] = [];
  for (const review of reviews) {
    if (review.status !== 'completed' || !review.report)
      issues.push(`${review.member.name}: review missing or failed.`);
    else if (review.report.verdict !== 'PASS')
      issues.push(
        `${review.member.name}: ${review.report.verdict}. ${review.report.summary}`,
      );
  }
  if (!reviews.length) issues.push('Required review is missing.');
  if (reviews.length > 1 && chair?.status !== 'completed')
    issues.push('Chair synthesis is missing or failed.');
  if (chair?.disputes?.length)
    issues.push(
      ...chair.disputes.map((dispute) => `Unresolved dispute: ${dispute}`),
    );
  evidence.issues = issues;
  evidence.status = reviews.some((r) => r.report?.verdict === 'BLOCKED')
    ? 'blocked'
    : issues.length
      ? 'needs_evidence'
      : 'pass';
}

export function councilSummary(evidence: CouncilEvidence): string {
  const chair =
    evidence.challenge && !evidence.challenge.requested
      ? evidence.challenge.chair
      : evidence.chair;
  const label =
    evidence.status === 'pass'
      ? 'Review passed'
      : evidence.status === 'running'
        ? 'Reviewing'
        : evidence.status === 'simulated'
          ? 'Simulated'
          : 'BLOCKED';
  const findings = councilReviews(evidence).flatMap(
    (r) =>
      r.report?.findings.map(
        (f) =>
          `- ${r.member.name} / ${f.id} (${f.severity}, ${f.criterion}): ${f.summary}\n  Evidence: ${f.evidence.join('; ')}`,
      ) ?? [],
  );
  const shown = new Set(
    councilReviews(evidence).flatMap(
      (r) =>
        r.report?.findings
          .filter((f) => f.severity === 'blocker')
          .map((f) => `${r.member.id}:${f.id}`) ?? [],
    ),
  );
  findings.push(
    ...unresolvedCouncilFindings(evidence).flatMap((o) =>
      o.findings
        .filter((f) => !shown.has(`${o.memberId}:${f.id}`))
        .map(
          (f) =>
            `- Retained ${o.memberId} / ${f.id} (blocker, ${f.criterion}): ${f.summary}\n  Evidence: ${f.evidence.join('; ')}`,
        ),
    ),
  );
  const single = evidence.reviewers.length === 1;
  return `${label}: ${single ? 'Independent review' : 'Council'}\n\n${chair?.summary ?? (single ? reviewsSummary(evidence) : 'Independent reviews, then a chair synthesis.')}\n\n${evidence.issues.map((i) => `- ${i}`).join('\n')}\n\n${findings.join('\n')}\n\nSource: ${evidence.source}\nEvidence: ${evidence.bundleHash}\nJev signals are advisory; no majority vote can clear a blocker.`;
}

function reviewsSummary(evidence: CouncilEvidence): string {
  return (
    councilReviews(evidence)[0]?.report?.summary ??
    'Inspecting the approved criteria, source and recorded tests.'
  );
}

export function approvedReviewCriteria(run: Run): string[] {
  const plan = run.steps.find((s) => s.definition.planning)?.output ?? '';
  return [...new Set(plan.match(/\bAC\d+\b/g) ?? [])];
}

export function unresolvedCouncilFindings(evidence: CouncilEvidence) {
  return evidence.reviewers
    .map((member) => {
      const findings = new Map(
        (
          evidence.obligations?.find((o) => o.memberId === member.member.id)
            ?.findings ?? []
        ).map((f) => [f.id, f]),
      );
      for (const review of [
        member,
        evidence.challenge?.reviewers.find(
          (r) => r.member.id === member.member.id,
        ),
      ]) {
        if (review?.status !== 'completed' || !review.report) continue;
        for (const resolution of review.report.resolutions)
          findings.delete(resolution.findingId);
        for (const finding of review.report.findings)
          if (finding.severity === 'blocker') findings.set(finding.id, finding);
      }
      return { memberId: member.member.id, findings: [...findings.values()] };
    })
    .filter((o) => o.findings.length);
}
