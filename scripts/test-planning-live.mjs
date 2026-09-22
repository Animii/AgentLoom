import { writeFile } from 'node:fs/promises';
const base = 'http://localhost:4317';
async function api(path, body, method = 'POST') {
  const r = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!r.ok) throw Error(await r.text());
  return r.json();
}
const id = 'planning-live-' + Date.now();
const plan = {
  id: 'plan',
  name: 'Plan',
  role: 'product owner',
  provider: 'codex',
  model: '',
  effort: 'high',
  access: 'read-only',
  approval: true,
  planning: true,
  instructions:
    'Help the user agree a small documentation plan. Ask about audience and output format before drafting. Do not use tools or inspect files; this is a conversation-only validation.',
};
await api(
  '/api/workflows/' + id,
  {
    id,
    name: 'Planning chat live validation',
    description: 'Read-only planning and handoff verification.',
    updatedAt: new Date().toISOString(),
    steps: [
      plan,
      {
        ...plan,
        id: 'verify',
        name: 'Verify agreement',
        role: 'reviewer',
        planning: false,
        approval: false,
        instructions:
          'Do not use tools. From the approved plan, state the agreed audience, output format, and offline constraint. No implementation or changes.',
      },
    ],
  },
  'PUT',
);
const run = await api('/api/runs', {
  title: 'Live planning conversation validation',
  task: 'I want a short getting-started guide for a local application. Ask me the audience and format before planning; do not assume either.',
  project: 'welcome',
  workflowId: id,
  mode: 'live',
});
await writeFile(
  'artifacts/planning-live-id.json',
  JSON.stringify({ id: run.id, workflowId: id }),
);
async function wait() {
  for (let i = 0; i < 180; i++) {
    const r = await api('/api/runs/' + run.id, null, 'GET');
    if (!['queued', 'running'].includes(r.status)) return r;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw Error('timeout');
}
let r = await wait();
console.log('First status:', r.status, 'Reply:', r.steps[0].output);
if (r.status !== 'waiting_input') throw Error('Expected questions');
await api('/api/runs/' + run.id + '/messages', {
  stepId: 'plan',
  messageId: crypto.randomUUID(),
  message:
    'The audience is first-time local developers. Use a Markdown checklist of at most five items. Everything must work offline. No installation commands.',
});
r = await wait();
console.log('Second status:', r.status, 'Plan:', r.steps[0].output);
if (r.status === 'waiting_input') {
  await api('/api/runs/' + run.id + '/messages', {
    stepId: 'plan',
    messageId: crypto.randomUUID(),
    message:
      'The app is AgentLoom, already installed and running at localhost:4317 with a welcome project and browser open. The first task is to create a demo run, answer the planner, review its plan, and explicitly approve it. Success means the next demo step starts only after approval. Only a documentation plan, no implementation or file changes. Propose the checklist with this scope.',
  });
  r = await wait();
}
if (r.status !== 'waiting_approval') throw Error('Expected proposed plan');
if (r.steps[1].attempt !== 0) throw Error('Premature handoff');
await api('/api/runs/' + run.id + '/approve', {});
r = await wait();
console.log('Final:', r.status, 'Handoff:', r.steps[1].output);
if (r.status !== 'completed') throw Error('Handoff failed');
await writeFile(
  'artifacts/planning-live-result.json',
  JSON.stringify(r, null, 2),
);
