// Creates only a disposable fixture on the isolated pilot instance, never the main server.
import { mkdir, writeFile } from 'node:fs/promises';
const base = 'http://localhost:4319';
async function api(route, method = 'GET', body) {
  const response = await fetch(`${base}/api${route}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json();
  if (!response.ok) throw Error(JSON.stringify(value));
  return value;
}
const name = `council-jev-pilot-${Date.now()}`;
const files = {
  'package.json': JSON.stringify({
    name: 'jev-autonomous-pilot',
    private: true,
    type: 'module',
  }),
  'src/clamp.js': `export function clamp(value,min,max) {
 for(const x of [value,min,max]) if(typeof x!=='number'||!Number.isFinite(x))throw new TypeError('finite numbers required');
 if(min>max)throw new RangeError('inverted bounds');
 return Math.min(Math.max(value,min),max);
}
`,
  'tests/clamp.test.js': `import test from 'node:test';
import assert from 'node:assert/strict';
import {clamp} from '../src/clamp.js';
test('clamp bounds and preserve in-range value',()=>{assert.equal(clamp(-1,0,5),0);assert.equal(clamp(7,0,5),5);assert.equal(clamp(3,0,5),3);});
test('preserve signed zero at opposing zero boundary',()=>{assert.ok(Object.is(clamp(-0,0,1),-0));assert.ok(Object.is(clamp(+0,-1,-0),+0));assert.ok(Object.is(clamp(+0,-0,-0),+0));});
test('invalid arguments and range order',()=>{for(const bad of [null,undefined,'1',NaN,Infinity,-Infinity])for(let i=0;i<3;i++){const args=[1,0,2];args[i]=bad;assert.throws(()=>clamp(...args),TypeError);}assert.throws(()=>clamp(0,2,1),RangeError);assert.throws(()=>clamp(NaN,2,1),TypeError);});
`,
};
const job = await api('/project-imports', 'POST', { name, fileCount: 3 });
for (const [path, text] of Object.entries(files))
  await api(`/project-imports/${job.id}/files`, 'PUT', {
    path,
    data: Buffer.from(text).toString('base64'),
  });
await api(`/project-imports/${job.id}/complete`, 'POST', {});
const workflow = (await api('/workflows')).find(
  (w) => w.id === 'council-delivery',
);
workflow.id = 'jev-autonomous-repair-pilot';
workflow.name = 'Jev autonomous repair pilot';
workflow.description =
  'Disposable routing experiment with at most two repairs and no publishing.';
workflow.steps[0].instructions +=
  ' This is a fully specified authorized experiment. Return a concise AC1-AC4 plan ending PLAN_READY. First implementer pass preserves the seeded baseline for validation and council; later handoffs repair findings. No product decisions are missing.';
workflow.steps[1].name = 'Prepare baseline or repair';
workflow.steps[1].instructions =
  'Authorized disposable routing experiment. On the INITIAL attempt with no repair feedback, inspect and summarize the seeded baseline WITHOUT editing any files. The next validation and council must observe that baseline. Describe observations without a BLOCKED verdict on this baseline-preparation pass; the council owns the verdict. On a repair handoff with findings, implement the exact approved clamp behavior and meaningful regression tests in the two permitted files. Never change scope, package.json or validation commands. Do not commit or publish.';
workflow.steps[2].validation.commands = [
  { executable: 'node', args: ['--check', 'src/clamp.js'], timeoutMs: 30000 },
  {
    executable: 'node',
    args: ['--test', 'tests/clamp.test.js'],
    timeoutMs: 30000,
  },
];
await api(`/workflows/${workflow.id}`, 'PUT', workflow);
const task = `Disposable Jev routing experiment on an isolated server. The controller may start this specified task, return concrete findings for at most two repairs, and complete only this fixture after current recorded validation and council pass. No publication.
AC1: For primitive finite numeric inputs with min<=max, clamp(value,min,max) returns min if value<min, max if value>max, otherwise the original value including exact signed zero.
AC2: Invalid type or nonfinite argument in ANY position throws TypeError before comparing bound order.
AC3: Finite min>max throws RangeError; equal bounds use AC1 comparisons.
AC4: Maintain meaningful tests for both clamps, in-range values, both signed-zero boundaries, opposite-sign equal zero bounds, invalid arguments in every position, inverted bounds and validation precedence.
Only src/clamp.js and tests/clamp.test.js may change. package.json and dependencies remain unchanged. Initial baseline preparation intentionally does not edit seeded buggy code, so validation and council should detect it. Subsequent handoffs repair it. No UI, architecture or missing product decision. Commands: node --check src/clamp.js; node --test tests/clamp.test.js. Optional suggestions outside these criteria do not expand scope.`;
const run = await api('/runs', 'POST', {
  title: 'Jev controls baseline, repair and completion',
  task,
  project: name,
  workflowId: workflow.id,
  mode: 'live',
});
await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
await writeFile(
  new URL('../artifacts/jev-autonomous-run.json', import.meta.url),
  JSON.stringify(
    { id: run.id, project: name, url: `${base}/?run=${run.id}` },
    null,
    2,
  ),
);
console.log(run.id);
