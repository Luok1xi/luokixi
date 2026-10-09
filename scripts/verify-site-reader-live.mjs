// Read-only acceptance against the real local site. Credentials never leave this process.
import {chromium} from 'playwright';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const base='http://127.0.0.1:17860',out='campus/.data/reader-verification-20261009';
await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:'C:/Users/user/AppData/Local/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe'});
const context=await browser.newContext({baseURL:base,viewport:{width:1280,height:900},reducedMotion:'reduce',acceptDownloads:true});
const page=await context.newPage(),errors=[],checks=[];
page.on('pageerror',e=>errors.push(e.message));
const json=async route=>{const r=await context.request.get(route);assert.ok(r.ok(),route+' HTTP '+r.status());return r.json();};
const check=(name,data={})=>{checks.push({name,...data});console.log(name);};
const open=async route=>{await page.goto(route,{waitUntil:'load'});await page.locator('#reader-content[aria-busy="false"]').waitFor();assert.notEqual(await page.locator('#reader-title').textContent(),'暂时无法打开');};
try{
 let session=await json('/api/hub/auth/session');
 const secret=await readFile('campus/.data/hub/owner-private/developer-account.txt','utf8');
 const email=secret.match(/登录邮箱（仅本机占位）：([^\r\n]+)/)?.[1]?.trim(),password=secret.match(/初始密码：([^\r\n]+)/)?.[1]?.trim();
 assert.ok(email&&password);
 const login=await context.request.post('/api/hub/auth/login',{headers:{'X-CSRFToken':session.csrfToken,Origin:base},data:{email,password}});assert.ok(login.ok());
 session=await json('/api/hub/auth/session');assert.equal(session.user.emailVerified,false);assert.equal(session.user.canParticipate,true);assert.equal(session.user.developer,true);
 check('Unverified developer has server-granted participation');
 await page.goto('/materials.html');await page.locator('#upload-open').click();await page.locator('#upload-dialog[open] #upload-form').waitFor({state:'visible'});
 assert.equal(await page.locator('#upload-gate').textContent(),'');await page.locator('#upload-dialog [aria-label="关闭上传"]').click();check('Materials upload form opens without mailbox gate');
 const first=await json('/api/catalogue');let docs=[...first.items];
 for(let offset=docs.length;offset<first.total;offset+=30)docs.push(...(await json('/api/catalogue?offset='+offset)).items);
 assert.equal(docs.length,first.total);assert.ok(docs.length>=218);check('Real published library retained',{total:docs.length});
 const pdf=docs.find(x=>x.format==='pdf'),mp3=docs.find(x=>x.format==='mp3'),html=await json('/api/document/a303672b7a8c447baa85add73e3cd584');assert.ok(pdf&&mp3&&html);
 await open('/viewer.html?kind=document&id='+pdf.id);await page.locator('.reader-pdf-canvas[data-page="1"][aria-busy="false"] canvas').waitFor({timeout:30000});
 assert.ok(await page.locator('.reader-pdf-canvas canvas').evaluate(canvas=>{const raw=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;let dark=0;for(let i=0;i<raw.length;i+=400)if(raw[i]<180)dark++;return dark>10;}),'PDF page contains visible rendered ink');
 const [download]=await Promise.all([page.waitForEvent('download'),page.locator('#reader-download').click()]);
 assert.ok(download.suggestedFilename().endsWith('.pdf'));const bytes=await readFile(await download.path());assert.equal(bytes.toString('ascii',0,4),'%PDF');
 check('PDF renders visible page content and download contains PDF bytes',{bytes:bytes.length});
 await page.screenshot({path:out+'/pdf-desktop.png'});
 if(!(await page.locator('[data-pdf-next]').isDisabled())){await page.locator('[data-pdf-next]').click();await page.locator('.reader-pdf-canvas[data-page="2"][aria-busy="false"]').waitFor();check('PDF next page renders');}
 const dimensions=await page.locator('.reader-pdf-canvas canvas').evaluate(c=>({width:c.width,height:c.height}));
 await page.locator('[data-pdf-rotate]').click();await page.waitForFunction(before=>{const c=document.querySelector('.reader-pdf-canvas canvas');return c&&Math.sign(c.width-c.height)!==Math.sign(before.width-before.height);},dimensions);
 await page.setViewportSize({width:390,height:844});await page.waitForFunction(()=>{const c=document.querySelector('.reader-pdf-canvas canvas');return c?.getBoundingClientRect().width<=innerWidth;});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:out+'/pdf-mobile.png'});check('Scanned PDF rotates and fits mobile screen');
 await page.setViewportSize({width:1280,height:900});
 await open('/viewer.html?kind=document&id='+mp3.id);await page.waitForFunction(()=>Number.isFinite(document.querySelector('audio')?.duration),{},{timeout:20000});
 check('Listening audio loads playable metadata',{seconds:await page.locator('audio').evaluate(x=>x.duration)});
 await open('/viewer.html?kind=document&id='+html.id);assert.ok((await page.locator('.reader-text').textContent()).length>100);assert.match(await page.locator('#reader-note').textContent(),/提取文本/);
 const text=await context.request.get('/api/file/'+html.id);assert.ok(text.ok());assert.match(text.headers()['content-disposition'],/\.md/);assert.match(await text.text(),/非原始网页完整副本/);check('Collected webpage exports clearly labelled extracted text');
 const projects=(await json('/api/hub/catalogue?kind=project')).items;
 assert.ok(projects.length);await page.goto('/project.html?id='+projects[0].id);await page.locator('#pd-reply-body').waitFor({state:'visible'});check('Developer can access project reply form');
 await page.locator('a[href*="viewer.html?kind=entry"]').first().click();await page.waitForURL('**/viewer.html?kind=entry*');await page.locator('.reader-prose').waitFor();
 check('Project detail enters on-site reader');
 const news=(await json('/api/hub/catalogue?kind=news')).items;assert.ok(news.length);
 await open('/viewer.html?kind=entry&id='+news[0].id);assert.ok((await page.locator('.reader-prose').textContent()).length>60);
 const exported=await context.request.get('/api/hub/reader/entry/'+news[0].id+'/download');assert.ok(exported.ok());assert.match(await exported.text(),/上传时间/);check('News content and discussion export on site');
 let mirror;
 for(const p of projects.slice(0,12)){
  const repo=p.data.links?.repo?.match(/github\.com\/([^/]+\/[^/#?]+)/)?.[1];if(!repo)continue;
  const m=await json('/api/hub/mirror?repository='+encodeURIComponent(repo));mirror=m.items?.find(x=>x.available&&x.name.endsWith('.zip'));if(mirror)break;
 }
 assert.ok(mirror,'existing mirrored ZIP');await open('/viewer.html?kind=mirror&id='+mirror.id);
 const readme=page.locator('[data-member]').filter({hasText:/readme/i}).first();
 const [memberResponse]=await Promise.all([page.waitForResponse(r=>r.url().includes('/reader/mirror/')&&r.url().includes('member=')),readme.click()]);
 assert.ok(memberResponse.ok(),'ZIP member API HTTP '+memberResponse.status());await page.waitForFunction(()=>document.querySelector('#member-content')?.textContent.length>20);
 check('Mirrored ZIP directory and README readable without extracting');
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:out+'/archive-mobile.png',fullPage:true});
 const overflow=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,elements:[...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().right>innerWidth+1).slice(0,12).map(e=>({tag:e.tagName,cls:e.className,width:e.getBoundingClientRect().width,right:e.getBoundingClientRect().right,min:getComputedStyle(e).minWidth,whiteSpace:getComputedStyle(e).whiteSpace}))}));
 assert.ok(overflow.scroll<=overflow.width+1,JSON.stringify(overflow));check('Mobile reader fits 390px viewport');
 await open('/viewer.html?file='+encodeURIComponent('/art/beikuang/avatar.png'));await page.waitForFunction(()=>document.querySelector('.reader-image')?.naturalWidth>0);check('Local post/art image viewer works');
 await page.goto('/me.html#account');await page.getByText('开发者账号可以直接发帖、回复、上传和测试，无需验证邮箱。',{exact:true}).waitFor();check('Account explains developer exemption truthfully');
 assert.deepEqual(errors,[]);check('No browser script errors');
 await writeFile(out+'/report.json',JSON.stringify({passed:true,checks,errors},null,2));
}catch(e){const reason=String(e.message).split('Call log:')[0].trim();await page.screenshot({path:out+'/failure.png',fullPage:true});await writeFile(out+'/report.json',JSON.stringify({passed:false,url:page.url(),memberStatus:await page.locator('#member-name').textContent().catch(()=>null),error:reason,checks,errors},null,2));throw Error(reason);}
finally{await context.close();await browser.close();}
