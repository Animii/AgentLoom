import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../src/server/app.js';
import { councilWorkflow } from '../src/server/templates.js';
import {
  parseCouncilReport,
  unresolvedCouncilFindings,
  councilSummary,
  retainedTranscript,
} from '../src/server/council.js';
import type { Run } from '../src/shared/types.js';
import type { CouncilEvidence } from '../src/shared/council.js';

function required<T>(value: T | undefined | null, label: string): T {
  assert.ok(value, `${label} is present`);
  return value;
}

function councilOf(run: Run, index: number): CouncilEvidence {
  const council = run.steps[index].council;
  assert.ok(council, 'council evidence is stored');
  return council;
}

const passing = () => ({
  verdict: 'PASS',
  summary: 'AC1 verified against source and recorded check.',
  criteria: [
    {
      id: 'AC1',
      status: 'met',
      evidence: ['app.txt:1 contains fixed; recorded check exit 0'],
    },
  ],
  findings: [],
  resolutions: [],
});
const blocked = () => ({
  ...passing(),
  verdict: 'BLOCKED',
  summary: 'The value is incorrect.',
  criteria: [{ id: 'AC1', status: 'unmet', evidence: ['app.txt:1'] }],
  findings: [
    {
      id: 'F1',
      criterion: 'AC1',
      severity: 'blocker',
      summary: 'Incorrect value',
      evidence: ['app.txt:1 should contain fixed'],
    },
  ],
});

