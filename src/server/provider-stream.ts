import type { AgentEvent, ProviderId } from '../shared/types.js';

export interface ParsedAgentLine {
  text?: string;
  sessionId?: string;
  costUsd?: number;
  error?: string;
  complete?: boolean;
  delta?: boolean;
  silent?: boolean;
}

export class AgentTextStream {
  output = '';
  private claudePartial = false;
  constructor(private readonly provider: ProviderId) {}

  accept(parsed: ParsedAgentLine): AgentEvent | undefined {
    if (parsed.text === undefined) return;
    if (this.provider === 'claude' && parsed.complete) {
      this.output = parsed.text;
      return { type: 'output', message: parsed.text, replace: true };
    }
    if (this.provider === 'claude' && parsed.delta) this.claudePartial = true;
    else if (this.provider === 'claude' && this.claudePartial) {
      this.claudePartial = false;
      return; // Assistant envelopes repeat the preceding partial text.
    }
    const text =
      (this.provider === 'codex' && this.output ? '\n\n' : '') + parsed.text;
    this.output += text;
    return { type: 'output', message: text };
  }
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return undefined;
  return value as JsonRecord;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asCost(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function claudeText(message: JsonRecord): string | undefined {
  const content = message.content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    const record = asRecord(block);
    if (record?.type !== 'text') continue;
    const text = asString(record.text);
    if (text !== undefined) parts.push(text);
  }
  return parts.length > 0 ? parts.join('') : undefined;
}

function claudeError(record: JsonRecord): string {
  const direct = asString(record.result);
  if (direct !== undefined && direct.length > 0) return direct;
  const errors = record.errors;
  if (Array.isArray(errors)) {
    const messages: string[] = [];
    for (const entry of errors) {
      const text = asString(entry) ?? asString(asRecord(entry)?.message);
      if (text !== undefined && text.length > 0) messages.push(text);
    }
    if (messages.length > 0) return messages.join('; ');
  }
  return 'Claude reported an error';
}

function codexError(record: JsonRecord): string {
  const text =
    asString(record.error) ??
    asString(asRecord(record.error)?.message) ??
    asString(record.message);
  return text !== undefined && text.length > 0
    ? text
    : 'Codex reported an error';
}

function openCodeError(record: JsonRecord): string {
  const error = record.error;
  if (typeof error === 'string' && error.length > 0) return error;
  const entry = asRecord(error);
  if (entry !== undefined) {
    const data = asRecord(entry.data);
    const text =
      (data !== undefined ? asString(data.message) : undefined) ??
      asString(entry.message) ??
      asString(entry.data) ??
      asString(entry.name);
    if (text !== undefined && text.length > 0) return text;
  }
  return 'OpenCode reported an error';
}
export function parseAgentLine(
  provider: ProviderId,
  line: string,
): ParsedAgentLine {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return {};
  }
  const record = asRecord(parsed);
  if (record === undefined) return {};
  const type = asString(record.type);

  if (provider === 'claude') {
    if (type === 'stream_event') {
      const event = asRecord(record.event);
      const delta = asRecord(event?.delta);
      if (
        event?.type === 'content_block_delta' &&
        delta?.type === 'text_delta' &&
        typeof delta.text === 'string'
      )
        return { text: delta.text, delta: true };
      return { silent: true };
    }
    if (type === 'assistant') {
      const message = asRecord(record.message);
      const text = message !== undefined ? claudeText(message) : undefined;
      return text !== undefined ? { text } : {};
    }
    if (type === 'result') {
      const subtype = asString(record.subtype);
      const isError =
        record.is_error === true ||
        (subtype !== undefined && subtype.startsWith('error'));
      const out: ParsedAgentLine = {};
      if (!isError) {
        const text = asString(record.result);
        if (text !== undefined) out.text = text;
      }
      const sessionId = asString(record.session_id);
      if (sessionId !== undefined) out.sessionId = sessionId;
      const cost = asCost(record.total_cost_usd);
      if (cost !== undefined) out.costUsd = cost;
      if (isError) out.error = claudeError(record);
      else out.complete = true;
      return out;
    }
    return {};
  }
  if (provider === 'codex') {
    if (type === 'thread.started') {
      const sessionId = asString(record.thread_id);
      return sessionId !== undefined ? { sessionId } : {};
    }
    if (type === 'item.completed') {
      const item = asRecord(record.item);
      if (item?.type !== 'agent_message') return {};
      const text = asString(item.text);
      return text !== undefined ? { text } : {};
    }
    if (type === 'turn.failed' || type === 'error') {
      return { error: codexError(record) };
    }
    if (type === 'turn.completed') return { complete: true };
    return {};
  }
  const sessionId = asString(record.sessionID);
  if (type === 'text') {
    const part = asRecord(record.part);
    const out: ParsedAgentLine = {};
    const text = part !== undefined ? asString(part.text) : undefined;
    if (text !== undefined) out.text = text;
    if (sessionId !== undefined) out.sessionId = sessionId;
    return out;
  }
  if (type === 'step_finish') {
    const part = asRecord(record.part);
    const out: ParsedAgentLine = {};
    const cost = part !== undefined ? asCost(part.cost) : undefined;
    if (cost !== undefined) out.costUsd = cost;
    const reason = part !== undefined ? asString(part.reason) : undefined;
    if (reason === 'stop') out.complete = true;
    if (reason === 'length') out.error = 'Provider output limit reached';
    if (sessionId !== undefined) out.sessionId = sessionId;
    return out;
  }
  if (type === 'error') {
    const out: ParsedAgentLine = { error: openCodeError(record) };
    if (sessionId !== undefined) out.sessionId = sessionId;
    return out;
  }
  return {};
}
