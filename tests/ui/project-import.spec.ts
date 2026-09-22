import { test, expect } from '@playwright/test';
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  readFile,
  readdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

type AppModule = typeof import('../../src/server/app.js');

async function importDist<T>(relativePath: string): Promise<T> {
  return (await import(pathToFileURL(path.resolve(relativePath)).href)) as T;
}

test('select a folder, import a project, preserve run draft and start a run from its source', async ({
  page,
}) => {
  const root = await mkdtemp(path.join(tmpdir(), 'loom-folder-ui-'));
  const source = path.join(root, 'My Game');
  await mkdir(path.join(source, 'src'), { recursive: true });
  await mkdir(path.join(source, 'node_modules'), { recursive: true });
  await writeFile(path.join(source, 'src/main.ts'), 'export const game = 42;');
  await writeFile(path.join(source, 'README.md'), 'Folder picker project');
  await writeFile(path.join(source, '.env'), 'SECRET=never-import');
  await writeFile(path.join(source, 'node_modules/dependency.txt'), 'excluded');
  const { createApp } = await importDist<AppModule>('dist/server/app.js');
  const work = path.join(root, 'work');
  const app = await createApp({
    dataDir: path.join(root, 'data'),
    workspaceRoot: work,
    host: '127.0.0.1',
    port: 0,
    cliTimeoutMs: 1000,
    maxOutputBytes: 1000,
  });
  try {
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    await page.goto(address + '/?view=runs');
    await page
      .getByRole('button', { name: 'New run', exact: true })
      .first()
      .click();
    const dialog = page.getByRole('dialog');
    await dialog
      .getByLabel('Task title', { exact: true })
      .fill('Imported game review');
    await dialog
      .getByLabel('Task brief', { exact: true })
      .fill('Review the imported code');
    await dialog.getByRole('button', { name: 'Import a copy' }).click();
    const chooserPromise = page.waitForEvent('filechooser');
    await dialog
      .getByRole('button', { name: 'Choose folder', exact: true })
      .click();
    const chooser = await chooserPromise;
    await chooser.setFiles(source);
    await expect(
      dialog.getByLabel('Project name', { exact: true }),
    ).toHaveValue('My-Game');
    await expect(dialog).toContainText('2 files');
    await expect(dialog).toContainText('2 excluded');
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: 'artifacts/project-import-mobile.png',
      fullPage: true,
    });
    await dialog
      .getByRole('button', { name: 'Create project', exact: true })
      .click();
    await expect(dialog.getByLabel('Project', { exact: true })).toHaveValue(
      'My-Game',
    );
    await expect(dialog.getByLabel('Task title', { exact: true })).toHaveValue(
      'Imported game review',
    );
    expect(
      await readFile(path.join(work, 'projects/My-Game/src/main.ts'), 'utf8'),
    ).toBe('export const game = 42;');
    expect(await readdir(path.join(work, 'projects/My-Game'))).toEqual([
      'README.md',
      'src',
    ]);
    await dialog
      .getByLabel('Workflow', { exact: true })
      .selectOption('quick-review');
    await dialog.getByLabel('Mode', { exact: true }).selectOption('demo');
    await dialog
      .getByRole('button', { name: 'Start run', exact: true })
      .click();
    await expect(
      page.locator('.detail-status .status-completed'),
    ).toBeVisible();
    const run = app.store.listRuns()[0];
    expect(
      await readFile(path.join(run.workspace, 'src/main.ts'), 'utf8'),
    ).toBe('export const game = 42;');
    expect(await readFile(path.join(source, 'src/main.ts'), 'utf8')).toBe(
      'export const game = 42;',
    );
    await page.reload();
    await page
      .getByRole('button', { name: 'New run', exact: true })
      .first()
      .click();
    await expect(page.getByLabel('Project', { exact: true })).toHaveValue(
      'My-Game',
    );
    await page.getByRole('button', { name: 'Import a copy' }).click();
    await page
      .getByLabel('Project folder', { exact: true })
      .setInputFiles(source);
    await page
      .getByRole('button', { name: 'Create project', exact: true })
      .click();
    await expect(page.getByRole('alert')).toContainText('already exists');
    await page
      .getByLabel('Project name', { exact: true })
      .fill('cancelled-import');
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/project-imports/*/files', async (route) => {
      await held;
      await route.continue();
    });
    await page
      .getByRole('button', { name: 'Create project', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: 'Cancel import', exact: true }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Cancel import', exact: true })
      .click();
    release();
    await expect(page.getByRole('alert')).toContainText('Import cancelled');
    expect(await readdir(path.join(work, '.imports'))).toEqual([]);
    expect(
      (await readdir(path.join(work, 'projects'))).includes('cancelled-import'),
    ).toBe(false);
  } finally {
    await page.goto('about:blank');
    app.server.closeAllConnections();
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