void test('repeated cumulative completion does not truncate retained transcript and tool offsets twice', () => {
  const full = 'discarded prefix' + 'x'.repeat(63980) + ' tool boundary text!';
  const retained = full.slice(-64000);
  assert.equal(
    retainedTranscript(retained, full, full.length - 64000),
    retained,
  );
  assert.equal(
    retainedTranscript(retained, full + 'new suffix', full.length - 64000),
    retained + 'new suffix',
  );
  assert.equal(
    retainedTranscript('x'.repeat(64000), 'x'.repeat(64001), 1),
    'x'.repeat(64000),
  );
  assert.equal(
    retainedTranscript('x'.repeat(64000), 'x'.repeat(64002), 1),
    'x'.repeat(64001),
  );
  assert.equal(
    retainedTranscript('Inspection text', 'Final report'),
    'Inspection text\n\nFinal report',
  );
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'loom-council-'));
  const project = path.join(root, 'work/projects/sample');
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, 'app.txt'), 'original');
  let mode = 'pass';
  let fixed = true;
  let release: (() => void) | undefined;
  const prompts: { id: string; prompt: string; workspace: string }[] = [];
  const app = await createApp(
    {
      dataDir: path.join(root, 'data'),
      workspaceRoot: path.join(root, 'work'),
      host: '127.0.0.1',
      port: 0,
      cliTimeoutMs: 1000,
      maxOutputBytes: 100000,
    },
    {
      serveStatic: false,
      execute: async (step, prompt, workspace, signal, onEvent) => {
        prompts.push({ id: step.id, prompt, workspace });
        if (step.id === 'plan')
          return {
            output:
              'AC1: app.txt must contain fixed. Run the configured check.\n\nPLAN_READY',
            sessionId: null,
            costUsd: null,
          };
        if (step.id === 'build') {
          await writeFile(
            path.join(workspace, 'app.txt'),
            fixed ? 'fixed' : 'broken',
          );
          return {
            output: 'Implementation done.',
            sessionId: null,
            costUsd: null,
          };
        }
        if (step.id === 'council-chair')
          return {
            output: JSON.stringify({
              summary: 'Checked all reports against AC1.',
              disputes:
                mode === 'dispute'
                  ? ['AC1 evidence contradicts the product claim.']
                  : [],
            }),
            sessionId: null,
            costUsd: 0.01,
          };
        if (['long_output', 'repeated_output'].includes(mode)) {
          const first = 'x'.repeat(mode === 'repeated_output' ? 50000 : 40000);
          const last =
            (mode === 'repeated_output'
              ? 'x'.repeat(30000)
              : 'y'.repeat(24001)) +
            '\nCOUNCIL_JSON\n' +
            JSON.stringify(passing()) +
            '\nEND_COUNCIL_JSON';
          onEvent({ type: 'output', message: first });
          onEvent({
            type: 'tool',
            message: 'read',
            toolCall: {
              id: 'long-tool',
              name: 'read',
              status: 'completed',
              input: {},
              startedAt: new Date().toISOString(),
            },
          });
          onEvent({ type: 'output', message: last });
          return { output: first + last, sessionId: null, costUsd: null };
        }
        onEvent({ type: 'output', message: 'Inspecting AC1.\n' });
        onEvent({
          type: 'tool',
          message: 'read',
          toolCall: {
            id: 'read-1',
            name: 'read_project_file',
            status: 'completed',
            input: { path: 'app.txt' },
            startedAt: new Date().toISOString(),
          },
        });
        onEvent({ type: 'output', message: 'Evidence collected.\n' });
        if (signal.aborted) throw Error('Cancelled');
        if (
          mode === 'hold' ||
          (['partial_initial', 'partial_challenge'].includes(mode) &&
            step.id !== 'council-adversarial')
        )
          await new Promise<void>((resolve) => {
            release = resolve;
            signal.addEventListener(
              'abort',
              () => {
                resolve();
              },
              { once: true },
            );
          });
        if (mode === 'failure' && step.id === 'council-product')
          throw Error('Provider unavailable');
        if (mode === 'mutate' && step.id === 'council-product')
          await writeFile(
            path.join(workspace, 'app.txt'),
            'modified by reviewer',
          );
        const challenge = prompt.includes('ONE FOCUSED CHALLENGE ROUND');
        const report =
          ['block', 'partial_initial', 'partial_challenge'].includes(mode) &&
          step.id === 'council-adversarial'
            ? blocked()
            : passing();
        if (mode === 'warning' && step.id === 'council-adversarial')
          Object.assign(report, {
            findings: [{ ...blocked().findings[0], severity: 'warning' }],
          });
        if (mode === 'partial_challenge' && step.id === 'council-adversarial')
          Object.assign(report, {
            findings: [
              {
                ...blocked().findings[0],
                id: 'F2',
                summary: 'New challenge blocker',
              },
            ],
            resolutions: [
              {
                findingId: 'F1',
                evidence: 'F1 refuted; a different defect F2 remains.',
              },
            ],
          });
        if (
          (challenge ||
            prompt.includes('Prior findings requiring verification')) &&
          ['resolve', 'resolve_peers'].includes(mode) &&
          step.id === 'council-adversarial'
        )
          Object.assign(report, {
            resolutions: [
              {
                findingId: 'F1',
                evidence:
                  'Read app.txt:1; value is fixed and the recorded check proves it. Earlier complaint was incorrect.',
              },
              ...(mode === 'resolve_peers'
                ? [
                    {
                      findingId: 'PEER1',
                      evidence:
                        'Also checked a peer finding from repair feedback.',
                    },
                  ]
                : []),
            ],
          });
        return {
          output: JSON.stringify(report),
          sessionId: null,
          costUsd: 0.01,
        };
      },
    },
  );
  const workflow = structuredClone(councilWorkflow);
  const validation = workflow.steps[2].validation;
  assert.ok(validation);
  validation.commands = [
    {
      executable: process.execPath,
      args: [
        '-e',
        "console.log('RECORDED AC1');process.exit(require('fs').readFileSync('app.txt','utf8')==='fixed'?0:1)",
      ],
      timeoutMs: 3000,
    },
  ];
  app.store.saveWorkflow(workflow);
  const wait = async (
    id: string,
    predicate: (run: Run) => boolean,
  ): Promise<Run> => {
    for (let i = 0; i < 500; i++) {
      const run = app.store.getRun(id);
      assert.ok(run, 'run is stored');
      if (predicate(run)) return run;
      await delay(20);
    }
    throw Error('Wait timed out: ' + JSON.stringify(app.store.getRun(id)));
  };
  const start = async () => {
    const run = await app.engine.create({
      title: 'Council pilot',
      task: 'AC1: set app.txt to fixed.',
      project: 'sample',
      workflowId: workflow.id,
      mode: 'live',
    });
    await wait(run.id, (r) => r.status === 'waiting_approval');
    app.engine.approve(run.id);
    return run;
  };
  const finish = (id: string) =>
    wait(
      id,
      (r) =>
        r.currentStep === 3 &&
        ['waiting_approval', 'blocked', 'failed'].includes(r.status),
    );
  return {
    app,
    root,
    prompts,
    workflow,
    start,
    wait,
    finish,
    mode: (value: string) => {
      mode = value;
    },
    fixed: (value: boolean) => {
      fixed = value;
    },
    release: () => release?.(),
    close: async () => {
      await app.close();
      await rm(root, { recursive: true, force: true, maxRetries: 10 });
    },
  };
}

