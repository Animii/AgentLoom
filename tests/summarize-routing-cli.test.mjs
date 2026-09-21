import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { after, before, describe, it } from 'node:test';

import { summarizeRouting } from '../scripts/summarize-routing.mjs';

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(new URL('../scripts/summarize-routing.mjs', import.meta.url));
const scriptUrl = new URL('../scripts/summarize-routing.mjs', import.meta.url).href;
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

async function runCli(args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [scriptPath, ...args], { cwd: repoRoot });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

function assertConciseFailure(result, code) {
  assert.equal(result.code, code);
  assert.equal(result.stdout, '');
  assert.ok(result.stderr.trim().length > 0, 'stderr must report the failure');
  assert.ok(!result.stderr.includes('    at '), `stderr must not contain a stack: ${result.stderr}`);
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

const FORBIDDEN = ['task-text', 'prompt-text', 'reason-text', 'log-line', 'credential-value'];

function assertNoForbiddenFields(summary) {
  const serialized = JSON.stringify(summary);
  for (const marker of FORBIDDEN) assert.ok(!serialized.includes(marker), `output leaked ${marker}`);
}

let dir;
let counter = 0;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'summarize-routing-'));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeRunFile(contents) {
  counter += 1;
  const file = path.join(dir, `run-${counter}.json`);
  await writeFile(file, typeof contents === 'string' ? contents : JSON.stringify(contents));
  return file;
}

describe('absent automation', () => {
  it('returns defaults when automation is omitted and ignores extra fields', () => {
    const summary = summarizeRouting({
      id: 'run-1',
      status: 'running',
      task: 'task-text',
      prompts: ['prompt-text'],
      logs: ['log-line'],
      credentials: 'credential-value',
    });
    assert.deepEqual(summary, {
      runId: 'run-1',
      status: 'running',
      repairsUsed: 0,
      escalationUsed: false,
      decisions: [],
    });
    assert.deepEqual(Object.keys(summary), ['runId', 'status', 'repairsUsed', 'escalationUsed', 'decisions']);
    assertNoForbiddenFields(summary);
  });

  it('treats an omitted automation and an explicit undefined automation as absent', () => {
    const omitted = summarizeRouting({ id: 'run-2', status: 'completed', escalation: { used: 'nope' } });
    const explicit = summarizeRouting({ id: 'run-2', status: 'completed', automation: undefined });
    const expected = {
      runId: 'run-2',
      status: 'completed',
      repairsUsed: 0,
      escalationUsed: false,
      decisions: [],
    };
    assert.deepEqual(omitted, expected);
    assert.deepEqual(explicit, expected);
  });

  it('treats an explicit undefined escalation and undefined offeredActions as absent', () => {
    const summary = summarizeRouting({
      id: 'run-2b',
      status: 'running',
      automation: {
        repairsUsed: 0,
        decisions: [{ choice: 'complete', action: 'complete', confidence: 1, offeredActions: undefined }],
        escalation: undefined,
      },
    });
    assert.equal(summary.escalationUsed, false);
    assert.equal(summary.decisions[0].offeredActions, null);
  });
});

