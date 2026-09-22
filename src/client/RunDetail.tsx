import { secondOpinionAvailable } from '../shared/automation';
import { needsTriage, triagePassed } from '../shared/crates';
import CouncilPanel from './CouncilPanel';
import ValidationPanel from './ValidationPanel';
import GitRunPanel from './GitRunPanel';
import AutomationPanel from './AutomationPanel';
import { uncertainAssessmentToken } from '../shared/review-assessment';
import ReviewAdvice from './ReviewAdvice';
import ToolCalls from './ToolCalls';
import { stepToolCalls } from '../shared/native-tools';
import { reworkTarget } from '../shared/rework';
import { useEffect, useId, useState } from 'react';
import type { Run, RunEvent } from '../shared/types.js';
import AgentOutput from './AgentOutput';
import PlanningChat from './PlanningChat';
import { useUrlState, useUrlSelection, updateUrl } from './url-state';
import { isPlanningStep } from '../shared/planning';

type TabId = 'output' | 'activity' | 'files';
type ActivityScope = 'step' | 'all';
type RunAction = 'approve' | 'revise' | 'rework' | 'retry' | 'cancel';

interface RunDetailProps {
  run: Run;
  events: RunEvent[];
  busy: boolean;
  onAction: (
    action: RunAction,
    feedback?: string,
    acknowledgedAssessment?: string,
  ) => Promise<void>;
  onBack: () => void;
  onMessage: (stepId: string, text: string, messageId: string) => Promise<void>;
}

const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: 'output', label: 'Output' },
  { id: 'activity', label: 'Activity' },
  { id: 'files', label: 'Files' },
];

