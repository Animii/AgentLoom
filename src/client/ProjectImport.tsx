import { useRef, useState } from 'react';
import type { ProjectInfo } from '../shared/types.js';
import { excludedProjectPath, IMPORT_MAX_BYTES, IMPORT_MAX_FILE_BYTES, IMPORT_MAX_FILES, projectSlug } from '../shared/project-import.js';

async function request<T>(url: string, method: string, body?: unknown): Promise<T> {
  const response = await fetch(url, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  if (!response.ok) { const payload = await response.json().catch(() => ({})); throw new Error(payload.error ?? `Import failed (${response.status}).`); }
  return response.status === 204 ? undefined as T : response.json();
}

export default function ProjectImport({ titleId, onCreated, onCancel, onBusy }: {
  titleId: string; onCreated: (project: ProjectInfo) => void; onCancel: () => void; onBusy: (busy: boolean) => void;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const cancelled = useRef(false);
  const [files, setFiles] = useState<{ file: File; path: string }[]>([]);
  const [folder, setFolder] = useState('');
  const [name, setName] = useState('');
  const [skipped, setSkipped] = useState(0);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [finalizing, setFinalizing] = useState(false);

  function select(selected: FileList | null) {
    if (!selected?.length) return;
    setError(null); setFiles([]); setProgress(0);
    const all = [...selected]; const folderName = all[0].webkitRelativePath.split('/')[0];
    setFolder(folderName); setName(projectSlug(folderName));
    const included = all.map(file => ({ file, path: file.webkitRelativePath.split('/').slice(1).join('/') })).filter(item => !excludedProjectPath(item.path));
    setSkipped(all.length - included.length);
    if (!included.length) { setError('This folder has no importable files. Choose a folder containing your project files.'); return; }
    if (included.length > IMPORT_MAX_FILES || included.reduce((sum, item) => sum + item.file.size, 0) > IMPORT_MAX_BYTES) { setError('Select a project with up to 10,000 files and 100 MB after exclusions.'); return; }
    const large = included.find(item => item.file.size > IMPORT_MAX_FILE_BYTES);
    if (large) { setError(`${large.path} exceeds the 10 MB per-file limit.`); return; }
    setFiles(included);
  }

  async function create() {
    if (busy || !files.length) return;
    setBusy(true); onBusy(true); setError(null); setProgress(0); cancelled.current = false; setCancelling(false);
    let id: string | undefined;
    try {
      ({ id } = await request<{ id: string }>('/api/project-imports', 'POST', { name, fileCount: files.length }));
      for (let index = 0; index < files.length; index++) {
        if (cancelled.current) break;
        const item = files[index]; const bytes = new Uint8Array(await item.file.arrayBuffer());
        let binary = ''; for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
        if (cancelled.current) break;
        await request(`/api/project-imports/${id}/files`, 'PUT', { path: item.path, data: btoa(binary) });
        setProgress(index + 1);
      }
      if (cancelled.current) { await request(`/api/project-imports/${id}`, 'DELETE'); id = undefined; setError('Import cancelled. No project was created.'); return; }
      setFinalizing(true);
      const project = await request<ProjectInfo>(`/api/project-imports/${id}/complete`, 'POST', {});
      id = undefined; onCreated(project);
    } catch (caught) {
      if (id) await request(`/api/project-imports/${id}`, 'DELETE').catch(() => {});
      setError(caught instanceof Error ? caught.message : 'Could not import the folder. Try again.');
    } finally { setBusy(false); onBusy(false); setCancelling(false); setFinalizing(false); }
  }

  return <div className="project-import">
    <h2 id={titleId} className="dialog-title">Add project from folder</h2>
    <p>Choose a folder on your computer. AgentLoom imports a copy for your runs; your original folder stays unchanged.</p>
    <input ref={picker} type="file" aria-label="Project folder" {...{ webkitdirectory: '', directory: '' }} multiple hidden disabled={busy} onChange={event => select(event.target.files)} />
    <button type="button" className="button button-secondary" disabled={busy} onClick={() => picker.current?.click()}>{folder ? 'Choose a different folder' : 'Choose folder'}</button>
    {folder && <div className="import-selection"><strong>{folder}</strong><p>{files.length} files{skipped ? ` · ${skipped} excluded` : ''}</p></div>}
    <p className="field-helper">Excludes .git, node_modules, .env files, .auth and .data. Includes .env.example. Up to 100 MB total and 10 MB per file.</p>
    {files.length > 0 && <div className="field"><label htmlFor={`${titleId}-name`}>Project name</label><input id={`${titleId}-name`} value={name} maxLength={80} disabled={busy} onChange={event => setName(event.target.value)} /><p className="field-helper">Letters, numbers, hyphens and underscores.</p></div>}
    {busy && <div role="status"><progress value={progress} max={files.length} aria-label="Import progress" /><p>{finalizing ? 'Creating project…' : cancelling ? 'Finishing the current file, then cancelling…' : `Importing ${progress} of ${files.length} files…`}</p></div>}
    {error && <p className="error-banner" role="alert">{error}</p>}
    <div className="dialog-actions">
      <button type="button" className="button button-ghost" disabled={cancelling || finalizing} onClick={() => { if (busy) { cancelled.current = true; setCancelling(true); } else onCancel(); }}>{busy ? 'Cancel import' : 'Back to run'}</button>
      <button type="button" className="button button-primary" disabled={busy || !files.length || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(name)} onClick={() => void create()}>Create project</button>
    </div>
  </div>;
}