describe('route projections', () => {
  it('projects a completed route and drops unused decision fields', () => {
    const summary = summarizeRouting({
      id: 'run-3',
      status: 'completed',
      task: 'task-text',
      automation: {
        version: 1,
        status: 'done',
        repairsUsed: 0,
        maxRepairs: 2,
        message: 'reason-text',
        task: 'task-text',
        decisions: [
          {
            at: '2026-01-01T00:00:00.000Z',
            inputHash: 'abc',
            model: 'model-x',
            probabilities: { complete: 1 },
            reason: 'reason-text',
            logs: ['log-line'],
            credentials: 'credential-value',
            choice: 'complete',
            confidence: 0.87,
            action: 'complete',
            offeredActions: ['complete', 'request_clarification'],
          },
        ],
      },
    });
    assert.deepEqual(summary, {
      runId: 'run-3',
      status: 'completed',
      repairsUsed: 0,
      escalationUsed: false,
      decisions: [{ choice: 'complete', action: 'complete', confidence: 0.87, offeredActions: ['complete', 'request_clarification'] }],
    });
    assert.deepEqual(Object.keys(summary.decisions[0]), ['choice', 'action', 'confidence', 'offeredActions']);
    assertNoForbiddenFields(summary);
  });

  it('projects an escalated route and ignores unused escalation fields', () => {
    const summary = summarizeRouting({
      id: 'run-4',
      status: 'running',
      automation: {
        repairsUsed: 2,
        decisions: [{ choice: 'return_to_implementer', action: 'escalate', confidence: 0.9, reason: 'reason-text' }],
        escalation: { used: true, provider: 'claude', model: 'fable', effort: 'high', stepId: 'build', task: 'task-text' },
      },
    });
    assert.deepEqual(summary, {
      runId: 'run-4',
      status: 'running',
      repairsUsed: 2,
      escalationUsed: true,
      decisions: [{ choice: 'return_to_implementer', action: 'escalate', confidence: 0.9, offeredActions: null }],
    });
    assertNoForbiddenFields(summary);
  });

  it('projects a paused route', () => {
    const summary = summarizeRouting({
      id: 'run-5',
      status: 'blocked',
      automation: {
        repairsUsed: 2,
        decisions: [
          { choice: 'request_clarification', action: 'paused', confidence: 1, offeredActions: ['request_clarification'] },
        ],
        escalation: { used: false },
      },
    });
    assert.deepEqual(summary, {
      runId: 'run-5',
      status: 'blocked',
      repairsUsed: 2,
      escalationUsed: false,
      decisions: [{ choice: 'request_clarification', action: 'paused', confidence: 1, offeredActions: ['request_clarification'] }],
    });
  });

  it('projects a repair route with an explicit undefined offeredActions as null', () => {
    const summary = summarizeRouting({
      id: 'run-6',
      status: 'completed',
      automation: {
        repairsUsed: 1,
        decisions: [
          { choice: 'return_to_implementer', action: 'repair', confidence: 0.5, offeredActions: ['return_to_implementer', 'complete'] },
          { choice: 'complete', action: 'complete', confidence: 0.99, offeredActions: undefined },
        ],
      },
    });
    assert.deepEqual(summary.decisions.map((d) => d.offeredActions), [['return_to_implementer', 'complete'], null]);
  });

  it('keeps an empty offeredActions array distinct from absence', () => {
    const summary = summarizeRouting({
      id: 'run-7',
      status: 'blocked',
      automation: { repairsUsed: 0, decisions: [{ choice: 'paused', action: 'paused', confidence: 0, offeredActions: [] }] },
    });
    assert.deepEqual(summary.decisions[0].offeredActions, []);
    assert.notEqual(summary.decisions[0].offeredActions, null);
  });
});

describe('confidence boundaries', () => {
  for (const confidence of [0, 1, -0, 0.000001, 0.999999]) {
    it(`accepts ${Object.is(confidence, -0) ? '-0' : confidence}`, () => {
      const summary = summarizeRouting({
        id: 'run-c',
        status: 'running',
        automation: { repairsUsed: 0, decisions: [{ choice: 'complete', action: 'complete', confidence }] },
      });
      assert.equal(summary.decisions[0].confidence, confidence);
    });
  }

  for (const confidence of [-0.0001, 1.0001, NaN, Infinity, -Infinity, '0.5', null, undefined]) {
    it(`rejects ${String(confidence)}`, () => {
      assert.throws(
        () => summarizeRouting({
          id: 'run-c',
          status: 'running',
          automation: { repairsUsed: 0, decisions: [{ choice: 'complete', action: 'complete', confidence }] },
        }),
        TypeError,
      );
    });
  }
});

