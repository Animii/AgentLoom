import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

test('council shows independent findings, focused challenge, reload and human approval', async ({ page }) => {
  const root = await mkdtemp(path.join(tmpdir(), 'loom-council-ui-'));
  await mkdir(path.join(root, 'work/projects/sample'), { recursive: true }); await writeFile(path.join(root, 'work/projects/sample/app.txt'), 'fixed');
  const { createApp } = await import(pathToFileURL(path.resolve('dist/server/app.js')).href);
  const { councilWorkflow } = await import(pathToFileURL(path.resolve('dist/server/templates.js')).href);
  const app = await createApp({ dataDir: path.join(root, 'data'), workspaceRoot: path.join(root, 'work'), host: '127.0.0.1', port: 0, cliTimeoutMs: 1000, maxOutputBytes: 100000 }, { execute: async (step: { id: string }, prompt: string) => {
    if (step.id === 'plan') return { output: 'AC1: value is fixed. Run the check.\n\nPLAN_READY', sessionId: null, costUsd: null };
    if (step.id === 'build') return { output: 'Implementation complete.', sessionId: null, costUsd: null };
    const challenge = prompt.includes('ONE FOCUSED CHALLENGE ROUND');
    const blocked = step.id === 'council-adversarial' && !challenge;
    const output = step.id === 'council-chair' ? { summary: 'All three reports checked against the source.', disputes: [] } : { verdict: blocked ? 'BLOCKED' : 'PASS', summary: blocked ? 'Recheck value against AC1.' : 'AC1 confirmed.', criteria: [{ id: 'AC1', status: blocked ? 'unmet' : 'met', evidence: ['app.txt:1 and recorded check'] }], findings: blocked ? [{ id: 'F1', criterion: 'AC1', severity: 'blocker', summary: 'Reported value mismatch', evidence: ['app.txt:1'] }] : [], resolutions: challenge && step.id === 'council-adversarial' ? [{ findingId: 'F1', evidence: 'Focused read confirms fixed; original complaint was incorrect.' }] : [] };
    return { output: JSON.stringify(output), sessionId: null, costUsd: 0.01 };
  } });
  const workflow = structuredClone(councilWorkflow); workflow.steps[2].validation.commands = [{ executable: process.execPath, args: ['-e', "console.log('AC1 verified')"], timeoutMs: 3000 }]; app.store.saveWorkflow(workflow);
  try {
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const run = await app.engine.create({ title: 'Council verification', task: 'AC1: verify fixed.', project: 'sample', workflowId: workflow.id, mode: 'live' });
    await page.goto(`${address}/?run=${run.id}`); await page.getByRole('button', { name: 'Approve plan and continue', exact: true }).click();
    const council = page.getByRole('region', { name: 'Outcome council', exact: true });
    await expect(council).toContainText('Changes required'); await expect(council.locator('.council-members > details')).toHaveCount(3);
    await expect(page.getByRole('button', { name: 'Approve and continue', exact: true })).toHaveCount(0);
    await page.reload(); await expect(council).toContainText('Reported value mismatch');
    await council.getByRole('button', { name: 'Request evidence', exact: true }).click(); await council.getByLabel('Focused question').fill('Please reproduce F1 against app.txt.'); await council.getByRole('button', { name: 'Ask council', exact: true }).click();
    await expect(council).toContainText('Ready for your approval'); await expect(council.getByRole('button', { name: 'Request evidence', exact: true })).toHaveCount(0);
    await page.reload(); await expect(council).toContainText('Focused challenge used');
    await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: 'artifacts/council-mobile.png', fullPage: true });
    await page.getByRole('button', { name: 'Approve and continue', exact: true }).click(); await expect(page.locator('.detail-status .status-completed')).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto(`${address}/?view=workflows&workflow=council-delivery`); await page.locator('.wf-step summary').nth(3).click();
    await expect(page.getByLabel('Reviewer model', { exact: true })).toHaveCount(3); await page.getByLabel('Reviewer model', { exact: true }).nth(2).fill('gpt-6-astra'); await page.getByRole('button', { name: 'Save workflow', exact: true }).click(); await expect(page.locator('.wf-message[role=status]')).toContainText('Saved');
  } finally { await page.goto('about:blank').catch(() => {}); app.server.closeAllConnections(); await app.close(); await rm(root, { recursive: true, force: true, maxRetries: 10 }); }
});