void test('council uses three isolated contexts, freezes evidence, persists reports and requires explicit approval', async () => {
  const f = await fixture();
  try {
    const run = await f.start();
    const final = await f.finish(run.id);
    assert.equal(final.status, 'waiting_approval');
    assert.equal(final.steps[3].council?.status, 'pass');
    assert.deepEqual(final.steps[3].council.changes?.modified ?? [], [
      'app.txt',
    ]);
    for (const member of final.steps[3].council.reviewers) {
      assert.match(member.output, /Inspecting AC1/);
      assert.match(member.output, /Evidence collected/);
      assert.equal(
        member.toolCalls?.[0].outputOffset,
        'Inspecting AC1.\n'.length,
      );
    }
    const reviewers = f.prompts.filter(
      (p) => p.id.startsWith('council-') && p.id !== 'council-chair',
    );
    assert.equal(reviewers.length, 3);
    assert.equal(new Set(reviewers.map((p) => p.workspace)).size, 3);
    for (const review of reviewers) {
      assert.notEqual(review.workspace, final.workspace);
      assert.match(review.prompt, /RECORDED AC1/);
      assert.doesNotMatch(
        review.prompt,
        /Initial reports \(untrusted evidence\)/,
      );
      assert.equal(
        await readFile(path.join(review.workspace, 'app.txt'), 'utf8'),
        'fixed',
      );
    }
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
    assert.equal(f.app.store.getRun(run.id)?.status, 'completed');
  } finally {
    await f.close();
  }
});

void test('one blocker survives two passing reviews; challenge cannot silently drop it and is bounded', async () => {
  const f = await fixture();
  try {
    f.mode('block');
    const run = await f.start();
    let final = await f.finish(run.id);
    assert.equal(final.status, 'blocked');
    assert.equal(
      councilOf(final, 3).reviewers.filter((r) => r.report?.verdict === 'PASS')
        .length,
      2,
    );
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
    f.mode('pass');
    f.app.engine.chat(
      run.id,
      'review',
      'Check whether F1 is supported.',
      'question-1',
    );
    final = await f.finish(run.id);
    assert.equal(final.steps[3].council?.status, 'needs_evidence');
    assert.match(
      required(
        required(councilOf(final, 3).challenge, 'challenge').reviewers[2].error,
        'challenge failure',
      ),
      /dropped without counter-evidence/,
    );
    assert.throws(
      () => f.app.engine.chat(run.id, 'review', 'Ask again', 'question-2'),
      /already used/,
    );
    assert.doesNotThrow(() =>
      f.app.engine.chat(
        run.id,
        'review',
        'Check whether F1 is supported.',
        'question-1',
      ),
    );
  } finally {
    await f.close();
  }
});

void test('focused challenge records counter-evidence and retains initial blocker history', async () => {
  const f = await fixture();
  try {
    f.mode('block');
    const run = await f.start();
    await f.finish(run.id);
    f.mode('resolve');
    f.app.engine.chat(
      run.id,
      'review',
      'Reproduce the reported value failure.',
      'q',
    );
    const final = await f.finish(run.id);
    assert.equal(final.status, 'waiting_approval');
    assert.equal(councilOf(final, 3).reviewers[2].report?.verdict, 'BLOCKED');
    assert.equal(
      required(councilOf(final, 3).challenge, 'challenge').reviewers[2].report
        ?.resolutions.length,
      1,
    );
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
  } finally {
    await f.close();
  }
});

