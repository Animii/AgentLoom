import { createBrowserTestApp as createApp } from '../helpers/app-fixture.js';
import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import assert from 'node:assert/strict';
import type { AgentEvent } from '../../src/shared/types';

test('non-planning output shows live native calls and recovers historical Activity calls', async ({
  page,
}) => {
  const root = await mkdtemp(path.join(tmpdir(), 'loom-native-ui-'));
  await mkdir(path.join(root, 'work/projects/welcome'), { recursive: true });

  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const app = await createApp(
    {
      dataDir: path.join(root, 'data'),
      workspaceRoot: path.join(root, 'work'),
      host: '127.0.0.1',
      port: 0,
      cliTimeoutMs: 10000,
      maxOutputBytes: 10000,
    },
    {
      execute: async (
        _s: unknown,
        _p: unknown,
        _w: unknown,
        _sig: unknown,
        event: (e: AgentEvent) => void,
      ) => {
        const startedAt = new Date().toISOString();
        event({ type: 'output', message: 'Inspecting the workspace.' });
        event({
          type: 'tool',
          message: 'command',
          toolCall: {
            id: 'item_1',
            name: 'command_execution',
            status: 'running',
            input: { command: 'npm test' },
            startedAt,
          },
        });
        await held;
        event({
          type: 'tool',
          message: 'command',
          toolCall: {
            id: 'item_1',
            name: 'command_execution',
            status: 'completed',
            input: { command: 'npm test' },
            startedAt,
            finishedAt: new Date().toISOString(),
            summary: 'Exit code 0',
          },
        });
        event({ type: 'output', message: ' Tests passed. Checking files.' });
        event({
          type: 'tool',
          message: 'files',
          toolCall: {
            id: 'item_2',
            name: 'command_execution',
            status: 'completed',
            input: { command: 'rg --files' },
            startedAt: new Date().toISOString(),
            summary: 'Exit code 0',
          },
        });
        return {
          output:
            'Inspecting the workspace. Tests passed. Checking files. All done.',
          sessionId: null,
          costUsd: null,
        };
      },
    },
  );
  try {
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const workflow = app.store.getWorkflow('quick-review');
    assert.ok(workflow);
    workflow.steps = [
      { ...workflow.steps[0], provider: 'codex', approval: true },
    ];
    app.store.saveWorkflow(workflow);
    const run = await app.engine.create({
      title: 'Native tools',
      task: 'Inspect',
      project: 'welcome',
      workflowId: 'quick-review',
      mode: 'live',
    });
    await page.goto(`${address}/?run=${run.id}`);
    const cards = page.locator('.chat-tool-call');
    const card = cards.first();
    await expect(card).toContainText('Running');
    await expect(card).toContainText('npm test');
    release();
    await expect(card).toContainText('Completed');
    await page.locator('.tool-call-group > summary').first().click();
    await card.locator('summary').click();
    await expect(card).toContainText('Exit code 0');
    await page.reload();
    await expect(cards).toHaveCount(2);
    await expect(page.locator('.tool-call-group')).toHaveCount(2);
    await expect(page.locator('.reply-tool-segment').first()).toContainText(
      'Inspecting the workspace.',
    );
    await expect(page.locator('.reply-tool-segment').nth(1)).toContainText(
      'Tests passed. Checking files.',
    );
    await expect(card).toContainText('Completed');
    const saved = app.store.getRun(run.id);
    assert.ok(saved);
    saved.steps[0].toolCalls = [];
    app.store.saveRun(saved);
    for (const type of ['item.started', 'item.completed'])
      app.store.addEvent(
        run.id,
        workflow.steps[0].id,
        'log',
        JSON.stringify({
          type,
          item: {
            id: 'old-call',
            type: 'command_execution',
            command: 'rg --files',
            exit_code: type === 'item.completed' ? 0 : null,
          },
        }),
      );
    await page.reload();
    await expect(card).toHaveCount(1);
    await expect(card).toContainText('rg --files');
    await expect(card).toContainText('Completed');
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: 'artifacts/native-tools-mobile.png',
      fullPage: true,
    });
  } finally {
    release();
    await page.goto('about:blank');
    app.server.closeAllConnections();
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
