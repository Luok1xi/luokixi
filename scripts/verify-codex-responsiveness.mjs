import {chromium} from 'playwright';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';

const base='http://127.0.0.1:17860',phase=process.env.VERIFY_PHASE||'after';
const dir=`campus/.data/verification-20261009/${phase}`;
await mkdir(dir,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:'C:/Users/user/AppData/Local/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe'});
const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
const page=await context.newPage(),report={phase,errors:[]};
page.on('pageerror',e=>report.errors.push(e.message));
try{
  const session=await (await context.request.get(base+'/api/hub/auth/session')).json();
  const secret=await readFile('campus/.data/hub/owner-private/developer-account.txt','utf8');
  const email=secret.match(/登录邮箱（仅本机占位）：([^\r\n]+)/)?.[1]?.trim();
  const password=secret.match(/初始密码：([^\r\n]+)/)?.[1]?.trim();
  const auth=await context.request.post(base+'/api/hub/auth/login',{headers:{'X-CSRFToken':session.csrfToken,Origin:base},data:{email,password}});
  assert.ok(auth.ok(),'Local owner login');
  for(const width of [1440,390]){
    await page.setViewportSize({width,height:width===390?844:1000});
    for(const seat of ['beikuang','codex']){
      await page.goto(`${base}/me.html#${seat}`,{waitUntil:'domcontentloaded'});
      await page.waitForSelector('.bk-head img');
      await page.waitForSelector('.cs-actor[data-ready="true"]');
      await page.waitForTimeout(500);
      const id=`${seat}-${width}`;
      report[id]=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth,avatarScale:getComputedStyle(document.querySelector('.bk-head img')).transform,avatarOrigin:getComputedStyle(document.querySelector('.bk-head img')).transformOrigin,badImages:[...document.images].filter(i=>i.complete&&!i.naturalWidth).length}));
      await page.locator('.bk-head').screenshot({path:`${dir}/${id}-head.png`});
      await page.locator('.companion-stage').screenshot({path:`${dir}/${id}-stage.png`});
      assert.equal(report[id].overflow,false,id+' page fits');
      assert.equal(report[id].badImages,0,id+' assets load');
    }
  }
  if(process.env.VERIFY_LIVE_CHAT==='1'){
    const s=await (await context.request.get(base+'/api/hub/auth/session')).json();
    const start=Date.now();
    const response=await context.request.post(base+'/api/hub/studio/codex/messages',{headers:{'X-CSRFToken':s.csrfToken,Origin:base},data:{body:'这是一条回复速度测试，不用记住、查资料或执行任务。用你平时的语气跟我打个招呼就好。',requestKey:crypto.randomUUID()}});
    const sent=await response.json();assert.ok(response.ok(),JSON.stringify(sent));
    const run=sent.run||sent;report.chat={id:run.id,acceptedMs:Date.now()-start};
    console.log(JSON.stringify({phase,event:'accepted',...report.chat}));
    let lastState='',lastLog=Date.now();
    while(Date.now()-start<240000){
      const fetched=await context.request.get(`${base}/api/hub/studio/runs/${run.id}`);
      const data=await fetched.json(),state=data.run||data;
      if(state.state==='running'&&!report.chat.startedMs)report.chat.startedMs=Date.now()-start;
      if(state.state!==lastState||Date.now()-lastLog>15000){console.log(JSON.stringify({phase,state:state.state,elapsedMs:Date.now()-start}));lastState=state.state;lastLog=Date.now();}
      if(!['queued','running'].includes(state.state)){
        report.chat={...report.chat,state:state.state,totalMs:Date.now()-start,messages:state.messages?.map(m=>({body:m.body,parts:m.messages?.length,model:m.model})),error:state.error};
        break;
      }
      await new Promise(resolve=>setTimeout(resolve,750));
    }
    assert.equal(report.chat.state,'completed',JSON.stringify(report.chat));
  }
}finally{
  await writeFile(`${dir}/report.json`,JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));await browser.close();
}
