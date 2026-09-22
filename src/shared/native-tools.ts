import type {
  PlanningToolCall,
  ProviderId,
  RunEvent,
  StepRun,
} from './types.js';

type Row = Record<string, unknown>;
const row = (value: unknown): Row =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Row)
    : {};
const text = (value: unknown, fallback: string): string =>
  typeof value === 'string' ? value : fallback;
function safe(value: string): string {
  return value
    .replace(/(bearer\s+)\S+/gi, '$1[redacted]')
    .replace(
      /((?:api[_-]?key|token|password|secret|authorization)["']?\s*[:=]\s*["']?)[^\s"'&]+/gi,
      '$1[redacted]',
    )
    .replace(/\b(?:sk-|sk_)[A-Za-z0-9_-]{12,}/g, '[redacted]')
    .replace(/https?:\/\/[^\s"']+/g, '[URL]')
    .slice(0, 1000);
}
function input(value: unknown): PlanningToolCall['input'] {
  const result: PlanningToolCall['input'] = {};
  const source = row(value);
  for (const key of [
    'command',
    'path',
    'file_path',
    'filePath',
    'pattern',
    'query',
    'description',
  ]) {
    if (typeof source[key] === 'string') result[key] = safe(source[key]);
  }
  return result;
}

/** Stateful because Claude reports results separately from tool names and arguments. */
export class NativeToolStream {
  private calls = new Map<string, PlanningToolCall>();
  constructor(
    private provider: ProviderId,
    private prefix = '',
  ) {}
  accept(line: string, timestamp: string): PlanningToolCall[] {
    let data: Row;
    try {
      data = row(JSON.parse(line));
    } catch {
      // Older Activity entries were truncated. Recover only complete JSON fields,
      // never infer a successful result from a truncated completion envelope.
      if (this.provider !== 'codex' || !line.startsWith('{"type":"item.'))
        return [];
      const field = (key: string): unknown => {
        const match = new RegExp('"' + key + '":("(?:[^"\\\\]|\\\\.)*")').exec(
          line,
        );
        try {
          return match ? (JSON.parse(match[1]) as unknown) : undefined;
        } catch {
          return undefined;
        }
      };
      const type = field('type'),
        id = field('id');
      if (!id || !line.includes('"type":"command_execution"')) return [];
      data = {
        type,
        item: {
          id,
          type: 'command_execution',
          command: field('command'),
          truncated: true,
        },
      };
    }
    const updates: PlanningToolCall[] = [];
    const put = (
      id: unknown,
      name: string,
      status: PlanningToolCall['status'],
      args: unknown,
      summary?: string,
    ) => {
      if (typeof id !== 'string' || !id) return;
      const key = this.prefix + id;
      const previous = this.calls.get(key);
      const call: PlanningToolCall = {
        id: key,
        name: previous?.name ?? name,
        status,
        input: { ...previous?.input, ...input(args) },
        startedAt: previous?.startedAt ?? timestamp,
        ...(status !== 'running' ? { finishedAt: timestamp } : {}),
        summary,
      };
      this.calls.set(key, call);
      updates.push(call);
    };
    const itemType = typeof data.type === 'string' ? data.type : '';
    if (
      this.provider === 'codex' &&
      ['item.started', 'item.updated', 'item.completed'].includes(itemType)
    ) {
      const item = row(data.item);
      const itemKind = typeof item.type === 'string' ? item.type : '';
      if (
        ![
          'command_execution',
          'file_change',
          'mcp_tool_call',
          'web_search',
        ].includes(itemKind)
      )
        return [];
      const failed =
        item.status === 'failed' ||
        !!item.error ||
        (typeof item.exit_code === 'number' && item.exit_code !== 0);
      const done = itemType === 'item.completed';
      const name =
        itemKind === 'mcp_tool_call' ? text(item.tool, 'MCP tool') : itemKind;
      const args =
        itemKind === 'command_execution'
          ? { command: item.command }
          : itemKind === 'file_change'
            ? {
                path: Array.isArray(item.changes)
                  ? item.changes
                      .map((change) => text(row(change).path, ''))
                      .join(', ')
                  : '',
              }
            : (item.arguments ?? { query: item.query });
      put(
        item.id,
        name,
        item.truncated && done
          ? 'unknown'
          : failed
            ? 'failed'
            : done
              ? 'completed'
              : 'running',
        args,
        item.truncated
          ? 'Completion recorded; result details were truncated.'
          : done
            ? typeof item.exit_code === 'number'
              ? `Exit code ${String(item.exit_code)}`
              : failed
                ? 'Tool reported an error.'
                : 'Tool completed.'
            : undefined,
      );
    }
    if (this.provider === 'claude') {
      const blocks = row(data.message).content;
      if (Array.isArray(blocks))
        for (const rawBlock of blocks) {
          const block = row(rawBlock);
          if (block.type === 'tool_use')
            put(block.id, text(block.name, 'Tool'), 'running', block.input);
          if (block.type === 'tool_result')
            put(
              block.tool_use_id,
              'Tool',
              block.is_error ? 'failed' : 'completed',
              {},
              block.is_error ? 'Tool reported an error.' : 'Tool completed.',
            );
        }
      const event = row(data.event),
        block = row(event.content_block);
      if (
        data.type === 'stream_event' &&
        event.type === 'content_block_start' &&
        block.type === 'tool_use'
      )
        put(block.id, text(block.name, 'Tool'), 'running', block.input);
    }
    if (this.provider === 'opencode' && data.type === 'tool_use') {
      const part = row(data.part),
        state = row(part.state);
      const status = state.status;
      put(
        part.callID ?? part.id,
        text(part.tool, 'Tool'),
        status === 'error'
          ? 'failed'
          : status === 'completed'
            ? 'completed'
            : 'running',
        state.input,
        status === 'error'
          ? 'Tool reported an error.'
          : status === 'completed'
            ? 'Tool completed.'
            : undefined,
      );
    }
    return updates;
  }
}

export function stepToolCalls(
  step: StepRun,
  events: RunEvent[],
): PlanningToolCall[] {
  if (step.status === 'pending') return [];
  const calls = new Map(
    (step.toolCalls ?? [])
      .filter(
        (call) =>
          !!step.conversation ||
          !step.startedAt ||
          call.startedAt >= step.startedAt,
      )
      .map((call) => [call.id, call]),
  );
  const parser = new NativeToolStream(
    step.definition.provider,
    `native-${String(step.attempt)}-`,
  );
  for (const event of events) {
    if (
      event.stepId !== step.definition.id ||
      event.type !== 'log' ||
      (step.startedAt && event.timestamp < step.startedAt)
    )
      continue;
    for (const call of parser.accept(event.message, event.timestamp)) {
      if (!calls.has(call.id)) calls.set(call.id, call);
      else if (!(step.toolCalls ?? []).some((saved) => saved.id === call.id))
        calls.set(call.id, call);
    }
  }
  return [...calls.values()].sort((a, b) =>
    a.startedAt.localeCompare(b.startedAt),
  );
}
