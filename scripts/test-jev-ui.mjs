import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import path from 'node:path';import {tmpdir} from 'node:os';
import {chromium,expect} from '@playwright/test';
import {createApp} from '../dist/server/app.js';
const root=await mkdtemp(path.join(tmpdir(),'loom-jev-browser-'));await mkdir('artifacts',{recursive:true});
const previous=process.env.TYPESAFE_API_KEY;delete process.env.TYPESAFE_API_KEY;
const secret='browser-fixture-jev-key';let calls=0;
const mockFetch=async(url,options)=>{if(url!=='https://api.typesafe.ai/v1/systemone')throw Error('Unexpected URL');if(new Headers(options.headers).get('authorization')!=='Bearer '+secret)throw Error('Wrong credential');calls++;const body=JSON.parse(options.body);const [id,q]=Object.entries(body.questions)[0];let answer;if(q.type==='noul')answer={type:'noul',noul:0.75};else if(q.type==='choice'){const keys=Object.keys(q.criteria);answer={type:'choice',choice:keys[0],confidence:0.9,probabilities:Object.fromEntries(keys.map((x,i)=>[x,i===0?1:0]))};}else answer={type:'score',score:1,confidence:0.9,probabilities:{'0':0,'1':1,'2':0}};return Response.json({model:'jev-1.13.0',answers:{[id]:answer}});};
const config={dataDir:root,workspaceRoot:path.join(root,'workspaces'),host:'127.0.0.1',port:4319,cliTimeoutMs:1000,maxOutputBytes:10000};
let app=await createApp(config,{jevFetch:mockFetch});let browser;
try {
 const address=await app.listen({host:'127.0.0.1',port:0});const port=Number(new URL(address).port);browser=await chromium.launch();const page=await browser.newPage({viewport:{width:1280,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(address);await page.getByRole('button',{name:'Agents',exact:true}).click();await expect(page.getByRole('heading',{name:'Jev (TypeSafe)',exact:true})).toBeVisible();
 await page.getByText('API key and connection',{exact:true}).click();await page.getByLabel('Jev API key',{exact:true}).fill(secret);await page.getByRole('button',{name:'Save API key',exact:true}).click();await expect(page.getByLabel('Jev API key',{exact:true})).toHaveValue('');await expect(page.getByText('API key saved',{exact:true})).toBeVisible();
 await app.close();app=await createApp(config,{jevFetch:mockFetch});await app.listen({host:'127.0.0.1',port});await page.reload();await page.getByRole('button',{name:'Agents',exact:true}).click();await expect(page.getByText('API key saved',{exact:true})).toBeVisible();
 await page.getByText('API key and connection',{exact:true}).click();await page.getByRole('button',{name:'Test connection',exact:true}).click();await expect(page.getByText(/Connection verified/)).toBeVisible();
 await page.getByText('Try an evaluation',{exact:true}).click();await page.getByLabel('Text to evaluate',{exact:true}).fill('Build is blocked because the requirements are missing.');
 for(const type of ['noul','choice','score']){await page.getByLabel('Question type',{exact:true}).selectOption(type);await page.getByRole('button',{name:'Evaluate',exact:true}).click();await expect(page.locator('pre').last()).toContainText('"type": "'+type+'"');}
 await page.screenshot({path:'artifacts/jev-desktop.png',fullPage:true});await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
 await page.getByRole('button',{name:'Remove saved key',exact:true}).click();await expect(page.getByText('No API key configured',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Test connection',exact:true})).toBeDisabled();
 expect(await page.locator('body').innerText()).not.toContain(secret);expect(errors).toEqual([]);expect(calls).toBe(4);console.log('PASS: Jev key save, restart persistence, connection test, all 3 evaluations, mobile layout and removal. Upstream calls used a deterministic fixture; no real provider key used.');
}finally{await browser?.close();await app.close();if(previous===undefined)delete process.env.TYPESAFE_API_KEY;else process.env.TYPESAFE_API_KEY=previous;await rm(root,{recursive:true,force:true});}
