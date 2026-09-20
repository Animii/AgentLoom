import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createApp} from '../src/server/app.js';
test('real HTTP responses complete with headers, including unknown routes',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'loom-http-'));const app=await createApp({dataDir:path.join(root,'data'),workspaceRoot:path.join(root,'work'),port:4317,host:'127.0.0.1',cliTimeoutMs:1000,maxOutputBytes:1000},{serveStatic:false});
 try {const address=await app.listen({port:0,host:'127.0.0.1'});const response=await fetch(address+'/api/health',{signal:AbortSignal.timeout(3000)});assert.equal(response.status,200);assert.equal(response.headers.get('x-frame-options'),'DENY');assert.deepEqual(await response.json(),{ok:true,version:'0.1.0'});const missing=await fetch(address+'/api/unknown',{signal:AbortSignal.timeout(3000)});assert.equal(missing.status,404);assert.deepEqual(await missing.json(),{error:'Not found'});}finally{await app.close();await rm(root,{recursive:true,force:true});}
});

test('SSE sends partial output before completion, reconnects from saved state and closes on shutdown',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'loom-stream-'));const app=await createApp({dataDir:path.join(root,'data'),workspaceRoot:path.join(root,'work'),port:4317,host:'127.0.0.1',cliTimeoutMs:1000,maxOutputBytes:1000},{serveStatic:false});
 try{
  const address=await app.listen({port:0,host:'127.0.0.1'});
  const now=new Date().toISOString();const run:any={id:'stream-test',title:'Stream test',task:'Question',project:'sample',workflowId:'review-build',workflowName:'Test',mode:'live',status:'running',currentStep:0,workspace:'',error:null,createdAt:now,updatedAt:now,steps:[{definition:app.store.listWorkflows()[0].steps[0],status:'running',attempt:1,output:'First chunk',error:null,sessionId:null,feedback:'',startedAt:now,finishedAt:null,costUsd:null}]};
  app.store.saveRun(run);const controller=new AbortController();const response=await fetch(address+'/api/runs/stream-test/stream',{signal:controller.signal});assert.match(response.headers.get('content-type')??'',/event-stream/);const reader=response.body!.getReader();const first=new TextDecoder().decode((await reader.read()).value);assert.match(first,/First chunk/);assert.match(first,/"status":"running"/);
  run.steps[0].output='First chunk plus second';app.store.saveRun(run);const next=new TextDecoder().decode((await reader.read()).value);assert.match(next,/plus second/);
  controller.abort();const again=await fetch(address+'/api/runs/stream-test/stream');const reconnect=again.body!.getReader();assert.match(new TextDecoder().decode((await reconnect.read()).value),/plus second/);
  assert.equal((await fetch(address+'/api/runs/stream-test/stream',{headers:{origin:'https://evil.example'}})).status,403);
  assert.equal((await fetch(address+'/api/runs/missing/stream')).status,404);
  await app.close();assert.equal((await reconnect.read()).done,true);
 }finally{await app.close();await rm(root,{recursive:true,force:true});}
});
