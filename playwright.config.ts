import { defineConfig } from '@playwright/test';
import { uiTarget } from './tests/support/ui-target.js';
export default defineConfig({
  testDir: 'tests/ui',
  timeout: 60000,
  expect: { timeout: 12000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: uiTarget(process.env),
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1440, height: 1000 },
  },
});
