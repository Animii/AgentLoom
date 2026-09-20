import {test,expect} from '@playwright/test';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

test('Projects connects a real folder and manages its mode, name, archive and history',async({page})=>{
 const root=await mkdtemp(path.join(tmpdir(),'loom-project-ui-'));const host=path.join(root,'host');await mkdir(path.join(host,'Game'),{recursive:true});await writeFile(path.join(host,'Game/README.md'),'Original game');
 const {createApp}=await import(pathToFileURL(path.resolve('dist/server/app.js')).href);const app=await createApp({dataDir:path.join(root,'data'),workspaceRoot:path.join(root,'work'),projectRoot:host,projectHostRoot:host,host:'127.0.0.1',port:0,cliTimeoutMs:1000,maxOutputBytes:1000});
 try{
  const address=await app.listen({port:0,host:'127.0.0.1'});await page.goto(address);await page.getByRole('button',{name:'Projects',exact:true}).click();await page.getByRole('button',{name:'Connect folder',exact:true}).click();await page.getByRole('button',{name:'Game',exact:false}).click();
  await expect(page.getByLabel('Workspace mode',{exact:true})).toHaveValue('direct');await page.getByLabel('Project name',{exact:true}).fill('My connected game');await page.getByRole('button',{name:'Connect this folder',exact:true}).click();await expect(page.getByRole('region',{name:'Project settings'})).toBeVisible();
  await expect(page.locator('.project-row')).toContainText('Connected folder');await expect(page.locator('.project-row')).toContainText('Direct');
  await page.getByRole('button',{name:'New run for project',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('Direct folder: live implementation edits the source files.');
  await page.getByLabel('Task title',{exact:true}).fill('Connected project demo');await page.getByLabel('Task brief',{exact:true}).fill('Inspect the project');await page.getByLabel('Workflow',{exact:true}).selectOption('quick-review');await page.getByLabel('Mode',{exact:true}).selectOption('demo');await page.getByRole('button',{name:'Start run',exact:true}).click();await expect(page.locator('.detail-status .status-completed')).toBeVisible();await expect(page.locator('.detail-heading')).toContainText('Direct folder');
  await page.getByRole('button',{name:'Projects',exact:true}).click();await page.getByLabel('Project name',{exact:true}).fill('Renamed game');await page.getByRole('button',{name:'Save name',exact:true}).click();await expect(page.locator('.project-row')).toContainText('Renamed game');
  await page.getByLabel('Workspace mode',{exact:true}).selectOption('isolated');await expect(page.locator('.project-row')).toContainText('Isolated');
  await page.getByRole('button',{name:'Archive',exact:true}).click();await expect(page.locator('.project-row')).toHaveCount(0);await page.getByLabel('Project status').selectOption('archived');await page.locator('.project-row').click();await page.getByRole('button',{name:'Restore project',exact:true}).click();await page.getByLabel('Project status').selectOption('active');await page.locator('.project-row').click();
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'artifacts/projects-mobile.png',fullPage:true});
  await page.getByRole('button',{name:'Disconnect',exact:true}).click();await page.getByRole('button',{name:'Disconnect project',exact:true}).click();await page.getByLabel('Project status').selectOption('disconnected');await page.locator('.project-row').click();await page.getByText('Run history (1)',{exact:true}).click();await expect(page.locator('.project-history')).toContainText('Connected project demo');
  expect(await readFile(path.join(host,'Game/README.md'),'utf8')).toBe('Original game');await page.reload();await expect(page.getByLabel('Project status')).toHaveValue('disconnected');await expect(page.locator('.project-row')).toContainText('Renamed game');await page.getByRole('button',{name:'Reconnect',exact:true}).click();await page.getByLabel('Project status').selectOption('active');await expect(page.locator('.project-row')).toHaveCount(1);
 }finally{await page.goto('about:blank');app.server.closeAllConnections();await app.close();await rm(root,{recursive:true,force:true});}
});
