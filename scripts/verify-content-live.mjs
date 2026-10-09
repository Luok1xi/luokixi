import {chromium} from 'playwright';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
const base='http://127.0.0.1:17860';
const browser=await chromium.launch({headless:true,executablePath:'C:/Users/user/AppData/Local/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe'});
const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
const report={};
try{
  const session=await (await context.request.get(base+'/api/hub/auth/session')).json();
  const credentials=await readFile('campus/.data/hub/owner-private/developer-account.txt','utf8');
  const email=credentials.match(/登录邮箱（仅本机占位）：([^\r\n]+)/)?.[1]?.trim();
  const password=credentials.match(/初始密码：([^\r\n]+)/)?.[1]?.trim();
  if(!email||!password)throw Error('Local owner credential fields unavailable');
  const auth=await context.request.post(base+'/api/hub/auth/login',{headers:{'X-CSRFToken':session.csrfToken,Origin:base},data:{email,password}});
  if(!auth.ok())throw Error('Owner login failed: '+auth.status());
  for(const path of ['/api/health','/api/hub/health','/api/library/feed','/api/hub/studio/robots']){
    const r=await context.request.get(base+path);const d=await r.json();
    report[path]={status:r.status(),total:d.total,robots:d.robots?.length,version:d.libraryPipelineVersion||d.beikuangChatVersion,policy:d.policy};
  }
  await mkdir('campus/.data/verification-20261008',{recursive:true});
  for(const [name,url,selector] of [['materials','materials.html','.mt-row'],['codex','me.html#codex','[data-codex-thread]'],['beikuang','me.html#beikuang','[data-bk-thread]'],['home','index.html','.home-updates'],['studio','studio.html','.robot-console'],['discover','discover.html','#disc-gallery']]){
    await page.goto(base+'/'+url,{waitUntil:'domcontentloaded'});
    try{await page.waitForSelector(selector,{timeout:18000});}catch{ /* Capture the actual DOM for diagnosis. */ }
    await page.waitForTimeout(1800);
    report[name]=await page.evaluate(()=>({title:document.title,overflow:document.documentElement.scrollWidth>innerWidth,text:document.body.innerText.slice(-1500),images:[...document.images].filter(i=>i.complete&&i.naturalWidth===0).map(i=>i.getAttribute('src')).slice(0,6)}));
    if(name==='codex'||name==='home')await page.screenshot({path:`campus/.data/verification-20261008/${name}.png`,fullPage:false});
  }
  await page.setViewportSize({width:390,height:844});
  await page.goto(base+'/me.html#codex');await page.waitForSelector('[data-codex-thread]');await page.waitForTimeout(1500);
  report.mobile=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth,avatar:document.querySelector('.codex-avatar img')?.naturalWidth}));
  await page.screenshot({path:'campus/.data/verification-20261008/codex-mobile.png'});
  report.errors=errors;
  await writeFile('campus/.data/verification-20261008/browser.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify(Object.fromEntries(Object.entries(report).map(([k,v])=>[k,v?.text?{...v,text:undefined}:v])),null,2));
}finally{await browser.close();}
