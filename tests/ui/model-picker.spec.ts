import {test,expect} from '@playwright/test';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

function discovered(provider:string,models:Array<{id:string;label?:string|null}>){
 return {provider,status:'discovered',message:null,models:models.map(model=>({id:model.id,label:model.label??null,source:'discovered'})),fetchedAt:new Date().toISOString()};
}

async function startApp(holdCodex:()=>Promise<void>,failCodex:()=>boolean){
 const root=await mkdtemp(path.join(tmpdir(),'loom-model-ui-'));await mkdir(path.join(root,'work/projects/welcome'),{recursive:true});
 const {createApp}=await import(pathToFileURL(path.resolve('dist/server/app.js')).href);
 const codexModels=[{id:'gpt-5.6-sol',label:'Sol'},{id:'gpt-6-astra',label:'Astra'},{id:'gpt-5.5',label:'GPT-5.5'}];
 for(let index=1;index<=24;index+=1)codexModels.push({id:`codex-filler-${index}`,label:`Filler ${index}`});
 const codex=discovered('codex',codexModels);
 const opencode=discovered('opencode',[{id:'opencode/gpt-5.1-codex'},{id:'deepseek/deepseek-flash'}]);
 const app=await createApp(
  {dataDir:path.join(root,'data'),workspaceRoot:path.join(root,'work'),host:'127.0.0.1',port:0,cliTimeoutMs:10000,maxOutputBytes:10000},
  {execute:async()=>({output:'Completed.',sessionId:null,costUsd:null}),discoverModels:async(provider:string)=>{
   if(provider==='codex'){await holdCodex();if(failCodex())throw new Error('offline');return codex;}
   return opencode;
  }},
 );
 const workflow=app.store.getWorkflow('quick-review');workflow.steps=[{...workflow.steps[0],provider:'codex',model:'',planning:false}];app.store.saveWorkflow(workflow);
 const address=await app.listen({port:0,host:'127.0.0.1'});
 return {app,root,address};
}

async function stopApp(app:{server:{closeAllConnections():void};close():Promise<void>},root:string){
 app.server.closeAllConnections();await app.close();await rm(root,{recursive:true,force:true});
}

