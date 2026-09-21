import { test, expect } from '@playwright/test';
import type { Run, RunStatus } from '../../src/shared/types';

function fixture(id: string, title: string, status: RunStatus, mode: 'live' | 'demo' = 'live', project = 'storefront'): Run {
  return {
    id, title, task: 'Fixture for overview browser checks.', project, workflowId: 'review-build', workflowName: 'Plan, build, review', mode, status,
    currentStep: status === 'completed' ? 3 : 1, createdAt: '2026-09-20T10:00:00Z', updatedAt: '2026-09-20T10:00:00Z', workspace: '', error: null,
    steps: ['Plan', 'Implement', 'Verify'].map((name, i) => ({
      definition: { id: name.toLowerCase(), name, role: 'reviewer', provider: i === 1 ? 'opencode' : 'codex', model: '', effort: 'high', instructions: '', access: 'read-only', approval: true },
      status: status === 'completed' || i === 0 ? 'completed' : i === 2 || status === 'queued' ? 'pending' : status === 'cancelled' ? 'cancelled' : status === 'interrupted' ? 'failed' : status,
      attempt: 1, output: 'Output for review.', error: null, sessionId: null, feedback: '', startedAt: null, finishedAt: null, costUsd: null,
    })),
  };
}

test('overview prioritizes attention, shows honest progress, filters and updates live', async ({ page }) => {
  const running = fixture('working', 'Improve search relevance', 'running');
  const data = [
    fixture('approval', 'Review checkout changes', 'waiting_approval'),
    fixture('failure', 'Fix payment retry', 'failed'),
    running,
    fixture('demo', 'Explore a demo workflow', 'completed', 'demo', 'notes'),
    ...Array.from({ length: 10 }, (_, i) => fixture(`done-${i}`, `Completed task ${i}`, 'completed')),
  ];
  // Only the run feed is simulated, so every state can be inspected without invoking agents.
  await page.route(/\/api\/runs$/, route => route.fulfill({ json: data }));
  await page.route(/\/api\/runs\/[^/]+\/events\?/, route => route.fulfill({ json: [] }));
  await page.goto('/?view=runs');
  const attention = page.getByRole('region', { name: 'Needs attention', exact: true });
  const active = page.getByRole('region', { name: 'In progress', exact: true });
  const history = page.getByRole('region', { name: 'Finished', exact: true });
  await expect(attention.locator('.run-card')).toHaveCount(2);
  await expect(active.locator('.run-card')).toHaveCount(1);
  await expect(history.locator('.run-card')).toHaveCount(8);
  await expect(attention).toContainText('1/3 steps complete');
  await expect(active).toContainText('Implement');
  await expect(active).toContainText('OpenCode');
  await expect(history).not.toContainText('Fix payment retry');
  expect((await attention.boundingBox())!.y).toBeLessThan((await history.boundingBox())!.y);
  await page.screenshot({ path: 'artifacts/overview-states-desktop.png', fullPage: true });
  await history.getByRole('button', { name: /Show more/ }).click();
  await expect(history.locator('.run-card')).toHaveCount(11);

  running.status = 'waiting_approval';
  running.steps[1].status = 'waiting_approval';
  await expect(attention.locator('.run-card')).toHaveCount(3);
  await expect(active).toContainText('No agents working right now.');
  await page.getByLabel('Filter by mode').selectOption('live');
  await expect(page.locator('.run-card').filter({ hasText: 'Explore a demo workflow' })).toHaveCount(0);
  await page.getByLabel('Filter by project').selectOption('storefront');
  await attention.getByRole('button').filter({ hasText: 'Review checkout changes' }).click();
  await page.getByRole('button', { name: 'Back to runs' }).click();
  await expect(page.getByLabel('Filter by mode')).toHaveValue('live');
  await expect(page.getByLabel('Filter by project')).toHaveValue('storefront');
  await page.getByLabel('Filter by project').selectOption('notes');
  await expect(page.getByText('No matching runs', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await expect(attention.locator('.run-progress').first()).toBeVisible();
  await page.screenshot({ path: 'artifacts/overview-states-mobile.png', fullPage: true });
});
