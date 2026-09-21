import { Plus } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ProjectInfo, ProviderInfo, Run, RunEvent, Workflow } from '../shared/types.js';
import NewRunDialog from './NewRunDialog';
import ProvidersView from './ProvidersView';
import RunDetail from './RunDetail';
import WorkflowEditor from './WorkflowEditor';
import RunOverview from './RunOverview';
import ProjectsView from './ProjectsView';
import CratesView from './CratesView';
import { useUrlState, useUrlSelection, updateUrl } from './url-state';

type ViewId = 'crates' | 'runs' | 'projects' | 'workflows' | 'agents';
type RunActionId = 'approve' | 'revise' | 'rework' | 'retry' | 'cancel';
type ErrorKey = 'runs' | 'workflows' | 'projects' | 'providers' | 'events' | 'action';

const RUN_POLL_MS = 1500;

const NAV_ITEMS: ReadonlyArray<{ id: ViewId; label: string }> = [
  { id: 'crates', label: 'Crates' },
  { id: 'runs', label: 'Runs' },
  { id: 'projects', label: 'Projects' },
  { id: 'workflows', label: 'Workflows' },
  { id: 'agents', label: 'Agents' },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : 'Something went wrong.';
}

async function readErrorMessage(response: Response): Promise<string> {
  const text = await response.text();
  if (text !== '') {
    try {
      const parsed: unknown = JSON.parse(text);
      if (isRecord(parsed) && typeof parsed.error === 'string' && parsed.error !== '') {
        return parsed.error;
      }
    } catch {
      /* Body was not JSON; fall back to the HTTP status. */
    }
  }
  return `Request failed (HTTP ${response.status}).`;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(await readErrorMessage(response));
  return (await response.json()) as T;
}

