import { initShell } from '../js/shell.js';
import { hubApi,hubState,loginURL } from '../js/hub.js';
import { esc } from '../js/data.js';
import { buildMaterialZip,localFileURL } from '../js/material-bag.js';
import '../styles/products.css';
initShell();
const $=s=>document.querySelector(s),KEY='luokixi.materials.bag.v1';
let all=[],filtered=[],subject='',limit=24,busy=false,controller=null;
let bag=[];try{bag=JSON.parse(localStorage.getItem(KEY)||'[]');if(!Array.isArray(bag))bag=[];bag=bag.filter(x=>{try{return x&&typeof x.title==='string'&&localFileURL(x.url);}catch{return false;}}).slice(0,30);}catch{bag=[];}
const subjects=[['','全部资料'],['英语四级','英语四级'],['英语六级','英语六级'],['高等数学','高等数学'],['线性代数','线性代数'],['大学物理','大学物理'],['大学化学','大学化学'],['计算机','计算机与编程'],['机械','机械与控制'],['雅思','雅思']];
const fetchJSON=async url=>{const r=await fetch(url,{signal:AbortSignal.timeout(6000)});if(!r.ok)throw Error(`目录读取失败 (${r.status})`);return r.json();};
function saveBag(){try{localStorage.setItem(KEY,JSON.stringify(bag));}catch{$('#bag-status').textContent='浏览器未允许保存，关闭页面后资料袋可能丢失。';}$('#bag-count').textContent=bag.length;$('#bag-download').disabled=!bag.length||busy;}
function add(item){if(bag.some(x=>x.url===item.url)){bag=bag.filter(x=>x.url!==item.url);}else{if(bag.length>=30){$('#library-status').textContent='资料袋已放入 30 份，请先打包这一批。';return;}bag.push(item);}saveBag();renderList();renderBag();}
function renderList(){
 const q=$('#library-q').value.trim().toLowerCase().replaceAll('线代','线性代数').replaceAll('高数','高等数学').replaceAll('大物','大学物理');
 const kind=$('#library-kind').value,year=$('#library-year').value;
 filtered=all.filter(x=>(!subject||x.course.includes(subject))&&(!q||q.split(/\s+/).every(w=>`${x.title} ${x.course} ${x.year} ${x.kind}`.toLowerCase().includes(w)))&&(!kind||`${x.kind} ${x.title}`.includes(kind))&&(!year||x.year===year));
 $('#library-heading').textContent=subjects.find(x=>x[0]===subject)?.[1]||'全校资料库';$('#library-count').textContent=`${filtered.length} 份实际文件`;
 $('#library-subjects').innerHTML=subjects.map(([id,name])=>`<button data-subject="${id}" aria-pressed="${id===subject}">${name}<span>${all.filter(x=>!id||x.course.includes(id)).length}</span></button>`).join('');
 $('#library-list').innerHTML=filtered.length?filtered.slice(0,limit).map(x=>`<article class="material-row"><div class="material-cover" data-format="${esc(x.format)}"><span>${esc(x.format.toUpperCase())}</span><b>${esc(x.course.slice(0,6))}</b><i>${esc(x.year||'年份待核')}</i></div><div class="material-copy"><p class="section-label">${esc(x.course)} · ${esc(x.kind)}</p><h3>${esc(x.title)}</h3><p>${esc(x.pages?`${x.pages} 页 · `:'')}${esc(x.note||'请以原文件为准')}</p><small>${esc(x.rights)}</small><div class="material-actions"><a href="${esc(x.url)}" target="_blank" rel="noopener">预览原件 ↗</a>${x.external?'<span class="small-note">仅原站链接</span>':`<button data-add="${esc(x.id)}" aria-pressed="${bag.some(b=>b.url===x.url)}">${bag.some(b=>b.url===x.url)?'✓ 已放入资料袋':'＋ 放入资料袋'}</button>`}</div></div></article>`).join(''):`<div class="product-empty"><span class="empty-symbol">↗</span><h3>这一格，等你来补充。</h3><p>当前没有符合条件的文件。可以换个关键词，或分享这门课的第一份资料。</p><button class="btn btn-primary" data-upload>分享资料</button></div>`;
 $('#library-more').hidden=filtered.length<=limit;
}
function renderBag(){ $('#bag-list').innerHTML=bag.length?bag.map(x=>`<div class="bag-item"><span><b>${esc(x.title)}</b><small>${esc(x.course)} · ${esc(x.format.toUpperCase())}</small></span><button data-remove="${esc(x.id)}" aria-label="移除 ${esc(x.title)}" ${busy?'disabled':''}>移除</button></div>`).join(''):'<div class="product-empty"><h3>资料袋还是空的。</h3><p>把需要的试卷、答案和笔记逐份放进来。</p></div>';saveBag();}
document.addEventListener('click',e=>{const b=e.target.closest('[data-add],[data-remove],[data-subject],[data-upload],[data-close]');if(!b)return;if(b.hasAttribute('data-close'))b.closest('dialog').close();if(b.hasAttribute('data-add'))add(all.find(x=>x.id===b.dataset.add));if(b.hasAttribute('data-remove')&&!busy){bag=bag.filter(x=>x.id!==b.dataset.remove);renderBag();renderList();}if(b.hasAttribute('data-subject')){subject=b.dataset.subject;limit=24;renderList();}if(b.hasAttribute('data-upload'))openUpload();});
$('#library-search').onsubmit=e=>{e.preventDefault();limit=24;renderList();};let debounce;$('#library-q').oninput=()=>{clearTimeout(debounce);debounce=setTimeout(()=>{limit=24;renderList();},130);};['#library-kind','#library-year'].forEach(id=>$(id).onchange=()=>{limit=24;renderList();});$('#library-more').onclick=()=>{limit+=24;renderList();};
$('#bag-open').onclick=()=>{renderBag();$('#bag-dialog').showModal();};$('#bag-clear').onclick=()=>{if(!busy){bag=[];renderBag();renderList();}};
$('#bag-cancel').onclick=()=>controller?.abort();$('#bag-download').onclick=async()=>{if(busy)return;busy=true;controller=new AbortController();$('#bag-status').textContent='正在读取所选原文件…';$('#bag-cancel').hidden=false;$('#bag-clear').disabled=true;$('#bag-progress').hidden=false;renderBag();try{const result=await buildMaterialZip([...bag],{signal:controller.signal,onProgress:s=>{$('#bag-progress').max=s.total;$('#bag-progress').value=s.done;$('#bag-status').textContent=`正在打包 ${s.done}/${s.total} · ${(s.bytes/1048576).toFixed(1)} MB`;}});const url=URL.createObjectURL(new Blob([result],{type:'application/zip'}));const a=document.createElement('a');a.href=url;a.download=`Luokixi-资料袋-${new Date().toISOString().slice(0,10)}.zip`;a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);$('#bag-status').textContent='打包完成，已交给浏览器下载。来源清单已附在 ZIP 内。';}catch(e){$('#bag-status').textContent=e.name==='AbortError'?'已取消，资料仍保留在袋中。':e.message;}finally{busy=false;$('#bag-cancel').hidden=true;$('#bag-clear').disabled=false;$('#bag-progress').hidden=true;renderBag();}};
async function openUpload(){const s=await hubState();if(!s.user){location.href=loginURL();return;}$('#upload-dialog').showModal();}
$('#upload-open').onclick=openUpload;
$('#upload-form').onsubmit=async e=>{e.preventDefault();const form=e.currentTarget,button=form.querySelector('[type=submit]'),v=Object.fromEntries(new FormData(form));const files=[...form.elements.files.files];if(files.length>10||files.some(f=>f.size>25*1024*1024)){$('#upload-status').textContent='一次最多 10 份，每份不超过 25 MB。';return;}button.disabled=true;try{const uploads=[];for(const file of files){$('#upload-status').textContent=`正在上传 ${file.name}`;const u=await hubApi.upload(file);uploads.push(u.id);}const entry=await hubApi.create('resource',{title:v.title,course:v.course,year:v.year,summary:v.summary,credit:v.credit,sourceNote:v.credit,license:v.license,uploads,rightsConfirmed:form.elements.rights.checked,links:v.source?{source:v.source}:{}});await hubApi.submit(entry.id,entry.editRevision);$('#upload-status').innerHTML='已提交审核。<a href="me.html#entries">到我的投稿查看进度 →</a>';form.reset();}catch(err){$('#upload-status').textContent=err.message;}finally{button.disabled=false;}};
async function init(){
 saveBag();let isLocal=false;
 try {
  if(['127.0.0.1','localhost'].includes(location.hostname)){
   const first=await fetchJSON('/api/catalogue');
   const pages=await Promise.all(Array.from({length:Math.max(0,Math.ceil(first.total/30)-1)},(_,i)=>fetchJSON(`/api/catalogue?offset=${(i+1)*30}`)));
   all=[...first.items,...pages.flatMap(x=>x.items)].map(x=>({id:x.id,title:x.title,course:x.course,year:x.year,kind:x.kind,format:x.format,pages:x.pages,url:`/api/file/${x.id}`,rights:x.rights,source:x.source_url,note:x.snippet}));isLocal=true;
  }
 } catch { $('#library-status').textContent='本机资料服务暂时无法连接。先显示公共目录。'; }
 if(!isLocal){
  const d=await fetchJSON('data/school.json');
  const available=await Promise.all(d.papers.filter(x=>x.file).map(async x=>{try{const r=await fetch(new URL(x.file,location.href),{method:'HEAD',signal:AbortSignal.timeout(3000)});return r.ok&&!/text\/html/.test(r.headers.get('content-type')||'')?x:null;}catch{return null;}}));
  all=available.filter(Boolean).map(x=>({id:x.id,title:`${d.courses.find(c=>c.id===x.course)?.name||x.course} · ${x.year} · ${x.kind}`,course:d.courses.find(c=>c.id===x.course)?.name||x.course,year:x.year,kind:'试卷',format:'pdf',pages:x.pages,url:new URL(x.file,location.href).pathname,rights:'请保留原作者与原文件标注',note:x.hasAnswers?'含答案或评分标准':'原卷'}));
 }
 // Approved community resources share this catalogue. Drafts never enter the result.
 const state=await hubState();
 if(state.online){try{
   const first=await hubApi.catalogue({kind:'resource'});
   const pages=await Promise.all(Array.from({length:Math.min(9,Math.max(0,Math.ceil(first.total/30)-1))},(_,i)=>hubApi.catalogue({kind:'resource',offset:(i+1)*30})));
   for(const entry of [...first.items,...pages.flatMap(p=>p.items)]){
    const d=entry.data;
    for(const a of entry.attachments||[]){all.push({id:a.id,title:`${d.title} · ${a.name}`,course:d.course||'其他课程',year:d.year,kind:d.tags?.includes('笔记')?'笔记':'资料',format:a.name.split('.').pop().toLowerCase(),pages:a.pages,url:a.url,rights:d.license,source:d.links?.source||'',note:d.summary});}
    if(!(entry.attachments||[]).length&&d.links?.source){all.push({id:entry.id,title:d.title,course:d.course||'其他课程',year:d.year,kind:'站外链接',format:'link',url:d.links.source,rights:d.license,source:d.links.source,note:d.summary,external:true});}
   }
   if(first.total>300)$('#library-status').textContent='已载入最近 300 条公开投稿；更多内容请使用全文检索。';
  }catch{ $('#library-status').textContent='公开投稿暂时读取失败，以下为已载入的本机文件。'; }
 }
 const years=[...new Set(all.map(x=>x.year).filter(Boolean))].sort().reverse();
 $('#library-year').insertAdjacentHTML('beforeend',years.map(y=>`<option>${esc(y)}</option>`).join(''));
 if(isLocal)$('#library-status').textContent='当前包含本机资料，仅在这台电脑可用；不代表已获公开转载授权。';
 renderList();if(new URLSearchParams(location.search).has('upload'))openUpload();
}
init().catch(e=>{$('#library-status').textContent=e.message;$('#library-count').textContent='目录读取失败';$('#library-list').innerHTML='<p class="product-empty">请刷新重试，或从旧版资料页继续浏览。<a href="school.html">校内资料 →</a></p>';});
