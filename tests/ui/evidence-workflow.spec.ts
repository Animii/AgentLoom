import { createBrowserTestApp as createApp } from '../helpers/app-fixture.js';
import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import assert from 'node:assert/strict';

type TemplatesModule = typeof import('../../src/server/templates.js');

async function importDist<T>(relativePath: string): Promise<T> {
  return (await import(pathToFileURL(path.resolve(relativePath)).href)) as T;
}

test('evidence workflow exposes real failed commands, repairs, and requires final approval', async ({
  page,
}) => {
  const root = await mkdtemp(path.join(tmpdir(), 'loom-evidence-ui-'));
  await mkdir(path.join(root, 'work/projects/sample'), { recursive: true });
  await writeFile(path.join(root, 'work/projects/sample/app.txt'), 'original');

  const { evidenceWorkflow } = await importDist<TemplatesModule>(
    'dist/server/templates.js',
  );
  let fixed = false;
  const app = await createApp(
    {
      dataDir: path.join(root, 'data'),
      workspaceRoot: path.join(root, 'work'),
      host: '127.0.0.1',
      port: 0,
      cliTimeoutMs: 1000,
      maxOutputBytes: 10000,
    },
    {
      execute: async (s: { id: string }, _p: string, w: string) => {
        if (s.id === 'build')
          await writeFile(path.join(w, 'app.txt'), fixed ? 'fixed' : 'broken');
        return {
          output:
            s.id === 'plan'
              ? 'Plan: change app.txt and run the configured check.\n\nPLAN_READY'
              : 'Implementation and review complete.',
          sessionId: null,
          costUsd: null,
        };
      },
    },
  );
  const workflow = structuredClone(evidenceWorkflow);
  const validation = workflow.steps[2].validation;
  assert.ok(validation);
  validation.commands = [
    {
      executable: process.execPath,
      args: [
        '-e',
        "console.log('ACTUAL CHECK');process.exit(require('fs').readFileSync('app.txt','utf8')==='fixed'?0:1)",
      ],
      timeoutMs: 3000,
    },
  ];
  app.store.saveWorkflow(workflow);
  try {
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const run = await app.engine.create({
      title: 'Evidence pilot',
      task: 'Fix the approved behavior.',
      project: 'sample',
      workflowId: workflow.id,
      mode: 'live',
    });
    await page.goto(`${address}/?run=${run.id}`);
    await page
      .getByRole('button', { name: 'Approve plan and continue', exact: true })
      .click();
    await expect(page.locator('.detail-status .status-blocked')).toBeVisible();
    await page
      .getByText('Validation evidence and Jev signals', { exact: true })
      .click();
    const evidence = page.getByRole('region', { name: 'Recorded validation' });
    await expect(evidence).toContainText('exit 1');
    await evidence.locator('summary').click();
    await expect(evidence).toContainText('ACTUAL CHECK');
    await expect(evidence).toContainText('Jev API key is not configured');
    await expect(
      page.getByRole('button', { name: 'Approve and continue', exact: true }),
    ).toHaveCount(0);
    fixed = true;
    await page
      .getByRole('button', { name: 'Send to implementer', exact: true })
      .click();
    await expect(
      page.locator('.detail-status .status-waiting_approval'),
    ).toBeVisible();
    await page
      .getByText('Validation evidence and Jev signals', { exact: true })
      .click();
    await expect(evidence).toContainText('exit 0');
    await page.reload();
    await page
      .getByText('Validation evidence and Jev signals', { exact: true })
      .click();
    await expect(
      page.getByRole('region', { name: 'Recorded validation' }),
    ).toContainText('Attempt 2');
    await page
      .getByRole('button', { name: 'Approve and continue', exact: true })
      .click();
    await expect(
      page.locator('.detail-status .status-completed'),
    ).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: 'artifacts/evidence-workflow-mobile.png',
      fullPage: true,
    });
    await page.goto(`${address}/?view=workflows&workflow=evidence-delivery`);
    await page.locator('.wf-step summary').nth(2).click();
    const commands = page.locator('.validation-command-editor');
    const args = commands.getByRole('textbox', {
      name: 'Arguments (one per line)',
    });
    await args.fill('run');
    await args.press('End');
    await args.press('Enter');
    await args.pressSequentially('test');
    await expect(args).toHaveValue('run\ntest');
    await page
      .getByRole('button', { name: 'Save workflow', exact: true })
      .click();
    await expect
      .poll(
        () =>
          app.store.getWorkflow(workflow.id)?.steps[2].validation?.commands[0]
            .args,
      )
      .toEqual(['run', 'test']);
    expect(
      app.store.getRun(run.id)?.steps[2].definition.validation?.commands[0]
        .args[0],
    ).toBe('-e');
  } finally {
    await page.goto('about:blank').catch(() => {});
    app.server.closeAllConnections();
    await app.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});
