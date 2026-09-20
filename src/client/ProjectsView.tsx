import { useEffect, useState } from 'react';
import type { ProjectInfo, Run } from '../shared/types.js';
import ProjectImport from './ProjectImport';
import { useUrlState, useUrlSelection, updateUrl } from './url-state';

interface FolderListing { path: string; hostPath: string; folders: { name: string; path: string }[]; canConnect: boolean }
async function api<T>(url: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(url, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const value = await response.json(); if (!response.ok) throw new Error(value.error ?? 'Request failed.'); return value;
}

export default function ProjectsView({ projects, runs, refresh, onRun, onOpenRun, connectRequest }: {
  projects: ProjectInfo[]; runs: Run[]; refresh: () => Promise<void>; onRun: (id: string) => void; onOpenRun: (id: string) => void;
  connectRequest: number;
}) {
  const [connecting, setConnecting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [folderPath, setFolderPath] = useState('');
  const [name, setName] = useState('');
  const [mode, setMode] = useState<'direct' | 'isolated' | 'worktree'>('direct');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [scope, setScope] = useUrlState<string>('projectStatus', 'active', ['active', 'archived', 'disconnected']);
  const [search, setSearch] = useUrlState<string>('projectQuery', '', undefined, 'replace');
  const [selected, setSelected] = useUrlSelection('project');
  const [rename, setRename] = useState('');
  const [disconnect, setDisconnect] = useState(false);
  const project = projects.find(item => item.id === selected);
  useEffect(() => { if (connectRequest) { setConnecting(true); setImporting(false); void browse(''); } }, [connectRequest]);
  useEffect(() => { setRename(project?.name ?? ''); setDisconnect(false); }, [project?.id, project?.name]);

  async function browse(value: string) {
    setBusy(true); setError(null);
    try { const next = await api<FolderListing>(`/api/project-folders?path=${encodeURIComponent(value)}`); setListing(next); setFolderPath(next.path); setName(next.path.split('/').at(-1) ?? ''); }
    catch (caught) { setError((caught as Error).message); setListing(null); }
    finally { setBusy(false); }
  }
  async function connect() {
    if (!listing?.canConnect) return;
    setBusy(true); setError(null);
    try { const created = await api<ProjectInfo>('/api/projects', 'POST', { name, folder: listing.path, workspaceMode: mode }); await refresh(); setConnecting(false); setSelected(created.id); setScope('active'); setNotice('Folder connected.'); }
    catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  }
  async function update(changes: object) {
    if (!project) return;
    setBusy(true); setError(null); setNotice('');
    try { await api(`/api/projects/${project.id}`, 'PATCH', changes); await refresh(); setNotice('Project updated.'); setDisconnect(false); }
    catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  }
  const visible = projects.filter(item => (item.status ?? 'active') === scope && `${item.name} ${item.hostPath ?? ''}`.toLowerCase().includes(search.toLowerCase()));

  return <div className="projects-view">
    <header className="page-head"><div><h1 className="page-title" tabIndex={-1}>Projects</h1><p className="page-lede">Connect your folders and choose where agents work.</p></div><button className="button button-primary" disabled={busy || importing} onClick={() => { setConnecting(true); setSelected(null); void browse(''); }}>Connect folder</button></header>
    {error && <p role="alert" className="error-banner">{error}</p>}
    {notice && <p role="status" className="field-helper">{notice}</p>}
    {importing ? <section className="project-editor"><ProjectImport titleId="projects-import-title" onBusy={setBusy} onCancel={() => setImporting(false)} onCreated={item => { void refresh(); setImporting(false); setScope('active'); setSelected(item.id); }} /></section> : connecting ? <section className="project-editor" aria-label="Connect a folder">
      <h2>Connect a folder</h2><p>Browse the shared Projects directory or enter a folder path inside it.</p>
      <form className="folder-location" onSubmit={event => { event.preventDefault(); void browse(folderPath); }}><label htmlFor="connect-folder-path">Folder path</label><div><input id="connect-folder-path" value={folderPath} onChange={event => setFolderPath(event.target.value)} placeholder="Project folder or full host path" disabled={busy} /><button className="button button-secondary" disabled={busy}>Open folder</button></div></form>
      {listing && <><p className="project-path">{listing.hostPath}</p><div className="folder-browser">
        {listing.path && <button className="button button-ghost" disabled={busy} onClick={() => void browse(listing.path.split('/').slice(0, -1).join('/'))}>Up one folder</button>}
        {listing.folders.map(folder => <button className="folder-entry" key={folder.path} disabled={busy} onClick={() => void browse(folder.path)}><span aria-hidden="true">📁</span> {folder.name}<span aria-hidden="true">›</span></button>)}
        {!listing.folders.length && <p className="field-helper">No subfolders. You can connect this folder.</p>}
      </div>
      <div className="field"><label htmlFor="connect-name">Project name</label><input id="connect-name" value={name} maxLength={100} disabled={busy} onChange={event => setName(event.target.value)} /></div>
      <div className="field"><label htmlFor="connect-mode">Workspace mode</label><select id="connect-mode" value={mode} disabled={busy} onChange={event => setMode(event.target.value as 'direct' | 'isolated' | 'worktree')}><option value="direct">Work directly in folder</option><option value="isolated">Use isolated copies</option><option value="worktree">Git worktree (branch per run)</option></select><p className="field-helper">{mode === 'worktree' ? 'Each run uses a new Git branch from committed code. Keep the source working tree clean.' : mode === 'direct' ? 'Live implementation steps change files in this folder. Planning stays read-only.' : 'Each run gets a copy. Your original folder is unchanged.'}</p></div></>}
      <div className="dialog-actions"><button className="button button-ghost" disabled={busy} onClick={() => setConnecting(false)}>Cancel</button><button className="button button-primary" disabled={busy || !listing?.canConnect || !name.trim() || folderPath !== listing.path} onClick={() => void connect()}>Connect this folder</button></div>
      <details><summary>Folder outside this directory?</summary><p className="field-helper">Set PROJECTS_FOLDER in AgentLoom’s .env to a parent directory containing your projects, then run docker compose up -d. You can also import a copy from any folder.</p></details>
    </section> : <>
      <div className="overview-tools"><input type="search" aria-label="Search projects" placeholder="Search projects" value={search} onChange={event => setSearch(event.target.value)} /><select aria-label="Project status" value={scope} onChange={event => { updateUrl({ projectStatus: event.target.value === 'active' ? null : event.target.value, project: null }); }}><option value="active">Active</option><option value="archived">Archived</option><option value="disconnected">Disconnected</option></select><button className="button button-ghost" onClick={() => { setImporting(true); setSelected(null); }}>Import a copy</button></div>
      <ul className="project-list">{visible.map(item => <li key={item.id}><button className={`project-row${selected === item.id ? ' selected' : ''}`} onClick={() => setSelected(selected === item.id ? null : item.id)} aria-expanded={selected === item.id}><span><strong>{item.name}</strong><span className="project-path">{item.hostPath ?? item.sourcePath ?? item.id}</span></span><span className="field-helper">{item.kind === 'connected' ? 'Connected folder' : 'Imported copy'} · {item.workspaceMode === 'worktree' ? 'Git worktree' : item.workspaceMode === 'direct' ? 'Direct' : 'Isolated'}{item.available === false ? ' · Folder unavailable' : ''}</span><span className="field-helper">{runs.filter(run => run.project === item.id).length} runs</span></button></li>)}</ul>
      {!visible.length && <p className="empty-note">No {scope} projects. Connect a folder to get started.</p>}
      {project && <section className="project-editor" aria-label="Project settings">
        <h2>{project.name}</h2><p className="project-path">{project.hostPath ?? project.id}</p>
        <div className="field"><label htmlFor="project-rename">Project name</label><div className="project-inline"><input id="project-rename" value={rename} maxLength={100} disabled={busy} onChange={event => setRename(event.target.value)} /><button className="button button-secondary" disabled={busy || !rename.trim() || rename === project.name} onClick={() => void update({ name: rename })}>Save name</button></div></div>
        <div className="field"><label htmlFor="project-mode">Workspace mode</label><select id="project-mode" value={project.workspaceMode ?? 'isolated'} disabled={busy || project.status !== 'active'} onChange={event => void update({ workspaceMode: event.target.value })}><option value="direct">Work directly in folder</option><option value="isolated">Use isolated copies</option><option value="worktree">Git worktree (branch per run)</option></select><p className="field-helper">{project.workspaceMode === 'worktree' ? 'Each new run uses a dedicated Git branch and worktree from committed code.' : project.workspaceMode === 'direct' ? 'Live implementation edits this folder. Planning stays read-only.' : 'Each new run gets an isolated copy.'} Changes apply to new runs.</p></div>
        <div className="project-actions">{project.status === 'active' ? <><button className="button button-primary" disabled={busy || project.available === false} onClick={() => onRun(project.id)}>New run for project</button><button className="button button-secondary" disabled={busy} onClick={() => void update({ status: 'archived' })}>Archive</button><button className="button button-ghost" disabled={busy} onClick={() => setDisconnect(true)}>Disconnect</button></> : <><button className="button button-primary" disabled={busy || project.available === false} onClick={() => void update({ status: 'active' })}>{project.status === 'disconnected' ? 'Reconnect' : 'Restore project'}</button>{project.status === 'archived' && <button className="button button-ghost" disabled={busy} onClick={() => setDisconnect(true)}>Disconnect</button>}</>}</div>
        {disconnect && <div className="disconnect-confirm"><p>Disconnect this project? Its files and run history will remain.</p><button className="button button-secondary" disabled={busy} onClick={() => void update({ status: 'disconnected' })}>Disconnect project</button><button className="button button-ghost" onClick={() => setDisconnect(false)}>Keep connected</button></div>}
        <details><summary>Run history ({runs.filter(run => run.project === project.id).length})</summary><ul className="project-history">{runs.filter(run => run.project === project.id).map(run => <li key={run.id}><button onClick={() => onOpenRun(run.id)}>{run.title}<span>{run.status.replaceAll('_', ' ')}</span></button></li>)}</ul></details>
      </section>}
    </>}
  </div>;
}
