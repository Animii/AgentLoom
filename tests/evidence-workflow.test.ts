import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createTestApp as createApp } from './helpers/app-fixture.js';
import { evidenceWorkflow } from '../src/server/templates.js';
import { runValidationCommand } from '../src/server/validation.js';
import type { Run } from '../src/shared/types.js';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'loom-evidence-'));
  await mkdir(path.join(root, 'work/projects/sample'), { recursive: true });
  await writeFile(path.join(root, 'work/projects/sample/app.txt'), 'original');
  let correct = true,
    jevFails = false;
  const calls: string[] = [];
  let reviewPrompt = '';
  let evalCalls = 0;
  const config = {
    dataDir: path.join(root, 'data'),
    workspaceRoot: path.join(root, 'work'),
    host: '127.0.0.1',
    port: 0,
    cliTimeoutMs: 1000,
    maxOutputBytes: 10000,
  };
  const app = await createApp(config, {
    serveStatic: false,
    execute: async (step, prompt, workspace) => {
      calls.push(step.id);
      if (step.id === 'build')
        await writeFile(
          path.join(workspace, 'app.txt'),
          correct ? 'fixed' : 'broken',
        );
      if (step.id === 'review') reviewPrompt = prompt;
      return {
        output:
          step.id === 'plan'
            ? 'Approved scope: change app.txt to fixed; platform validates content.\n\nPLAN_READY'
            : 'All requested work is complete. Tests passed.',
        sessionId: null,
        costUsd: null,
      };
    },
    jevFetch: (_url, init) => {
      evalCalls++;
      if (jevFails)
        return Promise.resolve(
          new Response('upstream unavailable', { status: 503 }),
        );
      const rawBody = init?.body;
      assert.ok(typeof rawBody === 'string');
      const body = JSON.parse(rawBody) as {
        questions: Record<string, { type: string }>;
      };
      const answers = Object.fromEntries(
        Object.entries(body.questions).map(([id, q]) => [
          id,
          q.type === 'noul'
            ? { type: 'noul', noul: id === 'claimsSupported' ? 0.95 : 0.05 }
            : {
                type: 'choice',
                choice: 'no_blocker',
                confidence: 0.95,
                probabilities: {
                  code_fix: 0.01,
                  missing_requirement: 0.01,
                  environment: 0.01,
                  mixed: 0.01,
                  no_blocker: 0.95,
                  unclear: 0.01,
                },
              },
        ]),
      );
      return Promise.resolve(
        new Response(JSON.stringify({ model: 'jev-test', answers })),
      );
    },
  });
  const workflow = structuredClone(evidenceWorkflow);
  const buildStep = workflow.steps[2];
  assert.ok(buildStep.validation);
  buildStep.validation.commands = [
    {
      executable: process.execPath,
      args: [
        '-e',
        "const fs=require('fs'); console.log('ACTUAL TEST OUTPUT'); process.exit(fs.readFileSync('app.txt','utf8')==='fixed'?0:1)",
      ],
      timeoutMs: 3000,
    },
  ];
  app.store.saveWorkflow(workflow);
  const wait = async (id: string, predicate: (r: Run) => boolean) => {
    for (let i = 0; i < 300; i++) {
      const run = app.store.getRun(id);
      if (run && predicate(run)) return run;
      await delay(20);
    }
    throw Error('Run wait timed out: ' + JSON.stringify(app.store.getRun(id)));
  };
  const start = () =>
    app.engine.create({
      title: 'Evidence workflow',
      task: 'Change app.txt to fixed and validate it.',
      project: 'sample',
      workflowId: workflow.id,
      mode: 'live',
    });
  return {
    app,
    config,
    root,
    calls,
    wait,
    start,
    setCorrect: (value: boolean) => {
      correct = value;
    },
    setJevFails: () => {
      jevFails = true;
    },
    reviewPrompt: () => reviewPrompt,
    evalCalls: () => evalCalls,
    close: async () => {
      await app.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}
void test('approved plan -> cheap implementation -> real validation + Jev -> independent review -> explicit approval', async () => {
  const f = await fixture();
  try {
    await f.app.inject({
      method: 'PUT',
      url: '/api/jev/settings',
      payload: { apiKey: 'fixture-evidence-key' },
    });
    const run = await f.start();
    await f.wait(run.id, (r) => r.status === 'waiting_approval');
    assert.deepEqual(f.calls, ['plan']);
    f.app.engine.approve(run.id);
    const reviewed = await f.wait(
      run.id,
      (r) =>
        r.currentStep === 3 &&
        r.status === 'waiting_approval' &&
        r.steps[3].assessment?.status === 'ready',
    );
    assert.deepEqual(f.calls, ['plan', 'build', 'review']);
    const evidence = reviewed.steps[2].validation;
    assert.ok(evidence);
    assert.equal(evidence.status, 'passed');
    assert.equal(evidence.commands[0].exitCode, 0);
    assert.match(evidence.commands[0].output, /ACTUAL TEST OUTPUT/);
    assert.equal(evidence.before, evidence.after);
    const signals = evidence.signals;
    assert.ok(signals);
    assert.equal(signals.status, 'ready');
    assert.equal(signals.claimsSupported, 0.95);
    assert.match(f.reviewPrompt(), /ACTUAL TEST OUTPUT/);
    assert.match(f.reviewPrompt(), /claimsSupported/);
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: `/api/runs/${run.id}/approve`,
          payload: {},
        })
      ).statusCode,
      200,
    );
    const finished = f.app.store.getRun(run.id);
    assert.ok(finished);
    assert.equal(finished.status, 'completed');
    assert.equal(
      await readFile(path.join(f.root, 'work/projects/sample/app.txt'), 'utf8'),
      'original',
    );
  } finally {
    await f.close();
  }
});
void test('failed real tests override a confident reviewer; repair repeats validation and preserves evidence history', async () => {
  const f = await fixture();
  try {
    f.setCorrect(false);
    const run = await f.start();
    await f.wait(run.id, (r) => r.status === 'waiting_approval');
    f.app.engine.approve(run.id);
    const blocked = await f.wait(run.id, (r) => r.status === 'blocked');
    assert.equal(blocked.steps[2].validation?.commands[0].exitCode, 1);
    assert.match(blocked.steps[3].output, /BLOCKED: Recorded validation/);
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: `/api/runs/${run.id}/approve`,
          payload: {},
        })
      ).statusCode,
      409,
    );
    f.setCorrect(true);
    f.app.engine.rework(run.id);
    const repaired = await f.wait(
      run.id,
      (r) => r.currentStep === 3 && r.status === 'waiting_approval',
    );
    assert.equal(repaired.steps[2].attempt, 2);
    assert.equal(repaired.steps[2].history?.[0].validation?.status, 'failed');
    const repairedValidation = repaired.steps[2].validation;
    assert.ok(repairedValidation);
    assert.equal(repairedValidation.status, 'passed');
    assert.equal(repairedValidation.signals?.status, 'unavailable');
    await writeFile(
      path.join(repaired.workspace, 'app.txt'),
      'changed after review',
    );
    const approval = await f.app.inject({
      method: 'POST',
      url: `/api/runs/${run.id}/approve`,
      payload: {},
    });
    assert.equal(approval.statusCode, 409);
    assert.match(approval.body, /Source changed/);
  } finally {
    await f.close();
  }
});
void test('Jev outage does not erase deterministic evidence or skip the reviewer', async () => {
  const f = await fixture();
  try {
    await f.app.inject({
      method: 'PUT',
      url: '/api/jev/settings',
      payload: { apiKey: 'fixture-evidence-key' },
    });
    f.setJevFails();
    const run = await f.start();
    await f.wait(run.id, (r) => r.status === 'waiting_approval');
    f.app.engine.approve(run.id);
    const reviewed = await f.wait(
      run.id,
      (r) => r.currentStep === 3 && r.status === 'waiting_approval',
    );
    const outageValidation = reviewed.steps[2].validation;
    assert.ok(outageValidation);
    assert.equal(outageValidation.status, 'passed');
    assert.equal(outageValidation.signals?.status, 'failed');
    assert.ok(f.calls.includes('review'));
  } finally {
    await f.close();
  }
});
void test('validation runner records startup failure, timeout, cancellation and output bounds', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'loom-validation-'));
  try {
    const controller = new AbortController();
    const run = (args: string[], timeoutMs = 3000) =>
      runValidationCommand(
        { executable: process.execPath, args, timeoutMs },
        root,
        controller.signal,
        () => {},
      );
    assert.equal(
      (
        await runValidationCommand(
          { executable: 'nonexistent-loom-command', args: [], timeoutMs: 1000 },
          root,
          controller.signal,
          () => {},
        )
      ).status,
      'failed',
    );
    assert.equal(
      (await run(['-e', 'setInterval(()=>{},1000)'], 100)).status,
      'timed_out',
    );
    const output = await run([
      '-e',
      "console.log('x'.repeat(80000));console.log('token=fixture-secret')",
    ]);
    assert.equal(output.truncated, true);
    assert.ok(output.output.length <= 64000);
    assert.ok(!output.output.includes('fixture-secret'));
    const pending = run(['-e', 'setInterval(()=>{},1000)']);
    setTimeout(() => {
      controller.abort();
    }, 100);
    assert.equal((await pending).status, 'cancelled');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('Markdown blocker verdicts cannot pass a final approval gate', async () => {
  const f = await fixture();
  try {
    const run = await f.start();
    await f.wait(run.id, (r) => r.status === 'waiting_approval');
    f.app.engine.approve(run.id);
    await f.wait(
      run.id,
      (r) => r.currentStep === 3 && r.status === 'waiting_approval',
    );
    for (const verdict of [
      '**BLOCKED**',
      '## Status: BLOCKED',
      '**Status: BLOCKED**',
      '__BLOCKED__',
    ]) {
      const current = f.app.store.getRun(run.id);
      assert.ok(current);
      current.steps[3].output = verdict + '\nConcrete unresolved finding.';
      f.app.store.saveRun(current);
      assert.throws(() => f.app.engine.approve(run.id), /reported blocker/);
    }
  } finally {
    await f.close();
  }
});
