import type { AgentResult, ExecuteAgent } from '../../src/shared/types.js';

export type AgentCall = Parameters<ExecuteAgent>;
export type AgentScript = AgentResult | Error | ExecuteAgent;

/** A finite script rejects accidental retries and captures prompts for assertions. */
export function scriptedAgent(script: readonly AgentScript[]) {
  const calls: AgentCall[] = [];
  const execute: ExecuteAgent = async (...args) => {
    const index = calls.push(args) - 1;
    const item = script.at(index);
    if (!item)
      throw new Error(
        `Unexpected agent call ${String(index + 1)}; script exhausted.`,
      );
    if (item instanceof Error) throw item;
    if (typeof item === 'function') return item(...args);
    return structuredClone(item);
  };
  return { execute, calls };
}

export function agentResult(output: string): AgentResult {
  return { output, sessionId: null, costUsd: null };
}