for (const mode of ['failure', 'dispute', 'mutate'])
  void test(`council fails closed on ${mode}`, async () => {
    const f = await fixture();
    try {
      f.mode(mode);
      const run = await f.start();
      const final = await f.finish(run.id);
      assert.equal(final.status, 'blocked');
      assert.notEqual(final.steps[3].council?.status, 'pass');
      assert.equal(
        await readFile(path.join(final.workspace, 'app.txt'), 'utf8'),
        'fixed',
      );
    } finally {
      await f.close();
    }
  });

void test('failed recorded check overrides unanimous PASS; repair archives council and repeats all evidence', async () => {
  const f = await fixture();
  try {
    f.fixed(false);
    const run = await f.start();
    let final = await f.finish(run.id);
    assert.equal(final.status, 'blocked');
    f.fixed(true);
    f.app.engine.rework(run.id);
    final = await f.finish(run.id);
    assert.equal(final.status, 'waiting_approval');
    assert.equal(final.steps[2].attempt, 2);
    assert.equal(final.steps[3].history?.[0].council?.attempt, 1);
    assert.equal(final.steps[3].council?.attempt, 2);
  } finally {
    await f.close();
  }
});

void test('source and evidence changes after council invalidate approval', async () => {
  const f = await fixture();
  try {
    const run = await f.start();
    const final = await f.finish(run.id);
    await writeFile(path.join(final.workspace, 'app.txt'), 'changed');
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
    await writeFile(path.join(final.workspace, 'app.txt'), 'fixed');
    const changed = f.app.store.getRun(run.id);
    assert.ok(changed);
    changed.steps[0].output += ' New requirement';
    f.app.store.saveRun(changed);
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
  } finally {
    await f.close();
  }
});

