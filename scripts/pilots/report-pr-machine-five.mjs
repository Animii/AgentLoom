// Summarize recorded evidence; never infer success from an agent's prose.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
const root=new URL('../../artifacts/single-review/live/',import.meta.url);
const base=process.env.PILOT_URL??'http://127.0.0.1:4319';
const results=[];
for(let task=1;task<=5;task++){
 let record;try{record=JSON.parse(await readFile(new URL(`p${task}.json`,root),'utf8'));}catch{continue;}
 const response=await fetch(base+'/api/runs/'+record.id);if(!response.ok)throw Error('Run unavailable: '+record.id);
 const run=await response.json();await writeFile(new URL(`p${task}-run.json`,root),JSON.stringify(run,null,2));
 const attempts=run.steps.flatMap(step=>[...(step.history??[]),step].map(attempt=>({stepId:step.definition.id,provider:step.definition.provider,model:step.definition.model,effort:step.definition.effort,...attempt})));
 const validation=attempts.filter(a=>a.validation).map(a=>({attempt:a.attempt,status:a.validation.status,sourceUnchanged:a.validation.before===a.validation.after,signals:a.validation.signals,commands:a.validation.commands.map(c=>({executable:c.command.executable,args:c.command.args,status:c.status,exitCode:c.exitCode,truncated:c.truncated,durationMs:Date.parse(c.finishedAt)-Date.parse(c.startedAt)}))}));
 const reviewRecord=r=>({provider:r.member.provider,model:r.member.model,status:r.status,verdict:r.report?.verdict,error:r.error,criteria:r.report?.criteria,findings:r.report?.findings,resolutions:r.report?.resolutions,costUsd:r.costUsd});
 const reviews=attempts.filter(a=>a.council).map(a=>({attempt:a.attempt,status:a.council.status,source:a.council.source,bundleHash:a.council.bundleHash,changes:a.council.changes,reviewClarifications:a.council.reviewClarifications??[],reviewers:a.council.reviewers.map(reviewRecord),challenge:a.council.challenge?{question:a.council.challenge.question,reviewers:a.council.challenge.reviewers.map(reviewRecord),chair:a.council.challenge.chair?.status??null}:null,chair:a.council.chair?.status??null}));
 const agentAttempts=attempts.filter(a=>!a.validation);
 const costs=agentAttempts.map(a=>({stepId:a.stepId,attempt:a.attempt,provider:a.provider,model:a.model,effort:a.effort,status:a.status,startedAt:a.startedAt,finishedAt:a.finishedAt,costUsd:a.costUsd??null}));
 results.push({task,id:run.id,title:run.title,status:run.status,url:record.url,brief:run.task,approvedPlan:run.steps.find(s=>s.definition.planning)?.output,createdAt:run.createdAt,updatedAt:run.updatedAt,elapsedMs:Date.parse(run.updatedAt)-Date.parse(run.createdAt),approvedElapsedMs:run.automation?.approvedAt?Date.parse(run.updatedAt)-Date.parse(run.automation.approvedAt):null,automation:run.automation,git:run.git,validation,reviews,costs,reportedAgentCostUsd:costs.reduce((sum,c)=>sum+(c.costUsd??0),0),costsComplete:costs.every(c=>c.costUsd!==null),notes:'Agent cost only; missing costs and Jev billing are unknown. Elapsed time includes queueing, approvals and deliberate recovery pauses.'});
}
let interventions=[];try{interventions=JSON.parse(await readFile(new URL('interventions.json',root),'utf8'));}catch{}
await mkdir(root,{recursive:true});
await writeFile(new URL('summary.json',root),JSON.stringify({generatedAt:new Date().toISOString(),results,interventions},null,2));
console.log(JSON.stringify(results.map(r=>({task:r.task,status:r.status,pr:r.git?.prUrl,repairs:r.automation?.repairsUsed,reportedAgentCostUsd:r.reportedAgentCostUsd,costsComplete:r.costsComplete})),null,2));
