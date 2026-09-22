import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../src/server/app.js';
import { newCrate, triagePassed } from '../src/shared/crates.js';
import type { Run } from '../src/shared/types.js';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'loom-crates-'));
  await mkdir(path.join(root, 'work/projects/welcome'), { recursive: true });
  let snapshot: {
    state: 'OPEN' | 'MERGED';
    head: string;
    events: { id: string; head: string; kind: 'ci'; summary: string }[];
  } = { state: 'OPEN', head: 'a'.repeat(40), events: [] };
  const app = await createApp(
    {
      dataDir: path.join(root, 'data'),
      workspaceRoot: path.join(root, 'work'),
      host: '127.0.0.1',
      port: 0,
      cliTimeoutMs: 1000,
      maxOutputBytes: 10000,
    },
    {
      serveStatic: false,
      execute: (step) =>
        Promise.resolve({
          output: step.planning
            ? 'Agreed scope and acceptance criteria.\nPLAN_READY'
            : 'Verified the approved requirements.',
          sessionId: null,
          costUsd: null,
        }),
      readPr: () => Promise.resolve(snapshot),
    },
  );
  const post = (id: string, action: string, body: object = {}) =>
    app.inject({
      method: 'POST',
      url: `/api/runs/${id}/${action}`,
      payload: body,
    });
  const wait = async (id: string, status: string) => {
    for (let i = 0; i < 200; i++) {
      const run = app.store.getRun(id);
      if (run && run.status === status) return run;
      await delay(25);
    }
    throw Error(`Timed out waiting for ${status}`);
  };
  return {
    app,
    post,
    wait,
    setSnapshot: (value: typeof snapshot) => (snapshot = value),
    close: async () => {
      await app.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
void test('crate triage is durable, invalidates on new evidence and repairs through the implementer', async () => {
  const f = await fixture();
  try {
    const run = await f.app.engine.create({
      title: 'Triage',
      task: 'Fix within scope',
      project: 'welcome',
      workflowId: 'fix-verify',
      mode: 'live',
      crate: true,
    });
    await f.wait(run.id, 'waiting_approval');
    await f.app.engine.approveCurrent(run.id);
    await f.wait(run.id, 'waiting_approval');
    assert.equal((await f.post(run.id, 'approve')).statusCode, 409);
    assert.equal((await f.post(run.id, 'rework')).statusCode, 409);
    assert.equal(
      (
        await f.post(run.id, 'crate-triage', {
          action: 'approve',
          reason: 'Evidence meets the criteria.',
        })
      ).statusCode,
      200,
    );
    const triaged = f.app.store.getRun(run.id);
    assert.ok(triaged);
    assert.ok(triagePassed(triaged));
    assert.equal(
      (
        await f.post(run.id, 'crate-triage', {
          action: 'clarify',
          reason: 'Need a missing acceptance detail.',
        })
      ).statusCode,
      200,
    );
    const clarified = f.app.store.getRun(run.id);
    assert.ok(clarified);
    assert.equal(triagePassed(clarified), false);
    assert.equal(
      (
        await f.post(run.id, 'crate-triage', {
          action: 'repair',
          reason: 'Add the missing regression coverage.',
        })
      ).statusCode,
      200,
    );
    let repaired = await f.wait(run.id, 'waiting_approval');
    assert.equal(repaired.currentStep, 0);
    assert.equal(repaired.steps[0].attempt, 2);
    assert.ok(repaired.steps[1].history?.length);
    await f.app.engine.approveCurrent(run.id);
    repaired = await f.wait(run.id, 'waiting_approval');
    assert.equal(triagePassed(repaired), false);
    await f.post(run.id, 'crate-triage', {
      action: 'approve',
      reason: 'Fresh evidence verified.',
    });
    assert.equal((await f.post(run.id, 'approve')).statusCode, 200);
    const completed = f.app.store.getRun(run.id);
    assert.ok(completed?.crate);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.crate.triage.length, 4);
  } finally {
    await f.close();
  }
});
void test('split creates durable child identities, guards parent progress and joins only approved results', async () => {
  const f = await fixture();
  try {
    const parent = await f.app.engine.create({
      title: 'Parent',
      task: 'Independent parts',
      project: 'welcome',
      workflowId: 'review-build',
      mode: 'live',
      crate: true,
    });
    await f.wait(parent.id, 'waiting_approval');
    let stored = f.app.store.getRun(parent.id);
    assert.ok(stored);
    stored.mode = 'demo';
    f.app.store.saveRun(stored);
    const body = {
      children: [
        { title: 'API', task: 'API acceptance' },
        { title: 'UI', task: 'UI acceptance' },
      ],
    };
    const split = await f.post(parent.id, 'crate-split', body);
    assert.equal(split.statusCode, 200);
    stored = split.json<Run>();
    assert.ok(stored.crate);
    assert.equal(stored.crate.childIds.length, 2);
    assert.equal(
      (await f.post(parent.id, 'crate-split', body)).statusCode,
      409,
    );
    assert.equal((await f.post(parent.id, 'approve')).statusCode, 409);
    assert.equal((await f.post(parent.id, 'crate-join')).statusCode, 409);
    for (const id of stored.crate.childIds) {
      await f.wait(id, 'waiting_input');
      const child = f.app.store.getRun(id);
      assert.ok(child?.crate);
      assert.equal(child.crate.parentId, parent.id);
      assert.ok(child.task.includes('Parent plan:'));
      child.steps.forEach((s) => (s.status = 'completed'));
      child.currentStep = child.steps.length;
      child.status = 'completed';
      f.app.store.saveRun(child);
    }
    assert.equal((await f.post(parent.id, 'crate-join')).statusCode, 200);
    const joined = f.app.store.getRun(parent.id);
    assert.ok(joined?.crate);
    assert.equal(joined.crate.join, 'joined');
    assert.equal(
      (
        await f.post(stored.crate.childIds[0], 'messages', {
          stepId: 'plan',
          message: 'Change scope',
          messageId: crypto.randomUUID(),
        })
      ).statusCode,
      409,
    );
    await f.wait(parent.id, 'waiting_approval');
    assert.equal((await f.post(parent.id, 'approve')).statusCode, 200);
  } finally {
    await f.close();
  }
});
void test('PR event sync deduplicates, ignores old commits and preserves the same crate during repair', async () => {
  const f = await fixture();
  try {
    const run = await f.app.engine.create({
      title: 'PR repair',
      task: 'Fix',
      project: 'welcome',
      workflowId: 'fix-verify',
      mode: 'live',
    });
    await f.wait(run.id, 'waiting_approval');
    f.app.engine.approve(run.id);
    await f.wait(run.id, 'waiting_approval');
    f.app.engine.approve(run.id);
    const stored = f.app.store.getRun(run.id);
    assert.ok(stored);
    stored.crate = newCrate();
    stored.git = {
      branch: 'agentloom/test',
      baseBranch: 'main',
      baseCommit: '0'.repeat(40),
      repository: 'fixture/project',
      prUrl: 'https://github.com/fixture/project/pull/1',
      publishedCommit: 'a'.repeat(40),
    };
    f.app.store.saveRun(stored);
    f.setSnapshot({
      state: 'OPEN',
      head: 'a'.repeat(40),
      events: [
        { id: 'old', head: 'b'.repeat(40), kind: 'ci', summary: 'Old failure' },
        {
          id: 'current',
          head: 'a'.repeat(40),
          kind: 'ci',
          summary: 'Regression failed',
        },
      ],
    });
    assert.equal((await f.post(run.id, 'crate-sync')).statusCode, 200);
    await f.post(run.id, 'crate-sync');
    const synced = f.app.store.getRun(run.id);
    assert.ok(synced?.crate);
    assert.equal(synced.crate.feedback.length, 2);
    assert.equal(synced.crate.feedback[0].state, 'dismissed');
    assert.equal(
      (
        await f.post(run.id, 'crate-triage', {
          eventId: 'old',
          action: 'repair',
          reason: 'Old',
        })
      ).statusCode,
      409,
    );
    assert.equal(
      (
        await f.post(run.id, 'crate-triage', {
          eventId: 'current',
          action: 'repair',
          reason: 'In-scope regression.',
        })
      ).statusCode,
      200,
    );
    const repaired = await f.wait(run.id, 'waiting_approval');
    assert.equal(repaired.id, run.id);
    assert.ok(repaired.git && repaired.crate);
    assert.equal(repaired.git.prUrl, stored.git.prUrl);
    assert.equal(repaired.crate.updatingPr, true);
    assert.ok(
      repaired.steps[1].history?.[0].output.includes('Regression failed'),
    );
    assert.equal(
      (
        await f.post(run.id, 'crate-triage', {
          eventId: 'current',
          action: 'repair',
          reason: 'Duplicate',
        })
      ).statusCode,
      409,
    );
  } finally {
    await f.close();
  }
});
