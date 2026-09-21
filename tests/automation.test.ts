import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {createApp} from '../src/server/app.js';
import {councilWorkflow,singleReviewWorkflow} from '../src/server/templates.js';
import type {Run} from '../src/shared/types.js';
const exec=promisify(execFile);
async function fixture(options:{escalation?:boolean;warning?:boolean;testsFail?:boolean;single?:boolean;repair?:boolean;alwaysBroken?:boolean;confidence?:number;publishFails?:boolean;failReview?:boolean;missingEvidence?:boolean;beforeDecision?:()=>Promise<void>}={}){
 const root=await mkdtemp(path.join(tmpdir(),'loom-auto-'));const source=path.join(root,'projects','fixture');await mkdir(source,{recursive:true});
 const git=(args:string[])=>exec('git',args,{cwd:source,windowsHide:true});
 await git(['init','-b','main']);await git(['config','user.name','Fixture']);await git(['config','user.email','fixture@example.invalid']);await writeFile(path.join(source,'app.txt'),'original');await git(['add','.']);await git(['commit','-m','Initial']);await git(['remote','add','origin','https://github.com/fixture/project.git']);
 const profiles:string[]=[],packets:any[]=[];let builds=0,publishes=0,fail=!!options.publishFails;
 const app=await createApp({dataDir:path.join(root,'data'),workspaceRoot:path.join(root,'work'),projectRoot:path.join(root,'projects'),host:'127.0.0.1',port:0,cliTimeoutMs:1000,maxOutputBytes:100000},{serveStatic:false,
  publishPr:async run=>{publishes++;if(fail)throw Error('GitHub authentication unavailable');assert.ok(run.git?.approvedTree);return {url:'https://github.com/fixture/project/pull/1',commit:'a'.repeat(40)};},
  jevFetch:async(_url,init)=>{const body=JSON.parse(String(init?.body));if(body.questions.action)await options.beforeDecision?.();const state=JSON.parse(body.state);const offered=body.questions.action?.criteria??{};const choice=state.council?.status==='pass'?'complete':offered.return_to_implementer?'return_to_implementer':offered.escalate_to_fable?'escalate_to_fable':'request_clarification';return new Response(JSON.stringify({model:'jev-test',answers:Object.fromEntries(Object.entries(body.questions as Record<string,{type:string}>).map(([id,q])=>[id,q.type==='noul'?{type:'noul',noul:0.9}:{type:'choice',choice,confidence:options.confidence??0.9,probabilities:Object.fromEntries(Object.keys(offered).map(key=>[key,key===choice?0.9:0.1]))}]))}));},
  execute:async(step,_prompt,workspace)=>{
   if(step.id==='plan')return {output:'AC1: change app.txt to fixed.\n\nPLAN_READY',sessionId:null,costUsd:null};
   if(step.id==='build'){builds++;profiles.push(step.model);const packetPath=/complete recorded process evidence at ("[^\n]+?") \(SHA-256/.exec(_prompt)?.[1];if(packetPath)packets.push(JSON.parse(await readFile(JSON.parse(packetPath),'utf8')));await writeFile(path.join(workspace,'app.txt'),options.alwaysBroken||options.repair&&builds===1||options.escalation&&step.provider!=='claude'?'broken':'fixed');return {output:'Implementation ready.',sessionId:null,costUsd:null};}
   if(step.id==='council-chair')return {output:JSON.stringify({summary:'Reviewed reports.',disputes:[]}),sessionId:null,costUsd:null};
   if(options.failReview&&step.id==='council-product')throw Error('Required provider unavailable');
   if(options.missingEvidence&&step.id==='council-product')return {output:JSON.stringify({verdict:'NEEDS_EVIDENCE',summary:'Required observation unavailable.',criteria:[{id:'AC1',status:'unknown',evidence:['No usable observation.']}],findings:[],resolutions:[]}),sessionId:null,costUsd:null};
   const broken=options.alwaysBroken||options.repair&&builds===1||options.escalation&&profiles.at(-1)!=='claude-fable-5-1';
   return {output:JSON.stringify({verdict:broken?'BLOCKED':'PASS',summary:broken?'Value is wrong.':'Value verified.',criteria:[{id:'AC1',status:broken?'unmet':'met',evidence:['app.txt:1 and recorded check']},...(options.single?[{id:'SCOPE',status:'met',evidence:['Only app.txt changed.']}]:[])],findings:options.warning?[{id:'W1',criterion:'AC1',severity:'warning',summary:'Optional naming suggestion.',evidence:['app.txt']}]:broken?[{id:'F1',criterion:'AC1',severity:'blocker',summary:'Set the value to fixed.',evidence:['app.txt:1 is broken']}]:[],resolutions:builds>1?[{findingId:'F1',evidence:'app.txt is fixed; recorded assertion passes.'}]:[]}),sessionId:null,costUsd:null};
  }});
 const workflow=structuredClone(options.single?singleReviewWorkflow:councilWorkflow);workflow.steps[2].validation!.commands=[{executable:process.execPath,args:['-e',options.testsFail?"process.exit(1)":"console.log('RECORDED_EARLY_OUTPUT');process.exit(require('fs').readFileSync('app.txt','utf8')==='fixed'?0:1)"],timeoutMs:3000}];app.store.saveWorkflow(workflow);
 await app.inject({method:'PUT',url:'/api/jev/settings',payload:{apiKey:'fixture-automation-key'}});
 const project=(await app.inject({method:'POST',url:'/api/projects',payload:{name:'Fixture',folder:'fixture',workspaceMode:'worktree'}})).json();
 const run=await app.engine.create({title:'Automated fix',task:'AC1: set app.txt to fixed.',project:project.id,workflowId:workflow.id,mode:'live',automation:{publication:'draft',...(options.escalation?{escalation:'fable' as const}:{})}});
 const wait=async(predicate:(run:Run)=>boolean)=>{for(let i=0;i<1200;i++){const current=app.store.getRun(run.id)!;if(predicate(current))return current;await delay(25);}throw Error('Timed out: '+JSON.stringify(app.store.getRun(run.id)));};
 return {profiles,packets,app,run,root,wait,builds:()=>builds,publishes:()=>publishes,allowPublish:()=>{fail=false;},close:async()=>{await app.close();await rm(root,{recursive:true,force:true,maxRetries:10});}};
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
 const f=await fixture({alwaysBroken:true,failReview:!missingEvidence,missingEvidence});try{await f.wait(r=>r.status==='waiting_approval');await f.app.engine.approveCurrent(f.run.id);const paused=await f.wait(r=>r.automation?.status==='paused');assert.equal(paused.automation!.decisions[0].choice,'request_clarification');assert.deepEqual(paused.automation!.decisions[0].offeredActions,['request_clarification']);assert.equal(paused.automation!.repairsUsed,0);assert.equal(f.builds(),1);assert.equal(f.publishes(),0);}finally{await f.close();}
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

test('single reviewer repairs once and publishes with no chair invocation',async()=>{
 const f=await fixture({single:true,repair:true});try{await f.wait(r=>r.status==='waiting_approval');await f.app.engine.approveCurrent(f.run.id);const done=await f.wait(r=>r.automation?.status==='done');assert.equal(done.automation?.repairsUsed,1);assert.equal(done.steps[3].council?.reviewers.length,1);assert.equal(done.steps[3].council?.chair,undefined);assert.equal(done.steps[3].council?.reviewers[0].report?.resolutions[0].findingId,'F1');assert.equal(f.publishes(),1);assert.equal(done.steps[2].validation?.status,'passed');}finally{await f.close();}
});
test('single review retains two-repair limit and unresolved finding after failed fixes',async()=>{
 const f=await fixture({single:true,alwaysBroken:true});try{await f.wait(r=>r.status==='waiting_approval');await f.app.engine.approveCurrent(f.run.id);const stopped=await f.wait(r=>r.automation?.status==='paused'&&r.automation.repairsUsed===2);assert.equal(f.builds(),3);assert.equal(f.publishes(),0);assert.equal(stopped.status,'blocked');assert.equal(stopped.steps[3].council?.reviewers[0].report?.findings[0].id,'F1');}finally{await f.close();}
});


test('two Flash repairs escalate once to Fable, preserve evidence and rerun independent Astra review',async()=>{
 const f=await fixture({single:true,escalation:true});try{
  await f.wait(r=>r.status==='waiting_approval');await f.app.engine.approveCurrent(f.run.id);
  const done=await f.wait(r=>r.automation?.status==='done');
  assert.deepEqual(f.profiles,['deepseek/deepseek-flash','deepseek/deepseek-flash','deepseek/deepseek-flash','claude-fable-5-1']);
  assert.deepEqual(done.automation!.decisions.map(d=>d.action),['repair','repair','escalate','complete']);
  assert.equal(done.automation!.repairsUsed,2);assert.equal(done.automation!.escalation?.used,true);
  assert.equal(done.steps[1].definition.model,'deepseek/deepseek-flash');assert.equal(done.steps[1].execution?.model,'claude-fable-5-1');
  assert.equal(done.steps[3].council?.reviewers[0].member.model,'gpt-6-astra');
  assert.equal(f.packets[3].validation[0].history.length,3);
  assert.match(f.packets[3].validation[0].history[0].commands[0].output,/RECORDED_EARLY_OUTPUT/);
  assert.ok(done.steps[3].council?.validationPacketHash);
  await assert.rejects(f.app.engine.secondOpinion(f.run.id,'Ask Fable'),/implemented/);
  assert.equal(f.publishes(),1);
 }finally{await f.close();}
});

test('failed Fable rescue stops with all blockers retained and no further automatic attempts',async()=>{
 const f=await fixture({single:true,escalation:true,alwaysBroken:true});try{
  await f.wait(r=>r.status==='waiting_approval');await f.app.engine.approveCurrent(f.run.id);
  const stopped=await f.wait(r=>r.automation?.status==='paused');
  assert.equal(f.builds(),4);assert.equal(stopped.automation!.escalation!.used,true);assert.equal(f.publishes(),0);
  assert.deepEqual(stopped.automation!.decisions.at(-1)!.offeredActions,['request_clarification']);
  assert.throws(()=>f.app.engine.rework(f.run.id,'escalate'),/unavailable or already used/);
  assert.throws(()=>f.app.engine.rework(f.run.id,true),/budget exhausted/);
 }finally{await f.close();}
});

test('warnings never offer a repair action and failed tests never offer completion',async()=>{
 for(const testsFail of [false,true]){const f=await fixture({single:true,warning:true,testsFail});try{
  await f.wait(r=>r.status==='waiting_approval');await f.app.engine.approveCurrent(f.run.id);
  const run=await f.wait(r=>['done','paused'].includes(r.automation!.status));
  assert.deepEqual(run.automation!.decisions[0].offeredActions,testsFail?['request_clarification']:['request_clarification','complete']);
  assert.equal(f.builds(),1);assert.equal(f.publishes(),testsFail?0:1);
 }finally{await f.close();}}
});
