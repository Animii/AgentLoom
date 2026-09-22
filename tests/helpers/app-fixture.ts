import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { TestContext } from 'node:test';
import { createApp, type CreateAppOptions } from '../../src/server/app.js';
import type { AppConfig, Run } from '../../src/shared/types.js';
import { safeAppOptions } from './fake-effects.js';
import { waitForRun } from './wait.js';

export function createTestApp(
  config: AppConfig,
  options: CreateAppOptions = {},
) {
  return createApp(config, safeAppOptions(options));
}

/** Browser tests exercise the built server while retaining fail-closed dependencies. */
export async function createBrowserTestApp(
  config: AppConfig,
  options: CreateAppOptions = {},
) {
  const built = (await import(
    pathToFileURL(path.resolve('dist/server/app.js')).href
  )) as typeof import('../../src/server/app.js');
  return built.createApp(config, safeAppOptions(options));
}

interface FixtureOptions {
  options?: CreateAppOptions;
  config?: Partial<Omit<AppConfig, 'dataDir' | 'workspaceRoot'>>;
  project?: string;
  files?: Record<string, string>;
  built?: boolean;
  temporaryParent?: string;
}

function containedPath(root: string, relative: string): string {
  const target = path.resolve(root, relative);
  const difference = path.relative(root, target);
  if (
    path.isAbsolute(relative) ||
    difference === '' ||
    difference === '..' ||
    difference.startsWith(`..${path.sep}`) ||
    path.isAbsolute(difference)
  ) {
    throw new Error(
      `Fixture path must stay inside its test-owned directory: ${relative}`,
    );
  }
  return target;
}

export async function createAppFixture(
  owner?: Pick<TestContext, 'after'>,
  {
    options = {},
    config: overrides = {},
    project = 'welcome',
    files = { 'README.md': '# Welcome\n\nDisposable test project.\n' },
    built = false,
    temporaryParent = tmpdir(),
  }: FixtureOptions = {},
) {
  const root = await mkdtemp(path.join(temporaryParent, 'agentloom-test-'));
  const work = path.join(root, 'workspaces');
  const config: AppConfig = {
    dataDir: path.join(root, 'data'),
    workspaceRoot: work,
    host: '127.0.0.1',
    port: 0,
    cliTimeoutMs: 3000,
    maxOutputBytes: 100000,
    ...overrides,
  };
  const start = () =>
    (built ? createBrowserTestApp : createTestApp)(config, options);
  let app: Awaited<ReturnType<typeof createTestApp>> | undefined;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      app?.server.closeAllConnections();
      await app?.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  };
  owner?.after(close);
  try {
    const projectRoot = containedPath(path.join(work, 'projects'), project);
    const entries = Object.entries(files).map(
      ([name, content]) => [containedPath(projectRoot, name), content] as const,
    );
    await mkdir(projectRoot, { recursive: true });
    for (const [target, content] of entries) {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    app = await start();
  } catch (error) {
    await close();
    throw error;
  }
  const current = () => {
    if (!app || closed) throw new Error('Test application is closed.');
    return app;
  };
  return {
    root,
    work,
    config,
    get app() {
      return current();
    },
    close,
    async restart() {
      current().server.closeAllConnections();
      await current().close();
      app = await start();
      return app;
    },
    async request<T>(
      url: string,
      {
        method = 'GET',
        payload,
        expectedStatus = 200,
      }: {
        method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
        payload?: object;
        expectedStatus?: number;
      } = {},
    ): Promise<T> {
      const response = await current().inject({
        method,
        url,
        ...(payload ? { payload } : {}),
      });
      assert.equal(
        response.statusCode,
        expectedStatus,
        `${method} ${url}: ${response.body}`,
      );
      return response.json<T>();
    },
    wait: (
      id: string,
      expected: Run['status'] | ((run: Run) => boolean),
      timing?: { timeoutMs?: number; intervalMs?: number },
    ) => {
      return waitForRun(() => current().store.getRun(id), expected, timing);
    },
  };
}
