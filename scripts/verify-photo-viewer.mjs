// Isolated browser fixture: no accounts, live posts, databases or model calls.
import { chromium } from 'playwright';
import { createServer } from 'vite';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function fixture(req,res,next) {
  if (req.url === '/photo-viewer-qa') {
    res.setHeader('Content-Type','text/html; charset=utf-8');
    res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <title>图片查看隔离验收</title><style>
      body{margin:0;font-family:system-ui}#fixture-thread{width:820px;max-width:90vw;border:0;padding:20px}
      .ds-frame{height:230px!important}#fixture-thread button{padding:12px}
      </style><dialog id="fixture-thread"><h1>九图帖子</h1><div id="rail" class="ds-track"></div>
      <button id="unknown-origin">打开未知尺寸图片</button></dialog><script type="module">
      import {depthSlides,mountDepthSlider} from '/src/js/depth-slider.js';
      import {openPhotoViewer} from '/src/js/photo-viewer.js';
      const urls=Array.from({length:9},(_,i)=>'/viewer-fixture/'+i+'.svg');
      const rail=document.querySelector('#rail');rail.innerHTML=depthSlides(urls,'隔离验收照片',{open:true});
      document.querySelector('#fixture-thread').showModal();mountDepthSlider(rail);
      rail.addEventListener('click',event=>{const origin=event.target.closest('[data-image-open]');
        if(origin&&!event.defaultPrevented)openPhotoViewer(urls,Number(origin.dataset.imageOpen),origin);});
      window.viewerTest={open:openPhotoViewer,urls};
      </script></html>`);
    return;
  }
  const match = req.url?.match(/^\/viewer-fixture\/(\d+)\.svg$/);
  if (match) {
    const id=Number(match[1]),width=id%2?600:1600,height=id%2?1600:1200;
    res.setHeader('Content-Type','image/svg+xml');
    res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="hsl(${id*32} 50% 55%)"/><text x="10%" y="50%" font-size="90" fill="white">${id+1}</text></svg>`);
    return;
  }
  if (req.url === '/viewer-missing.svg') {res.statusCode=404;res.end('Missing image fixture');return;}
  next();
}
const server = await createServer({ root, configFile:false,
  plugins:[{name:'isolated-photo-viewer-fixture',configureServer(server){server.middlewares.use(fixture);}}],
  server:{host:'127.0.0.1',port:0,strictPort:false}, logLevel:'error' });
