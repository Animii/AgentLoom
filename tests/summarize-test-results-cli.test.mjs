import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {summarizeTestResults} from '../scripts/summarize-test-results.mjs';

const scriptPath = fileURLToPath(new URL('../scripts/summarize-test-results.mjs', import.meta.url));
const tempDir = mkdtempSync(join(tmpdir(), 'summarize-test-results-'));

after(() => rmSync(tempDir, {recursive: true, force: true}));

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function validationCommand(overrides = {}) {
  return {
    command: {executable: 'node', args: ['--test'], timeoutMs: 120000},
    status: 'passed',
    exitCode: 0,
    output: 'raw output that must not be projected',
    truncated: false,
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    ...overrides,
  };
}

function stepWithValidation(stepId, commands, validationOverrides = {}) {
  return {
    definition: {
      id: stepId,
      name: `Check ${stepId}`,
      role: 'validation runner',
      provider: 'opencode',
      model: '',
      effort: '',
      instructions: 'run the recorded commands',
      access: 'read-only',
      approval: false,
    },
    validation: {
      attempt: 1,
      status: 'passed',
      before: 'fingerprint-before',
      after: 'fingerprint-before',
      commands,
      signals: {status: 'ready', claimsSupported: 1},
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:02.000Z',
      ...validationOverrides,
    },
    status: 'completed',
    attempt: 1,
    output: 'agent prompt and output that must not be projected',
    error: null,
    sessionId: 'session-1',
    feedback: 'feedback text',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:02.000Z',
    costUsd: 0.01,
  };
}

function stepWithoutValidation(overrides = {}) {
  return {status: 'completed', attempt: 1, output: 'planning output', ...overrides};
}

function runFixture(steps) {
  return {
    id: 'run-42',
    title: 'Evidence run',
    task: 'Task text',
    project: 'welcome',
    workflowId: 'quick-review',
    workflowName: 'Quick review',
    mode: 'live',
    status: 'completed',
    steps,
    currentStep: steps.length,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:05.000Z',
    workspace: '/tmp/workspace',
    error: null,
  };
}

function expectedCheck(stepId, commandOverrides = {}, sourceUnchanged = true) {
  const command = validationCommand(commandOverrides);
  return {
    stepId,
    executable: command.command.executable,
    args: command.command.args,
    status: command.status,
    exitCode: command.exitCode,
    truncated: command.truncated,
    sourceUnchanged,
  };
}

function runCli(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {encoding: 'utf8'});
}

function writeFixture(name, contents) {
  const file = join(tempDir, name);
  writeFileSync(file, contents);
  return file;
}

function assertConciseSingleLine(stderr) {
  const lines = stderr.trim().split('\n');
  assert.equal(lines.length, 1, `expected one stderr line, got: ${stderr}`);
  assert.ok(!stderr.includes('    at '), `stderr must not contain a stack: ${stderr}`);
  assert.ok(!/\b(?:TypeError|SyntaxError|Error)\b/.test(stderr), `stderr must not name error classes: ${stderr}`);
}

test('omits steps without validation and flattens multiple validation steps in order', () => {
  const run = runFixture([
    stepWithoutValidation(),
    stepWithValidation('validate-a', [validationCommand(), validationCommand({status: 'failed', exitCode: 1})]),
    stepWithoutValidation({definition: undefined, validation: undefined}),
    stepWithValidation('validate-b', [validationCommand({truncated: true})]),
  ]);
  const summary = summarizeTestResults(run);
  assert.deepEqual(summary, {
    runId: 'run-42',
    checks: [
      expectedCheck('validate-a'),
      expectedCheck('validate-a', {status: 'failed', exitCode: 1}),
      expectedCheck('validate-b', {truncated: true}),
    ],
  });
  assert.deepEqual(Object.keys(summary), ['runId', 'checks']);
  for (const check of summary.checks) {
    assert.deepEqual(Object.keys(check), ['stepId', 'executable', 'args', 'status', 'exitCode', 'truncated', 'sourceUnchanged']);
  }
});

test('reports sourceUnchanged for equal, changed and absent after fingerprints', () => {
  const run = runFixture([
    stepWithValidation('unchanged', [validationCommand(), validationCommand()]),
    stepWithValidation('changed', [validationCommand()], {after: 'fingerprint-after'}),
    stepWithValidation('absent', [validationCommand()], {after: undefined}),
  ]);
  const summary = summarizeTestResults(run);
  assert.deepEqual(summary.checks.map((check) => [check.stepId, check.sourceUnchanged]), [
    ['unchanged', true],
    ['unchanged', true],
    ['changed', false],
    ['absent', false],
  ]);
});

