import { setTimeout as delay } from 'node:timers/promises';
import type { Run } from '../../src/shared/types.js';

export async function waitForRun(
  read: () => Run | undefined | Promise<Run | undefined>,
  expected: Run['status'] | ((run: Run) => boolean),
  { timeoutMs = 5000, intervalMs = 20 } = {},
): Promise<Run> {
  const started = performance.now();
  let last: Run | undefined;
  do {
    last = await read();
    if (
      last &&
      (typeof expected === 'function'
        ? expected(last)
        : last.status === expected)
    )
      return last;
    await delay(intervalMs);
  } while (performance.now() - started < timeoutMs);
  const step = last?.steps.at(last.currentStep);
  throw new Error(
    `Timed out waiting for run ${typeof expected === 'string' ? expected : 'predicate'} after ${String(timeoutMs)}ms. Last state: ${JSON.stringify({ id: last?.id, status: last?.status, currentStep: last?.currentStep, stepStatus: step?.status, error: step?.error })}`,
  );
}
