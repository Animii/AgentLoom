import { test,expect, type Page } from '@playwright/test';
const stamp=Date.now();
async function createDemo(page:Page,title:string,workflow:string){
 await page.getByRole('button',{name:'New run',exact:true}).first().click();
 const dialog=page.getByRole('dialog');await dialog.getByLabel('Task title',{exact:true}).fill(title);
 await dialog.getByLabel('Task brief',{exact:true}).fill('Exercise the workflow and its approval controls.');
 await dialog.getByLabel('Project',{exact:true}).selectOption('welcome');
 await dialog.getByLabel('Workflow',{exact:true}).selectOption(workflow);await dialog.getByLabel('Mode',{exact:true}).selectOption('demo');
 await dialog.getByRole('button',{name:'Start run',exact:true}).click();await expect(dialog).not.toBeVisible();
 await expect(page.locator('.detail-title')).toHaveText(title);
}
test('gated four-role workflow with revision, activity, files and final approval',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('/?view=runs');
 await createDemo(page,`E2E gated ${stamp}`,'review-build');
 await expect(page.locator('.detail-status .status-waiting_input')).toBeVisible();
 await expect(page.getByRole('button',{name:'Approve plan and continue'})).toHaveCount(0);
 await page.getByRole('button',{name:'Reply in chat instead'}).click();
 await page.getByLabel('Message the planner').fill('For local developers. Keep the change small and verify it in the browser.');
 await page.getByRole('button',{name:'Send message',exact:true}).click();
 await expect(page.getByRole('button',{name:'Approve plan and continue'})).toBeVisible();
 await page.getByRole('button',{name:'Approve plan and continue'}).click();
 await expect(page.getByRole('button',{name:'Approve and continue'})).toBeVisible();
 await page.getByRole('button',{name:'Request revision'}).click();await page.getByLabel('Revision feedback').fill('Use a smaller approved change.');
 await page.getByRole('button',{name:'Send revision'}).click();await expect(page.locator('.step-attempt').first()).toHaveText('attempt 2');
 await expect(page.getByRole('button',{name:'Approve and continue'})).toBeVisible();
 await page.getByRole('tab',{name:'Activity',exact:true}).click();await expect(page.locator('.activity-list')).toContainText('revision');
 await page.getByRole('tab',{name:'Files',exact:true}).click();await page.getByRole('button',{name:'README.md',exact:true}).click();await expect(page.locator('.file-viewer')).toContainText('Welcome');
 await page.getByRole('tab',{name:'Output',exact:true}).click();
 for(let i=1;i<4;i++){
  await expect(page.getByRole('button',{name:'Approve and continue'})).toBeVisible();await page.getByRole('button',{name:'Approve and continue'}).click();
  if(i<3)await expect(page.locator('.step-list li').nth(i).locator('.status-chip')).toHaveText('Completed');
 }
 await expect(page.locator('.detail-status .status-completed')).toBeVisible();await page.reload();
 await expect(page.locator('.detail-title')).toHaveText(`E2E gated ${stamp}`);expect(errors).toEqual([]);
});
test('automatic review finishes without approvals; second gated approach can be cancelled',async({page})=>{
 await page.goto('/?view=runs');await createDemo(page,`E2E automatic ${stamp}`,'quick-review');await expect(page.locator('.detail-status .status-completed')).toBeVisible();
 await expect(page.getByRole('button',{name:'Approve and continue'})).toHaveCount(0);
 await createDemo(page,`E2E cancelled ${stamp}`,'fix-verify');await expect(page.getByRole('button',{name:'Approve and continue'})).toBeVisible();
 await page.locator('.approval-bar').getByRole('button',{name:'Cancel',exact:true}).click();await expect(page.locator('.detail-status .status-cancelled')).toBeVisible();
});
test('workflow editing persists; provider discovery and narrow layout work',async({page})=>{
 await page.goto('/?view=runs');await page.getByRole('button',{name:'Workflows',exact:true}).click();
 await page.getByLabel('Description',{exact:true}).fill('Local workflow validated by browser E2E.');await page.getByRole('button',{name:'Save workflow',exact:true}).click();
 await expect(page.getByRole('status')).toContainText(/saved/i);await page.reload();await page.getByRole('button',{name:'Workflows',exact:true}).click();await expect(page.getByLabel('Description',{exact:true})).toHaveValue('Local workflow validated by browser E2E.');
 await page.getByRole('button',{name:'Agents',exact:true}).click();await expect(page.getByRole('heading',{name:'Agent connections'})).toBeVisible();await expect(page.locator('.provider-card')).toHaveCount(3);
 await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'Runs',exact:true}).click();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBeTruthy();
 await page.getByRole('button',{name:'New run',exact:true}).first().click();await expect(page.getByRole('dialog')).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBeTruthy();
});

test('failed workspace preparation is visible and explicit retry recovers',async({page,request})=>{
 const {mkdir,writeFile,unlink,rmdir}=await import('node:fs/promises');const path=await import('node:path');
 const project=`e2e-recovery-${Date.now()}`;const projectPath=path.resolve(process.env.E2E_WORKSPACE_ROOT??'workspaces','projects',project);
 const title=`E2E retry ${Date.now()}`;const created=await request.post('/api/runs',{data:{title,task:'Exercise failure recovery only.',project,workflowId:'quick-review',mode:'demo'}});expect(created.status()).toBe(201);
 await page.goto('/?view=runs');await page.getByRole('button').filter({hasText:title}).first().click();await expect(page.locator('.detail-status .status-failed')).toBeVisible();await expect(page.locator('.run-detail')).toContainText('Workspace preparation failed');
 await mkdir(projectPath);await writeFile(path.join(projectPath,'README.md'),'Recovery fixture');
 try {await page.getByRole('button',{name:'Retry step',exact:true}).click();await expect(page.locator('.detail-status .status-completed')).toBeVisible();await page.getByRole('tab',{name:'Activity',exact:true}).click();await page.getByRole('button',{name:'All events',exact:true}).click();await expect(page.locator('.activity-list')).toContainText('Run queued for retry');}
 finally {await unlink(path.join(projectPath,'README.md'));await rmdir(projectPath);}
});