void test('API rejects self-review and invalid council configuration', async () => {
  const f = await fixture();
  try {
    const workflow = structuredClone(f.workflow);
    const council = workflow.steps[3].council;
    assert.ok(council);
    council.reviewers[0] = {
      ...council.reviewers[0],
      provider: 'opencode',
      model: 'deepseek/deepseek-flash',
    };
    assert.equal(
      (
        await f.app.inject({
          method: 'PUT',
          url: `/api/workflows/${workflow.id}`,
          payload: workflow,
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await f.app.inject({
          method: 'PUT',
          url: `/api/workflows/${f.workflow.id}`,
          payload: f.workflow,
        })
      ).statusCode,
      200,
    );
  } finally {
    await f.close();
  }
});

void test('malformed or contradictory model reports never become passing reports', () => {
  assert.throws(() => parseCouncilReport('PASS'));
  assert.throws(() =>
    parseCouncilReport(JSON.stringify({ ...blocked(), verdict: 'PASS' })),
  );
  assert.throws(() =>
    parseCouncilReport(JSON.stringify({ ...passing(), criteria: [] })),
  );
});

void test('cancelling a running council never advances to approval', async () => {
  const f = await fixture();
  try {
    f.mode('hold');
    const run = await f.start();
    await f.wait(
      run.id,
      (r) =>
        r.steps[3].council?.reviewers.every(
          (member) => member.status === 'running',
        ) === true,
    );
    await f.wait(run.id, (r) =>
      councilOf(r, 3).reviewers.every((member) =>
        member.output.includes('Evidence collected.'),
      ),
    );
    f.app.engine.cancel(run.id);
    await delay(100);
    const cancelled = f.app.store.getRun(run.id);
    assert.ok(cancelled);
    const cancelledCouncil = cancelled.steps[3].council;
    assert.ok(cancelledCouncil);
    assert.ok(
      cancelledCouncil.reviewers.every(
        (member) =>
          member.output.includes('Inspecting AC1.') &&
          member.toolCalls?.[0].outputOffset === 'Inspecting AC1.\n'.length,
      ),
    );
    assert.equal(f.app.store.getRun(run.id)?.status, 'cancelled');
    assert.equal(f.prompts.filter((p) => p.id === 'council-chair').length, 0);
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
  } finally {
    await f.close();
  }
});

void test('interrupted council retry preserves partial history and starts fresh independent contexts', async () => {
  const f = await fixture();
  try {
    f.mode('hold');
    const run = await f.start();
    await f.wait(
      run.id,
      (r) =>
        r.steps[3].council?.reviewers.every(
          (member) => member.status === 'running',
        ) === true,
    );
    await f.app.engine.shutdown();
    const interrupted = f.app.store.getRun(run.id);
    assert.ok(interrupted);
    assert.equal(interrupted.status, 'interrupted');
    assert.ok(interrupted.steps[3].council);
    const { Engine } = await import('../src/server/engine.js');
    const config = {
      dataDir: path.join(f.root, 'data'),
      workspaceRoot: path.join(f.root, 'work'),
      host: '127.0.0.1',
      port: 0,
      cliTimeoutMs: 1000,
      maxOutputBytes: 100000,
    };
    const retryEngine = new Engine(f.app.store, config, (step) =>
      Promise.resolve({
        output: JSON.stringify(
          step.id === 'council-chair'
            ? { summary: 'Retried evidence checked.', disputes: [] }
            : passing(),
        ),
        sessionId: null,
        costUsd: null,
      }),
    );
    try {
      retryEngine.retry(run.id);
      const final = await f.finish(run.id);
      assert.equal(final.status, 'waiting_approval');
      assert.equal(final.steps[3].history?.[0].council?.attempt, 1);
      assert.equal(final.steps[3].council?.attempt, 2);
    } finally {
      await retryEngine.shutdown();
    }
  } finally {
    await f.close();
  }
});

void test('legacy revision API uses the bounded challenge rather than replacing initial blockers', async () => {
  const f = await fixture();
  try {
    f.mode('block');
    const run = await f.start();
    await f.finish(run.id);
    f.mode('pass');
    const reply = await f.app.inject({
      method: 'POST',
      url: `/api/runs/${run.id}/revise`,
      payload: { feedback: 'Recheck F1.' },
    });
    assert.equal(reply.statusCode, 200);
    const final = await f.finish(run.id);
    assert.equal(final.status, 'blocked');
    assert.match(
      required(
        required(councilOf(final, 3).challenge, 'challenge').reviewers[2].error,
        'challenge failure',
      ),
      /counter-evidence/,
    );
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: `/api/runs/${run.id}/revise`,
          payload: { feedback: 'Again' },
        })
      ).statusCode,
      409,
    );
  } finally {
    await f.close();
  }
});

void test('retrying an interrupted challenge retains original blockers and consumes the same challenge', async () => {
  const f = await fixture();
  try {
    f.mode('block');
    const run = await f.start();
    await f.finish(run.id);
    f.mode('hold');
    f.app.engine.chat(run.id, 'review', 'Verify F1.', 'challenge');
    await f.wait(
      run.id,
      (r) =>
        r.steps[3].council?.challenge?.reviewers.every(
          (member) => member.status === 'running',
        ) === true,
    );
    await f.app.engine.shutdown();
    assert.equal(f.app.store.getRun(run.id)?.status, 'interrupted');
    const { Engine } = await import('../src/server/engine.js');
    const retry = new Engine(
      f.app.store,
      {
        dataDir: path.join(f.root, 'data'),
        workspaceRoot: path.join(f.root, 'work'),
        host: '127.0.0.1',
        port: 0,
        cliTimeoutMs: 1000,
        maxOutputBytes: 100000,
      },
      (step) =>
        Promise.resolve({
          output: JSON.stringify(
            step.id === 'council-chair'
              ? { summary: 'Check findings.', disputes: [] }
              : passing(),
          ),
          sessionId: null,
          costUsd: null,
        }),
    );
    try {
      retry.retry(run.id);
      const final = await f.finish(run.id);
      assert.equal(final.status, 'blocked');
      assert.equal(councilOf(final, 3).reviewers[2].report?.verdict, 'BLOCKED');
      assert.match(
        required(
          required(councilOf(final, 3).challenge, 'challenge').reviewers[2]
            .error,
          'challenge failure',
        ),
        /counter-evidence/,
      );
      assert.throws(
        () => retry.chat(run.id, 'review', 'Again', 'again'),
        /already used/,
      );
    } finally {
      await retry.shutdown();
    }
  } finally {
    await f.close();
  }
});

