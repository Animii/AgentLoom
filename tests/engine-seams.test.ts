import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Engine } from '../src/server/engine.js';
import type { EngineEffects } from '../src/server/ports/execution.js';
import type { ExecuteAgent, Run, StepDefinition } from '../src/shared/types.js';
import { MemoryRepository } from './helpers/memory-repository.js';
import { createAppFixture } from './helpers/app-fixture.js';
import { repositoryRun } from './helpers/repository-contract.js';

function unexpected(): never {
  throw new Error('Unexpected environmental effect in isolated workflow test');
}
const definition = (id: string, approval = false): StepDefinition => ({
  id,
  name: id,
  role: 'implementer',
  provider: 'codex',
  model: 'fake',
  effort: 'high',
  instructions: 'Approved scope',
  access: id === 'review' ? 'read-only' : 'workspace-write',
  approval,
  planning: false,
});

function fixture(
  t: TestContext,
  steps: StepDefinition[],
  execute: ExecuteAgent,
  overrides: Partial<EngineEffects> = {},
) {
  const store = new MemoryRepository();
  const effects: EngineEffects = {
    projects: {
      forRun: () => Promise.resolve(undefined),
      assertNoConflict: () => undefined,
      resolve: unexpected,
      directFolder: unexpected,
    },
    prepareWorkspace: () => Promise.resolve('/virtual/workspace'),
    prepareWorkspaceFrom: unexpected,
    prepareGitWorkspace: unexpected,
    previewRunGit: unexpected,
    workspaceExists: () => false,
    readSourceSnapshot: unexpected,
    sourceFingerprint: unexpected,
    writeEvidencePacket: () =>
      Promise.resolve({ path: '/virtual/evidence.json', sha256: 'fake' }),
    runValidationCommand: unexpected,
    runCouncil: unexpected,
    assertCouncilCurrent: unexpected,
    ...overrides,
  };
  const engine = new Engine(
    store,
    {
      dataDir: '/virtual/data',
      workspaceRoot: '/virtual/workspaces',
      port: 0,
      host: '127.0.0.1',
      cliTimeoutMs: 1000,
      maxOutputBytes: 10000,
    },
    execute,
    effects,
  );
  t.after(async () => {
    await engine.shutdown();
    store.close();
  });
  store.saveWorkflow({
    id: 'isolated',
    name: 'Isolated',
    description: '',
    steps,
    updatedAt: new Date().toISOString(),
  });
  return {
    engine,
    store,
    create: (crate = false) =>
      engine.create({
        title: 'Task',
        task: 'Approved scope',
        project: 'virtual',
        workflowId: 'isolated',
        mode: 'live',
        crate,
      }),
    wait: async (id: string, status: Run['status']) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const run = store.getRun(id);
        if (run?.status === status) return run;
        await delay(5);
      }
      throw new Error(
        `Expected ${status}; last state ${JSON.stringify(store.getRun(id))}`,
      );
    },
  };
}

void test('memory workflow runs no next agent until approval and completes after approval', async (t) => {
  const calls: string[] = [];
  const f = fixture(
    t,
    [definition('build', true), definition('review', true)],
    (step) => {
      calls.push(step.id);
      return Promise.resolve({
        output: 'Within scope',
        sessionId: null,
        costUsd: null,
      });
    },
  );
  const run = await f.create();
  await f.wait(run.id, 'waiting_approval');
  assert.deepEqual(calls, ['build']);
  assert.equal(f.store.getRun(run.id)?.currentStep, 0);
  f.engine.approve(run.id);
  await f.wait(run.id, 'waiting_approval');
  assert.deepEqual(calls, ['build', 'review']);
  await f.engine.approveCurrent(run.id);
  assert.equal(f.store.getRun(run.id)?.status, 'completed');
});

