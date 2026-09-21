import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {createApp} from '../src/server/app.js';
import {councilWorkflow} from '../src/server/templates.js';
import type {Run} from '../src/shared/types.js';
const exec=promisify(execFile);
async function fixture(options:{repair?:boolean;alwaysBroken?:boolean;confidence?:number;publishFails?:boolean;failReview?:boolean;missingEvidence?:boolean;beforeDecision?:()=>Promise<void>}={}){
 const root=await mkdtemp(path.join(tmpdir(),'loom-auto-'));const source=path.join(root,'projects','fixture');await mkdir(source,{recursive:true});
 const git=(args:string[])=>exec('git',args,{cwd:source,windowsHide:true});
 await git(['init','-b','main']);await git(['config','user.name','Fixture']);await git(['config','user.email','fixture@example.invalid']);await writeFile(path.join(source,'app.txt'),'original');await git(['add','.']);await git(['commit','-m','Initial']);await git(['remote','add','origin','https://github.com/fixture/project.git']);
 let builds=0,publishes=0,fail=!!options.publishFails;
 const app=await createApp({dataDir:path.join(root,'data'),workspaceRoot:path.join(root,'work'),projectRoot:path.join(root,'projects'),host:'127.0.0.1',port:0,cliTimeoutMs:1000,maxOutputBytes:100000},{serveStatic:false,
  publishPr:async run=>{publishes++;if(fail)throw Error('GitHub authentication unavailable');assert.ok(run.git?.approvedTree);return {url:'https://github.com/fixture/project/pull/1',commit:'a'.repeat(40)};},
  jevFetch:async(_url,init)=>{const body=JSON.parse(String(init?.body));if(body.questions.action)await options.beforeDecision?.();const state=JSON.parse(body.state);const choice=state.council?.status==='pass'?'complete':'return_to_implementer';return new Response(JSON.stringify({model:'jev-test',answers:Object.fromEntries(Object.entries(body.questions as Record<string,{type:string}>).map(([id,q])=>[id,q.type==='noul'?{type:'noul',noul:0.9}:{type:'choice',choice,confidence:options.confidence??0.9,probabilities:{complete:choice==='complete'?0.9:0.05,return_to_implementer:choice==='return_to_implementer'?0.9:0.05,request_clarification:0.05}}]))}));},
  execute:async(step,_prompt,workspace)=>{
   if(step.id==='plan')return {output:'AC1: change app.txt to fixed.\n\nPLAN_READY',sessionId:null,costUsd:null};
   if(step.id==='build'){builds++;await writeFile(path.join(workspace,'app.txt'),options.alwaysBroken||options.repair&&builds===1?'broken':'fixed');return {output:'Implementation ready.',sessionId:null,costUsd:null};}
   if(step.id==='council-chair')return {output:JSON.stringify({summary:'Reviewed reports.',disputes:[]}),sessionId:null,costUsd:null};
   if(options.failReview&&step.id==='council-product')throw Error('Required provider unavailable');
   if(options.missingEvidence&&step.id==='council-product')return {output:JSON.stringify({verdict:'NEEDS_EVIDENCE',summary:'Required observation unavailable.',criteria:[{id:'AC1',status:'unknown',evidence:['No usable observation.']}],findings:[],resolutions:[]}),sessionId:null,costUsd:null};
   const broken=options.alwaysBroken||options.repair&&builds===1;
   return {output:JSON.stringify({verdict:broken?'BLOCKED':'PASS',summary:broken?'Value is wrong.':'Value verified.',criteria:[{id:'AC1',status:broken?'unmet':'met',evidence:['app.txt:1 and recorded check']}],findings:broken?[{id:'F1',criterion:'AC1',severity:'blocker',summary:'Set the value to fixed.',evidence:['app.txt:1 is broken']}]:[],resolutions:builds>1?[{findingId:'F1',evidence:'app.txt is fixed; recorded assertion passes.'}]:[]}),sessionId:null,costUsd:null};
  }});
 const workflow=structuredClone(councilWorkflow);workflow.steps[2].validation!.commands=[{executable:process.execPath,args:['-e',"process.exit(require('fs').readFileSync('app.txt','utf8')==='fixed'?0:1)"],timeoutMs:3000}];app.store.saveWorkflow(workflow);
 await app.inject({method:'PUT',url:'/api/jev/settings',payload:{apiKey:'fixture-automation-key'}});
 const project=(await app.inject({method:'POST',url:'/api/projects',payload:{name:'Fixture',folder:'fixture',workspaceMode:'worktree'}})).json();
 const run=await app.engine.create({title:'Automated fix',task:'AC1: set app.txt to fixed.',project:project.id,workflowId:workflow.id,mode:'live',automation:{publication:'draft'}});
 const wait=async(predicate:(run:Run)=>boolean)=>{for(let i=0;i<1200;i++){const current=app.store.getRun(run.id)!;if(predicate(current))return current;await delay(25);}throw Error('Timed out: '+JSON.stringify(app.store.getRun(run.id)));};
 return {app,run,root,wait,builds:()=>builds,publishes:()=>publishes,allowPublish:()=>{fail=false;},close:async()=>{await app.close();await rm(root,{recursive:true,force:true,maxRetries:10});}};
}
test('approved plan repairs once, reruns real checks and council, then publishes the exact approved tree',async()=>{
 const f=await fixture({repair:true});try{await f.wait(r=>r.status==='waiting_approval');await delay(1100);assert.equal(f.builds(),0);assert.equal((await f.app.inject({method:'POST',url:`/api/runs/${f.run.id}/approve`,payload:{}})).statusCode,200);const done=await f.wait(r=>r.automation?.status==='done');assert.equal(done.status,'completed');assert.equal(done.automation?.repairsUsed,1);assert.deepEqual(done.automation?.decisions.map(d=>d.action),['repair','complete']);assert.equal(f.publishes(),1);assert.ok(done.git?.approvedTree);assert.equal(done.steps[2].validation?.status,'passed');}finally{await f.close();}
});
test('low confidence pauses and never publishes',async()=>{
 const f=await fixture({confidence:0.33});try{await f.wait(r=>r.status==='waiting_approval');await f.app.engine.approveCurrent(f.run.id);const paused=await f.wait(r=>r.automation?.status==='paused');assert.match(paused.automation!.message,/Low routing confidence/);assert.equal(paused.status,'waiting_approval');assert.equal(f.publishes(),0);}finally{await f.close();}
});
test('publication recovery retries GitHub without rerunning implementation or reviewers',async()=>{
 const f=await fixture({publishFails:true});try{await f.wait(r=>r.status==='waiting_approval');await f.app.engine.approveCurrent(f.run.id);await f.wait(r=>r.status==='completed'&&r.automation?.status==='paused');assert.equal(f.publishes(),1);f.allowPublish();assert.equal((await f.app.inject({method:'POST',url:`/api/runs/${f.run.id}/automation/resume`,payload:{}})).statusCode,200);await f.wait(r=>r.automation?.status==='done');assert.equal(f.publishes(),2);assert.equal(f.builds(),1);}finally{await f.close();}
});
test('persistent defects exhaust exactly two automatic repairs and retain a manual decision',async()=>{
 const f=await fixture({alwaysBroken:true});try{await f.wait(r=>r.status==='waiting_approval');await f.app.engine.approveCurrent(f.run.id);const paused=await f.wait(r=>r.automation?.status==='paused'&&r.automation.repairsUsed===2);assert.equal(f.builds(),3);assert.equal(f.publishes(),0);assert.equal(paused.status,'blocked');assert.match(paused.automation!.message,/repair limit/);}finally{await f.close();}
});

