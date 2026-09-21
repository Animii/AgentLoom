import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createApp} from '../src/server/app.js';
import {singleReviewWorkflow} from '../src/server/templates.js';
import type {Run} from '../src/shared/types.js';

async function fixture(){
 const root=await mkdtemp(path.join(tmpdir(),'loom-single-'));
 await mkdir(path.join(root,'work/projects/sample'),{recursive:true});await writeFile(path.join(root,'work/projects/sample/app.txt'),'fixed');
 let mode='pass';const calls:string[]=[];
 const app=await createApp({dataDir:path.join(root,'data'),workspaceRoot:path.join(root,'work'),host:'127.0.0.1',port:0,cliTimeoutMs:1000,maxOutputBytes:100000},{serveStatic:false,execute:async(step,prompt)=>{
  calls.push(step.id);
  if(step.id==='plan')return {output:'AC1: app.txt is fixed. AC2: only app.txt is in scope.\nPLAN_READY',sessionId:null,costUsd:null};
  if(step.id==='build')return {output:'Ready for verification.',sessionId:null,costUsd:null};
  if(step.id==='council-chair')return {output:JSON.stringify({summary:'Reports compared; original findings still require resolution.',disputes:[]}),sessionId:null,costUsd:null};
  if(mode==='fail')throw Error('Provider unavailable');
  const blocked=mode==='block'&&step.id==='council-correctness';
  const secondBlocked=mode==='second-block'&&step.id==='council-second-opinion';
  const report={verdict:blocked||secondBlocked?'BLOCKED':'PASS',summary:blocked||secondBlocked?'Verify the value.':'Value and scope verified.',criteria:(mode==='omit'?['AC1','SCOPE']:['AC1','AC2','SCOPE']).map(id=>({id,status:blocked||secondBlocked?'unmet':'met',evidence:['app.txt:1, recorded command']})),findings:blocked||secondBlocked?[{id:'F1',criterion:'AC1',severity:'blocker',summary:'Reported value mismatch',evidence:['app.txt:1']}]:[],resolutions:mode==='resolve'&&prompt.includes('ONE FOCUSED CHALLENGE ROUND')&&step.id==='council-correctness'?[{findingId:'F1',evidence:'Read app.txt and verified fixed; original claim was incorrect.'}]:[]};
  return {output:JSON.stringify(report),sessionId:null,costUsd:null};
 }});
 const workflow=structuredClone(singleReviewWorkflow);workflow.steps[2].validation!.commands=[{executable:process.execPath,args:['-e',"if(require('fs').readFileSync('app.txt','utf8')!=='fixed')process.exit(1)"],timeoutMs:3000}];
 const saved=await app.inject({method:'PUT',url:`/api/workflows/${workflow.id}`,payload:workflow});assert.equal(saved.statusCode,200,saved.body);
 const wait=async(id:string,predicate:(r:Run)=>boolean)=>{for(let n=0;n<600;n++){const r=app.store.getRun(id)!;if(predicate(r))return r;await delay(20);}throw Error('Timed out: '+JSON.stringify(app.store.getRun(id)));};
 const start=async()=>{const run=await app.engine.create({title:'Single review',task:'AC1: value fixed. AC2: scope app.txt.',project:'sample',workflowId:workflow.id,mode:'live'});await wait(run.id,r=>r.status==='waiting_approval');await app.engine.approveCurrent(run.id);return wait(run.id,r=>r.currentStep===3&&['blocked','waiting_approval'].includes(r.status));};
 return {app,calls,start,wait,mode:(value:string)=>{mode=value;},close:async()=>{await app.close();await rm(root,{recursive:true,force:true,maxRetries:10});}};
}

test('single structured review runs once, skips synthesis and guards source freshness',async()=>{
 const f=await fixture();try{const run=await f.start();assert.equal(run.status,'waiting_approval');assert.deepEqual(f.calls,['plan','build','council-correctness']);assert.equal(run.steps[3].council?.chair,undefined);await writeFile(path.join(run.workspace,'app.txt'),'changed');await assert.rejects(f.app.engine.approveCurrent(run.id),/stale|changed/);}finally{await f.close();}
});

test('PASS cannot omit an approved acceptance criterion',async()=>{
 const f=await fixture();try{f.mode('omit');const run=await f.start();assert.equal(run.status,'blocked');assert.match(run.steps[3].council!.reviewers[0].error!,/AC2.*missing/);assert.throws(()=>f.app.engine.approve(run.id));assert.equal(f.calls.includes('council-chair'),false);}finally{await f.close();}
});

test('second opinion preserves original blocker, runs once, then explicit challenge resolves it',async()=>{
 const f=await fixture();try{f.mode('block');let run=await f.start();const original=structuredClone(run.steps[3].council!.reviewers[0]);
  await f.app.engine.secondOpinion(run.id,'Independently check the disputed value.');run=await f.wait(run.id,r=>r.currentStep===3&&r.status==='blocked');
  assert.deepEqual(run.steps[3].council!.reviewers[0],original);assert.deepEqual(f.calls.slice(2),['council-correctness','council-second-opinion','council-chair']);
  assert.equal(run.steps[3].council!.reviewers[1].report!.verdict,'PASS');await assert.rejects(f.app.engine.secondOpinion(run.id,'Repeat'),/already used/);
  f.mode('resolve');f.app.engine.chat(run.id,'review','Reproduce the original F1 claim.','challenge-1');run=await f.wait(run.id,r=>r.currentStep===3&&r.status==='waiting_approval');assert.equal(run.steps[3].council!.challenge!.reviewers.length,2);assert.equal(run.steps[3].council!.challenge!.reviewers[0].report!.resolutions[0].findingId,'F1');
  await f.app.engine.approveCurrent(run.id);assert.equal(f.app.store.getRun(run.id)!.status,'completed');
 }finally{await f.close();}
});

test('additional reviewer obligations survive repair and cannot be silently removed',async()=>{
 const f=await fixture();try{let run=await f.start();f.mode('second-block');await f.app.engine.secondOpinion(run.id,'Check for a missed defect.');await f.wait(run.id,r=>r.status==='blocked');
  f.mode('pass');f.app.engine.rework(run.id);run=await f.wait(run.id,r=>r.currentStep===3&&r.status==='blocked');
  assert.equal(run.steps[3].council!.reviewers.length,2);assert.match(run.steps[3].council!.reviewers[1].error!,/F1.*dropped/);assert.ok(run.steps[3].council!.obligations!.some(o=>o.memberId==='second-opinion'));await assert.rejects(f.app.engine.approveCurrent(run.id));
 }finally{await f.close();}
});

test('a failed single reviewer is recoverable without bypassing review or running a chair',async()=>{
 const f=await fixture();try{f.mode('fail');let run=await f.start();assert.equal(run.status,'blocked');await assert.rejects(f.app.engine.secondOpinion(run.id,'Replace it'),/Recover/);
  // A focused evidence request re-executes the failed review against the same source.
  f.mode('pass');f.app.engine.chat(run.id,'review','Retry the unavailable reviewer.','retry-1');run=await f.wait(run.id,r=>r.currentStep===3&&r.status==='waiting_approval');assert.equal(run.steps[3].council!.challenge!.reviewers.length,1);assert.equal(f.calls.includes('council-chair'),false);
 }finally{await f.close();}
});