test('preserves supplied status strings, null and nonzero exit codes and truncation', () => {
  const run = runFixture([
    stepWithValidation('statuses', [
      validationCommand({status: 'timed_out', exitCode: null}),
      validationCommand({status: 'failed', exitCode: 137, truncated: true}),
      validationCommand({status: 'cancelled', exitCode: null, truncated: false}),
      validationCommand({status: 'simulated', exitCode: 0}),
    ], {status: 'partial'}),
  ]);
  const summary = summarizeTestResults(run);
  assert.deepEqual(summary.checks.map((check) => [check.status, check.exitCode, check.truncated]), [
    ['timed_out', null, false],
    ['failed', 137, true],
    ['cancelled', null, false],
    ['simulated', 0, false],
  ]);
});

test('projects only the documented fields and does not mutate the input', () => {
  const run = runFixture([
    stepWithoutValidation(),
    stepWithValidation('validate', [validationCommand(), validationCommand({status: 'failed', exitCode: 2})]),
  ]);
  const snapshot = JSON.stringify(run);
  const frozen = deepFreeze(run);
  const summary = summarizeTestResults(frozen);
  assert.equal(JSON.stringify(run), snapshot);
  const serialized = JSON.stringify(summary);
  for (const excluded of ['raw output', 'signals', 'startedAt', 'finishedAt', 'timeoutMs', 'prompt', 'feedback', 'sessionId', 'attempt', 'costUsd']) {
    assert.ok(!serialized.includes(excluded), `projection must exclude ${excluded}`);
  }
  assert.notEqual(summary.checks[0].args, run.steps[1].validation.commands[0].command.args);
});

test('returns an empty projection when no step records validation', () => {
  const summary = summarizeTestResults(runFixture([stepWithoutValidation(), stepWithoutValidation()]));
  assert.deepEqual(summary, {runId: 'run-42', checks: []});
});

test('throws TypeError for malformed nested data', () => {
  const valid = stepWithValidation('validate', [validationCommand()]);
  const cases = [
    ['null run', null],
    ['array run', []],
    ['string run', 'run'],
    ['missing id', {steps: []}],
    ['numeric id', {id: 7, steps: []}],
    ['missing steps', {id: 'run'}],
    ['object steps', {id: 'run', steps: {}}],
    ['null step', {id: 'run', steps: [null]}],
    ['null validation', {id: 'run', steps: [{...valid, validation: null}]}],
    ['missing definition', {id: 'run', steps: [{...valid, definition: undefined}]}],
    ['numeric definition id', {id: 'run', steps: [{...valid, definition: {id: 3}}]}],
    ['numeric validation status', {id: 'run', steps: [{...valid, validation: {...valid.validation, status: 1}}]}],
    ['null before', {id: 'run', steps: [{...valid, validation: {...valid.validation, before: null}}]}],
    ['null after', {id: 'run', steps: [{...valid, validation: {...valid.validation, after: null}}]}],
    ['numeric after', {id: 'run', steps: [{...valid, validation: {...valid.validation, after: 4}}]}],
    ['non-array commands', {id: 'run', steps: [{...valid, validation: {...valid.validation, commands: {}}}]}],
    ['null command result', {id: 'run', steps: [{...valid, validation: {...valid.validation, commands: [null]}}]}],
    ['missing command', {id: 'run', steps: [{...valid, validation: {...valid.validation, commands: [{...validationCommand(), command: undefined}]}}]}],
    ['numeric executable', {id: 'run', steps: [{...valid, validation: {...valid.validation, commands: [validationCommand({command: {executable: 1, args: []}})]}}]}],
    ['non-array args', {id: 'run', steps: [{...valid, validation: {...valid.validation, commands: [validationCommand({command: {executable: 'node', args: 'x'}})]}}]}],
    ['non-string arg', {id: 'run', steps: [{...valid, validation: {...valid.validation, commands: [validationCommand({command: {executable: 'node', args: [1]}})]}}]}],
    ['sparse args', {id: 'run', steps: [{...valid, validation: {...valid.validation, commands: [validationCommand({command: {executable: 'node', args: new Array(1)}})]}}]}],
    ['sparse args with trailing value', {id: 'run', steps: [{...valid, validation: {...valid.validation, commands: [validationCommand({command: {executable: 'node', args: Object.assign(new Array(2), {1: '--test'})}})]}}]}],
    ['sparse commands', {id: 'run', steps: [{...valid, validation: {...valid.validation, commands: new Array(1)}}]}],
    ['sparse steps', {id: 'run', steps: new Array(1)}],
    ['numeric status', {id: 'run', steps: [{...valid, validation: {...valid.validation, commands: [validationCommand({status: 1})]}}]}],
    ['undefined exitCode', {id: 'run', steps: [{...valid, validation: {...valid.validation, commands: [validationCommand({exitCode: undefined})]}}]}],
    ['fractional exitCode', {id: 'run', steps: [{...valid, validation: {...valid.validation, commands: [validationCommand({exitCode: 1.5})]}}]}],
    ['string exitCode', {id: 'run', steps: [{...valid, validation: {...valid.validation, commands: [validationCommand({exitCode: '0'})]}}]}],
    ['undefined truncated', {id: 'run', steps: [{...valid, validation: {...valid.validation, commands: [validationCommand({truncated: undefined})]}}]}],
    ['numeric truncated', {id: 'run', steps: [{...valid, validation: {...valid.validation, commands: [validationCommand({truncated: 0})]}}]}],
  ];
  for (const [name, value] of cases) {
    assert.throws(() => summarizeTestResults(value), TypeError, name);
  }
});

