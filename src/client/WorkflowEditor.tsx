import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { ProviderId, StepDefinition, Workflow } from '../shared/types';
import { suggestedCatalog, type ModelCatalog } from '../shared/model-catalog';
import ModelPicker from './ModelPicker';
import { useUrlSelection } from './url-state';
import { isPlanningStep } from '../shared/planning';

const PROVIDERS: ProviderId[] = ['codex', 'claude', 'opencode'];
const EFFORTS: Record<ProviderId, string[]> = {
  claude: ['', 'low', 'medium', 'high', 'max'],
  codex: ['', 'low', 'medium', 'high', 'xhigh'],
  opencode: ['', 'low', 'high', 'max'],
};
const MAX_STEPS = 8;

function cloneWorkflow(workflow: Workflow): Workflow {
  return structuredClone(workflow);
}

function newStep(): StepDefinition {
  return {
    id: crypto.randomUUID(),
    name: '',
    role: 'Reviewer',
    provider: 'codex',
    model: '',
    effort: '',
    instructions: '',
    access: 'read-only',
    approval: true,
  };
}

export default function WorkflowEditor({
  workflows,
  onSaved,
}: {
  workflows: Workflow[];
  onSaved: (workflow: Workflow) => void;
}) {
  const [selectedId, setSelectedId] = useUrlSelection('workflow', workflows[0]?.id ?? null);
  const [draft, setDraft] = useState<Workflow | null>(null);
  const [saving, setSaving] = useState(false);
  const [expandedSteps, setExpandedSteps] = useState<Record<string, boolean>>({});
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [catalogs, setCatalogs] = useState<Partial<Record<ProviderId, { catalog?: ModelCatalog; loading: boolean }>>>({});
  const catalogSequence = useRef<Partial<Record<ProviderId, number>>>({});
  const catalogAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    catalogAbort.current = controller;
    return () => {
      controller.abort();
      catalogAbort.current = null;
    };
  }, []);

  const loadCatalog = useCallback(async (provider: ProviderId, refresh: boolean): Promise<void> => {
    const sequence = (catalogSequence.current[provider] ?? 0) + 1;
    catalogSequence.current[provider] = sequence;
    const signal = catalogAbort.current?.signal;
    setCatalogs((previous) => ({ ...previous, [provider]: { ...previous[provider], loading: true } }));
    try {
      const response = await fetch(`/api/providers/${provider}/models${refresh ? '/refresh' : ''}`, {
        method: refresh ? 'POST' : 'GET',
        ...(refresh ? { headers: { 'Content-Type': 'application/json' }, body: '{}' } : {}),
        signal,
      });
      if (!response.ok) throw new Error(`Model catalog request failed (${response.status})`);
      const body = (await response.json()) as ModelCatalog;
      if (signal?.aborted || catalogSequence.current[provider] !== sequence || body.provider !== provider) return;
      setCatalogs((previous) => ({ ...previous, [provider]: { catalog: body, loading: false } }));
    } catch {
      if (signal?.aborted || catalogSequence.current[provider] !== sequence) return;
      setCatalogs((previous) => ({ ...previous, [provider]: { catalog: suggestedCatalog(provider, 'failed'), loading: false } }));
    }
  }, []);

  useEffect(() => {
    if (selectedId === null && workflows[0]) setSelectedId(workflows[0].id);
    else if (selectedId !== null && !workflows.some((w) => w.id === selectedId)) setSelectedId(workflows[0]?.id ?? null);
  }, [workflows, selectedId]);

  useEffect(() => {
    const selected = workflows.find((w) => w.id === selectedId);
    setDraft(selected ? cloneWorkflow(selected) : null);
  }, [workflows, selectedId]);

  useEffect(() => {
    setMessage(null);
    setExpandedSteps({});
  }, [selectedId]);

  const expandedProviders = draft === null
    ? []
    : Array.from(new Set(draft.steps.filter((step) => expandedSteps[step.id]).flatMap((step) => [
        step.provider,
        ...(step.council?.reviewers.map((member) => member.provider) ?? []),
      ])));
  const expandedProviderKey = expandedProviders.join(',');

  useEffect(() => {
    for (const provider of expandedProviders) {
      if (!catalogs[provider]) {
        void loadCatalog(provider, false);
      }
    }
  }, [expandedProviderKey, catalogs, loadCatalog]);

  function patchDraft(patch: Partial<Workflow>) {
    setDraft((current) => (current ? { ...current, ...patch } : current));
  }

  function patchStep(id: string, patch: Partial<StepDefinition>) {
    setDraft((current) =>
      current ? { ...current, steps: current.steps.map((step) => (step.id === id ? { ...step, ...patch } : step)) } : current,
    );
  }

  function moveStep(index: number, delta: number) {
    setDraft((current) => {
      if (!current) return current;
      const target = index + delta;
      if (target < 0 || target >= current.steps.length) return current;
      const steps = [...current.steps];
      [steps[index], steps[target]] = [steps[target], steps[index]];
      return { ...current, steps };
    });
  }

  function removeStep(id: string) {
    setDraft((current) =>
      current && current.steps.length > 1 ? { ...current, steps: current.steps.filter((step) => step.id !== id) } : current,
    );
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || saving) return;
    if (!draft.name.trim()) {
      setMessage({ kind: 'error', text: 'Workflow name is required.' });
      return;
    }
    const unnamed = draft.steps.findIndex((step) => !step.name.trim());
    if (unnamed !== -1) {
      setMessage({ kind: 'error', text: `Step ${unnamed + 1} needs a name.` });
      return;
    }
    const missingReviewerModel = draft.steps.findIndex((step) =>
      step.council?.reviewers.some((member) => member.model.trim().length === 0),
    );
    if (missingReviewerModel !== -1) {
      setMessage({ kind: 'error', text: `Step ${missingReviewerModel + 1} needs an explicit model for every council reviewer.` });
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/workflows/${encodeURIComponent(draft.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(detail ? `Save failed (${response.status}): ${detail}` : `Save failed (${response.status}).`);
      }
      const saved = (await response.json()) as Workflow;
      onSaved(saved);
      setMessage({
        kind: 'ok',
        text: `Saved "${saved.name}". Changes affect new runs; existing runs keep their snapshot.`,
      });
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : 'Save failed.' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="panel wf-editor">
      <label className="workflow-picker">Workflow
        <select value={selectedId ?? ''} onChange={event => setSelectedId(event.target.value)}>
          {workflows.map(workflow => <option key={workflow.id} value={workflow.id}>{workflow.name}</option>)}
        </select>
      </label>

      {workflows.length === 0 ? (
        <p className="wf-empty">Loading workflows…</p>
      ) : (
        <div className="wf-list">
          {workflows.map((workflow) => (
            <button
              key={workflow.id}
              type="button"
              className={`button wf-item${workflow.id === selectedId ? ' is-selected' : ''}`}
              aria-pressed={workflow.id === selectedId}
              onClick={() => setSelectedId(workflow.id)}
            >
              <strong>{workflow.name}</strong>
              <span>{workflow.steps.length} steps &middot; {workflow.steps.filter(s => s.approval).length} approval gates</span>
            </button>
          ))}
        </div>
      )}

      {draft && (
        <form className="wf-form" onSubmit={handleSubmit} onInvalidCapture={event => { const details = (event.target as HTMLElement).closest('details'); if (details) details.open = true; }}>
          <label className="form-field">
            Workflow name
            <input
              value={draft.name}
              required
              maxLength={120}
              onChange={(event) => patchDraft({ name: event.target.value })}
            />
          </label>

          <label className="form-field">
            Description
            <input
              value={draft.description}
              maxLength={2000}
              onChange={(event) => patchDraft({ description: event.target.value })}
            />
          </label>

          <ol className="wf-steps">
            {draft.steps.map((step, index) => (
              <li key={step.id}>
                <details className="wf-step" open={expandedSteps[step.id] ?? false} onToggle={event => {
                  const open = event.currentTarget.open;
                  setExpandedSteps(previous => previous[step.id] === open ? previous : { ...previous, [step.id]: open });
                }}>
                  <summary><span>{index + 1}. {step.name || 'New step'}</span><span className="quiet">{step.council ? '3 reviewers + chair' : step.validation ? 'Recorded commands + Jev' : step.provider} &middot; {step.approval ? 'Approval required' : 'Automatic'}</span></summary>
                  <div className="wf-step-fields">
                <div className="wf-step-header">
                  <h3>Step {index + 1}</h3>
                  <div className="wf-step-actions">
                    <button type="button" className="button" aria-label={`Move step ${index + 1} up`} disabled={index === 0} onClick={() => moveStep(index, -1)}>
                      Up
                    </button>
                    <button type="button" className="button" aria-label={`Move step ${index + 1} down`} disabled={index === draft.steps.length - 1} onClick={() => moveStep(index, 1)}>
                      Down
                    </button>
                    <button type="button" className="button" aria-label={`Remove step ${index + 1}`} disabled={draft.steps.length === 1} onClick={() => removeStep(step.id)}>
                      Remove
                    </button>
                  </div>
                </div>

                <label className="form-field">
                  Name
                  <input value={step.name} required maxLength={120} onChange={(event) => patchStep(step.id, { name: event.target.value })} />
                </label>

                <label className="form-field">
                  Role
                  <input value={step.role} maxLength={120} onChange={(event) => patchStep(step.id, { role: event.target.value })} />
                </label>

                {!step.validation && <>
                <label className="form-field">
                  Provider
                  <select
                    value={step.provider}
                    onChange={(event) => patchStep(step.id, { provider: event.target.value as ProviderId, effort: '', model: '' })}
                  >
                    {PROVIDERS.map((provider) => (
                      <option key={provider} value={provider}>{provider}</option>
                    ))}
                  </select>
                </label>

                <label className="form-field">
                  Model
                  <ModelPicker
                    provider={step.provider}
                    value={step.model}
                    catalog={catalogs[step.provider]?.catalog}
                    loading={catalogs[step.provider]?.loading ?? false}
                    fieldKey={step.id}
                    onChange={(model) => patchStep(step.id, { model })}
                    onRefresh={() => { void loadCatalog(step.provider, true); }}
                  />
                </label>

                <label className="form-field">
                  Effort
                  <select value={step.effort} onChange={(event) => patchStep(step.id, { effort: event.target.value })}>
                    {EFFORTS[step.provider].map((effort) => (
                      <option key={effort || 'default'} value={effort}>{effort || 'default'}</option>
                    ))}
                  </select>
                </label>

                </>}
                {step.council && <div className="council-editor"><p>The provider and model above configure the chair. Members review independently; the implementer model cannot review its own work. Changes affect new runs.</p>{step.council.reviewers.map((member, mi) => <fieldset key={member.id}><legend>{member.name}</legend><label>Reviewer provider<select value={member.provider} onChange={event => patchStep(step.id,{council:{reviewers:step.council!.reviewers.map((m,i)=>i===mi?{...m,provider:event.target.value as ProviderId,model:'',effort:''}:m)}})}>{PROVIDERS.map(provider=><option key={provider}>{provider}</option>)}</select></label><label>Reviewer model<ModelPicker provider={member.provider} value={member.model} catalog={catalogs[member.provider]?.catalog} loading={catalogs[member.provider]?.loading ?? false} fieldKey={`${step.id}-reviewer-${member.id}`} label="Reviewer model" allowDefault={false} onChange={model=>patchStep(step.id,{council:{reviewers:step.council!.reviewers.map((m,i)=>i===mi?{...m,model}:m)}})} onRefresh={()=>{void loadCatalog(member.provider,true);}}/></label><label>Reviewer effort<select value={member.effort} onChange={event=>patchStep(step.id,{council:{reviewers:step.council!.reviewers.map((m,i)=>i===mi?{...m,effort:event.target.value}:m)}})}>{EFFORTS[member.provider].map(effort=><option key={effort} value={effort}>{effort||'default'}</option>)}</select></label><label>Review focus<textarea value={member.focus} maxLength={2000} required onChange={event=>patchStep(step.id,{council:{reviewers:step.council!.reviewers.map((m,i)=>i===mi?{...m,focus:event.target.value}:m)}})}/></label></fieldset>)}</div>}
                {step.validation && <div className="validation-command-editor"><p>These exact commands are approved with the plan. Arguments are separate values, one per line. Shell operators are not interpreted.</p>{step.validation.commands.map((command,ci)=><fieldset key={ci}><legend>Command {ci+1}</legend><label>Program<input value={command.executable} required onChange={e=>patchStep(step.id,{validation:{commands:step.validation!.commands.map((c,i)=>i===ci?{...c,executable:e.target.value}:c)}})}/></label><label>Arguments (one per line)<textarea rows={2} value={command.args.join("\n")} onChange={e=>patchStep(step.id,{validation:{commands:step.validation!.commands.map((c,i)=>i===ci?{...c,args:e.target.value===""?[]:e.target.value.split("\n")}:c)}})}/></label><label>Timeout (seconds)<input type="number" min={1} max={3600} value={command.timeoutMs/1000} onChange={e=>patchStep(step.id,{validation:{commands:step.validation!.commands.map((c,i)=>i===ci?{...c,timeoutMs:Number(e.target.value)*1000}:c)}})}/></label><button type="button" className="button" disabled={step.validation!.commands.length===1} onClick={()=>patchStep(step.id,{validation:{commands:step.validation!.commands.filter((_,i)=>i!==ci)}})}>Remove command {ci+1}</button></fieldset>)}<button type="button" className="button" disabled={step.validation.commands.length>=8} onClick={()=>patchStep(step.id,{validation:{commands:[...step.validation!.commands,{executable:"npm",args:["test"],timeoutMs:600000}]}})}>Add validation command</button></div>}
                <label className="form-field">
                  Instructions
                  <textarea value={step.instructions} maxLength={10000} rows={3} onChange={(event) => patchStep(step.id, { instructions: event.target.value })} />
                </label>

                <label className="form-field">
                  Access
                  <select value={isPlanningStep(step) ? 'read-only' : step.access} disabled={isPlanningStep(step) || Boolean(step.validation || step.council)} onChange={(event) => patchStep(step.id, { access: event.target.value as StepDefinition['access'] })}>
                    <option value="read-only">Preserve source (shell enabled)</option>
                    <option value="workspace-write">Edit source (shell enabled)</option>
                  </select>
                </label>

                <label className="wf-checkbox">
                  <input type="checkbox" checked={isPlanningStep(step)} disabled={Boolean(step.validation || step.council)} onChange={event => patchStep(step.id, { planning: event.target.checked, ...(event.target.checked ? { access: 'read-only', approval: true } : {}) })} />
                  Planning conversation
                </label>
                {isPlanningStep(step) && <p className="field-helper wf-checkbox">Ask questions and agree on a plan. Read-only, with approval before continuing.</p>}
                <label className="wf-checkbox">
                  <input type="checkbox" checked={isPlanningStep(step) || step.approval} disabled={isPlanningStep(step) || Boolean(step.council)} onChange={(event) => patchStep(step.id, { approval: event.target.checked })} />
                  Require approval after this step
                </label>
                  </div>
                </details>
              </li>
            ))}
          </ol>

          <button
            type="button"
            className="button"
            disabled={draft.steps.length >= MAX_STEPS}
            onClick={() => {
              const step = newStep();
              patchDraft({ steps: [...draft.steps, step] });
              setExpandedSteps(previous => ({ ...previous, [step.id]: true }));
            }}
          >
            Add step
          </button>

          <div className="wf-submit">
            <button type="submit" className="button button-primary" disabled={saving}>
              {saving ? 'Saving…' : 'Save workflow'}
            </button>
            {message && (
              <p className="wf-message" role={message.kind === 'error' ? 'alert' : 'status'}>
                {message.text}
              </p>
            )}
          </div>
        </form>
      )}
    </section>
  );
}
