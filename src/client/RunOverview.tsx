import { useMemo, useState } from 'react';
import { useUrlState, updateUrl } from './url-state';
import type { Run } from '../shared/types';

type GroupId = 'attention' | 'active' | 'history';
const GROUPS: { id: GroupId; label: string; hint: string }[] = [
  {
    id: 'attention',
    label: 'Needs attention',
    hint: 'Reply to a question, review output or resolve a stopped step.',
  },
  {
    id: 'active',
    label: 'In progress',
    hint: 'Agents are working or waiting to start.',
  },
  { id: 'history', label: 'Finished', hint: 'Completed and cancelled runs.' },
];
const LABELS: Record<Run['status'], string> = {
  waiting_input: 'Your reply needed',
  waiting_approval: 'Needs approval',
  blocked: 'Blocked',
  failed: 'Failed',
  interrupted: 'Interrupted',
  running: 'Running',
  queued: 'Queued',
  completed: 'Completed',
  cancelled: 'Cancelled',
};
const PROVIDERS = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' };
const PAGE_SIZE = 8;

export function runGroup(run: Run): GroupId {
  if (
    [
      'waiting_input',
      'waiting_approval',
      'blocked',
      'failed',
      'interrupted',
    ].includes(run.status)
  )
    return 'attention';
  if (run.status === 'running' || run.status === 'queued') return 'active';
  return 'history';
}

