import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { AppConfig, Run } from '../../src/shared/types';

type AppModule = typeof import('../../src/server/app.js');
type GitWorkspacesModule = typeof import('../../src/server/git-workspaces.js');
type PublishInput = Parameters<GitWorkspacesModule['publishDraftPr']>[2];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function importDist<T>(relativePath: string): Promise<T> {
  return (await import(pathToFileURL(path.resolve(relativePath)).href)) as T;
}
const exec = promisify(execFile);
test('worktree run requires approval, reviews diff, creates draft PR and retains link after refresh', async ({
  page,
}) => {
  const root = await mkdtemp(path.join(tmpdir(), 'loom-git-ui-'));
  const source = path.join(root, 'projects', 'fixture');
  await mkdir(source, { recursive: true });
  const git = async (...args: string[]) =>
    exec('git', args, { cwd: source, windowsHide: true });
  await git('init', '-b', 'main');
  await git('config', 'user.name', 'Fixture');
  await git('config', 'user.email', 'fixture@example.invalid');
  await writeFile(path.join(source, 'app.txt'), 'original\n');
  await git('add', '.');
  await git('commit', '-m', 'Initial');
  await git(
    'remote',
    'add',
    'origin',
    'https://github.com/fixture/project.git',
  );
  const { createApp } = await importDist<AppModule>('dist/server/app.js');
  const { publishDraftPr } = await importDist<GitWorkspacesModule>(
    'dist/server/git-workspaces.js',
  );
  let pushed = 0;
  const app = await createApp(
    {
      dataDir: path.join(root, 'data'),
      workspaceRoot: path.join(root, 'work'),
      projectRoot: path.join(root, 'projects'),
      host: '127.0.0.1',
      port: 0,
      cliTimeoutMs: 1000,
      maxOutputBytes: 10000,
    },
    {
      execute: async (
        s: { access: string },
        prompt: string,
        workspace: string,
      ) => {
        expect(prompt).toContain('Managed Git worktree');
        if (s.access === 'workspace-write')
          await writeFile(path.join(workspace, 'app.txt'), 'implemented\n');
        return {
          output: 'Completed and validated.',
          sessionId: null,
          costUsd: null,
        };
      },
      publishPr: (run: Run, config: AppConfig, input: PublishInput) =>
        publishDraftPr(run, config, input, {
          gh: async (args: string[]) => {
            if (args[0] === 'auth') return '';
            if (args[1] === 'list') return '[]';
            if (args[0] === 'api') return '{"login":"fixture","id":123}';
            expect(args).toContain('--draft');
            expect(args[args.indexOf('--title') + 1]).toBe('Reviewed fix');
            expect(
              await readFile(args[args.indexOf('--body-file') + 1], 'utf8'),
            ).toBe('Validated by reviewer.');
            return 'https://github.com/fixture/project/pull/42';
          },
          push: () => {
            pushed++;
            return Promise.resolve();
          },
        }),
    },
  );
  try {
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const connected = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: {
        name: 'Git fixture',
        folder: 'fixture',
        workspaceMode: 'worktree',
      },
    });
    expect(connected.statusCode).toBe(201);
    const projectBody: unknown = connected.json();
    if (!isRecord(projectBody) || typeof projectBody.id !== 'string')
      throw new Error('Fixture project creation failed');
    const project = { id: projectBody.id };
    const run = await app.engine.create({
      title: 'Worktree fixture',
      task: 'Implement fix',
      project: project.id,
      workflowId: 'fix-verify',
      mode: 'live',
    });
    await page.goto(`${address}/?run=${run.id}`);
    await page.locator('.git-run-panel > summary').click();
    await expect(page.locator('.git-diff-stat')).toContainText('app.txt');
    await expect(
      page.getByRole('button', { name: 'Create draft PR', exact: true }),
    ).toBeDisabled();
    expect(
      (
        await page.request.post(`${address}/api/runs/${run.id}/pull-request`, {
          data: { token: '0'.repeat(64), title: 'Premature', body: '' },
        })
      ).status(),
    ).toBe(409);
    await page
      .getByRole('button', { name: 'Approve and continue', exact: true })
      .click();
    await expect(
      page.locator('.detail-status .status-waiting_approval'),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Approve and continue', exact: true })
      .click();
    await expect(
      page.locator('.detail-status .status-completed'),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Create draft PR', exact: true }),
    ).toBeEnabled();
    await page.getByText('View patch', { exact: true }).click();
    await expect(page.locator('.git-diff')).toContainText('+implemented');
    await page.getByLabel('PR title', { exact: true }).fill('Reviewed fix');
    await page
      .getByLabel('PR description', { exact: true })
      .fill('Validated by reviewer.');
    await page
      .getByRole('button', { name: 'Create draft PR', exact: true })
      .click();
    await expect(
      page.getByRole('link', { name: 'Open draft pull request' }),
    ).toHaveAttribute('href', 'https://github.com/fixture/project/pull/42');
    expect(pushed).toBe(1);
    await page.reload();
    await page.locator('.git-run-panel > summary').click();
    await expect(
      page.getByRole('link', { name: 'Open draft pull request' }),
    ).toBeVisible();
    expect(await readFile(path.join(source, 'app.txt'), 'utf8')).toBe(
      'original\n',
    );
    expect((await git('status', '--porcelain')).stdout.trim()).toBe('');
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  } finally {
    await page.goto('about:blank').catch(() => {});
    app.server.closeAllConnections();
    await app.close();
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    });
  }
});
