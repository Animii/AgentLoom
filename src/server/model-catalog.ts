import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { AppConfig, ProviderId } from '../shared/types.js';
import {
  isValidModelId,
  MODEL_ID_MAX_LENGTH,
  suggestedCatalog,
  type ModelCatalog,
  type ModelCatalogStatus,
  type ModelChoice,
  type ModelFallbackStatus,
} from '../shared/model-catalog.js';
import { resolveBinary } from './providers.js';

export type DiscoverModels = (
  provider: ProviderId,
  refresh: boolean,
) => Promise<ModelCatalog>;

export interface ModelCatalogServiceOptions {
  now?: () => number;
  codexTimeoutMs?: number;
  opencodeTimeoutMs?: number;
  warn?: (provider: ProviderId, status: ModelCatalogStatus) => void;
}

const DISCOVERED_TTL_MS = 10 * 60 * 1000;
const FAILURE_TTL_MS = 30 * 1000;
const STDOUT_CAP_BYTES = 1024 * 1024;
const KILL_GRACE_MS = 2000;
const CODEX_TIMEOUT_MS = 15 * 1000;
const OPENCODE_TIMEOUT_MS = 30 * 1000;
const CODEX_PAGE_LIMIT = 100;
const CODEX_MAX_PAGES = 20;
const CODEX_MAX_MODELS = 500;
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g; // eslint-disable-line no-control-regex -- stripping ANSI colour codes requires the ESC control character
const OPENCODE_MODEL_PATTERN = /^[^\s/]+\/\S+$/;

function isMissingBinaryError(error: NodeJS.ErrnoException): boolean {
  return error.code === 'ENOENT' || error.code === 'EACCES';
}

function discoveryEnvironment(provider: ProviderId): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.TYPESAFE_API_KEY;
  if (provider === 'codex') {
    const apiKey = env.OPENAI_API_KEY;
    if (typeof apiKey === 'string' && apiKey.length > 0) {
      env.CODEX_API_KEY = apiKey;
    }
  }
  return env;
}

function stripControlCharacters(value: string): string {
  let result = '';
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint < 0x20 || codePoint === 0x7f))
      continue;
    result += character;
  }
  return result;
}

function sanitizeLabel(value: unknown, id: string): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = stripControlCharacters(value)
    .trim()
    .slice(0, MODEL_ID_MAX_LENGTH);
  if (cleaned.length === 0 || cleaned === id) return null;
  return cleaned;
}

interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  overflow: boolean;
  spawnError: NodeJS.ErrnoException | null;
}

interface ProcessHandle {
  done: Promise<ProcessExit>;
  write(line: string): void;
  stopInput(): void;
  stop(): void;
}

function launch(
  config: AppConfig,
  provider: ProviderId,
  args: string[],
  timeoutMs: number,
  onLine: (line: string) => void,
): ProcessHandle {
  let child: ChildProcess | undefined;
  let killStarted = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  const flags = {
    timedOut: false,
    overflow: false,
    spawnError: null as NodeJS.ErrnoException | null,
  };
  const stdoutDecoder = new StringDecoder('utf8');
  let buffer = '';
  let totalBytes = 0;
  let resolveExit!: (exit: ProcessExit) => void;
  const done = new Promise<ProcessExit>((resolve) => {
    resolveExit = resolve;
  });

  const deadline = setTimeout(() => {
    flags.timedOut = true;
    killTree();
  }, timeoutMs);
  deadline.unref();

  const settle = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (settled) return;
    settled = true;
    clearTimeout(deadline);
    if (killTimer) clearTimeout(killTimer);
    resolveExit({
      code,
      signal,
      timedOut: flags.timedOut,
      overflow: flags.overflow,
      spawnError: flags.spawnError,
    });
  };

  const killTree = (): void => {
    const pid = child?.pid;
    if (pid === undefined || killStarted) return;
    killStarted = true;
    if (process.platform === 'win32') {
      try {
        const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
          shell: false,
          windowsHide: true,
          stdio: 'ignore',
        });
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

  const stopInput = (): void => {
    try {
      child?.stdin?.end();
    } catch {
      // The child process may already be gone.
    }
  };

  const handle: ProcessHandle = {
    done,
    write: (line: string): void => {
      try {
        child?.stdin?.write(line);
      } catch {
        // A failed write surfaces through the process exit status.
      }
    },
    stopInput,
    stop: (): void => {
      stopInput();
      killTree();
    },
  };

  try {
    child = spawn(resolveBinary(config, provider), args, {
      shell: false,
      windowsHide: true,
      cwd: config.dataDir,
      detached: process.platform !== 'win32',
      env: discoveryEnvironment(provider),
    });
  } catch (error) {
    flags.spawnError = error as NodeJS.ErrnoException;
    settle(null, null);
    return handle;
  }

  child.stdin?.on('error', () => {
    // A provider that exits before reading input makes later writes such as end() fail asynchronously.
  });
  child.stdout?.on('error', () => {
    // A read can fail when the provider is killed; the close event reports the failure.
  });
  child.stderr?.on('error', () => {
    // Provider diagnostics are drained and discarded.
  });

  child.stdout?.on('data', (chunk: Buffer) => {
    if (settled) return;
    totalBytes += chunk.length;
    if (totalBytes > STDOUT_CAP_BYTES) {
      flags.overflow = true;
      killTree();
      return;
    }
    buffer += stdoutDecoder.write(chunk);
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      onLine(line);
      newline = buffer.indexOf('\n');
    }
  });
  child.stderr?.on('data', () => {
    // Provider diagnostics are drained and discarded to keep secrets out of logs and responses.
  });
  child.on('error', (error) => {
    flags.spawnError = error;
    if (child.pid === undefined) settle(null, null);
  });
  child.on('close', (code, signal) => {
    if (!settled) {
      buffer += stdoutDecoder.end();
      const leftover = buffer.trim();
      buffer = '';
      if (leftover.length > 0) onLine(leftover);
    }
    settle(code, signal);
  });

  return handle;
}

interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  result?: unknown;
  error?: unknown;
}

function discovered(provider: ProviderId, models: ModelChoice[]): ModelCatalog {
  return {
    provider,
    status: 'discovered',
    message: null,
    models,
    fetchedAt: new Date().toISOString(),
  };
}

function fallback(
  provider: ProviderId,
  status: ModelFallbackStatus,
): ModelCatalog {
  return suggestedCatalog(provider, status);
}

async function discoverWithCodex(
  config: AppConfig,
  timeoutMs: number,
  register: (handle: ProcessHandle) => void,
): Promise<ModelCatalog> {
  const models: ModelChoice[] = [];
  const seen = new Set<string>();
  const cursors = new Set<string>();
  let failure: 'unsupported' | 'malformed' | null = null;
  let handshakeComplete = false;
  let finished = false;
  let requestId = 0;
  let pending: {
    id: number;
    resolve: (message: JsonRpcMessage | null) => void;
  } | null = null;
  const failureNow = (): 'unsupported' | 'malformed' | null => failure;

  const handle = launch(
    config,
    'codex',
    ['app-server'],
    timeoutMs,
    (rawLine) => {
      if (failure !== null || finished) return;
      const line = rawLine.trim();
      if (line.length === 0) return;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        failure = 'malformed';
        handle.stop();
        return;
      }
      if (typeof message !== 'object' || message === null) {
        failure = 'malformed';
        handle.stop();
        return;
      }
      const record = message as JsonRpcMessage;
      const active = pending;
      if (
        active === null ||
        typeof record.id !== 'number' ||
        record.id !== active.id
      )
        return;
      pending = null;
      if (record.error !== undefined) {
        failure = 'unsupported';
        active.resolve(null);
        handle.stop();
        return;
      }
      active.resolve(record);
    },
  );
  register(handle);

  const request = (
    method: string,
    params?: Record<string, unknown>,
  ): Promise<JsonRpcMessage | null> => {
    const id = ++requestId;
    return new Promise((resolve) => {
      pending = { id, resolve };
      handle.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`,
      );
    });
  };

  void handle.done.then(() => {
    const active = pending;
    pending = null;
    active?.resolve(null);
  });

  const initialized = await request('initialize', {
    clientInfo: { name: 'agentloom', version: '0.1.0' },
  });
  if (initialized !== null && failureNow() === null) {
    handshakeComplete = true;
    handle.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`,
    );
    let cursor: string | null = null;
    let listingDone = false;
    for (
      let page = 0;
      page < CODEX_MAX_PAGES && models.length < CODEX_MAX_MODELS;
      page += 1
    ) {
      const response = await request(
        'model/list',
        cursor === null
          ? { limit: CODEX_PAGE_LIMIT }
          : { limit: CODEX_PAGE_LIMIT, cursor },
      );
      if (response === null || failureNow() !== null) break;
      const result = response.result;
      if (
        typeof result !== 'object' ||
        result === null ||
        !Array.isArray((result as { data?: unknown }).data)
      ) {
        failure = 'malformed';
        handle.stop();
        break;
      }
      const pageData = (result as { data: unknown[]; nextCursor?: unknown })
        .data;
      for (const item of pageData) {
        if (models.length >= CODEX_MAX_MODELS) break;
        if (typeof item !== 'object' || item === null) continue;
        const record = item as { model?: unknown; displayName?: unknown };
        if (
          typeof record.model !== 'string' ||
          !isValidModelId(record.model) ||
          seen.has(record.model)
        )
          continue;
        seen.add(record.model);
        models.push({
          id: record.model,
          label: sanitizeLabel(record.displayName, record.model),
          source: 'discovered',
        });
      }
      const next = (result as { nextCursor?: unknown }).nextCursor;
      if (typeof next !== 'string' || next.length === 0 || cursors.has(next)) {
        listingDone = true;
        break;
      }
      cursors.add(next);
      cursor = next;
      if (page === CODEX_MAX_PAGES - 1 || models.length >= CODEX_MAX_MODELS)
        listingDone = true;
    }
    if (failure === null) {
      finished = listingDone;
      if (listingDone) handle.stop();
    }
  }

  const exit = await handle.done;
  if (exit.spawnError !== null) {
    return fallback(
      'codex',
      isMissingBinaryError(exit.spawnError) ? 'missing' : 'failed',
    );
  }
  if (exit.timedOut) return fallback('codex', 'timeout');
  if (exit.overflow) return fallback('codex', 'malformed');
  if (failure !== null) return fallback('codex', failure);
  if (!handshakeComplete) return fallback('codex', 'unsupported');
  if (!finished) return fallback('codex', 'failed');
  if (models.length === 0) return fallback('codex', 'empty');
  return discovered('codex', models);
}

