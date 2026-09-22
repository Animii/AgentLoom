import { NativeToolStream } from '../shared/native-tools.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type {
  AgentEvent,
  AgentResult,
  AppConfig,
  ExecuteAgent,
  StepDefinition,
} from '../shared/types.js';
import {
  AgentTextStream,
  parseAgentLine,
  type ParsedAgentLine,
} from './provider-stream.js';
import { resolveBinary } from './providers.js';
import { isPlanningStep } from '../shared/planning.js';
import { createAskTool } from './ask-tool.js';
import { PLANNING_TOOL_NAMES } from './project-tools.js';

const MAX_LOG_CHARS = 2000;
const STDERR_TAIL_CHARS = 300;
const KILL_GRACE_MS = 2000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortError(): Error {
  const error = new Error('Run execution was aborted');
  error.name = 'AbortError';
  return error;
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

function claudeTools(access: StepDefinition['access']): string {
  const tools = ['Read', 'Glob', 'Grep', 'Bash'];
  if (access === 'workspace-write') {
    tools.push('Write', 'Edit');
  }
  return tools.join(',');
}

export function buildArguments(
  step: StepDefinition,
  prompt: string,
  workspace: string,
  askUrl?: string,
): string[] {
  if (step.provider === 'claude') {
    const tools = claudeTools(step.access);
    const args = [
      '-p',
      '--dangerously-skip-permissions',
      ...(askUrl
        ? [
            '--strict-mcp-config',
            '--disable-slash-commands',
            '--mcp-config',
            JSON.stringify({
              mcpServers: { agentloom: { type: 'http', url: askUrl } },
            }),
          ]
        : []),
      '--name',
      'AgentLoom-step',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--tools',
      tools,
      '--allowedTools',
      askUrl
        ? `${tools},${PLANNING_TOOL_NAMES.map((name) => `mcp__agentloom__${name}`).join(',')}`
        : tools,
    ];
    if (step.model.length > 0) args.push('--model', step.model);
    if (step.effort.length > 0) args.push('--effort', step.effort);
    return args;
  }
  if (step.provider === 'codex') {
    const args = [
      'exec',
      '-C',
      workspace,
      '--json',
      '--skip-git-repo-check',
      '--ephemeral',
      '-s',
      'danger-full-access',
      '-c',
      'approval_policy="never"',
    ];
    if (step.model.length > 0) args.push('-m', step.model);
    if (step.effort.length > 0)
      args.push('-c', `model_reasoning_effort="${step.effort}"`);
    if (askUrl)
      args.push(
        '-c',
        `mcp_servers.agentloom.url="${askUrl}"`,
        '-c',
        `mcp_servers.agentloom.enabled_tools=${JSON.stringify(PLANNING_TOOL_NAMES)}`,
        ...PLANNING_TOOL_NAMES.flatMap((name) => [
          '-c',
          `mcp_servers.agentloom.tools.${name}.approval_mode="approve"`,
        ]),
      );
    args.push('-');
    return args;
  }
  const args = ['run', '--dir', workspace, '--pure', '--format', 'json'];
  if (step.model.length > 0) args.push('--model', step.model);
  if (step.effort.length > 0) args.push('--variant', step.effort);
  args.push(prompt);
  return args;
}

function buildEnvironment(
  step: StepDefinition,
  workspace: string,
  askUrl?: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // The backend Jev HTTP integration key must not be inherited by provider children.
  delete env.TYPESAFE_API_KEY;
  env.PWD = workspace;
  env.AGENTLOOM_PLATFORM_CONTAINER = process.env.HOSTNAME ?? '';
  env.AGENTLOOM_WORKSPACE = workspace;
  // Agent workspaces need development dependencies even though the platform runs production Node.
  delete env.NODE_ENV;
  if (step.provider === 'codex') {
    const apiKey = env.OPENAI_API_KEY;
    if (typeof apiKey === 'string' && apiKey.length > 0) {
      env.CODEX_API_KEY = apiKey;
    }
    return env;
  }
  if (step.provider === 'opencode') {
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      share: 'disabled',
      ...(askUrl
        ? { mcp: { agentloom: { type: 'remote', url: askUrl, oauth: false } } }
        : {}),
      permission: {
        '*': 'deny',
        read: 'allow',
        glob: 'allow',
        grep: 'allow',
        edit: step.access === 'workspace-write' ? 'allow' : 'deny',
        write: step.access === 'workspace-write' ? 'allow' : 'deny',
        external_directory: 'allow',
        bash: 'allow',
        task: 'deny',
        ...(askUrl
          ? Object.fromEntries(
              PLANNING_TOOL_NAMES.map((name) => [`agentloom_${name}`, 'allow']),
            )
          : {}),
      },
    });
  }
  return env;
}

