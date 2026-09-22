import { chromium, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const source = await mkdtemp(path.join(tmpdir(), 'loom-folder-docker-'));
const name = 'e2e-folder-docker-' + Date.now();
const projects = path.resolve('workspaces/projects');
const target = path.resolve(projects, name);
const browser = await chromium.launch();
try {
  await mkdir(path.join(source, 'src'));
  await writeFile(
    path.join(source, 'README.md'),
    'Imported through the real Docker folder picker.',
  );
  await writeFile(
    path.join(source, 'src/main.js'),
    'export const imported = true;',
  );
  await writeFile(path.join(source, '.env'), 'DO_NOT_IMPORT=test');
  const page = await browser.newPage();
  await page.goto('http://localhost:4317');
  await page
    .getByRole('button', { name: 'New run', exact: true })
    .first()
    .click();
  await page.getByLabel('Task title', { exact: true }).fill(name);
  await page
    .getByLabel('Task brief', { exact: true })
    .fill('Validate a folder import without provider calls.');
  await page.getByRole('button', { name: 'Import a copy' }).click();
  const picked = page.waitForEvent('filechooser');
  await page
    .getByRole('button', { name: 'Choose folder', exact: true })
    .click();
  await (await picked).setFiles(source);
  await page.getByLabel('Project name', { exact: true }).fill(name);
  await page
    .getByRole('button', { name: 'Create project', exact: true })
    .click();
  await expect(page.getByLabel('Project', { exact: true })).toHaveValue(name);
  await page
    .getByLabel('Workflow', { exact: true })
    .selectOption('quick-review');
  await page.getByLabel('Mode', { exact: true }).selectOption('demo');
  await page.screenshot({
    path: 'artifacts/project-import-docker.png',
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Start run', exact: true }).click();
  await expect(page.locator('.detail-status .status-completed')).toBeVisible();
  await page.getByRole('tab', { name: 'Files', exact: true }).click();
  await page.getByRole('button', { name: 'README.md', exact: true }).click();
  await expect(page.locator('.file-viewer')).toContainText(
    'Imported through the real Docker folder picker.',
  );
  console.log(
    'Docker folder selection, project creation and run file snapshot: passed',
  );
  console.log(
    'Source unchanged:',
    await readFile(path.join(source, 'src/main.js'), 'utf8'),
  );
} finally {
  await browser.close();
  if (
    path.dirname(target) !== projects ||
    !/^e2e-folder-docker-\d+$/.test(path.basename(target))
  )
    throw Error('Unexpected cleanup path');
  await rm(target, { recursive: true, force: true });
  if (
    path.dirname(source) !== path.resolve(tmpdir()) ||
    !path.basename(source).startsWith('loom-folder-docker-')
  )
    throw Error('Unexpected fixture path');
  await rm(source, { recursive: true, force: true });
}
