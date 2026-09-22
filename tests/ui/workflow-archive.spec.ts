import { createAppFixture } from '../helpers/app-fixture.js';
import { test, expect } from '@playwright/test';

import assert from 'node:assert/strict';

test('archive removes workflows from active lists and new runs, with restore after reload', async ({
  page,
}) => {
  const f = await createAppFixture(undefined, { built: true });
  const { app } = f;
  try {
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    await page.goto(`${address}/?view=workflows&workflow=quick-review`);
    await page
      .getByRole('button', { name: 'Archive workflow', exact: true })
      .click();
    await expect(
      page.locator('.wf-item').filter({ hasText: 'Quick Review' }),
    ).toHaveCount(0);
    await page.reload();
    await expect(
      page.locator('.wf-item').filter({ hasText: 'Quick Review' }),
    ).toHaveCount(0);
    await page.goto(`${address}/?view=runs`);
    await page.getByRole('button', { name: 'New run', exact: true }).click();
    await expect(
      page
        .getByRole('dialog')
        .getByRole('option', { name: 'Quick Review', exact: true }),
    ).toHaveCount(0);
    await page.goto(`${address}/?view=workflows`);
    await page.getByLabel(/Show archived workflows/).check();
    await page
      .locator('.wf-item')
      .filter({ hasText: 'Quick Review (archived)' })
      .click();
    await expect(
      page.getByRole('button', { name: 'Save workflow', exact: true }),
    ).toBeDisabled();
    await page
      .getByRole('button', { name: 'Restore workflow', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: 'Save workflow', exact: true }),
    ).toBeEnabled();
    await page.reload();
    await expect(
      page.locator('.wf-item').filter({ hasText: 'Quick Review' }),
    ).toBeVisible();
    const savedWorkflow = app.store.getWorkflow('quick-review');
    assert.ok(savedWorkflow);
    expect(savedWorkflow.archived).toBe(false);
  } finally {
    await page.goto('about:blank').catch(() => {});
    await f.close();
  }
});
