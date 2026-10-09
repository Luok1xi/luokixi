import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const base = process.env.MOTION_URL || 'http://127.0.0.1:17875';
const out = 'campus/.data/motion-20261009';
await mkdir(out,{recursive:true});
const browser = await chromium.launch({
  headless:process.env.MOTION_HEADED !== '1',
  ...(process.env.MOTION_BROWSER_CHANNEL
    ? {channel:process.env.MOTION_BROWSER_CHANNEL}
    : {executablePath:'C:/Users/user/AppData/Local/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe'}),
});
const results = [];
try {
 for (const fallback of [false,true]) {
  const page = await browser.newPage({viewport:{width:1080,height:800}});
  const errors = []; page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(fallback=>{
   window.draws = 0;
   const context = HTMLCanvasElement.prototype.getContext;
   HTMLCanvasElement.prototype.getContext = function(kind,...args) {return fallback&&kind==='webgl2'?null:context.call(this,kind,...args);};
   for (const [prototype,method] of [[CanvasRenderingContext2D.prototype,'drawImage'],[WebGL2RenderingContext.prototype,'drawArraysInstanced']]) {
    const original = prototype[method]; prototype[method] = function(...args){window.draws++;return original.apply(this,args);};
   }
  },fallback);
  await page.route('**/curtain-qa',r=>r.fulfill({contentType:'text/html',body:'<style>body{margin:40px;background:#f5f5f7}#curtain{width:640px;height:440px;color:#202124;--accent:#0071e3;font-family:system-ui}</style><div id="curtain"></div>'}));
  await page.goto(`${base}/curtain-qa`);
  await page.evaluate(async()=>{
   const {mountCurtain} = await import('/src/js/text-curtain.js');
   window.setsSeen = [];
   window.curtain = mountCurtain(document.querySelector('#curtain'),{sets:[
    {id:'a',roof:'eave',terms:['高等数学','电路分析','大学英语','北矿娘']},
    {id:'b',roof:'arch',terms:['开源项目','嵌入式','机器学习','校园地图']},
    {id:'c',roof:'flat',terms:['科技新闻','课程资料','自主学习']},
   ],onSet:(_,i)=>window.setsSeen.push(i)});
  });
  await page.waitForTimeout(1900);
  const renderer = await page.locator('canvas').getAttribute('data-renderer');
  // Headless/software-only browsers now deliberately use 2D. Require a GPU
  // explicitly for a hardware-path run instead of reporting that fallback as GPU.
  if (fallback) assert.equal(renderer,'2d');
  else if (process.env.MOTION_REQUIRE_GPU === '1') assert.equal(renderer,'webgl2');
  else assert.ok(['2d','webgl2'].includes(renderer));
  await page.screenshot({path:`${out}/curtain-${renderer}.png`});
  await page.evaluate(()=>curtain.pause());
  await page.waitForTimeout(80); const paused = await page.evaluate(()=>draws);
  await page.waitForTimeout(350); assert.equal(await page.evaluate(()=>draws),paused,'paused curtain must not draw');
  await page.evaluate(()=>{curtain.resume();curtain.next();curtain.next();curtain.prev();});
  await page.waitForTimeout(820); assert.equal(await page.evaluate(()=>curtain.index),1,'rapid arrows choose final target once');
  assert.deepEqual(await page.evaluate(()=>setsSeen),[0,1]);
  await page.evaluate(()=>{curtain.next();curtain.pause();});
  await page.waitForTimeout(800); assert.equal(await page.evaluate(()=>curtain.index),1);
  await page.evaluate(()=>curtain.resume());
  await page.waitForTimeout(800); assert.equal(await page.evaluate(()=>curtain.index),2);
  if (renderer === 'webgl2') {
    await page.evaluate(()=>document.querySelector('canvas').getContext('webgl2').getExtension('WEBGL_lose_context').loseContext());
    await page.waitForTimeout(100); assert.equal(await page.locator('canvas').getAttribute('data-renderer'),'2d');
  }
  await page.emulateMedia({reducedMotion:'reduce'}); await page.waitForTimeout(100);
  const still = await page.evaluate(()=>draws); await page.waitForTimeout(300);
  assert.equal(await page.evaluate(()=>draws),still,'reduced motion stays static');
  await page.evaluate(()=>curtain.destroy());
  const destroyed = await page.evaluate(()=>draws); await page.mouse.move(300,220); await page.waitForTimeout(100);
  assert.equal(await page.evaluate(()=>draws),destroyed);
  assert.deepEqual(errors,[]);
  results.push({renderer,forcedCanvas:fallback,contextLossTested:renderer==='webgl2',paused:true,rapidRetarget:true,pausedTransition:true,reducedMotion:true,disposed:true,errors});
  await page.close();
 }
 await writeFile(`${out}/curtain-browser.json`,JSON.stringify(results,null,2));
 console.log(JSON.stringify(results));
} finally { await browser.close(); }
