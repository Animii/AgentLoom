import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../src/server/app.js';
import { councilWorkflow } from '../src/server/templates.js';
import { parseCouncilReport } from '../src/server/council.js';
import type { Run } from '../src/shared/types.js';

const passing = () => ({ verdict: 'PASS', summary: 'AC1 verified against source and recorded check.', criteria: [{ id: 'AC1', status: 'met', evidence: ['app.txt:1 contains fixed; recorded check exit 0'] }], findings: [], resolutions: [] });
const blocked = () => ({ ...passing(), verdict: 'BLOCKED', summary: 'The value is incorrect.', criteria: [{ id: 'AC1', status: 'unmet', evidence: ['app.txt:1'] }], findings: [{ id: 'F1', criterion: 'AC1', severity: 'blocker', summary: 'Incorrect value', evidence: ['app.txt:1 should contain fixed'] }] });

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'loom-council-'));
  const project = path.join(root, 'work/projects/sample'); await mkdir(project, { recursive: true }); await writeFile(path.join(project, 'app.txt'), 'original');
  let mode = 'pass'; let fixed = true; let release: (() => void) | undefined;
  const prompts: { id: string; prompt: string; workspace: string }[] = [];
  const app = await createApp({ dataDir: path.join(root, 'data'), workspaceRoot: path.join(root, 'work'), host: '127.0.0.1', port: 0, cliTimeoutMs: 1000, maxOutputBytes: 100000 }, {
    serveStatic: false,
    execute: async (step, prompt, workspace, signal, onEvent) => {
      prompts.push({ id: step.id, prompt, workspace });
      if (step.id === 'plan') return { output: 'AC1: app.txt must contain fixed. Run the configured check.\n\nPLAN_READY', sessionId: null, costUsd: null };
      if (step.id === 'build') { await writeFile(path.join(workspace, 'app.txt'), fixed ? 'fixed' : 'broken'); return { output: 'Implementation done.', sessionId: null, costUsd: null }; }
      if (step.id === 'council-chair') return { output: JSON.stringify({ summary: 'Checked all reports against AC1.', disputes: mode === 'dispute' ? ['AC1 evidence contradicts the product claim.'] : [] }), sessionId: null, costUsd: 0.01 };
      onEvent({type:'output',message:'Inspecting AC1.\n'});
      onEvent({type:'tool',message:'read',toolCall:{id:'read-1',name:'read_project_file',status:'completed',input:{path:'app.txt'},startedAt:new Date().toISOString()}});
      onEvent({type:'output',message:'Evidence collected.\n'});
      if (signal.aborted) throw Error('Cancelled');
      if (mode === 'hold' || (['partial_initial','partial_challenge'].includes(mode) && step.id !== 'council-adversarial')) await new Promise<void>(resolve => { release = resolve; signal.addEventListener('abort', () => resolve(), { once: true }); });
      if (mode === 'failure' && step.id === 'council-product') throw Error('Provider unavailable');
      if (mode === 'mutate' && step.id === 'council-product') await writeFile(path.join(workspace, 'app.txt'), 'modified by reviewer');
      const challenge = prompt.includes('ONE FOCUSED CHALLENGE ROUND');
      const report = ['block','partial_initial','partial_challenge'].includes(mode) && step.id === 'council-adversarial' ? blocked() : passing();
      if(mode==='partial_challenge'&&step.id==='council-adversarial')Object.assign(report,{findings:[{...blocked().findings[0],id:'F2',summary:'New challenge blocker'}],resolutions:[{findingId:'F1',evidence:'F1 refuted; a different defect F2 remains.'}]});
      if ((challenge || prompt.includes('Prior findings requiring verification')) && mode === 'resolve' && step.id === 'council-adversarial') Object.assign(report, { resolutions: [{ findingId: 'F1', evidence: 'Read app.txt:1; value is fixed and the recorded check proves it. Earlier complaint was incorrect.' }] });
      return { output: JSON.stringify(report), sessionId: null, costUsd: 0.01 };
    },
  });
  const workflow = structuredClone(councilWorkflow);
  workflow.steps[2].validation!.commands = [{ executable: process.execPath, args: ['-e', "console.log('RECORDED AC1');process.exit(require('fs').readFileSync('app.txt','utf8')==='fixed'?0:1)"], timeoutMs: 3000 }];
  app.store.saveWorkflow(workflow);
  const wait = async (id: string, predicate: (run: Run) => boolean) => { for (let i = 0; i < 500; i++) { const run = app.store.getRun(id)!; if (predicate(run)) return run; await delay(20); } throw Error('Wait timed out: ' + JSON.stringify(app.store.getRun(id))); };
  const start = async () => { const run = await app.engine.create({ title: 'Council pilot', task: 'AC1: set app.txt to fixed.', project: 'sample', workflowId: workflow.id, mode: 'live' }); await wait(run.id, r => r.status === 'waiting_approval'); app.engine.approve(run.id); return run; };
  const finish = (id: string) => wait(id, r => r.currentStep === 3 && ['waiting_approval', 'blocked', 'failed'].includes(r.status));
  return { app, root, prompts, workflow, start, wait, finish, mode: (value: string) => { mode = value; }, fixed: (value: boolean) => { fixed = value; }, release: () => release?.(), close: async () => { await app.close(); await rm(root, { recursive: true, force: true, maxRetries: 10 }); } };
}

