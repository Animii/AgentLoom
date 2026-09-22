import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ModelCatalogService } from '../src/server/model-catalog.js';
import type { AppConfig } from '../src/shared/types.js';

const CODEX_FIXTURE = `
const fs = require('node:fs');
const mode = process.env.LOOM_CATALOG_MODE || 'pages';
if (process.env.LOOM_CATALOG_COUNTER) fs.appendFileSync(process.env.LOOM_CATALOG_COUNTER, 'spawn\\n');
if (process.env.LOOM_CATALOG_PID) fs.writeFileSync(process.env.LOOM_CATALOG_PID, String(process.pid));
const write = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const pageFor = (message) => {
  const params = message.params || {};
  const cursor = typeof params.cursor === 'string' ? params.cursor : null;
  const pages = {
    null: { data: [{ model: 'gpt-6-astra', displayName: 'Astra' }, { model: 'hidden-model', displayName: 'Hidden', hidden: true }], nextCursor: 'c1' },
    c1: { data: [{ model: 'gpt-5.6-sol', displayName: 'Sol' }, { model: 'gpt-5.6-sol', displayName: 'Sol again' }, { model: 'bad\\u0000id' }, { model: '-danger' }], nextCursor: 'c2' },
    c2: { data: [{ model: 'gpt-5.5', displayName: 'GPT-5.5' }], nextCursor: null }
  };
  return pages[cursor] || { data: [], nextCursor: null };
};
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    handle(line);
  }
});
function handle(line) {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method === 'initialize') {
    if (mode === 'no-handshake') { process.exit(1); return; }
    if (mode === 'close-stdin') {
      write({ jsonrpc: '2.0', id: message.id, result: { userAgent: 'fixture' } });
      // Close through the stream that owns fd 0. Raw closeSync races libuv's
      // pipe watcher on Linux and can hang this fixture instead of exiting.
      process.stdin.destroy();
      setTimeout(() => process.exit(0), 50);
      return;
    }
    if (mode === 'unsupported-init') { write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }); return; }
    write({ jsonrpc: '2.0', id: message.id, result: { userAgent: 'fixture' } });
    return;
  }
  if (message.method === 'initialized') return;
  if (message.method !== 'model/list') return;
  if (mode === 'unsupported-list') { write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }); return; }
  if (mode === 'garbage') { process.stdout.write('not json\\n'); return; }
  if (mode === 'malformed-data') { write({ jsonrpc: '2.0', id: message.id, result: { data: 'nope' } }); return; }
  if (mode === 'hang') return;
  if (mode === 'exit-early') { process.exit(1); return; }
  if (mode === 'loop') { write({ jsonrpc: '2.0', id: message.id, result: { data: [{ model: 'loop-model', displayName: 'Loop' }], nextCursor: 'same' } }); return; }
  if (mode === 'env') { write({ jsonrpc: '2.0', id: message.id, result: { data: [{ model: 'envcheck/' + (process.env.TYPESAFE_API_KEY ? 'set' : 'unset') }], nextCursor: null } }); return; }
  const page = pageFor(message);
  const params = message.params || {};
  if (params.includeHidden !== true) page.data = page.data.filter((item) => !item.hidden);
  write({ jsonrpc: '2.0', id: message.id, result: page });
  if (mode === 'pages') write({ jsonrpc: '2.0', method: 'configWarning', params: { message: 'ignored notification' } });
}
`;

const OPENCODE_FIXTURE = `
const fs = require('node:fs');
const mode = process.env.LOOM_CATALOG_MODE || 'lines';
if (process.env.LOOM_CATALOG_COUNTER) fs.appendFileSync(process.env.LOOM_CATALOG_COUNTER, 'spawn\\n');
if (process.env.LOOM_CATALOG_PID) fs.writeFileSync(process.env.LOOM_CATALOG_PID, String(process.pid));
if (mode === 'lines') {
  process.stdout.write('\\u001b[32mopencode/gpt-5.1-codex\\u001b[0m\\n\\nopencode/gpt-5.1-codex\\n');
  process.stdout.write('  deepseek/deepseek-flash  \\n');
  process.stdout.write('-x/y\\nnot-a-model\\n');
  process.exit(0);
}
if (mode === 'hanging-lines') { process.stdout.write('opencode/gpt-5.1-codex\\n'); setInterval(() => {}, 1000); }
if (mode === 'empty') process.exit(0);
if (mode === 'noise') { process.stdout.write('No models available\\n'); process.exit(0); }
if (mode === 'nonzero') { process.stderr.write('sk-verysecretfixturevalue\\n'); process.exit(3); }
if (mode === 'secret') { process.stderr.write('Authorization: Bearer sk-verysecretfixturevalue\\n'); process.stdout.write('opencode/gpt-5.1-codex\\n'); process.exit(0); }
if (mode === 'env') { process.stdout.write('envcheck/' + (process.env.TYPESAFE_API_KEY ? 'set' : 'unset') + '\\n'); process.exit(0); }
process.exit(0);
`;

