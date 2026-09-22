import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
await mkdir('artifacts', { recursive: true });
const base = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:4317';
const pilot = process.argv[2];
if (!pilot)
  throw Error(
    'Usage: node scripts/check-restart.mjs <existing waiting-approval run id>. This restarts the Compose service.',
  );
async function api(url, body, method = body ? 'POST' : 'GET') {
  const r = await fetch(base + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw Error(await r.text());
  return r.json();
}
const before = await api('/api/runs/' + pilot);
if (before.status !== 'waiting_approval') throw Error('Pilot must be paused');
const template = (await api('/api/workflows')).find(
  (w) => w.id === 'quick-review',
);
const id = 'restart-check';
await api(
  '/api/workflows/' + id,
  {
    ...template,
    id,
    name: 'Restart recovery check',
    description:
      'Eight automatic demo steps for testing interrupted-run recovery.',
    steps: Array.from({ length: 8 }, (_, i) => ({
      ...template.steps[0],
      id: 'step' + i,
      name: 'Checkpoint ' + (i + 1),
      approval: false,
    })),
  },
  'PUT',
);
const run = await api('/api/runs', {
  title: 'E2E restart recovery',
  task: 'Demo-only recovery validation',
  project: 'welcome',
  workflowId: id,
  mode: 'demo',
});
console.log('Restarting with active demo', run.id);
execFileSync('docker', ['compose', 'restart', 'platform'], {
  stdio: 'inherit',
});
for (let i = 0; i < 30; i++) {
  try {
    await api('/api/health');
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 500));
  }
}
const interrupted = await api('/api/runs/' + run.id);
const preserved = await api('/api/runs/' + pilot);
if (interrupted.status !== 'interrupted')
  throw Error('Expected interrupted, got ' + interrupted.status);
if (
  preserved.status !== 'waiting_approval' ||
  preserved.steps[preserved.currentStep].output !==
    before.steps[before.currentStep].output
)
  throw Error('Approval not preserved');
console.log('Interrupted state and pending approval preserved');
await api('/api/runs/' + run.id + '/retry', {});
let recovered;
for (let i = 0; i < 30; i++) {
  recovered = await api('/api/runs/' + run.id);
  if (recovered.status === 'completed') break;
  await new Promise((r) => setTimeout(r, 500));
}
if (recovered.status !== 'completed') throw Error('Recovery did not complete');
await writeFile(
  'artifacts/restart.json',
  JSON.stringify(
    {
      runId: run.id,
      interrupted: interrupted.status,
      retried: recovered.status,
      pilotPreserved: preserved.status,
    },
    null,
    2,
  ),
);
console.log('Explicit retry completed all eight steps');
