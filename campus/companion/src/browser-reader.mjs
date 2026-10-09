import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {lookup} from 'node:dns/promises';
import {publicAddress} from './public-reader.mjs';
import {webUrl} from './web-life-state.mjs';
const require=createRequire(import.meta.url);
export const loginSites={bilibili:'https://www.bilibili.com/',zhihu:'https://www.zhihu.com/',niconico:'https://www.nicovideo.jp/'};
const suffix=(host,root)=>host===root||host.endsWith('.'+root);
export function blockedPage(text,status=200){if([401,403,412,429].includes(status)||/验证码|安全验证|访问异常|操作频繁|captcha|verify you are human|access denied/i.test(text.slice(0,1800)))return 'verification_required';if(/登录后(?:即可|查看|继续)|请先登录|Sign in to continue/i.test(text.slice(0,600)))return 'login_required';return null;}
export class BrowserReader{
 constructor({dataDir=resolve(process.env.MIKU_DATA||'data'),launcher=null}={}){this.dataDir=dataDir;this.launcher=launcher;this.context=null;this.visible=false;this.queue=Promise.resolve();this.status={};this.cache=new Map();}
 exclusive(fn){const p=this.queue.then(fn);this.queue=p.catch(()=>{});return p;}
 async start(visible=false){if(this.context&&(!visible||this.visible))return this.context;if(this.context)await this.close();let chromium=this.launcher;if(!chromium){try{chromium=require('playwright').chromium;}catch{try{chromium=require(resolve(process.env.USERPROFILE||'', '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')).chromium;}catch{throw new Error('浏览器驱动未安装，未自动下载软件。');}}}
  this.context=await chromium.launchPersistentContext(resolve(this.dataDir,'web-browser'),{channel:'msedge',headless:!visible,acceptDownloads:false,serviceWorkers:'block',viewport:{width:1280,height:850}});this.visible=visible;
  this.context.on('close',()=>{this.context=null;});return this.context;
 }
 async openLogin(site){if(!loginSites[site])throw new Error('未知登录网站。');return this.exclusive(async()=>{const c=await this.start(true),p=await c.newPage();await this.guard(p,site);await p.goto(loginSites[site],{waitUntil:'domcontentloaded',timeout:30000});this.status[site]={status:'login_window_open',at:Date.now()};this.cache.clear();return {message:'专用浏览器已打开；请在该窗口自行登录或完成验证，完成后点击“登录完成”。'};});}
 async publicHost(host){if(/^(localhost|.*\.localhost)$/i.test(host))throw new Error('拒绝本机地址');const rows=await lookup(host,{all:true});if(!rows.length||rows.some(r=>!publicAddress(r.address)))throw new Error('拒绝非公网地址');}
 async guard(page,site){const checked=new Map();const allowed=site==='bilibili'?['bilibili.com','biliapi.net','biliapi.com','hdslb.com','bilivideo.com','biliimg.com']:site==='zhihu'?['zhihu.com','zhimg.com']:['nicovideo.jp','nimg.jp','dmc.nico','nicovideo.cdn.nimg.jp'];
  await page.route('**/*',async route=>{try{const u=new URL(route.request().url());if(!['https:','http:'].includes(u.protocol)||u.username||u.password||u.port||!allowed.some(d=>suffix(u.hostname,d)))return route.abort();let ok=checked.get(u.hostname);if(!ok){await this.publicHost(u.hostname);checked.set(u.hostname,true);}if(['media','font'].includes(route.request().resourceType()))return route.abort();await route.continue();}catch{await route.abort();}});
 }
 site(url){const host=new URL(webUrl(url)).hostname;for(const site of Object.keys(loginSites))if(suffix(host,new URL(loginSites[site]).hostname.replace(/^www\./,'')))return site;throw new Error('浏览器读取仅用于 B 站、知乎和 niconico；其他站点优先公开正文接口。');}
 async page(url,search=false){url=webUrl(url);const site=this.site(url),state=this.status[site];if(state?.until>Date.now())throw new Error('网站需要你登录或验证，已暂停自动重试；请在专用浏览器处理。');const cache=this.cache.get(url);if(cache?.until>Date.now())return structuredClone(cache.data);return this.exclusive(async()=>{
  const c=await this.start(),p=await c.newPage();try{await this.guard(p,site);const r=await p.goto(url,{waitUntil:'domcontentloaded',timeout:30000});await p.waitForTimeout(1200);const visible=await p.locator('body').innerText({timeout:5000}),blocked=blockedPage(visible,r?.status());if(blocked){this.status[site]={status:blocked,at:Date.now(),until:Date.now()+3600000};throw new Error('网页要求登录或安全验证；已停止读取，等待你在专用浏览器处理。');}
   let data;if(search){data=await p.locator('a[href]').evaluateAll(nodes=>nodes.map(a=>({url:a.href,title:(a.getAttribute('title')||a.closest('.bili-video-card,.video-item,.List-item')?.querySelector('h3,.bili-video-card__info--tit,.ContentItem-title')?.textContent||a.textContent).trim().replace(/\s+/g,' ').slice(0,200),text:a.closest('.bili-video-card,article,section,.video-item,.List-item,.video-list-item')?.textContent.trim().replace(/\s+/g,' ').slice(0,1000)||a.textContent.trim()})).filter(x=>x.title.length>4));data=data.filter(x=>{try{webUrl(x.url);return /\/video\/BV[\da-zA-Z]{10}|\/question\/\d+\/answer\/\d+|\/p\/\d+|\/watch\/(sm|so)\d+/.test(new URL(x.url).pathname);}catch{return false;}}).filter((x,i,a)=>a.findIndex(y=>y.url===x.url)===i).slice(0,8).map(x=>({...x,readLevel:'search-excerpt'}));if(!data.length)throw new Error('浏览器已打开，但没有取得可用结果；不把空页面当作读过。');}
   else{let text;if(site==='bilibili')text=await p.locator('h1,.video-desc-container,.basic-desc-info').allTextContents().then(x=>x.join('\n'));else if(site==='zhihu')text=await p.locator('h1,.RichContent-inner,.Post-RichTextContainer').allTextContents().then(x=>x.join('\n'));else text=visible;
    if(!text||text.length<40)throw new Error('页面只有标题或空内容，需要登录或完整加载。');const comments=await p.locator(site==='bilibili'?'.reply-content':'.CommentContent,.CommentItem-content').allTextContents().catch(()=>[]);data={url:p.url(),title:await p.title(),text:text.slice(0,14000),comments:comments.slice(0,20).map(x=>x.slice(0,400)),readLevel:site==='bilibili'?'video-description':'page-text',limitations:['读取浏览器实际显示的内容；未自动播放或理解完整视频。']};}
   this.status[site]={status:'readable',at:Date.now()};this.cache.set(url,{until:Date.now()+15*60000,data});if(this.cache.size>30)this.cache.delete(this.cache.keys().next().value);return data;
  }finally{await p.close();}
 });}
 document(url){return this.page(url);}
 discover(source){const site=source.kind==='bilibili-search'?'bilibili':source.kind==='zhihu-search'?'zhihu':'niconico';const url=site==='bilibili'?'https://search.bilibili.com/all?keyword='+encodeURIComponent(source.query):site==='zhihu'?'https://www.zhihu.com/search?type=content&q='+encodeURIComponent(source.query):'https://www.nicovideo.jp/search/'+encodeURIComponent(source.query);return this.page(url,true);}
 confirm(site){if(!loginSites[site])throw new Error('未知网站');delete this.status[site];this.cache.clear();return {message:'已清除访问冷却，下一次会重新检查实际页面；不会仅凭点击就认定登录成功。'};}
 async close(){const c=this.context;this.context=null;if(c)await c.close();}
}
