import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {checkGitSource,prepareGitWorkspace,previewRunGit,publishDraftPr,githubRepository} from '../src/server/git-workspaces.js';
import type {Run,AppConfig,RunGit} from '../src/shared/types.js';
const exec=promisify(execFile);
const git=async(cwd:string,...args:string[])=>(await exec('git',args,{cwd,windowsHide:true})).stdout.trim();
async function fixture(){
 const root=await mkdtemp(path.join(tmpdir(),'loom-git-'));const source=path.join(root,'source');await mkdir(source);
 await git(source,'init','-b','main');await git(source,'config','user.name','Fixture');await git(source,'config','user.email','fixture@example.invalid');
 await writeFile(path.join(source,'app.txt'),'original\n');await git(source,'add','.');await git(source,'commit','-m','Initial');await git(source,'remote','add','origin','https://github.com/fixture/project.git');
 const config:AppConfig={dataDir:path.join(root,'data'),workspaceRoot:path.join(root,'work'),host:'127.0.0.1',port:0,cliTimeoutMs:1000,maxOutputBytes:10000};
 const makeRun=(id:string):Run=>({id,title:'Fix app',task:'Implement approved change',project:'fixture',projectLocation:{id:'fixture',name:'Fixture',sourcePath:source,hostPath:source,kind:'connected',workspaceMode:'worktree',status:'active'},workflowId:'fix-verify',workflowName:'Fix',mode:'live',status:'completed',steps:[],currentStep:0,createdAt:'',updatedAt:'',workspace:'',error:null});
 const prepare=async(id:string)=>{const run=makeRun(id);const prepared=await prepareGitWorkspace(config,source,run);Object.assign(run,prepared);return run;};
 return {root,source,config,makeRun,prepare,close:()=>rm(root,{recursive:true,force:true})};
}
test('real worktrees isolate concurrent runs and resume without losing edits',async()=>{
 const f=await fixture();try{
 const [a,b]=await Promise.all([f.prepare('one'),f.prepare('two')]);await writeFile(path.join(a.workspace,'app.txt'),'changed\n');await writeFile(path.join(a.workspace,'new.txt'),'new\n');
 assert.equal((await readFile(path.join(b.workspace,'app.txt'),'utf8')).trim(),'original');assert.equal(await readFile(path.join(f.source,'app.txt'),'utf8'),'original\n');assert.equal(await git(f.source,'status','--porcelain'),'');assert.equal(await git(f.source,'branch','--show-current'),'main');
 const before=await git(a.workspace,'diff','--cached');const preview=await previewRunGit(a,f.config);assert.match(preview.diff,/changed/);assert.match(preview.diff,/new.txt/);assert.equal(preview.canPublish,true);assert.equal(await git(a.workspace,'diff','--cached'),before);
 assert.equal((await prepareGitWorkspace(f.config,f.source,a)).workspace,a.workspace);assert.equal(await readFile(path.join(a.workspace,'app.txt'),'utf8'),'changed\n');
 a.status='waiting_approval';assert.equal((await previewRunGit(a,f.config)).canPublish,false);
 await writeFile(path.join(a.workspace,'.env'),'SECRET=fixture');await assert.rejects(previewRunGit(a,f.config),/credential/);
 }finally{await f.close();}
});
test('source validation and interrupted worktree preparation preserve the pinned base',async()=>{
 const f=await fixture();try{
 await writeFile(path.join(f.source,'dirty.txt'),'dirty');await assert.rejects(checkGitSource(f.source),/Commit or stash/);await rm(path.join(f.source,'dirty.txt'));
 const run=f.makeRun('interrupted');let planned:RunGit|undefined;await assert.rejects(prepareGitWorkspace(f.config,f.source,run,meta=>{planned=meta;throw Error('interrupted');}),/interrupted/);run.git=planned;
 await writeFile(path.join(f.source,'app.txt'),'later\n');await git(f.source,'commit','-am','Later');Object.assign(run,await prepareGitWorkspace(f.config,f.source,run));assert.equal((await readFile(path.join(run.workspace,'app.txt'),'utf8')).trim(),'original');
 await git(f.source,'checkout','--detach');await assert.rejects(checkGitSource(f.source),/checked-out branch/);
 assert.equal(githubRepository('https://token@github.com/owner/repo.git'),undefined);
 assert.equal(githubRepository('git@github.com:owner/repo.git'),'owner/repo');
 }finally{await f.close();}
});
test('draft PR publishes only reviewed snapshot to run branch; stale previews and auth failure cannot push',async()=>{
 const f=await fixture();try{
 const run=await f.prepare('publish');await writeFile(path.join(run.workspace,'app.txt'),'first\n');const old=await previewRunGit(run,f.config);await writeFile(path.join(run.workspace,'app.txt'),'approved\n');
 let calls=0,pushes=0,created=false;const remote=path.join(f.root,'remote.git');await git(f.root,'init','--bare',remote);
 const transport={gh:async(args:string[])=>{
  calls++;if(args[0]==='auth')return '';
  if(args[1]==='list')return created?JSON.stringify([{url:'https://github.com/fixture/project/pull/1',headRefOid:await git(f.root,'--git-dir',remote,'rev-parse','refs/heads/agentloom/publish'),state:'OPEN',baseRefName:'main'}]):'[]';
  if(args[0]==='api')return args[1]==='user'?'{"login":"fixture","id":123}':JSON.stringify({tree:{sha:run.git!.approvedTree}});
  assert.ok(args.includes('--draft'));assert.equal(args[args.indexOf('--base')+1],'main');assert.equal(await readFile(args[args.indexOf('--body-file')+1],'utf8'),'Checked\n\nTests passed.');created=true;return 'https://github.com/fixture/project/pull/1';
 },push:async(cwd:string,_url:string,ref:string)=>{
  pushes++;
  // Advance the local branch after the publisher creates its approved commit.
  await writeFile(path.join(cwd,'app.txt'),'unreviewed concurrent edit\n');await git(cwd,'add','.');await git(cwd,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','Concurrent change');
  await git(cwd,'push',remote,ref);
 }};
 run.git!.approvedTree=old.tree;
 await assert.rejects(publishDraftPr(run,f.config,{token:old.token,title:'Fix',body:''},transport),/not been approved/);assert.equal(calls,0);
 const preview=await previewRunGit(run,f.config);const input={token:preview.token,title:'Fix',body:'Checked\n\nTests passed.'};
 await assert.rejects(publishDraftPr(run,f.config,input,transport),/not been approved/);assert.equal(calls,0);
 run.git!.approvedTree=preview.tree;
 await assert.rejects(publishDraftPr(run,f.config,input,{...transport,gh:async()=>{throw Error('auth failed');}}),/auth failed/);assert.equal(pushes,0);
 const result=await publishDraftPr(run,f.config,input,transport);assert.match(result.url,/pull\/1$/);assert.equal(await git(f.root,'--git-dir',remote,'show','refs/heads/agentloom/publish:app.txt'),'approved');assert.equal(await git(f.root,'--git-dir',remote,'for-each-ref','--format=%(refname)'),'refs/heads/agentloom/publish');assert.equal(await git(f.source,'status','--porcelain'),'');
 await writeFile(path.join(run.workspace,'app.txt'),'approved\n');
 const retry=await previewRunGit(run,f.config);const recovered=await publishDraftPr(run,f.config,{...input,token:retry.token},transport);assert.equal(recovered.url,result.url);assert.equal(recovered.commit,result.commit);assert.notEqual(recovered.commit,retry.head);assert.equal(pushes,1);
 }finally{await f.close();}
});

test('committing approved edits during GitHub preflight cannot publish the older preview commit',async()=>{
 const f=await fixture();try{
  const run=await f.prepare('preflight');await writeFile(path.join(run.workspace,'app.txt'),'approved\n');const preview=await previewRunGit(run,f.config);run.git!.approvedTree=preview.tree;let pushes=0;
  await assert.rejects(publishDraftPr(run,f.config,{token:preview.token,title:'Fix',body:''},{gh:async(args)=>{
   if(args[0]==='auth'){await git(run.workspace,'add','.');await git(run.workspace,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','Approved edits committed concurrently');return '';}
   if(args[1]==='list')return '[]';if(args[0]==='api')return '{"login":"fixture","id":123}';return 'https://github.com/fixture/project/pull/1';
  },push:async()=>{pushes++;}}),/Git command failed/);
  assert.equal(pushes,0);assert.equal(await git(run.workspace,'show','HEAD:app.txt'),'approved');
 }finally{await f.close();}
});
