import {createRequire} from 'node:module';
import {mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
import {createApp} from '../src/server.mjs';
const require=createRequire(import.meta.url),{chromium}=require('C:/Users/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const models={config:()=>({deepseekKey:''}),usage:()=>({spent:0,limit:200,rows:[]})};
const app=await createApp({dbPath:':memory:',background:false,models});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
  const page=await browser.newPage({viewport:{width:1440,height:1050}}),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:'+app.server.address().port);await page.locator('#research-goal').waitFor({state:'attached'});await page.locator('nav [data-tab="research"]').click();
  await page.locator('#research-goal [name="title"]').fill('测试：完成循迹小车');await page.locator('#research-goal [name="keywords"]').fill('robot navigation');await page.getByRole('button',{name:'保存目标',exact:true}).click();await page.locator('#research-goals strong').waitFor();assert.equal(app.store.read().research.goals.length,1);
  await page.locator('#research-source [name="title"]').fill('测试大学图书馆');await page.locator('#research-source [name="url"]').fill('https://example.edu/news');await page.getByRole('button',{name:'添加来源',exact:true}).click();await page.locator('#research-sources strong').waitFor();assert.equal(app.store.read().research.sources.length,1);
  await page.locator('#research-notice [name="title"]').fill('老师通知');await page.locator('#research-notice [name="text"]').fill('请于下周提交报告，详细要求稍后发布。');await page.getByRole('button',{name:'加入待整理通知',exact:true}).click();await page.locator('#research-notices strong').waitFor();assert.equal(app.store.read().research.notices.length,1);
  await page.getByRole('button',{name:'停止关注',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('#research-goals strong'));assert.equal(app.store.read().research.goals.length,1);assert.equal(app.store.read().research.goals[0].active,false);
  await page.locator('#research-toggle').click();await page.waitForFunction(()=>document.querySelector('#research-toggle').textContent==='开启每日检查');assert.equal(app.store.read().research.enabled,false);
  mkdirSync('test-output',{recursive:true});await page.screenshot({path:resolve('test-output/research-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:resolve('test-output/research-mobile.png'),fullPage:true});assert.deepEqual(errors,[]);
  console.log('Research UI: goals, subscriptions, forwarded notices, pause, desktop/mobile and browser errors verified.');
}finally{await browser.close();await app.close();}
