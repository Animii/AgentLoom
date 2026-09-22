import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppFixture } from './helpers/app-fixture.js';

void test('workflow archive preserves runs, survives restart, blocks new runs and restores', async (t) => {
  const f = await createAppFixture(t, { options: { serveStatic: false } });
  let app = f.app;
  try {
    const run = await app.engine.create({
      title: 'Retained history',
      task: 'Demo check',
      project: 'welcome',
      workflowId: 'quick-review',
      mode: 'demo',
    });
    await f.wait(run.id, 'completed');
    assert.equal(app.store.getRun(run.id)?.status, 'completed');
    const before = app.store.getRun(run.id);
    const patch = (payload: object) =>
      app.inject({
        method: 'PATCH',
        url: '/api/workflows/quick-review',
        payload,
      });
    assert.equal((await patch({ archived: 'yes' })).statusCode, 400);
    assert.equal((await patch({ archived: true })).statusCode, 200);
    assert.deepEqual(app.store.getRun(run.id), before);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/runs',
          payload: {
            title: 'Blocked',
            task: 'x',
            project: 'welcome',
            workflowId: 'quick-review',
            mode: 'demo',
          },
        })
      ).statusCode,
      409,
    );
    const archived = app.store.getWorkflow('quick-review');
    assert.ok(archived);
    const stale = { ...archived, archived: false };
    assert.equal(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/workflows/quick-review',
          payload: stale,
        })
      ).statusCode,
      200,
    );
    assert.equal(app.store.getWorkflow('quick-review')?.archived, true);
    app = await f.restart();
    assert.equal(app.store.getWorkflow('quick-review')?.archived, true);
    assert.deepEqual(app.store.getRun(run.id), before);
    assert.equal((await patch({ archived: false })).statusCode, 200);
    assert.equal(app.store.getWorkflow('quick-review')?.archived, false);
  } finally {
    await f.close();
  }
});