export function createExecutor(config: AppConfig): ExecuteAgent {
  return async (step, prompt, workspace, signal, onEvent) => {
    if (signal.aborted) throw abortError();
    let asked = false;
    const ask = isPlanningStep(step)
      ? await createAskTool(
          (questions) => {
            if (signal.aborted) throw abortError();
            onEvent({
              type: 'ask',
              message: 'Planner asked a question.',
              questions,
            });
            asked = true;
          },
          workspace,
          (name) => {
            if (signal.aborted) throw abortError();
            onEvent({
              type: 'log',
              message: `Planner used ${name} (read-only project access).`,
            });
          },
          (toolCall) => {
            if (!signal.aborted)
              onEvent({ type: 'tool', message: toolCall.name, toolCall });
          },
        )
      : undefined;
    try {
      return await new Promise<AgentResult>((resolve, reject) => {
        if (signal.aborted) {
          reject(abortError());
          return;
        }
        let child: ChildProcess;
        try {
          child = spawn(
            resolveBinary(config, step.provider),
            buildArguments(step, prompt, workspace, ask?.url),
            {
              shell: false,
              windowsHide: true,
              cwd: workspace,
              detached: process.platform !== 'win32',
              env: buildEnvironment(step, workspace, ask?.url),
            },
          );
        } catch (error) {
          reject(
            new Error(
              `Failed to start provider process: ${errorMessage(error)}`,
            ),
          );
          return;
        }

        let settled = false;
        let failure: Error | null = null;
        const failureNow = (): Error | null => failure;
        let callbackBroken = false;
        let killStarted = false;
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        let idleTimer: ReturnType<typeof setTimeout> | undefined;
        const activeTools = new Set<string>();
        let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
        let totalBytes = 0;
        let output = '';
        let sessionId: string | null = null;
        let costUsd: number | null = null;
        let stderrTail = '';
        let stdoutBuffer = '';
        const textStream = new AgentTextStream(step.provider);
        const maxBytes =
          Number.isFinite(config.maxOutputBytes) && config.maxOutputBytes > 0
            ? Math.floor(config.maxOutputBytes)
            : Number.POSITIVE_INFINITY;
        const stdoutDecoder = new StringDecoder('utf8');
        const stderrDecoder = new StringDecoder('utf8');

        const killTree = (): void => {
          const pid = child.pid;
          if (pid === undefined || killStarted) return;
          killStarted = true;
          if (process.platform === 'win32') {
            try {
              const killer = spawn(
                'taskkill',
                ['/pid', String(pid), '/t', '/f'],
                {
                  shell: false,
                  windowsHide: true,
                  stdio: 'ignore',
                },
              );
              killer.on('error', () => {});
              killer.unref();
            } catch {
              // The child process may already be gone.
            }
            return;
          }
          try {
            process.kill(-pid, 'SIGTERM');
          } catch {
            // The child process may already be gone.
          }
          killTimer = setTimeout(() => {
            killTimer = undefined;
            try {
              process.kill(-pid, 'SIGKILL');
            } catch {
              // The child process may already be gone.
            }
          }, KILL_GRACE_MS);
          killTimer.unref();
        };

        const fail = (error: Error): void => {
          if (failure === null) failure = error;
          killTree();
        };

        const resetIdle = (): void => {
          if (idleTimer) clearTimeout(idleTimer);
          const idleMs = config.cliIdleTimeoutMs ?? 0;
          if (!settled && !failure && activeTools.size === 0 && idleMs > 0) {
            idleTimer = setTimeout(() => {
              fail(
                new Error(
                  `Provider was inactive for ${String(idleMs)} ms with no running tool. Retry to continue.`,
                ),
              );
            }, idleMs);
            idleTimer.unref();
          }
        };
        const emit = (event: AgentEvent): void => {
          if (settled || callbackBroken) return;
          if (event.type === 'tool' && event.toolCall) {
            if (event.toolCall.status === 'running')
              activeTools.add(event.toolCall.id);
            else activeTools.delete(event.toolCall.id);
          }
          resetIdle();
          try {
            onEvent(
              ask
                ? {
                    ...event,
                    message: event.message.replaceAll(
                      ask.url,
                      '[question tool]',
                    ),
                  }
                : event,
            );
          } catch (error) {
            callbackBroken = true;
            fail(
              new Error(`Agent event callback failed: ${errorMessage(error)}`),
            );
          }
        };

        const nativeTools = new NativeToolStream(step.provider);
        const handleLine = (rawLine: string): void => {
          if (settled || failure !== null) return;
          const line = rawLine.trim();
          if (line.length === 0) return;
          let validJson = true;
          try {
            JSON.parse(line);
          } catch {
            validJson = false;
          }
          if (!validJson) {
            fail(
              new Error(
                `Provider emitted a line that is not valid JSON: ${truncate(line, 200)}`,
              ),
            );
            return;
          }
          let parsed: ParsedAgentLine;
          try {
            parsed = parseAgentLine(step.provider, line);
          } catch (error) {
            fail(
              new Error(
                `Provider output parser failed: ${errorMessage(error)}`,
              ),
            );
            return;
          }
          const toolCalls = nativeTools.accept(line, new Date().toISOString());
          for (const toolCall of toolCalls)
            emit({ type: 'tool', message: toolCall.name, toolCall });
          let recognized = toolCalls.length > 0;
          if (parsed.text !== undefined) {
            recognized = true;
            const event = textStream.accept(parsed);
            output = textStream.output;
            if (event) emit(event);
          }
          if (parsed.sessionId !== undefined) {
            recognized = true;
            sessionId = parsed.sessionId;
          }
          if (parsed.costUsd !== undefined) {
            recognized = true;
            costUsd =
              step.provider === 'claude'
                ? parsed.costUsd
                : (costUsd ?? 0) + parsed.costUsd;
          }
          if (parsed.error !== undefined) {
            fail(new Error(parsed.error));
            emit({ type: 'error', message: parsed.error });
            return;
          }
          if (parsed.complete === true) recognized = true;
          if (!recognized && !parsed.silent)
            emit({ type: 'log', message: truncate(line, MAX_LOG_CHARS) });
        };

        const accountBytes = (chunk: Buffer): boolean => {
          resetIdle();
          totalBytes += chunk.length;
          if (totalBytes > maxBytes) {
            fail(
              new Error(
                `Provider output exceeded the ${String(maxBytes)} byte limit`,
              ),
            );
            return false;
          }
          return true;
        };

        const onAbort = (): void => {
          fail(abortError());
        };

        const cleanup = (): void => {
          if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
          if (idleTimer !== undefined) clearTimeout(idleTimer);
          if (killTimer !== undefined) clearTimeout(killTimer);
          signal.removeEventListener('abort', onAbort);
        };

        const settleError = (error: Error): void => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        };

        const settleResolve = (): void => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve({ output, sessionId, costUsd });
        };

        const finalize = (
          code: number | null,
          exitSignal: NodeJS.Signals | null,
        ): void => {
          if (settled) return;
          stdoutBuffer += stdoutDecoder.end();
          const leftover = stdoutBuffer;
          stdoutBuffer = '';
          if (leftover.trim().length > 0) handleLine(leftover);
          if (failure !== null) {
            settleError(failure);
            return;
          }
          if (code !== 0) {
            const reason =
              code === null
                ? `was terminated by signal ${exitSignal ?? 'unknown'}`
                : `exited with code ${String(code)}`;
            const tail = stderrTail.trim();
            const detail =
              tail.length > 0
                ? `. stderr: ${truncate(tail, STDERR_TAIL_CHARS)}`
                : '';
            settleError(
              new Error(
                `Provider (${step.provider}) process ${reason}${detail}`,
              ),
            );
            return;
          }
          if (output.trim().length === 0 && !asked) {
            settleError(
              new Error(`Provider (${step.provider}) produced no output`),
            );
            return;
          }
          settleResolve();
        };

        child.stdout?.on('data', (chunk: Buffer) => {
          if (settled || failure !== null || !accountBytes(chunk)) return;
          stdoutBuffer += stdoutDecoder.write(chunk);
          let newline = stdoutBuffer.indexOf('\n');
          while (newline >= 0) {
            const line = stdoutBuffer.slice(0, newline).replace(/\r$/, '');
            stdoutBuffer = stdoutBuffer.slice(newline + 1);
            handleLine(line);
            if (failureNow() !== null) return;
            newline = stdoutBuffer.indexOf('\n');
          }
        });
        child.stdout?.on('error', (error) => {
          fail(
            new Error(`Provider output stream failed: ${errorMessage(error)}`),
          );
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          if (settled || failure !== null || !accountBytes(chunk)) return;
          for (const rawLine of stderrDecoder.write(chunk).split('\n')) {
            const line = rawLine.replace(/\r$/, '');
            if (line.trim().length === 0) continue;
            stderrTail = (stderrTail + line + '\n').slice(-STDERR_TAIL_CHARS);
            emit({
              type: 'log',
              message: `stderr: ${truncate(line, MAX_LOG_CHARS)}`,
            });
          }
        });
        child.stderr?.on('error', (error) => {
          fail(
            new Error(`Provider error stream failed: ${errorMessage(error)}`),
          );
        });
        child.on('error', (error) => {
          fail(new Error(`Provider process failed: ${errorMessage(error)}`));
          if (child.pid === undefined) {
            settleError(
              failure ?? new Error('Provider process failed to start'),
            );
          }
        });
        child.on('close', (code, exitSignal) => {
          finalize(code, exitSignal);
        });

        child.stdin?.on('error', (error: NodeJS.ErrnoException) => {
          if (error.code === 'EPIPE') return;
          fail(
            new Error(`Failed to write provider input: ${errorMessage(error)}`),
          );
        });
        try {
          if (step.provider !== 'opencode') child.stdin?.write(prompt);
          child.stdin?.end();
        } catch (error) {
          fail(
            new Error(`Failed to write provider input: ${errorMessage(error)}`),
          );
        }

        signal.addEventListener('abort', onAbort, { once: true });

        resetIdle();
        const timeoutMs = config.cliTimeoutMs;
        if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
          timeoutTimer = setTimeout(() => {
            fail(
              new Error(
                `Provider timed out after ${String(timeoutMs)} ms (total runtime limit; configure CLI_TIMEOUT_MS)`,
              ),
            );
          }, timeoutMs);
          timeoutTimer.unref();
        }
      });
    } finally {
      ask?.close();
    }
  };
}
