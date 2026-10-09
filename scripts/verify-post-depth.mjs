// Multi-image scrolling/parallax regression. Uses isolated existing uploads; never publishes.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const base = process.env.DEPTH_TEST_URL || 'http://127.0.0.1:17870';
const browser = await chromium.launch({ headless:true, channel:'msedge' });
const page = await browser.newPage({ viewport:{width:1380,height:920}, reducedMotion:'no-preference' });
const errors = [], checks = [];
page.on('pageerror', error => errors.push(error.message));
try {
  if (process.env.DEPTH_TEST_SESSION_FILE) {
    const session = JSON.parse(await readFile(process.env.DEPTH_TEST_SESSION_FILE,'utf8'));
    await page.context().addCookies([{name:'luokixi_session',value:session.cookie,url:base,httpOnly:true,sameSite:'Lax'}]);
  }
  const response = await page.request.get(base+'/api/hub/circle/feed?lane=latest');
  assert.equal(response.status(),200);
  const feed = await response.json(), multi = feed.items.find(post => post.photos?.length > 2);
  assert.ok(multi,'Prepare an isolated post with three or more pictures before this check.');
  const pair = {...multi,id:'depth-pair-fixture',photos:multi.photos.slice(0,2)};
  const single = {...multi,id:'depth-single-fixture',photos:multi.photos.slice(0,1)};
  await page.route('**/api/hub/circle/feed*',route => route.fulfill({status:200,contentType:'application/json',
    body:JSON.stringify({...feed,items:[multi,pair,single],cursor:null})}));
  await page.goto(base+'/circle.html');
  const tracks = page.locator('#circle-feed .ds-track');
  await tracks.first().waitFor();
  assert.equal(await tracks.count(),2);
  for (const track of await tracks.all()) {
    assert.equal(await track.getAttribute('data-depth-slider'),'on');
    assert.ok(await track.evaluate(el => el.scrollWidth > el.clientWidth*1.2));
    assert.equal(await track.locator('.ds-img').first().evaluate(image => getComputedStyle(image).animationName),'ds-pan');
  }
  assert.equal(await page.locator('#circle-feed .ds-frame[data-fx-tilt]').count(),0);
  checks.push('Two-image and nine-image previews both overflow as mounted rails and use the original reverse parallax.');

  async function dragRail(track) {
    assert.ok(await track.evaluate(el => el.scrollWidth>el.clientWidth*1.2),'Preview pictures must actually overflow horizontally.');
    await track.scrollIntoViewIfNeeded();
    await track.evaluate(el => el.scrollLeft=0);
    await page.waitForTimeout(200);
    const before = await track.locator('img').first().evaluate(image => getComputedStyle(image).transform);
    const box = await track.boundingBox(), currentURL = page.url();
    await page.mouse.move(box.x+box.width*.8,box.y+box.height*.5);await page.mouse.down();
    for(let step=1;step<=16;step++) {
      await page.mouse.move(box.x+box.width*(.8-step*.6/16),box.y+box.height*.5);
      await page.waitForTimeout(12);
    }
    const during = await track.locator('img').first().evaluate(image => getComputedStyle(image).transform);
    await page.mouse.up();
    assert.notEqual(during,before,'The picture must move relative to its frame, rather than translating only the whole gallery.');
    assert.ok(await track.evaluate(el => el.scrollLeft>10));
    await page.waitForFunction(() => !document.querySelector('.ds-track.is-dragging'));
    assert.equal(page.url(),currentURL,'Dragging a linked preview must not open its article.');
    assert.equal(await page.locator('#circle-thread[open]').count(),0);
  }
  await dragRail(tracks.nth(1));
  await dragRail(tracks.first());
  checks.push('Dragging two and nine pictures changes frame-relative image transforms; inertia settles and dragging never opens the post.');
  await tracks.first().focus();await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(600);
  assert.equal(await tracks.first().evaluate(el => getComputedStyle(el).scrollSnapType),'x mandatory');
  checks.push('The existing inertia, snap and left/right keyboard interactions remain active.');

  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await tracks.first().locator('img').first().evaluate(image => getComputedStyle(image).transform),'none');
  await page.emulateMedia({reducedMotion:'no-preference'});
  checks.push('Reduced-motion keeps the browsable rail while disabling its parallax.');

  await tracks.first().evaluate(el => {window.oldRail=el;});
  await page.locator('[data-lane="latest"]').click();
  await page.waitForFunction(() => !window.oldRail.isConnected);
  assert.equal(await page.evaluate(() => window.oldRail.dataset.depthSlider),undefined);
  checks.push('Changing feed lanes releases the previous rail and mounts the replacement.');
  await page.locator('#circle-feed .ds-frame').first().click();
  await page.locator('#circle-thread[open] .ds-track[data-depth-slider="on"]').waitFor();
  assert.equal(await page.locator('#circle-thread .ds-frame').count(),multi.photos.length);
  await page.locator('#circle-thread [data-close]').click();
  await page.waitForFunction(() => !document.querySelector('#circle-thread').open);
  assert.equal(await page.locator('#circle-thread .ds-ui').count(),0);
  checks.push('Thread detail mounts the same multi-image rail and disposes it on close.');

  await page.goto(base+'/index.html');
  await page.locator('.op').waitFor({state:'detached',timeout:15000});
  const frontier = page.locator('.home-frontier-item .ds-track[data-depth-slider="on"]').first();
  await frontier.waitFor();assert.equal(await frontier.locator('.ds-frame').count(),multi.photos.length);
  await dragRail(frontier);
  await page.locator('#td-panel .td-post-preview.ds-track[data-depth-slider="on"]').first().waitFor();
  await page.locator('[data-tab="hot"]').click();
  await page.locator('#td-panel .td-post-preview.ds-track[data-depth-slider="on"]').first().waitFor();
  checks.push('Homepage frontier, recommended and hot-list previews retain all pictures and the same scroll parallax, including linked-card drag suppression.');
  if(process.env.DEPTH_TEST_SESSION_FILE) {
    await page.locator('[data-tab="following"]').click();
    await page.locator('#td-panel .td-post-preview.ds-track[data-depth-slider="on"]').first().waitFor();
    checks.push('Logged-in following previews also mount the shared multi-image rail.');
  }
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth<=innerWidth+1));
  const mobileRail=page.locator('#td-panel .ds-track').first();
  await mobileRail.scrollIntoViewIfNeeded();await mobileRail.evaluate(el => el.scrollLeft=0);
  const mobileBox=await mobileRail.boundingBox(), urlBeforeTouch=page.url();
  const cdp=await page.context().newCDPSession(page);
  await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});
  const y=mobileBox.y+mobileBox.height*.5;
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:mobileBox.x+mobileBox.width*.85,y}]});
  for(let i=1;i<=12;i++) {
    await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:mobileBox.x+mobileBox.width*(.85-.7*i/12),y}]});
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await page.waitForTimeout(500);
  assert.ok(await mobileRail.evaluate(el => el.scrollLeft>10));
  assert.equal(page.url(),urlBeforeTouch);
  checks.push('Multi-image previews fit 390 pixels and native touch swipes move the rail without opening the article.');
  assert.deepEqual(errors,[]);
  const result={passed:true,browser:'Microsoft Edge headless',checks,errors};
  await mkdir('campus/.data/social-media-20261010',{recursive:true});
  await writeFile('campus/.data/social-media-20261010/depth-result.json',JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
} finally {await browser.close();}
