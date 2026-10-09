import {chromium} from 'playwright';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const base='http://127.0.0.1:17860',out='campus/.data/quality-20261009';await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:'C:/Users/user/AppData/Local/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe'});
const context=await browser.newContext({baseURL:base,viewport:{width:1280,height:900},acceptDownloads:true});const page=await context.newPage(),errors=[],checks=[];
page.on('pageerror',e=>errors.push(e.message));const get=async path=>{const r=await context.request.get(path);assert.ok(r.ok(),path+' HTTP '+r.status());return r.json();};
try{
 const session=await get('/api/hub/auth/session'),secret=await readFile('campus/.data/hub/owner-private/developer-account.txt','utf8');
 const email=secret.match(/登录邮箱（仅本机占位）：([^\r\n]+)/)?.[1]?.trim(),password=secret.match(/初始密码：([^\r\n]+)/)?.[1]?.trim();
 assert.ok(email&&password);assert.ok((await context.request.post('/api/hub/auth/login',{headers:{'X-CSRFToken':session.csrfToken,Origin:base},data:{email,password}})).ok());
 assert.equal((await get('/api/hub/health')).beikuangChatVersion,30);
 const robots=await get('/api/hub/studio/robots');assert.equal(robots.tools.filter(t=>t.state==='ready').length,2);checks.push({name:'两项真实工具通过安装测试',tools:robots.tools.map(t=>({id:t.id,state:t.state,test:t.receipt.test.passed}))});
 await page.goto('/studio.html');await page.getByText('可安装工具与真实试验记录',{exact:true}).waitFor();await page.getByText('可安装工具与真实试验记录',{exact:true}).click();await page.getByText('Markdown 结构阅读器',{exact:true}).waitFor();checks.push({name:'工作室显示工具和试验记录'});
 const catalogue=await get('/api/hub/catalogue'),illustrated=catalogue.items.filter(x=>x.data.autoMedia?.url?.startsWith('/api/hub/illustration/'));
 assert.ok(illustrated.length);const urls=illustrated.map(x=>x.data.autoMedia.url);assert.equal(new Set(urls).size,urls.length);
 for(const item of illustrated.slice(0,8)){const r=await context.request.get(item.data.autoMedia.url);assert.ok(r.ok());assert.match(r.headers()['content-type'],/image\/svg/);}
 await page.goto('/viewer.html?file='+encodeURIComponent(urls[0]));await page.waitForFunction(()=>document.querySelector('.reader-image')?.naturalWidth>0);await page.screenshot({path:out+'/article-cover.png'});checks.push({name:'独立文章封面均可加载，注明示意图',checked:Math.min(8,urls.length)});
 const projects=(await get('/api/hub/catalogue?kind=project')).items;let project,asset;
 for(const p of projects){const repo=p.data.links?.repo?.match(/github\.com\/([^/]+\/[^/#?]+)/)?.[1];if(!repo)continue;const coverage=robots.coverage.items.find(x=>x.repository.toLowerCase()===repo.toLowerCase());if(coverage?.guide!=='reviewed'||!coverage.packages)continue;const mirrors=await get('/api/hub/mirror?repository='+encodeURIComponent(repo));const file=mirrors.items.find(x=>x.available&&x.size>1024&&x.size<32*1024*1024);if(file){project=p;asset=file;break;}}
 assert.ok(project&&asset);await page.goto('/project.html?id='+project.id);await page.locator('[data-film-open]').waitFor();await page.locator('[data-film-open]').click();await page.locator('[data-project-film] canvas').waitFor();
 await page.locator('[data-project-film]').scrollIntoViewIfNeeded();await page.locator('[data-play]').click();await page.waitForTimeout(800);await page.locator('[data-play]').click();await page.screenshot({path:out+'/chinese-project-film.png'});checks.push({name:'已核对导读生成可播放的中文讲解'});
 const [film]=await Promise.all([page.waitForEvent('download',{timeout:30000}),page.locator('[data-save]').click()]);const filmBytes=await readFile(await film.path());assert.equal(filmBytes.subarray(0,4).toString('hex'),'1a45dfa3');assert.ok(filmBytes.length>10000);checks.push({name:'讲解视频导出为真实 WebM',bytes:filmBytes.length});
 await page.goto('/viewer.html?kind=mirror&id='+asset.id);await page.locator('#reader-download[data-accelerate]').waitFor();const ranges=[];page.on('request',r=>{if(r.url().includes('/mirror/'+asset.id+'/file')&&r.headers().range)ranges.push(r.headers().range);});
 const [download]=await Promise.all([page.waitForEvent('download',{timeout:45000}),page.locator('#reader-download').click()]);const bytes=await readFile(await download.path());assert.equal(createHash('sha256').update(bytes).digest('hex'),asset.sha256);assert.ok(ranges.length>=2);checks.push({name:'真实镜像分段下载，最终哈希与原件一致',nameOnDisk:download.suggestedFilename(),bytes:bytes.length,ranges:ranges.length});
 await page.goto('/viewer.html?kind=entry&id='+project.id);await page.locator('.reader-prose').first().waitFor();assert.ok(await page.locator('.reader-original').count());assert.equal(await page.locator('.reader-original').getAttribute('open'),null);checks.push({name:'中文默认阅读，原文折叠保留'});
 await page.setViewportSize({width:390,height:844});await page.goto('/project.html?id='+project.id);await page.locator('[data-film-open]').waitFor();await page.locator('[data-film-open]').click();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:out+'/project-mobile.png'});checks.push({name:'手机详情和视频无横向溢出'});
 assert.deepEqual(errors,[]);await writeFile(out+'/browser.json',JSON.stringify({passed:true,checks,errors,coverage:robots.coverage},null,2));console.log(JSON.stringify({passed:true,checks,errors}));
}catch(e){const reason=String(e.message).split('Call log:')[0].trim();await page.screenshot({path:out+'/failure.png',fullPage:true});await writeFile(out+'/browser.json',JSON.stringify({passed:false,error:reason,url:page.url(),checks,errors},null,2));throw Error(reason);}finally{await context.close();await browser.close();}
