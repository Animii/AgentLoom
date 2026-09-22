import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
const base = 'http://localhost:4317';
const host = path.resolve('..');
const folder = 'AgentLoom-Direct-Test-' + Date.now();
const source = path.resolve(host, folder);
async function api(url, body, method = body ? 'POST' : 'GET') {
  const r = await fetch(base + url, {
    method,
    ...(body
      ? {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {}),
  });
  const data = await r.json();
  if (!r.ok) throw Error(data.error);
  return data;
}
await mkdir(source);
await writeFile(path.join(source, 'proof.txt'), 'before\n');
let project;
let run;
try {
  const listing = await api('/api/project-folders');
  if (!listing.folders.some((item) => item.name === folder))
    throw Error('Host directory is not mounted');
  project = await api('/api/projects', {
    name: 'Direct folder live verification',
    folder,
    workspaceMode: 'direct',
  });
  const workflow = {
    id: 'direct-folder-live-check',
    name: 'Direct folder live check',
    description: 'Exact authorized write in a disposable fixture.',
    steps: [
      {
        id: 'edit',
        name: 'Edit fixture',
        role: 'implementer',
        provider: 'opencode',
        model: 'deepseek/deepseek-flash',
        effort: 'max',
        access: 'workspace-write',
        approval: true,
        planning: false,
        instructions:
          'The product owner approves this exact test: read proof.txt and replace its entire content with after followed by a newline. Use file read/write/edit tools only. Do not run commands, change other files, or make any decisions. Report completion.',
      },
    ],
  };
  await api('/api/workflows/' + workflow.id, workflow, 'PUT');
  run = await api('/api/runs', {
    title: 'Live direct folder verification',
    task: 'Apply the approved exact proof.txt change from before to after. This temporary test folder is the full allowed scope.',
    project: project.id,
    workflowId: workflow.id,
    mode: 'live',
  });
  for (let i = 0; i < 240; i++) {
    run = await api('/api/runs/' + run.id);
    if (!['queued', 'running'].includes(run.status)) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log('Run status:', run.status, 'workspace:', run.workspace);
  if (run.status !== 'waiting_approval')
    throw Error(run.error ?? run.steps[0].output);
  const actual = await readFile(path.join(source, 'proof.txt'), 'utf8');
  if (actual.trim() !== 'after')
    throw Error('Original folder did not change: ' + actual);
  await api('/api/runs/' + run.id + '/approve', {});
  run = await api('/api/runs/' + run.id);
  await api('/api/projects/' + project.id, { status: 'disconnected' }, 'PATCH');
  if (
    (await readFile(path.join(source, 'proof.txt'), 'utf8')).trim() !== 'after'
  )
    throw Error('Disconnect changed source');
  await writeFile(
    'artifacts/projects-live-result.json',
    JSON.stringify(
      { run, originalFile: actual, disconnectedPreservesSource: true },
      null,
      2,
    ),
  );
  console.log(
    'PASS: Flash edited the host file directly; disconnect preserved it.',
  );
} finally {
  if (
    run &&
    [
      'queued',
      'running',
      'waiting_approval',
      'waiting_input',
      'blocked',
      'interrupted',
    ].includes(run.status)
  ) {
    await api('/api/runs/' + run.id + '/cancel', {}).catch(() => {});
  }
  if (project)
    await api(
      '/api/projects/' + project.id,
      { status: 'disconnected' },
      'PATCH',
    ).catch(() => {});
  if (
    path.dirname(source) !== host ||
    !/^AgentLoom-Direct-Test-\d+$/.test(path.basename(source))
  )
    throw Error('Unexpected cleanup path');
  await rm(source, { recursive: true, force: true });
}