export default function App() {
  const [view, setView] = useUrlState<ViewId>('view', ['run','q','mode','scope'].some(key=>new URLSearchParams(window.location.search).has(key))?'runs':'crates', ['crates','runs', 'projects', 'workflows', 'agents']);

  const [runs, setRuns] = useState<Run[]>([]);
  const [runsLoading, setRunsLoading] = useState(true);
  const runsInFlightRef = useRef(false);

  const [selectedRunId] = useUrlSelection('run');
  const setSelectedRunId = useCallback((id: string | null) => updateUrl({ view: 'runs', run: id, step: null, tab: null, file: null, activity: null }), []);
  const openCrate = useCallback((id:string)=>updateUrl({view:'crates',run:id,crateNode:null,crateTab:null,step:null,tab:null,file:null,activity:null}),[]);
  const streamingRunRef = useRef<string | null>(null);

  const [events, setEvents] = useState<RunEvent[]>([]);
  const eventsCursorRef = useRef(0);

  const [actionBusy, setActionBusy] = useState(false);

  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [workflowsLoading, setWorkflowsLoading] = useState(true);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [providersLoading, setProvidersLoading] = useState(true);

  const [errors, setErrors] = useState<Partial<Record<ErrorKey, string>>>({});
  const setResourceError = useCallback((key: ErrorKey, message: string | null): void => {
    setErrors((previous) => {
      if (message === null) {
        if (previous[key] === undefined) return previous;
        const next = { ...previous };
        delete next[key];
        return next;
      }
      if (previous[key] === message) return previous;
      return { ...previous, [key]: message };
    });
  }, []);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogInitialDemo, setDialogInitialDemo] = useState(false);
  const [dialogProject, setDialogProject] = useState<string | null>(null);
  const [connectRequest, setConnectRequest] = useState(0);

  const loadRuns = useCallback(
    async (): Promise<void> => {
      if (runsInFlightRef.current) return;
      runsInFlightRef.current = true;
      try {
        const list = await getJson<Run[]>('/api/runs');
        setRuns(previous => list.map(run => {
          const current = previous.find(item => item.id === run.id);
          // A stalled SSE connection must not suppress a newer durable snapshot.
          return current && current.updatedAt >= run.updatedAt ? current : run;
        }));
        setResourceError('runs', null);
      } catch (error) {
        setResourceError('runs', `Unable to load runs: ${errorMessage(error)}`);
      } finally {
        runsInFlightRef.current = false;
        setRunsLoading(false);
      }
    },
    [setResourceError],
  );

  const loadWorkflows = useCallback(async (): Promise<void> => {
    try {
      const list = await getJson<Workflow[]>('/api/workflows');
      setWorkflows(list);
      setResourceError('workflows', null);
    } catch (error) {
      setResourceError('workflows', `Unable to load workflows: ${errorMessage(error)}`);
    } finally {
      setWorkflowsLoading(false);
    }
  }, [setResourceError]);

  const loadProjects = useCallback(async (): Promise<void> => {
    try {
      const list = await getJson<ProjectInfo[]>('/api/projects');
      setProjects(list);
      setResourceError('projects', null);
    } catch (error) {
      setResourceError('projects', `Unable to load projects: ${errorMessage(error)}`);
    }
  }, [setResourceError]);

  const loadProviders = useCallback(async (): Promise<void> => {
    setProvidersLoading(true);
    try {
      const list = await getJson<ProviderInfo[]>('/api/providers');
      setProviders(list);
      setResourceError('providers', null);
    } catch (error) {
      setResourceError('providers', `Unable to load providers: ${errorMessage(error)}`);
    } finally {
      setProvidersLoading(false);
    }
  }, [setResourceError]);

  useEffect(() => { if (view === 'projects') void loadProjects(); }, [view, loadProjects]);

  useEffect(() => {
    void loadRuns();
    void loadWorkflows();
    void loadProjects();
    void loadProviders();
  }, [loadRuns, loadWorkflows, loadProjects, loadProviders]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadRuns();
    }, RUN_POLL_MS);
    return () => window.clearInterval(timer);
  }, [loadRuns]);

  useEffect(() => {
    setEvents([]);
    eventsCursorRef.current = 0;
    if (selectedRunId === null || !runs.some(run => run.id === selectedRunId)) return;

    let stale = false;
    let inFlight = false;

    const load = async (): Promise<void> => {
      if (inFlight) return;
      inFlight = true;
      try {
        const batch = await getJson<RunEvent[]>(
          `/api/runs/${encodeURIComponent(selectedRunId)}/events?after=${eventsCursorRef.current}`,
        );
        if (stale) return;
        if (batch.length > 0) {
          eventsCursorRef.current = batch.reduce(
            (highest, event) => Math.max(highest, event.id),
            eventsCursorRef.current,
          );
          setEvents((previous) => {
            const seen = new Set(previous.map((event) => event.id));
            const merged = previous.slice();
            for (const event of batch) {
              if (!seen.has(event.id)) {
                seen.add(event.id);
                merged.push(event);
              }
            }
            merged.sort((left, right) => left.id - right.id);
            return merged;
          });
        }
        setResourceError('events', null);
      } catch (error) {
        if (!stale) setResourceError('events', `Unable to load activity: ${errorMessage(error)}`);
      } finally {
        inFlight = false;
      }
    };

    void load();
    const timer = window.setInterval(() => {
      void load();
    }, RUN_POLL_MS);
    return () => {
      stale = true;
      window.clearInterval(timer);
    };
  }, [selectedRunId, runs.some(run => run.id === selectedRunId), setResourceError]);

  useEffect(() => {
    if (!selectedRunId || !runs.some(run => run.id === selectedRunId)) return;
    const source = new EventSource(`/api/runs/${encodeURIComponent(selectedRunId)}/stream`);
    source.addEventListener('run', event => {
      const updated = JSON.parse((event as MessageEvent).data) as Run;
      if (updated.id !== selectedRunId) return;
      streamingRunRef.current = selectedRunId;
      setRuns(previous => previous.map(run => run.id === updated.id && run.updatedAt <= updated.updatedAt ? updated : run));
    });
    source.onerror = () => { streamingRunRef.current = null; };
    return () => { source.close(); streamingRunRef.current = null; };
  }, [selectedRunId, runs.some(run => run.id === selectedRunId)]);

  useEffect(() => {
    setResourceError('action', null);
  }, [selectedRunId, setResourceError]);

  const selectedRun = useMemo(
    () => (selectedRunId === null ? null : runs.find((run) => run.id === selectedRunId) ?? null),
    [runs, selectedRunId],
  );

  useEffect(() => {
    const heading = document.querySelector<HTMLElement>('.main:not([hidden]) h1');
    heading?.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  }, [view, selectedRunId]);

  const handleCreated = useCallback((run: Run): void => {
    setRuns((previous) => [run, ...previous.filter((item) => item.id !== run.id)]);
    if(view==='crates')openCrate(run.id);else setSelectedRunId(run.id);
    setDialogOpen(false);
  }, [setSelectedRunId,openCrate,view]);

  const handleBack = useCallback((): void => {
    setSelectedRunId(null);
  }, [setSelectedRunId]);

  const handleWorkflowSaved = useCallback((workflow: Workflow): void => {
    setWorkflows((previous) => {
      const index = previous.findIndex((item) => item.id === workflow.id);
      if (index === -1) return [workflow, ...previous];
      const next = previous.slice();
      next[index] = workflow;
      return next;
    });
  }, []);

  const handleAction = useCallback(
    async (action: RunActionId, feedback?: string, acknowledgedAssessment?: string): Promise<void> => {
      if (selectedRunId === null) return;
      setActionBusy(true);
      setResourceError('action', null);
      try {
        const response = await fetch(
          `/api/runs/${encodeURIComponent(selectedRunId)}/${action}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(action === 'revise' ? { feedback: feedback ?? '' } : action === 'approve' && acknowledgedAssessment ? { acknowledgedAssessment } : {}),
          },
        );
        if (!response.ok) throw new Error(await readErrorMessage(response));
        await loadRuns();
      } catch (error) {
        const message = errorMessage(error);
        setResourceError('action', message);
        throw error instanceof Error ? error : new Error(message);
      } finally {
        setActionBusy(false);
      }
    },
    [selectedRunId, loadRuns, setResourceError],
  );

  function openDialog(initialDemo: boolean, projectId: string | null = null): void {
    void loadProjects();
    setDialogProject(projectId);
    setDialogInitialDemo(initialDemo);
    setDialogOpen(true);
  }

  async function sendPlanningMessage(stepId: string, message: string, messageId: string): Promise<void> {
    if (!selectedRunId) throw new Error('Select a run first.');
    setActionBusy(true);
    try {
      const response = await fetch(`/api/runs/${encodeURIComponent(selectedRunId)}/messages`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stepId, message, messageId }),
      });
      if (!response.ok) throw new Error(await readErrorMessage(response));
      const updated = await response.json() as Run;
      setRuns(previous => previous.map(run => run.id === updated.id && run.updatedAt <= updated.updatedAt ? updated : run));
    } finally {
      setActionBusy(false);
    }
  }

  const activeErrors = Object.entries(errors).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  );

  return (
    <div className="app-shell">
      <header className="app-header">
        <span className="wordmark">AgentLoom<span className="brand-dot" aria-hidden="true">.</span></span>
        <nav className="nav" aria-label="Primary">
          {NAV_ITEMS.map(item => <button key={item.id} type="button" className={`nav-button${view === item.id ? ' active' : ''}`} aria-current={view === item.id ? 'page' : undefined} onClick={() => { if (item.id === 'runs') setSelectedRunId(null); else setView(item.id); }}>{item.label}</button>)}
        </nav>
        <button type="button" className="button button-primary" onClick={() => openDialog(false)}><Plus size={16} aria-hidden="true" />{view === 'crates' ? 'New crate' : 'New run'}</button>
      </header>

      {activeErrors.length > 0 && <div className="alerts">{activeErrors.map(([key, message]) => <p key={key} role="alert" className="alert">{message}</p>)}</div>}

      <main className="main crates-main" hidden={view !== 'crates'}>{view==='crates'&&<CratesView runs={runs} selected={selectedRun} loading={runsLoading} events={events} busy={actionBusy} onOpen={openCrate} onNew={()=>openDialog(false)} refresh={loadRuns} onAction={handleAction} onMessage={sendPlanningMessage}/>}</main>
      <main className="main" hidden={view !== 'runs'}>
        {selectedRunId && !selectedRun && <section><h1 tabIndex={-1}>{runsLoading ? 'Loading run?' : errors.runs ? 'Unable to load run' : 'Run not found'}</h1><p className="page-lede">{runsLoading ? 'Restoring your view.' : 'This link could not be opened. You can return to the run list.'}</p><button className="button" onClick={handleBack}>Back to runs</button></section>}
        {view==='runs' && selectedRun && <RunDetail key={selectedRun.id} run={selectedRun} events={events} busy={actionBusy} onAction={handleAction} onBack={handleBack} onMessage={sendPlanningMessage} />}
        <div hidden={selectedRunId !== null}><RunOverview runs={runs} loading={runsLoading} onOpen={setSelectedRunId} /></div>
      </main>

      <main className="main" hidden={view !== 'workflows'}>
        <header className="page-head"><div><h1 className="page-title" tabIndex={-1}>Workflows</h1><p className="page-lede">Choose a workflow to edit its steps. Changes apply to new runs.</p></div></header>
        {workflowsLoading ? <p className="empty-note">Loading workflows...</p> : <WorkflowEditor workflows={workflows} onSaved={handleWorkflowSaved} />}
      </main>

      <main className="main" hidden={view !== 'projects'}><ProjectsView projects={projects} runs={runs} refresh={loadProjects} connectRequest={connectRequest} onRun={id => openDialog(false, id)} onOpenRun={setSelectedRunId} /></main>

      <main className="main" hidden={view !== 'agents'}>
        <header className="page-head"><div><h1 className="page-title" tabIndex={-1}>Agents</h1><p className="page-lede">Manage provider connections and credentials.</p></div></header>
        <ProvidersView providers={providers} loading={providersLoading} onRefresh={() => { void loadProviders(); }} />
      </main>
      <NewRunDialog crate={view==='crates'} open={dialogOpen} initialDemo={dialogInitialDemo} initialProject={dialogProject} workflows={workflows} projects={projects.filter(project => (!project.status || project.status === 'active') && project.available !== false)} onConnect={() => { setDialogOpen(false); setView('projects'); setConnectRequest(value => value + 1); }} onClose={() => setDialogOpen(false)} onCreated={handleCreated} onProjectCreated={project => { setProjects(previous => [...previous.filter(item => item.id !== project.id), project].sort((a, b) => a.name.localeCompare(b.name))); void loadProjects(); }} />
    </div>
  );
}
