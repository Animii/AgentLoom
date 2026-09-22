import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/server/store.js';
import { Engine } from '../src/server/engine.js';
import type {
  AppConfig,
  ExecuteAgent,
  Run,
  StepDefinition,
  Workflow,
} from '../src/shared/types.js';

const definition = (id: string, approval = false): StepDefinition => ({
  id,
  name: id,
  role: 'implementer',
  provider: 'opencode',
  model: 'deepseek/deepseek-flash',
  effort: 'max',
  instructions: 'Only the approved task.',
  access: 'workspace-write',
  approval,
});
async function fixture(execute: ExecuteAgent) {
  const root = await mkdtemp(path.join(tmpdir(), 'loom-test-'));
  const work = path.join(root, 'workspaces');
  await mkdir(path.join(work, 'projects', 'sample'), { recursive: true });
  await writeFile(
    path.join(work, 'projects', 'sample', 'README.md'),
    'Original source',
  );
  const config: AppConfig = {
    dataDir: path.join(root, 'data'),
    workspaceRoot: work,
    port: 4317,
    host: '127.0.0.1',
    cliTimeoutMs: 3000,
    maxOutputBytes: 100000,
  };
  const store = new Store(config.dataDir);
  const engine = new Engine(store, config, execute);
  const workflow = (steps: StepDefinition[]) => {
    const w: Workflow = {
      id: 'test',
      name: 'Test workflow',
      description: '',
      steps,
      updatedAt: new Date().toISOString(),
    };
    store.saveWorkflow(w);
    return w;
  };
  const create = (mode: 'live' | 'demo' = 'live') =>
    engine.create({
      title: 'Test run',
      task: 'Implement the approved task.',
      project: 'sample',
      workflowId: 'test',
      mode,
    });
  const wait = async (id: string, status: Run['status']) => {
    for (let i = 0; i < 250; i++) {
      const r = store.getRun(id);
      if (r && r.status === status) return r;
      await delay(20);
    }
    throw new Error(
      `Timed out waiting ${status}: ${JSON.stringify(store.getRun(id))}`,
    );
  };
  return {
    root,
    work,
    config,
    store,
    engine,
    workflow,
    create,
    wait,
    close: async () => {
      await engine.shutdown();
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
const success: ExecuteAgent = (_s, _p, _w, _sig, event) => {
  event({ type: 'output', message: 'draft' });
  return Promise.resolve({
    output: 'Approved implementation',
    sessionId: 'session-1',
    costUsd: 0.001,
  });
};

void test('approval gates stop execution, reject duplicate approval and preserve approved context', async () => {
  const calls: string[] = [];
  const prompts: string[] = [];
  const f = await fixture(async (s, p, w, _sig, event) => {
    calls.push(s.id);
    prompts.push(p);
    await writeFile(path.join(w, `${s.id}.txt`), 'local change');
    return success(s, p, w, _sig, event);
  });
  try {
    f.workflow([definition('design', true), definition('build', true)]);
    const r = await f.create();
    await f.wait(r.id, 'waiting_approval');
    assert.deepEqual(calls, ['design']);
    f.engine.approve(r.id);
    assert.throws(() => f.engine.approve(r.id));
    await f.wait(r.id, 'waiting_approval');
    assert.deepEqual(calls, ['design', 'build']);
    assert.match(prompts[1], /Approved implementation/);
    f.engine.approve(r.id);
    const done = await f.wait(r.id, 'completed');
    assert.equal(done.steps[1].attempt, 1);
    assert.equal(
      await readFile(path.join(f.work, 'projects/sample/README.md'), 'utf8'),
      'Original source',
    );
    assert.ok(f.store.getEvents(r.id).some((e) => e.type === 'approval'));
  } finally {
    await f.close();
  }
});

void test('automatic workflow across three providers completes without approval', async () => {
  const called: string[] = [];
  const f = await fixture(async (s, ...a) => {
    called.push(s.provider);
    return success(s, ...a);
  });
  try {
    f.workflow([
      { ...definition('a'), provider: 'claude' },
      { ...definition('b'), provider: 'codex' },
      definition('c'),
    ]);
    const r = await f.create();
    const done = await f.wait(r.id, 'completed');
    assert.deepEqual(called, ['claude', 'codex', 'opencode']);
    assert.ok(done.steps.every((s) => s.status === 'completed'));
  } finally {
    await f.close();
  }
});

void test('revision repeats current step with feedback, never runs downstream before approval', async () => {
  const prompts: string[] = [];
  const f = await fixture(async (s, p, ...a) => {
    prompts.push(p);
    return success(s, p, ...a);
  });
  try {
    f.workflow([definition('design', true), definition('build')]);
    const r = await f.create();
    await f.wait(r.id, 'waiting_approval');
    f.engine.revise(r.id, 'Use an accessible label.');
    const revised = await f.wait(r.id, 'waiting_approval');
    assert.equal(revised.steps[0].attempt, 2);
    assert.equal(revised.steps[1].attempt, 0);
    assert.match(prompts[1], /accessible label/);
    assert.match(prompts[1], /Approved implementation/);
    assert.ok(f.store.getEvents(r.id).some((e) => e.type === 'revision'));
  } finally {
    await f.close();
  }
});

void test('BLOCKED output cannot be approved; explicit revision resolves it', async () => {
  let count = 0;
  const f = await fixture(() =>
    Promise.resolve({
      output: ++count === 1 ? 'BLOCKED: Which limit?' : 'Limit is 40.',
      sessionId: null,
      costUsd: null,
    }),
  );
  try {
    f.workflow([definition('build', true)]);
    const r = await f.create();
    await f.wait(r.id, 'blocked');
    assert.throws(() => f.engine.approve(r.id));
    f.engine.revise(r.id, 'The approved limit is 40.');
    await f.wait(r.id, 'waiting_approval');
    f.engine.approve(r.id);
    await f.wait(r.id, 'completed');
  } finally {
    await f.close();
  }
});

void test('failure requires manual retry and retains event history', async () => {
  let calls = 0;
  const f = await fixture(() => {
    if (++calls === 1) throw new Error('Provider offline');
    return Promise.resolve({
      output: 'Recovered',
      sessionId: null,
      costUsd: null,
    });
  });
  try {
    f.workflow([definition('build')]);
    const r = await f.create();
    await f.wait(r.id, 'failed');
    const before = f.store.getEvents(r.id).length;
    f.engine.retry(r.id);
    const done = await f.wait(r.id, 'completed');
    assert.equal(done.steps[0].attempt, 2);
    assert.ok(f.store.getEvents(r.id).length > before);
    assert.ok(
      f.store
        .getEvents(r.id)
        .some((e) => e.message.includes('Provider offline')),
    );
  } finally {
    await f.close();
  }
});

void test(
  'retry after shutdown retains partial files, transcript, tools and unknown attempt cost',
  { timeout: 10000 },
  async () => {
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const f = await fixture(async (_s, _p, workspace, signal, event) => {
      await writeFile(path.join(workspace, 'partial.txt'), 'keep this work');
      event({
        type: 'output',
        message: 'Partial implementation before restart.',
      });
      event({
        type: 'tool',
        message: 'Read project',
        toolCall: {
          id: 'before-restart',
          name: 'read',
          status: 'completed',
          input: { path: 'README.md' },
          startedAt: new Date().toISOString(),
        },
      });
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          'abort',
          () => {
            resolve();
          },
          { once: true },
        );
        notifyStarted();
      });
      return { output: 'Late completion', sessionId: null, costUsd: 9 };
    });
    let restarted: Engine | undefined;
    try {
      f.workflow([definition('build')]);
      const run = await f.create();
      await started;
      await f.engine.shutdown();
      const interrupted = f.store.getRun(run.id);
      assert.ok(interrupted);
      assert.equal(interrupted.status, 'interrupted');
      const prior = interrupted.steps[0];
      assert.match(prior.output, /Partial implementation/);
      assert.equal(prior.costUsd, null);
      restarted = new Engine(
        f.store,
        f.config,
        async (s, p, workspace, signal, event) => {
          assert.equal(
            await readFile(path.join(workspace, 'partial.txt'), 'utf8'),
            'keep this work',
          );
          return success(s, p, workspace, signal, event);
        },
      );
      restarted.retry(run.id);
      const done = await f.wait(run.id, 'completed'),
        step = done.steps[0];
      assert.equal(step.attempt, 2);
      assert.equal(step.costUsd, 0.001);
      assert.equal(step.history?.length, 1);
      const saved = step.history[0];
      for (const key of [
        'attempt',
        'status',
        'output',
        'error',
        'startedAt',
        'finishedAt',
        'costUsd',
        'execution',
        'toolCalls',
      ] as const)
        assert.deepEqual(saved[key], prior[key]);
      assert.equal(saved.costUsd, null);
      assert.deepEqual(step.toolCalls, []);
      assert.equal(saved.toolCalls?.[0].name, 'read');
    } finally {
      await restarted?.shutdown();
      await f.close();
    }
  },
);

