// An approved validation command, not an agent-authored receipt. It starts an
// isolated copy of the exact built app, probes it, records identities, cleans up.
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {sourceFingerprint} from '/app/dist/server/validation.js';
const exec=promisify(execFile), root=process.cwd();
const temp=await mkdtemp(path.join(tmpdir(),'loom-compose-check-'));
const project='loom-check-'+randomUUID().slice(0,12), image=project+':validation';
const command=async(args,options={})=>exec('docker',args,{cwd:root,timeout:600000,maxBuffer:4*1024*1024,windowsHide:true,...options});
const compose=['compose','-f',path.join(temp,'compose.json'),'-p',project];
const before=await sourceFingerprint(root);
try{
 // Use the validated runtime as a dependency base and copy the run's fresh build.
 // No host bind paths, shared application data, published ports or credentials.
 await writeFile(path.join(temp,'Dockerfile'), 'FROM agentloom-reliable:pilot\nUSER root\nCOPY --chown=node:node dist /app/dist\nCOPY --chown=node:node package.json /app/package.json\nUSER node\n');
 await command(['build','-f',path.join(temp,'Dockerfile'),'-t',image,'.']);
 await writeFile(path.join(temp,'compose.json'),JSON.stringify({services:{platform:{image,init:true,environment:{HOST:'0.0.0.0',PORT:'4317',DATA_DIR:'/data',WORKSPACE_ROOT:'/workspaces'},tmpfs:['/data:uid=1000,gid=1000','/workspaces:uid=1000,gid=1000'],healthcheck:{test:['CMD','node','-e',"fetch('http://127.0.0.1:4317/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],interval:'1s',timeout:'3s',start_period:'2s',retries:30}}}}));
 await command([...compose,'up','-d','--wait','--wait-timeout','90']);
 const id=(await command([...compose,'ps','-q','platform'])).stdout.trim();
 const metadata=JSON.parse((await command(['inspect',id])).stdout)[0];
 const probe="const health=await (await fetch('http://127.0.0.1:4317/api/health')).json();const runs=await (await fetch('http://127.0.0.1:4317/api/runs')).json();const page=await fetch('http://127.0.0.1:4317/');if(health.ok!==true||!Array.isArray(runs)||runs.length!==0||!page.ok)throw Error('Smoke checks failed');console.log(JSON.stringify({health,runCount:runs.length,pageStatus:page.status}));";
 const checks=JSON.parse((await command([...compose,'exec','-T','platform','node','--input-type=module','-e',probe])).stdout);
 const after=await sourceFingerprint(root);if(before!==after)throw Error('Source changed during Compose validation');
 console.log(JSON.stringify({kind:'docker-compose-receipt',source:before,project,imageId:metadata.Image,containerId:id,health:metadata.State.Health.Status,checks,finishedAt:new Date().toISOString()}));
}finally{
 await command([...compose,'down','--remove-orphans','--volumes']).catch(()=>{});
 await command(['image','rm',image]).catch(()=>{});
 await rm(temp,{recursive:true,force:true});
}
