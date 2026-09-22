import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { StepDefinition } from '../../src/shared/types';

type AppModule = typeof import('../../src/server/app.js');

async function importDist<T>(relativePath: string): Promise<T> {
  return (await import(pathToFileURL(path.resolve(relativePath)).href)) as T;
}

test('send review blockers to implementer, retain history and approve fresh review', async ({
  page,
}) => {
  const root = await mkdtemp(path.join(tmpdir(), 'loom-rework-ui-'));
  await mkdir(path.join(root, 'work/projects/welcome'), { recursive: true });
  const { createApp } = await importDist<AppModule>('dist/server/app.js');
  let builds = 0;
  let reviews = 0;
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
      execute: async (s: StepDefinition, p: string, w: string) => {
        if (s.access === 'workspace-write') {
          builds++;
          if (builds === 2)
            expect(p).toContain('BLOCKED: Missing keyboard handler');
          await writeFile(
            path.join(w, 'result.txt'),
            builds === 1 ? 'missing' : 'fixed',
          );
          return {
            output: 'Implementation and validation complete',
            sessionId: null,
            costUsd: null,
          };
        }
        reviews++;
        return {
          output:
            reviews === 1
              ? 'BLOCKED: Missing keyboard handler'
              : `Verified: ${await readFile(path.join(w, 'result.txt'), 'utf8')}`,
          sessionId: null,
          costUsd: null,
        };
      },
    },
  );
  try {
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const run = await app.engine.create({
      title: 'Review repair loop',
      task: 'Fix keyboard support',
      project: 'welcome',
      workflowId: 'fix-verify',
      mode: 'live',
    });
    await page.goto(`${address}/?run=${run.id}`);
    await page
      .getByRole('button', { name: 'Approve and continue', exact: true })
      .click();
    await expect(page.locator('.detail-status .status-blocked')).toBeVisible();
    expect(
      (
        await page.request.post(`${address}/api/runs/${run.id}/approve`, {
          data: {},
        })
      ).status(),
    ).toBe(409);
    await page
      .getByRole('button', { name: 'Send to implementer', exact: true })
      .click();
    await expect(
      page.locator('.detail-status .status-waiting_approval'),
    ).toBeVisible();
    expect(builds).toBe(2);
    expect(reviews).toBe(1);
    await page
      .getByRole('button', { name: 'Approve and continue', exact: true })
      .click();
    await expect(page.locator('.output-pane')).toContainText('Verified: fixed');
    await expect(
      page.locator('.detail-status .status-waiting_approval'),
    ).toBeVisible();
    await page.reload();
    await page.locator('.previous-attempt summary').click();
    await expect(page.locator('.previous-attempt')).toContainText(
      'BLOCKED: Missing keyboard handler',
    );
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: 'artifacts/rework-mobile.png',
      fullPage: true,
    });
    await page
      .getByRole('button', { name: 'Approve and continue', exact: true })
      .click();
    await expect(
      page.locator('.detail-status .status-completed'),
    ).toBeVisible();
    expect(builds).toBe(2);
    expect(reviews).toBe(2);
  } finally {
    await page.goto('about:blank');
    app.server.closeAllConnections();
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