async function discoverWithOpenCode(
  config: AppConfig,
  timeoutMs: number,
  register: (handle: ProcessHandle) => void,
): Promise<ModelCatalog> {
  const models: ModelChoice[] = [];
  const seen = new Set<string>();
  const observed = { output: false };
  const handle = launch(
    config,
    'opencode',
    ['models', '--pure'],
    timeoutMs,
    (rawLine) => {
      if (rawLine.trim().length > 0) observed.output = true;
      const line = rawLine.replace(ANSI_PATTERN, '').trim();
      if (
        !OPENCODE_MODEL_PATTERN.test(line) ||
        !isValidModelId(line) ||
        seen.has(line)
      )
        return;
      seen.add(line);
      models.push({ id: line, label: null, source: 'discovered' });
    },
  );
  register(handle);
  handle.stopInput();

  const exit = await handle.done;
  if (exit.spawnError !== null) {
    return fallback(
      'opencode',
      isMissingBinaryError(exit.spawnError) ? 'missing' : 'failed',
    );
  }
  if (exit.timedOut) return fallback('opencode', 'timeout');
  if (exit.overflow) return fallback('opencode', 'malformed');
  if (models.length > 0) return discovered('opencode', models);
  if (exit.code !== 0) return fallback('opencode', 'failed');
  return fallback('opencode', observed.output ? 'malformed' : 'empty');
}

export class ModelCatalogService {
  private readonly cache = new Map<
    ProviderId,
    { expiresAt: number; catalog: ModelCatalog }
  >();
  private readonly inflight = new Map<ProviderId, Promise<ModelCatalog>>();
  private readonly active = new Set<() => void>();
  private readonly config: AppConfig;
  private readonly now: () => number;
  private readonly codexTimeoutMs: number;
  private readonly opencodeTimeoutMs: number;
  private readonly warn?: (
    provider: ProviderId,
    status: ModelCatalogStatus,
  ) => void;
  private closed = false;

  constructor(config: AppConfig, options: ModelCatalogServiceOptions = {}) {
    this.config = config;
    this.now = options.now ?? Date.now;
    this.codexTimeoutMs = options.codexTimeoutMs ?? CODEX_TIMEOUT_MS;
    this.opencodeTimeoutMs = options.opencodeTimeoutMs ?? OPENCODE_TIMEOUT_MS;
    this.warn = options.warn;
  }

  get(provider: ProviderId, refresh = false): Promise<ModelCatalog> {
    if (provider === 'claude')
      return Promise.resolve(suggestedCatalog('claude', 'builtin'));
    if (this.closed) return Promise.resolve(fallback(provider, 'failed'));
    if (!refresh) {
      const cached = this.cache.get(provider);
      if (cached && cached.expiresAt > this.now())
        return Promise.resolve(cached.catalog);
    }
    const pending = this.inflight.get(provider);
    if (pending) return pending;
    const promise = this.discover(provider)
      .then((result) => {
        const ttl =
          result.status === 'discovered' ? DISCOVERED_TTL_MS : FAILURE_TTL_MS;
        this.cache.set(provider, {
          expiresAt: this.now() + ttl,
          catalog: result,
        });
        if (result.status !== 'discovered')
          this.warn?.(provider, result.status);
        return result;
      })
      .finally(() => {
        this.inflight.delete(provider);
      });
    this.inflight.set(provider, promise);
    return promise;
  }

  close(): void {
    this.closed = true;
    for (const stop of [...this.active]) stop();
    this.active.clear();
  }

  private async discover(provider: ProviderId): Promise<ModelCatalog> {
    const state: { stop: (() => void) | null } = { stop: null };
    const register = (handle: ProcessHandle): void => {
      state.stop = () => {
        handle.stop();
      };
      this.active.add(state.stop);
    };
    try {
      return provider === 'codex'
        ? await discoverWithCodex(this.config, this.codexTimeoutMs, register)
        : await discoverWithOpenCode(
            this.config,
            this.opencodeTimeoutMs,
            register,
          );
    } finally {
      if (state.stop !== null) this.active.delete(state.stop);
    }
  }
}