describe('sparse arrays are rejected', () => {
  it('rejects a hole in decisions instead of projecting null', () => {
    const decisions = new Array(1);
    assert.throws(
      () => summarizeRouting({ id: 'run-sparse', status: 'completed', automation: { repairsUsed: 0, decisions } }),
      (error) => error instanceof TypeError && error.message.includes('decisions[0]'),
    );
    assert.equal(decisions.length, 1);
    assert.ok(!(0 in decisions));
  });

  it('rejects a hole between valid decisions', () => {
    const decision = { choice: 'complete', action: 'complete', confidence: 1 };
    const decisions = [decision, , decision];
    assert.throws(
      () => summarizeRouting({ id: 'run-sparse-2', status: 'completed', automation: { repairsUsed: 0, decisions } }),
      (error) => error instanceof TypeError && error.message.includes('decisions[1]'),
    );
  });

  it('rejects a hole in offeredActions', () => {
    const decision = { choice: 'complete', action: 'complete', confidence: 1, offeredActions: new Array(2) };
    assert.throws(
      () => summarizeRouting({ id: 'run-sparse-3', status: 'completed', automation: { repairsUsed: 0, decisions: [decision] } }),
      TypeError,
    );
  });

  it('never emits a null decision for a dense valid array', () => {
    const decisions = [{ choice: 'complete', action: 'complete', confidence: 1 }];
    const summary = summarizeRouting({ id: 'run-dense', status: 'completed', automation: { repairsUsed: 0, decisions } });
    assert.equal(summary.decisions.length, 1);
    assert.deepEqual(Object.keys(summary.decisions[0]), ['choice', 'action', 'confidence', 'offeredActions']);
    assert.ok(!summary.decisions.includes(null));
    assert.ok(!summary.decisions.includes(undefined));
  });
});

describe('invalid shapes throw TypeError', () => {
  const validDecision = { choice: 'complete', action: 'complete', confidence: 1 };
  const validDecisionWithOffered = { ...validDecision, offeredActions: new Array(1) };
  const cases = [
    ['null run', null],
    ['undefined run', undefined],
    ['array run', []],
    ['string run', 'run'],
    ['missing id', { status: 'running' }],
    ['non-string id', { id: 7, status: 'running' }],
    ['missing status', { id: 'run-8' }],
    ['non-string status', { id: 'run-8', status: { value: 'running' } }],
    ['non-object automation', { id: 'run-8', status: 'running', automation: 'auto' }],
    ['array automation', { id: 'run-8', status: 'running', automation: [] }],
    ['null automation', { id: 'run-8', status: 'running', automation: null }],
    ['missing repairsUsed', { id: 'run-8', status: 'running', automation: { decisions: [] } }],
    ['negative repairsUsed', { id: 'run-8', status: 'running', automation: { repairsUsed: -1, decisions: [] } }],
    ['fractional repairsUsed', { id: 'run-8', status: 'running', automation: { repairsUsed: 1.5, decisions: [] } }],
    ['NaN repairsUsed', { id: 'run-8', status: 'running', automation: { repairsUsed: NaN, decisions: [] } }],
    ['string repairsUsed', { id: 'run-8', status: 'running', automation: { repairsUsed: '2', decisions: [] } }],
    ['missing decisions', { id: 'run-8', status: 'running', automation: { repairsUsed: 0 } }],
    ['non-array decisions', { id: 'run-8', status: 'running', automation: { repairsUsed: 0, decisions: {} } }],
    ['null decisions', { id: 'run-8', status: 'running', automation: { repairsUsed: 0, decisions: null } }],
    ['sparse decisions array', { id: 'run-8', status: 'running', automation: { repairsUsed: 0, decisions: new Array(1) } }],
    ['sparse decisions array between valid entries', { id: 'run-8', status: 'running', automation: { repairsUsed: 0, decisions: [validDecision, , validDecision] } }],
    ['sparse offeredActions array', { id: 'run-8', status: 'running', automation: { repairsUsed: 0, decisions: [validDecisionWithOffered] } }],
    ['null decision', { id: 'run-8', status: 'running', automation: { repairsUsed: 0, decisions: [null] } }],
    ['string decision', { id: 'run-8', status: 'running', automation: { repairsUsed: 0, decisions: ['complete'] } }],
    ['missing choice', { id: 'run-8', status: 'running', automation: { repairsUsed: 0, decisions: [{ action: 'complete', confidence: 1 }] } }],
    ['non-string choice', { id: 'run-8', status: 'running', automation: { repairsUsed: 0, decisions: [{ choice: 1, action: 'complete', confidence: 1 }] } }],
    ['missing action', { id: 'run-8', status: 'running', automation: { repairsUsed: 0, decisions: [{ choice: 'complete', confidence: 1 }] } }],
    ['non-string action', { id: 'run-8', status: 'running', automation: { repairsUsed: 0, decisions: [{ choice: 'complete', action: false, confidence: 1 }] } }],
    ['non-array offeredActions', { id: 'run-8', status: 'running', automation: { repairsUsed: 0, decisions: [{ choice: 'complete', action: 'complete', confidence: 1, offeredActions: 'complete' }] } }],
    ['null offeredActions', { id: 'run-8', status: 'running', automation: { repairsUsed: 0, decisions: [{ choice: 'complete', action: 'complete', confidence: 1, offeredActions: null }] } }],
    ['non-string offeredActions entry', { id: 'run-8', status: 'running', automation: { repairsUsed: 0, decisions: [{ choice: 'complete', action: 'complete', confidence: 1, offeredActions: ['complete', 2] }] } }],
    ['string escalation', { id: 'run-8', status: 'running', automation: { repairsUsed: 0, decisions: [], escalation: 'fable' } }],
    ['array escalation', { id: 'run-8', status: 'running', automation: { repairsUsed: 0, decisions: [], escalation: [] } }],
    ['null escalation', { id: 'run-8', status: 'running', automation: { repairsUsed: 0, decisions: [], escalation: null } }],
    ['escalation without used', { id: 'run-8', status: 'running', automation: { repairsUsed: 0, decisions: [], escalation: {} } }],
    ['non-boolean escalation.used', { id: 'run-8', status: 'running', automation: { repairsUsed: 0, decisions: [], escalation: { used: 'yes' } } }],
  ];
  for (const [name, run] of cases) {
    it(`rejects ${name}`, () => {
      assert.throws(() => summarizeRouting(run), TypeError);
    });
  }
});