void test('memory retry preserves failed attempt and reruns only after explicit retry', async (t) => {
  let calls = 0;
  const f = fixture(t, [definition('build', true)], () => {
    calls += 1;
    return calls === 1
      ? Promise.reject(new Error('Scripted failure'))
      : Promise.resolve({ output: 'Fixed', sessionId: null, costUsd: null });
  });
  const run = await f.create();
  await f.wait(run.id, 'failed');
  assert.equal(calls, 1);
  f.engine.retry(run.id);
  const retried = await f.wait(run.id, 'waiting_approval');
  assert.equal(calls, 2);
  assert.equal(retried.steps[0]?.attempt, 2);
  assert.equal(retried.steps[0]?.history?.[0]?.status, 'failed');
  await f.engine.approveCurrent(run.id);
  assert.equal(f.store.getRun(run.id)?.status, 'completed');
});

void test('crate final approval requires an explicit triage decision', async (t) => {
  const f = fixture(t, [definition('build'), definition('review', true)], () =>
    Promise.resolve({
      output: 'Review passed',
      sessionId: null,
      costUsd: null,
    }),
  );
  const run = await f.create(true);
  await f.wait(run.id, 'waiting_approval');
  await assert.rejects(f.engine.approveCurrent(run.id), /triage/i);
  f.engine.triage(run.id, 'approve', 'Evidence satisfies the approved scope.');
  await f.engine.approveCurrent(run.id);
  assert.equal(f.store.getRun(run.id)?.status, 'completed');
});

void test('fake validation records failure and cannot reach final approval', async (t) => {
  const validate = {
    ...definition('validate'),
    validation: {
      commands: [{ executable: 'fake', args: [], timeoutMs: 100 }],
    },
  };
  const f = fixture(
    t,
    [validate, definition('review', true)],
    () =>
      Promise.resolve({
        output: 'Inspect failed validation',
        sessionId: null,
        costUsd: null,
      }),
    {
      sourceFingerprint: () => Promise.resolve('source'),
      runValidationCommand: (command, _cwd, _signal, update) => {
        const result = {
          command,
          status: 'failed' as const,
          exitCode: 1,
          output: 'Scripted assertion failure',
          truncated: false,
          startedAt: new Date().toISOString(),
        };
        update(result);
        return Promise.resolve(result);
      },
    },
  );
  const run = await f.create();
  const stopped = await f.wait(run.id, 'blocked');
  assert.equal(stopped.steps[0]?.validation?.status, 'failed');
  assert.equal(stopped.currentStep, 1);
  await assert.rejects(f.engine.approveCurrent(run.id), /validation/i);
});

void test('composition shares the injected Git preview across HTTP, approval and publication', async (t) => {
  let previews = 0;
  let publications = 0;
  const preview = {
    branch: 'task',
    baseBranch: 'main',
    baseCommit: 'base',
    head: 'head',
    tree: 'tree',
    token: 'a'.repeat(64),
    stat: '',
    diff: '',
    title: 'Task',
    body: 'Reviewed',
    canPublish: true,
  };
  const f = await createAppFixture(t, {
    options: {
      repository: new MemoryRepository(),
      previewGit: () => {
        previews += 1;
        return Promise.resolve(preview);
      },
      publishPr: () => {
        publications += 1;
        return Promise.resolve({
          url: 'https://example.test/pr/1',
          commit: 'commit',
        });
      },
    },
  });
  const run = repositoryRun('approved');
  run.status = 'waiting_approval';
  run.workspace = '/virtual/workspace';
  run.git = { branch: 'task', baseBranch: 'main', baseCommit: 'base' };
  run.steps = [
    {
      definition: definition('review', true),
      status: 'waiting_approval',
      attempt: 1,
      output: 'Passed',
      error: null,
      sessionId: null,
      feedback: '',
      startedAt: null,
      finishedAt: null,
      costUsd: null,
    },
  ];
  f.app.store.saveRun(run);
  const response = await f.app.inject({
    method: 'GET',
    url: '/api/runs/approved/git',
  });
  assert.equal(response.statusCode, 200);
  await f.app.engine.approveCurrent(run.id);
  assert.equal(f.app.store.getRun(run.id)?.git?.approvedTree, 'tree');
  const publication = await f.app.inject({
    method: 'POST',
    url: '/api/runs/approved/pull-request',
    payload: { token: preview.token, title: preview.title, body: preview.body },
  });
  assert.equal(publication.statusCode, 200, publication.body);
  assert.equal(previews, 3);
  assert.equal(publications, 1);
});
