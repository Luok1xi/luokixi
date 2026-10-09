import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {createApp} from '../src/server.mjs';
import {dateMinute} from '../src/time.mjs';
const require=createRequire(import.meta.url);let pw;try{pw=require('playwright');}catch{pw=require('C:/Users/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');}
const messages=[{type:'text',text:'嗯！  等等～'},{type:'sticker',id:'eyes'},{type:'text',text:'这条另发。'}];
const models={config:()=>({deepseekKey:'test'}),usage:()=>({spent:0,limit:200,rows:[]}),complete:async(m,o)=>({text:o.json?JSON.stringify({actions:[],act:'social'}):JSON.stringify({messages})})};
const app=await createApp({dbPath:':memory:',background:false,models,clock:()=>dateMinute('2026-09-21','10:00')});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
let browser;try{browser=await pw.chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:'+app.server.address().port);await page.locator('#message').fill('在吗');await page.locator('#send').click();
 await page.waitForFunction(()=>document.querySelectorAll('#chat-list .bubble:not(.user)').length===3);
 assert.equal(await page.locator('#chat-list img').count(),1);await page.waitForFunction(()=>document.querySelector('#chat-list img').naturalWidth>0);
 assert.equal(app.store.chats().at(-1).messages.length,3);await page.reload();await page.waitForFunction(()=>document.querySelectorAll('#chat-list .bubble:not(.user)').length===3);
 await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+2));
 await page.locator('nav [data-tab="persona"]').click();assert.equal(await page.locator('[name="dailyBurstLimit"]').inputValue(),'6');assert.equal(await page.locator('[name="maxUnanswered"]').inputValue(),'0');
 assert.deepEqual(errors,[]);console.log('Verified: three separate bubbles, real PNG loaded, reload persistence, frequency settings, mobile layout; no paid model or external messages.');
}finally{await browser?.close();await app.close();}
