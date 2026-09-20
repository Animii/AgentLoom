import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,mkdir,writeFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createApp} from '../src/server/app.js';

test('folder import publishes complete projects, rejects unsafe paths, preserves names and feeds a run',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'loom-import-'));const work=path.join(root,'work');let sawSource=false;
 const app=await createApp({dataDir:path.join(root,'data'),workspaceRoot:work,host:'127.0.0.1',port:0,cliTimeoutMs:1000,maxOutputBytes:10000},{serveStatic:false,execute:async(_s,_p,w)=>{assert.equal(await readFile(path.join(w,'src/main.ts'),'utf8'),'export const imported = true;');sawSource=true;return {output:'Source inspected',sessionId:null,costUsd:null};}});
 const post=(url:string,payload:object={})=>app.inject({method:'POST',url,payload});
 const upload=(id:string,filePath:string,data:string)=>app.inject({method:'PUT',url:`/api/project-imports/${id}/files`,payload:{path:filePath,data}});
 try{
  const begin=await post('/api/project-imports',{name:'imported-project',fileCount:2});assert.equal(begin.statusCode,201);const {id}=begin.json();
  assert.equal((await post('/api/project-imports',{name:'IMPORTED-PROJECT',fileCount:1})).statusCode,409);
  assert.equal((await post(`/api/project-imports/${id}/complete`)).statusCode,409);assert.deepEqual((await app.inject({url:'/api/projects'})).json(),[]);
  for(const invalid of ['../escape','/absolute','C:/escape','nested/../../escape','x\\y','.env','nested/.env.local','node_modules/test','CON.txt','.agentloom-importing'])assert.equal((await upload(id,invalid,'eA==')).statusCode,400,invalid);
  assert.equal((await upload(id,'bad.txt','not base64')).statusCode,400);
  assert.equal((await upload(id,'src/main.ts',Buffer.from('export const imported = true;').toString('base64'))).statusCode,200);
  assert.equal((await upload(id,'src/main.ts','eA==')).statusCode,400);
  const binary=Buffer.from([0,255,120,13]);assert.equal((await upload(id,'asset.bin',binary.toString('base64'))).statusCode,200);
  assert.equal((await post(`/api/project-imports/${id}/complete`)).statusCode,201);
  assert.equal((await app.inject({url:'/api/projects'})).json()[0].id,'imported-project');assert.deepEqual(await readFile(path.join(work,'projects/imported-project/asset.bin')),binary);
  assert.equal((await post('/api/project-imports',{name:'imported-project',fileCount:1})).statusCode,409);
  const run=(await post('/api/runs',{title:'Use imported source',task:'Read the imported file',project:'imported-project',workflowId:'quick-review',mode:'live'})).json();
  for(let i=0;i<150;i++){if(app.store.getRun(run.id)?.status==='completed')break;await delay(20);}
  assert.equal(app.store.getRun(run.id)?.status,'completed');assert.ok(sawSource);assert.equal(await readFile(path.join(work,'projects/imported-project/src/main.ts'),'utf8'),'export const imported = true;');
  assert.deepEqual(await readdir(path.join(work,'.imports')),[]);
 }finally{await app.close();await rm(root,{recursive:true,force:true});}
});

test('cancellation and publication collisions never overwrite existing folders',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'loom-import-cancel-'));const work=path.join(root,'work');const app=await createApp({dataDir:path.join(root,'data'),workspaceRoot:work,host:'127.0.0.1',port:0,cliTimeoutMs:1000,maxOutputBytes:1000},{serveStatic:false});
 const post=(url:string,payload:object={})=>app.inject({method:'POST',url,payload});
 try{
  let id=(await post('/api/project-imports',{name:'cancelled',fileCount:1})).json().id;
  assert.equal((await app.inject({method:'DELETE',url:'/api/project-imports/'+id})).statusCode,204);assert.deepEqual(await readdir(path.join(work,'.imports')),[]);
  id=(await post('/api/project-imports',{name:'collision',fileCount:1})).json().id;
  await app.inject({method:'PUT',url:`/api/project-imports/${id}/files`,payload:{path:'README.md',data:Buffer.from('new').toString('base64')}});
  await mkdir(path.join(work,'projects/collision'));await writeFile(path.join(work,'projects/collision/README.md'),'original');
  assert.equal((await post(`/api/project-imports/${id}/complete`)).statusCode,409);assert.equal(await readFile(path.join(work,'projects/collision/README.md'),'utf8'),'original');
  assert.equal((await post('/api/project-imports',{name:'../bad',fileCount:1})).statusCode,400);
  assert.equal((await app.inject({method:'POST',url:'/api/project-imports',headers:{origin:'https://evil.example'},payload:{name:'bad',fileCount:1}})).statusCode,403);
 }finally{await app.close();await rm(root,{recursive:true,force:true});}
});
