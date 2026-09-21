import {test,expect} from '@playwright/test';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import type {Run} from '../../src/shared/types';
const exec=promisify(execFile);
test('PR machine opt-in, plan authorization, uncertainty recovery and automatic draft link survive refresh',async({page})=>{
 const root=await mkdtemp(path.join(tmpdir(),'loom-machine-ui-'));const source=path.join(root,'projects','fixture');await mkdir(source,{recursive:true});
 const git=(args:string[])=>exec('git',args,{cwd:source,windowsHide:true});await git(['init','-b','main']);await git(['config','user.name','Fixture']);await git(['config','user.email','fixture@example.invalid']);await writeFile(path.join(source,'app.txt'),'original');await git(['add','.']);await git(['commit','-m','Initial']);await git(['remote','add','origin','https://github.com/fixture/project.git']);
 const {createApp}=await import(pathToFileURL(path.resolve('dist/server/app.js')).href);const {councilWorkflow}=await import(pathToFileURL(path.resolve('dist/server/templates.js')).href);
 let confidence=0.33,builds=0,published=0;
 const app=await createApp({dataDir:path.join(root,'data'),workspaceRoot:path.join(root,'work'),projectRoot:path.join(root,'projects'),host:'127.0.0.1',port:0,cliTimeoutMs:1000,maxOutputBytes:100000},{
  publishPr:async(run:Run)=>{expect(run.git?.approvedTree).toMatch(/^[a-f0-9]{40}$/);published++;return {url:'https://github.com/fixture/project/pull/42',commit:'a'.repeat(40)};},
  jevFetch:async(_url:unknown,init:RequestInit)=>{const body=JSON.parse(String(init.body));return new Response(JSON.stringify({model:'jev-test',answers:Object.fromEntries(Object.entries(body.questions as Record<string,{type:string}>).map(([id,q])=>[id,q.type==='noul'?{type:'noul',noul:0.9}:{type:'choice',choice:'complete',confidence,probabilities:{complete:0.9,return_to_implementer:0.05,request_clarification:0.05}}]))}));},
  execute:async(step:{id:string},_prompt:string,workspace:string)=>{
   if(step.id==='plan')return {output:'AC1: set app.txt to fixed.\n\nPLAN_READY',sessionId:null,costUsd:null};
   if(step.id==='build'){builds++;await writeFile(path.join(workspace,'app.txt'),'fixed');return {output:'Implemented.',sessionId:null,costUsd:null};}
   return {output:JSON.stringify(step.id==='council-chair'?{summary:'All evidence supports AC1.',disputes:[]}:{verdict:'PASS',summary:'AC1 verified.',criteria:[{id:'AC1',status:'met',evidence:['app.txt and recorded check']}],findings:[],resolutions:[]}),sessionId:null,costUsd:null};
  }});
 const workflow=structuredClone(councilWorkflow);workflow.steps[2].validation.commands=[{executable:process.execPath,args:['-e',"process.exit(require('fs').readFileSync('app.txt','utf8')==='fixed'?0:1)"],timeoutMs:3000}];app.store.saveWorkflow(workflow);
 try{
  await app.inject({method:'PUT',url:'/api/jev/settings',payload:{apiKey:'fixture-ui-automation'}});const project=(await app.inject({method:'POST',url:'/api/projects',payload:{name:'Machine fixture',folder:'fixture',workspaceMode:'worktree'}})).json();const address=await app.listen({port:0,host:'127.0.0.1'});
  await page.goto(address);await page.getByRole('button',{name:'New run',exact:true}).first().click();const dialog=page.getByRole('dialog');await dialog.getByLabel('Task title',{exact:true}).fill('Machine delivery');await dialog.getByLabel('Task brief',{exact:true}).fill('AC1: set app.txt to fixed.');await dialog.getByLabel('Project',{exact:true}).selectOption(project.id);await dialog.getByLabel('Workflow',{exact:true}).selectOption(workflow.id);await dialog.getByLabel('Mode',{exact:true}).selectOption('live');await expect(dialog.getByLabel('Delivery',{exact:true})).toHaveValue('draft');await dialog.getByLabel('Delivery',{exact:true}).selectOption('manual');await expect(dialog.getByLabel('Delivery',{exact:true})).toHaveValue('manual');await dialog.getByLabel('Delivery',{exact:true}).selectOption('draft');await dialog.getByRole('button',{name:'Start run',exact:true}).click();
  const panel=page.getByRole('region',{name:'PR machine',exact:true});await expect(panel).toContainText('awaiting plan');expect(builds).toBe(0);await page.getByRole('button',{name:'Approve plan and continue',exact:true}).click();await expect(panel).toContainText('Low routing confidence');expect(published).toBe(0);
  await page.reload();await expect(panel).toContainText('Low routing confidence');confidence=0.9;await panel.getByRole('button',{name:'Resume automation',exact:true}).click();await expect(panel).toContainText('Draft PR ready');expect(builds).toBe(1);expect(published).toBe(1);
  await page.locator('details.git-run-panel > summary').click();await expect(page.getByRole('link',{name:'Open draft pull request'})).toHaveAttribute('href','https://github.com/fixture/project/pull/42');await page.reload();await expect(panel).toContainText('Draft PR ready');await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 }finally{await page.goto('about:blank').catch(()=>{});app.server.closeAllConnections();await app.close();await rm(root,{recursive:true,force:true,maxRetries:10});}
});