void test(
  'cancellation aborts owned work and late completion cannot revive run',
  { timeout: 10000 },
  async () => {
    let aborted = false,
      notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const f = await fixture(async (_s, _p, _w, signal) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            resolve();
          },
          { once: true },
        );
        notifyStarted();
      });
      return { output: 'late', sessionId: null, costUsd: null };
    });
    try {
      f.workflow([definition('build')]);
      const r = await f.create();
      // Running includes asynchronous evidence preparation; wait for the owned agent.
      await started;
      f.engine.cancel(r.id);
      await delay(40);
      assert.equal(f.store.getRun(r.id)?.status, 'cancelled');
      assert.ok(aborted);
    } finally {
      await f.close();
    }
  },
);

void test('demo uses no provider and clearly labels simulated output', async () => {
  const f = await fixture(() => {
    throw new Error('Provider must not run');
  });
  try {
    f.workflow([definition('a'), definition('b')]);
    const r = await f.create('demo');
    const done = await f.wait(r.id, 'completed');
    assert.match(done.steps[0].output, /Demo output/);
    assert.equal(done.steps[0].costUsd, null);
  } finally {
    await f.close();
  }
});

void test('running records recover as interrupted; waiting approvals survive restart', async () => {
  const f = await fixture(success);
  try {
    f.workflow([definition('a', true)]);
    const r = await f.create();
    await f.wait(r.id, 'waiting_approval');
    await f.engine.shutdown();
    const active = f.store.getRun(r.id);
    assert.ok(active);
    const interrupted = structuredClone(active);
    interrupted.id = 'interrupted-run';
    interrupted.status = 'running';
    interrupted.steps[0].status = 'running';
    f.store.saveRun(interrupted);
    const restarted = new Engine(f.store, f.config, success);
    assert.equal(f.store.getRun(r.id)?.status, 'waiting_approval');
    assert.equal(f.store.getRun('interrupted-run')?.status, 'interrupted');
    await restarted.shutdown();
  } finally {
    await f.close();
  }
});

