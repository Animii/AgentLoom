import { randomUUID } from 'node:crypto';
import type { PlanningMessage, Run, StepRun } from '../shared/types.js';

export const PLANNING_LIMIT = 80_000;
export const PLANNING_INSTRUCTIONS = `# Planning conversation rules
You are in a conversation with the user to build a shared understanding, not implementing a task.
Inspect the workspace read-only when useful. Do not modify project source files. You may execute shell commands to inspect the project and environment.
You have read-only access to the selected project through agentloom MCP tools: list_project_files, read_project_file and search_project. Discover these tools with tool search if deferred. Use project-relative paths (empty path lists the root); inspect relevant files before asking the user for repository context. These tools do not execute shell commands. Page through listings or file lines and narrow searches when truncated. Do not ask the user to paste files already accessible through these tools. If a tool actually fails, explain the specific missing access and ask only for the information still needed.
Ask up to three focused questions at a time when goals, scope, constraints or acceptance criteria are unclear.
Use the agentloom ask_user MCP tool for questions. It displays one question at a time above the composer, with optional choices and a custom answer. Give each question a short header. Prefer options with a short label and a description explaining the tradeoff; mark your recommended option with recommended: true. Use multiSelect: true only when multiple choices can apply. Do not include an Other option; the UI provides custom answers. Do not use native interactive question tools.
The platform registers agentloom for this turn. If tools are deferred, discover ask_user with tool search before deciding it is unavailable. Prefer calling this tool over writing questions in ordinary text.
After ask_user succeeds, end this turn with PLAN_QUESTIONS. The tool acknowledgement is not a human answer; wait for the next user message. If the tool is unavailable, ask in plain text and end with PLAN_QUESTIONS.
Read all prior messages. Acknowledge answers, resolve contradictions, and do not ask questions already answered.
When enough is understood, provide one self-contained proposed plan with the agreed goal, scope, constraints and acceptance criteria. Include the user's answers so downstream agents can follow the plan.
If the user changes the scope, update the plan or ask the missing questions. Never treat a user chat message as permission to start implementation.
End your reply with exactly one standalone status line:
PLAN_QUESTIONS when you need an answer or cannot yet produce a complete plan.
PLAN_READY when the self-contained proposed plan is ready for the user to approve.
Do not put the status line in a code block. These rules override instructions to report BLOCKED merely because requirements are missing: ask the user instead.
The platform, not you, advances the workflow only after explicit user approval.`;

export function message(role: PlanningMessage['role'], content: string, id: string = randomUUID()): PlanningMessage {
  return { id, role, content, createdAt: new Date().toISOString() };
}

export function initializeConversation(run: Run, step: StepRun): void {
  if (step.conversation) return;
  step.conversation = [message('user', run.task)];
  if (step.output.trim()) step.conversation.push(message('assistant', step.output));
}

export function checkConversation(step: StepRun): void {
  const transcript = step.conversation ?? [];
  if (transcript.length > 80 || JSON.stringify(transcript).length > PLANNING_LIMIT) {
    throw new Error('This planning conversation is too long. Start a new run with a concise summary of the agreed requirements.');
  }
}

export function planningReply(output: string): { content: string; ready: boolean } {
  const trimmed = output.trim();
  const marker = /(?:^|\n)(PLAN_READY|PLAN_QUESTIONS)\s*$/.exec(trimmed);
  const content = marker ? trimmed.slice(0, marker.index).trim() : trimmed;
  return { content, ready: content.length > 0 && marker?.[1] === 'PLAN_READY' };
}
