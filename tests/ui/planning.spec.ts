import {test,expect} from '@playwright/test';

test('planning chat survives reload, keeps corrections and gates the handoff',async({page,request})=>{
 const title=`E2E planning ${Date.now()}`;
 const created=await request.post('/api/runs',{data:{title,task:'Plan an accessible local dashboard.',project:'welcome',workflowId:'review-build',mode:'demo'}});
 expect(created.status()).toBe(201);const run=await created.json();
 await page.goto('/?view=runs');await page.getByRole('button').filter({hasText:title}).first().click();
 await expect(page.getByRole('region',{name:'Planning conversation'})).toContainText('Who is this for?');
 await expect(page.getByRole('button',{name:'Approve plan and continue'})).toHaveCount(0);
 expect((await request.post(`/api/runs/${run.id}/approve`)).status()).toBe(409);
 // A failed send keeps the draft so the user can retry.
 await page.getByRole('button',{name:'Reply in chat instead'}).click();
 await page.route(`**/api/runs/${run.id}/messages`,async route=>{await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Temporary connection problem'})});await page.unroute(`**/api/runs/${run.id}/messages`);});
 await page.getByLabel('Message the planner').fill('For local developers. It must work offline.');
 await page.getByRole('button',{name:'Send message',exact:true}).click();
 await expect(page.getByRole('alert')).toContainText('Temporary connection problem');
 await expect(page.getByLabel('Message the planner')).toHaveValue('For local developers. It must work offline.');
 await page.getByRole('button',{name:'Send message',exact:true}).click();
 await expect(page.getByRole('button',{name:'Approve plan and continue'})).toBeVisible();
 await expect(page.getByLabel('Message the planner')).toHaveValue('');
 await page.reload();await expect(page.locator('.detail-title')).toHaveText(title);
 await expect(page.locator('.chat-messages')).toContainText('It must work offline.');
 await page.getByLabel('Message the planner').fill('Add full keyboard support.');await page.getByRole('button',{name:'Send message',exact:true}).click();
 await expect(page.getByLabel('Message the planner')).toHaveValue('');
 await expect(page.locator('.chat-assistant').last()).toContainText('Add full keyboard support.');
 await expect(page.getByRole('button',{name:'Approve plan and continue'})).toBeVisible();
 const ready=await (await request.get(`/api/runs/${run.id}`)).json();
 expect(ready.steps[0].conversation).toHaveLength(7);expect(ready.steps[1].attempt).toBe(0);
 expect(ready.steps[0].output).toContain('offline');expect(ready.steps[0].output).toContain('keyboard support');
 await page.screenshot({path:'artifacts/planning-chat-desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
 await page.screenshot({path:'artifacts/planning-chat-mobile.png',fullPage:true});
 await page.getByRole('button',{name:'Approve plan and continue'}).click();
 await expect(page.getByRole('button',{name:'Approve and continue'})).toBeVisible();
 await page.locator('.step-list li').first().getByRole('button').click();
 await expect(page.getByLabel('Message the planner')).toBeVisible();
 await expect(page.locator('.chat-footnote')).toContainText('Later steps and their approvals');
 await request.post(`/api/runs/${run.id}/cancel`);
});

