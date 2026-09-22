import type { ValidationEvidence } from '../shared/types';
export default function ValidationPanel({
  evidence,
}: {
  evidence: ValidationEvidence;
}) {
  const signals = evidence.signals;
  return (
    <section className="validation-evidence" aria-label="Recorded validation">
      <h3>Recorded validation · {evidence.status}</h3>
      <p className="field-helper">
        Attempt {evidence.attempt} ·{' '}
        {evidence.status === 'simulated'
          ? 'Demo only. No commands ran.'
          : 'Actual command results from this workspace. Generated build, dependency and report folders are excluded from the source fingerprint.'}
      </p>
      {evidence.commands.map((command, index) => (
        <details key={index}>
          <summary>
            <code>
              {[command.command.executable, ...command.command.args].join(' ')}
            </code>{' '}
            · {command.status} · exit {command.exitCode ?? '—'}
          </summary>
          <p className="field-helper">
            Started {new Date(command.startedAt).toLocaleTimeString()}
            {command.finishedAt
              ? ` · Finished ${new Date(command.finishedAt).toLocaleTimeString()}`
              : ''}
          </p>
          {command.truncated && (
            <p>Only the last 64,000 characters are retained.</p>
          )}
          <pre>{command.output || 'No output recorded yet.'}</pre>
        </details>
      ))}
      {evidence.after && (
        <p className="field-helper">
          Source {evidence.before === evidence.after ? 'unchanged' : 'changed'}{' '}
          during validation · {evidence.after.slice(0, 12)}
        </p>
      )}
      <h4>Jev signals</h4>
      {signals?.status === 'ready' ? (
        <>
          <ul>
            <li>
              Claims supported by evidence:{' '}
              {Math.round((signals.claimsSupported ?? 0) * 100)}%
            </li>
            <li>
              Possible scope drift:{' '}
              {Math.round((signals.scopeDrift ?? 0) * 100)}%
            </li>
            <li>
              Human decision needed:{' '}
              {Math.round((signals.needsHuman ?? 0) * 100)}%
            </li>
          </ul>
          <p className="field-helper">
            Estimated probabilities from {signals.model}. Advisory signals for
            the reviewer; they do not approve work or prove correctness.
          </p>
        </>
      ) : (
        <p>
          {signals?.message ??
            (evidence.status === 'running'
              ? 'Available after the commands finish.'
              : 'Signals unavailable.')}
        </p>
      )}
    </section>
  );
}
