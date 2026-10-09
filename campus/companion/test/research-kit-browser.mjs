// Edge check of the research toolkit panel with scripted models (no paid calls) and a temporary config file.
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const tmp=await mkdtemp(join(tmpdir(),'miku-kit-'));process.env.MIKU_CONFIG=join(tmp,'config.json');
const {createApp}=await import('../src/server.mjs');
const require=createRequire(import.meta.url);let pw;try{pw=require('playwright');}catch{pw=require('C:/Users/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');}
const call=(id,name,args)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
const models={config:()=>({deepseekKey:'test'}),usage:()=>({spent:0,limit:200,rows:[]}),
  complete:async()=>({text:JSON.stringify({messages:[{type:'text',text:'研究做完啦！结论是方法 A 在真实场景更稳。'}]})}),
  chat:async(messages,opts)=>{const tools=messages.filter(m=>m.role==='tool').length;
    if(!tools)return {message:{role:'assistant',content:'',tool_calls:[call('a','load_skill',{name:'web-research'}),call('b','web_search',{query:'方法 A 方法 B 对比'})]},cost:0.002};
    return {message:{role:'assistant',content:'',tool_calls:[call('c','finish',{answer:'方法 A 在真实场景更稳定 [S1]。',confidence:'medium',findings:[{claim:'A 的成功率更高',sources:['S1'],quote:'A 的成功率为 91%'}],gaps:['缺少长期测试'],sections:opts.purpose==='agent-research'?[{heading:'主要发现',content:'A 优于 B [S1]'}]:undefined})]},cost:0.003};}};
const app=await createApp({dbPath:':memory:',background:false,models});
const real=app.toolkit.execute.bind(app.toolkit);
app.toolkit.execute=async(name,args,ctx)=>name==='web_search'?{results:[{ref:ctx.ledger.add({title:'对比评测',url:'https://example.org/review',provider:'stub',tool:'web_search',text:'实验显示 A 的成功率为 91%，B 为 84%。'},'S')}]}:real(name,args,ctx);
await new Promise(r=>app.server.listen(0,'127.0.0.1',r));let browser;const out=new URL('../test-output/',import.meta.url);await mkdir(out,{recursive:true});
try{
  browser=await pw.chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];page.on("pageerror",e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:'+app.server.address().port);await page.click('[data-tab="research"]');
  await page.waitForSelector("#kit-panel");await page.waitForFunction(()=>/技能 7 个/.test(document.querySelector('#kit-status').textContent));
  assert.match(await page.textContent('#kit-status'),/通用网页搜索：未配置/);
  await page.fill('#kit-quick [name=question]','方法 A 和方法 B 哪个好');await page.click('#kit-quick button');
  await page.waitForSelector('.kit-result');const result=await page.textContent('.kit-result');
  assert.match(result,/方法 A 在真实场景更稳定/);assert.match(result,/✓已核对原文/);assert.match(result,/对比评测/);assert.match(result,/web-research/);
  await page.fill('#kit-project [name=question]','抓取算法 A 与 B 的系统对比');await page.click('#kit-project button');
  for(let i=0;i<20&&!/已完成/.test(await page.textContent('#kit-projects'));i++){await page.waitForTimeout(300);await page.click('[data-tab="research"]');}
  assert.match(await page.textContent('#kit-projects'),/已完成[\s\S]*1 个来源 · 引文核对 1\/1/);
  await page.click('[data-kit="view"]');await page.waitForFunction(()=>/参考文献/.test(document.querySelector('.kit-report')?.textContent||''));
  assert.match(await page.textContent('.kit-report'),/## 主要发现[\s\S]*\[S1\]/);
  assert.match(app.store.chats().at(-1).text,/研究做完啦[\s\S]*科研项目/);
  await page.screenshot({path:fileURLToPath(new URL('research-kit-desktop.png',out)),fullPage:false});
  await page.click('#kit-panel summary:has-text("搜索服务")');await page.fill('#kit-config [name=tavilyKey]','tvly-test-key');await page.click('#kit-config button.primary');
  await page.waitForFunction(()=>/通用网页搜索：tavily/.test(document.querySelector('#kit-status').textContent));
  assert.equal(await page.getAttribute('#kit-config [name=tavilyKey]','placeholder'),'已保存，留空不修改');
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(200);
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-window.innerWidth);assert.ok(overflow<=1,'no horizontal overflow at 390px: '+overflow);
  await page.screenshot({path:fileURLToPath(new URL('research-kit-mobile.png',out)),fullPage:false});
  assert.deepEqual(errors,[]);console.log('research kit browser check passed: quick run, project report, config save, 390px layout');
}finally{await browser?.close();await app.close();await rm(tmp,{recursive:true,force:true});}
