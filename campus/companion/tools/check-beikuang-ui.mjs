import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdirSync,writeFileSync} from 'node:fs';
import {createApp} from '../src/server.mjs';
import {characterCard} from '../src/character-card.mjs';
const require=createRequire(import.meta.url);let pw;
try{pw=require('playwright');}catch{pw=require('C:/Users/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');}
const models={config:()=>({}),usage:()=>({spent:0,limit:200,rows:[]}),complete:async()=>{throw Error('No paid model in UI check');}};
const app=await createApp({dbPath:':memory:',background:false,models});
await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
let browser;
try{
  browser=await pw.chromium.launch({channel:'msedge',headless:true,timeout:20000});
  const page=await browser.newPage({viewport:{width:1360,height:1000}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:'+app.server.address().port);
  await page.waitForFunction(()=>!document.querySelector('#send').disabled);
  assert.equal(await page.title(),characterCard.name+' · 北矿娘');
  assert.equal(await page.locator('.chat-heading strong').innerText(),characterCard.name);
  await page.waitForFunction(()=>document.querySelector('#character-avatar img')?.naturalWidth>0);
  await page.locator('nav [data-tab="persona"]').click();
  await page.waitForFunction(()=>document.querySelector('#character-portrait img')?.naturalWidth>0);
  assert.ok(await page.locator('#character-portrait').isVisible());
  mkdirSync('test-output',{recursive:true});
  await page.screenshot({path:'test-output/beikuang-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.locator('nav [data-tab="chat"]').click();
  assert.equal(await page.locator('#page-title').innerText(),'和 '+characterCard.name+' 说说话');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));
  await page.screenshot({path:'test-output/beikuang-mobile.png',fullPage:true});
  assert.deepEqual(errors,[]);
  const result={status:'PASS',title:await page.title(),desktop:[1360,1000],mobile:[390,844],avatarLoaded:true,portraitLoaded:true,pageErrors:errors,syntheticState:true};
  writeFileSync('test-output/beikuang-ui.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await browser?.close();await app.close();}
