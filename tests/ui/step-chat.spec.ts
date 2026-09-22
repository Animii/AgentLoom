import { createBrowserTestApp as createApp } from '../helpers/app-fixture.js';
import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import assert from 'node:assert/strict';

test('implementation and review chats preserve messages, drafts and approval boundaries', async ({
  page,
}) => {
  const root = await mkdtemp(path.join(tmpdir(), 'loom-step-chat-'));
  await mkdir(path.join(root, 'work/projects/welcome'), { recursive: true });

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
      execute: () =>
        Promise.resolve({
          output: 'Work complete. Validation evidence recorded.',
          sessionId: null,
          costUsd: null,
        }),
    },
  );
  try {
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const run = await app.engine.create({
      title: 'Chat on every step',
      task: 'Fix keyboard access.',
      project: 'welcome',
      workflowId: 'fix-verify',
      mode: 'live',
    });
    await page.goto(`${address}/?run=${run.id}`);
    await expect(
      page.getByLabel('Message Implement', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Approve and continue', exact: true }),
    ).toBeVisible();
    await page
      .getByLabel('Message Implement', { exact: true })
      .fill('Add an empty-input regression test.');
    await page.reload();
    await expect(
      page.getByLabel('Message Implement', { exact: true }),
    ).toHaveValue('Add an empty-input regression test.');
    await page.getByLabel('Message Implement', { exact: true }).press('Enter');
    await expect(page.locator('.chat-user').last()).toContainText(
      'Add an empty-input regression test.',
    );
    await expect(
      page.getByRole('button', { name: 'Approve and continue', exact: true }),
    ).toBeVisible();
    const storedRun = app.store.getRun(run.id);
    assert.ok(storedRun);
    expect(storedRun.steps[1].attempt).toBe(0);
    await page.reload();
    await expect(page.locator('.chat-user').last()).toContainText(
      'Add an empty-input regression test.',
    );
    await page
      .getByRole('button', { name: 'Approve and continue', exact: true })
      .click();
    await expect(
      page.getByLabel('Message Verify', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Approve and continue', exact: true }),
    ).toBeVisible();
    await page
      .getByLabel('Message Verify', { exact: true })
      .fill('Explain the test evidence.');
    await page
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: 'Approve and continue', exact: true }),
    ).toBeVisible();
    await expect(page.locator('.chat-user').last()).toContainText(
      'Explain the test evidence.',
    );
    await page
      .getByRole('button', { name: 'Approve and continue', exact: true })
      .click();
    await expect(
      page.locator('.detail-status .status-completed'),
    ).toBeVisible();
    await page.locator('.step-list button').first().click();
    await expect(page.locator('.chat-footnote')).toContainText('Later steps');
    await page
      .getByLabel('Message Implement', { exact: true })
      .fill('Also cover cancellation.');
    await page
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: 'Approve and continue', exact: true }),
    ).toBeVisible();
    const refreshedRun = app.store.getRun(run.id);
    assert.ok(refreshedRun);
    expect(refreshedRun.steps[1].status).toBe('pending');
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: 'artifacts/step-chat-mobile.png',
      fullPage: true,
    });
  } finally {
    await page.goto('about:blank');
    app.server.closeAllConnections();
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
