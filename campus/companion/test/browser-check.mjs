import {createRequire} from 'node:module';
import {mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
import {createApp} from '../src/server.mjs';
import {dateKey,nowMinute} from '../src/time.mjs';
const require=createRequire(import.meta.url);
let playwright;try{playwright=require('playwright');}catch{playwright=require('C:/Users/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');}
const offlineModels={config:()=>({deepseekKey:''}),usage:()=>({spent:0,limit:200,rows:[]}),complete:async()=>{throw new Error('Browser CRUD tests must never call a paid model.');}};
const app=await createApp({dbPath:':memory:',background:false,models:offlineModels});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
let browser;const errors=[];
try{
  browser=await playwright.chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:'+app.server.address().port);await page.getByRole('heading',{name:'从今天开始，慢慢认识。'}).waitFor();
  await page.locator('nav [data-tab="tasks"]').click();await page.locator('#task-form [name="title"]').fill('高数第三章作业');await page.locator('#task-form [name="remaining"]').fill('180');await page.locator('#task-form [name="deadline"]').fill(dateKey(nowMinute()+3*1440)+'T22:00');await page.getByRole('button',{name:'保存并安排'}).click();await page.locator('#task-list strong').filter({hasText:'高数第三章作业'}).waitFor();
  assert.equal(app.store.read().tasks[0].remaining,180);
  await page.locator('nav [data-tab="chat"]').click();await page.locator('#message').fill('高数还需要两小时');await page.getByRole('button',{name:'发送 ↗'}).click();await page.waitForFunction(()=>document.querySelector('#chat-list').textContent.includes('现在还需要 120 分钟'));assert.equal(app.store.read().tasks[0].remaining,120);
  await page.locator('nav [data-tab="courses"]').click();await page.locator('#course-form [name="title"]').fill('机器人学');await page.locator('#course-form [name="location"]').fill('工学楼 B301');await page.getByRole('button',{name:'保存课程',exact:true}).click();await page.locator('#course-list strong').filter({hasText:'机器人学'}).waitFor();assert.equal(app.store.read().courses.length,1);
  await page.locator('nav [data-tab="memory"]').click();await page.locator('#memory-form [name="content"]').fill('我喜欢安静地阅读');await page.getByRole('button',{name:'保存记忆',exact:true}).click();await page.locator('#memory-list strong').filter({hasText:'我喜欢安静地阅读'}).waitFor();page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'忘记',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('#memory-list').textContent.includes('我喜欢安静地阅读'));assert.equal(app.store.read().memories.length,0);assert.equal(app.store.chats().length,0);
  await page.locator('nav [data-tab="plan"]').click();await page.getByRole('button',{name:'今天想休息'}).click();await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('弹性学习任务会移开'));assert.ok(app.store.read().restUntil>nowMinute());
  for(const tab of ['tasks','courses','memory','persona','settings','chat']){await page.locator(`nav [data-tab="${tab}"]`).click();assert.ok(await page.locator('#'+tab).isVisible());}
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  mkdirSync(resolve('test-output'),{recursive:true});await page.screenshot({path:resolve('test-output/console-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.reload();await page.locator('#send').waitFor();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.deepEqual(errors,[]);console.log(JSON.stringify({browser:'Edge',desktop:'1440x1000',mobile:'390x844',checks:['task add','offline remaining update','course add','forget purges chat','rest replan','all navigation','no horizontal overflow','no browser errors'],screenshot:resolve('test-output/console-desktop.png')},null,2));
}finally{await browser?.close();await app.close();}