test('reviewer and chair text and separated tool groups stream before completion and survive reload', async ({page})=>{
  const root=await mkdtemp(path.join(tmpdir(),'loom-council-stream-'));
  await mkdir(path.join(root,'work/projects/sample'),{recursive:true}); await writeFile(path.join(root,'work/projects/sample/app.txt'),'fixed');
  const {createApp}=await import(pathToFileURL(path.resolve('dist/server/app.js')).href);
  const {councilWorkflow}=await import(pathToFileURL(path.resolve('dist/server/templates.js')).href);
  let releaseReviews!:()=>void,releaseChair!:()=>void;
  const reviewsGate=new Promise<void>(resolve=>{releaseReviews=resolve;}); const chairGate=new Promise<void>(resolve=>{releaseChair=resolve;});
  const report={verdict:'PASS',summary:'AC1 verified.',criteria:[{id:'AC1',status:'met',evidence:['app.txt:1']}],findings:[],resolutions:[]};
  const app=await createApp({dataDir:path.join(root,'data'),workspaceRoot:path.join(root,'work'),host:'127.0.0.1',port:0,cliTimeoutMs:1000,maxOutputBytes:100000},{execute:async(step:{id:string},_prompt:string,_workspace:string,signal:AbortSignal,onEvent:(event:unknown)=>void)=>{
    if(step.id==='plan')return {output:'AC1: verify fixed.\n\nPLAN_READY',sessionId:null,costUsd:null};
    if(step.id==='build')return {output:'Implementation ready.',sessionId:null,costUsd:null};
    const chair=step.id==='council-chair';
    onEvent({type:'output',message:chair?'Reconciling evidence.\n':'Inspecting acceptance criteria.\n'});
    onEvent({type:'tool',message:'read',toolCall:{id:'read-1',name:'read_project_file',status:'completed',input:{path:'app.txt'},startedAt:new Date().toISOString()}});
    onEvent({type:'output',message:'Now checking the recorded tests.\n'});
    onEvent({type:'tool',message:'read',toolCall:{id:'read-2',name:'read_project_file',status:'completed',input:{path:'package.json'},startedAt:new Date().toISOString()}});
    await Promise.race([chair?chairGate:reviewsGate,new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}))]);
    return {output:JSON.stringify(chair?{summary:'All criteria supported.',disputes:[]}:report),sessionId:null,costUsd:null};
  }});
  const workflow=structuredClone(councilWorkflow);workflow.steps[2].validation.commands=[{executable:process.execPath,args:['-e','console.log("checked")'],timeoutMs:3000}];app.store.saveWorkflow(workflow);
  try{
    const address=await app.listen({port:0,host:'127.0.0.1'});const run=await app.engine.create({title:'Live council output',task:'Verify AC1.',project:'sample',workflowId:workflow.id,mode:'live'});
    await page.goto(`${address}/?run=${run.id}`);await page.getByRole('button',{name:'Approve plan and continue',exact:true}).click();
    const member=page.locator('.council-members > details').first();await member.locator('summary').first().click();
    await expect(member).toContainText('Inspecting acceptance criteria.');await expect(member.locator('.tool-call-group')).toHaveCount(2);
    expect(app.store.getRun(run.id).status).toBe('running');await page.reload();await member.locator('summary').first().click();await expect(member).toContainText('Now checking the recorded tests.');await expect(member.locator('.tool-call-group')).toHaveCount(2);
    await page.screenshot({path:'artifacts/council-live-stream.png',fullPage:true});
    releaseReviews();const chair=page.locator('.council-chair');await chair.locator('summary').first().click();await expect(chair).toContainText('Reconciling evidence.');await expect(chair.locator('.tool-call-group')).toHaveCount(2);
    expect(app.store.getRun(run.id).status).toBe('running');releaseChair();await expect(page.locator('.detail-status .status-waiting_approval')).toBeVisible();
  }finally{releaseReviews();releaseChair();await page.goto('about:blank').catch(()=>{});app.server.closeAllConnections();await app.close();await rm(root,{recursive:true,force:true,maxRetries:10});}
});