describe('exact output and non-mutation', () => {
  it('produces exactly the documented fields and leaves a frozen input untouched', () => {
    const run = deepFreeze({
      id: 'run-9',
      status: 'completed',
      task: 'task-text',
      automation: {
        version: 1,
        repairsUsed: 1,
        decisions: [{ choice: 'complete', action: 'complete', confidence: 0.75, offeredActions: ['complete'] }],
        escalation: { used: false, provider: 'flash' },
      },
    });
    const before = JSON.stringify(run);
    const summary = summarizeRouting(run);
    assert.deepEqual(Object.keys(summary), ['runId', 'status', 'repairsUsed', 'escalationUsed', 'decisions']);
    assert.deepEqual(Object.keys(summary.decisions[0]), ['choice', 'action', 'confidence', 'offeredActions']);
    assert.equal(JSON.stringify(run), before);
  });

  it('returns copies so output mutation cannot change the input', () => {
    const run = {
      id: 'run-10',
      status: 'running',
      automation: {
        repairsUsed: 0,
        decisions: [{ choice: 'complete', action: 'complete', confidence: 0.5, offeredActions: ['complete'] }],
      },
    };
    const before = JSON.stringify(run);
    const summary = summarizeRouting(run);
    summary.decisions.push({ choice: 'x', action: 'x', confidence: 0, offeredActions: null });
    summary.decisions[0].offeredActions.push('request_clarification');
    assert.equal(JSON.stringify(run), before);
  });
});