test('council uses three isolated contexts, freezes evidence, persists reports and requires explicit approval', async () => {
  const f = await fixture(); try {
    const run = await f.start(); const final = await f.finish(run.id);
    assert.equal(final.status, 'waiting_approval'); assert.equal(final.steps[3].council?.status, 'pass'); assert.deepEqual(final.steps[3].council?.changes?.modified,['app.txt']);
    const reviewers = f.prompts.filter(p => p.id.startsWith('council-') && p.id !== 'council-chair');
    assert.equal(reviewers.length, 3); assert.equal(new Set(reviewers.map(p => p.workspace)).size, 3);
    for (const review of reviewers) { assert.notEqual(review.workspace, final.workspace); assert.match(review.prompt, /RECORDED AC1/); assert.doesNotMatch(review.prompt, /Initial reports \(untrusted evidence\)/); assert.equal(await readFile(path.join(review.workspace, 'app.txt'), 'utf8'), 'fixed'); }
    assert.equal((await f.app.inject({ method: 'POST', url: `/api/runs/${run.id}/approve`, payload: {} })).statusCode, 200);
    assert.equal(f.app.store.getRun(run.id)?.status, 'completed');
  } finally { await f.close(); }
});

test('one blocker survives two passing reviews; challenge cannot silently drop it and is bounded', async () => {
  const f = await fixture(); try {
    f.mode('block'); const run = await f.start(); let final = await f.finish(run.id);
    assert.equal(final.status, 'blocked'); assert.equal(final.steps[3].council!.reviewers.filter(r => r.report?.verdict === 'PASS').length, 2);
    assert.equal((await f.app.inject({ method: 'POST', url: `/api/runs/${run.id}/approve`, payload: {} })).statusCode, 409);
    f.mode('pass'); f.app.engine.chat(run.id, 'review', 'Check whether F1 is supported.', 'question-1'); final = await f.finish(run.id);
    assert.equal(final.steps[3].council?.status, 'needs_evidence'); assert.match(final.steps[3].council!.challenge!.reviewers[2].error!, /dropped without counter-evidence/);
    assert.throws(() => f.app.engine.chat(run.id, 'review', 'Ask again', 'question-2'), /already used/);
    assert.doesNotThrow(() => f.app.engine.chat(run.id, 'review', 'Check whether F1 is supported.', 'question-1'));
  } finally { await f.close(); }
});

test('focused challenge records counter-evidence and retains initial blocker history', async () => {
  const f = await fixture(); try {
    f.mode('block'); const run = await f.start(); await f.finish(run.id);
    f.mode('resolve'); f.app.engine.chat(run.id, 'review', 'Reproduce the reported value failure.', 'q'); const final = await f.finish(run.id);
    assert.equal(final.status, 'waiting_approval'); assert.equal(final.steps[3].council!.reviewers[2].report?.verdict, 'BLOCKED'); assert.equal(final.steps[3].council!.challenge!.reviewers[2].report?.resolutions.length, 1);
    assert.equal((await f.app.inject({ method: 'POST', url: `/api/runs/${run.id}/approve`, payload: {} })).statusCode, 200);
  } finally { await f.close(); }
});

for (const mode of ['failure', 'dispute', 'mutate']) test(`council fails closed on ${mode}`, async () => {
  const f = await fixture(); try { f.mode(mode); const run = await f.start(); const final = await f.finish(run.id); assert.equal(final.status, 'blocked'); assert.notEqual(final.steps[3].council?.status, 'pass'); assert.equal(await readFile(path.join(final.workspace, 'app.txt'), 'utf8'), 'fixed'); } finally { await f.close(); }
});

