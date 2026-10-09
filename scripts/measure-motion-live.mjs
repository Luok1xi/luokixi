import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
const label=process.argv[2]||'before', out='campus/.data/quality-20261009';
await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:'C:/Users/user/AppData/Local/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe'});
const page=await browser.newPage({viewport:{width:1280,height:900},reducedMotion:'no-preference'});
const results=[],errors=[];page.on('pageerror',e=>errors.push(e.message));
const cdp=await page.context().newCDPSession(page);await cdp.send('Profiler.enable');
async function measure(name,action){
 await cdp.send('Profiler.start');
 await page.evaluate(()=>{window.framesMeasured=[];window.tasksMeasured=[];window.measuring=true;let last=performance.now();function tick(t){if(!window.measuring)return;window.framesMeasured.push(t-last);last=t;requestAnimationFrame(tick);}requestAnimationFrame(tick);window.perfObserver=new PerformanceObserver(l=>window.tasksMeasured.push(...l.getEntries().map(e=>e.duration)));window.perfObserver.observe({type:'longtask',buffered:false});});
 await action();await page.waitForTimeout(450);
 results.push(await page.evaluate(name=>{window.measuring=false;window.perfObserver.disconnect();const a=window.framesMeasured.slice(2).sort((a,b)=>a-b);return{name,frames:a.length,medianMs:a[a.length>>1],p95Ms:a[Math.floor(a.length*.95)],over25Ms:a.filter(x=>x>25).length,longTasks:window.tasksMeasured};},name));
 const {profile}=await cdp.send('Profiler.stop');const counts=new Map();for(const id of profile.samples||[])counts.set(id,(counts.get(id)||0)+1);const top=profile.nodes.map(n=>({name:n.callFrame.functionName,url:n.callFrame.url.split('/').pop(),line:n.callFrame.lineNumber,samples:counts.get(n.id)||0})).sort((a,b)=>b.samples-a.samples).slice(0,12);results.at(-1).profile=top;
}
try{
 await page.goto('http://127.0.0.1:17860/circle.html');await page.waitForTimeout(1800);
 await measure('news-hover-scroll',async()=>{const card=page.locator('[data-tilt]').first();if(await card.count()){const b=await card.boundingBox();if(b)for(let i=0;i<36;i++){await page.mouse.move(b.x+b.width*(.15+.7*i/36),b.y+b.height*(.45+.25*Math.sin(i)));await page.waitForTimeout(16);}}await page.mouse.wheel(0,600);await page.waitForTimeout(600);});
 await measure('search-open-type-close',async()=>{await page.keyboard.press('Control+k');await page.locator('.sl input[type=search]').waitFor();await page.waitForTimeout(600);await page.locator('.sl input[type=search]').pressSequentially('calculus',{delay:70});await page.waitForTimeout(500);await page.keyboard.press('Escape');});
 await writeFile(`${out}/motion-${label}.json`,JSON.stringify({label,environment:'Chromium headless, 1280x900, default CPU, no reduced motion',results,errors},null,2));console.log(JSON.stringify({label,results,errors}));
}finally{await browser.close();}
