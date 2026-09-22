import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import type { Repository } from '../../src/server/ports/repository.js';
import type { Run } from '../../src/shared/types.js';

export function repositoryRun(
  id: string,
  createdAt = '2026-01-01T00:00:00.000Z',
): Run {
  return {
    id,
    title: id,
    task: 'Approved task',
    project: 'sample',
    workflowId: 'contract',
    workflowName: 'Contract',
    mode: 'live',
    status: 'queued',
    steps: [],
    currentStep: 0,
    createdAt,
    updatedAt: createdAt,
    workspace: '',
    error: null,
  };
}

/** Adapter factories register cleanup with t.after before returning the repository. */
export async function repositoryContract(
  t: TestContext,
  create: (t: TestContext) => Repository | Promise<Repository>,
): Promise<void> {
  await t.test(
    'run writes and reads are detached and updates preserve insertion ordering',
    async (t) => {
      const store = await create(t);
      const first = repositoryRun('a');
      store.saveRun(first);
      first.title = 'unsaved';
      store.saveRun(repositoryRun('b'));
      const loaded = store.getRun('a');
      assert.ok(loaded);
      assert.equal(loaded.title, 'a');
      loaded.title = 'edited';
      assert.equal(store.getRun('a')?.title, 'a');
      store.saveRun(loaded);
      assert.equal(store.getRun('a')?.title, 'edited');
      assert.deepEqual(
        store.listRuns().map((run) => run.id),
        ['b', 'a'],
      );
      const listed = store.listRuns();
      const item = listed[0];
      assert.ok(item);
      item.task = 'unsaved';
      assert.equal(store.getRun('b')?.task, 'Approved task');
      assert.notEqual(store.getRun('a')?.updatedAt, first.updatedAt);
    },
  );

  await t.test(
    'all batch writes precede notifications, scoped subscriptions unsubscribe',
    async (t) => {
      const store = await create(t);
      const seen: string[] = [];
      const unsubscribe = store.subscribe('a', () => {
        seen.push('a');
        assert.equal(store.getRun('b')?.title, 'b');
      });
      store.subscribe('b', () => {
        seen.push('b');
      });
      store.saveRuns([repositoryRun('a'), repositoryRun('b')]);
      assert.deepEqual(seen, ['a', 'b']);
      unsubscribe();
      store.saveRun(repositoryRun('a'));
      assert.deepEqual(seen, ['a', 'b']);
      store.addEvent('b', null, 'log', 'not a run save');
      assert.deepEqual(seen, ['a', 'b']);
    },
  );

  await t.test(
    'event cursors are exclusive, ordered, scoped, capped and detached',
    async (t) => {
      const store = await create(t);
      const first = store.addEvent('a', null, 'status', 'start');
      const other = store.addEvent('b', null, 'log', 'other');
      const last = store.addEvent('a', 'build', 'output', 'x'.repeat(100_001));
      assert.ok(first.id < other.id && other.id < last.id);
      assert.equal(last.message.length, 100_000);
      last.message = 'mutated';
      assert.deepEqual(
        store.getEvents('a', first.id).map((event) => event.id),
        [last.id],
      );
      assert.equal(store.getEvents('a', first.id)[0]?.message.length, 100_000);
      const loaded = store.getEvents('a')[0];
      assert.ok(loaded);
      loaded.message = 'mutated';
      assert.equal(store.getEvents('a')[0]?.message, 'start');
    },
  );

  await t.test(
    'serialization failure rolls back the full batch without notifications',
    async (t) => {
      const store = await create(t);
      store.saveRun(repositoryRun('a'));
      const changed = repositoryRun('a');
      changed.title = 'must not commit';
      const invalid = repositoryRun('invalid');
      Object.assign(invalid, { circular: invalid });
      let notifications = 0;
      store.subscribe('a', () => {
        notifications += 1;
      });
      assert.throws(() => {
        store.saveRuns([changed, invalid]);
      });
      assert.equal(store.getRun('a')?.title, 'a');
      assert.equal(store.getRun('invalid'), undefined);
      assert.equal(notifications, 0);
    },
  );

  await t.test(
    'event pages cap at 2000 and the cursor retrieves the remainder',
    async (t) => {
      const store = await create(t);
      for (let index = 0; index < 2001; index += 1)
        store.addEvent('paged', null, 'log', String(index));
      const page = store.getEvents('paged');
      assert.equal(page.length, 2000);
      const cursor = page.at(-1);
      assert.ok(cursor);
      const remainder = store.getEvents('paged', cursor.id);
      assert.equal(remainder.length, 1);
      assert.equal(remainder[0]?.message, '2000');
    },
  );

  await t.test(
    'workflow and project values are detached and updates retain order',
    async (t) => {
      const store = await create(t);
      const workflow = {
        id: 'contract',
        name: 'Contract',
        description: '',
        steps: [],
        updatedAt: '2026-01-01T00:00:00.000Z',
      };
      store.saveWorkflow(workflow);
      workflow.name = 'unsaved';
      assert.equal(store.getWorkflow('contract')?.name, 'Contract');
      const saved = store.getWorkflow('contract');
      assert.ok(saved);
      saved.name = 'updated';
      store.saveWorkflow(saved);
      assert.equal(store.getWorkflow('contract')?.name, 'updated');
      assert.equal(store.getWorkflow('missing'), undefined);
      const project = {
        id: 'project',
        name: 'Project',
        sourcePath: '/virtual/source',
        hostPath: '/virtual/source',
        kind: 'connected' as const,
        workspaceMode: 'direct' as const,
        status: 'active' as const,
      };
      store.saveProject(project);
      project.name = 'unsaved';
      assert.equal(store.getProject(project.id)?.name, 'Project');
      const read = store
        .listProjects()
        .find((entry) => entry.id === project.id);
      assert.ok(read);
      read.name = 'unsaved again';
      assert.equal(store.getProject(project.id)?.name, 'Project');
    },
  );
}
