// Isolated browser verification: synthetic messages, in-memory database, no paid calls or sending.
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {createApp} from '../src/server.mjs';
const require=createRequire(import.meta.url);
let playwright;try{playwright=require('playwright');}catch{playwright=require('C:/Users/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');}
const app=await createApp({dbPath:':memory:',background:false});let calls=0;
app.models.complete=async(messages,options)=>{calls++;if(options.purpose==='dialogue-conversation-analysis'){
  const m=JSON.parse(messages.at(-1).content).messages[0];return {text:JSON.stringify({summary:'材料通知',advice:[],todos:[{title:'确认报名材料',priority:3,deadlineText:'周五',steps:['问清分工'],evidence:[{messageId:m.id,quote:m.text}]}],uncertainties:['消息没有具体日期']})};
}return {text:JSON.stringify({messages:[{type:'text',text:'先问问这份材料是不是你负责吧。'}]})};};
await new Promise(r=>app.server.listen(0,'127.0.0.1',r));let browser;
try{
  browser=await playwright.chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:'+app.server.address().port);await page.locator('#conversation-library').waitFor({state:'attached'});
  await page.locator('nav [data-tab="research"]').click();const form=page.locator('#conversation-import');
  await form.locator('[name="title"]').fill('竞赛测试');await form.locator('[name="rawText"]').fill('队长：周五交材料 <script>alert(1)</script>');
  await form.locator('button').click();await page.locator('#conversation-original').getByText('队长：周五交材料', {exact:false}).waitFor({state:'attached'});assert.equal(calls,0);
  await page.locator('#conversation-analyze').click();await page.getByText('先问问这份材料是不是你负责吧。',{exact:true}).waitFor();assert.equal(calls,2);
  await page.locator('[data-todo="0"]').click();assert.equal(await page.locator('#task-form [name="title"]').inputValue(),'确认报名材料');assert.equal(await page.locator('#task-form [name="remaining"]').inputValue(),'');assert.equal(app.store.read().tasks.length,0);
  await page.locator('nav [data-tab="research"]').click();await page.locator('#conversation-delete').click();await page.waitForFunction(()=>document.querySelector('#conversation-source').options.length===1);assert.equal(app.conversations.sources().length,0);
  await page.locator('nav [data-tab="settings"]').click();await page.locator('#breakfast-habit [name="start"]').fill('07:30');await page.locator('#breakfast-habit [name="end"]').fill('08:20');await page.locator('#breakfast-habit button').click();await page.getByText('早餐习惯已保存，作为聊天参考；不会自动创建提醒或固定日程。',{exact:true}).waitFor();
  assert.equal(app.store.read().settings.breakfastHabit.start,'07:30');assert.deepEqual(errors,[]);assert.equal(app.store.chats().length,0);assert.equal(app.store.messages().length,0);
  console.log('Browser verified: selected import, escaped original, shared analysis, reviewed task draft, deletion, breakfast settings; 2 stub calls, no external messages.');
}finally{await browser?.close();await app.close();}