test('rejects sparse arrays instead of projecting undefined holes', () => {
  const sparseArgs = runFixture([
    stepWithValidation('validate', [validationCommand({command: {executable: 'node', args: new Array(1)}})]),
  ]);
  assert.throws(() => summarizeTestResults(sparseArgs), TypeError);
  const explicitUndefinedArg = runFixture([
    stepWithValidation('validate', [validationCommand({command: {executable: 'node', args: [undefined]}})]),
  ]);
  assert.throws(() => summarizeTestResults(explicitUndefinedArg), TypeError);
});

test('importing the module runs no CLI side effects', () => {
  const scriptUrl = new URL('../scripts/summarize-test-results.mjs', import.meta.url).href;
  const probe = spawnSync(process.execPath, [
    '--input-type=module',
    '-e',
    `const mod = await import(${JSON.stringify(scriptUrl)}); process.stdout.write(typeof mod.summarizeTestResults);`,
  ], {encoding: 'utf8'});
  assert.equal(probe.status, 0);
  assert.equal(probe.stderr, '');
  assert.equal(probe.stdout, 'function');
});

test('CLI prints formatted JSON and exits 0 even when recorded checks failed', () => {
  const run = runFixture([
    stepWithoutValidation(),
    stepWithValidation('validate', [
      validationCommand(),
      validationCommand({status: 'failed', exitCode: 1, truncated: true}),
    ], {after: 'other-fingerprint'}),
  ]);
  const file = writeFixture('mixed-run.json', JSON.stringify(run));
  const expected = {
    runId: 'run-42',
    checks: [
      {...expectedCheck('validate'), sourceUnchanged: false},
      {...expectedCheck('validate', {status: 'failed', exitCode: 1, truncated: true}), sourceUnchanged: false},
    ],
  };
  const result = runCli([file]);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.ok(result.stdout.endsWith('\n'));
  assert.equal(result.stdout, JSON.stringify(expected, null, 2) + '\n');
  assert.deepEqual(JSON.parse(result.stdout), expected);
});

test('CLI succeeds for a run without validation steps', () => {
  const file = writeFixture('no-validation.json', JSON.stringify(runFixture([stepWithoutValidation()])));
  const result = runCli([file]);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), {runId: 'run-42', checks: []});
});

test('CLI reports read errors concisely with exit 1', () => {
  const result = runCli([join(tempDir, 'missing-run.json')]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assertConciseSingleLine(result.stderr);
  assert.match(result.stderr, /cannot read input file/);
});

test('CLI reports JSON errors with exit 1 without echoing file content', () => {
  const file = writeFixture('invalid.json', '{"id":"secret-marker","steps":[}');
  const result = runCli([file]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assertConciseSingleLine(result.stderr);
  assert.ok(!result.stderr.includes('secret-marker'));
  assert.ok(!result.stderr.includes('steps'));
  assert.match(result.stderr, /not valid JSON/);
});

test('CLI reports shape errors with exit 1 without raw content or stack', () => {
  const file = writeFixture('bad-shape.json', JSON.stringify({id: 42, steps: [stepWithValidation('validate', [validationCommand()])], secret: 'hidden-value'}));
  const result = runCli([file]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assertConciseSingleLine(result.stderr);
  assert.ok(!result.stderr.includes('hidden-value'));
  assert.match(result.stderr, /run\.id must be a string/);
});

test('CLI exits 2 for missing and extra arguments', () => {
  for (const args of [[], ['one.json', 'two.json']]) {
    const result = runCli(args);
    assert.equal(result.status, 2, `args: ${JSON.stringify(args)}`);
    assert.equal(result.stdout, '');
    assertConciseSingleLine(result.stderr);
    assert.match(result.stderr, /usage:/);
  }
});
