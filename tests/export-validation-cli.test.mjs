import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {summarizeValidation} from '../scripts/export-validation.mjs';

const scriptPath = fileURLToPath(new URL('../scripts/export-validation.mjs', import.meta.url));
const scriptUrl = pathToFileURL(scriptPath).href;
const startedAt = '2026-01-01T00:00:00.000Z';
const finishedAt = '2026-01-01T00:05:00.000Z';

const expectedCommand = {
  executable: 'npm',
  args: ['run', 'typecheck'],
  status: 'passed',
  exitCode: 0,
  startedAt,
  finishedAt,
  truncated: false,
};

const expectedValidatedStep = {
  stepId: 'validate',
  attempt: 2,
  status: 'passed',
  before: 'before-hash',
  after: 'after-hash',
  commands: [expectedCommand],
};

function commandRecord(overrides = {}) {
  return {
    command: {executable: 'npm', args: ['run', 'typecheck'], timeoutMs: 600000},
    status: 'passed',
    exitCode: 0,
    output: 'command output',
    truncated: false,
    startedAt,
    finishedAt,
    ...overrides,
  };
}

function validationFixture(overrides = {}) {
  return {
    attempt: 1,
    status: 'passed',
    before: 'before-hash',
    after: 'after-hash',
    commands: [commandRecord()],
    signals: {status: 'ready', model: 'jev-latest', claimsSupported: 0.9},
    startedAt,
    finishedAt,
    ...overrides,
  };
}

function runFixture(overrides = {}) {
  return {
    id: 'run-1',
    title: 'Pilot run',
    task: 'Implement the approved task',
    status: 'completed',
    mode: 'live',
    steps: [
      {
        definition: {id: 'plan', name: 'Plan', role: 'product owner'},
        attempt: 1,
        status: 'completed',
        output: 'plan output',
        error: null,
        sessionId: 'session-1',
        feedback: '',
        startedAt,
        finishedAt,
        costUsd: 0.1,
      },
      {
        definition: {id: 'validate', name: 'Tests and signals', role: 'validation runner'},
        attempt: 2,
        status: 'completed',
        output: 'validation summary',
        error: null,
        sessionId: null,
        feedback: '',
        startedAt,
        finishedAt,
        costUsd: null,
        validation: validationFixture(),
      },
      {
        definition: {id: 'review', name: 'Review', role: 'reviewer'},
        attempt: 1,
        status: 'waiting_approval',
        output: 'review output',
        error: null,
        sessionId: null,
        feedback: '',
        startedAt,
        finishedAt: null,
        costUsd: null,
      },
    ],
    workspace: '/tmp/workspace',
    currentStep: 2,
    createdAt: startedAt,
    updatedAt: finishedAt,
    error: null,
    ...overrides,
  };
}

function runCli(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [scriptPath, ...args], {shell: false, encoding: 'utf8'}, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      resolve({code, stdout, stderr});
    });
  });
}

const tmpRoot = await mkdtemp(path.join(tmpdir(), 'export-validation-test-'));
after(() => rm(tmpRoot, {recursive: true, force: true}));

test('projects only steps with recorded validation and drops unrelated fields', () => {
  const run = runFixture();
  run.task = 'SECRET-TASK';
  run.steps[0].output = 'SECRET-PLAN';
  run.steps[1].output = 'SECRET-VALIDATION-OUTPUT';
  run.steps[1].validation.commands[0].output = 'SECRET-COMMAND-OUTPUT';
  run.steps[1].validation.signals = {status: 'ready', message: 'SECRET-SIGNAL'};
  run.steps[1].conversation = [{role: 'assistant', content: 'SECRET-CONVERSATION'}];
  const summary = summarizeValidation(run);
  assert.deepEqual(summary, {
    runId: 'run-1',
    runStatus: 'completed',
    steps: [expectedValidatedStep],
  });
  assert.deepEqual(Object.keys(summary), ['runId', 'runStatus', 'steps']);
  assert.deepEqual(Object.keys(summary.steps[0]), ['stepId', 'attempt', 'status', 'before', 'after', 'commands']);
  assert.deepEqual(Object.keys(summary.steps[0].commands[0]), ['executable', 'args', 'status', 'exitCode', 'startedAt', 'finishedAt', 'truncated']);
  assert.ok(!JSON.stringify(summary).includes('SECRET'));
});

test('keeps multiple validation steps and command order', () => {
  const run = runFixture();
  run.steps.push({
    definition: {id: 'validate-2', name: 'Second validation'},
    attempt: 3,
    status: 'failed',
    output: 'second validation summary',
    error: null,
    sessionId: null,
    feedback: '',
    startedAt,
    finishedAt,
    costUsd: null,
    validation: validationFixture({
      status: 'failed',
      before: 'hash-a',
      after: 'hash-b',
      commands: [
        commandRecord({command: {executable: 'npm', args: ['test'], timeoutMs: 600000}, status: 'failed', exitCode: 2}),
        commandRecord({command: {executable: 'npm', args: ['run', 'build'], timeoutMs: 600000}, status: 'timed_out', exitCode: null}),
      ],
    }),
  });
  const summary = summarizeValidation(run);
  assert.deepEqual(summary.steps.map(step => step.stepId), ['validate', 'validate-2']);
  assert.deepEqual(summary.steps[1].commands.map(command => command.executable), ['npm', 'npm']);
  assert.deepEqual(summary.steps[1].commands.map(command => command.args), [['test'], ['run', 'build']]);
  assert.deepEqual(summary.steps[1].commands.map(command => command.exitCode), [2, null]);
});

