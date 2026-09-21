import {after, test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {summarizeChanges} from '../scripts/summarize-changes.mjs';

const SCRIPT_PATH = join(import.meta.dirname, '..', 'scripts', 'summarize-changes.mjs');
const BASELINE = '0123456789abcdef'.repeat(4);
const OTHER_BASELINE = 'fedcba9876543210'.repeat(4);

const workspace = mkdtempSync(join(tmpdir(), 'summarize-changes-'));
after(() => rmSync(workspace, {recursive: true, force: true}));

let inputCounter = 0;
function writeInput(content) {
  inputCounter += 1;
  const filePath = join(workspace, `input-${inputCounter}.json`);
  writeFileSync(filePath, content);
  return filePath;
}

function runCli(...args) {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...args], {encoding: 'utf8'});
}

function manifest(overrides = {}) {
  return {baseline: BASELINE, added: [], modified: [], deleted: [], ...overrides};
}

function wrap(changes) {
  return {steps: [{council: {changes}}]};
}

function assertNoStack(stderr) {
  assert.ok(!/\n\s+at [^\n]+:\d+:\d+/.test(stderr), `stack trace leaked: ${stderr}`);
  assert.ok(!/TypeError|SyntaxError/.test(stderr), `error class leaked: ${stderr}`);
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

test('selects the last step that carries a council changelist', () => {
  const first = manifest({baseline: OTHER_BASELINE, added: ['first.txt']});
  const last = manifest({baseline: BASELINE, added: ['last.txt']});
  const run = {
    steps: [
      {id: 'step-1', council: {changes: first}},
      {id: 'step-2', council: {}},
      {id: 'step-3'},
      {id: 'step-4', council: {changes: undefined}},
      {id: 'step-5', council: {changes: last}},
      {id: 'step-6', council: {}}
    ]
  };
  const summary = summarizeChanges(run);
  assert.equal(summary.baseline, BASELINE);
  assert.deepEqual(summary.added, ['last.txt']);

  const onlyFirst = summarizeChanges({steps: [{council: {changes: first}}, {council: {}}]});
  assert.equal(onlyFirst.baseline, OTHER_BASELINE);

  assert.throws(
    () => summarizeChanges({steps: [{council: {changes: first}}, {council: {changes: null}}]}),
    TypeError,
    'a malformed selected manifest must not fall back to an earlier one'
  );
});

test('returns literal null when no step carries a changelist', () => {
  assert.equal(summarizeChanges({steps: []}), null);
  assert.equal(summarizeChanges({steps: [{id: 'a'}, {council: {}}, {council: null}, {council: {changes: undefined}}]}), null);
  assert.equal(summarizeChanges({steps: [null, 7, 'text']}), null);
});

test('keeps empty lists empty with a zero total', () => {
  const summary = summarizeChanges(wrap(manifest()));
  assert.deepEqual(summary, {baseline: BASELINE, added: [], modified: [], deleted: [], total: 0});
});

test('sorts each list lexicographically, copies it and reports the total', () => {
  const changes = manifest({
    added: ['zeta', 'Alpha', 'alpha', '10', '2'],
    modified: ['b', 'a'],
    deleted: ['d', 'c']
  });
  const snapshot = structuredClone(changes);
  const summary = summarizeChanges(wrap(changes));

  assert.deepEqual(summary, {
    baseline: BASELINE,
    added: ['10', '2', 'Alpha', 'alpha', 'zeta'],
    modified: ['a', 'b'],
    deleted: ['c', 'd'],
    total: 9
  });
  assert.deepEqual(Object.keys(summary), ['baseline', 'added', 'modified', 'deleted', 'total']);
  assert.notStrictEqual(summary.added, changes.added);
  assert.deepEqual(changes, snapshot);
});

test('does not mutate deeply frozen input and ignores unused fields', () => {
  const run = deepFreeze({
    id: 'run-1',
    unused: {nested: true},
    steps: [
      {id: 's1', status: 'done', output: 'ignored', council: {changes: deepFreeze(manifest({
        added: ['b', 'a'],
        ignoredField: 'ignored',
        renamed: [{from: 'x', to: 'y'}]
      })), chair: 'ignored'}},
      {id: 's2', council: {}}
    ]
  });

  const summary = summarizeChanges(run);
  assert.deepEqual(summary, {
    baseline: BASELINE,
    added: ['a', 'b'],
    modified: [],
    deleted: [],
    total: 2
  });

  const selectedLast = summarizeChanges(deepFreeze({steps: [
    {council: {changes: manifest({deleted: ['z', 'y']})}},
    {council: {changes: manifest({deleted: ['x', 'w']})}}
  ]}));
  assert.deepEqual(selectedLast.deleted, ['w', 'x']);
});

test('rejects malformed runs, manifests and fields with TypeError', () => {
  const cases = [
    ['run is null', null],
    ['run is undefined', undefined],
    ['run is a string', 'run'],
    ['run is a number', 42],
    ['run has no steps', {}],
    ['steps is null', {steps: null}],
    ['steps is not an array', {steps: 'steps'}],
    ['steps is an object', {steps: {}}],
    ['changes is null', wrap(null)],
    ['changes is an array', wrap([])],
    ['changes is a string', wrap('changes')],
    ['baseline is missing', wrap({added: [], modified: [], deleted: []})],
    ['baseline is not a string', wrap(manifest({baseline: 42}))],
    ['baseline is too short', wrap(manifest({baseline: 'a'.repeat(63)}))],
    ['baseline is too long', wrap(manifest({baseline: 'a'.repeat(65)}))],
    ['baseline is uppercase', wrap(manifest({baseline: 'A'.repeat(64)}))],
    ['baseline is not hexadecimal', wrap(manifest({baseline: 'g'.repeat(64)}))],
    ['baseline has a trailing newline', wrap(manifest({baseline: `${'a'.repeat(64)}\n`}))],
    ['added is missing', wrap({baseline: BASELINE, modified: [], deleted: []})],
    ['added is not an array', wrap(manifest({added: 'file.txt'}))],
    ['modified is not an array', wrap(manifest({modified: {}}))],
    ['deleted is not an array', wrap(manifest({deleted: null}))],
    ['added contains an empty string', wrap(manifest({added: ['']}))],
    ['added contains a non-string', wrap(manifest({added: [42]}))],
    ['modified contains null', wrap(manifest({modified: [null]}))],
    ['deleted contains an empty string', wrap(manifest({deleted: ['']}))]
  ];

  for (const [label, run] of cases) {
    assert.throws(() => summarizeChanges(run), TypeError, label);
  }
});

test('rejects duplicate paths within and across lists', () => {
  assert.throws(() => summarizeChanges(wrap(manifest({added: ['same.txt', 'same.txt']}))), TypeError);
  assert.throws(() => summarizeChanges(wrap(manifest({modified: ['dup.txt', 'other.txt', 'dup.txt']}))), TypeError);
  assert.throws(() => summarizeChanges(wrap(manifest({added: ['shared.txt'], modified: ['shared.txt']}))), TypeError);
  assert.throws(() => summarizeChanges(wrap(manifest({deleted: ['shared.txt'], added: ['shared.txt']}))), TypeError);
  assert.throws(() => summarizeChanges(wrap(manifest({modified: ['shared.txt'], deleted: ['shared.txt']}))), TypeError);

  const summary = summarizeChanges(wrap(manifest({added: ['a.txt'], modified: ['b.txt'], deleted: ['c.txt']})));
  assert.equal(summary.total, 3);
});

test('exposes summarizeChanges as the only executable export path', () => {
  assert.equal(typeof summarizeChanges, 'function');
});

test('importing the module has no side effects', () => {
  const moduleUrl = pathToFileURL(SCRIPT_PATH).href;
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(moduleUrl)});`],
    {encoding: 'utf8'}
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('CLI prints the formatted summary and exits 0', () => {
  const run = {
    steps: [
      {council: {changes: manifest({baseline: OTHER_BASELINE, added: ['old.txt']})}},
      {council: {changes: manifest({added: ['beta.txt', 'alpha.txt'], modified: ['m.txt']})}}
    ]
  };
  const filePath = writeInput(JSON.stringify(run));
  const result = runCli(filePath);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, `${JSON.stringify(summarizeChanges(run), null, 2)}\n`);
  assert.deepEqual(JSON.parse(result.stdout), {
    baseline: BASELINE,
    added: ['alpha.txt', 'beta.txt'],
    modified: ['m.txt'],
    deleted: [],
    total: 3
  });
});

test('CLI prints literal null when no manifest exists and exits 0', () => {
  const filePath = writeInput(JSON.stringify({steps: [{council: {}}, {id: 'plain'}]}));
  const result = runCli(filePath);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, 'null\n');
});

test('CLI reports a read error concisely and exits 1', () => {
  const result = runCli(join(workspace, 'does-not-exist.json'));

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.ok(result.stderr.trim().length > 0);
  assert.ok(result.stderr.length < 200);
  assertNoStack(result.stderr);
});

test('CLI reports a JSON error without echoing raw content and exits 1', () => {
  const filePath = writeInput('not json at all');
  const result = runCli(filePath);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.ok(result.stderr.trim().length > 0);
  assert.ok(!result.stderr.includes('not json'), `raw content leaked: ${result.stderr}`);
  assertNoStack(result.stderr);
});

test('CLI reports shape errors concisely and exits 1', () => {
  const result = runCli(writeInput('{"steps":"nope"}'));
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.ok(result.stderr.includes('run.steps'));
  assertNoStack(result.stderr);

  const malformed = runCli(writeInput('{"steps":[{"council":{"changes":null}}]}'));
  assert.equal(malformed.status, 1);
  assert.equal(malformed.stdout, '');
  assert.ok(malformed.stderr.includes('council.changes'));
  assertNoStack(malformed.stderr);

  const duplicate = runCli(writeInput(JSON.stringify(wrap(manifest({added: ['dup.txt', 'dup.txt']})))));
  assert.equal(duplicate.status, 1);
  assert.equal(duplicate.stdout, '');
  assert.ok(duplicate.stderr.includes('duplicate'));
  assertNoStack(duplicate.stderr);
});

test('CLI exits 2 for missing or extra arguments', () => {
  const missing = runCli();
  assert.equal(missing.status, 2);
  assert.equal(missing.stdout, '');
  assert.ok(missing.stderr.includes('Usage'));

  const extra = runCli(join(workspace, 'one.json'), join(workspace, 'two.json'));
  assert.equal(extra.status, 2);
  assert.equal(extra.stdout, '');
  assert.ok(extra.stderr.includes('Usage'));
});