test('model picker covers discovered models, keyboard selection, custom ids, CLI default and fallback',async({page})=>{
 const state={fail:false};
 const {app,root,address}=await startApp(async()=>{},()=>state.fail);
 try{
  await page.goto(`${address}/?view=workflows&workflow=quick-review`);
  const step=page.locator('.wf-step').first();await step.locator('summary').click();
  const combo=step.getByRole('combobox',{name:'Model'});await expect(combo).toBeVisible();
  await combo.click();await expect(step.getByRole('listbox')).toBeVisible();await expect(step.getByRole('listbox')).toContainText('Discovered from Codex');await expect(step.getByRole('option').filter({hasText:'gpt-5.6-sol'})).toContainText('Sol');
  await combo.press('ArrowDown');await combo.press('Enter');await expect(combo).toHaveValue('gpt-5.6-sol');await expect(page.locator('.wf-message')).toHaveCount(0);
  await combo.click();await expect(step.getByRole('option').filter({hasText:'gpt-6-astra'})).toBeVisible();await expect(step.getByRole('option').filter({hasText:'gpt-5.5'})).toBeVisible();
  await combo.fill('Astra');await expect(step.getByRole('option').filter({hasText:'gpt-6-astra'})).toBeVisible();await expect(step.getByRole('option').filter({hasText:'gpt-5.5'})).toHaveCount(0);
  await combo.press('Escape');await expect(combo).toHaveValue('gpt-5.6-sol');
  await combo.click();await combo.press('End');
  const listbox=step.getByRole('listbox');const metrics=await listbox.evaluate((element)=>({scrollTop:element.scrollTop,clientHeight:element.clientHeight,scrollHeight:element.scrollHeight}));
  expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);expect(metrics.scrollTop).toBeGreaterThan(0);
  const lastVisible=await listbox.evaluate((element)=>{const options=[...element.querySelectorAll('[role="option"]')];const last=options[options.length-1];const listRect=element.getBoundingClientRect();const lastRect=last.getBoundingClientRect();return lastRect.bottom<=listRect.bottom+1&&lastRect.top>=listRect.top-1;});
  expect(lastVisible).toBe(true);
  await combo.press('Escape');await expect(combo).toHaveValue('gpt-5.6-sol');
  await page.getByRole('button',{name:'Save workflow',exact:true}).click();await expect(page.locator('.wf-message')).toContainText(/saved/i);expect(app.store.getWorkflow('quick-review').steps[0].model).toBe('gpt-5.6-sol');
  await combo.click();await combo.fill('acme/rocket-9');await step.getByRole('option').filter({hasText:'Use custom model'}).click();await expect(combo).toHaveValue('acme/rocket-9');
  await page.getByRole('button',{name:'Save workflow',exact:true}).click();await page.reload();await step.locator('summary').click();await expect(combo).toHaveValue('acme/rocket-9');
  await combo.click();await step.getByRole('option').filter({hasText:'CLI default'}).click();await expect(combo).toHaveValue('');
  await page.getByRole('button',{name:'Save workflow',exact:true}).click();await page.reload();await step.locator('summary').click();await expect(combo).toHaveValue('');await expect(combo).toHaveAttribute('placeholder','CLI default');
  state.fail=true;await page.reload();await step.locator('summary').click();await expect(step.locator('.model-picker .field-helper')).toContainText(/discovery failed/i);await expect(step.getByRole('button',{name:'Refresh codex models'})).toBeVisible();
  await combo.click();await expect(step.getByRole('listbox')).toContainText('Built-in suggestions');await step.getByRole('option').filter({hasText:'gpt-5.6-sol'}).click();await expect(combo).toHaveValue('gpt-5.6-sol');
  await page.getByRole('button',{name:'Save workflow',exact:true}).click();await page.reload();await step.locator('summary').click();await expect(combo).toHaveValue('gpt-5.6-sol');
 }finally{await page.goto('about:blank');await stopApp(app,root);}
});

test('late catalogs, provider switches and refresh never overwrite the saved selection',async({page})=>{
 let gate:Promise<void>|null=null;let releaseGate:(()=>void)|null=null;
 const openGate=()=>{gate=new Promise<void>(resolve=>{releaseGate=resolve;});};
 const open=()=>{const current=gate;gate=null;releaseGate?.();releaseGate=null;return current;};
 const {app,root,address}=await startApp(async()=>{if(gate)await gate;},()=>false);
 try{
  const setup=app.store.getWorkflow('quick-review');setup.steps[0]={...setup.steps[0],provider:'codex',model:'claude-fable-5-1',planning:false};app.store.saveWorkflow(setup);
  openGate();
  await page.goto(`${address}/?view=workflows&workflow=quick-review`);
  const step=page.locator('.wf-step').first();await step.locator('summary').click();
  const combo=step.getByRole('combobox',{name:'Model'});await expect(combo).toHaveValue('claude-fable-5-1');
  open();await expect(step.locator('.model-picker .field-helper')).toContainText(/not in the current catalog/i);await expect(combo).toHaveValue('claude-fable-5-1');
  await combo.click();await expect(step.getByRole('option').filter({hasText:'Saved model'})).toBeVisible();
  openGate();
  await page.reload();await step.locator('summary').click();await expect(combo).toHaveValue('claude-fable-5-1');
  await step.getByLabel('Provider').selectOption('claude');await expect(combo).toHaveValue('');
  open();await page.waitForTimeout(200);
  await combo.click();await expect(step.getByRole('listbox')).toContainText('sonnet');await expect(step.getByRole('listbox')).not.toContainText('gpt-5.6-sol');await expect(step.getByRole('button',{name:'Refresh claude models'})).toHaveCount(0);await expect(combo).toHaveValue('');
  await combo.press('Escape');expect(app.store.getWorkflow('quick-review').steps[0].model).toBe('claude-fable-5-1');
  await step.getByLabel('Provider').selectOption('codex');await combo.click();await expect(step.getByRole('listbox')).toContainText('Discovered from Codex');await step.getByRole('option').filter({hasText:'gpt-5.6-sol'}).click();await expect(combo).toHaveValue('gpt-5.6-sol');
  await page.getByRole('button',{name:'Save workflow',exact:true}).click();await expect(page.locator('.wf-message')).toContainText(/saved/i);
  await combo.click();await combo.fill('gpt-5.5');await step.getByRole('button',{name:'Refresh codex models'}).click();await expect(combo).toHaveValue('gpt-5.6-sol');await expect(page.locator('.wf-message')).toContainText(/saved/i);expect(app.store.getWorkflow('quick-review').steps[0].model).toBe('gpt-5.6-sol');
 }finally{open();await page.goto('about:blank');await stopApp(app,root);}
});

