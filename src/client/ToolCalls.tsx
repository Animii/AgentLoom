import type { PlanningToolCall } from '../shared/types';

function toolTarget(input: PlanningToolCall['input']): string {
  for (const key of ['path', 'file_path', 'query', 'command']) {
    const value: unknown = input[key];
    if (typeof value === 'string' && value !== '') return value;
    if (typeof value === 'number' || typeof value === 'boolean')
      return String(value);
  }
  return '';
}

const labels: Record<string, string> = {
  command_execution: 'Run command',
  file_change: 'Change files',
  web_search: 'Search web',
  Bash: 'Run command',
  bash: 'Run command',
  list_project_files: 'List project files',
  read_project_file: 'Read project file',
  search_project: 'Search project',
  ask_user: 'Ask a question',
};

export default function ToolCalls({
  calls,
  running,
  activeSince,
}: {
  calls: PlanningToolCall[];
  running: boolean;
  activeSince: string | null;
}) {
  if (!calls.length) return null;
  const activeCount = calls.filter(
    (call) =>
      call.status === 'running' &&
      running &&
      (!activeSince || call.startedAt >= activeSince),
  ).length;
  const failedCount = calls.filter((call) => call.status === 'failed').length;
  return (
    <details className="tool-call-group">
      <summary>
        Tool calls <span>{calls.length}</span>
        <span className="tool-group-status">
          {activeCount
            ? `${String(activeCount)} running`
            : failedCount
              ? `${String(failedCount)} failed`
              : 'Finished'}
        </span>
      </summary>
      <ul className="chat-tool-calls" aria-label="Tool calls">
        {calls.map((call) => {
          const active =
            running && (!activeSince || call.startedAt >= activeSince);
          const state =
            call.status === 'running'
              ? active
                ? 'Running'
                : 'Stopped'
              : call.status === 'completed'
                ? 'Completed'
                : call.status === 'unknown'
                  ? 'Result unavailable'
                  : 'Failed';
          const target = toolTarget(call.input);
          return (
            <li key={call.id}>
              <details
                className={`chat-tool-call tool-${state.toLowerCase().replaceAll(' ', '-')}`}
              >
                <summary>
                  <span className="tool-state-dot" aria-hidden="true" />
                  <span className="tool-call-label">
                    {labels[call.name] ?? call.name}
                    {target && <span className="tool-target">{target}</span>}
                  </span>
                  <span className="tool-call-state">{state}</span>
                </summary>
                <div className="tool-call-details">
                  <code>{call.name}</code>
                  {Object.keys(call.input).length > 0 && (
                    <dl>
                      {Object.entries(call.input).map(([key, value]) => (
                        <div key={key}>
                          <dt>{key}</dt>
                          <dd>{String(value) || '(project root)'}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                  <p>
                    {call.summary ??
                      (state === 'Running'
                        ? 'Waiting for the tool result…'
                        : 'No result was recorded.')}
                  </p>
                </div>
              </details>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