for (const phase of ['initial', 'challenge', 'stale_challenge'])
  void test(`completed ${phase} blocker survives another member being interrupted`, async () => {
    const f = await fixture();
    try {
      f.mode(phase === 'initial' ? 'partial_initial' : 'block');
      const run = await f.start();
      if (phase !== 'initial') {
        await f.finish(run.id);
        f.mode('partial_challenge');
        f.app.engine.chat(run.id, 'review', 'Check the evidence.', 'partial');
      }
      await f.wait(run.id, (r) => {
        const council = r.steps[3].council;
        return (
          (phase !== 'initial'
            ? council?.challenge?.reviewers
            : council?.reviewers)?.[2].status === 'completed'
        );
      });
      await f.app.engine.shutdown();
      if (phase === 'stale_challenge') {
        const staleRun = f.app.store.getRun(run.id);
        assert.ok(staleRun);
        await writeFile(path.join(staleRun.workspace, 'extra.txt'), 'changed');
      }
      const { Engine } = await import('../src/server/engine.js');
      const executed: string[] = [];
      const retry = new Engine(
        f.app.store,
        {
          dataDir: path.join(f.root, 'data'),
          workspaceRoot: path.join(f.root, 'work'),
          host: '127.0.0.1',
          port: 0,
          cliTimeoutMs: 1000,
          maxOutputBytes: 100000,
        },
        (step) => {
          executed.push(step.id);
          return Promise.resolve({
            output: JSON.stringify(
              step.id === 'council-chair'
                ? { summary: 'Retained findings.', disputes: [] }
                : passing(),
            ),
            sessionId: null,
            costUsd: null,
          });
        },
      );
      try {
        retry.retry(run.id);
        const final = await f.finish(run.id);
        assert.equal(final.status, 'blocked');
        assert.ok(!executed.includes('council-adversarial'));
        const evidence = councilOf(final, 3);
        const chosenReviews =
          phase !== 'initial'
            ? required(evidence.challenge, 'challenge').reviewers
            : evidence.reviewers;
        assert.equal(
          required(chosenReviews[2].report, 'review report').findings[0].id,
          phase !== 'initial' ? 'F2' : 'F1',
        );
        if (phase === 'stale_challenge') {
          assert.equal(evidence.status, 'stale');
          assert.deepEqual(
            unresolvedCouncilFindings(evidence)[0].findings.map((f) => f.id),
            ['F2'],
          );
          assert.match(councilSummary(evidence), /New challenge blocker/);
        }
      } finally {
        await retry.shutdown();
      }
    } finally {
      await f.close();
    }
  });

void test('repair handoffs carry unresolved blockers across revisions until explicit resolution', async () => {
  const f = await fixture();
  try {
    f.mode('block');
    const run = await f.start();
    await f.finish(run.id);
    f.mode('pass');
    f.app.engine.rework(run.id);
    let final = await f.finish(run.id);
    assert.equal(final.status, 'blocked');
    assert.match(
      required(councilOf(final, 3).reviewers[2].error, 'reviewer error'),
      /earlier revision/,
    );
    assert.match(councilSummary(councilOf(final, 3)), /Incorrect value/);
    f.mode('resolve');
    f.app.engine.rework(run.id);
    final = await f.finish(run.id);
    assert.equal(final.status, 'waiting_approval');
    assert.equal(
      councilOf(final, 3).reviewers[2].report?.resolutions[0].findingId,
      'F1',
    );
    assert.match(
      required(f.prompts.filter((p) => p.id === 'build').at(-1), 'build prompt')
        .prompt,
      /Incorrect value/,
    );
  } finally {
    await f.close();
  }
});