await server.listen();
const base=`http://127.0.0.1:${server.httpServer.address().port}`;
const browser=await chromium.launch({headless:true,channel:process.env.PHOTO_VIEWER_BROWSER_CHANNEL||'msedge'});
const context=await browser.newContext({viewport:{width:1380,height:920},reducedMotion:'no-preference'});
const page=await context.newPage(),errors=[],checks=[],requests=[];
page.on('pageerror',error=>errors.push(error.message));
page.on('console',message=>{if(message.type()==='error')console.error(message.text());});
page.on('request',request=>requests.push(request.url()));
const viewer=()=>page.locator('.photo-viewer-modal[open]');
const ready=async()=>{await page.locator('.photo-viewer-modal[data-ready="true"]').waitFor();};
const close=async()=>{await viewer().locator('.pswp__button--close').click();await viewer().waitFor({state:'detached'});};
try {
  await page.goto(base+'/photo-viewer-qa');
  await page.waitForFunction(()=>window.viewerTest&&document.querySelector('#rail img').naturalWidth>0);
  assert.equal(requests.some(url=>/photoswipe(?:\.esm)?\.js/.test(url)),false,'Core must stay unloaded before opening.');
  await page.locator('#rail [data-image-open="2"]').scrollIntoViewIfNeeded();
  await page.locator('#rail [data-image-open="2"]').click();await ready();
  assert.equal(await viewer().getAttribute('data-index'),'2');
  assert.equal(await page.locator('#fixture-thread').evaluate(el=>el.open),true);
  assert.equal(await page.evaluate(()=>!!document.elementFromPoint(innerWidth/2,innerHeight/2)?.closest('.photo-viewer-modal')),true);
  checks.push('PhotoSwipe loads on first click and remains above the already-modal nine-image thread.');

  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(()=>document.querySelector('.photo-viewer-modal')?.dataset.index==='3');
  assert.equal(await viewer().locator('.pswp__button--original').getAttribute('href'),base+'/viewer-fixture/3.svg');
  await viewer().locator('.pswp__button--zoom').click();
  await viewer().locator('.pswp--zoomed-in').waitFor();
  await page.keyboard.press('Escape');await viewer().waitFor({state:'detached'});
  assert.equal(await page.locator('#fixture-thread').evaluate(el=>el.open),true,'Escape must close only the viewer.');
  assert.equal(await page.evaluate(()=>document.activeElement?.dataset.imageOpen),'2');
  assert.equal(await page.locator('#rail').getAttribute('data-depth-slider'),'on');
  checks.push('Keyboard navigation, zoom, original-image link, Escape and focus return work without closing or dismantling the depth rail.');

  await page.evaluate(()=>window.viewerTest.open([
    'javascript:alert(1)',
    {src:'/viewer-fixture/0.svg',width:1600,height:1200,alt:'横图'},
    {url:'/viewer-fixture/1.svg',w:600,h:1600,alt:'竖图'},
  ],2,document.querySelector('#unknown-origin')));await ready();
  assert.equal(await viewer().getAttribute('data-index'),'1');
  assert.equal(await viewer().locator('.pswp__description').textContent(),'竖图');
  assert.equal(await viewer().locator('.pswp__counter').textContent(),'2 / 2');
  await close();
  await page.evaluate(()=>window.viewerTest.open(['/viewer-fixture/7.svg'],0,document.querySelector('#unknown-origin')));await ready();
  const portrait=await viewer().locator('.pswp__item[aria-hidden="false"] img.pswp__img').first().evaluate(img=>({w:img.naturalWidth,h:img.naturalHeight,width:img.width,height:img.height}));
  assert.equal(portrait.w,600);assert.equal(portrait.h,1600);
  assert.ok(Math.abs(portrait.width/portrait.height-600/1600)<.01);
  await close();
  checks.push('Metadata and existing URL arrays both work; invalid URLs preserve the requested item, and unknown portrait dimensions stay proportional.');

  await page.evaluate(()=>window.viewerTest.open(['/viewer-missing.svg'],0,document.querySelector('#unknown-origin')));await ready();
  await viewer().locator('.pswp__error-msg').waitFor();
  assert.match(await viewer().locator('.pswp__error-msg').textContent(),/图片暂时无法加载/);
  assert.equal(await viewer().locator('.pswp__button--original').getAttribute('href'),base+'/viewer-missing.svg');
  await close();
  await page.route('**/viewer-slow.svg',async route=>{await new Promise(resolve=>setTimeout(resolve,1700));await route.abort().catch(()=>{});});
  await page.evaluate(()=>{const handle=window.viewerTest.open(['/viewer-slow.svg'],0,document.querySelector('#unknown-origin'));handle.close();});
  await page.waitForTimeout(1800);
  assert.equal(await page.locator('.photo-viewer-modal').count(),0);
  assert.equal(await page.evaluate(()=>document.documentElement.classList.contains('has-photo-viewer')),false);
  checks.push('Broken images retain a Chinese error and original link; cancellation during a slow image probe never opens a late modal.');

  await page.emulateMedia({reducedMotion:'reduce'});
  for(let iteration=0;iteration<4;iteration++) {
    await page.evaluate(()=>window.viewerTest.open(window.viewerTest.urls,0,document.querySelector('#unknown-origin')));
    await viewer().locator('.pswp--open').waitFor();
    await close();
  }
  assert.equal(await page.locator('.pswp, .photo-viewer-modal').count(),0);
  assert.equal(await page.evaluate(()=>document.documentElement.classList.contains('has-photo-viewer')),false);
  checks.push('Repeated opening/closing with reduced motion leaves no viewer elements or scroll lock.');

  const mobileContext=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true,reducedMotion:'no-preference'});
  const mobile=await mobileContext.newPage();mobile.on('pageerror',error=>errors.push(error.message));
  await mobile.goto(base+'/photo-viewer-qa');await mobile.waitForFunction(()=>window.viewerTest);
  await mobile.evaluate(()=>window.viewerTest.open(window.viewerTest.urls,0,document.querySelector('#unknown-origin')));
  await mobile.locator('.photo-viewer-modal[data-ready="true"]').waitFor();
  const cdp=await mobileContext.newCDPSession(mobile),y=422,cx=195;
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:cx-30,y},{x:cx+30,y}]});
  for(let i=1;i<=8;i++) {
    await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:cx-30-i*10,y},{x:cx+30+i*10,y}]});
    await mobile.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await mobile.locator('.pswp--zoomed-in').waitFor();
  assert.ok(await mobile.evaluate(()=>document.querySelector('.photo-viewer-modal').getBoundingClientRect().width<=innerWidth));
  await mobile.locator('.pswp__button--close').click();
  await mobile.locator('.photo-viewer-modal').waitFor({state:'detached'});
  assert.equal(await mobile.locator('#fixture-thread').evaluate(el=>el.open),true);
  await mobileContext.close();
  checks.push('A 390-pixel touch viewport supports real two-pointer pinch zoom and preserves the underlying thread on close.');

  assert.deepEqual(errors,[]);
  const result={passed:true,browser:'Microsoft Edge headless',checks,errors};
  const out=resolve(root,'campus/.data/photo-viewer-20261010');await mkdir(out,{recursive:true});
  await writeFile(resolve(out,'result.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
} catch(error) { console.error(JSON.stringify({checks,errors,diagnostic:await page.evaluate(()=>({url:location.href,title:document.title,fixture:!!window.viewerTest,
  focus:document.activeElement?.outerHTML.slice(0,350),viewer:document.querySelector('.pswp')?.outerHTML.slice(0,350),
  images:[...document.images].slice(0,3).map(i=>({src:i.getAttribute('src'),complete:i.complete,width:i.naturalWidth,rect:i.getBoundingClientRect().toJSON()})),body:document.body.innerText.slice(0,250)})).catch(()=>null)})); throw error; }
finally {await browser.close();await server.close();}
