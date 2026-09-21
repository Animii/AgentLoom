// Reads preserved local snapshots. Never invokes agents or creates a PR.
import {readFile,mkdir,writeFile} from 'node:fs/promises';
const source=new URL('../../../artifacts/reliable-delivery/live/',import.meta.url);
const target=new URL('../../../docs/evaluations/reliable-delivery/',import.meta.url);
await mkdir(target,{recursive:true});
let operator=[];try{operator=(await readFile(new URL('operator.jsonl',source),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch{}
const records=[],outcomes=[];
for(let task=1;task<=5;task++){
 let run;try{run=JSON.parse(await readFile(new URL(`r${task}-run.json`,source),'utf8'));}catch{continue;}
 const actions=operator.filter(e=>e.task===task);
 const attempts=run.steps.filter(s=>!s.definition.validation).flatMap(s=>[...(s.history??[]),s].map(a=>({stepId:s.definition.id,attempt:a.attempt,status:a.status,startedAt:a.startedAt,finishedAt:a.finishedAt,provider:a.execution?.provider??s.definition.provider,model:a.execution?.model??s.definition.model,costUsd:a.costUsd??null})));
 const unique=[...new Map(attempts.map(a=>[`${a.stepId}/${a.attempt}/${a.startedAt}`,a])).values()].filter(a=>a.attempt>0);
 const controllerCompletedAt=run.automation?.decisions.findLast(d=>d.action==='complete'&&d.appliedAt)?.appliedAt;
 const draftReadyAt=run.automation?.status==='done'&&run.git?.prUrl?run.updatedAt:null;
 let independent;try{independent=JSON.parse(await readFile(new URL(`r${task}-independent-check.json`,source),'utf8'));}catch{}
 outcomes.push({task,runId:run.id,title:run.title,status:run.status,automation:run.automation?.status,pr:run.git?.prUrl??null,baseCommit:run.git?.baseCommit,approvedTree:run.git?.approvedTree,commit:run.git?.publishedCommit,approvedAt:run.automation?.approvedAt,controllerCompletedAt,draftReadyAt,observedAt:run.updatedAt,approvalToDraftMinutes:run.automation?.approvedAt&&draftReadyAt?(Date.parse(draftReadyAt)-Date.parse(run.automation.approvedAt))/60000:null,repairs:run.automation?.repairsUsed,rescueUsed:run.automation?.escalation?.used,unplannedInterventions:actions.filter(a=>a.classification==='unplanned').length,plannedRecoveryActions:actions.filter(a=>a.classification==='planned recovery').length,knownUsd:unique.reduce((sum,a)=>sum+(a.costUsd??0),0),implementationKnownUsd:unique.filter(a=>a.stepId==='build').reduce((sum,a)=>sum+(a.costUsd??0),0),unreportedAttemptCosts:unique.filter(a=>a.costUsd===null).length,jevCost:'not reported',attempts:unique});
 function validation(e){return e?{...e,commands:e.commands.map(c=>{const {output,...rest}=c;let receipt;try{receipt=JSON.parse(output.trim());}catch{}return {...rest,receipt:receipt?.kind==='docker-compose-receipt'?receipt:undefined,testSummary:output.match(/(?:# |ℹ )(?:tests|pass|fail|suites) \d+/g)??[],failureTail:c.status==='failed'?output.slice(-2500):undefined};})}:undefined;}
 function review(e){return e?{attempt:e.attempt,status:e.status,source:e.source,bundleHash:e.bundleHash,validationPacketHash:e.validationPacketHash,changes:e.changes,obligations:e.obligations,reviewClarifications:e.reviewClarifications,issues:e.issues,reviewers:e.reviewers.map(({output,toolCalls,...rest})=>rest),challenge:e.challenge?{question:e.challenge.question,requested:e.challenge.requested,reviewers:e.challenge.reviewers.map(({output,toolCalls,...rest})=>rest)}:undefined}:undefined;}
 records.push({task,id:run.id,title:run.title,brief:run.task,approvedPlan:run.steps[0].output,git:run.git,automation:run.automation,steps:run.steps.map(s=>({definition:s.definition,attempt:s.attempt,status:s.status,execution:s.execution,validation:validation(s.validation),review:review(s.council),history:(s.history??[]).map(a=>({attempt:a.attempt,status:a.status,execution:a.execution,validation:validation(a.validation),review:review(a.council),startedAt:a.startedAt,finishedAt:a.finishedAt,costUsd:a.costUsd}))})),operator:actions,independent});
}
await writeFile(new URL('outcomes.json',target),JSON.stringify(outcomes,null,2)+'\n');
await writeFile(new URL('records.json',target),JSON.stringify(records,null,2)+'\n');
console.log(JSON.stringify(outcomes.map(({attempts,...o})=>o),null,2));
