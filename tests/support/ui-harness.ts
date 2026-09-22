import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createAppFixture } from '../helpers/app-fixture.js';

export async function withUiApp(
  environment: NodeJS.ProcessEnv,
  run: (context: {
    address: string;
    root: string;
    workspace: string;
  }) => Promise<number>,
  {
    built = true,
    temporaryParent,
  }: { built?: boolean; temporaryParent?: string } = {},
): Promise<number> {
  if (
    environment.E2E_BASE_URL ||
    environment.E2E_WORKSPACE_ROOT ||
    environment.AGENTLOOM_TEST_ROOT
  ) {
    throw new Error(
      'UI tests own their server and workspace. Unset E2E_BASE_URL, E2E_WORKSPACE_ROOT and AGENTLOOM_TEST_ROOT; production targets are not accepted.',
    );
  }
  const fixture = await createAppFixture(undefined, { built, temporaryParent });
  try {
    const address = await fixture.app.listen({ port: 0, host: '127.0.0.1' });
    if (new URL(address).port === '4317')
      throw new Error('Refusing production port 4317.');
    await writeFile(
      path.join(fixture.root, 'ui-harness.json'),
      JSON.stringify({ address, workspace: fixture.work }),
    );
    return await run({ address, root: fixture.root, workspace: fixture.work });
  } finally {
    await fixture.close();
  }
}

/** Forward terminal termination, then kill a child that ignores graceful shutdown. */
export async function runUiChild(
  args: string[],
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<number> {
  if (signal?.aborted) return 143;
  const child = spawn(process.execPath, args, {
    stdio: 'inherit',
    windowsHide: true,
    env: environment,
  });
  let timer: NodeJS.Timeout | undefined;
  let signalCode: number | undefined;
  const stop = (code: number) => {
    if (signalCode !== undefined) return;
    signalCode = code;
    child.kill('SIGTERM');
    timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    timer.unref();
  };
  const interrupt = () => {
    stop(130);
  };
  const terminate = () => {
    stop(143);
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  signal?.addEventListener('abort', terminate, { once: true });
  try {
    return await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => {
        resolve(signalCode ?? code ?? 1);
      });
    });
  } finally {
    if (timer) clearTimeout(timer);
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
    signal?.removeEventListener('abort', terminate);
  }
}
