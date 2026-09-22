import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig, Run } from '../shared/types.js';
import { newCrate } from '../shared/crates.js';
import { joinCrateWorktrees, readCratePr } from './git-workspaces.js';

type CrateRun = Run & { crate: NonNullable<Run['crate']> };

function isCrateRun(run: Run | undefined): run is CrateRun {
  return Boolean(run?.crate);
}

export function registerCrates(
  app: FastifyInstance,
  config: AppConfig,
  readPr = readCratePr,
) {
  const busy = new Set<string>(),
    jobs = new Set<Promise<unknown>>();
  let closed = false;
  for (const run of app.store.listRuns())
    if (run.crate?.joining) {
      run.crate.joining = false;
      app.store.saveRun(run);
    }
  async function locked<T>(id: string, fn: () => Promise<T>): Promise<T> {
    if (busy.has(id)) throw Error('A crate operation is already in progress.');
    busy.add(id);
    try {
      return await fn();
    } finally {
      busy.delete(id);
    }
  }
  const requireRun = (id: string) => {
    const run = app.store.getRun(id);
    if (!run) throw Error('Crate not found.');
    return run;
  };
  const requireCrateRun = (id: string) => {
    const run = app.store.getRun(id);
    if (!isCrateRun(run)) throw Error('Crate not found.');
    return run;
  };
  async function sync(id: string) {
    return locked(id, async () => {
      const initial = requireRun(id);
      if (!initial.crate || !initial.git?.prUrl)
        throw Error('This crate has no published PR.');
      const snapshot = await readPr(initial);
      if (closed) return initial;
      const run = requireCrateRun(id);
      const crate = run.crate;
      crate.prHead = snapshot.head;
      crate.prState = snapshot.state;
      crate.syncedAt = new Date().toISOString();
      delete crate.syncError;
      const ids = new Set(snapshot.events.map((e) => e.id));
      for (const event of crate.feedback)
        if (
          event.state === 'pending' &&
          (!ids.has(event.id) || event.head !== snapshot.head)
        )
          event.state = 'dismissed';
      for (const event of snapshot.events)
        if (!crate.feedback.some((e) => e.id === event.id))
          crate.feedback.push({
            ...event,
            state: event.head === snapshot.head ? 'pending' : 'dismissed',
          });
      app.store.saveRun(run);
      return run;
    });
  }
  // Explicit endpoints keep actions reviewable and reject unknown input.
  app.post<{ Params: { id: string } }>(
    '/api/runs/:id/crate-enable',
    async (request, reply) => {
      if (!z.strictObject({}).safeParse(request.body ?? {}).success)
        return reply.code(400).send({ error: 'Expected an empty body.' });
      try {
        const run = requireRun(request.params.id);
        run.crate ??= {
          ...newCrate(),
          allowSplit:
            app.store.getWorkflow(run.workflowId)?.allowSplit ?? false,
        };
        app.store.saveRun(run);
        return run;
      } catch (e) {
        return reply.code(409).send({ error: (e as Error).message });
      }
    },
  );
  app.post<{ Params: { id: string } }>(
    '/api/runs/:id/crate-split',
    async (request, reply) => {
      const body = z
        .strictObject({
          children: z
            .array(
              z.strictObject({
                title: z.string().trim().min(1).max(120),
                task: z.string().trim().min(1).max(4000),
              }),
            )
            .min(2)
            .max(4),
        })
        .safeParse(request.body);
      if (!body.success)
        return reply.code(400).send({
          error: 'Provide two to four child crates with a title and scope.',
        });
      try {
        return app.engine.splitCrate(request.params.id, body.data.children);
      } catch (e) {
        return reply.code(409).send({ error: (e as Error).message });
      }
    },
  );
  app.post<{ Params: { id: string } }>(
    '/api/runs/:id/crate-join',
    async (request, reply) => {
      if (!z.strictObject({}).safeParse(request.body ?? {}).success)
        return reply.code(400).send({ error: 'Expected an empty body.' });
      try {
        return await locked(request.params.id, async () => {
          const parent = requireRun(request.params.id);
          if (
            parent.crate?.join !== 'waiting' ||
            !parent.crate.childIds.length ||
            parent.status !== 'waiting_input'
          )
            throw Error('This parent is not waiting to join children.');
          const children = parent.crate.childIds.map(requireRun);
          if (
            children.some(
              (c) =>
                c.crate?.parentId !== parent.id || c.status !== 'completed',
            )
          )
            throw Error(
              'Every required child must be completed and approved before joining.',
            );
          parent.crate.joining = true;
          app.store.saveRun(parent);
          try {
            for (const child of children)
              await app.engine.assertValidationCurrent(child.id);
            if (parent.mode === 'live')
              await joinCrateWorktrees(parent, children, config);
            const latest = requireCrateRun(parent.id);
            latest.crate.join = 'joined';
            latest.crate.joining = false;
            const next = latest.steps.at(latest.currentStep);
            if (next)
              next.feedback =
                'The approved child results have been integrated into this workspace. Inspect the combined result, complete only remaining parent requirements, and validate integration.\n' +
                children
                  .map((c) => `${c.title}: ${c.steps.at(-1)?.output ?? ''}`)
                  .join('\n')
                  .slice(0, 30000);
            app.store.saveRun(latest);
            app.store.addEvent(
              parent.id,
              null,
              'status',
              'Child crates joined. Continuing the parent through integration, validation and independent review.',
            );
            return app.engine.resumeJoinedCrate(parent.id);
          } finally {
            const latest = requireCrateRun(parent.id);
            latest.crate.joining = false;
            app.store.saveRun(latest);
          }
        });
      } catch (e) {
        return reply.code(409).send({ error: (e as Error).message });
      }
    },
  );
  app.post<{ Params: { id: string } }>(
    '/api/runs/:id/crate-triage',
    async (request, reply) => {
      const body = z
        .strictObject({
          action: z.enum(['approve', 'repair', 'clarify', 'dismiss']),
          reason: z.string().trim().min(1).max(4000),
          eventId: z.string().max(200).optional(),
        })
        .safeParse(request.body);
      if (!body.success)
        return reply
          .code(400)
          .send({ error: 'Choose a triage action and record a reason.' });
      try {
        return await locked(request.params.id, async () => {
          const { action, reason, eventId } = body.data;
          if (!eventId) {
            if (action === 'dismiss')
              throw Error('Only PR events can be dismissed.');
            return app.engine.triage(request.params.id, action, reason);
          }
          const run = requireRun(request.params.id),
            event = run.crate?.feedback.find((e) => e.id === eventId);
          if (
            !event ||
            event.state !== 'pending' ||
            event.head !== run.crate?.prHead
          )
            throw Error('This feedback has already been handled or is stale.');
          if (action !== 'repair' && action !== 'dismiss')
            throw Error(
              'Route the feedback to repair or dismiss it with a reason.',
            );
          if (action === 'repair') {
            const fresh = await readPr(run);
            const latest = requireRun(run.id);
            if (
              fresh.state !== 'OPEN' ||
              fresh.head !== event.head ||
              fresh.head !== latest.git?.publishedCommit ||
              !fresh.events.some((e) => e.id === event.id)
            )
              throw Error(
                'The PR changed. Refresh its feedback before routing a repair.',
              );
            app.engine.repairPr(
              run.id,
              `${event.summary}\n\nTriage: ${reason}`,
            );
          }
          const latest = requireCrateRun(run.id);
          const feedback = latest.crate.feedback.find((e) => e.id === event.id);
          if (!feedback)
            throw Error('This feedback has already been handled or is stale.');
          feedback.state = action === 'repair' ? 'repair' : 'dismissed';
          latest.crate.triage.push({
            key: eventId,
            action,
            reason,
            at: new Date().toISOString(),
          });
          app.store.saveRun(latest);
          return latest;
        });
      } catch (e) {
        return reply.code(409).send({ error: (e as Error).message });
      }
    },
  );
  app.post<{ Params: { id: string } }>(
    '/api/runs/:id/crate-sync',
    async (request, reply) => {
      if (!z.strictObject({}).safeParse(request.body ?? {}).success)
        return reply.code(400).send({ error: 'Expected an empty body.' });
      try {
        return await sync(request.params.id);
      } catch (e) {
        return reply.code(409).send({ error: (e as Error).message });
      }
    },
  );
  const timer = setInterval(() => {
    if (closed) return;
    for (const run of app.store
      .listRuns()
      .filter(
        (r) =>
          r.crate &&
          r.git?.prUrl &&
          r.crate.prState !== 'MERGED' &&
          r.crate.prState !== 'CLOSED',
      )
      .sort((a, b) =>
        (a.crate?.syncedAt ?? '').localeCompare(b.crate?.syncedAt ?? ''),
      )
      .slice(0, 20)) {
      if (busy.has(run.id)) continue;
      const job = sync(run.id)
        .catch((error: unknown) => {
          if (!closed) {
            const current = requireCrateRun(run.id);
            current.crate.syncError =
              error instanceof Error ? error.message : String(error);
            current.crate.syncedAt = new Date().toISOString();
            app.store.saveRun(current);
          }
        })
        .finally(() => jobs.delete(job));
      jobs.add(job);
    }
  }, 60000);
  timer.unref();
  return async () => {
    closed = true;
    clearInterval(timer);
    await Promise.allSettled(jobs);
  };
}
