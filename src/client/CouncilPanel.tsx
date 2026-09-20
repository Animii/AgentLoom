import { useState } from 'react';
import type { CouncilEvidence } from '../shared/council';
import { councilReviews } from '../shared/council';
import AgentOutput from './AgentOutput';
import ReplyWithTools from './ReplyWithTools';

export default function CouncilPanel({ evidence, onChallenge, busy = false }: { evidence: CouncilEvidence; onChallenge?: (question: string) => Promise<void>; busy?: boolean }) {
  const [question, setQuestion] = useState('');
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const reviews = councilReviews(evidence);
  const chair = evidence.challenge && !evidence.challenge.requested ? evidence.challenge.chair : evidence.chair;
  const findings = new Map<string, { summary: string; severity: string; sources: { member: string; id: string; criterion: string; evidence: string[] }[] }>();
  for (const review of reviews) for (const finding of review.report?.findings ?? []) {
    const key = `${finding.criterion}:${finding.summary.trim().toLowerCase()}`;
    const grouped = findings.get(key) ?? { summary: finding.summary, severity: finding.severity, sources: [] };
    if (finding.severity === 'blocker') grouped.severity = 'blocker';
    grouped.sources.push({ member: review.member.name, id: finding.id, criterion: finding.criterion, evidence: finding.evidence }); findings.set(key, grouped);
  }
  const title = { running: 'Reviewing independently', pass: 'Ready for your approval', blocked: 'Changes required', needs_evidence: 'More evidence needed', stale: 'Review is out of date', simulated: 'Simulated council' }[evidence.status];
  return <section className="council-panel" aria-label="Outcome council">
    <div className="council-heading"><h3>Outcome council</h3><strong role="status">{title}</strong></div>
    <p>{chair?.summary ?? 'Three separate reviews of the same source and evidence, followed by a chair synthesis.'}</p>
    <div className="council-members">{reviews.map(review => <details key={review.member.id}>
      <summary><strong>{review.member.name}</strong><span>{review.status === 'completed' ? review.report?.verdict.replaceAll('_', ' ') : review.status}</span></summary>
      <p className="quiet">{review.member.provider} · {review.member.model} · {review.member.effort}</p>
      {review.error && <p role="alert">{review.error}</p>}
      {review.report && <><p>{review.report.summary}</p><ul>{review.report.criteria.map(criterion => <li key={criterion.id}><strong>{criterion.id} · {criterion.status}</strong><p>{criterion.evidence.join('; ')}</p></li>)}</ul>{review.report.resolutions.map(resolution => <p key={resolution.findingId}><strong>Resolved {resolution.findingId}:</strong> {resolution.evidence}</p>)}</>}
      <p className="quiet">{review.costUsd === null ? 'Cost not reported' : `$${review.costUsd.toFixed(4)}`} {review.finishedAt && `· Finished ${new Date(review.finishedAt).toLocaleTimeString()}`}</p>
      {review.status === 'running' ? <ReplyWithTools text={review.output} calls={review.toolCalls ?? []} events={[]} since={review.startedAt ?? ''} live={evidence.status === 'running'} running={evidence.status === 'running'} activeSince={review.startedAt ?? null} /> : (review.output || review.toolCalls?.length) ? <details><summary>Full response and tool calls</summary><ReplyWithTools text={review.output} calls={review.toolCalls ?? []} events={[]} since={review.startedAt ?? ''} live={false} running={false} activeSince={null} /></details> : null}
    </details>)}</div>
    {chair && <details className="council-chair"><summary>Chair synthesis &middot; {chair.status}</summary><ReplyWithTools text={chair.output ?? chair.summary ?? ''} calls={chair.toolCalls ?? []} events={[]} since={chair.startedAt ?? ''} live={chair.status === 'running' && evidence.status === 'running'} running={chair.status === 'running' && evidence.status === 'running'} activeSince={chair.startedAt ?? null} /></details>}
    {findings.size > 0 && <div className="council-findings"><h4>{findings.size} unique finding{findings.size === 1 ? '' : 's'}</h4>{[...findings].map(([key, finding]) => <details key={key}><summary><strong>{finding.severity}</strong> · {finding.summary}</summary>{finding.sources.map(source => <div key={`${source.member}:${source.id}`}><p><strong>{source.member} / {source.id} · {source.criterion}</strong></p><ul>{source.evidence.map((ref, i) => <li key={i}>{ref}</li>)}</ul></div>)}</details>)}</div>}
    {evidence.issues.length > 0 && <details className="council-issues" open><summary>What needs resolving</summary><ul>{evidence.issues.map((issue, i) => <li key={i}>{issue}</li>)}</ul></details>}
    <details><summary>Evidence and review history</summary><p className="quiet">Source {evidence.source}<br />Bundle {evidence.bundleHash}</p>{evidence.changes ? <><p>Changes since the run started: {evidence.changes.added.length} added, {evidence.changes.modified.length} modified, {evidence.changes.deleted.length} deleted.</p><ul>{(['added','modified','deleted'] as const).flatMap(kind=>evidence.changes![kind].map(file=><li key={`${kind}:${file}`}>{kind}: {file}</li>))}</ul></> : <p>No pre-implementation baseline was recorded for this older run.</p>}<p>Separate source copies and first-pass contexts. Full shell access is enabled; these copies are not a security sandbox. Jev has no approval vote.</p>{chair?.error && <p>Chair: {chair.error}</p>}{evidence.challenge && <><p><strong>Focused challenge:</strong> {evidence.challenge.question}</p>{evidence.reviewers.map(review => <details key={review.member.id}><summary>Initial {review.member.name}: {review.report?.verdict ?? review.status}</summary><AgentOutput text={review.output || review.error || 'No report.'} /></details>)}</>}</details>
    {onChallenge && !evidence.challenge && !['running', 'stale', 'simulated'].includes(evidence.status) && <div className="council-challenge">
      <button type="button" className="btn secondary" disabled={busy} onClick={() => setOpen(!open)}>Request evidence</button>
      {open && <form onSubmit={event => { event.preventDefault(); setError(''); void onChallenge(question).then(() => { setOpen(false); setQuestion(''); }).catch(error => setError(error instanceof Error ? error.message : 'Unable to request evidence.')); }}><label>Focused question<textarea value={question} onChange={event => setQuestion(event.target.value)} maxLength={8000} required rows={3} /></label><p className="quiet">One challenge round on this revision. Reviewers must provide counter-evidence to withdraw a blocker.</p><button className="btn primary" disabled={busy || !question.trim()}>Ask council</button>{error && <p role="alert">{error}</p>}</form>}
    </div>}
    {evidence.challenge && <p className="quiet">Focused challenge {evidence.status === 'running' ? 'in progress' : 'used'}. Unresolved findings require implementation work or a clarified new run.</p>}
    <p className="quiet">Approval requires passing validation, current evidence, and resolved blockers and disputes. You make the final decision.</p>
  </section>;
}
