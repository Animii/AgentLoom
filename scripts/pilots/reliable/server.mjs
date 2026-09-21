// Isolated experiment: real providers, Jev and GitHub. No production fault flags.
import {createApp} from '/app/dist/server/app.js';
import {createExecutor} from '/app/dist/server/providers.js';
import {publishDraftPr} from '/app/dist/server/git-workspaces.js';
import {mkdir,appendFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
if(process.env.AGENTLOOM_LIVE_PILOT!=='reliable-delivery')throw Error('Isolated pilot authorization missing');
const config={dataDir:'/data',workspaceRoot:'/workspaces',projectRoot:'/workspaces/reliable-sources',projectHostRoot:'/workspaces/reliable-sources',host:'0.0.0.0',port:4317,cliTimeoutMs:3600000,cliIdleTimeoutMs:600000,maxOutputBytes:2097152};
const execute=createExecutor(config);
await mkdir('/data/reliable-pilot',{recursive:true});
async function once(name){try{await writeFile(path.join('/data/reliable-pilot',name),'reserved',{flag:'wx'});return true;}catch(e){if(e.code==='EEXIST')return false;throw e;}}
const app=await createApp(config,{
 execute:async(step,prompt,workspace,...rest)=>{
  const result=await execute(step,prompt,workspace,...rest);
  if(step.id==='build'&&step.instructions.includes('[PILOT_ESCALATION]')&&step.provider==='opencode'){
   await appendFile(path.join(workspace,'scripts/summarize-changes.mjs'),"\nthrow new Error('CONTROLLED_ESCALATION_DEFECT: harness injects this after Flash attempts only; Fable removes it during the preapproved rescue');\n");
   await appendFile('/data/reliable-pilot/injections.jsonl',JSON.stringify({at:new Date().toISOString(),run:path.basename(workspace),provider:step.provider,model:step.model})+'\n');
  }
  return result;
 },
 publishPr:async(run,...args)=>{
  if(run.title.startsWith('[R5]')&&await once(run.id+'-publication'))throw Error('CONTROLLED_PUBLICATION_OUTAGE: one planned transport failure. Resume retries the exact approved tree without rerunning agents.');
  return publishDraftPr(run,...args);
 }
});
let closing=false;
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{if(closing)return;closing=true;await app.close();});
await app.listen({host:config.host,port:config.port});