function relativeTime(value: string) {
  const seconds = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(value)) / 1000),
  );
  if (!Number.isFinite(seconds)) return 'Unknown';
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${String(Math.floor(seconds / 60))}m ago`;
  if (seconds < 86400) return `${String(Math.floor(seconds / 3600))}h ago`;
  return `${String(Math.floor(seconds / 86400))}d ago`;
}

function RunRow({ run, onOpen }: { run: Run; onOpen: (id: string) => void }) {
  const step =
    run.steps[Math.min(run.currentStep, Math.max(0, run.steps.length - 1))];
  const completed = run.steps.filter((s) => s.status === 'completed').length;
  return (
    <li>
      <button
        type="button"
        className="run-card overview-row"
        onClick={() => {
          onOpen(run.id);
        }}
      >
        <span className="run-card-copy">
          <span className="run-title">{run.title}</span>
          <span className="run-card-meta">
            {run.projectLocation?.name ?? run.project} · {run.workflowName}
            {run.mode === 'demo' ? ' · Demo' : ''}
          </span>
        </span>
        <span className="run-progress">
          <span className="run-stage">
            {run.status === 'completed'
              ? 'All steps complete'
              : step.definition.name}
            {!['completed', 'cancelled'].includes(run.status) && (
              <span className="stage-provider">
                {' '}
                · {PROVIDERS[step.definition.provider]}
              </span>
            )}
          </span>
          <span className="progress-line">
            <span className="progress-segments" aria-hidden="true">
              {run.steps.map((s, i) => (
                <span
                  key={`${s.definition.id}-${String(i)}`}
                  className={`progress-segment progress-${s.status}`}
                />
              ))}
            </span>
            <span className="progress-caption">
              {completed}/{run.steps.length} steps complete
            </span>
          </span>
        </span>
        <span className={`status status-${run.status}`}>
          {LABELS[run.status]}
        </span>
        <time
          className="run-time"
          dateTime={run.updatedAt}
          title={new Date(run.updatedAt).toLocaleString()}
        >
          {relativeTime(run.updatedAt)}
        </time>
      </button>
    </li>
  );
}

export default function RunOverview({
  runs,
  loading,
  onOpen,
}: {
  runs: Run[];
  loading: boolean;
  onOpen: (id: string) => void;
}) {
  const [search, setSearch] = useUrlState<string>(
    'q',
    '',
    undefined,
    'replace',
  );
  const [project, setProject] = useUrlState<string>('runProject', '');
  const [mode, setMode] = useUrlState<string>('mode', 'all', [
    'all',
    'live',
    'demo',
  ]);
  const [scope, setScope] = useUrlState<'all' | GroupId>('scope', 'all', [
    'all',
    'attention',
    'active',
    'history',
  ]);
  const [limits, setLimits] = useState<Record<GroupId, number>>({
    attention: PAGE_SIZE,
    active: PAGE_SIZE,
    history: PAGE_SIZE,
  });
  const projects = useMemo(
    () => [...new Set(runs.map((r) => r.project))].sort(),
    [runs],
  );
  const matches = useMemo(
    () =>
      runs
        .filter(
          (run) =>
            (project === '' || project === run.project) &&
            (mode === 'all' || run.mode === mode) &&
            `${run.title} ${run.projectLocation?.name ?? ''} ${run.project} ${run.workflowName}`
              .toLowerCase()
              .includes(search.trim().toLowerCase()),
        )
        .sort(
          (a, b) =>
            b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
        ),
    [runs, search, project, mode],
  );
  const grouped = useMemo(() => {
    const result: Record<GroupId, Run[]> = {
      attention: [],
      active: [],
      history: [],
    };
    for (const run of matches) result[runGroup(run)].push(run);
    return result;
  }, [matches]);
  const displayedGroups = GROUPS.filter(
    (group) => scope === 'all' || scope === group.id,
  );
  const totalVisible = displayedGroups.reduce(
    (n, group) => n + grouped[group.id].length,
    0,
  );
  const resetLimits = () => {
    setLimits({ attention: PAGE_SIZE, active: PAGE_SIZE, history: PAGE_SIZE });
  };
  const clear = () => {
    updateUrl({ q: null, runProject: null, mode: null, scope: null });
    resetLimits();
  };

  return (
    <div className="run-overview">
      <header className="page-head">
        <h1 className="page-title" tabIndex={-1}>
          Runs
        </h1>
        <span className="quiet">
          {loading ? 'Loading…' : `${String(runs.length)} total`}
        </span>
      </header>
      <div className="overview-tools">
        <input
          type="search"
          className="run-search"
          aria-label="Search runs"
          placeholder="Search runs"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            resetLimits();
          }}
        />
        <select
          aria-label="Filter by project"
          value={project}
          onChange={(e) => {
            setProject(e.target.value);
            resetLimits();
          }}
        >
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p} value={p}>
              {runs.find((run) => run.project === p)?.projectLocation?.name ??
                p}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter by mode"
          value={mode}
          onChange={(e) => {
            setMode(e.target.value);
            resetLimits();
          }}
        >
          <option value="all">Live &amp; demo</option>
          <option value="live">Live only</option>
          <option value="demo">Demo only</option>
        </select>
      </div>
      <div
        className="overview-scopes filters"
        role="group"
        aria-label="Filter runs"
      >
        {[{ id: 'all' as const, label: 'Overview' }, ...GROUPS].map((group) => (
          <button
            key={group.id}
            type="button"
            className={`filter-button${scope === group.id ? ' active' : ''}`}
            aria-pressed={scope === group.id}
            onClick={() => {
              setScope(group.id);
              resetLimits();
            }}
          >
            {group.label}
          </button>
        ))}
        <span className="overview-result-count">
          {matches.length !== runs.length &&
            `${String(matches.length)} of ${String(runs.length)} match`}
        </span>
      </div>

      {loading && runs.length === 0 ? (
        <p className="empty-note">Loading runs…</p>
      ) : totalVisible === 0 ? (
        <div className="list-empty">
          <h2>
            {runs.length === 0 ? 'Start your first task' : 'No matching runs'}
          </h2>
          <p>
            {runs.length === 0
              ? 'Create a run to give your agents a task.'
              : 'Try a different search or filter.'}
          </p>
          {runs.length > 0 && (
            <button type="button" className="btn" onClick={clear}>
              Clear filters
            </button>
          )}
        </div>
      ) : (
        displayedGroups.map((group) => (
          <section
            className={`run-group run-group-${group.id}`}
            key={group.id}
            aria-label={group.label}
          >
            <header className="run-group-heading">
              <h2>
                {group.label} <span>{grouped[group.id].length}</span>
              </h2>
              <p>{group.hint}</p>
            </header>
            {grouped[group.id].length === 0 ? (
              <p className="group-empty">
                {group.id === 'attention'
                  ? 'Nothing needs your attention.'
                  : group.id === 'active'
                    ? 'No agents working right now.'
                    : 'No finished runs yet.'}
              </p>
            ) : (
              <>
                <div className="run-columns" aria-hidden="true">
                  <span>Task</span>
                  <span>Workflow progress</span>
                  <span>Status</span>
                  <span>Updated</span>
                </div>
                <ul className="run-list">
                  {grouped[group.id].slice(0, limits[group.id]).map((run) => (
                    <RunRow key={run.id} run={run} onOpen={onOpen} />
                  ))}
                </ul>
                {grouped[group.id].length > limits[group.id] && (
                  <button
                    className="button group-more"
                    type="button"
                    onClick={() => {
                      setLimits((previous) => ({
                        ...previous,
                        [group.id]: previous[group.id] + PAGE_SIZE,
                      }));
                    }}
                  >
                    Show more {group.label.toLowerCase()} (
                    {grouped[group.id].length - limits[group.id]} remaining)
                  </button>
                )}
              </>
            )}
          </section>
        ))
      )}
    </div>
  );
}