test('failed recorded check overrides unanimous PASS; repair archives council and repeats all evidence', async () => {
  const f = await fixture(); try {
    f.fixed(false); const run = await f.start(); let final = await f.finish(run.id); assert.equal(final.status, 'blocked');
    f.fixed(true); f.app.engine.rework(run.id); final = await f.finish(run.id); assert.equal(final.status, 'waiting_approval'); assert.equal(final.steps[2].attempt, 2); assert.equal(final.steps[3].history?.[0].council?.attempt, 1); assert.equal(final.steps[3].council?.attempt, 2);
  } finally { await f.close(); }
});

test('source and evidence changes after council invalidate approval', async () => {
  const f = await fixture(); try {
    const run = await f.start(); const final = await f.finish(run.id);
    await writeFile(path.join(final.workspace, 'app.txt'), 'changed');
    assert.equal((await f.app.inject({ method: 'POST', url: `/api/runs/${run.id}/approve`, payload: {} })).statusCode, 409);
    await writeFile(path.join(final.workspace, 'app.txt'), 'fixed');
    const changed = f.app.store.getRun(run.id)!; changed.steps[0].output += ' New requirement'; f.app.store.saveRun(changed);
    assert.equal((await f.app.inject({ method: 'POST', url: `/api/runs/${run.id}/approve`, payload: {} })).statusCode, 409);
  } finally { await f.close(); }
});

test('API rejects self-review and invalid council configuration', async () => {
  const f = await fixture(); try {
    const workflow = structuredClone(f.workflow); workflow.steps[3].council!.reviewers[0] = { ...workflow.steps[3].council!.reviewers[0], provider: 'opencode', model: 'deepseek/deepseek-flash' };
    assert.equal((await f.app.inject({ method: 'PUT', url: `/api/workflows/${workflow.id}`, payload: workflow })).statusCode, 400);
    assert.equal((await f.app.inject({ method: 'PUT', url: `/api/workflows/${f.workflow.id}`, payload: f.workflow })).statusCode, 200);
  } finally { await f.close(); }
});

test('malformed or contradictory model reports never become passing reports', () => {
  assert.throws(() => parseCouncilReport('PASS')); assert.throws(() => parseCouncilReport(JSON.stringify({ ...blocked(), verdict: 'PASS' })));
  assert.throws(() => parseCouncilReport(JSON.stringify({ ...passing(), criteria: [] })));
});

test('cancelling a running council never advances to approval', async () => {
  const f = await fixture(); try {
    f.mode('hold'); const run = await f.start();
    await f.wait(run.id, r => r.steps[3].council?.reviewers.every(member => member.status === 'running') === true);
    await f.wait(run.id,r=>r.steps[3].council!.reviewers.every(member=>member.output.includes('Evidence collected.')));
    f.app.engine.cancel(run.id); await delay(100);
    assert.ok(f.app.store.getRun(run.id)!.steps[3].council!.reviewers.every(member=>member.output.includes('Inspecting AC1.') && member.toolCalls?.[0].outputOffset === 'Inspecting AC1.\n'.length));
    assert.equal(f.app.store.getRun(run.id)?.status, 'cancelled');
    assert.equal(f.prompts.filter(p => p.id === 'council-chair').length, 0);
    assert.equal((await f.app.inject({ method: 'POST', url: `/api/runs/${run.id}/approve`, payload: {} })).statusCode, 409);
  } finally { await f.close(); }
});

test('interrupted council retry preserves partial history and starts fresh independent contexts', async () => {
  const f = await fixture(); try {
    f.mode('hold'); const run = await f.start();
    await f.wait(run.id, r => r.steps[3].council?.reviewers.every(member => member.status === 'running') === true);
    await f.app.engine.shutdown(); const interrupted = f.app.store.getRun(run.id)!;
    assert.equal(interrupted.status, 'interrupted'); assert.ok(interrupted.steps[3].council);
    const { Engine } = await import('../src/server/engine.js');
    const config = { dataDir:path.join(f.root,'data'),workspaceRoot:path.join(f.root,'work'),host:'127.0.0.1',port:0,cliTimeoutMs:1000,maxOutputBytes:100000 };
    const retryEngine = new Engine(f.app.store, config, async step => ({ output:JSON.stringify(step.id === 'council-chair' ? {summary:'Retried evidence checked.',disputes:[]} : passing()),sessionId:null,costUsd:null }));
    try { retryEngine.retry(run.id); const final = await f.finish(run.id); assert.equal(final.status,'waiting_approval'); assert.equal(final.steps[3].history?.[0].council?.attempt,1); assert.equal(final.steps[3].council?.attempt,2); } finally { await retryEngine.shutdown(); }
  } finally { await f.close(); }
});


