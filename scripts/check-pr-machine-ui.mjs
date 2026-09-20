import {chromium} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
const url=process.argv[2];
if(!url||!['localhost','127.0.0.1'].includes(new URL(url).hostname))throw Error('Pass a local PR-machine run URL.');
await mkdir('artifacts',{recursive:true});
const browser=await chromium.launch({headless:true});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(url);const panel=page.getByRole('region',{name:'PR machine'});await panel.waitFor();
 if(!(await panel.innerText()).includes('Merge remains manual.'))throw Error('Policy disclosure missing.');
 await panel.scrollIntoViewIfNeeded();await page.screenshot({path:'artifacts/pr-machine-desktop.png'});
 await page.reload();await panel.waitFor();await page.setViewportSize({width:390,height:844});await panel.scrollIntoViewIfNeeded();
 if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('Mobile page overflows horizontally.');
 await page.screenshot({path:'artifacts/pr-machine-mobile.png'});
 if(errors.length)throw Error(errors.join('\n'));
 console.log(JSON.stringify({url,policy:await panel.innerText(),reload:true,mobile:true,pageErrors:errors}));
}finally{await browser.close();}