void test('long streamed reviewer transcript keeps actual tool position after cumulative provider completion', async () => {
  const f = await fixture();
  try {
    f.mode('long_output');
    const run = await f.start();
    const final = await f.finish(run.id);
    const full =
      'x'.repeat(40000) +
      'y'.repeat(24001) +
      '\nCOUNCIL_JSON\n' +
      JSON.stringify(passing()) +
      '\nEND_COUNCIL_JSON';
    for (const review of councilOf(final, 3).reviewers) {
      assert.equal(review.status, 'completed');
      assert.equal(review.output, full.slice(-64000));
      assert.equal(
        required(review.toolCalls, 'review tool calls')[0].outputOffset,
        40000 - (full.length - 64000),
      );
    }
  } finally {
    await f.close();
  }
});

void test('repeated streamed content uses absolute discarded length when cumulative completion arrives', async () => {
  const f = await fixture();
  try {
    f.mode('repeated_output');
    const run = await f.start();
    const final = await f.finish(run.id);
    const full =
      'x'.repeat(80000) +
      '\nCOUNCIL_JSON\n' +
      JSON.stringify(passing()) +
      '\nEND_COUNCIL_JSON';
    for (const review of councilOf(final, 3).reviewers) {
      assert.equal(review.status, 'completed');
      assert.equal(review.output, full.slice(-64000));
      assert.equal(
        required(review.toolCalls, 'review tool calls')[0].outputOffset,
        50000 - (full.length - 64000),
      );
    }
  } finally {
    await f.close();
  }
});

void test('hard restart replaces stale running reviewer indicators while preserving completed reports', async () => {
  const f = await fixture();
  try {
    const created = await f.start();
    const run = await f.finish(created.id);
    await f.app.engine.shutdown();
    run.status = 'running';
    run.steps[3].status = 'running';
    const evidence = councilOf(run, 3);
    evidence.status = 'running';
    evidence.reviewers[1].status = 'running';
    evidence.reviewers[1].output = 'Partial text survives';
    required(evidence.chair, 'council chair').status = 'running';
    f.app.store.saveRun(run);
    const { Engine } = await import('../src/server/engine.js');
    const recovered = new Engine(
      f.app.store,
      {
        dataDir: path.join(f.root, 'data'),
        workspaceRoot: path.join(f.root, 'work'),
        host: '127.0.0.1',
        port: 0,
        cliTimeoutMs: 1000,
        maxOutputBytes: 100000,
      },
      () => Promise.reject(Error('Must not run automatically')),
    );
    try {
      const saved = f.app.store.getRun(run.id);
      assert.ok(saved);
      assert.equal(saved.status, 'interrupted');
      assert.equal(councilOf(saved, 3).reviewers[0].status, 'completed');
      assert.equal(councilOf(saved, 3).reviewers[1].status, 'failed');
      assert.equal(
        councilOf(saved, 3).reviewers[1].output,
        'Partial text survives',
      );
      assert.equal(
        required(councilOf(saved, 3).chair, 'chair').status,
        'failed',
      );
    } finally {
      await recovered.shutdown();
    }
  } finally {
    await f.close();
  }
});

void test('repair reviewer may explicitly resolve its own prior warning without being rejected as an initial hallucination', async () => {
  const f = await fixture();
  try {
    f.mode('warning');
    const run = await f.start();
    await f.finish(run.id);
    f.mode('resolve');
    f.app.engine.rework(run.id);
    const final = await f.finish(run.id);
    assert.equal(final.status, 'waiting_approval');
    assert.equal(
      councilOf(final, 3).reviewers[2].report?.resolutions[0].findingId,
      'F1',
    );
  } finally {
    await f.close();
  }
});

void test('cross-member resolution extras cannot clear own obligations and do not discard a valid repair report', async () => {
  const f = await fixture();
  try {
    f.mode('block');
    const run = await f.start();
    await f.finish(run.id);
    f.mode('resolve_peers');
    f.app.engine.rework(run.id);
    const final = await f.finish(run.id);
    assert.equal(final.status, 'waiting_approval');
    assert.deepEqual(
      councilOf(final, 3).reviewers[2].report?.resolutions.map(
        (r) => r.findingId,
      ),
      ['F1'],
    );
  } finally {
    await f.close();
  }
});