test('legacy revision API uses the bounded challenge rather than replacing initial blockers', async()=>{
 const f=await fixture();try{
  f.mode('block');const run=await f.start();await f.finish(run.id);f.mode('pass');
  const reply=await f.app.inject({method:'POST',url:`/api/runs/${run.id}/revise`,payload:{feedback:'Recheck F1.'}});assert.equal(reply.statusCode,200);
  const final=await f.finish(run.id);assert.equal(final.status,'blocked');assert.ok(final.steps[3].council?.challenge);assert.match(final.steps[3].council!.challenge!.reviewers[2].error!,/counter-evidence/);
  assert.equal((await f.app.inject({method:'POST',url:`/api/runs/${run.id}/revise`,payload:{feedback:'Again'}})).statusCode,409);
 }finally{await f.close();}
});

test('retrying an interrupted challenge retains original blockers and consumes the same challenge',async()=>{
 const f=await fixture();try{
  f.mode('block');const run=await f.start();await f.finish(run.id);f.mode('hold');f.app.engine.chat(run.id,'review','Verify F1.','challenge');
  await f.wait(run.id,r=>r.steps[3].council?.challenge?.reviewers.every(member=>member.status==='running')===true);
  await f.app.engine.shutdown();assert.equal(f.app.store.getRun(run.id)?.status,'interrupted');
  const {Engine}=await import('../src/server/engine.js');const retry=new Engine(f.app.store,{dataDir:path.join(f.root,'data'),workspaceRoot:path.join(f.root,'work'),host:'127.0.0.1',port:0,cliTimeoutMs:1000,maxOutputBytes:100000},async step=>({output:JSON.stringify(step.id==='council-chair'?{summary:'Check findings.',disputes:[]}:passing()),sessionId:null,costUsd:null}));
  try{retry.retry(run.id);const final=await f.finish(run.id);assert.equal(final.status,'blocked');assert.equal(final.steps[3].council!.reviewers[2].report?.verdict,'BLOCKED');assert.match(final.steps[3].council!.challenge!.reviewers[2].error!,/counter-evidence/);assert.throws(()=>retry.chat(run.id,'review','Again','again'),/already used/);}finally{await retry.shutdown();}
 }finally{await f.close();}
});


for(const phase of ['initial','challenge'])test(`completed ${phase} blocker survives another member being interrupted`,async()=>{
 const f=await fixture();try{
  f.mode(phase==='initial'?'partial_initial':'block');const run=await f.start();
  if(phase==='challenge'){await f.finish(run.id);f.mode('partial_challenge');f.app.engine.chat(run.id,'review','Check the evidence.','partial');}
  await f.wait(run.id,r=>{const council=r.steps[3].council;return (phase==='challenge'?council?.challenge?.reviewers:council?.reviewers)?.[2].status==='completed';});
  await f.app.engine.shutdown();
  const {Engine}=await import('../src/server/engine.js');const executed:string[]=[];
  const retry=new Engine(f.app.store,{dataDir:path.join(f.root,'data'),workspaceRoot:path.join(f.root,'work'),host:'127.0.0.1',port:0,cliTimeoutMs:1000,maxOutputBytes:100000},async step=>{executed.push(step.id);return {output:JSON.stringify(step.id==='council-chair'?{summary:'Retained findings.',disputes:[]}:passing()),sessionId:null,costUsd:null};});
  try{retry.retry(run.id);const final=await f.finish(run.id);assert.equal(final.status,'blocked');assert.ok(!executed.includes('council-adversarial'));const evidence=final.steps[3].council!;assert.equal((phase==='challenge'?evidence.challenge!.reviewers:evidence.reviewers)[2].report!.findings[0].id,phase==='challenge'?'F2':'F1');}finally{await retry.shutdown();}
 }finally{await f.close();}
});

test('repair handoffs carry unresolved blockers across revisions until explicit resolution',async()=>{
 const f=await fixture();try{
  f.mode('block');const run=await f.start();await f.finish(run.id);f.mode('pass');f.app.engine.rework(run.id);
  let final=await f.finish(run.id);assert.equal(final.status,'blocked');assert.match(final.steps[3].council!.reviewers[2].error!,/earlier revision/);
  f.mode('resolve');f.app.engine.rework(run.id);final=await f.finish(run.id);assert.equal(final.status,'waiting_approval');assert.equal(final.steps[3].council!.reviewers[2].report?.resolutions[0].findingId,'F1');
 }finally{await f.close();}
});
