import {test,expect} from '@playwright/test';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

test('default single review streams openly, second opinion preserves history and survives refresh',async({page})=>{
 const root=await mkdtemp(path.join(tmpdir(),'loom-single-ui-'));
 await mkdir(path.join(root,'work/projects/sample'),{recursive:true});await writeFile(path.join(root,'work/projects/sample/app.txt'),'fixed');
 const {createApp}=await import(pathToFileURL(path.resolve('dist/server/app.js')).href);
 const {singleReviewWorkflow}=await import(pathToFileURL(path.resolve('dist/server/templates.js')).href);
 const calls:string[]=[];let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});let releaseWorkflows!:()=>void;const workflowGate=new Promise<void>(r=>{releaseWorkflows=r;});
 const app=await createApp({dataDir:path.join(root,'data'),workspaceRoot:path.join(root,'work'),host:'127.0.0.1',port:0,cliTimeoutMs:1000,maxOutputBytes:100000},{execute:async(step:{id:string},_prompt:string,_workspace:string,_signal:AbortSignal,event:(e:unknown)=>void)=>{
  calls.push(step.id);
  if(step.id==='plan')return {output:'AC1: verify fixed. Scope: app.txt only.\nPLAN_READY',sessionId:null,costUsd:null};
  if(step.id==='build')return {output:'Implementation ready.',sessionId:null,costUsd:null};
  if(step.id==='council-chair')return {output:JSON.stringify({summary:'Both reviews agree on current evidence.',disputes:[]}),sessionId:null,costUsd:null};
  event({type:'output',message:'Inspecting the approved task.\n'});event({type:'tool',message:'read',toolCall:{id:'read',name:'read_project_file',status:'completed',input:{path:'app.txt'},startedAt:new Date().toISOString()}});
  if(step.id==='council-correctness')await gate;
  return {output:JSON.stringify({verdict:'PASS',summary:'Value and scope verified.',criteria:['AC1','SCOPE'].map(id=>({id,status:'met',evidence:['app.txt:1 and recorded check']})),findings:[],resolutions:[]}),sessionId:null,costUsd:null};
 }});
 const workflow=structuredClone(singleReviewWorkflow);workflow.steps[2].validation.commands=[{executable:process.execPath,args:['-e',"if(require('fs').readFileSync('app.txt','utf8')!=='fixed')process.exit(1)"],timeoutMs:3000}];app.store.saveWorkflow(workflow);
 try{
  const address=await app.listen({port:0,host:'127.0.0.1'});await page.route('**/api/workflows',async route=>{await workflowGate;await route.continue();});await page.goto(address);
  await page.getByRole('button',{name:'New run',exact:true}).first().click();await page.getByLabel('Task title',{exact:true}).fill('Draft while workflows load');await expect(page.getByLabel('Workflow',{exact:true})).toHaveValue('');releaseWorkflows();await expect(page.getByLabel('Workflow',{exact:true})).toHaveValue('single-review-delivery');await expect(page.getByLabel('Task title',{exact:true})).toHaveValue('Draft while workflows load');await expect(page.getByRole('dialog')).toContainText('Automatic draft PRs require a Git worktree');await page.getByRole('button',{name:'Cancel',exact:true}).click();
  const run=await app.engine.create({title:'Single review UI',task:'AC1: value is fixed.',project:'sample',workflowId:workflow.id,mode:'live'});
  await page.goto(`${address}/?run=${run.id}`);await page.getByRole('button',{name:'Approve plan and continue',exact:true}).click();
  const panel=page.getByRole('region',{name:'Independent review',exact:true});await expect(panel).toContainText('Inspecting the approved task.');await expect(panel.locator('.tool-call-group')).toBeVisible();await expect(panel.locator('.council-members > details')).toHaveCount(1);await expect(panel.locator('.council-members > details')).toHaveAttribute('open','');
  await page.reload();await expect(panel).toContainText('Inspecting the approved task.');release();await expect(panel).toContainText('Review passed');expect(calls.includes('council-chair')).toBe(false);
  await panel.getByRole('button',{name:'Get another opinion',exact:true}).click();await panel.getByLabel('Focused question').fill('Independently verify AC1 and scope.');await panel.getByRole('button',{name:'Request second opinion',exact:true}).click();
  const expanded=page.getByRole('region',{name:'Review and second opinion',exact:true});await expect(expanded).toContainText('Both reviews agree');expect(calls.filter(x=>x==='council-correctness')).toHaveLength(1);expect(calls.filter(x=>x==='council-second-opinion')).toHaveLength(1);expect(calls.filter(x=>x==='council-chair')).toHaveLength(1);
  await page.reload();await expect(expanded.locator('.council-members > details')).toHaveCount(2);await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'artifacts/single-review/review-mobile.png',fullPage:true});
  await page.goto(`${address}/?view=workflows&workflow=single-review-delivery`);await page.locator('.wf-step summary').nth(3).click();await page.getByLabel('Reviewer model',{exact:true}).fill('gpt-6-astra');await page.getByRole('button',{name:'Save workflow',exact:true}).click();await expect(page.locator('.wf-message[role=status]')).toContainText('Saved');expect(app.store.getWorkflow(workflow.id).steps[3].council.secondOpinion.model).toBe('claude-fable-5-1');
 }finally{releaseWorkflows();release();await page.goto('about:blank').catch(()=>{});app.server.closeAllConnections();await app.close();await rm(root,{recursive:true,force:true,maxRetries:10});}
});
