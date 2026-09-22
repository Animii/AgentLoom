import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { AppConfig, ProviderId } from '../shared/types.js';
import { createApp } from './app.js';

const DEFAULT_PORT = 4317;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_CLI_TIMEOUT_MS = 3_600_000;
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

const WELCOME_README = `# Welcome

This starter project was created automatically because the projects folder was empty.

Add your own project folders next to it, or delete this one. AgentLoom never
overwrites an existing project.
`;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}

function readIntegerEnv(
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(
      `${name} must be an integer between ${String(min)} and ${String(max)}`,
    );
  }
  return value;
}

function readPathEnv(name: string, fallback: string): string {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }
  return resolve(raw.trim());
}

function readHostEnv(): string {
  const raw = process.env.HOST;
  if (raw === undefined || raw.trim().length === 0) {
    return DEFAULT_HOST;
  }
  return raw.trim();
}

function readBinaries(): Partial<Record<ProviderId, string>> {
  const overrides: ReadonlyArray<readonly [string, ProviderId]> = [
    ['CLAUDE_BIN', 'claude'],
    ['CODEX_BIN', 'codex'],
    ['OPENCODE_BIN', 'opencode'],
  ];
  const binaries: Partial<Record<ProviderId, string>> = {};
  for (const [envName, id] of overrides) {
    const value = process.env[envName];
    if (typeof value === 'string' && value.trim().length > 0) {
      binaries[id] = value;
    }
  }
  return binaries;
}

function readConfig(): AppConfig {
  const config: AppConfig = {
    dataDir: readPathEnv('DATA_DIR', resolve('.data')),
    workspaceRoot: readPathEnv('WORKSPACE_ROOT', resolve('workspaces')),
    ...(process.env.PROJECTS_ROOT
      ? {
          projectRoot: resolve(process.env.PROJECTS_ROOT),
          projectHostRoot:
            process.env.PROJECTS_HOST_ROOT ?? process.env.PROJECTS_ROOT,
        }
      : {}),
    port: readIntegerEnv('PORT', DEFAULT_PORT, 1, 65535),
    host: readHostEnv(),
    cliTimeoutMs: readIntegerEnv(
      'CLI_TIMEOUT_MS',
      DEFAULT_CLI_TIMEOUT_MS,
      1000,
      86_400_000,
    ),
    cliIdleTimeoutMs: readIntegerEnv(
      'CLI_IDLE_TIMEOUT_MS',
      600_000,
      0,
      86_400_000,
    ),
    maxOutputBytes: readIntegerEnv(
      'MAX_OUTPUT_BYTES',
      DEFAULT_MAX_OUTPUT_BYTES,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
  };
  const binaries = readBinaries();
  if (Object.keys(binaries).length > 0) {
    config.binaries = binaries;
  }
  return config;
}

async function ensureWelcomeProject(workspaceRoot: string): Promise<void> {
  const projectsDirectory = join(workspaceRoot, 'projects');
  await mkdir(projectsDirectory, { recursive: true });
  const entries = await readdir(projectsDirectory);
  if (entries.length > 0) {
    return;
  }
  const welcomeDirectory = join(projectsDirectory, 'welcome');
  await mkdir(welcomeDirectory);
  try {
    await writeFile(join(welcomeDirectory, 'README.md'), WELCOME_README, {
      encoding: 'utf8',
      flag: 'wx',
    });
  } catch (error) {
    if (!isErrnoException(error) || error.code !== 'EEXIST') {
      throw error;
    }
  }
}

async function main(): Promise<void> {
  const config = readConfig();
  await ensureWelcomeProject(config.workspaceRoot);
  const app = await createApp(config);
  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) {
      return;
    }
    closing = true;
    app.log.info(`Received ${signal}; shutting down.`);
    try {
      await app.close();
      process.exitCode = 0;
    } catch (error) {
      console.error(`Shutdown failed: ${errorMessage(error)}`);
      process.exitCode = 1;
    }
  };
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  try {
    await app.listen({ port: config.port, host: config.host });
    app.log.info(
      `AgentLoom listening on http://${config.host}:${String(config.port)}`,
    );
  } catch (error) {
    console.error(`Failed to start AgentLoom: ${errorMessage(error)}`);
    process.exitCode = 1;
    try {
      await app.close();
    } catch {
      // The original startup failure is the useful error.
    }
  }
}

main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
