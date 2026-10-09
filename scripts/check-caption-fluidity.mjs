import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const origin='http://127.0.0.1:17875';
const root=new URL('../',import.meta.url);
const out=new URL('campus/.data/motion-20261009/',root);
await mkdir(out,{recursive:true});
const baselineStage=await readFile(new URL('before-source/src/js/companion-stage.js',out),'utf8');
const baselinePlayback=await readFile(new URL('before-source/src/js/stage-playback.js',out),'utf8');
const baselineCSS=await readFile(new URL('before-source/src/styles/companion-stage.css',out),'utf8');
const html=`<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>字幕隔离验收</title><style>body{margin:24px;background:#f8f6f3}main{max-width:860px;margin:auto;--dur-1:150ms;--dur-2:200ms;--ease-out:cubic-bezier(.23,1,.32,1);--ease-in-out:ease-in-out;--line-soft:#ddd;--r-l:18px;--r-m:12px;--accent:#97668b;--fs-small:13px}</style><main></main></html>`;
const browser=await chromium.launch({channel:'msedge',headless:false,args:['--disable-background-timer-throttling','--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding']});
const errors=[],measurements=[];
const result={checks:[],measurements,errors,scope:'Isolated stage on headed Microsoft Edge, real local assets and hardware GPU; local synthetic dialogue with no voice/model/API/DB requests. rAF measures main-thread presentation opportunity, not proof of every GPU frame being presented.'};

async function setup(before=false,viewport={width:1280,height:980}){
  const context=await browser.newContext({viewport});
  const page=await context.newPage();
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/hub/**',route=>route.abort());
  await page.route('**/caption-qa',route=>route.fulfill({contentType:'text/html',body:html}));
  if(before){
    await page.route('**/src/js/companion-stage.js',route=>route.fulfill({contentType:'application/javascript',body:baselineStage.replace("import '../styles/companion-stage.css';",`const baselineStyle=document.createElement('style');baselineStyle.textContent=${JSON.stringify(baselineCSS)};document.head.append(baselineStyle);`)}));
    await page.route('**/src/js/stage-playback.js',route=>route.fulfill({contentType:'application/javascript',body:baselinePlayback}));
  }
  await page.goto(origin+'/caption-qa');
  await page.evaluate(async()=>{
    const {mountCompanionStage}=await import('/src/js/companion-stage.js');
    window.stage=mountCompanionStage(document.querySelector('main'));
    stage.update({lines:[]});document.querySelector('[data-cs-sound]').click();
    window.nextNumber=0;window.allLines=[];
    window.queueLine=(text='很短的一句。')=>{
      const line={id:'caption-'+(++nextNumber),seat:'beikuang',emotion:'neutral',text,speech:''};
      allLines.push(line);stage.update({lines:allLines});return line.id;
    };
    window.advanceText=text=>{const id=queueLine(text);document.querySelector('[data-cs-next]').click();return id;};
    await document.fonts.ready;
  });
  await page.waitForFunction(()=>{const img=document.querySelector('.cs-sprite.is-visible');return img?.complete&&img.naturalWidth>0;});
  await page.waitForTimeout(500);
  return {page,context};
}

