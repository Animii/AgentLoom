import test from 'node:test';
import assert from 'node:assert/strict';
import { toolGroups } from '../src/client/ReplyWithTools.js';
import type { PlanningToolCall, RunEvent } from '../src/shared/types.js';
const call = (id: string, offset?: number): PlanningToolCall => ({
  id,
  name: 'command_execution',
  input: {},
  status: 'completed',
  startedAt: '2026-01-01T00:00:02Z',
  outputOffset: offset,
});
void test('tool groups split at intervening response text but consecutive calls remain together', () => {
  const groups = toolGroups(
    'Inspect. Testing. Done.',
    [call('a', 8), call('b', 8), call('c', 17)],
    [],
    '',
  );
  assert.deepEqual(
    groups.map(([offset, calls]) => [offset, calls.map((c) => c.id)]),
    [
      [8, ['a', 'b']],
      [17, ['c']],
    ],
  );
});
void test('legacy calls recover their position from saved output and ignore other turns', () => {
  const events: RunEvent[] = [
    {
      id: 1,
      runId: 'r',
      stepId: 's',
      type: 'output',
      timestamp: '2026-01-01T00:00:01Z',
      message: 'Inspect.',
    },
  ];
  assert.equal(
    toolGroups(
      'Inspect. Done.',
      [call('a')],
      events,
      '2026-01-01T00:00:00Z',
    )[0][0],
    8,
  );
  assert.equal(
    toolGroups(
      'Inspect. Done.',
      [call('a')],
      events,
      '2026-01-01T00:00:02Z',
    )[0][0],
    0,
  );
});
