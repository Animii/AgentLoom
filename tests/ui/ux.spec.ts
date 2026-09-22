import { test, expect } from '@playwright/test';
import assert from 'node:assert/strict';

// Exercise the simplified UI against the running Docker application.

test('quiet run list, search, mobile navigation and review without overlapping controls', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/?view=runs');
  await expect(
    page.getByRole('button', { name: 'New run', exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByRole('heading', { name: 'Runs', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('group', { name: 'UI design' })).toHaveCount(0);
  await page
    .getByRole('searchbox', { name: 'Search runs' })
    .fill('not-a-real-run-12345');
  await expect(
    page.getByText('No matching runs', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await page.screenshot({
    path: 'artifacts/quiet-runs-desktop.png',
    fullPage: true,
  });
  await page.getByRole('button', { name: 'New run', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const title = `UX review ${String(Date.now())}`;
  await dialog.getByLabel('Task title', { exact: true }).fill(title);
  await dialog
    .getByLabel('Task brief', { exact: true })
    .fill('Check output, then approve the handoff.');
  await dialog
    .getByLabel('Workflow', { exact: true })
    .selectOption('fix-verify');
  await dialog.getByLabel('Mode', { exact: true }).selectOption('demo');
  await dialog.getByLabel('Project', { exact: true }).selectOption('welcome');
  await dialog.getByRole('button', { name: 'Start run', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Approve and continue' }),
  ).toBeVisible();
  await expect(page.locator('.run-list:visible')).toHaveCount(0);
  await expect(page.locator('.chat-assistant').last()).toContainText(
    'Implement',
  );
  await expect(page.locator('.step-details')).not.toHaveAttribute('open', '');
  await page.screenshot({
    path: 'artifacts/quiet-review-desktop.png',
    fullPage: true,
  });
  const [output, actions] = await Promise.all([
    page.locator('.tab-panel').boundingBox(),
    page.locator('.approval-bar').boundingBox(),
  ]);
  assert.ok(output && actions);
  expect(actions.y).toBeGreaterThanOrEqual(output.y + output.height);
  await page.getByRole('button', { name: 'Approve and continue' }).click();
  await expect(
    page.locator('.step-list li').first().locator('.status-chip'),
  ).toHaveText('Completed');
  await expect(
    page.getByRole('button', { name: 'Approve and continue' }),
  ).toBeVisible();
  await page.locator('.step-row').first().click();
  await expect(
    page.getByRole('button', { name: 'Approve and continue' }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Review current step' }).click();
  await page.getByRole('button', { name: 'Approve and continue' }).click();
  await expect(page.locator('.detail-status .status-completed')).toBeVisible();
  await expect(
    page.locator('.agent-output').getByRole('heading', { name: /Verify/ }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: 'artifacts/quiet-review-mobile.png',
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  await page.getByRole('button', { name: 'Back to runs' }).click();
  await page.getByRole('searchbox', { name: 'Search runs' }).fill(title);
  await expect(page.locator('.run-card')).toHaveCount(1);
  await page.locator('.run-card').click();
  await expect(page.locator('.detail-title')).toBeInViewport();
  await page.getByRole('button', { name: 'Back to runs' }).click();
  await expect(page.getByRole('searchbox')).toHaveValue(title);
  await page.screenshot({
    path: 'artifacts/quiet-runs-mobile.png',
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test('progressive settings and workflow drafts survive navigation', async ({
  page,
}) => {
  await page.goto('/?view=runs');
  await page.getByRole('button', { name: 'Workflows', exact: true }).click();
  await expect(page.locator('.wf-step[open]')).toHaveCount(0);
  await page
    .getByLabel('Description', { exact: true })
    .fill('Unsaved workflow draft');
  await page.locator('.wf-step summary').first().click();
  await expect(
    page.locator('.wf-step').first().getByLabel('Instructions'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Add step', exact: true }).click();
  const newStep = page.locator('.wf-step').last();
  await newStep.getByLabel('Name', { exact: true }).fill('Extra review');
  await expect(newStep.getByLabel('Name', { exact: true })).toBeVisible();
  await expect(newStep.getByLabel('Name', { exact: true })).toHaveValue(
    'Extra review',
  );
  await newStep.getByRole('button', { name: /Remove step/ }).click();
  await page.screenshot({
    path: 'artifacts/quiet-workflows.png',
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  await expect(page.locator('.provider-card')).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Save API key' })).toHaveCount(
    0,
  );
  await page.getByText('API key and connection', { exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Save API key' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Workflows', exact: true }).click();
  await expect(page.getByLabel('Description', { exact: true })).toHaveValue(
    'Unsaved workflow draft',
  );
  for (const view of ['Runs', 'Workflows', 'Agents']) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: view, exact: true }).click();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBeTruthy();
  }
  await page.getByText('API key and connection', { exact: true }).click();
  await page.screenshot({
    path: 'artifacts/quiet-agents-mobile.png',
    fullPage: true,
  });
});