void test('at most two runs execute and cancelled queued work never starts', async () => {
  let active = 0,
    max = 0;
  const f = await fixture(async () => {
    active++;
    max = Math.max(max, active);
    await delay(100);
    active--;
    return { output: 'done', sessionId: null, costUsd: null };
  });
  try {
    f.workflow([definition('a')]);
    const a = await f.create(),
      b = await f.create(),
      c = await f.create();
    f.engine.cancel(c.id);
    await f.wait(a.id, 'completed');
    await f.wait(b.id, 'completed');
    assert.ok(max <= 2);
    assert.equal(f.store.getRun(c.id)?.steps[0].attempt, 0);
  } finally {
    await f.close();
  }
});

void test('a BLOCKED final after progress messages still requires revision', async () => {
  const f = await fixture(() =>
    Promise.resolve({
      output:
        'I will inspect the workspace.\n\nBLOCKED: Missing acceptance decision.',
      sessionId: null,
      costUsd: null,
    }),
  );
  try {
    f.workflow([definition('review', true)]);
    const r = await f.create();
    await f.wait(r.id, 'blocked');
    assert.throws(() => f.engine.approve(r.id));
  } finally {
    await f.close();
  }
});

for (const provider of ['claude', 'codex', 'opencode'] as const) {
  void test(`planning conversation with ${provider} preserves context and requires explicit approval`, async () => {
    const prompts: string[] = [];
    const calls: StepDefinition[] = [];
    const f = await fixture((s, p) => {
      calls.push(s);
      prompts.push(p);
      return Promise.resolve({
        output:
          s.id === 'build'
            ? 'Verified plan'
            : calls.length === 1
              ? 'Who is the audience?\nPLAN_QUESTIONS'
              : 'Plan: local developers, offline, keyboard accessible.\nPLAN_READY',
        sessionId: null,
        costUsd: null,
      });
    });
    try {
      f.workflow([
        { ...definition('plan'), provider, planning: true },
        definition('build'),
      ]);
      const run = await f.create();
      const question = await f.wait(run.id, 'waiting_input');
      assert.equal(calls[0].access, 'read-only');
      assert.equal(question.steps[0].definition.approval, true);
      assert.throws(() => f.engine.approve(run.id));
      assert.equal(question.steps[1].attempt, 0);
      const id = '11111111-1111-4111-8111-111111111111';
      f.engine.chat(run.id, 'plan', 'Local developers, offline.', id);
      f.engine.chat(run.id, 'plan', 'Local developers, offline.', id);
      assert.throws(() => f.engine.chat(run.id, 'plan', 'Changed', id));
      assert.throws(() => f.engine.chat(run.id, 'plan', 'While busy', 'busy'));
      const ready = await f.wait(run.id, 'waiting_approval');
      assert.equal(ready.steps[0].conversation?.length, 4);
      assert.equal(calls.length, 2);
      assert.match(prompts[1], /Who is the audience/);
      assert.match(prompts[1], /Local developers, offline/);
      assert.doesNotMatch(ready.steps[0].output, /PLAN_READY/);
      assert.equal(ready.steps[1].attempt, 0);
      f.engine.chat(run.id, 'plan', 'Also keyboard accessible.', 'second');
      assert.throws(() => f.engine.approve(run.id));
      await f.wait(run.id, 'waiting_approval');
      assert.match(prompts[2], /Local developers, offline/);
      assert.match(prompts[2], /keyboard accessible/);
      f.engine.approve(run.id);
      const done = await f.wait(run.id, 'completed');
      assert.match(
        prompts[3],
        /Plan: local developers, offline, keyboard accessible/,
      );
      assert.equal(done.steps[0].conversation?.length, 6);
      f.engine.chat(run.id, 'plan', 'Refine the approved plan', 'late');
      const reopened = await f.wait(run.id, 'waiting_approval');
      assert.equal(reopened.currentStep, 0);
      assert.equal(reopened.steps[1].status, 'pending');
    } finally {
      await f.close();
    }
  });
}

