// Read-only Playwright maintenance: isolated browser, fixed local pages, no user cookies.
import {chromium} from 'playwright';
import {readdirSync,existsSync} from 'node:fs';
import {join} from 'node:path';
const base='http://127.0.0.1:17860';
const cache=join(process.env.LOCALAPPDATA||'','ms-playwright');
const installed=existsSync(cache)?readdirSync(cache).filter(n=>n.startsWith('chromium_headless_shell-')).sort().reverse():[];
const executable=installed.map(n=>join(cache,n,'chrome-headless-shell-win64','chrome-headless-shell.exe')).find(existsSync);
let browser;
try{
  browser=await chromium.launch({headless:true,...(executable?{executablePath:executable}:{})});
  const context=await browser.newContext({serviceWorkers:'block'}),pages=[],issues=[];
  await context.route('**/*',route=>{
    const req=route.request(),url=new URL(req.url());
    if(url.origin!==base||!['GET','HEAD'].includes(req.method())||/\/(?:auth|logout)\b/.test(url.pathname))return route.abort();
    return route.continue();
  });
  for(const width of [1280,390])for(const path of ['/','/materials.html','/studio.html']){
    const page=await context.newPage();await page.setViewportSize({width,height:900});const errors=[];
    page.on('pageerror',e=>errors.push(String(e.message).slice(0,240)));
    try{
      const response=await page.goto(base+path,{waitUntil:'domcontentloaded',timeout:20000});
      await page.locator('body').waitFor();await page.waitForTimeout(900);
      const state=await page.evaluate(()=>({title:document.title,overflow:document.documentElement.scrollWidth>innerWidth+4,
        brokenImages:[...document.images].filter(i=>i.getAttribute('src')?.startsWith('/')&&i.complete&&!i.naturalWidth).map(i=>i.getAttribute('src')).slice(0,10)}));
      const result={path,width,status:response?.status(),...state,errors};pages.push(result);
      if(!response?.ok()||state.overflow||state.brokenImages.length||errors.length)issues.push(result);
    }catch(e){issues.push({path,width,error:String(e.message).slice(0,240)});}
    finally{await page.close();}
  }
  console.log(JSON.stringify({engine:'Microsoft Playwright',at:new Date().toISOString(),pages,issues,
    scope:'隔离浏览器、公开页面、桌面和手机宽度；未登录，不代表私聊或付费模型测试通过',errors:issues.map(i=>i.path+' @'+i.width+'：'+(i.error||i.errors?.join('；')||i.brokenImages?.join('；')||(i.overflow?'横向溢出':'页面状态异常')))}));
}catch(e){console.error(String(e.message).slice(0,500));process.exitCode=1;}
finally{await browser?.close();}