test('pausing during final filesystem freshness checks survives step completion',async()=>{
 const f=await fixture();let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let entered!:()=>void;const checking=new Promise<void>(resolve=>{entered=resolve;});
 const original=f.app.engine.assertValidationCurrent.bind(f.app.engine);f.app.engine.assertValidationCurrent=async id=>{entered();await gate;await original(id);};
 try{await f.wait(r=>r.status==='waiting_approval');await f.app.engine.approveCurrent(f.run.id);await checking;assert.equal((await f.app.inject({method:'POST',url:`/api/runs/${f.run.id}/automation/pause`,payload:{}})).statusCode,200);release();const run=await f.wait(r=>r.currentStep===3&&r.status==='waiting_approval');assert.equal(run.automation?.status,'paused');await delay(1200);assert.equal(f.publishes(),0);assert.equal(f.app.store.getRun(run.id)?.automation?.status,'paused');}finally{release();await f.close();}
});

for(const missingEvidence of [true,false])test(`confident repair cannot bypass ${missingEvidence?'explicitly missing evidence':'a missing required reviewer'}`,async()=>{
 const f=await fixture({alwaysBroken:true,failReview:!missingEvidence,missingEvidence});try{await f.wait(r=>r.status==='waiting_approval');await f.app.engine.approveCurrent(f.run.id);const paused=await f.wait(r=>r.automation?.status==='paused');assert.equal(paused.automation!.decisions[0].choice,'return_to_implementer');assert.equal(paused.automation!.repairsUsed,0);assert.equal(f.builds(),1);assert.equal(f.publishes(),0);}finally{await f.close();}
});

