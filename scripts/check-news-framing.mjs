import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
const browser=await chromium.launch({headless:true,channel:'msedge'});
const results=[];
try {
 for(const width of [1440,390]) {
  const page=await browser.newPage({viewport:{width,height:width===390?844:1000}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:17860/');
  await page.locator('.hc-slide[data-id^="f-"] .art-img').first().waitFor();
  await page.waitForTimeout(1500);
  const frames=await page.locator('.hc-slide[data-id^="f-"]').evaluateAll(slides=>slides.map(slide=>{
   const card=slide.querySelector('.hc-card'),media=slide.querySelector('.hc-media'),img=media?.querySelector('img');
   if(!img)return null;
   return {id:slide.dataset.id,card:card.offsetHeight,media:media.offsetHeight,bottom:getComputedStyle(media).bottom,fit:getComputedStyle(img).objectFit,natural:[img.naturalWidth,img.naturalHeight],src:img.getAttribute('src')};
  }).filter(Boolean));
  assert.ok(frames.length);for(const item of frames)assert.ok(Math.abs(item.card-item.media)<=2,`Uncovered news card: ${JSON.stringify(item)}`);
  assert.deepEqual(errors,[]);results.push({width,frames,errors});
  await page.screenshot({path:`campus/.data/motion-20261009/home-after-${width}.png`,fullPage:false});
  await page.close();
 }
 await writeFile('campus/.data/motion-20261009/news-framing.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results));
} finally {await browser.close();}