describe('CLI success', () => {
  it('prints formatted JSON plus a newline and exits 0', async () => {
    const file = await writeRunFile({
      id: 'run-cli-1',
      status: 'completed',
      task: 'task-text',
      automation: {
        repairsUsed: 1,
        decisions: [{ choice: 'complete', action: 'complete', confidence: 0.8, reason: 'reason-text' }],
        escalation: { used: false },
      },
    });
    const result = await runCli([file]);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    assert.ok(result.stdout.endsWith('\n'), 'stdout must end with a newline');
    assert.ok(result.stdout.includes('\n  "runId"'), 'stdout must be formatted JSON');
    assert.deepEqual(JSON.parse(result.stdout), {
      runId: 'run-cli-1',
      status: 'completed',
      repairsUsed: 1,
      escalationUsed: false,
      decisions: [{ choice: 'complete', action: 'complete', confidence: 0.8, offeredActions: null }],
    });
    assertNoForbiddenFields(JSON.parse(result.stdout));
  });

  it('handles a run without automation', async () => {
    const file = await writeRunFile({ id: 'run-cli-2', status: 'running', task: 'task-text' });
    const result = await runCli([file]);
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), {
      runId: 'run-cli-2',
      status: 'running',
      repairsUsed: 0,
      escalationUsed: false,
      decisions: [],
    });
  });
});

describe('CLI failures', () => {
  it('exits 1 on a missing file without leaking content or a stack', async () => {
    const result = await runCli([path.join(dir, 'does-not-exist.json')]);
    assertConciseFailure(result, 1);
    assert.ok(!result.stderr.includes('{'));
  });

  it('exits 1 on a directory argument', async () => {
    const result = await runCli([dir]);
    assertConciseFailure(result, 1);
  });

  it('exits 1 on invalid JSON without echoing the file', async () => {
    const file = await writeRunFile('not json credential-value');
    const result = await runCli([file]);
    assertConciseFailure(result, 1);
    assert.ok(!result.stderr.includes('credential-value'));
    assert.ok(!result.stderr.includes('not json'));
  });

  it('exits 1 on an invalid projected shape without echoing the file', async () => {
    const file = await writeRunFile({
      id: 'run-cli-3',
      status: 'running',
      task: 'task-text',
      automation: {
        repairsUsed: -1,
        decisions: [{ choice: 'complete', action: 'complete', confidence: 2, reason: 'reason-text' }],
      },
    });
    const result = await runCli([file]);
    assertConciseFailure(result, 1);
    assert.ok(!result.stderr.includes('task-text'));
    assert.ok(!result.stderr.includes('reason-text'));
    assert.ok(!result.stderr.includes('"id"'));
  });

  it('exits 1 when a JSON null fills a field that requires a shape', async () => {
    const payloads = [
      { id: 'run-null-automation', status: 'running', automation: null },
      {
        id: 'run-null-escalation',
        status: 'running',
        automation: { repairsUsed: 0, decisions: [], escalation: null },
      },
      {
        id: 'run-null-offered',
        status: 'running',
        automation: { repairsUsed: 0, decisions: [{ choice: 'complete', action: 'complete', confidence: 1, offeredActions: null }] },
      },
      {
        id: 'run-null-decision',
        status: 'running',
        automation: { repairsUsed: 0, decisions: [null] },
      },
    ];
    for (const payload of payloads) {
      const file = await writeRunFile(payload);
      const result = await runCli([file]);
      assertConciseFailure(result, 1);
      assert.ok(!result.stderr.includes('task-text'));
      assert.ok(!result.stderr.includes('reason-text'));
    }
  });

  it('exits 2 with usage on missing arguments', async () => {
    const result = await runCli([]);
    assertConciseFailure(result, 2);
    assert.equal(result.stderr.trim(), 'Usage: node scripts/summarize-routing.mjs RUN_JSON_FILE');
  });

  it('exits 2 with usage on extra arguments', async () => {
    const file = await writeRunFile({ id: 'run-cli-4', status: 'running' });
    const result = await runCli([file, 'extra']);
    assertConciseFailure(result, 2);
    assert.equal(result.stderr.trim(), 'Usage: node scripts/summarize-routing.mjs RUN_JSON_FILE');
  });
});

describe('import side effects', () => {
  it('imports cleanly without printing or exiting', async () => {
    const imported = await execFileAsync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(scriptUrl)})`], { cwd: repoRoot });
    assert.equal(imported.stdout, '');
    assert.equal(imported.stderr, '');
  });
});
