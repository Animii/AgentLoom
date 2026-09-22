import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { MemoryRepository } from './helpers/memory-repository.js';
import { repositoryContract } from './helpers/repository-contract.js';

void test('memory repository contract', async (t) => {
  await repositoryContract(t, (context) => {
    const repository = new MemoryRepository();
    context.after(() => {
      repository.close();
    });
    return repository;
  });
});

void test('SQLite repository contract', async (t) => {
  await repositoryContract(t, async (context) => {
    const root = await mkdtemp(join(tmpdir(), 'agentloom-repository-'));
    const resources: { repository?: Store } = {};
    context.after(async () => {
      try {
        resources.repository?.close();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
    resources.repository = new Store(root);
    return resources.repository;
  });
});