test('optional second opinion uses provider suggestions and survives edits to the primary reviewer',async({page})=>{
 const {app,root,address}=await startApp(async()=>{},()=>false);
 try{
  await page.goto(`${address}/?view=workflows&workflow=single-review-delivery`);
  const step=page.locator('.wf-step').nth(3);await step.locator('summary').click();
  const second=step.getByRole('combobox',{name:'Second reviewer model',exact:true});
  await second.click();await expect(step.getByRole('listbox')).toContainText('sonnet');
  await expect(step.getByRole('listbox')).not.toContainText('CLI default');
  await step.getByRole('option').filter({hasText:'opus'}).click();
  const primary=step.getByRole('combobox',{name:'Reviewer model',exact:true});
  await primary.click();await primary.fill('gpt-5.6-sol');await primary.press('Enter');
  await expect(second).toHaveValue('opus');
  await step.getByRole('combobox',{name:'Second reviewer provider',exact:true}).selectOption('opencode');
  await expect(second).toHaveValue('');await expect(step.getByLabel('Second reviewer effort')).toHaveValue('');
  await second.click();await expect(step.getByRole('listbox')).toContainText('deepseek/deepseek-flash');
  await second.fill('acme/custom-second');await step.getByRole('option').filter({hasText:'Use custom model'}).click();
  await page.getByRole('button',{name:'Save workflow',exact:true}).click();await expect(page.locator('.wf-message[role=status]')).toContainText(/saved/i);
  await page.reload();await step.locator('summary').click();await expect(second).toHaveValue('acme/custom-second');await expect(primary).toHaveValue('gpt-5.6-sol');
  await second.click();await expect(step.getByRole('listbox')).toContainText('acme/custom-second');
  const ids=await step.getByRole('combobox').evaluateAll(elements=>elements.map(e=>e.getAttribute('aria-controls')).filter(Boolean));expect(new Set(ids).size).toBe(ids.length);
  await step.getByRole('combobox',{name:'Second reviewer provider',exact:true}).selectOption('claude');
  expect(await second.evaluate(element=>(element as HTMLInputElement).validity.valueMissing)).toBe(true);
  expect(app.store.getWorkflow('single-review-delivery').steps[3].council.secondOpinion.model).toBe('acme/custom-second');
 }finally{await page.goto('about:blank');await stopApp(app,root);}
});

