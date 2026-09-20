import {mkdir,writeFile} from 'node:fs/promises';
await mkdir('artifacts',{recursive:true});
const base=process.env.E2E_BASE_URL??'http://127.0.0.1:4317';
async function api(url,body,method=body?'POST':'GET'){const r=await fetch(base+url,{method,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});const data=await r.json();if(!r.ok)throw new Error(JSON.stringify(data));return data;}
const definitions=[['claude','claude-fable-5-1','high','read-only','Read README.md. Propose exactly three concise acceptance criteria for a local notes widget. Do not modify files.'],['codex','','high','read-only','Read README.md. Return exactly a short summary of the project and one practical validation check. Do not modify files.'],['opencode','deepseek/deepseek-flash','max','workspace-write','The product owner approved this exact implementation: create pilot-result.json containing exactly {"platform":"AgentLoom","verified":true,"owner":"product-owner"}. Do not make product decisions, do not modify other files. Read it back and report the filename and content.']];
const runs=[];
for(const [provider,model,effort,access,instructions] of definitions){const id='live-smoke-'+provider;await api('/api/workflows/'+id,{id,name:'Live integration: '+provider,description:'Actual provider integration validation',updatedAt:new Date().toISOString(),steps:[{id:'check',name:'Provider check',role:provider==='opencode'?'Implementer':'Reviewer',provider,model,effort,access,instructions,approval:true}]},'PUT');const run=await api('/api/runs',{title:'Live integration: '+provider,task:instructions,project:'welcome',workflowId:id,mode:'live'});runs.push(run);console.log('START',provider,run.id);}
const pending=new Set(runs.map(r=>r.id));const results=[];const deadline=Date.now()+600000;
while(pending.size&&Date.now()<deadline){for(const id of [...pending]){const run=await api('/api/runs/'+id);if(!['queued','running'].includes(run.status)){pending.delete(id);const record={id,provider:run.steps[0].definition.provider,status:run.status,output:run.steps[0].output,error:run.error??run.steps[0].error,costUsd:run.steps[0].costUsd};results.push(record);console.log(JSON.stringify(record));}}if(pending.size)await new Promise(r=>setTimeout(r,2000));}
for(const result of results){
 result.accepted=result.status==='waiting_approval'&&!/\bBLOCKED\b|unable to read|sandbox failed|write blocked/i.test(result.output);
 if(result.provider==='opencode'&&result.accepted){
  try {const file=await api('/api/runs/'+result.id+'/file?path=pilot-result.json');const data=JSON.parse(file.content);result.accepted=JSON.stringify(data)===JSON.stringify({platform:'AgentLoom',verified:true,owner:'product-owner'});}catch{result.accepted=false;}
 }
}
await writeFile('artifacts/live-smoke.json',JSON.stringify(results,null,2));if(pending.size||results.some(r=>!r.accepted))process.exitCode=1;

