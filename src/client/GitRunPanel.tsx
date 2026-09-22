import { useCallback, useEffect, useState } from 'react';
import type { GitPreview, Run } from '../shared/types';

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

function parsePreview(value: unknown): GitPreview | null {
  if (
    !isRecord(value) ||
    typeof value.branch !== 'string' ||
    typeof value.baseBranch !== 'string' ||
    typeof value.baseCommit !== 'string' ||
    typeof value.head !== 'string' ||
    typeof value.tree !== 'string' ||
    typeof value.token !== 'string' ||
    typeof value.stat !== 'string' ||
    typeof value.diff !== 'string' ||
    typeof value.title !== 'string' ||
    typeof value.body !== 'string' ||
    typeof value.canPublish !== 'boolean'
  )
    return null;
  return {
    branch: value.branch,
    baseBranch: value.baseBranch,
    baseCommit: value.baseCommit,
    head: value.head,
    tree: value.tree,
    token: value.token,
    stat: value.stat,
    diff: value.diff,
    title: value.title,
    body: value.body,
    canPublish: value.canPublish,
    ...(typeof value.repository === 'string'
      ? { repository: value.repository }
      : {}),
    ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
    ...(typeof value.prUrl === 'string' ? { prUrl: value.prUrl } : {}),
  };
}

export default function GitRunPanel({ run }: { run: Run }) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<GitPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [title, setTitle] = useState(run.title);
  const [body, setBody] = useState('');
  const [url, setUrl] = useState(run.git?.prUrl ?? '');
  const load = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/runs/${run.id}/git`);
      const data: unknown = await response.json();
      if (!response.ok) throw Error(errorMessage(data, 'Could not load diff'));
      const loaded = parsePreview(data);
      if (!loaded) throw Error('Could not load diff');
      setPreview(loaded);
      setTitle(loaded.title);
      setBody(loaded.body);
      setUrl(loaded.prUrl ?? '');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load diff');
    } finally {
      setBusy(false);
    }
  }, [run.id]);
  useEffect(() => {
    if (open) void load();
  }, [run.id, run.status, open, load]);
  useEffect(() => {
    setUrl(run.git?.prUrl ?? '');
  }, [run.id, run.git?.prUrl]);
  if (!run.git) return null;
  async function publish() {
    if (!preview) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/runs/${run.id}/pull-request`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: preview.token, title, body }),
      });
      const data: unknown = await response.json();
      if (!response.ok) throw Error(errorMessage(data, 'PR creation failed'));
      setUrl(isRecord(data) && typeof data.url === 'string' ? data.url : '');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'PR creation failed');
    } finally {
      setBusy(false);
    }
  }
  return (
    <details
      className="git-run-panel"
      open={open}
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
      }}
    >
      <summary>Branch {run.git.branch} · Diff and draft PR</summary>
      <p className="field-helper">
        Base: {run.git.baseBranch} · {run.git.baseCommit.slice(0, 8)}
        {run.git.repository
          ? ` · ${run.git.repository}`
          : ' · No GitHub origin configured'}
      </p>
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      <button
        type="button"
        className="btn ghost"
        disabled={busy}
        onClick={() => void load()}
      >
        Refresh diff
      </button>
      {preview && (
        <>
          <pre className="git-diff-stat">
            {preview.stat || 'No changes yet.'}
          </pre>
          <details>
            <summary>View patch</summary>
            <pre className="git-diff">{preview.diff || 'No changes.'}</pre>
          </details>
        </>
      )}
      {url && (
        <p>
          <a href={url} target="_blank" rel="noreferrer">
            Open draft pull request
          </a>
        </p>
      )}
      {(!url || run.crate?.updatingPr) && preview && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void publish();
          }}
        >
          <div className="field">
            <label htmlFor="pr-title">PR title</label>
            <input
              id="pr-title"
              value={title}
              maxLength={200}
              onChange={(event) => {
                setTitle(event.target.value);
              }}
            />
          </div>
          <div className="field">
            <label htmlFor="pr-description">PR description</label>
            <textarea
              id="pr-description"
              rows={7}
              value={body}
              maxLength={30000}
              onChange={(event) => {
                setBody(event.target.value);
              }}
            />
          </div>
          <p className="field-helper">
            Review the patch and description. Creating a draft PR commits these
            changes and pushes only this run's branch. It does not merge
            anything.
          </p>
          {preview.reason && <p>{preview.reason}</p>}
          <button
            type="submit"
            className="btn primary"
            disabled={
              busy || !preview.canPublish || !title.trim() || run.git.publishing
            }
          >
            {busy
              ? 'Working…'
              : run.crate?.updatingPr
                ? 'Update draft PR'
                : 'Create draft PR'}
          </button>
          <details>
            <summary>GitHub authentication</summary>
            <p>
              Sign in once from a terminal; credentials stay in the agent home
              volume.
            </p>
            <code>
              docker compose exec platform gh auth login --hostname github.com
              --git-protocol https --web
            </code>
          </details>
        </form>
      )}
    </details>
  );
}
