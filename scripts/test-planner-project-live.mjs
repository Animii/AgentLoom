import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
const base = 'http://localhost:4317';
const parent = path.resolve('..');
const folder = `AgentLoom-Planner-Test-${Date.now()}`;
const source = path.join(parent, folder);
const marker = randomUUID();
const file = `fixture_marker=${marker}\n`;
let project;
let run;
async function api(url, body, method = body ? 'POST' : 'GET') {
  const response = await fetch(base + url, {
    method,
    ...(body
      ? {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {}),
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error);
  return result;
}
try {
  await mkdir(path.join(source, 'src'), { recursive: true });
  await writeFile(path.join(source, 'src/config.txt'), file);
  project = await api('/api/projects', {
    name: 'Planner read-only verification',
    folder,
    workspaceMode: 'direct',
  });
  const workflow = {
    id: 'planner-project-access-check',
    name: 'Planner project access check',
    description: 'Read-only inspection of a disposable host project.',
    steps: [
      {
        id: 'plan',
        name: 'Plan',
        role: 'planner',
        provider: 'codex',
        model: '',
        effort: 'high',
        access: 'read-only',
        approval: true,
        planning: true,
        instructions:
          'Use all three agentloom tools: list_project_files, read_project_file, and search_project. List the project, search for fixture_marker, read the matching file and report its exact value in your proposed plan. Do not ask questions; the scope is fully specified. Do not execute commands or modify files.',
      },
    ],
  };
  await api('/api/workflows/' + workflow.id, workflow, 'PUT');
  run = await api('/api/runs', {
    title: 'Live planner project access verification',
    task: 'Inspect this temporary project using the three read-only MCP project tools. Report the exact fixture_marker value found in the file. End with PLAN_READY. Do not change anything.',
    project: project.id,
    workflowId: workflow.id,
    mode: 'live',
  });
  console.log('Started read-only Codex run:', run.id);
  for (let i = 0; i < 180; i++) {
    run = await api('/api/runs/' + run.id);
    if (!['queued', 'running'].includes(run.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (
    run.status !== 'waiting_approval' ||
    !run.steps[0].output.includes(marker)
  )
    throw Error(
      `Inspection did not report the fixture: ${run.status}: ${run.error ?? run.steps[0].output}`,
    );
  for (const name of [
    'list_project_files',
    'read_project_file',
    'search_project',
  ])
    if (
      !run.steps[0].toolCalls?.some(
        (call) =>
          call.name === name && call.status === 'completed' && call.turnId,
      )
    )
      throw Error(`Missing saved chat tool call: ${name}`);
  const events = await api('/api/runs/' + run.id + '/events');
  for (const name of [
    'list_project_files',
    'read_project_file',
    'search_project',
  ])
    if (!JSON.stringify(events).includes(`Planner used ${name}`))
      throw Error(`Missing actual tool call: ${name}`);
  if ((await readFile(path.join(source, 'src/config.txt'), 'utf8')) !== file)
    throw Error('Planner changed source.');
  await writeFile(
    'artifacts/planner-project-live-result.json',
    JSON.stringify(
      {
        run,
        verifiedTools: [
          'list_project_files',
          'read_project_file',
          'search_project',
        ],
        sourceUnchanged: true,
      },
      null,
      2,
    ),
  );
  console.log(
    'PASS: Codex read the selected host project using all three MCP tools; source unchanged.',
  );
} finally {
  if (run) await api('/api/runs/' + run.id + '/cancel', {}).catch(() => {});
  if (project)
    await api(
      '/api/projects/' + project.id,
      { status: 'disconnected' },
      'PATCH',
    ).catch(() => {});
  if (
    path.dirname(source) !== parent ||
    !/^AgentLoom-Planner-Test-\d+$/.test(path.basename(source))
  )
    throw Error('Unexpected cleanup path');
  await rm(source, { recursive: true, force: true });
}
