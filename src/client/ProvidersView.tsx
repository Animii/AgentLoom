import { useState } from 'react';
import type { ProviderInfo } from '../shared/types';
import JevPanel from './JevPanel';

export default function ProvidersView({
  providers,
  loading,
  onRefresh,
}: {
  providers: ProviderInfo[];
  loading: boolean;
  onRefresh: () => void;
}) {
  const [copyError, setCopyError] = useState<string | null>(null);

  async function copyCommand(command: string) {
    try {
      await navigator.clipboard.writeText(command);
      setCopyError(null);
    } catch {
      setCopyError(
        'Could not copy to clipboard. Select the command and copy it manually.',
      );
    }
  }

  return (
    <section className="panel providers-view">
      <h2>Agent connections</h2>
      <p className="providers-hint">
        CLI availability is shown below. Login is verified when a live run
        starts.
      </p>

      <button
        type="button"
        className="button"
        disabled={loading}
        onClick={onRefresh}
      >
        {loading ? 'Rechecking…' : 'Recheck'}
      </button>

      {loading && providers.length === 0 && (
        <p className="providers-empty">Checking installed CLIs…</p>
      )}
      {!loading && providers.length === 0 && (
        <p className="providers-empty">No providers detected.</p>
      )}

      <div className="providers-grid">
        {providers.map((provider) => (
          <article key={provider.id} className="provider-card">
            <header className="provider-card-header">
              <h3>{provider.name}</h3>
              <span
                className={`provider-status${provider.installed ? ' is-installed' : ''}`}
              >
                {provider.installed ? 'Installed' : 'Not found'}
              </span>
            </header>

            <details className="provider-details">
              <summary>Connection details</summary>
              <p className="provider-meta">
                Version: {provider.version ?? 'unknown'}
              </p>
              <p className="provider-meta">
                Suggested model: {provider.suggestedModel || 'CLI default'}
              </p>
              <p className="provider-meta">
                Effort options: {provider.efforts.join(', ') || 'default'}
              </p>

              {provider.error && (
                <p className="provider-error">{provider.error}</p>
              )}

              <div className="provider-login">
                <code>{provider.loginCommand}</code>
                <button
                  type="button"
                  className="button"
                  onClick={() => {
                    void copyCommand(provider.loginCommand);
                  }}
                >
                  Copy
                </button>
              </div>
            </details>
          </article>
        ))}
      </div>

      {copyError && (
        <p className="providers-copy-error" role="alert">
          {copyError}
        </p>
      )}

      <JevPanel />
    </section>
  );
}
