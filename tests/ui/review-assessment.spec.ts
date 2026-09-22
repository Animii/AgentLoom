import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import assert from 'node:assert/strict';
type AppModule = typeof import('../../src/server/app.js');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function importDist<T>(relativePath: string): Promise<T> {
  return (await import(pathToFileURL(path.resolve(relativePath)).href)) as T;
}

for (const uncertain of [false, true])
  test(`Jev review advice and uncertainty acknowledgment (${String(uncertain)})`, async ({
    page,
  }) => {
    const root = await mkdtemp(path.join(tmpdir(), 'loom-jev-review-ui-'));
    await mkdir(path.join(root, 'work/projects/welcome'), { recursive: true });
    const { createApp } = await importDist<AppModule>('dist/server/app.js');
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
        jevFetch: (_url: unknown, init?: RequestInit) => {
          if (typeof init?.body !== 'string')
            throw new Error('Expected a JSON request body');
          const parsed: unknown = JSON.parse(init.body);
          if (!isRecord(parsed)) throw new Error('Unexpected Jev request');
          const questions = parsed.questions as
            Record<string, { criteria?: Record<string, unknown> }> | undefined;
          const criteria = questions?.blocker.criteria ?? {};
          return Promise.resolve(
            new Response(
              JSON.stringify({
                model: 'jev-test',
                answers: {
                  blocker: {
                    type: 'choice',
                    choice: 'environment',
                    confidence: uncertain ? 0.33 : 0.9,
                    probabilities: Object.fromEntries(
                      Object.keys(criteria).map((key) => [
                        key,
                        key === 'environment'
                          ? uncertain
                            ? 0.33
                            : 0.9
                          : uncertain
                            ? 0.134
                            : 0.02,
                      ]),
                    ),
                  },
                },
              }),
            ),
          );
        },
        execute: (s: { access: string }) =>
          Promise.resolve({
            output:
              s.access === 'read-only'
                ? uncertain
                  ? 'Review passed. All evidence verified.'
                  : 'BLOCKED: Docker is unavailable. Code fixes are verified.'
                : 'Implementation complete.',
            sessionId: null,
            costUsd: null,
          }),
      },
    );
    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' });
      await app.inject({
        method: 'PUT',
        url: '/api/jev/settings',
        payload: { apiKey: 'fixture-ui-jev-key' },
      });
      const run = await app.engine.create({
        title: 'Advisory review routing',
        task: 'Validate approved work.',
        project: 'welcome',
        workflowId: 'fix-verify',
        mode: 'live',
      });
      await page.goto(`${address}/?run=${run.id}`);
      await page
        .getByRole('button', { name: 'Approve and continue', exact: true })
        .click();
      const advice = page.getByRole('complementary', {
        name: 'Jev review assessment',
      });
      if (uncertain) {
        await expect(advice).toContainText('Jev is uncertain');
        await expect(advice).toContainText('Classification confidence 33%');
        const approve = page.getByRole('button', {
          name: 'Approve and continue',
          exact: true,
        });
        await expect(approve).toBeDisabled();
        expect(
          (
            await page.request.post(`${address}/api/runs/${run.id}/approve`, {
              data: {},
            })
          ).status(),
        ).toBe(409);
        expect(
          (
            await page.request.post(`${address}/api/runs/${run.id}/approve`, {
              data: { acknowledgedAssessment: 'stale' },
            })
          ).status(),
        ).toBe(409);
        const acknowledgment = page.getByRole('checkbox', {
          name: /I understand Jev is uncertain/,
        });
        await acknowledgment.check();
        await expect(approve).toBeEnabled();
        await advice
          .getByRole('button', { name: 'Classify again', exact: true })
          .click();
        await expect(acknowledgment).not.toBeChecked();
        await expect(approve).toBeDisabled();
        await acknowledgment.check();
        await page.reload();
        await expect(acknowledgment).not.toBeChecked();
        await expect(approve).toBeDisabled();
        await acknowledgment.check();
        await approve.click();
        await expect(
          page.locator('.detail-status .status-completed'),
        ).toBeVisible();
        expect(
          app.store
            .getEvents(run.id)
            .some((event: { message: string }) =>
              event.message.includes('explicitly acknowledged'),
            ),
        ).toBe(true);
        return;
      }
      await expect(advice).toContainText('Environment blocker');
      await expect(advice).toContainText('Advisory only');
      await page.reload();
      await expect(advice).toContainText('Environment blocker');
      await advice.getByRole('button', { name: 'Draft follow-up' }).click();
      await expect(
        page.getByLabel('Message Verify', { exact: true }),
      ).toHaveValue(/Resolve missing dependencies/);
      const storedRun = app.store.getRun(run.id);
      assert.ok(storedRun);
      expect(storedRun.status).toBe('blocked');
      expect(storedRun.steps[1].attempt).toBe(1);
      await page.setViewportSize({ width: 390, height: 844 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: 'artifacts/jev-review-mobile.png',
        fullPage: true,
      });
    } finally {
      await page.goto('about:blank');
      app.server.closeAllConnections();
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