test('council reviewer fields offer their provider suggestions and keep models explicit',async({page})=>{
 const {app,root,address}=await startApp(async()=>{},()=>false);
 try{
  const council=app.store.getWorkflow('council-delivery');
  council.steps[3].council.reviewers=[
   {...council.steps[3].council.reviewers[0],provider:'codex',model:'gpt-5.6-sol',effort:'high'},
   {...council.steps[3].council.reviewers[1],provider:'claude',model:'sonnet',effort:'high'},
   {...council.steps[3].council.reviewers[2],provider:'opencode',model:'acme/legacy-review',effort:'high'},
  ];
  app.store.saveWorkflow(council);
  await page.goto(`${address}/?view=workflows&workflow=council-delivery`);
  const step=page.locator('.wf-step').nth(3);await step.locator('summary').click();
  const reviewers=step.getByLabel('Reviewer model',{exact:true});
  await expect(reviewers).toHaveCount(3);await expect(step.getByRole('combobox',{name:'Model',exact:true})).toHaveCount(1);
  await step.getByRole('button',{name:'Show Claude Code models'}).click();
  const claudeOptions=step.getByRole('listbox');
  await expect(claudeOptions).toBeVisible();await expect(claudeOptions).toContainText('Built-in suggestions');await expect(claudeOptions).toContainText('sonnet');
  await expect(claudeOptions).not.toContainText('CLI default');
  await step.getByRole('option').filter({hasText:'opus'}).click();
  await expect(reviewers.nth(1)).toHaveValue('opus');await expect(reviewers.nth(0)).toHaveValue('gpt-5.6-sol');await expect(reviewers.nth(2)).toHaveValue('acme/legacy-review');
  const codexReviewer=step.locator('fieldset').nth(0);
  await codexReviewer.getByRole('button',{name:'Show Codex models'}).click();
  await expect(codexReviewer.getByRole('listbox')).toContainText('Discovered from Codex');
  await codexReviewer.getByRole('option').filter({hasText:'gpt-6-astra'}).click();
  await expect(reviewers.nth(0)).toHaveValue('gpt-6-astra');await expect(reviewers.nth(1)).toHaveValue('opus');
  const opencodeReviewer=reviewers.nth(2);
  await opencodeReviewer.click();await opencodeReviewer.press('ArrowDown');await opencodeReviewer.press('Enter');
  await expect(opencodeReviewer).toHaveValue('opencode/gpt-5.1-codex');await expect(reviewers.nth(0)).toHaveValue('gpt-6-astra');
  const codexCombo=codexReviewer.getByRole('combobox',{name:'Reviewer model'});
  await codexCombo.click();await codexCombo.fill('acme/rocket-9');
  await codexReviewer.getByRole('option').filter({hasText:'Use custom model'}).click();
  await page.getByRole('button',{name:'Save workflow',exact:true}).click();await expect(page.locator('.wf-message[role=status]')).toContainText(/saved/i);
  await page.reload();await step.locator('summary').click();await expect(reviewers.nth(0)).toHaveValue('acme/rocket-9');
  await codexReviewer.getByLabel('Reviewer provider').selectOption('claude');
  await expect(reviewers.nth(0)).toHaveValue('');await expect(reviewers.nth(0)).toHaveAttribute('placeholder','Select a model');
  await reviewers.nth(0).click();
  await expect(step.getByRole('listbox')).toContainText('sonnet');await expect(step.getByRole('listbox')).not.toContainText('gpt-6-astra');
  expect(await reviewers.nth(0).evaluate(element=>(element as HTMLInputElement).validity.valueMissing)).toBe(true);
  await page.getByRole('button',{name:'Save workflow',exact:true}).click();await expect(page.locator('.wf-message')).toHaveCount(0);
  await reviewers.nth(0).click();await step.getByRole('option').filter({hasText:'sonnet'}).click();await expect(reviewers.nth(0)).toHaveValue('sonnet');
  await page.getByRole('button',{name:'Save workflow',exact:true}).click();await expect(page.locator('.wf-message[role=status]')).toContainText(/saved/i);
  expect(app.store.getWorkflow('council-delivery').steps[3].council.reviewers[0].model).toBe('sonnet');
 }finally{await page.goto('about:blank');await stopApp(app,root);}
});
