import { useState } from 'react';
import type { Run, StepRun } from '../shared/types';
import { assessmentAdvice, canAssessReview } from '../shared/review-assessment';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function errorMessage(value: unknown, fallback: string): string {
  return isRecord(value) &&
    typeof value.error === 'string' &&
    value.error !== ''
    ? value.error
    : fallback;
}

export default function ReviewAdvice({
  run,
  step,
  onDraft,
}: {
  run: Run;
  step: StepRun;
  onDraft: (text: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!canAssessReview(step)) return null;
  const assessment =
    step.assessment?.attempt === step.attempt ? step.assessment : undefined;
  const advice = assessment?.category
    ? assessmentAdvice[assessment.category]
    : undefined;
  async function classify() {
    setBusy(true);
    setError('');
    try {
      const response = await fetch(
        `/api/runs/${encodeURIComponent(run.id)}/steps/${encodeURIComponent(step.definition.id)}/assessment`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        },
      );
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        throw Error(errorMessage(body, 'Classification failed'));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Classification failed');
    } finally {
      setBusy(false);
    }
  }
  return (
    <aside className="review-advice" aria-label="Jev review assessment">
      <strong>Jev assessment{advice ? ` · ${advice.label}` : ''}</strong>
      {assessment?.status === 'running' ? (
        <p>Classifying review findings…</p>
      ) : assessment && advice ? (
        <>
          <p>{advice.advice}</p>
          <p className="field-helper">
            Classification confidence{' '}
            {Math.round((assessment.confidence ?? 0) * 100)}% ·{' '}
            {assessment.model}. Advisory only; you decide the next action.
          </p>
          {assessment.category !== 'no_blocker' &&
            assessment.category !== 'code_fix' && (
              <button
                type="button"
                className="btn secondary"
                onClick={() => {
                  onDraft(
                    `Jev classified this review as ${advice.label.toLowerCase()}. ${advice.advice} Please identify the concrete next steps and any decision you need from me.`,
                  );
                }}
              >
                Draft follow-up
              </button>
            )}
        </>
      ) : (
        <p>
          {assessment?.message ??
            'Classify these findings to help choose the next action.'}
        </p>
      )}
      {assessment?.status !== 'running' && (
        <button
          className="btn ghost"
          type="button"
          disabled={busy}
          onClick={() => void classify()}
        >
          {busy
            ? 'Classifying…'
            : assessment?.status === 'ready'
              ? 'Classify again'
              : 'Classify with Jev'}
        </button>
      )}
      <p className="field-helper">
        Sends the task and review text to TypeSafe using your saved Jev key. No
        files are sent. Configure the key under Agents.
      </p>
      {error && <p role="alert">{error}</p>}
    </aside>
  );
}
