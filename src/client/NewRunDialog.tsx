import { useEffect, useId, useRef, useState, type FormEvent, type SyntheticEvent } from 'react';
import type { ProjectInfo, Run, Workflow } from '../shared/types.js';
import ProjectImport from './ProjectImport';

type RunMode = 'live' | 'demo';

interface NewRunDialogProps {
  open: boolean;
  initialDemo: boolean;
  initialProject: string | null;
  onConnect: () => void;
  workflows: Workflow[];
  projects: ProjectInfo[];
  onClose: () => void;
  onCreated: (run: Run) => void;
  onProjectCreated: (project: ProjectInfo) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export default function NewRunDialog({
  open,
  initialDemo,
  initialProject,
  onConnect,
  workflows,
  projects,
  onClose,
  onCreated,
  onProjectCreated,
}: NewRunDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const wasOpenRef = useRef(false);

  const fieldId = useId();
  const titleId = `${fieldId}-title`;
  const taskId = `${fieldId}-task`;
  const projectId = `${fieldId}-project`;
  const workflowId = `${fieldId}-workflow`;
  const modeId = `${fieldId}-mode`;
  const modeHelpId = `${fieldId}-mode-help`;
  const dialogTitleId = `${fieldId}-dialog-title`;

  const [title, setTitle] = useState('');
  const [task, setTask] = useState('');
  const [project, setProject] = useState('');
  const [workflowSelection, setWorkflowSelection] = useState('');
  const [mode, setMode] = useState<RunMode>('live');
  const [delivery,setDelivery]=useState('manual');
  const selectedWorkflow=workflows.find(w=>w.id===workflowSelection);
  const automationEligible=mode==='live' && projects.find(p=>p.id===project)?.workspaceMode==='worktree' && !!selectedWorkflow?.steps[0]?.planning && !!selectedWorkflow.steps.at(-1)?.council && !selectedWorkflow.steps.slice(1,-1).some(s=>s.approval);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addingProject, setAddingProject] = useState(false);
  const [importBusy, setImportBusy] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open) {
      if (!dialog.open) dialog.showModal();
      titleInputRef.current?.focus();
    } else if (dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setTitle(initialDemo ? 'Explore an approval workflow' : '');
      setTask(initialDemo ? 'Propose a small text utility and explain each handoff.' : '');
      setMode(initialDemo ? 'demo' : 'live');
      setDelivery('manual');
      setProject(initialProject ?? projects[0]?.id ?? '');
      setWorkflowSelection(workflows[0]?.id ?? '');
      setSubmitting(false);
      setError(null);
      setAddingProject(false);
    }
    wasOpenRef.current = open;
  }, [open, initialDemo, initialProject, projects, workflows]);

  useEffect(() => { if (open && !project && projects.length) setProject(initialProject ?? projects[0].id); }, [open, project, projects, initialProject]);

  const canSubmit =
    !submitting &&
    title.trim() !== '' &&
    task.trim() !== '' &&
    projects.some(item => item.id === project) &&
    workflowSelection !== '' &&
    projects.length > 0 &&
    workflows.length > 0;

  function handleCancel(event: SyntheticEvent<HTMLDialogElement>): void {
    event.preventDefault();
    if (submitting || importBusy) return;
    if (addingProject) { setAddingProject(false); return; }
    onClose();
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          task: task.trim(),
          project,
          expectedWorkspaceMode: projects.find(item => item.id === project)?.workspaceMode ?? 'isolated',
          workflowId: workflowSelection,
          mode,
          ...(automationEligible && delivery!=='manual'?{automation:{publication:delivery}}:{}),
        }),
      });
      if (!response.ok) {
        let message = `Unable to start run (HTTP ${response.status}).`;
        try {
          const body: unknown = await response.json();
          if (isRecord(body) && typeof body.error === 'string' && body.error !== '') {
            message = body.error;
          }
        } catch {
          // Keep the fallback message when the response body is not JSON.
        }
        throw new Error(message);
      }
      const payload: unknown = await response.json();
      const candidate = isRecord(payload) && isRecord(payload.run) ? payload.run : payload;
      if (!isRecord(candidate) || typeof candidate.id !== 'string') {
        throw new Error('The server returned an unexpected response.');
      }
      setSubmitting(false);
      onCreated(candidate as unknown as Run);
      onClose();
    } catch (caught: unknown) {
      setSubmitting(false);
      setError(caught instanceof Error ? caught.message : 'Unable to start run.');
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="dialog"
      aria-labelledby={dialogTitleId}
      onCancel={handleCancel}
    >
      {addingProject ? <ProjectImport titleId={dialogTitleId} onBusy={setImportBusy} onCancel={() => setAddingProject(false)} onCreated={item => { onProjectCreated(item); setProject(item.id); setAddingProject(false); }} /> : <form className="new-run-form" onSubmit={handleSubmit}>
        <h2 id={dialogTitleId} className="dialog-title">
          New run
        </h2>

        {error ? (
          <div className="error-banner" role="alert">
            {error}
          </div>
        ) : null}

        <div className="form-grid">
          <div className="field">
            <label htmlFor={titleId}>Task title</label>
            <input
              ref={titleInputRef}
              id={titleId}
              type="text"
              value={title}
              maxLength={120}
              required
              disabled={submitting}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor={taskId}>Task brief</label>
            <textarea
              id={taskId}
              value={task}
              maxLength={30000}
              required
              rows={4}
              disabled={submitting}
              onChange={(event) => setTask(event.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor={projectId}>Project</label>
            <select
              id={projectId}
              value={project}
              required
              disabled={submitting || projects.length === 0}
              onChange={(event) => setProject(event.target.value)}
            >
              {projects.length === 0 ? <option value="">No projects found</option> : null}
              {projects.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
            <p className="field-helper">{projects.find(item => item.id === project)?.workspaceMode === 'worktree' ? 'Git worktree: a dedicated branch from committed code. Commit or stash local changes first.' : projects.find(item => item.id === project)?.workspaceMode === 'direct' ? 'Direct folder: live implementation edits the source files.' : 'Isolated: each run works on a copy.'}</p>
            <div className="project-actions"><button type="button" className="button button-ghost add-project-button" disabled={submitting} onClick={onConnect}>Connect folder</button><button type="button" className="button button-ghost add-project-button" disabled={submitting} onClick={() => setAddingProject(true)}>Import a copy</button></div>
          </div>

          <div className="field">
            <label htmlFor={workflowId}>Workflow</label>
            <select
              id={workflowId}
              value={workflowSelection}
              required
              disabled={submitting || workflows.length === 0}
              onChange={(event) => setWorkflowSelection(event.target.value)}
            >
              {workflows.length === 0 ? <option value="">No workflows found</option> : null}
              {workflows.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor={modeId}>Mode</label>
            <select
              id={modeId}
              value={mode}
              required
              aria-describedby={modeHelpId}
              disabled={submitting}
              onChange={(event) => setMode(event.target.value === 'demo' ? 'demo' : 'live')}
            >
              <option value="live">Live</option>
              <option value="demo">Demo</option>
            </select>
            <p className="field-helper" id={modeHelpId}>
              {mode === 'live' ? 'Uses your configured providers and may incur usage costs.' : 'Simulates the workflow. No provider calls or charges.'}
            </p>
          </div>
        </div>

        {automationEligible&&<div className="field"><label htmlFor={`${fieldId}-delivery`}>Delivery</label><select id={`${fieldId}-delivery`} value={delivery} onChange={e=>setDelivery(e.target.value)} disabled={submitting}><option value="manual">Manual approval gates</option><option value="draft">PR machine · automatic draft PR</option></select><p className="field-helper">Approve the plan first. Jev can request up to two repairs; passing tests and council review are required. Uncertainty pauses the run. Nothing merges automatically.</p></div>}
        <div className="dialog-actions">
          <button type="button" className="btn ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!canSubmit} aria-busy={submitting}>
            {'Start run'}
          </button>
        </div>

        <p className="dialog-footer-note">
          Folder access follows the selected project's workspace mode.
        </p>
      </form>}
    </dialog>
  );
}
