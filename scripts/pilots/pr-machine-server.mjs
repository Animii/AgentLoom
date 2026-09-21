// Isolated live pilot only. Real providers, Jev, Git and GitHub are used.
// The two explicitly labelled, one-time faults exercise recovery without
// weakening validation or adding fault switches to the production server.
import {createApp} from '/app/dist/server/app.js';
import {createExecutor} from '/app/dist/server/providers.js';
import {publishDraftPr} from '/app/dist/server/git-workspaces.js';
import {mkdir, appendFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
if(process.env.AGENTLOOM_LIVE_PILOT!=='five-tasks')throw Error('Isolated pilot authorization missing');
const config={dataDir:'/data',workspaceRoot:'/workspaces',projectRoot:'/workspaces/pilot-sources',projectHostRoot:'/workspaces/pilot-sources',host:'0.0.0.0',port:4317,cliTimeoutMs:3600000,cliIdleTimeoutMs:600000,maxOutputBytes:2097152};
const realExecute=createExecutor(config);
await mkdir('/data/five-task-pilot',{recursive:true});
async function once(name,action){
 try{await writeFile(path.join('/data/five-task-pilot',name),'reserved',{flag:'wx'});}catch(error){if(error.code==='EEXIST')return false;throw error;}
 await action();return true;
}
const app=await createApp(config,{
 execute:async(step,prompt,workspace,...rest)=>{
  const result=await realExecute(step,prompt,workspace,...rest);
  if(step.id==='build'&&step.instructions.includes('[PILOT_CONTROLLED_DEFECT]')){
   await once(path.basename(workspace)+'-defect',async()=>{
    await appendFile(path.join(workspace,'scripts/check-git-project.mjs'),"\nthrow new Error('CONTROLLED_PILOT_DEFECT: remove this injected top-level failure during the approved repair');\n");
   });
  }
  return result;
 },
 publishPr:async(run,...args)=>{
  if(run.title.startsWith('[P5]')&&await once(run.id+'-publication',async()=>{}))throw Error('CONTROLLED_PILOT_PUBLICATION_OUTAGE: first publish intentionally unavailable; resume retries real GitHub publication.');
  return publishDraftPr(run,...args);
 }
});
let closing=false;
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{if(closing)return;closing=true;await app.close();});
await app.listen({host:config.host,port:config.port});
