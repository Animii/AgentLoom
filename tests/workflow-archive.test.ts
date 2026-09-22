import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createApp} from '../src/server/app.js';

test('workflow archive preserves runs, survives restart, blocks new runs and restores',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'loom-archive-'));
 await mkdir(path.join(root,'work/projects/welcome'),{recursive:true});
 const config={dataDir:path.join(root,'data'),workspaceRoot:path.join(root,'work'),host:'127.0.0.1',port:0,cliTimeoutMs:1000,maxOutputBytes:10000};
 let app=await createApp(config,{serveStatic:false});
 try{
  const run=await app.engine.create({title:'Retained history',task:'Demo check',project:'welcome',workflowId:'quick-review',mode:'demo'});
  for(let i=0;i<100&&app.store.getRun(run.id)?.status!=='completed';i++)await delay(30);
  assert.equal(app.store.getRun(run.id)?.status,'completed');
  const before=app.store.getRun(run.id);
  const patch=(payload:object)=>app.inject({method:'PATCH',url:'/api/workflows/quick-review',payload});
  assert.equal((await patch({archived:'yes'})).statusCode,400);
  assert.equal((await patch({archived:true})).statusCode,200);
  assert.deepEqual(app.store.getRun(run.id),before);
  assert.equal((await app.inject({method:'POST',url:'/api/runs',payload:{title:'Blocked',task:'x',project:'welcome',workflowId:'quick-review',mode:'demo'}})).statusCode,409);
  const archived=app.store.getWorkflow('quick-review')!;
  const stale={...archived,archived:false};
  assert.equal((await app.inject({method:'PUT',url:'/api/workflows/quick-review',payload:stale})).statusCode,200);
  assert.equal(app.store.getWorkflow('quick-review')?.archived,true);
  await app.close();app=await createApp(config,{serveStatic:false});
  assert.equal(app.store.getWorkflow('quick-review')?.archived,true);
  assert.deepEqual(app.store.getRun(run.id),before);
  assert.equal((await patch({archived:false})).statusCode,200);
  assert.equal(app.store.getWorkflow('quick-review')?.archived,false);
 }finally{await app.close();await rm(root,{recursive:true,force:true});}
});
