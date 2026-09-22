import { createReviewAssessor } from '../src/server/review-assessment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../src/server/app.js';
import type { Run } from '../src/shared/types.js';

void test('Jev classifies a completed review without changing workflow state; stale and failed responses stay advisory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'loom-review-jev-'));
  await mkdir(path.join(root, 'work/projects/welcome'), { recursive: true });
  let mode = 'environment';
  let called = 0;
  let release: () => void = () => {};
  let held: Promise<void> | undefined;
  const fakeFetch: typeof fetch = async (_url, init) => {
    called++;
    const rawBody = init?.body;
    assert.ok(typeof rawBody === 'string');
    const body = JSON.parse(rawBody) as {
      state: string;
      questions: { blocker: { criteria: Record<string, string> } };
    };
    assert.match(body.state, /BLOCKED/);
    assert.equal(Object.keys(body.questions).length, 1);
    if (held) await held;
    if (mode === 'invalid') return new Response('{}');
    const criteria = Object.keys(body.questions.blocker.criteria);
    return new Response(
      JSON.stringify({
        model: 'jev-test',
        answers: {
          blocker: {
            type: 'choice',
            choice: mode,
            confidence: 0.9,
            probabilities: Object.fromEntries(
              criteria.map((key) => [key, key === mode ? 0.9 : 0.02]),
            ),
          },
        },
      }),
    );
  };
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
      jevFetch: fakeFetch,
      execute: (s) =>
        Promise.resolve({
          output:
            s.access === 'read-only'
              ? 'BLOCKED: Docker is not available. Code findings are resolved.'
              : 'Implemented.',
          sessionId: null,
          costUsd: null,
        }),
    },
  );
  const wait = async (id: string, check: (r: Run) => boolean) => {
    for (let i = 0; i < 150; i++) {
      const run = app.store.getRun(id);
      if (run && check(run)) return run;
      await delay(20);
    }
    throw Error('Timed out');
  };
  try {
    await app.inject({
      method: 'PUT',
      url: '/api/jev/settings',
      payload: { apiKey: 'fixture-review-secret' },
    });
    const run = await app.engine.create({
      title: 'Review classification',
      task: 'Validate the approved fix.',
      project: 'welcome',
      workflowId: 'fix-verify',
      mode: 'live',
    });
    await wait(run.id, (r) => r.status === 'waiting_approval');
    app.engine.approve(run.id);
    let reviewed = await wait(
      run.id,
      (r) => r.steps[1].assessment?.status === 'ready',
    );
    assert.equal(reviewed.status, 'blocked');
    assert.equal(reviewed.currentStep, 1);
    assert.equal(reviewed.steps[1].assessment?.category, 'environment');
    assert.equal(called, 1);
    const endpoint = `/api/runs/${run.id}/steps/verify/assessment`;
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: endpoint,
          payload: { override: 'approve' },
        })
      ).statusCode,
      400,
    );
    mode = 'invalid';
    await app.inject({ method: 'POST', url: endpoint, payload: {} });
    const failed = app.store.getRun(run.id);
    assert.ok(failed);
    reviewed = failed;
    assert.equal(reviewed.steps[1].assessment?.status, 'failed');
    assert.equal(reviewed.status, 'blocked');
    assert.ok(!JSON.stringify(reviewed).includes('fixture-review-secret'));
    mode = 'code_fix';
    held = new Promise((resolve) => {
      release = resolve;
    });
    const pending = app.inject({ method: 'POST', url: endpoint, payload: {} });
    await wait(run.id, (r) => r.steps[1].assessment?.status === 'running');
    const changed = app.store.getRun(run.id);
    assert.ok(changed);
    changed.steps[1].output = 'New review supersedes old findings.';
    changed.steps[1].assessment = undefined;
    app.store.saveRun(changed);
    release();
    await pending;
    assert.equal(app.store.getRun(run.id)?.steps[1].assessment, undefined);
    const interrupted = app.store.getRun(run.id);
    assert.ok(interrupted);
    interrupted.steps[1].assessment = {
      status: 'running',
      attempt: interrupted.steps[1].attempt,
      output: 'fixture',
      createdAt: new Date().toISOString(),
    };
    app.store.saveRun(interrupted);
    const recovered = createReviewAssessor(app.store, () =>
      Promise.reject(new Error('No request expected')),
    );
    assert.equal(
      app.store.getRun(run.id)?.steps[1].assessment?.status,
      'failed',
    );
    await recovered.close();
  } finally {
    release();
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
