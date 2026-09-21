import {test,expect} from '@playwright/test';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

test('real crate UI: conversation, triage, repair, approval and URL restoration',async({page})=>{
 const root=await mkdtemp(path.join(tmpdir(),'loom-crate-ui-'));await mkdir(path.join(root,'work/projects/welcome'),{recursive:true});
 const {createApp}=await import(pathToFileURL(path.resolve('dist/server/app.js')).href);
 const app=await createApp({dataDir:path.join(root,'data'),workspaceRoot:path.join(root,'work'),host:'127.0.0.1',port:0,cliTimeoutMs:10000,maxOutputBytes:10000},{execute:async()=>({output:'Verified acceptance criteria. No blockers.',sessionId:null,costUsd:null})});
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 try{
  const address=await app.listen({port:0,host:'127.0.0.1'});
  const run=await app.engine.create({title:'Crate UI verification',task:'Preserve attempt history and keyboard access.',project:'welcome',workflowId:'fix-verify',mode:'live',crate:true});
  await page.goto(`${address}/?view=crates&run=${run.id}`);
  await expect(page.locator('.crate-title')).toContainText('Crate UI verification');
  await page.getByRole('button',{name:'Open step conversation'}).click();
  await expect(page.getByLabel('Message Implement',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Approve and continue',exact:true}).click();
  await expect(page.getByRole('button',{name:'Open triage',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Open triage',exact:true}).click();
  await expect(page.getByLabel('Triage reason')).toBeVisible();
  await page.getByLabel('Triage reason').fill('Add a regression for keyboard submission.');
  await page.getByRole('button',{name:'Route to implementer',exact:true}).click();
  await page.getByRole('button',{name:'Open step conversation'}).click();
  await expect(page.getByRole('button',{name:'Approve and continue',exact:true})).toBeEnabled();await page.getByRole('button',{name:'Approve and continue',exact:true}).click();
  await expect(page.getByRole('button',{name:'Open triage',exact:true})).toBeVisible();await page.getByRole('button',{name:'Open triage',exact:true}).click();
  await page.getByLabel('Triage reason').fill('The new evidence meets the approved criteria.');await page.getByRole('button',{name:'Proceed to approval',exact:true}).click();
  await page.getByRole('button',{name:'Review approval controls',exact:true}).click();await page.getByRole('button',{name:'Approve and continue',exact:true}).click();
  await expect(page.locator('.crate-title')).toContainText('Approved');
  await page.getByRole('tab',{name:'History',exact:true}).click();await page.reload();
  await expect(page.getByRole('tab',{name:'History',exact:true})).toHaveAttribute('aria-selected','true');await expect(page.locator('.crate-history')).toContainText('keyboard submission');
  await page.screenshot({path:'artifacts/crates-desktop.png',fullPage:true});
  for(const width of [390,320]){await page.setViewportSize({width,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}
  await page.screenshot({path:'artifacts/crates-mobile.png',fullPage:true});
  await page.emulateMedia({reducedMotion:'reduce'});await page.getByRole('tab',{name:'Brief',exact:true}).click();expect(await page.locator('.crate-inspector-body').evaluate(e=>e.getAnimations().length)).toBe(0);
  expect(errors).toEqual([]);
 }finally{await page.goto('about:blank');app.server.closeAllConnections();await app.close();await rm(root,{recursive:true,force:true});}
});

test('crate creation selects the split-capable workflow and child navigation survives refresh',async({page})=>{
 const root=await mkdtemp(path.join(tmpdir(),'loom-split-ui-'));await mkdir(path.join(root,'work/projects/welcome'),{recursive:true});
 const {createApp}=await import(pathToFileURL(path.resolve('dist/server/app.js')).href);
 const app=await createApp({dataDir:path.join(root,'data'),workspaceRoot:path.join(root,'work'),host:'127.0.0.1',port:0,cliTimeoutMs:10000,maxOutputBytes:10000});
 try{
  const address=await app.listen({port:0,host:'127.0.0.1'});await page.goto(address);
  await page.locator('.app-header').getByRole('button',{name:'New crate',exact:true}).click();
  await expect(page.getByLabel('Workflow',{exact:true})).toHaveValue('crate-delivery');
  await page.getByLabel('Task title',{exact:true}).fill('Split invitation feature');await page.getByLabel('Task brief',{exact:true}).fill('Build independent API and UI scopes.');await page.getByLabel('Mode',{exact:true}).selectOption('demo');
  await page.getByRole('button',{name:'Create crate',exact:true}).click();
  await expect(page.locator('.crate-title')).toContainText('Split invitation feature');
  const id=new URL(page.url()).searchParams.get('run')!;
  await expect.poll(()=>app.store.getRun(id).status).toBe('waiting_input');
  app.engine.chat(id,'plan','Developers. Split independent API and UI work; preserve the parent criteria.',crypto.randomUUID());
  await expect(page.getByRole('button',{name:'Split into child crates',exact:true})).toBeVisible();await page.getByRole('button',{name:'Split into child crates',exact:true}).click();
  const fields=page.locator('.crate-action fieldset');await fields.nth(0).getByLabel('Title',{exact:true}).fill('Invitation API');await fields.nth(0).getByLabel('Scope and acceptance criteria').fill('Create and expire invitations.');await fields.nth(1).getByLabel('Title',{exact:true}).fill('Invitation form');await fields.nth(1).getByLabel('Scope and acceptance criteria').fill('Accessible form with error states.');
  await page.getByRole('button',{name:'Create child crates',exact:true}).click();await expect(page.locator('.crate-branches')).toContainText('Invitation API');
  await expect(page.getByRole('button',{name:'Join approved children',exact:true})).toBeDisabled();
  await page.screenshot({path:'artifacts/crates-split.png',fullPage:true});
  await page.locator('.crate-branches').getByRole('button',{name:/Invitation form/}).click();await page.reload();await expect(page.locator('.crate-title')).toContainText('Invitation form');await expect(page.locator('.crate-breadcrumb')).toContainText('Child crate');
 }finally{await page.goto('about:blank');app.server.closeAllConnections();await app.close();await rm(root,{recursive:true,force:true});}
});
