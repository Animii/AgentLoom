import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createApp} from '../src/server/app.js';
import type {Run} from '../src/shared/types.js';

test('connected projects use original folders, isolated copies, persistent settings and safe lifecycle',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'loom-projects-'));const host=path.join(root,'host');const source=path.join(host,'Game');await mkdir(source,{recursive:true});await writeFile(path.join(source,'source.txt'),'original');await writeFile(path.join(source,'.env'),'secret');
 const config={dataDir:path.join(root,'data'),workspaceRoot:path.join(root,'work'),projectRoot:host,projectHostRoot:host,port:0,host:'127.0.0.1',cliTimeoutMs:1000,maxOutputBytes:10000};
 const execute=async(_s:unknown,_p:unknown,w:string)=>{await writeFile(path.join(w,'source.txt'),'changed');return {output:'Updated source',sessionId:null,costUsd:null};};
 let app=await createApp(config,{serveStatic:false,execute});
 const post=(url:string,payload:object={})=>app.inject({method:'POST',url,payload});const patch=(id:string,payload:object)=>app.inject({method:'PATCH',url:'/api/projects/'+id,payload});
 const wait=async(id:string,status:string)=>{for(let i=0;i<150;i++){const r=app.store.getRun(id)!;if(r.status===status)return r;await delay(20);}throw Error('Timed out '+status);};
 try{
  assert.equal((await app.inject({url:'/api/project-folders'})).json().folders[0].name,'Game');
  const connected=await post('/api/projects',{name:'My Game',folder:'Game',workspaceMode:'direct'});assert.equal(connected.statusCode,201);const project=connected.json();
  assert.equal((await post('/api/runs',{title:'Stale mode',task:'No write',project:project.id,workflowId:'quick-review',mode:'live',expectedWorkspaceMode:'isolated'})).statusCode,409);
  const workflow=app.store.listWorkflows().find(w=>w.id==='review-build')!;app.store.saveWorkflow({...workflow,id:'edit',steps:[{...workflow.steps.find(s=>s.id==='build')!,id:'edit',approval:true,planning:false}]});
  let created=await post('/api/runs',{title:'Direct edit',task:'Change source',project:project.id,workflowId:'edit',mode:'live'});assert.equal(created.statusCode,201);let run=created.json<Run>();await wait(run.id,'waiting_approval');assert.equal(await readFile(path.join(source,'source.txt'),'utf8'),'changed');assert.equal(app.store.getRun(run.id)?.workspace,source);
  assert.equal((await post('/api/runs',{title:'Conflicting edit',task:'Change source',project:project.id,workflowId:'edit',mode:'live'})).statusCode,409);
  const pausedBefore=app.store.getRun(run.id);
  assert.equal((await patch(project.id,{status:'archived'})).statusCode,200);
  assert.deepEqual(app.store.getRun(run.id),pausedBefore);
  assert.equal((await post('/api/runs',{title:'Archived edit',task:'x',project:project.id,workflowId:'edit',mode:'live'})).statusCode,409);
  assert.equal((await patch(project.id,{status:'active'})).statusCode,200);
  assert.equal((await patch(project.id,{name:'Renamed game'})).statusCode,200);assert.equal(app.store.getRun(run.id)?.projectLocation?.name,'My Game');
  assert.equal((await app.inject({url:`/api/runs/${run.id}/file?path=source.txt`})).json().content,'changed');assert.equal((await app.inject({url:`/api/runs/${run.id}/file?path=.env`})).statusCode,400);assert.equal((await app.inject({url:`/api/runs/${run.id}/file?path=../escape`})).statusCode,400);
  assert.equal((await post(`/api/runs/${run.id}/approve`)).statusCode,200);await wait(run.id,'completed');
  const directRunId=run.id;await writeFile(path.join(source,'source.txt'),'fresh source');await patch(project.id,{workspaceMode:'isolated'});
  created=await post('/api/runs',{title:'Isolated edit',task:'Change copy',project:project.id,workflowId:'edit',mode:'live'});run=created.json<Run>();const ready=await wait(run.id,'waiting_approval');assert.notEqual(ready.workspace,source);assert.equal(await readFile(path.join(source,'source.txt'),'utf8'),'fresh source');assert.equal(await readFile(path.join(ready.workspace,'source.txt'),'utf8'),'changed');await post(`/api/runs/${run.id}/approve`);await wait(run.id,'completed');
  await patch(project.id,{status:'archived'});assert.equal((await post('/api/runs',{title:'Archived',task:'x',project:project.id,workflowId:'edit',mode:'live'})).statusCode,409);await patch(project.id,{status:'active'});
  await patch(project.id,{status:'disconnected'});assert.equal(await readFile(path.join(source,'source.txt'),'utf8'),'fresh source');assert.equal((await app.inject({url:`/api/runs/${directRunId}/file?path=source.txt`})).statusCode,400);assert.equal((await app.inject({url:`/api/runs/${run.id}/file?path=source.txt`})).json().content,'changed');
  await app.close();app=await createApp(config,{serveStatic:false,execute});const stored=(await app.inject({url:'/api/projects'})).json().find((p:any)=>p.id===project.id);assert.equal(stored.status,'disconnected');assert.equal(stored.name,'Renamed game');assert.equal(stored.workspaceMode,'isolated');
  assert.equal((await patch(project.id,{status:'active'})).statusCode,200);assert.equal(app.store.listRuns().length,2);
 }finally{await app.close();await rm(root,{recursive:true,force:true});}
});

test('folder browser rejects traversal, symlinks and unavailable directories',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'loom-folders-'));const host=path.join(root,'host');await mkdir(host);await mkdir(path.join(root,'outside'));await symlink(path.join(root,'outside'),path.join(host,'link'),process.platform==='win32'?'junction':'dir');
 const app=await createApp({dataDir:path.join(root,'data'),workspaceRoot:path.join(root,'work'),projectRoot:host,port:0,host:'127.0.0.1',cliTimeoutMs:1000,maxOutputBytes:1000},{serveStatic:false});
 try{for(const value of ['../outside','link','missing','/etc','C:/outside'])assert.equal((await app.inject({url:'/api/project-folders?path='+encodeURIComponent(value)})).statusCode,400,value);assert.equal((await app.inject({method:'POST',url:'/api/projects',payload:{name:'Bad',folder:'../outside',workspaceMode:'direct'}})).statusCode,409);assert.equal((await app.inject({url:'/api/project-folders',headers:{origin:'https://evil.example'}})).statusCode,403);}finally{await app.close();await rm(root,{recursive:true,force:true});}
});