try{
  const system=await browser.newBrowserCDPSession();
  const info=await system.send('SystemInfo.getInfo');
  result.browser=await browser.version();
  result.gpu={devices:info.gpu.devices.map(d=>({vendor:d.vendorString,device:d.deviceString})),renderer:info.gpu.auxAttributes?.glRenderer,featureStatus:info.gpu.featureStatus};
  const {page,context}=await setup();
  await page.evaluate(()=>advanceText('这是一句短对白。'));
  const shortHeight=await page.locator('.cs-caption').evaluate(el=>el.getBoundingClientRect().height);
  const text='这里检查字幕的弹性与真实换行。'.repeat(40).slice(0,600);
  await page.evaluate(text=>advanceText(text),text);
  assert.ok(await page.locator('[data-cs-text] > *').count()<=24);
  assert.equal(await page.locator('[data-cs-text]').textContent(),text);
  const longHeight=await page.locator('.cs-caption').evaluate(el=>el.getBoundingClientRect().height);
  assert.equal(longHeight,shortHeight,'changing utterance length must not jump the paper height');
  await page.waitForTimeout(2900);
  assert.equal(await page.locator('[data-cs-text] > *').count(),0,'completed subtitle releases fragment animations');
  result.checks.push('600 characters use at most 24 inline fragments; finished text is a single node','short/long paper height remains fixed');
  const rapid=await page.evaluate(async()=>{
    let maxMotion=0,maxTravel=0;
    for(let i=0;i<30;i++){
      advanceText('快速切换的第 '+i+' 句。');
      const paper=document.querySelector('.cs-caption');
      maxMotion=Math.max(maxMotion,paper.getAnimations().length);
      maxTravel=Math.max(maxTravel,Math.abs(new DOMMatrixReadOnly(getComputedStyle(paper).transform).m42));
      await new Promise(resolve=>setTimeout(resolve,12));
    }
    return {maxMotion,maxTravel,current:document.querySelector('[data-cs-text]').dataset.message,last:allLines.at(-1).id};
  });
  assert.equal(rapid.current,rapid.last);assert.equal(rapid.maxMotion,1);assert.ok(rapid.maxTravel<=3.01);
  result.rapid=rapid;result.checks.push('30 rapid clicks preserve final utterance; one compositor spring and travel within 3px');
  await page.locator('.cs-toolbar [data-cs-history]').click();
  const stable=await page.evaluate(()=>{
    const list=document.querySelector('.cs-backlog ol'),first=list.firstElementChild;
    list.scrollTop=90;const before=list.scrollTop;
    stage.update({lines:allLines});
    return {same:first===list.firstElementChild,before,after:list.scrollTop,rows:list.children.length};
  });
  assert.ok(stable.same);assert.equal(stable.before,stable.after);result.checks.push('polling preserves backlog nodes and scroll position');
  await page.keyboard.press('Escape');
  await page.evaluate(()=>advanceText('保留手写纸张，保持可读。'));
  await page.waitForTimeout(300);
  await page.screenshot({path:fileURLToPath(new URL('caption-desktop.png',out))});
  await page.setViewportSize({width:390,height:844});
  await page.waitForTimeout(200);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  assert.equal(await page.locator('[data-cs-text]').evaluate(el=>el.clientHeight),93);
  await page.screenshot({path:fileURLToPath(new URL('caption-mobile.png',out))});
  result.checks.push('390px no horizontal overflow, stable three-line mobile caption');
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.evaluate(()=>advanceText('减少动态效果，立即显示文字。'));
  assert.equal(await page.locator('[data-cs-text] > *').count(),0);
  assert.equal(await page.locator('.cs-caption').evaluate(el=>el.getAnimations().length),0);
  assert.equal(await page.locator('.cs-portrait').evaluate(el=>getComputedStyle(el).animationName),'none');
  result.checks.push('reduced motion reveals text instantly and stops spring/portrait motion');
  await page.evaluate(()=>stage.destroy());await context.close();

  // Alternate order to reveal warm-cache or temperature effects. Identical
  // viewport, font warm-up, neutral artwork, 600 chars and cadence in every run.
  for(const before of [true,false,false,true]){
    const {page,context}=await setup(before);
    const cdp=await context.newCDPSession(page);await cdp.send('Performance.enable');
    const metrics=async()=>Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m=>[m.name,m.value]));
    const start=await metrics();
    const frame=await page.evaluate(async text=>{
      const deltas=[];let previous=0,raf=0,timer=0,peaks=0,sends=0;
      const sample=time=>{if(previous)deltas.push(time-previous);previous=time;raf=requestAnimationFrame(sample);};
      raf=requestAnimationFrame(sample);
      const next=()=>{advanceText(text);sends++;peaks=Math.max(peaks,document.querySelector('[data-cs-text]').querySelectorAll('*').length);};
      next();timer=setInterval(next,700);
      await new Promise(resolve=>setTimeout(resolve,5000));clearInterval(timer);cancelAnimationFrame(raf);
      const sorted=deltas.toSorted((a,b)=>a-b);
      return {frames:deltas.length,elapsed:deltas.reduce((sum,ms)=>sum+ms,0),p95:sorted[Math.ceil(sorted.length*.95)-1],max:sorted.at(-1),over25ms:deltas.filter(ms=>ms>25).length,peakSubtitleNodes:peaks,advances:sends};
    },text);
    const end=await metrics();
    const stat={variant:before?'before':'after',...frame};
    for(const key of ['TaskDuration','LayoutDuration','RecalcStyleDuration','ScriptDuration','LayoutCount','RecalcStyleCount'])stat[key]=end[key]-start[key];
    measurements.push(stat);
    console.log(JSON.stringify(stat));
    await page.evaluate(()=>stage.destroy());await context.close();
  }
  assert.deepEqual(errors,[]);
  result.passed=true;
  await writeFile(new URL('caption-fluidity.json',out),JSON.stringify(result,null,2));
  console.log(JSON.stringify({passed:true,checks:result.checks,gpu:result.gpu}));
}finally{await browser.close();}