test('omits steps without validation and returns an empty list when none exist', () => {
  const withNull = runFixture();
  withNull.steps[1].validation = null;
  assert.deepEqual(summarizeValidation(withNull), {runId: 'run-1', runStatus: 'completed', steps: []});
  const noValidation = runFixture();
  for (const step of noValidation.steps) delete step.validation;
  assert.deepEqual(summarizeValidation(noValidation).steps, []);
});

test('normalizes absent after and finishedAt to null and preserves failed commands', () => {
  const run = runFixture();
  run.steps[1].validation = validationFixture({
    status: 'failed',
    after: undefined,
    finishedAt: undefined,
    commands: [
      commandRecord({status: 'failed', exitCode: 1, finishedAt: undefined}),
      commandRecord({status: 'running', exitCode: null, finishedAt: undefined}),
    ],
  });
  const summary = summarizeValidation(run);
  assert.equal(summary.steps[0].after, null);
  assert.equal(summary.steps[0].commands[0].finishedAt, null);
  assert.equal(summary.steps[0].commands[0].exitCode, 1);
  assert.deepEqual(summary.steps[0].commands.map(command => command.status), ['failed', 'running']);
  assert.deepEqual(summary.steps[0].commands.map(command => command.exitCode), [1, null]);
});

test('accepts minimal run shapes and copies command arguments', () => {
  assert.deepEqual(summarizeValidation({id: 'run-min', status: 'running', steps: []}), {runId: 'run-min', runStatus: 'running', steps: []});
  assert.deepEqual(summarizeValidation({id: 'run-min', status: 'queued', steps: [{}, {validation: undefined}]}).steps, []);
  const run = runFixture();
  const summary = summarizeValidation(run);
  summary.steps[0].commands[0].args.push('mutated');
  assert.deepEqual(run.steps[1].validation.commands[0].command.args, ['run', 'typecheck']);
});

test('does not mutate the input run', () => {
  const run = runFixture();
  const snapshot = structuredClone(run);
  summarizeValidation(run);
  assert.deepEqual(run, snapshot);
});

test('rejects malformed shapes with TypeError', () => {
  const malformed = {
    'run is undefined': () => undefined,
    'run is null': () => null,
    'run is an array': () => [],
    'run.id is missing': () => { const run = runFixture(); delete run.id; return run; },
    'run.id is not a string': () => runFixture({id: 42}),
    'run.id is empty': () => runFixture({id: ''}),
    'run.status is missing': () => { const run = runFixture(); delete run.status; return run; },
    'run.status is not a string': () => runFixture({status: 3}),
    'run.steps is missing': () => { const run = runFixture(); delete run.steps; return run; },
    'run.steps is not an array': () => runFixture({steps: {}}),
    'run.steps contains an empty slot': () => runFixture({steps: new Array(2)}),
    'step is null': () => { const run = runFixture(); run.steps.push(null); return run; },
    'step.definition is missing': () => { const run = runFixture(); delete run.steps[1].definition; return run; },
    'step.definition.id is missing': () => { const run = runFixture(); delete run.steps[1].definition.id; return run; },
    'step.attempt is zero': () => { const run = runFixture(); run.steps[1].attempt = 0; return run; },
    'step.attempt is negative': () => { const run = runFixture(); run.steps[1].attempt = -1; return run; },
    'step.attempt is fractional': () => { const run = runFixture(); run.steps[1].attempt = 1.5; return run; },
    'step.attempt is a string': () => { const run = runFixture(); run.steps[1].attempt = '1'; return run; },
    'validation is not an object': () => { const run = runFixture(); run.steps[1].validation = 'passed'; return run; },
    'validation.status is missing': () => { const run = runFixture(); delete run.steps[1].validation.status; return run; },
    'validation.before is missing': () => { const run = runFixture(); delete run.steps[1].validation.before; return run; },
    'validation.commands is missing': () => { const run = runFixture(); delete run.steps[1].validation.commands; return run; },
    'validation.commands is not an array': () => { const run = runFixture(); run.steps[1].validation.commands = {}; return run; },
    'validation.commands contains an empty slot': () => { const run = runFixture(); run.steps[1].validation.commands = new Array(1); return run; },
    'command record is null': () => { const run = runFixture(); run.steps[1].validation.commands = [null]; return run; },
    'command.executable is missing': () => { const run = runFixture(); delete run.steps[1].validation.commands[0].command.executable; return run; },
    'command.args is not an array': () => { const run = runFixture(); run.steps[1].validation.commands[0].command.args = 'run typecheck'; return run; },
    'command.args contains a non-string': () => { const run = runFixture(); run.steps[1].validation.commands[0].command.args = ['npm', 7]; return run; },
    'command.args contains an empty slot': () => { const run = runFixture(); const args = new Array(1); run.steps[1].validation.commands[0].command.args = args; return run; },
    'command.args is sparse after a string': () => { const run = runFixture(); const args = ['npm']; args.length = 2; run.steps[1].validation.commands[0].command.args = args; return run; },
    'command.status is missing': () => { const run = runFixture(); delete run.steps[1].validation.commands[0].status; return run; },
    'command.exitCode is missing': () => { const run = runFixture(); delete run.steps[1].validation.commands[0].exitCode; return run; },
    'command.exitCode is a string': () => { const run = runFixture(); run.steps[1].validation.commands[0].exitCode = '0'; return run; },
    'command.exitCode is fractional': () => { const run = runFixture(); run.steps[1].validation.commands[0].exitCode = 1.5; return run; },
    'command.startedAt is missing': () => { const run = runFixture(); delete run.steps[1].validation.commands[0].startedAt; return run; },
    'command.startedAt is not a string': () => { const run = runFixture(); run.steps[1].validation.commands[0].startedAt = 123; return run; },
    'command.finishedAt is not a string': () => { const run = runFixture(); run.steps[1].validation.commands[0].finishedAt = 5; return run; },
    'command.truncated is missing': () => { const run = runFixture(); delete run.steps[1].validation.commands[0].truncated; return run; },
    'command.truncated is not a boolean': () => { const run = runFixture(); run.steps[1].validation.commands[0].truncated = 'false'; return run; },
  };
  for (const [name, build] of Object.entries(malformed)) {
    assert.throws(() => summarizeValidation(build()), TypeError, name);
  }
});

