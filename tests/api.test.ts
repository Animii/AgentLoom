import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../src/server/app.js';
import type { ModelCatalog } from '../src/shared/model-catalog.js';
import type { Run, Workflow } from '../src/shared/types.js';
void test('HTTP workflow lifecycle, validation, snapshots, files and local-origin boundary', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'loom-api-'));
  const work = path.join(root, 'workspaces');
  await mkdir(path.join(work, 'projects/sample'), { recursive: true });
  await writeFile(path.join(work, 'projects/sample/README.md'), 'source');
  let calls = 0;
  const app = await createApp(
    {
      dataDir: path.join(root, 'data'),
      workspaceRoot: work,
      host: '127.0.0.1',
      port: 4317,
      cliTimeoutMs: 1000,
      maxOutputBytes: 10000,
    },
    {
      serveStatic: false,
      execute: async (_s, p, w) => {
        calls++;
        await writeFile(path.join(w, 'result.txt'), 'safe output');
        return {
          output: p.includes('Use blue') ? 'Revised blue' : 'Initial answer',
          sessionId: 'fixture',
          costUsd: 0.001,
        };
      },
    },
  );
  const get = (url: string) => app.inject({ method: 'GET', url });
  const post = (url: string, payload: object = {}) =>
    app.inject({ method: 'POST', url, payload });
  const wait = async (id: string, status: string) => {
    for (let i = 0; i < 200; i++) {
      const r = (await get('/api/runs/' + id)).json<Run>();
      if (r.status === status) return r;
      await delay(20);
    }
    throw new Error('Timed out ' + status);
  };
  try {
    await t.test('local origin enforcement and strict schemas', async () => {
      assert.equal((await get('/api/health')).statusCode, 200);
      assert.equal(
        (
          await app.inject({
            url: '/api/health',
            headers: { host: 'evil.example' },
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await app.inject({
            url: '/api/health',
            headers: { origin: 'https://evil.example' },
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await app.inject({
            url: '/api/health',
            headers: {
              host: 'localhost:4317',
              origin: 'http://localhost:4317',
            },
          })
        ).statusCode,
        200,
      );
      assert.equal(
        (
          await post('/api/runs', {
            title: 'x',
            task: 'x',
            project: '../../escape',
            workflowId: 'review-build',
            mode: 'demo',
          })
        ).statusCode,
        400,
      );
      assert.equal(
        (
          await post('/api/runs', {
            title: 'x',
            task: ' ',
            project: 'sample',
            workflowId: 'review-build',
            mode: 'demo',
          })
        ).statusCode,
        400,
      );
      assert.equal((await get('/api/missing')).statusCode, 404);
    });
    const template = (await get('/api/workflows')).json<Workflow[]>()[0];
    const workflow: Workflow = {
      ...template,
      id: 'api-test',
      name: 'API test',
      steps: [
        { ...template.steps[0], id: 'only', approval: true, planning: false },
      ],
    };
    await t.test(
      'workflow validation rejects unknown fields, duplicate IDs and CLI flag models',
      async () => {
        for (const bad of [
          { ...workflow, extra: true },
          { ...workflow, steps: [workflow.steps[0], workflow.steps[0]] },
          { ...workflow, steps: [{ ...workflow.steps[0], model: '--unsafe' }] },
        ])
          assert.equal(
            (
              await app.inject({
                method: 'PUT',
                url: '/api/workflows/api-test',
                payload: bad,
              })
            ).statusCode,
            400,
          );
        assert.equal(
          (
            await app.inject({
              method: 'PUT',
              url: '/api/workflows/api-test',
              payload: workflow,
            })
          ).statusCode,
          200,
        );
      },
    );
    const created = await post('/api/runs', {
      title: 'Reviewable change',
      task: 'Build only approved thing',
      project: 'sample',
      workflowId: 'api-test',
      mode: 'live',
    });
    assert.equal(created.statusCode, 201);
    const id = created.json<Run>().id;
    await t.test(
      'revision and final approval with durable activity',
      async () => {
        await wait(id, 'waiting_approval');
        assert.equal(calls, 1);
        assert.equal(
          (await post('/api/runs/' + id + '/retry')).statusCode,
          409,
        );
        assert.equal(
          (await post('/api/runs/' + id + '/revise', { feedback: 'Use blue' }))
            .statusCode,
          200,
        );
        const revised = await wait(id, 'waiting_approval');
        assert.equal(revised.steps[0].attempt, 2);
        assert.equal(revised.steps[0].output, 'Revised blue');
        assert.equal(
          (await post('/api/runs/' + id + '/approve')).statusCode,
          200,
        );
        await wait(id, 'completed');
        assert.equal(
          (await post('/api/runs/' + id + '/approve')).statusCode,
          409,
        );
        const events = (await get('/api/runs/' + id + '/events')).json<
          Array<{ type: string }>
        >();
        assert.ok(events.some((e) => e.type === 'revision'));
        assert.equal(
          (await get('/api/runs/' + id + '/events?after=-1')).statusCode,
          400,
        );
      },
    );
    await t.test('files are inspectable without path escape', async () => {
      const files = (await get('/api/runs/' + id + '/files')).json<
        Array<{ path: string }>
      >();
      assert.ok(files.some((f) => f.path === 'result.txt'));
      assert.equal(
        (await get('/api/runs/' + id + '/file?path=result.txt')).json<{
          content: string;
        }>().content,
        'safe output',
      );
      assert.equal(
        (await get('/api/runs/' + id + '/file?path=../../outside')).statusCode,
        400,
      );
    });
    await t.test('workflow edits do not mutate prior runs', async () => {
      const changed = {
        ...workflow,
        name: 'Changed',
        steps: [{ ...workflow.steps[0], name: 'Changed step' }],
      };
      await app.inject({
        method: 'PUT',
        url: '/api/workflows/api-test',
        payload: changed,
      });
      const old = (await get('/api/runs/' + id)).json<Run>();
      assert.equal(old.workflowName, 'API test');
      assert.equal(old.steps[0].definition.name, workflow.steps[0].name);
    });
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

void test('planning message API validates requests, deduplicates retries and protects approval', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'loom-chat-api-'));
  const work = path.join(root, 'workspaces');
  await mkdir(path.join(work, 'projects/sample'), { recursive: true });
  const app = await createApp(
    {
      dataDir: path.join(root, 'data'),
      workspaceRoot: work,
      host: '127.0.0.1',
      port: 4317,
      cliTimeoutMs: 1000,
      maxOutputBytes: 10000,
    },
    {
      serveStatic: false,
      execute: () =>
        Promise.resolve({
          output: 'Which users?\nPLAN_QUESTIONS',
          sessionId: null,
          costUsd: null,
        }),
    },
  );
  const post = (url: string, payload: object = {}) =>
    app.inject({ method: 'POST', url, payload });
  try {
    const created = await post('/api/runs', {
      title: 'Plan',
      task: 'Clarify scope',
      project: 'sample',
      workflowId: 'review-build',
      mode: 'live',
    });
    const id = created.json<Run>().id;
    for (let i = 0; i < 100; i++) {
      if (
        (await app.inject({ url: '/api/runs/' + id })).json<Run>().status ===
        'waiting_input'
      )
        break;
      await delay(20);
    }
    const payload = {
      stepId: 'plan',
      messageId: '11111111-1111-4111-8111-111111111111',
      message: 'Local developers',
    };
    assert.equal((await post('/api/runs/' + id + '/approve')).statusCode, 409);
    for (const bad of [
      { ...payload, message: '' },
      { ...payload, message: 'x'.repeat(8001) },
      { ...payload, messageId: 'invalid' },
      { ...payload, extra: true },
    ])
      assert.equal(
        (await post('/api/runs/' + id + '/messages', bad)).statusCode,
        400,
      );
    assert.equal(
      (await post('/api/runs/missing/messages', payload)).statusCode,
      404,
    );
    assert.equal(
      (
        await post('/api/runs/' + id + '/messages', {
          ...payload,
          stepId: 'design',
        })
      ).statusCode,
      409,
    );
    assert.equal(
      (await post('/api/runs/' + id + '/messages', payload)).statusCode,
      200,
    );
    assert.equal(
      (await post('/api/runs/' + id + '/messages', payload)).statusCode,
      200,
    );
    assert.equal(
      (
        await post('/api/runs/' + id + '/messages', {
          ...payload,
          message: 'Different',
        })
      ).statusCode,
      409,
    );
    const saved = (await app.inject({ url: '/api/runs/' + id })).json<Run>();
    assert.equal(
      saved.steps[0].conversation?.filter((m) => m.id === payload.messageId)
        .length,
      1,
    );
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

void test('model catalog API: built-in aliases, safe fallbacks, strict validation and refresh', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'loom-model-api-'));
  const calls: Array<{ provider: string; refresh: boolean }> = [];
  const discoverModels = (
    provider: 'claude' | 'codex' | 'opencode',
    refresh: boolean,
  ) => {
    calls.push({ provider, refresh });
    if (provider === 'codex')
      return Promise.reject(new Error('provider exploded'));
    return Promise.resolve({
      provider,
      status: 'discovered' as const,
      message: null,
      models: [
        {
          id: 'opencode/gpt-5.1-codex',
          label: null,
          source: 'discovered' as const,
        },
      ],
      fetchedAt: new Date().toISOString(),
    });
  };
  const app = await createApp(
    {
      dataDir: path.join(root, 'data'),
      workspaceRoot: path.join(root, 'workspaces'),
      host: '127.0.0.1',
      port: 4317,
      cliTimeoutMs: 1000,
      maxOutputBytes: 10000,
    },
    {
      serveStatic: false,
      execute: () =>
        Promise.resolve({ output: 'ok', sessionId: null, costUsd: null }),
      discoverModels,
    },
  );
  const get = (url: string, headers?: Record<string, string>) =>
    app.inject({ method: 'GET', url, ...(headers ? { headers } : {}) });
  try {
    const claude = await get('/api/providers/claude/models');
    assert.equal(claude.statusCode, 200);
    const claudeBody = claude.json<ModelCatalog>();
    assert.equal(claudeBody.status, 'builtin');
    assert.deepEqual(
      claudeBody.models.map((m) => m.id),
      ['sonnet', 'opus', 'haiku'],
    );
    assert.equal((await get('/api/providers/jev/models')).statusCode, 400);
    assert.equal(
      (
        await get('/api/providers/codex/models', {
          origin: 'https://evil.example',
        })
      ).statusCode,
      403,
    );
    const failed = await get('/api/providers/codex/models');
    assert.equal(failed.statusCode, 200);
    const failedBody = failed.json<ModelCatalog>();
    assert.equal(failedBody.status, 'failed');
    assert.deepEqual(
      failedBody.models.map((m) => m.id),
      ['gpt-5.6-sol'],
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/providers/codex/models/refresh',
          payload: { unexpected: true },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/providers/missing/models/refresh',
          payload: {},
        })
      ).statusCode,
      400,
    );
    const refresh = await app.inject({
      method: 'POST',
      url: '/api/providers/opencode/models/refresh',
      payload: {},
    });
    assert.equal(refresh.statusCode, 200);
    assert.equal(refresh.json<ModelCatalog>().status, 'discovered');
    assert.ok(
      calls.some((call) => call.provider === 'opencode' && call.refresh),
    );
    const template = (await get('/api/workflows')).json<Workflow[]>()[0];
    const workflow: Workflow = {
      ...template,
      id: 'catalog-save',
      name: 'Catalog save',
      steps: [
        {
          ...template.steps[0],
          id: 'only',
          planning: false,
          model: 'custom/model-not-in-catalog',
        },
      ],
    };
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/workflows/catalog-save',
      payload: workflow,
    });
    assert.equal(saved.statusCode, 200);
    assert.equal(
      saved.json<Workflow>().steps[0].model,
      'custom/model-not-in-catalog',
    );
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
