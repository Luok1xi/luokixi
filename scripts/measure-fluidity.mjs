// On-device motion benchmark. rAF timing measures responsiveness, not a guarantee
// of compositor presentation. Use identical settings for both builds.
import {chromium} from 'playwright';
import {mkdir,writeFile} from 'node:fs/promises';
const phase=process.argv[2]||'before',base=process.env.MOTION_BASE||'http://127.0.0.1:17860';
const dir='campus/.data/motion-20261009';await mkdir(dir,{recursive:true});
const native=process.env.MOTION_NATIVE==='1',cpu=Number(process.env.MOTION_CPU||1),searchOnly=process.env.MOTION_ONLY==='search';
const browser=await chromium.launch({headless:false,channel:'msedge',args:native?['--start-maximized']:[]});
const context=await browser.newContext({...native?{viewport:null}:{viewport:{width:1440,height:1000},deviceScaleFactor:1},reducedMotion:'no-preference'});
const page=await context.newPage(),cdp=await context.newCDPSession(page),errors=[],results=[];
await cdp.send('Performance.enable');page.on('pageerror',e=>errors.push(e.message));
if(cpu>1)await cdp.send('Emulation.setCPUThrottlingRate',{rate:cpu});
const browserCDP=await browser.newBrowserCDPSession();const {gpu}=await browserCDP.send('SystemInfo.getInfo');
async function sample(name,options={}){
 const before=await cdp.send('Performance.getMetrics');
 const row=await page.evaluate(async({name,selector,action='pointer',seconds=5})=>{
  const target=selector?document.querySelector(selector):null,box=target?.getBoundingClientRect(),frames=[],longTasks=[];
  if(selector&&(!target||!box.width||!box.height))throw new Error(`Missing visible benchmark target: ${selector}`);
  let pointerEvents=0;
  const curtain=document.querySelector('.sl-curtain'),onPointer=()=>pointerEvents++;
  curtain?.addEventListener('pointermove',onPointer);
  const observer=new PerformanceObserver(list=>longTasks.push(...list.getEntries().map(x=>+x.duration.toFixed(1))));observer.observe({type:'longtask',buffered:false});
  let start,last,next=0,index=0;
  await new Promise(resolve=>{
   function frame(t){if(start===undefined){start=t;last=t;}else frames.push(t-last);last=t;
    const elapsed=t-start;
    if(action==='pointer'&&box){const x=box.x+box.width*(.5+.43*Math.sin(elapsed/330)),y=box.y+box.height*(.5+.3*Math.sin(elapsed/410));target.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerType:'mouse',clientX:x,clientY:y}));}
    if(action==='click'&&elapsed>=next){target?.click();next+=650;}
    if(action==='curtain'&&elapsed>=next){document.querySelector('[data-curtain="1"]')?.click();next+=1300;}
    if(action==='scroll')window.scrollTo(0,Math.round((1-Math.cos(elapsed/seconds/1000*Math.PI*2))*.5*Math.min(2300,document.documentElement.scrollHeight-innerHeight)));
    if(action==='type'&&target&&elapsed>=next){target.value=['高数','人工智能','GitHub','课程资料',''][index++%5];target.dispatchEvent(new Event('input',{bubbles:true}));next+=650;}
    if(elapsed>=seconds*1000){resolve();return;}requestAnimationFrame(frame);
   }requestAnimationFrame(frame);
  });
  observer.disconnect();curtain?.removeEventListener('pointermove',onPointer);
  const sorted=[...frames].sort((a,b)=>a-b),q=p=>+(sorted[Math.floor((sorted.length-1)*p)]||0).toFixed(2);
  return {name,selector,bounds:box?{x:box.x,y:box.y,width:box.width,height:box.height}:null,pointerEvents,frames:frames.length,rafFps:+(frames.length*1000/frames.reduce((a,b)=>a+b,0)).toFixed(2),medianMs:q(.5),p95Ms:q(.95),p99Ms:q(.99),over25Ms:frames.filter(n=>n>25).length,over50Ms:frames.filter(n=>n>50).length,longTasks,visible:document.visibilityState,dom:document.querySelectorAll('*').length};
 },{name,...options});
 const after=await cdp.send('Performance.getMetrics'),prior=Object.fromEntries(before.metrics.map(x=>[x.name,x.value]));
 row.cost=Object.fromEntries(after.metrics.filter(x=>['TaskDuration','ScriptDuration','LayoutDuration','RecalcStyleDuration','LayoutCount','RecalcStyleCount'].includes(x.name)).map(x=>[x.name,+(x.value-(prior[x.name]||0)).toFixed(4)]));
 results.push(row);console.log(JSON.stringify(row));
}
try{
 await page.goto(base+'/');await page.locator('.hc-card .art-img').first().waitFor();await page.waitForTimeout(2200);
 if(!searchOnly){await sample('home-carousel',{selector:'.hc-arrow[data-next],.hc-arrow:last-child',action:'click'});await sample('home-scroll',{action:'scroll'});}
 await page.keyboard.press('Control+k');await page.locator('.sl input[type=search]').waitFor();await page.waitForTimeout(1800);
 await sample('curtain-wind',{selector:'.sl-curtain'});
 await sample('curtain-switch',{action:'curtain'});
 await sample('search-results',{selector:'.sl input[type=search]',action:'type'});
 await page.keyboard.press('Escape');await page.waitForTimeout(400);
 if(!searchOnly){
 await page.goto(base+'/circle.html');await page.waitForTimeout(1600);
 const card=page.locator('[data-tilt]').first();if(await card.count()){await card.scrollIntoViewIfNeeded();await card.hover();await sample('news-tilt',{selector:'[data-tilt]'});}
 await sample('news-scroll',{action:'scroll'});
 await page.goto(base+'/discover.html');await page.waitForTimeout(2000);
 await sample('disc-interaction',{selector:'.dg canvas,canvas'});
 await sample('disc-scroll',{action:'scroll'});
 }
}finally{
 const viewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,screen:{width:screen.width,height:screen.height}}));
 const output={phase,at:new Date().toISOString(),browser:await browser.version(),viewport,cpu,gpu:{devices:gpu.devices,features:gpu.featureStatus,renderer:gpu.auxAttributes.glRenderer},metric:'Visible Edge rAF main-thread cadence and CDP costs; not a compositor presentation counter.',results,errors};
 await writeFile(`${dir}/${phase}.json`,JSON.stringify(output,null,2));await browser.close();
}
