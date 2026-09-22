import {test,expect} from '@playwright/test';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

test('archive removes workflows from active lists and new runs, with restore after reload',async({page})=>{
 const root=await mkdtemp(path.join(tmpdir(),'loom-archive-ui-'));await mkdir(path.join(root,'work/projects/welcome'),{recursive:true});
 const {createApp}=await import(pathToFileURL(path.resolve('dist/server/app.js')).href);
 const app=await createApp({dataDir:path.join(root,'data'),workspaceRoot:path.join(root,'work'),host:'127.0.0.1',port:0,cliTimeoutMs:1000,maxOutputBytes:10000});
 try{
  const address=await app.listen({port:0,host:'127.0.0.1'});
  await page.goto(`${address}/?view=workflows&workflow=quick-review`);
  await page.getByRole('button',{name:'Archive workflow',exact:true}).click();
  await expect(page.locator('.wf-item').filter({hasText:'Quick Review'})).toHaveCount(0);
  await page.reload();await expect(page.locator('.wf-item').filter({hasText:'Quick Review'})).toHaveCount(0);
  await page.goto(`${address}/?view=runs`);await page.getByRole('button',{name:'New run',exact:true}).click();
  await expect(page.getByRole('dialog').getByRole('option',{name:'Quick Review',exact:true})).toHaveCount(0);
  await page.goto(`${address}/?view=workflows`);
  await page.getByLabel(/Show archived workflows/).check();
  await page.locator('.wf-item').filter({hasText:'Quick Review (archived)'}).click();
  await expect(page.getByRole('button',{name:'Save workflow',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'Restore workflow',exact:true}).click();
  await expect(page.getByRole('button',{name:'Save workflow',exact:true})).toBeEnabled();
  await page.reload();await expect(page.locator('.wf-item').filter({hasText:'Quick Review'})).toBeVisible();
  expect(app.store.getWorkflow('quick-review').archived).toBe(false);
 }finally{await page.goto('about:blank').catch(()=>{});app.server.closeAllConnections();await app.close();await rm(root,{recursive:true,force:true});}
});
