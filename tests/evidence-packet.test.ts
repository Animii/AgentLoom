import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Run } from '../src/shared/types.js';
import { validationPacket, writeEvidencePacket } from '../src/server/evidence-packet.js';
import { automationContract } from '../src/server/automation-contract.js';
import { canEscalate, FABLE_REPAIR } from '../src/shared/automation.js';
import { singleReviewWorkflow } from '../src/server/templates.js';

function run(): Run {
  return { id:'packet-test', title:'Evidence', task:'AC1', project:'sample', workflowId:'test', workflowName:'Test', mode:'live', status:'blocked', currentStep:3, createdAt:'', updatedAt:'', workspace:'', error:null,
    automation:{version:1,publication:'draft',status:'active',repairsUsed:2,maxRepairs:2,message:'',decisions:[],approvedAt:'approved',escalation:{...FABLE_REPAIR,used:false}},
    steps:singleReviewWorkflow.steps.map(definition=>({definition:structuredClone(definition),status:'completed',attempt:1,output:definition.planning?'AC1: tested':'',error:null,sessionId:null,feedback:'',startedAt:null,finishedAt:null,costUsd:null})) };
}

test('evidence files retain complete recorded output and prior failures; modified files are rejected',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'loom-packet-'));try{
    const r=run(), step=r.steps[2];
    step.validation={attempt:1,status:'failed',before:'source-before',after:'source-after',startedAt:'then',commands:[{command:{executable:'docker',args:['compose','ps'],timeoutMs:1000},status:'failed',exitCode:1,output:'EARLY_DIAGNOSTIC'+'.'.repeat(60000)+'LATE_DIAGNOSTIC',truncated:false,startedAt:'then'}]};
    step.history=[{...step,validation:structuredClone(step.validation)}];step.validation=undefined;
    const packet=await writeEvidencePacket(r,root), contents=await readFile(packet.path,'utf8');
    assert.match(contents,/EARLY_DIAGNOSTIC/);assert.match(contents,/LATE_DIAGNOSTIC/);
    const parsed=JSON.parse(contents);assert.equal(parsed.validation[0].current,null);assert.equal(parsed.validation[0].history[0].commands[0].command.executable,'docker');
    assert.deepEqual(await writeEvidencePacket(r,root),packet);
    await writeFile(packet.path,'edited');await assert.rejects(writeEvidencePacket(r,root),/modified/);
    assert.equal(validationPacket(r).validation[0].history[0].status,'failed');
  }finally{await rm(root,{recursive:true,force:true});}
});

test('rescue approval pins its model and cannot discard a Fable review to enable self-review',()=>{
  const r=run(), original=automationContract(r);
  assert.equal(canEscalate(r),true);
  r.automation!.escalation!.model='unapproved-model';assert.notEqual(automationContract(r),original);
  r.automation!.escalation!.model=FABLE_REPAIR.model;
  const member=r.steps[3].definition.council!.secondOpinion!;
  r.steps[3].council={attempt:1,source:'s',bundleHash:'b',bundle:'{}',status:'blocked',reviewers:[{member,status:'completed',output:'',costUsd:null}],issues:[],startedAt:''};
  assert.equal(canEscalate(r),false);
  r.steps[3].history=[{...r.steps[3]}];r.steps[3].council=undefined;
  assert.equal(canEscalate(r),false);
  delete r.automation!.escalation;assert.equal(canEscalate(r),false);
});
