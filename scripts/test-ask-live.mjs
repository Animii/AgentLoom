import {writeFile} from 'node:fs/promises';
const base='http://localhost:4317';
async function api(path,body,method=body?'POST':'GET'){const r=await fetch(base+path,{method,headers:{'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});if(!r.ok)throw Error(await r.text());return r.json();}
async function test(provider){
 const id='ask-live-'+provider+'-'+Date.now();const step={id:'plan',name:'Plan',role:'product owner',provider,model:provider==='claude'?'claude-fable-5-1':provider==='opencode'?'deepseek/deepseek-flash':'',effort:provider==='opencode'?'max':'high',access:'read-only',approval:true,planning:true,instructions:'Validate planning conversation only. Do not inspect or change files. On the first turn write a short greeting and call the agentloom ask_user MCP tool with one question: Who is the guide for? Offer Developers and Players. End the turn after the tool acknowledges. Once the user answers, write a concise plan for a three-item offline Markdown guide for that audience and end PLAN_READY. Tool discovery/search is allowed when needed to locate ask_user; do not use other tools.'};
 await api('/api/workflows/'+id,{id,name:'Ask tool '+provider,description:'Read-only live tool validation',steps:[step]},'PUT');
 let run=await api('/api/runs',{title:'Live ask tool '+provider,task:'Help me plan a short local guide. Ask me its audience using ask_user.',project:'welcome',workflowId:id,mode:'live'});console.log(provider,'run',run.id);
 const streamAbort=new AbortController();const stream=await fetch(base+'/api/runs/'+run.id+'/stream',{signal:streamAbort.signal});let snapshots=0,partial=false;const streamWork=(async()=>{try{for await(const bytes of stream.body){const data=new TextDecoder().decode(bytes);snapshots++;if(data.includes('"status":"running"')&&!data.includes('"output":""'))partial=true;}}catch{}})();
 async function wait(){for(let i=0;i<240;i++){run=await api('/api/runs/'+run.id);if(!['queued','running'].includes(run.status))return;await new Promise(r=>setTimeout(r,1000));}throw Error(provider+' timeout');}
 try{
  await wait();console.log(provider,'question status',run.status,'tool',Boolean(run.steps[0].pendingAskId),'error',run.error);
  await writeFile('artifacts/ask-live-'+provider+'.json',JSON.stringify(run,null,2));
  if(run.status!=='waiting_input'||!run.steps[0].pendingAskId)throw Error(provider+' did not call ask_user');
  await api('/api/runs/'+run.id+'/messages',{stepId:'plan',messageId:crypto.randomUUID(),message:'Developers. The guide must be offline, Markdown, and exactly three items. No commands or installation.'});await wait();
  if(run.status!=='waiting_approval')throw Error(provider+' did not produce a plan: '+run.error);
  await api('/api/runs/'+run.id+'/approve',{});await wait();
  await writeFile('artifacts/ask-live-'+provider+'.json',JSON.stringify({...run,streamSnapshots:snapshots,partialObserved:partial},null,2));console.log(provider,'passed',run.status,'snapshots',snapshots,'partial',partial);
 }finally{streamAbort.abort();await streamWork;}
}
const providers=process.argv.slice(2).length?process.argv.slice(2):['claude','codex','opencode'];const results=await Promise.allSettled(providers.map(test));for(let i=0;i<results.length;i++)console.log(providers[i],results[i]);if(results.some(r=>r.status==='rejected'))process.exitCode=1;
