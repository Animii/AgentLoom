import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, before, describe, it} from 'node:test';
import {fileURLToPath, pathToFileURL} from 'node:url';

const scriptUrl = new URL('../scripts/summarize-run-cost.mjs', import.meta.url);
const scriptPath = fileURLToPath(scriptUrl);

async function loadModule() {
  return import(scriptUrl);
}

const {summarizeRunCost} = await loadModule();

function step(overrides = {}) {
  return {definition: {id: 'step-a'}, attempt: 1, costUsd: null, ...overrides};
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

describe('summarizeRunCost export', () => {
  it('returns an empty summary for a run with no steps', () => {
    const summary = summarizeRunCost({id: 'run-empty', steps: []});
    assert.deepEqual(summary, {runId: 'run-empty', knownUsd: 0, unreportedAttempts: 0, attempts: []});
    assert.deepEqual(Object.keys(summary), ['runId', 'knownUsd', 'unreportedAttempts', 'attempts']);
  });

  it('ignores unused fields on the run, steps, definitions and history entries', () => {
    const summary = summarizeRunCost({
      id: 'run-extra',
      name: 'ignored run field',
      steps: [
        {
          definition: {id: 'build', title: 'Build'},
          attempt: 1,
          costUsd: 0.5,
          status: 'ok',
          council: {reports: [{costUsd: 10}]},
          history: [{attempt: 3, costUsd: null, trace: 'ignored', council: {costUsd: 4}}],
        },
      ],
    });
    assert.deepEqual(summary, {
      runId: 'run-extra',
      knownUsd: 0.5,
      unreportedAttempts: 1,
      attempts: [
        {stepId: 'build', attempt: 3, costUsd: null},
        {stepId: 'build', attempt: 1, costUsd: 0.5},
      ],
    });
  });

  it('excludes attempt zero from the summary while still validating it', () => {
    const summary = summarizeRunCost({
      id: 'run-zero',
      steps: [
        {
          definition: {id: 'start'},
          attempt: 0,
          costUsd: 99,
          history: [{attempt: 0, costUsd: 98}],
        },
        {
          definition: {id: 'work'},
          attempt: 2,
          costUsd: 1,
          history: [{attempt: 1, costUsd: 0.5}],
        },
      ],
    });
    assert.deepEqual(summary.attempts, [
      {stepId: 'work', attempt: 1, costUsd: 0.5},
      {stepId: 'work', attempt: 2, costUsd: 1},
    ]);
    assert.equal(summary.knownUsd, 1.5);
    assert.equal(summary.unreportedAttempts, 0);
    assert.throws(
      () => summarizeRunCost({id: 'run-zero', steps: [{definition: {id: 'start'}, attempt: 0, costUsd: 'free'}]}),
      TypeError,
    );
  });

  it('flattens history in stored order and then the current attempt', () => {
    const summary = summarizeRunCost({
      id: 'run-order',
      steps: [
        step({
          definition: {id: 'build'},
          attempt: 3,
          costUsd: 1,
          history: [
            {attempt: 1, costUsd: 0.5},
            {attempt: 2, costUsd: null},
          ],
        }),
      ],
    });
    assert.deepEqual(summary.attempts, [
      {stepId: 'build', attempt: 1, costUsd: 0.5},
      {stepId: 'build', attempt: 2, costUsd: null},
      {stepId: 'build', attempt: 3, costUsd: 1},
    ]);
    assert.equal(summary.knownUsd, 1.5);
    assert.equal(summary.unreportedAttempts, 1);
  });

  it('keeps equal attempts as separate executions', () => {
    const summary = summarizeRunCost({
      id: 'run-duplicate',
      steps: [
        step({
          definition: {id: 'retry'},
          attempt: 2,
          costUsd: 3,
          history: [
            {attempt: 2, costUsd: 1},
            {attempt: 2, costUsd: 2},
          ],
        }),
      ],
    });
    assert.deepEqual(summary.attempts, [
      {stepId: 'retry', attempt: 2, costUsd: 1},
      {stepId: 'retry', attempt: 2, costUsd: 2},
      {stepId: 'retry', attempt: 2, costUsd: 3},
    ]);
    assert.equal(summary.knownUsd, 6);
    assert.equal(summary.unreportedAttempts, 0);
  });

  it('treats zero costs as reported and null costs as unreported', () => {
    const summary = summarizeRunCost({
      id: 'run-costs',
      steps: [
        step({definition: {id: 'a'}, attempt: 1, costUsd: 0}),
        step({definition: {id: 'b'}, attempt: 1, costUsd: null}),
        step({definition: {id: 'c'}, attempt: 1, costUsd: 0.25, history: [{attempt: 1, costUsd: 0}]}),
      ],
    });
    assert.equal(summary.knownUsd, 0.25);
    assert.equal(summary.unreportedAttempts, 1);
    assert.equal(summary.attempts.length, 4);
  });

  it('does not round or prettify the summed cost', () => {
    const summary = summarizeRunCost({
      id: 'run-precision',
      steps: [
        step({definition: {id: 'a'}, attempt: 1, costUsd: 0.1}),
        step({definition: {id: 'b'}, attempt: 1, costUsd: 0.2}),
      ],
    });
    assert.equal(summary.knownUsd, 0.1 + 0.2);
    assert.notEqual(summary.knownUsd, 0.3);
  });

  it('ignores nested council costs because step costs are already aggregated', () => {
    const summary = summarizeRunCost({
      id: 'run-council',
      steps: [
        {
          definition: {id: 'council'},
          attempt: 1,
          costUsd: 2,
          council: {members: [{costUsd: 100}], totals: {costUsd: 100}},
          councilReports: [{costUsd: 100}],
          history: [{attempt: 1, costUsd: 2, council: {members: [{costUsd: 50}]}}],
        },
      ],
    });
    assert.equal(summary.knownUsd, 4);
    assert.equal(summary.unreportedAttempts, 0);
    assert.deepEqual(summary.attempts, [
      {stepId: 'council', attempt: 1, costUsd: 2},
      {stepId: 'council', attempt: 1, costUsd: 2},
    ]);
  });

  it('rejects invalid run, step, definition and history shapes with TypeError', () => {
    const invalidRuns = [
      [null],
      [[]],
      ['run'],
      [{}],
      [{id: 5, steps: []}],
      [{id: 'r'}],
      [{id: 'r', steps: null}],
      [{id: 'r', steps: [null]}],
      [{id: 'r', steps: [{}]}],
      [{id: 'r', steps: [{definition: null, attempt: 1, costUsd: 1}]}],
      [{id: 'r', steps: [{definition: {id: 5}, attempt: 1, costUsd: 1}]}],
      [{id: 'r', steps: [{definition: {}, attempt: 1, costUsd: 1}]}],
      [{id: 'r', steps: [{definition: {id: 's'}, attempt: -1, costUsd: 1}]}],
      [{id: 'r', steps: [{definition: {id: 's'}, attempt: 1.5, costUsd: 1}]}],
      [{id: 'r', steps: [{definition: {id: 's'}, attempt: 2 ** 53, costUsd: 1}]}],
      [{id: 'r', steps: [{definition: {id: 's'}, attempt: '1', costUsd: 1}]}],
      [{id: 'r', steps: [{definition: {id: 's'}, attempt: undefined, costUsd: 1}]}],
      [{id: 'r', steps: [{definition: {id: 's'}, attempt: 1, costUsd: -1}]}],
      [{id: 'r', steps: [{definition: {id: 's'}, attempt: 1, costUsd: Infinity}]}],
      [{id: 'r', steps: [{definition: {id: 's'}, attempt: 1, costUsd: NaN}]}],
      [{id: 'r', steps: [{definition: {id: 's'}, attempt: 1, costUsd: '1'}]}],
      [{id: 'r', steps: [{definition: {id: 's'}, attempt: 1}]}],
      [{id: 'r', steps: [{definition: {id: 's'}, attempt: 1, costUsd: 1, history: {}}]}],
      [{id: 'r', steps: [{definition: {id: 's'}, attempt: 1, costUsd: 1, history: [null]}]}],
      [{id: 'r', steps: [{definition: {id: 's'}, attempt: 1, costUsd: 1, history: [{attempt: -2, costUsd: 1}]}]}],
      [{id: 'r', steps: [{definition: {id: 's'}, attempt: 1, costUsd: 1, history: [{attempt: 1, costUsd: Infinity}]}]}],
      [{id: 'r', steps: [{definition: {id: 's'}, attempt: 1, costUsd: 1, history: [{attempt: 1}]}]}],
    ];
    for (const [run] of invalidRuns) {
      assert.throws(() => summarizeRunCost(run), TypeError, `expected TypeError for ${JSON.stringify(run)}`);
    }
  });

  it('rejects a cost sum that overflows to Infinity with TypeError', () => {
    assert.throws(
      () =>
        summarizeRunCost({
          id: 'run-overflow',
          steps: [
            {definition: {id: 'a'}, attempt: 1, costUsd: Number.MAX_VALUE},
            {definition: {id: 'b'}, attempt: 1, costUsd: Number.MAX_VALUE},
          ],
        }),
      TypeError,
    );
    assert.throws(
      () =>
        summarizeRunCost({
          id: 'run-overflow-history',
          steps: [
            {
              definition: {id: 'a'},
              attempt: 3,
              costUsd: 0,
              history: [
                {attempt: 1, costUsd: Number.MAX_VALUE},
                {attempt: 2, costUsd: Number.MAX_VALUE},
              ],
            },
          ],
        }),
      TypeError,
    );
  });

  it('never mutates its input', () => {
    const input = deepFreeze({
      id: 'run-frozen',
      steps: [
        {
          definition: {id: 'a'},
          attempt: 2,
          costUsd: 1,
          status: 'ok',
          history: [{attempt: 1, costUsd: null, trace: 'kept'}],
        },
        {definition: {id: 'b'}, attempt: 0, costUsd: 5, council: {reports: [{costUsd: 3}]}},
      ],
    });
    const snapshot = structuredClone(input);
    const summary = summarizeRunCost(input);
    assert.deepEqual(input, snapshot);
    assert.notEqual(summary.attempts[0], input.steps[0].history[0]);
    assert.notEqual(summary.attempts[1], input.steps[0]);
  });
});

describe('summarize-run-cost CLI', () => {
  let dir;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'summarize-run-cost-'));
  });
  after(async () => {
    await rm(dir, {recursive: true, force: true});
  });

  function runCli(args) {
    return spawnSync(process.execPath, [scriptPath, ...args], {encoding: 'utf8'});
  }

  async function writeRunFile(name, contents) {
    const file = join(dir, name);
    await writeFile(file, contents);
    return file;
  }

  it('prints formatted JSON plus a newline and exits 0', async () => {
    const file = await writeRunFile(
      'run.json',
      JSON.stringify({
        id: 'cli-run',
        steps: [
          {
            definition: {id: 'build'},
            attempt: 2,
            costUsd: 1.5,
            history: [{attempt: 1, costUsd: null}],
          },
        ],
      }),
    );
    const result = runCli([file]);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.ok(result.stdout.endsWith('\n'));
    assert.ok(result.stdout.includes('\n  "runId"'));
    assert.deepEqual(JSON.parse(result.stdout), {
      runId: 'cli-run',
      knownUsd: 1.5,
      unreportedAttempts: 1,
      attempts: [
        {stepId: 'build', attempt: 1, costUsd: null},
        {stepId: 'build', attempt: 2, costUsd: 1.5},
      ],
    });
  });

  it('exits 1 with concise stderr when the file cannot be read', () => {
    const result = runCli([join(dir, 'missing.json')]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.trim().split('\n').length, 1);
    assert.ok(result.stderr.length > 0);
    assert.ok(!result.stderr.includes('at '));
    assert.ok(!result.stderr.includes('ENOENT'));
  });

  it('exits 1 for invalid JSON without echoing file content or a stack', async () => {
    const marker = 'RAW_SECRET_MARKER';
    const file = await writeRunFile('bad.json', `{"id": "${marker}",`);
    const result = runCli([file]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.trim().split('\n').length, 1);
    assert.ok(!result.stderr.includes(marker));
    assert.ok(!result.stderr.includes('at '));
  });

  it('exits 1 for projected shape errors and sum overflow without echoing file content', async () => {
    const marker = 'SHAPE_SECRET_MARKER';
    const shapeFile = await writeRunFile('shape.json', JSON.stringify({id: marker, steps: 'not-an-array'}));
    const shapeResult = runCli([shapeFile]);
    assert.equal(shapeResult.status, 1);
    assert.equal(shapeResult.stdout, '');
    assert.equal(shapeResult.stderr.trim().split('\n').length, 1);
    assert.ok(!shapeResult.stderr.includes(marker));
    assert.ok(!shapeResult.stderr.includes('TypeError'));

    const overflowFile = await writeRunFile(
      'overflow.json',
      JSON.stringify({
        id: 'overflow',
        steps: [
          {definition: {id: 'a'}, attempt: 1, costUsd: Number.MAX_VALUE},
          {definition: {id: 'b'}, attempt: 1, costUsd: Number.MAX_VALUE},
        ],
      }),
    );
    const overflowResult = runCli([overflowFile]);
    assert.equal(overflowResult.status, 1);
    assert.equal(overflowResult.stdout, '');
    assert.equal(overflowResult.stderr.trim().split('\n').length, 1);
  });

  it('exits 2 for missing or extra arguments', async () => {
    const file = await writeRunFile('usage.json', JSON.stringify({id: 'usage', steps: []}));
    const missing = runCli([]);
    assert.equal(missing.status, 2);
    assert.equal(missing.stdout, '');
    assert.ok(missing.stderr.includes('Usage:'));
    const extra = runCli([file, 'unexpected-extra-argument']);
    assert.equal(extra.status, 2);
    assert.equal(extra.stdout, '');
    assert.ok(extra.stderr.includes('Usage:'));
  });
});

describe('module import behavior', () => {
  it('exports summarizeRunCost without running the CLI', async () => {
    const module = await loadModule();
    assert.equal(typeof module.summarizeRunCost, 'function');
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `import {summarizeRunCost} from ${JSON.stringify(pathToFileURL(scriptPath).href)};` +
          `process.stdout.write(JSON.stringify(summarizeRunCost({id: 'imported', steps: []})));`,
      ],
      {encoding: 'utf8'},
    );
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), {
      runId: 'imported',
      knownUsd: 0,
      unreportedAttempts: 0,
      attempts: [],
    });
  });
});
