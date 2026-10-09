// Read-only UI acceptance on the existing local site. Never sends a model message.
import {chromium} from 'playwright';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
const base='http://127.0.0.1:17860',dir='campus/.data/galgame-dialogue-20261009/live';
await mkdir(dir,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||'C:/Users/user/AppData/Local/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe'});
const context=await browser.newContext(),page=await context.newPage(),report={pages:[],errors:[],voiceRequests:0};
page.on('pageerror',e=>report.errors.push(e.message));
page.on('request',r=>{if(r.url().endsWith('/studio/voice'))report.voiceRequests++;});
try{
 const s=await (await context.request.get(base+'/api/hub/auth/session')).json();
 const secret=await readFile('campus/.data/hub/owner-private/developer-account.txt','utf8');
 const email=secret.match(/登录邮箱（仅本机占位）：([^\r\n]+)/)?.[1]?.trim(),password=secret.match(/初始密码：([^\r\n]+)/)?.[1]?.trim();
 const auth=await context.request.post(base+'/api/hub/auth/login',{headers:{'X-CSRFToken':s.csrfToken,Origin:base},data:{email,password}});
 assert.ok(auth.ok(),'Existing local developer login');
 for(const width of [1440,390])for(const name of ['beikuang','codex','studio']){
  await page.setViewportSize({width,height:width===390?844:1050});
  await page.goto(base+(name==='studio'?'/studio.html':'/me.html#'+name),{waitUntil:'domcontentloaded'});
  const stage=page.locator('.companion-stage');await stage.waitFor();
  await page.waitForFunction(()=>[...document.querySelectorAll('.cs-actor')].every(e=>e.dataset.ready==='true'));
  await page.waitForFunction(()=>!!document.querySelector('[data-cs-text]')?.dataset.message);
  assert.equal(await stage.locator('[data-cs-auto]').getAttribute('aria-pressed'),'false');
  await stage.locator('.cs-toolbar [data-cs-history]').click();
  const count=await stage.locator('.cs-backlog li').count();
  await page.keyboard.press('Escape');await stage.scrollIntoViewIfNeeded();await page.waitForTimeout(250);
  const data=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth,broken:[...document.querySelectorAll('.companion-stage img')].filter(i=>i.complete&&!i.naturalWidth).length,actors:document.querySelectorAll('.cs-actor').length}));
  assert.equal(data.overflow,false,name+' fits '+width);assert.equal(data.broken,0);
  assert.equal(data.actors,name==='studio'?2:1);
  await stage.screenshot({path:`${dir}/${name}-${width}.png`});
  report.pages.push({name,width,historyRows:count,...data});
 }
 assert.equal(report.voiceRequests,0,'Opening and reading old history must never auto speak');
 if(process.env.CHECK_REAL_VOICE==='1'){
  await page.goto(base+'/me.html#beikuang',{waitUntil:'domcontentloaded'});
  const stage=page.locator('.companion-stage');
  await stage.locator('[data-cs-voice]:not(:disabled)').waitFor();
  await stage.scrollIntoViewIfNeeded();
  await stage.locator('[data-cs-voice]').click();
  await page.waitForFunction(()=>document.querySelector('.companion-stage')?.dataset.voice==='speaking',{},{timeout:180000});
  report.realVoice={played:true};
  await stage.locator('[data-cs-text]').click();
  assert.equal(await stage.getAttribute('data-voice'),'idle');report.realVoice.clickInterrupted=true;
 }
 assert.deepEqual(report.errors,[]);report.passed=true;
}finally{await writeFile(`${dir}/report.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report));await browser.close();}
