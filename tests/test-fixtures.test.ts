import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createAppFixture } from './helpers/app-fixture.js';
import { withUiApp } from './support/ui-harness.js';
import { agentResult, scriptedAgent } from './helpers/scripted-agent.js';
import type { ProviderInfo, Run } from '../src/shared/types.js';

void test('default fixtures reject unexpected live work and explicit scripts record calls', async (t) => {
  const denied = await createAppFixture(t);
  const providers = await denied.request<ProviderInfo[]>('/api/providers');
  assert.ok(providers.every((provider) => provider.version === 'test-fixture'));
  const input = {
    title: 'Fixture review',
    task: 'Review the fixture.',
    project: 'welcome',
    workflowId: 'quick-review',
    mode: 'live' as const,
  };
  const unexpected = await denied.app.engine.create(input);
  const failure = await denied.wait(unexpected.id, 'failed');
  assert.match(failure.steps[0].error ?? '', /Unexpected provider execution/);

  const agent = scriptedAgent([
    agentResult('Reviewed the requested scope.'),
    agentResult('Confirmed the independent review.'),
  ]);
  const allowed = await createAppFixture(t, {
    options: { execute: agent.execute },
  });
  const run = await allowed.request<Run>('/api/runs', {
    method: 'POST',
    expectedStatus: 201,
    payload: input,
  });
  const completed = await allowed.wait(run.id, 'completed');
  assert.equal(completed.steps[0].output, 'Reviewed the requested scope.');
  assert.equal(agent.calls.length, 2);
  assert.match(agent.calls[0][1], /Review the fixture/);
  const excess = await allowed.app.engine.create(input);
  const exhausted = await allowed.wait(excess.id, 'failed');
  assert.match(exhausted.steps[0].error ?? '', /script exhausted/);
});

void test('unsafe fixture paths neither overwrite outside files nor leave partially created applications', async (t) => {
  const parent = await mkdtemp(path.join(tmpdir(), 'loom-fixture-safety-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const sentinel = path.join(parent, 'sentinel.txt');
  await writeFile(sentinel, 'unchanged');
  const cases: { project: string; files: Record<string, string> }[] = [
    { project: '../../outside', files: { 'README.md': 'bad' } },
    { project: 'welcome', files: { '../../../../sentinel.txt': 'bad' } },
    { project: 'welcome', files: { [sentinel]: 'bad' } },
  ];
  for (const options of cases) {
    await assert.rejects(
      createAppFixture(undefined, { ...options, temporaryParent: parent }),
      /test-owned directory/,
    );
    assert.equal(await readFile(sentinel, 'utf8'), 'unchanged');
    assert.deepEqual(await readdir(parent), ['sentinel.txt']);
  }
});

void test('a mid-setup filesystem failure removes its temporary workspace', async (t) => {
  const parent = await mkdtemp(path.join(tmpdir(), 'loom-fixture-failure-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  await assert.rejects(
    createAppFixture(undefined, {
      temporaryParent: parent,
      files: {
        occupied: 'file',
        'occupied/nested.txt': 'cannot create child of a file',
      },
    }),
  );
  assert.deepEqual(await readdir(parent), []);
});

void test('fixture restart retains state and teardown is idempotent', async (t) => {
  const f = await createAppFixture(t);
  const workflow = f.app.store.getWorkflow('quick-review');
  assert.ok(workflow);
  f.app.store.saveWorkflow({ ...workflow, archived: true });
  await f.restart();
  assert.equal(f.app.store.getWorkflow('quick-review')?.archived, true);
  await f.close();
  await f.close();
  await assert.rejects(readdir(f.root), { code: 'ENOENT' });
});

void test('UI harness refuses caller-owned targets before starting an application', async () => {
  for (const env of [
    { E2E_BASE_URL: 'http://127.0.0.1:4317' },
    { E2E_BASE_URL: 'http://127.0.0.1:4999' },
    { E2E_WORKSPACE_ROOT: '/existing-workspace' },
    { AGENTLOOM_TEST_ROOT: '/existing-root' },
  ]) {
    let invoked = false;
    await assert.rejects(
      withUiApp(
        env,
        () => {
          invoked = true;
          return Promise.resolve(0);
        },
        { built: false },
      ),
      /production targets are not accepted/,
    );
    assert.equal(invoked, false);
  }
});

void test('UI runner failure closes the listening app and deletes its workspace', async () => {
  let root = '';
  let address = '';
  await assert.rejects(
    withUiApp(
      {},
      async (context) => {
        root = context.root;
        address = context.address;
        assert.notEqual(new URL(address).port, '4317');
        assert.match(
          await readFile(
            path.join(context.workspace, 'projects/welcome/README.md'),
            'utf8',
          ),
          /Welcome/,
        );
        assert.equal((await fetch(`${address}/api/health`)).status, 200);
        throw new Error('Simulated browser runner failure');
      },
      { built: false },
    ),
    /Simulated browser runner failure/,
  );
  assert.ok(root);
  await assert.rejects(readdir(root), { code: 'ENOENT' });
  await assert.rejects(fetch(`${address}/api/health`));
});

void test(
  'SIGTERM terminates a running UI child and cleans the fixture',
  {
    skip:
      process.platform === 'win32'
        ? 'Windows terminate-process does not deliver catchable POSIX SIGTERM; cleanup is covered through runner failure.'
        : false,
    timeout: 10000,
  },
  async (t) => {
    const parent = await mkdtemp(path.join(tmpdir(), 'loom-ui-signal-'));
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'tests/fixtures/ui-signal-child.ts'],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, SIGNAL_TEST_PARENT: parent },
      },
    );
    t.after(async () => {
      child.kill('SIGKILL');
      await rm(parent, { recursive: true, force: true });
    });
    const ended = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    await new Promise<void>((resolve, reject) => {
      child.stdout.once('data', () => {
        resolve();
      });
      child.once('error', reject);
      child.once('exit', (code) => {
        reject(new Error(`Harness exited before ready: ${String(code)}`));
      });
    });
    child.kill('SIGTERM');
    assert.equal(await ended, 143);
    assert.deepEqual(await readdir(parent), []);
  },
);