void test('planning history survives reopening storage and provider failure retries without duplicate messages', async () => {
  let calls = 0;
  const execute: ExecuteAgent = () => {
    calls++;
    if (calls === 2) throw new Error('Provider unavailable');
    return Promise.resolve({
      output:
        calls === 1
          ? 'Which audience?'
          : 'Agreed audience: developers.\nPLAN_READY',
      sessionId: null,
      costUsd: null,
    });
  };
  const f = await fixture(execute);
  let reopened: Store | undefined;
  let restarted: Engine | undefined;
  try {
    f.workflow([{ ...definition('plan'), planning: true }]);
    const run = await f.create();
    await f.wait(run.id, 'waiting_input');
    await f.engine.shutdown();
    f.store.close();
    reopened = new Store(f.config.dataDir);
    restarted = new Engine(reopened, f.config, execute);
    assert.equal(reopened.getRun(run.id)?.status, 'waiting_input');
    assert.equal(reopened.getRun(run.id)?.steps[0].conversation?.length, 2);
    restarted.chat(run.id, 'plan', 'Developers', 'answer');
    for (
      let i = 0;
      i < 100 && reopened.getRun(run.id)?.status !== 'failed';
      i++
    )
      await delay(20);
    assert.equal(reopened.getRun(run.id)?.status, 'failed');
    restarted.retry(run.id);
    for (
      let i = 0;
      i < 100 && reopened.getRun(run.id)?.status !== 'waiting_approval';
      i++
    )
      await delay(20);
    const ready = reopened.getRun(run.id);
    assert.ok(ready);
    assert.equal(ready.status, 'waiting_approval');
    const readyConversation = ready.steps[0].conversation;
    assert.ok(readyConversation);
    assert.equal(readyConversation.filter((m) => m.id === 'answer').length, 1);
    assert.equal(readyConversation.length, 4);
  } finally {
    await restarted?.shutdown();
    reopened?.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

void test('planning rejects invalid and oversized turns without changing saved conversation', async () => {
  const f = await fixture(() =>
    Promise.resolve({
      output: 'Which constraints?\nPLAN_QUESTIONS',
      sessionId: null,
      costUsd: null,
    }),
  );
  try {
    f.workflow([{ ...definition('plan'), planning: true }]);
    const run = await f.create();
    const waiting = await f.wait(run.id, 'waiting_input');
    for (const content of [' ', 'x'.repeat(8001)])
      assert.throws(() => f.engine.chat(run.id, 'plan', content, 'bad'));
    assert.throws(() => f.engine.chat(run.id, 'missing', 'Hello', 'wrong'));
    const conversation = waiting.steps[0].conversation;
    assert.ok(conversation);
    conversation.push({
      id: 'large',
      role: 'assistant',
      content: 'x'.repeat(79000),
      createdAt: waiting.createdAt,
    });
    f.store.saveRun(waiting);
    assert.throws(
      () => f.engine.chat(run.id, 'plan', 'x'.repeat(2000), 'overflow'),
      /too long/,
    );
    assert.equal(f.store.getRun(run.id)?.steps[0].conversation?.length, 3);
    f.engine.cancel(run.id);
    assert.throws(() => f.engine.chat(run.id, 'plan', 'Hello', 'cancelled'));
  } finally {
    await f.close();
  }
});

void test('empty planning response fails instead of exposing approval', async () => {
  const f = await fixture(() =>
    Promise.resolve({
      output: 'PLAN_READY',
      sessionId: null,
      costUsd: null,
    }),
  );
  try {
    f.workflow([{ ...definition('plan'), planning: true }]);
    const r = await f.create();
    await f.wait(r.id, 'failed');
    assert.throws(() => f.engine.approve(r.id));
  } finally {
    await f.close();
  }
});

void test('oversized downstream context fails before losing approved planning requirements', async () => {
  let calls = 0;
  const f = await fixture(() => {
    calls++;
    return Promise.resolve({
      output: 'Agreed constraints.\nPLAN_READY',
      sessionId: null,
      costUsd: null,
    });
  });
  try {
    f.workflow([
      { ...definition('plan'), planning: true },
      { ...definition('build'), instructions: 'x'.repeat(120000) },
    ]);
    const r = await f.create();
    await f.wait(r.id, 'waiting_approval');
    f.engine.approve(r.id);
    const failed = await f.wait(r.id, 'failed');
    assert.match(failed.error ?? '', /Approved planning context is too long/);
    assert.equal(calls, 1);
  } finally {
    await f.close();
  }
});

void test('ask_user persists question cards and cannot be overridden by PLAN_READY', async () => {
  let calls = 0;
  const f = await fixture((_s, p, _w, _sig, event) => {
    calls++;
    if (calls === 1) {
      event({ type: 'output', message: 'Let me clarify.' });
      event({
        type: 'ask',
        message: 'Question',
        questions: [
          { question: 'Who is it for?', options: ['Developers', 'Players'] },
        ],
      });
      return Promise.resolve({
        output: 'Guessed plan.\nPLAN_READY',
        sessionId: null,
        costUsd: null,
      });
    }
    assert.match(p, /Developers/);
    assert.match(p, /Who is it for/);
    return Promise.resolve({
      output: 'Plan for developers.\nPLAN_READY',
      sessionId: null,
      costUsd: null,
    });
  });
  try {
    f.workflow([
      { ...definition('plan'), planning: true },
      definition('build'),
    ]);
    const r = await f.create();
    const ask = await f.wait(r.id, 'waiting_input');
    assert.ok(ask.steps[0].pendingAskId);
    assert.equal(
      ask.steps[0].conversation?.at(-1)?.questions?.[0].options?.[0],
      'Developers',
    );
    assert.throws(() => f.engine.approve(r.id));
    assert.equal(ask.steps[1].attempt, 0);
    f.engine.chat(r.id, 'plan', 'Developers', 'answer');
    const ready = await f.wait(r.id, 'waiting_approval');
    assert.equal(ready.steps[0].pendingAskId, undefined);
    const readyConversation = ready.steps[0].conversation;
    assert.ok(readyConversation);
    assert.equal(readyConversation.length, 5);
    assert.equal(readyConversation[1].content, 'Let me clarify.');
  } finally {
    await f.close();
  }
});

void test('question cards survive a provider failure and restart before final output', async () => {
  const f = await fixture((_s, _p, _w, _sig, event) => {
    event({
      type: 'ask',
      message: 'Question',
      questions: [{ question: 'Which scope?' }],
    });
    throw Error('Provider stopped');
  });
  try {
    f.workflow([{ ...definition('plan'), planning: true }]);
    const r = await f.create();
    const ask = await f.wait(r.id, 'waiting_input');
    await f.engine.shutdown();
    ask.status = 'running';
    ask.steps[0].status = 'running';
    f.store.saveRun(ask);
    const restarted = new Engine(f.store, f.config, success);
    assert.equal(f.store.getRun(r.id)?.status, 'waiting_input');
    assert.ok(f.store.getRun(r.id)?.steps[0].pendingAskId);
    await restarted.shutdown();
  } finally {
    await f.close();
  }
});

void test('review rework preserves attempts, reruns validation, and gates fresh review across repeated loops', async () => {
  const calls: string[] = [];
  const prompts: string[] = [];
  let reviews = 0;
  const f = await fixture(async (s, p, w) => {
    calls.push(s.id);
    prompts.push(p);
    if (s.id === 'build')
      await writeFile(
        path.join(w, 'fix.txt'),
        String(calls.filter((x) => x === 'build').length),
      );
    return {
      output:
        s.id === 'review'
          ? ++reviews < 3
            ? 'BLOCKED: fix the keyboard handler'
            : 'Verified keyboard handler and tests'
          : `${s.id} evidence`,
      sessionId: null,
      costUsd: null,
    };
  });
  try {
    f.workflow([
      definition('build', true),
      { ...definition('validate'), access: 'read-only' },
      { ...definition('review'), access: 'read-only', role: 'reviewer' },
    ]);
    const created = await f.create();
    await f.wait(created.id, 'waiting_approval');
    f.engine.approve(created.id);
    const initial = await f.wait(created.id, 'blocked');
    for (let round = 1; round <= 2; round++) {
      f.engine.rework(created.id);
      assert.throws(() => f.engine.rework(created.id));
      let run = await f.wait(created.id, 'waiting_approval');
      assert.equal(run.currentStep, 0);
      assert.equal(run.steps[2].status, 'pending');
      assert.equal(run.steps[2].history?.length, round);
      assert.match(run.steps[2].history[round - 1].output, /BLOCKED/);
      assert.equal(run.workspace, initial.workspace);
      assert.equal(
        await readFile(path.join(run.workspace, 'fix.txt'), 'utf8'),
        String(round + 1),
      );
      const lastPrompt = prompts.at(-1);
      assert.ok(lastPrompt);
      assert.match(lastPrompt, /Review findings from review/);
      assert.match(
        lastPrompt,
        /Make no scope, design or architecture decisions/,
      );
      f.engine.approve(created.id);
      run = await f.wait(
        created.id,
        round === 1 ? 'blocked' : 'waiting_approval',
      );
      assert.equal(run.currentStep, 2);
    }
    assert.deepEqual(calls, [
      'build',
      'validate',
      'review',
      'build',
      'validate',
      'review',
      'build',
      'validate',
      'review',
    ]);
    f.engine.approve(created.id);
    await f.wait(created.id, 'completed');
    assert.throws(() => f.engine.rework(created.id));
    const reopened = new Store(f.config.dataDir);
    try {
      const saved = reopened.getRun(created.id);
      assert.ok(saved);
      assert.equal(saved.steps[2].history?.length, 2);
    } finally {
      reopened.close();
    }
  } finally {
    await f.close();
  }
});

void test('review rework rejects read-only workflows and implementation blockers', async () => {
  const f = await fixture(() =>
    Promise.resolve({
      output: 'BLOCKED: missing requirements',
      sessionId: null,
      costUsd: null,
    }),
  );
  try {
    f.workflow([{ ...definition('inspect'), access: 'read-only' }]);
    let run = await f.create();
    await f.wait(run.id, 'blocked');
    assert.throws(() => f.engine.rework(run.id));
    f.workflow([definition('build')]);
    run = await f.create();
    await f.wait(run.id, 'blocked');
    assert.throws(() => f.engine.rework(run.id));
  } finally {
    await f.close();
  }
});

void test('every step supports idempotent follow-ups, gates completion, and invalidates downstream approvals', async () => {
  const prompts: string[] = [];
  const f = await fixture(async (s, p, ...rest) => {
    prompts.push(p);
    return success(s, p, ...rest);
  });
  try {
    f.workflow([
      definition('build', true),
      { ...definition('review', true), access: 'read-only' },
    ]);
    const r = await f.create();
    await f.wait(r.id, 'waiting_approval');
    f.engine.chat(r.id, 'build', 'Add a regression test.', 'followup');
    f.engine.chat(r.id, 'build', 'Add a regression test.', 'followup');
    let run = await f.wait(r.id, 'waiting_approval');
    assert.equal(
      run.steps[0].conversation?.filter((m) => m.id === 'followup').length,
      1,
    );
    assert.match(prompts[1], /Add a regression test/);
    assert.equal(run.steps[1].attempt, 0);
    f.engine.approve(r.id);
    await f.wait(r.id, 'waiting_approval');
    f.engine.chat(
      r.id,
      'review',
      'Explain the validation evidence.',
      'review-chat',
    );
    run = await f.wait(r.id, 'waiting_approval');
    const chatPrompt = prompts.at(-1);
    assert.ok(chatPrompt);
    assert.match(chatPrompt, /Explain the validation evidence/);
    f.engine.approve(r.id);
    await f.wait(r.id, 'completed');
    f.engine.chat(r.id, 'build', 'Cover the empty case too.', 'reopen');
    run = await f.wait(r.id, 'waiting_approval');
    assert.equal(run.currentStep, 0);
    assert.equal(run.steps[1].status, 'pending');
    assert.ok(
      run.steps[1].history?.[0].conversation?.some(
        (m) => m.id === 'review-chat',
      ),
    );
    assert.equal(run.steps[1].conversation, undefined);
    assert.throws(() =>
      f.engine.chat(r.id, 'review', 'Not started', 'pending'),
    );
    const reopenedPrompt = prompts.at(-1);
    assert.ok(reopenedPrompt);
    assert.match(reopenedPrompt, /Add a regression test/);
    assert.match(reopenedPrompt, /Cover the empty case/);
  } finally {
    await f.close();
  }
});
