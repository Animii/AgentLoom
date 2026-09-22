import { useState } from 'react';
import { Package, GitBranch, ArrowRight, Plus } from 'lucide-react';
import type { Run, RunEvent } from '../shared/types';
import { crateStatus, needsTriage, triagePassed } from '../shared/crates';
import { reworkTarget } from '../shared/rework';
import { useUrlState, updateUrl } from './url-state';
import RunDetail from './RunDetail';
import AgentOutput from './AgentOutput';
import ValidationPanel from './ValidationPanel';

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

interface Props {
  runs: Run[];
  selected: Run | null;
  loading: boolean;
  events: RunEvent[];
  busy: boolean;
  onOpen: (id: string) => void;
  onNew: () => void;
  refresh: () => Promise<void>;
  onAction: (
    action: 'approve' | 'revise' | 'rework' | 'retry' | 'cancel',
    feedback?: string,
    ack?: string,
  ) => Promise<void>;
  onMessage: (stepId: string, text: string, messageId: string) => Promise<void>;
}
export default function CratesView({
  runs,
  selected: run,
  loading,
  events,
  busy,
  onOpen,
  onNew,
  refresh,
  onAction,
  onMessage,
}: Props) {
  const [search, setSearch] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [node, setNode] = useUrlState<string>('crateNode', '');
  const [tab, setTab] = useUrlState<'brief' | 'evidence' | 'history' | 'chat'>(
    'crateTab',
    'brief',
    ['brief', 'evidence', 'history', 'chat'],
  );
  const [reason, setReason] = useState('');
  const [splitting, setSplitting] = useState(false);
  const [children, setChildren] = useState([
    { title: '', task: '' },
    { title: '', task: '' },
  ]);
  const roots = runs.filter(
    (r) =>
      !r.crate?.parentId &&
      `${r.title} ${r.projectLocation?.name ?? r.project}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const parentId = run?.crate?.parentId;
  const parent = parentId ? runs.find((r) => r.id === parentId) : undefined;
  const childRuns =
    run?.crate?.childIds
      .map((id) => runs.find((r) => r.id === id))
      .filter((r): r is Run => !!r) ?? [];
  const current = run?.steps[Math.min(run.currentStep, run.steps.length - 1)];
  const selectedStep =
    run?.steps.find((s) => s.definition.id === node) ?? current;
  const triage = !!run && needsTriage(run);
  const ready = !!run && triagePassed(run);
  const activeNode =
    node ||
    (triage && !ready
      ? 'triage'
      : run?.git?.prUrl && run.status === 'completed'
        ? 'pr'
        : (current?.definition.id ?? ''));
  const blocked = busy || pending;
  async function action(name: string, body: object = {}) {
    if (!run) return;
    setPending(true);
    setError('');
    try {
      const response = await fetch(`/api/runs/${run.id}/${name}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data: unknown = await response.json();
      if (!response.ok) throw Error(errorMessage(data, 'Crate action failed.'));
      await refresh();
      return data;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Crate action failed.');
      return null;
    } finally {
      setPending(false);
    }
  }
  function select(id: string) {
    setNode(id);
    if (run?.steps.some((s) => s.definition.id === id)) updateUrl({ step: id });
    setReason('');
    setError('');
  }
  function open(id: string) {
    setSplitting(false);
    setReason('');
    setError('');
    onOpen(id);
  }
  async function route(
    choice: 'approve' | 'repair' | 'clarify' | 'dismiss',
    eventId?: string,
  ) {
    const data = await action('crate-triage', {
      action: choice,
      reason,
      eventId,
    });
    if (data) {
      setReason('');
      select(
        choice === 'approve' ? 'approval' : choice === 'repair' ? '' : 'triage',
      );
    }
  }
  const nodeButton = (
    id: string,
    title: string,
    status: string,
    description: string,
  ) => (
    <button
      type="button"
      key={id}
      className={`crate-node${activeNode === id ? ' selected' : ''}`}
      aria-pressed={activeNode === id}
      onClick={() => {
        select(id);
      }}
    >
      <span>
        <strong>{title}</strong>
        <small>{status}</small>
      </span>
      <p>{description}</p>
    </button>
  );
  return (
    <div className="crates-layout">
      <aside className="crates-sidebar" aria-label="Crate list">
        <div className="crates-side-title">
          <h1>Crates</h1>
          <button className="btn ghost" aria-label="New crate" onClick={onNew}>
            <Plus size={17} />
          </button>
        </div>
        <label className="sr-only" htmlFor="crate-search">
          Find a crate
        </label>
        <input
          id="crate-search"
          placeholder="Find a crate…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
          }}
        />
        <div className="crate-list">
          {roots.map((r) => (
            <button
              key={r.id}
              aria-pressed={r.id === run?.id || r.id === parent?.id}
              onClick={() => {
                open(r.id);
              }}
            >
              <small>{r.projectLocation?.name ?? r.project}</small>
              <strong>{r.title}</strong>
              <span>
                {crateStatus(r)}
                {r.crate?.childIds.length
                  ? ` · ${String(r.crate.childIds.length)} children`
                  : ''}
              </span>
            </button>
          ))}
        </div>
        {!roots.length && (
          <p className="quiet">
            {loading ? 'Loading crates…' : 'No matching crates.'}
          </p>
        )}
      </aside>
      {!run ? (
        <section className="crate-empty">
          <Package size={28} />
          <h2>One task. Its whole journey.</h2>
          <p>Select a crate to see its workflow, decisions, and evidence.</p>
          <button className="btn primary" onClick={onNew}>
            Create a crate
          </button>
        </section>
      ) : (
        <section className="crate-content">
          <div className="crate-breadcrumb">
            <Package size={14} />
            {parent ? (
              <button
                className="btn ghost"
                onClick={() => {
                  open(parent.id);
                }}
              >
                {parent.title} / Child crate
              </button>
            ) : (
              <span>{run.projectLocation?.name ?? run.project}</span>
            )}
            <code>{run.id.slice(0, 8)}</code>
          </div>
          <header className="crate-title">
            <h1>{run.title}</h1>
            <span className="status-chip">{crateStatus(run)}</span>
          </header>
          <p className="quiet">
            {run.workflowName} ·{' '}
            {run.mode === 'demo'
              ? 'Demo · simulated agents'
              : run.projectLocation?.workspaceMode === 'worktree'
                ? 'Isolated Git worktree'
                : 'Local workspace'}
          </p>
          {error && (
            <p className="error-banner" role="alert">
              {error}
            </p>
          )}
          {!run.crate && (
            <div className="crate-notice">
              <p>
                This existing run keeps its original workflow. Enable explicit
                triage to manage it as a crate.
              </p>
              <button
                className="btn"
                disabled={blocked}
                onClick={() => void action('crate-enable')}
              >
                Enable crate workflow
              </button>
            </div>
          )}
          <div className="crate-workspace">
            <section className="crate-flow" aria-label="Crate workflow">
              <h2>{childRuns.length ? 'Split & join' : 'Workflow'}</h2>
              {run.steps.map((step, i) => (
                <div className="crate-flow-part" key={step.definition.id}>
                  {i > 0 && <div className="crate-connector" />}
                  {nodeButton(
                    step.definition.id,
                    step.definition.name,
                    step.status.replaceAll('_', ' '),
                    `${step.definition.role} · ${step.definition.provider}${step.definition.model ? ' · ' + step.definition.model : ''}`,
                  )}
                  {i === 0 && childRuns.length > 0 && (
                    <>
                      <div className="crate-connector" />
                      <p className="crate-branch-label">
                        <GitBranch size={14} /> {childRuns.length} child crates
                      </p>
                      <div className="crate-branches">
                        {childRuns.map((child) => (
                          <button
                            className="crate-node"
                            key={child.id}
                            onClick={() => {
                              open(child.id);
                            }}
                          >
                            <strong>{child.title}</strong>
                            <p>{crateStatus(child)}</p>
                          </button>
                        ))}
                      </div>
                      <div className="crate-connector" />
                      {nodeButton(
                        'join',
                        'Integrate children',
                        run.crate?.join === 'joined'
                          ? 'Joined'
                          : `${String(childRuns.filter((c) => c.status === 'completed').length)} of ${String(childRuns.length)} approved`,
                        'Combine approved work, then validate the parent outcome.',
                      )}
                    </>
                  )}
                </div>
              ))}
              <div className="crate-connector" />
              {nodeButton(
                'triage',
                'Triage',
                triage
                  ? ready
                    ? 'Routed to approval'
                    : 'Needs a decision'
                  : run.crate?.feedback.some((f) => f.state === 'pending')
                    ? 'Feedback received'
                    : run.status === 'completed'
                      ? run.crate?.triage.length
                        ? 'Completed'
                        : 'Not recorded'
                      : 'After review',
                'Classify findings. Route fixes to the implementer or ask for a decision.',
              )}
              <div className="crate-connector" />
              {nodeButton(
                'approval',
                'Your approval',
                ready
                  ? 'Ready'
                  : run.status === 'completed'
                    ? 'Approved'
                    : 'Waiting',
                'Accept the reviewed outcome. Merging stays manual.',
              )}
              {run.git?.prUrl && (
                <>
                  <div className="crate-connector" />
                  {nodeButton(
                    'pr',
                    'PR feedback',
                    run.crate?.prState ?? 'Open',
                    'Code reviews and CI/CD return to triage.',
                  )}
                </>
              )}
            </section>
            <aside className="crate-inspector" aria-label="Crate details">
              <header>
                <span className="quiet">
                  {activeNode === 'triage'
                    ? 'Classify and route'
                    : activeNode === 'join'
                      ? 'Parent integration'
                      : activeNode === 'approval'
                        ? 'Human decision'
                        : activeNode === 'pr'
                          ? 'GitHub feedback'
                          : selectedStep?.definition.role}
                </span>
                <h2>
                  {(
                    {
                      triage: 'Triage',
                      join: 'Join child crates',
                      approval: 'Your approval',
                      pr: 'PR feedback',
                    } as Record<string, string>
                  )[activeNode] ?? selectedStep?.definition.name}
                </h2>
              </header>
              <div className="tabs" role="tablist" aria-label="Crate details">
                {(['brief', 'evidence', 'history', 'chat'] as const).map(
                  (t) => (
                    <button
                      role="tab"
                      aria-selected={tab === t}
                      className={`tab${tab === t ? ' tab-active' : ''}`}
                      key={t}
                      onClick={() => {
                        setTab(t);
                      }}
                    >
                      {
                        {
                          brief: 'Brief',
                          evidence: 'Evidence',
                          history: 'History',
                          chat: 'Conversation',
                        }[t]
                      }
                    </button>
                  ),
                )}
              </div>
              <div
                className="crate-inspector-body"
                key={`${run.id}/${activeNode}/${tab}`}
              >
                {tab === 'brief' && (
                  <>
                    <p className="crate-task">
                      {run.task.length > 900
                        ? run.task.slice(0, 280) + '...'
                        : run.task}
                    </p>
                    {run.task.length > 900 && (
                      <details>
                        <summary>Read full task brief</summary>
                        <p className="crate-task">{run.task}</p>
                      </details>
                    )}
                    {selectedStep?.output && (
                      <details>
                        <summary>Latest step output</summary>
                        <AgentOutput text={selectedStep.output} />
                      </details>
                    )}
                  </>
                )}
                {tab === 'evidence' && (
                  <>
                    {run.steps.map((s) =>
                      s.validation ? (
                        <ValidationPanel
                          key={s.definition.id}
                          evidence={s.validation}
                        />
                      ) : null,
                    )}
                    {!run.steps.some((s) => s.validation) && (
                      <p className="quiet">
                        No platform-recorded validation yet. Inspect the step
                        output for agent-reported evidence.
                      </p>
                    )}
                    <button
                      className="btn"
                      onClick={() => {
                        setTab('chat');
                        updateUrl({ tab: 'files' });
                      }}
                    >
                      Inspect files
                    </button>
                  </>
                )}
                {tab === 'history' && (
                  <ol className="crate-history">
                    {[...(run.crate?.triage ?? [])].reverse().map((t, i) => (
                      <li key={i}>
                        <strong>Triage → {t.action}</strong>
                        <p>{t.reason}</p>
                        <time>{new Date(t.at).toLocaleString()}</time>
                      </li>
                    ))}
                    {run.automation?.decisions.map((d, i) => (
                      <li key={`auto-${String(i)}`}>
                        Jev → {d.choice}
                        <p>{d.reason}</p>
                      </li>
                    ))}
                    {events
                      .filter(
                        (e) => e.type === 'error' || e.type === 'approval',
                      )
                      .slice(-5)
                      .reverse()
                      .map((e) => (
                        <li key={e.id}>
                          {e.message}
                          <time>{new Date(e.timestamp).toLocaleString()}</time>
                        </li>
                      ))}
                  </ol>
                )}
                {tab === 'chat' && (
                  <div className="crate-run-detail">
                    <RunDetail
                      run={run}
                      events={events}
                      busy={blocked}
                      onAction={onAction}
                      onBack={() => {
                        setTab('brief');
                      }}
                      onMessage={onMessage}
                    />
                  </div>
                )}
                {tab !== 'chat' && (
                  <>
                    {activeNode === 'triage' && triage && (
                      <section className="crate-action">
                        <p>
                          The reviewer reports findings. The implementer makes
                          fixes. Record why this outcome should proceed, return,
                          or pause.
                        </p>
                        <label>
                          Triage reason
                          <textarea
                            value={reason}
                            onChange={(e) => {
                              setReason(e.target.value);
                            }}
                            maxLength={4000}
                          />
                        </label>
                        <div className="crate-actions">
                          <button
                            className="btn primary"
                            disabled={
                              blocked ||
                              !reason.trim() ||
                              run.status !== 'waiting_approval'
                            }
                            onClick={() => void route('approve')}
                          >
                            Proceed to approval
                          </button>
                          <button
                            className="btn"
                            disabled={
                              blocked || !reason.trim() || reworkTarget(run) < 0
                            }
                            onClick={() => void route('repair')}
                          >
                            Route to implementer
                          </button>
                          <button
                            className="btn"
                            disabled={blocked || !reason.trim()}
                            onClick={() => void route('clarify')}
                          >
                            Needs clarification
                          </button>
                        </div>
                        <button
                          className="btn ghost"
                          onClick={() => {
                            setTab('chat');
                          }}
                        >
                          Discuss the findings <ArrowRight size={14} />
                        </button>
                      </section>
                    )}
                    {(activeNode === 'pr' || activeNode === 'triage') &&
                      run.git?.prUrl && (
                        <section className="crate-action">
                          <a
                            href={run.git.prUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Open pull request
                          </a>
                          <p className="quiet">
                            Checks every minute. Last checked:{' '}
                            {run.crate?.syncedAt
                              ? new Date(
                                  run.crate.syncedAt,
                                ).toLocaleTimeString()
                              : 'Not yet'}
                          </p>
                          {run.crate?.syncError && (
                            <p role="alert">{run.crate.syncError}</p>
                          )}
                          <button
                            className="btn"
                            disabled={blocked}
                            onClick={() => void action('crate-sync')}
                          >
                            Refresh PR feedback
                          </button>
                          {run.crate?.feedback
                            .filter(
                              (f) =>
                                f.state === 'pending' &&
                                f.head === run.crate?.prHead,
                            )
                            .map((event) => (
                              <div className="crate-feedback" key={event.id}>
                                <strong>
                                  {event.kind === 'ci'
                                    ? 'CI failure'
                                    : 'Review feedback'}
                                </strong>
                                <p>{event.summary}</p>
                                <label>
                                  Routing reason
                                  <textarea
                                    value={reason}
                                    onChange={(e) => {
                                      setReason(e.target.value);
                                    }}
                                    maxLength={4000}
                                  />
                                </label>
                                <div className="crate-actions">
                                  <button
                                    className="btn primary"
                                    disabled={
                                      blocked ||
                                      !reason.trim() ||
                                      run.status !== 'completed'
                                    }
                                    onClick={() =>
                                      void route('repair', event.id)
                                    }
                                  >
                                    Route fix to implementer
                                  </button>
                                  <button
                                    className="btn"
                                    disabled={blocked || !reason.trim()}
                                    onClick={() =>
                                      void route('dismiss', event.id)
                                    }
                                  >
                                    Dismiss with reason
                                  </button>
                                </div>
                              </div>
                            ))}
                        </section>
                      )}
                    {activeNode === 'join' && (
                      <section className="crate-action">
                        <p>
                          Every child must be approved. Conflicting changes
                          leave the parent unchanged.
                        </p>
                        <button
                          className="btn primary"
                          disabled={
                            blocked ||
                            run.crate?.join !== 'waiting' ||
                            childRuns.some((c) => c.status !== 'completed')
                          }
                          onClick={() => void action('crate-join')}
                        >
                          {run.crate?.join === 'joined'
                            ? 'Children joined'
                            : 'Join approved children'}
                        </button>
                        {run.crate?.join === 'joined' && (
                          <button
                            className="btn"
                            onClick={() => {
                              select(current?.definition.id ?? '');
                              setTab('chat');
                            }}
                          >
                            Continue parent workflow
                          </button>
                        )}
                      </section>
                    )}
                    {activeNode === 'approval' && (
                      <section className="crate-action">
                        <p>
                          {triage && !ready
                            ? 'Triage the findings before approving.'
                            : 'Inspect the evidence and approve the current step.'}
                        </p>
                        <button
                          className="btn primary"
                          onClick={() => {
                            updateUrl({ step: null });
                            setTab('chat');
                          }}
                        >
                          Review approval controls
                        </button>
                      </section>
                    )}
                    {activeNode !== 'triage' &&
                      activeNode !== 'join' &&
                      activeNode !== 'pr' &&
                      activeNode !== 'approval' && (
                        <section className="crate-action">
                          <button
                            className="btn primary"
                            onClick={() => {
                              setTab('chat');
                            }}
                          >
                            Open step conversation <ArrowRight size={14} />
                          </button>
                        </section>
                      )}
                    {run.crate?.allowSplit &&
                      !run.crate.parentId &&
                      !run.crate.childIds.length &&
                      run.currentStep === 0 &&
                      current?.definition.planning &&
                      run.status === 'waiting_approval' &&
                      !run.automation &&
                      (run.mode === 'demo' || run.git) && (
                        <section className="crate-action">
                          <button
                            className="btn"
                            onClick={() => {
                              setSplitting(!splitting);
                            }}
                          >
                            <GitBranch size={15} /> Split into child crates
                          </button>
                          {splitting && (
                            <form
                              onSubmit={(e) => {
                                e.preventDefault();
                                void action('crate-split', { children }).then(
                                  (data) => {
                                    if (data) {
                                      setSplitting(false);
                                      select('join');
                                    }
                                  },
                                );
                              }}
                            >
                              <p>
                                Define independent scopes. Each child uses this
                                workflow and gets its own plan approval and
                                worktree.
                              </p>
                              {children.map((child, i) => (
                                <fieldset key={i}>
                                  <legend>Child {i + 1}</legend>
                                  <label>
                                    Title
                                    <input
                                      required
                                      maxLength={120}
                                      value={child.title}
                                      onChange={(e) => {
                                        setChildren((items) =>
                                          items.map((c, j) =>
                                            j === i
                                              ? { ...c, title: e.target.value }
                                              : c,
                                          ),
                                        );
                                      }}
                                    />
                                  </label>
                                  <label>
                                    Scope and acceptance criteria
                                    <textarea
                                      required
                                      maxLength={4000}
                                      value={child.task}
                                      onChange={(e) => {
                                        setChildren((items) =>
                                          items.map((c, j) =>
                                            j === i
                                              ? { ...c, task: e.target.value }
                                              : c,
                                          ),
                                        );
                                      }}
                                    />
                                  </label>
                                </fieldset>
                              ))}
                              <div className="crate-actions">
                                {children.length < 4 && (
                                  <button
                                    type="button"
                                    className="btn"
                                    onClick={() => {
                                      setChildren((items) => [
                                        ...items,
                                        { title: '', task: '' },
                                      ]);
                                    }}
                                  >
                                    Add child
                                  </button>
                                )}
                                <button
                                  className="btn primary"
                                  disabled={blocked}
                                >
                                  Create child crates
                                </button>
                              </div>
                            </form>
                          )}
                        </section>
                      )}
                  </>
                )}
              </div>
            </aside>
          </div>
        </section>
      )}
    </div>
  );
}