async function waitForDeath(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await delay(20);
  }
  throw new Error(`Child process ${String(pid)} was still running`);
}

void test('provider model catalogs: discovery, parsing, fallbacks and caching', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'loom-models-'));
  const counter = path.join(root, 'spawns.log');
  const pidFile = path.join(root, 'child.pid');
  const previous = {
    mode: process.env.LOOM_CATALOG_MODE,
    counter: process.env.LOOM_CATALOG_COUNTER,
    pid: process.env.LOOM_CATALOG_PID,
    key: process.env.TYPESAFE_API_KEY,
  };
  await writeFile(path.join(root, 'app-server'), CODEX_FIXTURE);
  await writeFile(path.join(root, 'models'), OPENCODE_FIXTURE);
  process.env.LOOM_CATALOG_COUNTER = counter;
  process.env.LOOM_CATALOG_PID = pidFile;
  process.env.TYPESAFE_API_KEY = 'fixture-jev-secret';

  const config = (
    binaries?: Partial<Record<'codex' | 'opencode', string>>,
  ): AppConfig => ({
    dataDir: root,
    workspaceRoot: root,
    host: '127.0.0.1',
    port: 4317,
    cliTimeoutMs: 5000,
    maxOutputBytes: 100000,
    binaries: binaries ?? {
      codex: process.execPath,
      opencode: process.execPath,
    },
  });

  const withMode = async <T>(
    mode: string,
    run: () => Promise<T>,
  ): Promise<T> => {
    process.env.LOOM_CATALOG_MODE = mode;
    try {
      return await run();
    } finally {
      if (previous.mode === undefined) delete process.env.LOOM_CATALOG_MODE;
      else process.env.LOOM_CATALOG_MODE = previous.mode;
    }
  };

  const spawnCount = async (): Promise<number> => {
    try {
      const text = (await readFile(counter, 'utf8')).trim();
      return text.length === 0 ? 0 : text.split('\n').length;
    } catch {
      return 0;
    }
  };

  const resetCounter = (): Promise<void> => rm(counter, { force: true });

  try {
    await t.test(
      'Codex paginates, skips notifications, hidden models, duplicates and invalid ids',
      async () => {
        await resetCounter();
        const service = new ModelCatalogService(config(), {
          codexTimeoutMs: 3000,
        });
        const catalog = await withMode('pages', () => service.get('codex'));
        assert.equal(catalog.status, 'discovered');
        assert.equal(catalog.message, null);
        assert.deepEqual(
          catalog.models.map((model) => model.id),
          ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.5'],
        );
        assert.deepEqual(
          catalog.models.map((model) => model.label),
          ['Astra', 'Sol', 'GPT-5.5'],
        );
        assert.ok(
          catalog.models.every((model) => model.source === 'discovered'),
        );
        assert.equal(await spawnCount(), 1);
        service.close();
      },
    );

    await t.test(
      'Codex keeps collected models when a cursor repeats',
      async () => {
        const service = new ModelCatalogService(config(), {
          codexTimeoutMs: 3000,
        });
        const catalog = await withMode('loop', () => service.get('codex'));
        assert.equal(catalog.status, 'discovered');
        assert.deepEqual(
          catalog.models.map((model) => model.id),
          ['loop-model'],
        );
        service.close();
      },
    );

    await t.test(
      'Codex JSON-RPC errors are unsupported and non-array data is malformed',
      async () => {
        const service = new ModelCatalogService(config(), {
          codexTimeoutMs: 3000,
        });
        const unsupportedInit = await withMode('unsupported-init', () =>
          service.get('codex', true),
        );
        assert.equal(unsupportedInit.status, 'unsupported');
        assert.deepEqual(
          unsupportedInit.models.map((model) => model.id),
          ['gpt-5.6-sol'],
        );
        const unsupportedList = await withMode('unsupported-list', () =>
          service.get('codex', true),
        );
        assert.equal(unsupportedList.status, 'unsupported');
        const garbage = await withMode('garbage', () =>
          service.get('codex', true),
        );
        assert.equal(garbage.status, 'malformed');
        const malformedData = await withMode('malformed-data', () =>
          service.get('codex', true),
        );
        assert.equal(malformedData.status, 'malformed');
        service.close();
      },
    );

    await t.test(
      'Codex exits before the handshake is unsupported and an unusable non-zero exit is failed',
      async () => {
        const service = new ModelCatalogService(config(), {
          codexTimeoutMs: 3000,
        });
        const noHandshake = await withMode('no-handshake', () =>
          service.get('codex', true),
        );
        assert.equal(noHandshake.status, 'unsupported');
        const early = await withMode('exit-early', () =>
          service.get('codex', true),
        );
        assert.equal(early.status, 'failed');
        service.close();
      },
    );

    await t.test(
      'a provider that exits before reading further input returns a fallback instead of crashing',
      async () => {
        const service = new ModelCatalogService(config(), {
          codexTimeoutMs: 3000,
        });
        const catalog = await withMode('close-stdin', () =>
          service.get('codex', true),
        );
        assert.equal(catalog.status, 'failed');
        assert.deepEqual(
          catalog.models.map((model) => model.id),
          ['gpt-5.6-sol'],
        );
        service.close();
      },
    );

    await t.test(
      'a missing binary falls back to built-in suggestions',
      async () => {
        const missing = path.join(root, 'missing-codex-bin');
        const service = new ModelCatalogService(
          config({ codex: missing, opencode: process.execPath }),
          { codexTimeoutMs: 3000 },
        );
        const catalog = await service.get('codex');
        assert.equal(catalog.status, 'missing');
        assert.deepEqual(
          catalog.models.map((model) => model.id),
          ['gpt-5.6-sol'],
        );
        service.close();
      },
    );

    await t.test('a hang times out and the child is killed', async () => {
      await rm(pidFile, { force: true });
      const service = new ModelCatalogService(config(), {
        codexTimeoutMs: 300,
      });
      const catalog = await withMode('hang', () => service.get('codex'));
      assert.equal(catalog.status, 'timeout');
      const pid = Number((await readFile(pidFile, 'utf8')).trim());
      assert.ok(Number.isInteger(pid) && pid > 0);
      await waitForDeath(pid);
      service.close();
    });

    await t.test(
      'OpenCode preserves provider prefixes, strips ANSI, drops invalid and duplicate lines',
      async () => {
        const service = new ModelCatalogService(config(), {
          opencodeTimeoutMs: 3000,
        });
        const catalog = await withMode('lines', () => service.get('opencode'));
        assert.equal(catalog.status, 'discovered');
        assert.deepEqual(
          catalog.models.map((model) => model.id),
          ['opencode/gpt-5.1-codex', 'deepseek/deepseek-flash'],
        );
        assert.ok(catalog.models.every((model) => model.label === null));
        service.close();
      },
    );

    await t.test(
      'OpenCode distinguishes empty, unusable and failed output',
      async () => {
        const service = new ModelCatalogService(config(), {
          opencodeTimeoutMs: 3000,
        });
        const empty = await withMode('empty', () => service.get('opencode'));
        assert.equal(empty.status, 'empty');
        assert.deepEqual(
          empty.models.map((model) => model.id),
          ['opencode/gpt-5.1-codex'],
        );
        const noise = await withMode('noise', () =>
          service.get('opencode', true),
        );
        assert.equal(noise.status, 'malformed');
        const failed = await withMode('nonzero', () =>
          service.get('opencode', true),
        );
        assert.equal(failed.status, 'failed');
        assert.ok(!JSON.stringify(failed).includes('sk-verysecret'));
        service.close();
      },
    );

    await t.test(
      'provider diagnostics and secrets never reach the catalog or the logs',
      async () => {
        const warnings: Array<{ provider: string; status: string }> = [];
        const service = new ModelCatalogService(config(), {
          opencodeTimeoutMs: 3000,
          warn: (provider, status) => warnings.push({ provider, status }),
        });
        const catalog = await withMode('secret', () => service.get('opencode'));
        assert.equal(catalog.status, 'discovered');
        assert.ok(!JSON.stringify(catalog).includes('sk-verysecret'));
        assert.ok(!JSON.stringify(warnings).includes('sk-verysecret'));
        const failed = await withMode('nonzero', () =>
          service.get('opencode', true),
        );
        assert.equal(failed.status, 'failed');
        assert.ok(!JSON.stringify(failed).includes('sk-verysecret'));
        assert.ok(!JSON.stringify(warnings).includes('sk-verysecret'));
        service.close();
      },
    );

    await t.test(
      'discovery children do not inherit the Jev integration key',
      async () => {
        const service = new ModelCatalogService(config(), {
          codexTimeoutMs: 3000,
        });
        const catalog = await withMode('env', () => service.get('codex'));
        assert.equal(catalog.status, 'discovered');
        assert.deepEqual(
          catalog.models.map((model) => model.id),
          ['envcheck/unset'],
        );
        service.close();
      },
    );

    await t.test(
      'cache coalesces concurrent requests, refreshes on demand and expires failures after 30 seconds',
      async () => {
        await resetCounter();
        let now = 1_000_000;
        const service = new ModelCatalogService(config(), {
          now: () => now,
          codexTimeoutMs: 3000,
          opencodeTimeoutMs: 3000,
        });
        await withMode('lines', async () => {
          const [first, second] = await Promise.all([
            service.get('opencode'),
            service.get('opencode'),
          ]);
          assert.equal(first.status, 'discovered');
          assert.equal(second.status, 'discovered');
          assert.equal(await spawnCount(), 1);
          await service.get('opencode');
          assert.equal(await spawnCount(), 1);
          now += 10 * 60 * 1000;
          await service.get('opencode');
          assert.equal(await spawnCount(), 2);
          const [refresh, joined] = await Promise.all([
            service.get('opencode', true),
            service.get('opencode', true),
          ]);
          assert.equal(refresh.status, 'discovered');
          assert.equal(joined.status, 'discovered');
          assert.equal(await spawnCount(), 3);
        });
        await withMode('nonzero', async () => {
          await resetCounter();
          const failed = await service.get('opencode', true);
          assert.equal(failed.status, 'failed');
          assert.equal(await spawnCount(), 1);
          await service.get('opencode');
          assert.equal(await spawnCount(), 1);
          now += 29_000;
          await service.get('opencode');
          assert.equal(await spawnCount(), 1);
          now += 2_000;
          await service.get('opencode');
          assert.equal(await spawnCount(), 2);
        });
        service.close();
      },
    );

    await t.test(
      'closing the service cancels an in-flight discovery',
      async () => {
        await rm(pidFile, { force: true });
        const service = new ModelCatalogService(config(), {
          opencodeTimeoutMs: 3000,
        });
        const pending = withMode('hanging-lines', () =>
          service.get('opencode'),
        );
        let pid: number | null = null;
        for (let attempt = 0; attempt < 200 && pid === null; attempt += 1) {
          try {
            pid = Number((await readFile(pidFile, 'utf8')).trim());
          } catch {
            pid = null;
          }
          if (pid === null) await delay(10);
        }
        if (pid === null || !Number.isInteger(pid) || pid <= 0)
          throw new Error('The fixture never started');
        service.close();
        await pending;
        await waitForDeath(pid);
      },
    );
  } finally {
    if (previous.mode === undefined) delete process.env.LOOM_CATALOG_MODE;
    else process.env.LOOM_CATALOG_MODE = previous.mode;
    if (previous.counter === undefined) delete process.env.LOOM_CATALOG_COUNTER;
    else process.env.LOOM_CATALOG_COUNTER = previous.counter;
    if (previous.pid === undefined) delete process.env.LOOM_CATALOG_PID;
    else process.env.LOOM_CATALOG_PID = previous.pid;
    if (previous.key === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previous.key;
    await rm(root, { recursive: true, force: true });
  }
});