test('CLI prints formatted JSON for a valid run file', async () => {
  const file = path.join(tmpRoot, 'valid-run.json');
  await writeFile(file, JSON.stringify(runFixture()));
  const result = await runCli([file]);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), {
    runId: 'run-1',
    runStatus: 'completed',
    steps: [expectedValidatedStep],
  });
  assert.ok(result.stdout.includes('\n  "runId"'));
  assert.ok(result.stdout.endsWith('\n'));
});

test('CLI prints an empty step list when the run has no validation', async () => {
  const file = path.join(tmpRoot, 'no-validation.json');
  await writeFile(file, JSON.stringify({id: 'run-min', status: 'queued', steps: [{}]}));
  const result = await runCli([file]);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), {runId: 'run-min', runStatus: 'queued', steps: []});
});

test('CLI exits 2 for missing or extra arguments', async () => {
  const missing = await runCli([]);
  assert.equal(missing.code, 2);
  assert.equal(missing.stdout, '');
  assert.ok(missing.stderr.includes('Usage:'));
  const extra = await runCli([path.join(tmpRoot, 'valid-run.json'), 'extra']);
  assert.equal(extra.code, 2);
  assert.equal(extra.stdout, '');
  assert.ok(extra.stderr.includes('Usage:'));
});

test('CLI exits 1 with concise stderr for read failures', async () => {
  const result = await runCli([path.join(tmpRoot, 'does-not-exist.json')]);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.ok(result.stderr.trim().length > 0);
  assert.equal(result.stderr.trim().split('\n').length, 1);
});

test('CLI exits 1 with concise stderr for parse failures', async () => {
  const file = path.join(tmpRoot, 'invalid.json');
  await writeFile(file, '{"id": "run-1",');
  const result = await runCli([file]);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.ok(result.stderr.includes('Invalid JSON'));
  assert.equal(result.stderr.trim().split('\n').length, 1);
});

test('CLI parse failures do not echo excluded file content', async () => {
  const file = path.join(tmpRoot, 'secret-invalid.json');
  await writeFile(file, '{"task": "SECRET-TASK", "credential": "SECRET-CREDENTIAL"');
  const result = await runCli([file]);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.ok(result.stderr.includes('Invalid JSON'));
  assert.ok(!result.stderr.includes('SECRET-TASK'));
  assert.ok(!result.stderr.includes('SECRET-CREDENTIAL'));
  assert.equal(result.stderr.trim().split('\n').length, 1);
});

test('CLI exits 1 with concise stderr for shape failures', async () => {
  const file = path.join(tmpRoot, 'bad-shape.json');
  await writeFile(file, JSON.stringify({id: 'run-1', status: 'completed', steps: 'nope'}));
  const result = await runCli([file]);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.ok(result.stderr.includes('run.steps must be an array.'));
  assert.equal(result.stderr.trim().split('\n').length, 1);
});

test('importing the module has no side effects', async () => {
  const result = await new Promise((resolve) => {
    execFile(process.execPath, ['--input-type=module', '--eval', `await import(${JSON.stringify(scriptUrl)});`], {shell: false, encoding: 'utf8'}, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      resolve({code, stdout, stderr});
    });
  });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});