function readableStatus(status: string): string {
  if (status === 'waiting_input') return 'Waiting for your reply';
  const label = status.replace(/_/g, ' ');
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function readBody(
  response: Response,
): Promise<{ parsed: unknown; text: string }> {
  const text = await response.text();
  let parsed: unknown = null;
  if (text !== '') {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  return { parsed, text };
}

function extractFiles(parsed: unknown): string[] {
  const candidate = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.files)
      ? parsed.files
      : [];
  return candidate.flatMap((item): string[] => {
    if (typeof item === 'string') return [item];
    if (isRecord(item) && typeof item.path === 'string') return [item.path];
    return [];
  });
}

function extractContent(parsed: unknown, text: string): string {
  if (typeof parsed === 'string') return parsed;
  if (isRecord(parsed) && typeof parsed.content === 'string')
    return parsed.content;
  return text;
}

export default function RunDetail({
  run,
  events,
  busy,
  onAction,
  onBack,
  onMessage,
}: RunDetailProps) {
  const currentStepIndex = Math.min(
    run.currentStep,
    Math.max(0, run.steps.length - 1),
  );
  const tabsId = useId();
  const revisionFieldId = `${tabsId}-revision-feedback`;

  const [tab, setTab] = useUrlState<TabId>('tab', 'output', [
    'output',
    'activity',
    'files',
  ]);
  const [selectedStepParam, setSelectedStepParam] = useUrlState<string>(
    'step',
    '',
  );
  const matchingStep = run.steps.findIndex(
    (step) => step.definition.id === selectedStepParam,
  );
  const activeStep = matchingStep >= 0 ? matchingStep : currentStepIndex;
  const setActiveStep = (index: number) => {
    setSelectedStepParam(
      index === currentStepIndex ? '' : (run.steps[index]?.definition.id ?? ''),
    );
  };
  const [activityScope, setActivityScope] = useUrlState<ActivityScope>(
    'activity',
    'step',
    ['step', 'all'],
  );
  const [showRevision, setShowRevision] = useState(false);
  const [draftSuggestion, setDraftSuggestion] = useState<{
    stepId: string;
    text: string;
    nonce: number;
  } | null>(null);
  const [acknowledgedAssessment, setAcknowledgedAssessment] = useState<
    string | null
  >(null);
  const uncertaintyToken = uncertainAssessmentToken(run.steps[run.currentStep]);
  const assessmentPending =
    run.steps[run.currentStep]?.assessment?.attempt ===
      run.steps[run.currentStep]?.attempt &&
    run.steps[run.currentStep]?.assessment?.status === 'running';
  const [feedback, setFeedback] = useState('');
  const [files, setFiles] = useState<string[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [selectedFilePath, setSelectedFilePath] = useUrlSelection('file');
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

  useEffect(() => {
    setFeedback('');
    setShowRevision(false);
    setFileContent(null);
    setFileError(null);
    setFiles([]);
    setFilesError(null);
  }, [run.id]);

  useEffect(() => {
    if (tab !== 'files') return;
    const controller = new AbortController();
    let active = true;
    setFilesLoading(true);
    setFilesError(null);
    fetch(`/api/runs/${encodeURIComponent(run.id)}/files`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok)
          throw new Error(
            `Unable to load files (HTTP ${String(response.status)}).`,
          );
        const { parsed } = await readBody(response);
        if (active) setFiles(extractFiles(parsed));
      })
      .catch((error: unknown) => {
        if (!active || controller.signal.aborted) return;
        setFilesError(
          error instanceof Error ? error.message : 'Unable to load files.',
        );
      })
      .finally(() => {
        if (active) setFilesLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [tab, run.id]);

  useEffect(() => {
    if (tab !== 'files' || selectedFilePath === null) return;
    const controller = new AbortController();
    let active = true;
    setFileLoading(true);
    setFileError(null);
    setFileContent(null);
    fetch(
      `/api/runs/${encodeURIComponent(run.id)}/file?path=${encodeURIComponent(selectedFilePath)}`,
      {
        signal: controller.signal,
      },
    )
      .then(async (response) => {
        if (!response.ok)
          throw new Error(
            `Unable to load file (HTTP ${String(response.status)}).`,
          );
        const { parsed, text } = await readBody(response);
        if (active) setFileContent(extractContent(parsed, text));
      })
      .catch((error: unknown) => {
        if (!active || controller.signal.aborted) return;
        setFileError(
          error instanceof Error ? error.message : 'Unable to load file.',
        );
      })
      .finally(() => {
        if (active) setFileLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [tab, run.id, selectedFilePath]);

  const selectedStep = run.steps[activeStep] ?? run.steps[currentStepIndex];
  const planning = isPlanningStep(selectedStep.definition);
  // Completed runs advance currentStep past the final element.
  const currentStep = run.steps.at(run.currentStep);
  const currentPlanning = currentStep
    ? isPlanningStep(currentStep.definition)
    : false;
  const selectedStepId = selectedStep.definition.id;
  const visibleEvents =
    activityScope === 'all'
      ? events
      : events.filter((event) => event.stepId === selectedStepId);

  const repairTarget = reworkTarget(run);
  const isWaitingApproval = run.status === 'waiting_approval';
  const isBlocked = run.status === 'blocked';
  const canCancel =
    run.status === 'queued' ||
    run.status === 'running' ||
    run.status === 'waiting_input' ||
    isWaitingApproval ||
    isBlocked;
  const canRetry = run.status === 'failed' || run.status === 'interrupted';
  const showFooter = isWaitingApproval || isBlocked || canCancel || canRetry;

  function runAction(action: RunAction): void {
    void onAction(
      action,
      undefined,
      action === 'approve' && acknowledgedAssessment === uncertaintyToken
        ? acknowledgedAssessment
        : undefined,
    ).catch(() => {
      /* The parent displays the action error. */
    });
  }

  function sendRevision(): void {
    const text = feedback.trim();
    if (text === '' || busy) return;
    void onAction('revise', text)
      .then(() => {
        setShowRevision(false);
        setFeedback('');
      })
      .catch(() => {
        /* Keep the draft so the user can retry. */
      });
  }

  return (
    <section className="run-detail" aria-busy={busy || undefined}>
      <header className="detail-header">
        <div className="detail-heading">
          <button
            type="button"
            className="btn ghost back-to-runs"
            onClick={onBack}
            disabled={busy}
          >
            Back to runs
          </button>
          <h1 className="detail-title" tabIndex={-1}>
            {run.title}
          </h1>
          <p className="detail-subtitle">
            {run.workflowName}
            {' \u00b7 '}
            {run.projectLocation?.name ?? run.project}
          </p>
          {run.projectLocation && (
            <p className="project-path">
              {run.projectLocation.workspaceMode === 'worktree'
                ? 'Git worktree'
                : run.projectLocation.workspaceMode === 'direct'
                  ? 'Direct folder'
                  : 'Isolated copy'}{' '}
              · {run.projectLocation.hostPath}
              {run.projectLocation.workspaceMode === 'direct'
                ? ' · Files shows the current folder contents.'
                : ''}
            </p>
          )}
        </div>
        <div className="detail-status">
          <span className={`status-chip mode-chip mode-${run.mode}`}>
            {run.mode === 'demo' ? 'Demo' : 'Live'}
          </span>
          <span className={`status-chip status-${run.status}`}>
            {readableStatus(run.status)}
          </span>
        </div>
      </header>

      {run.error ? (
        <div className="error-banner" role="alert">
          {run.error}
        </div>
      ) : null}

      <ol className="step-list">
        {run.steps.map((step, index) => {
          const isActive = step === selectedStep;
          return (
            <li key={`${step.definition.id}-${String(index)}`}>
              <button
                type="button"
                className={`step-row${isActive ? ' step-active' : ''}`}
                aria-current={isActive ? 'step' : undefined}
                onClick={() => {
                  setActiveStep(index);
                }}
                disabled={busy}
              >
                <span className="step-name">
                  {index + 1}. {step.definition.name}
                </span>
                <span className={`status-chip status-${step.status}`}>
                  {readableStatus(step.status)}
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      <div className="run-context">
        <details>
          <summary>Task brief</summary>
          <p className="task-brief">{run.task}</p>
        </details>
        <details className="step-details">
          <summary>Step details · {selectedStep.definition.name}</summary>
          <dl className="metadata-list">
            <div>
              <dt>Provider</dt>
              <dd>{selectedStep.definition.provider}</dd>
            </div>
            <div>
              <dt>Model</dt>
              <dd>{selectedStep.definition.model || 'CLI default'}</dd>
            </div>
            <div>
              <dt>Effort</dt>
              <dd>{selectedStep.definition.effort || 'Default'}</dd>
            </div>
            <div>
              <dt>Role</dt>
              <dd>{selectedStep.definition.role}</dd>
            </div>
            <div>
              <dt>Attempt</dt>
              <dd className="step-attempt">attempt {selectedStep.attempt}</dd>
            </div>
            {selectedStep.costUsd !== null && (
              <div>
                <dt>Cost</dt>
                <dd>${selectedStep.costUsd.toFixed(4)}</dd>
              </div>
            )}
          </dl>
        </details>
      </div>

      <div className="tabs" role="tablist" aria-label="Run details">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`${tabsId}-tab-${item.id}`}
            aria-selected={tab === item.id}
            aria-controls={`${tabsId}-panel-${item.id}`}
            className={`tab${tab === item.id ? ' tab-active' : ''}`}
            tabIndex={tab === item.id ? 0 : -1}
            onKeyDown={(event) => {
              if (
                !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)
              )
                return;
              event.preventDefault();
              const index = TABS.findIndex((t) => t.id === tab);
              const next =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? TABS.length - 1
                    : (index +
                        (event.key === 'ArrowRight' ? 1 : -1) +
                        TABS.length) %
                      TABS.length;
              setTab(TABS[next].id);
              document
                .getElementById(`${tabsId}-tab-${TABS[next].id}`)
                ?.focus();
            }}
            onClick={() => {
              setTab(item.id);
            }}
          >
            {item.id === 'output' && planning ? 'Conversation' : item.label}
          </button>
        ))}
      </div>

      <div
        className="tab-panel"
        role="tabpanel"
        id={`${tabsId}-panel-${tab}`}
        aria-labelledby={`${tabsId}-tab-${tab}`}
      >
        {tab === 'output' ? (
          <div className="output-pane">
            {selectedStep.history?.map((attempt, index) => (
              <details key={index} className="previous-attempt">
                <summary>
                  Previous attempt {attempt.attempt} (
                  {attempt.status.replaceAll('_', ' ')})
                </summary>
                <ToolCalls
                  calls={stepToolCalls(
                    {
                      ...selectedStep,
                      ...attempt,
                      toolCalls: attempt.toolCalls ?? [],
                    },
                    events.filter(
                      (event) =>
                        !attempt.finishedAt ||
                        event.timestamp <= attempt.finishedAt,
                    ),
                  )}
                  running={false}
                  activeSince={null}
                />
                {attempt.council && <CouncilPanel evidence={attempt.council} />}
                {attempt.validation && (
                  <ValidationPanel evidence={attempt.validation} />
                )}
                {attempt.conversation?.length ? (
                  attempt.conversation.map((item) => (
                    <div key={item.id}>
                      <strong>
                        {item.role === 'user'
                          ? 'You'
                          : selectedStep.definition.name}
                      </strong>
                      <AgentOutput text={item.content} />
                    </div>
                  ))
                ) : (
                  <AgentOutput
                    text={
                      attempt.output || attempt.error || 'No output recorded.'
                    }
                  />
                )}
              </details>
            ))}
            {(selectedStep.history?.length ?? 0) > 0 && (
              <p className="current-attempt-label">
                Current attempt {selectedStep.attempt}
              </p>
            )}
            {selectedStep.error ? (
              <div className="error-banner" role="alert">
                {selectedStep.error}
              </div>
            ) : null}
            {selectedStep.council && (
              <CouncilPanel
                key={`${run.id}-${String(selectedStep.attempt)}`}
                evidence={selectedStep.council}
                busy={busy}
                onSecondOpinion={
                  activeStep === run.currentStep &&
                  ['blocked', 'waiting_approval'].includes(run.status) &&
                  secondOpinionAvailable(run) &&
                  !selectedStep.council.secondOpinion
                    ? async (question) => {
                        const response = await fetch(
                          `/api/runs/${run.id}/second-opinion`,
                          {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ question }),
                          },
                        );
                        if (!response.ok) {
                          const body: unknown = await response
                            .json()
                            .catch(() => null);
                          throw Error(
                            isRecord(body) && typeof body.error === 'string'
                              ? body.error
                              : 'Unable to request second opinion.',
                          );
                        }
                      }
                    : undefined
                }
                onChallenge={
                  activeStep === run.currentStep &&
                  ['blocked', 'waiting_approval'].includes(run.status)
                    ? (question) =>
                        onMessage(
                          selectedStep.definition.id,
                          question,
                          crypto.randomUUID(),
                        )
                    : undefined
                }
              />
            )}
            {selectedStep.validation && (
              <ValidationPanel evidence={selectedStep.validation} />
            )}
            {!selectedStep.definition.council && (
              <PlanningChat
                key={`${run.id}-${selectedStep.definition.id}`}
                run={run}
                step={selectedStep}
                events={events}
                current={activeStep === run.currentStep}
                busy={busy}
                onSend={onMessage}
                draftSuggestion={
                  draftSuggestion?.stepId === selectedStep.definition.id
                    ? draftSuggestion
                    : null
                }
              />
            )}
          </div>
        ) : null}

        {tab === 'activity' ? (
          <div className="activity-pane">
            <div
              className="activity-filters"
              role="group"
              aria-label="Activity filter"
            >
              <button
                type="button"
                className="btn ghost"
                aria-pressed={activityScope === 'step'}
                onClick={() => {
                  setActivityScope('step');
                }}
              >
                Selected step
              </button>
              <button
                type="button"
                className="btn ghost"
                aria-pressed={activityScope === 'all'}
                onClick={() => {
                  setActivityScope('all');
                }}
              >
                All events
              </button>
            </div>
            <ul className="activity-list">
              {visibleEvents.map((event) => (
                <li
                  key={event.id}
                  className={`activity-item activity-${event.type}`}
                >
                  <time
                    className="activity-time"
                    dateTime={new Date(event.timestamp).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                    })}
                  >
                    {new Date(event.timestamp).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                    })}
                  </time>
                  <span className="activity-type">{event.type}</span>
                  <span className="activity-message">{event.message}</span>
                </li>
              ))}
            </ul>
            {visibleEvents.length === 0 ? (
              <p className="empty-note">No activity to display.</p>
            ) : null}
          </div>
        ) : null}

        {tab === 'files' ? (
          <div className="files-pane">
            {filesError ? (
              <div className="error-banner" role="alert">
                {filesError}
              </div>
            ) : null}
            {filesLoading ? (
              <p className="empty-note">{'Loading files\u2026'}</p>
            ) : null}
            {!filesLoading && !filesError && files.length === 0 ? (
              <p className="empty-note">No files available yet.</p>
            ) : null}
            <div className="file-list">
              {files.map((file) => (
                <button
                  key={file}
                  type="button"
                  className={`btn secondary file-button${
                    selectedFilePath === file ? ' file-selected' : ''
                  }`}
                  aria-pressed={selectedFilePath === file}
                  onClick={() => {
                    setSelectedFilePath(file);
                  }}
                  disabled={fileLoading}
                >
                  {file}
                </button>
              ))}
            </div>
            {selectedFilePath !== null ? (
              <div className="file-viewer">
                <h3 className="file-name">{selectedFilePath}</h3>
                {fileError ? (
                  <div className="error-banner" role="alert">
                    {fileError}
                  </div>
                ) : null}
                {fileLoading ? (
                  <p className="empty-note">{'Loading file\u2026'}</p>
                ) : null}
                {!fileLoading && !fileError ? (
                  <pre className="output-pane-text">{fileContent ?? ''}</pre>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {!selectedStep.definition.validation &&
        run.steps.some((s) => s.validation) && (
          <details className="validation-summary">
            <summary>Validation evidence and Jev signals</summary>
            {run.steps.map((s) =>
              s.validation ? (
                <ValidationPanel
                  key={s.definition.id}
                  evidence={s.validation}
                />
              ) : null,
            )}
          </details>
        )}
      {run.git && <GitRunPanel run={run} />}
      <AutomationPanel run={run} />
      <ReviewAdvice
        run={run}
        step={selectedStep}
        onDraft={(text) => {
          setDraftSuggestion({
            stepId: selectedStep.definition.id,
            text,
            nonce: Date.now(),
          });
          setTab('output');
        }}
      />
      {showFooter ? (
        <footer className="approval-bar">
          {needsTriage(run) && !triagePassed(run) && (
            <p className="approval-context">
              Triage is required before approval.{' '}
              <button
                className="btn"
                onClick={() => {
                  updateUrl({
                    view: 'crates',
                    crateNode: 'triage',
                    crateTab: 'brief',
                  });
                }}
              >
                Open triage
              </button>
            </p>
          )}
          {isWaitingApproval && (
            <p className="approval-context">
              {run.steps[run.currentStep]?.definition.name} is ready for review.{' '}
              {run.steps[run.currentStep + 1]
                ? `Approval starts ${run.steps[run.currentStep + 1].definition.name}.`
                : 'Approval completes this run.'}
            </p>
          )}
          {repairTarget >= 0 &&
            !run.crate &&
            activeStep === run.currentStep && (
              <div>
                <button
                  type="button"
                  className="btn primary"
                  disabled={busy || showRevision}
                  onClick={() => {
                    void onAction('rework')
                      .then(() => {
                        updateUrl({ step: null, tab: null });
                      })
                      .catch(() => {});
                  }}
                >
                  Send to implementer
                </button>
                <p className="approval-context">
                  Sends these findings to{' '}
                  {run.steps[repairTarget].definition.name}, then repeats
                  validation and review. Existing approval gates stay in place.
                </p>
              </div>
            )}
          {isBlocked && (
            <p className="approval-context">
              {selectedStep.definition.council
                ? 'Resolve review findings with a focused evidence request or send them to the implementer.'
                : 'This step is blocked. Send revised instructions to continue.'}
            </p>
          )}
          {(isWaitingApproval || isBlocked) &&
            activeStep !== run.currentStep && (
              <button
                type="button"
                className="btn primary"
                onClick={() => {
                  updateUrl({ step: null, tab: null });
                }}
              >
                Review current step
              </button>
            )}
          {isWaitingApproval &&
            activeStep === run.currentStep &&
            uncertaintyToken && (
              <label className="uncertainty-acknowledgment">
                <input
                  type="checkbox"
                  checked={acknowledgedAssessment === uncertaintyToken}
                  onChange={(event) => {
                    setAcknowledgedAssessment(
                      event.target.checked ? uncertaintyToken : null,
                    );
                  }}
                />{' '}
                I understand Jev is uncertain. I have reviewed the evidence and
                want to approve anyway.
              </label>
            )}
          {isWaitingApproval && assessmentPending && (
            <p className="approval-context">
              Waiting for Jev assessment before approval.
            </p>
          )}
          {isWaitingApproval && activeStep === run.currentStep ? (
            <button
              type="button"
              className="btn primary"
              onClick={() => {
                runAction('approve');
              }}
              disabled={
                busy ||
                showRevision ||
                assessmentPending ||
                (needsTriage(run) && !triagePassed(run)) ||
                run.crate?.join === 'waiting' ||
                Boolean(
                  uncertaintyToken &&
                  acknowledgedAssessment !== uncertaintyToken,
                )
              }
            >
              {currentPlanning
                ? 'Approve plan and continue'
                : 'Approve and continue'}
            </button>
          ) : null}

          {(isWaitingApproval || isBlocked) &&
          activeStep === run.currentStep &&
          !currentPlanning &&
          !selectedStep.definition.council ? (
            <button
              type="button"
              className="btn secondary"
              onClick={() => {
                setShowRevision((value) => !value);
              }}
              aria-expanded={showRevision}
              aria-controls={showRevision ? revisionFieldId : undefined}
              disabled={busy}
            >
              Request revision
            </button>
          ) : null}

          {showRevision &&
          activeStep === run.currentStep &&
          (isWaitingApproval || isBlocked) ? (
            <div className="revision-form">
              <label htmlFor={revisionFieldId}>Revision feedback</label>
              <textarea
                id={revisionFieldId}
                className="field"
                value={feedback}
                onChange={(event) => {
                  setFeedback(event.target.value);
                }}
                disabled={busy}
              />
              <button
                type="button"
                className="btn primary"
                onClick={sendRevision}
                disabled={busy || feedback.trim() === ''}
              >
                Send revision
              </button>
            </div>
          ) : null}

          {canRetry ? (
            <button
              type="button"
              className="btn secondary"
              onClick={() => {
                runAction('retry');
              }}
              disabled={busy}
            >
              Retry step
            </button>
          ) : null}

          {canCancel ? (
            <button
              type="button"
              className="btn danger"
              onClick={() => {
                runAction('cancel');
              }}
              disabled={busy}
            >
              Cancel
            </button>
          ) : null}
        </footer>
      ) : null}
    </section>
  );
}
