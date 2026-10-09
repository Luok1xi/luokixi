import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {writeFile,mkdir} from 'node:fs/promises';
const out=new URL('../campus/.data/galgame-dialogue-20261009/',import.meta.url);await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||'C:/Users/user/AppData/Local/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe'});
try {
const page=await browser.newPage({viewport:{width:1280,height:980}}),errors=[],requests=[];
page.on('pageerror',e=>errors.push(e.message));
const wav=Buffer.alloc(44+16000*2*5);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(wav.length-44,40);
await page.route('**/api/hub/**',async route=>{
 const url=route.request().url();if(url.endsWith('auth/session'))return route.fulfill({json:{csrfToken:'test-only'}});
 if(url.endsWith('studio/voice')){requests.push(route.request().postDataJSON());await new Promise(r=>setTimeout(r,180));return route.fulfill({json:{audio:wav.toString('base64'),type:'audio/wav'}}).catch(()=>{});}
 await route.abort();
});
await page.route('**/galgame-qa',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Isolated stage QA</title><style>body{margin:24px;background:#f8f6f3}main{max-width:860px;margin:auto;--dur-1:150ms;--dur-2:200ms;--ease-out:cubic-bezier(.23,1,.32,1);--ease-in-out:ease-in-out;--line-soft:#ddd;--r-l:18px;--r-m:12px;--accent:#97668b;--fs-small:13px}</style><main></main></html>'}));
await page.goto('http://127.0.0.1:17875/galgame-qa');
await page.evaluate(async()=>{
 const AudioBase=window.Audio;window.soundElements=[];window.Audio=function(...args){const audio=new AudioBase(...args);window.soundElements.push(audio);return audio;};
 const {mountCompanionStage}=await import('/src/js/companion-stage.js');
 window.stage=mountCompanionStage(document.querySelector('main'));stage.update({lines:[]});
 window.lines=[{id:'one',seat:'beikuang',emotion:'happy',text:'好，这一段先让我慢慢讲。你点一下，我就接着往下说。',speech:'ここから、少しずつ話すね。'}, {id:'two',seat:'beikuang',emotion:'think',text:'等一下，我想起一件事。已经说过的话，在对话历史里都能找到。',speech:'少し待って、思い出した。'},{id:'three',seat:'beikuang',emotion:'surprised',text:'诶，已经读完了吗？那我就不挡着你了。',speech:'もう読み終わったの？'}];stage.update({lines});
});
await page.waitForTimeout(600);assert.equal(requests.length,0,'manual mode never auto plays fresh dialogue');
await page.locator('[data-cs-text]').click();await page.waitForFunction(()=>document.querySelector('.companion-stage').dataset.voice==='speaking');
assert.equal(await page.locator('[data-cs-text]').getAttribute('data-message'),'one');
await page.locator('[data-cs-text]').click();assert.equal(await page.locator('[data-cs-text]').getAttribute('data-message'),'two');
await page.waitForFunction(()=>document.querySelector('.companion-stage').dataset.voice==='speaking');
await page.locator('.cs-toolbar [data-cs-history]').click();assert.equal(await page.locator('.cs-backlog li').count(),2);
assert.ok(await page.evaluate(()=>soundElements.every(a=>a.paused)),'history interrupts all voices');
await page.keyboard.press('Escape');const reqBefore=requests.length;await page.waitForTimeout(450);assert.equal(requests.length,reqBefore,'closing history never replays');
await page.locator('[data-cs-text]').focus();await page.keyboard.press('Enter');
assert.equal(await page.locator('[data-cs-text]').getAttribute('data-message'),'three');
await page.waitForFunction(()=>document.querySelector('[data-actor="beikuang"]').dataset.pose==='surprised');
await page.waitForFunction(()=>{const img=document.querySelector('.cs-sprite.is-visible');return img&&getComputedStyle(img).opacity==='1';});
await page.screenshot({path:new URL('desktop.png',out).pathname.replace(/^\/(\w:)/,'$1')});
await page.locator('[data-cs-prev]').click();assert.equal(await page.locator('[data-cs-text]').getAttribute('data-message'),'two');
const old=requests.length;await page.waitForTimeout(400);assert.equal(requests.length,old,'previous line is silent until replay requested');
await page.locator('[data-cs-latest]').click();await page.setViewportSize({width:390,height:844});await page.waitForTimeout(400);
assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile no horizontal overflow');
await page.screenshot({path:new URL('mobile.png',out).pathname.replace(/^\/(\w:)/,'$1')});
await page.locator('.cs-toolbar [data-cs-history]').click();assert.equal(await page.locator('.cs-backlog li').count(),3);
await page.keyboard.press('Escape');
// Advance during synthesis and ensure its late completion cannot resume stale audio.
await page.evaluate(()=>stage.update({lines:[...lines,{...lines[0],id:'four',speech:'新しい言葉を話す。'},{...lines[1],id:'five',speech:'すぐ次に進もう。'}]}));
await page.locator('[data-cs-next]').click();await page.waitForFunction(()=>document.querySelector('.companion-stage').dataset.voice==='loading');
await page.locator('[data-cs-next]').click();assert.equal(await page.locator('[data-cs-text]').getAttribute('data-message'),'five');
await page.waitForFunction(()=>document.querySelector('.companion-stage').dataset.voice==='speaking');
assert.equal(await page.evaluate(()=>soundElements.filter(a=>!a.paused).length),1,'only current voice may play');
await page.locator('[data-cs-sound]').click();await page.locator('[data-cs-auto]').click();
await page.evaluate(()=>stage.update({lines:[...lines,{...lines[0],id:'six',speech:''}]}));
await page.waitForFunction(()=>document.querySelector('[data-cs-text]').dataset.message==='six');
await page.locator('[data-cs-auto]').click();
await page.emulateMedia({reducedMotion:'reduce'});await page.keyboard.press('Escape');
assert.equal(await page.locator('.cs-portrait').evaluate(e=>getComputedStyle(e).animationName),'none');
await page.evaluate(()=>stage.destroy());assert.ok(await page.evaluate(()=>soundElements.every(a=>a.paused)));
assert.deepEqual(errors,[]);
const result={passed:true,checks:['manual advancement','click interrupts voice and types next line','unread excluded from backlog','history silent','keyboard advancement','pose switching','390px overflow','advance during synthesis','one active voice','opt-in auto without voice','reduced motion','dispose stops audio'],voiceRequests:requests.length,errors,scope:'Isolated browser, real rendering/audio element, synthetic test WAV; no paid model or voice quality claim.'};
await writeFile(new URL('browser.json',out),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
} finally { await browser.close(); }