for(const takeover of [true,false])test(takeover?'manual takeover invalidates an in-flight Jev decision':'concurrent run update pauses instead of leaving routing stuck',async()=>{
 let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});const checking=new Promise<void>(resolve=>{entered=resolve;});const f=await fixture({beforeDecision:async()=>{entered();await gate;}});
 try{await f.wait(r=>r.status==='waiting_approval');await f.app.engine.approveCurrent(f.run.id);await checking;
  if(takeover)await f.app.inject({method:'POST',url:`/api/runs/${f.run.id}/automation/pause`,payload:{}});
  else{const changed=f.app.store.getRun(f.run.id)!;changed.title+=' (updated)';f.app.store.saveRun(changed);}
  release();const paused=await f.wait(r=>r.automation?.status==='paused');if(!takeover)assert.match(paused.automation!.message,/changed during routing/);await delay(1100);assert.equal(f.publishes(),0);assert.equal(f.app.store.getRun(f.run.id)!.automation!.decisions.length,0);
 }finally{release();await f.close();}
});

test('server restart pauses authorized automation without rerunning agents',async()=>{
 const f=await fixture({confidence:0.33});try{await f.wait(r=>r.status==='waiting_approval');await f.app.engine.approveCurrent(f.run.id);const paused=await f.wait(r=>r.automation?.status==='paused');paused.automation!.status='active';f.app.store.saveRun(paused);await f.app.close();
  const restarted=await createApp({dataDir:path.join(f.root,'data'),workspaceRoot:path.join(f.root,'work'),projectRoot:path.join(f.root,'projects'),host:'127.0.0.1',port:0,cliTimeoutMs:1000,maxOutputBytes:100000},{serveStatic:false,execute:async()=>{throw Error('Restart must not execute agents');}});
  try{const saved=restarted.store.getRun(f.run.id)!;assert.equal(saved.automation!.status,'paused');assert.match(saved.automation!.message,/Server restarted/);assert.equal(saved.status,'waiting_approval');}finally{await restarted.close();}
 }finally{await f.close();}
});

test('source edited while Jev is deciding cannot trigger a stale automatic repair',async()=>{
 let entered!:()=>void,release!:()=>void;const checking=new Promise<void>(resolve=>{entered=resolve;});const gate=new Promise<void>(resolve=>{release=resolve;});const f=await fixture({alwaysBroken:true,beforeDecision:async()=>{entered();await gate;}});
 try{await f.wait(r=>r.status==='waiting_approval');await f.app.engine.approveCurrent(f.run.id);await checking;await writeFile(path.join(f.app.store.getRun(f.run.id)!.workspace,'app.txt'),'user changed source');release();const paused=await f.wait(r=>r.automation?.status==='paused');assert.match(paused.automation!.message,/Source changed after review/);assert.equal(paused.automation!.repairsUsed,0);assert.equal(f.builds(),1);assert.equal(f.publishes(),0);}finally{release();await f.close();}
});
