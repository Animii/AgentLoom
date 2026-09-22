import type { FastifyInstance } from 'fastify';
import type { Store } from './store.js';

export function registerRunStream(app: FastifyInstance, store: Store) {
  const connections = new Set<() => void>();
  app.addHook('preClose', () => {
    for (const close of connections) close();
  });
  app.get<{ Params: { id: string } }>(
    '/api/runs/:id/stream',
    async (request, reply) => {
      if (!store.getRun(request.params.id))
        return reply.code(404).send({ error: 'Run not found' });
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
        'X-Content-Type-Options': 'nosniff',
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      let closed = false;
      let dirty = true;
      const send = () => {
        timer = undefined;
        if (closed || reply.raw.writableNeedDrain) return;
        dirty = false;
        const run = store.getRun(request.params.id);
        // Full snapshots make reconnects and final-text corrections idempotent.
        if (run)
          reply.raw.write(`event: run\ndata: ${JSON.stringify(run)}\n\n`);
      };
      const unsubscribe = store.subscribe(request.params.id, () => {
        dirty = true;
        timer ??= setTimeout(send, 50);
      });
      reply.raw.on('drain', () => {
        if (dirty) send();
      });
      const heartbeat = setInterval(() => {
        if (!reply.raw.writableNeedDrain) reply.raw.write(': heartbeat\n\n');
      }, 15000);
      const close = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        clearInterval(heartbeat);
        if (timer) clearTimeout(timer);
        connections.delete(close);
        reply.raw.end();
      };
      connections.add(close);
      reply.raw.on('close', close);
      send();
    },
  );
}
