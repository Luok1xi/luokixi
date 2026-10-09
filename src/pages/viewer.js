import {initShell} from '../js/shell.js';
import {readerTarget} from '../js/site-reader.js';
import {esc} from '../js/data.js';
import {renderMarkdown} from '../js/markdown.js';
import '../styles/viewer.css';
initShell();
const $=s=>document.querySelector(s),params=new URLSearchParams(location.search);
let current,apiPath='',serial=0;
const local=value=>{if(typeof value!=='string'||!value.trim())return null;try{const u=new URL(value,location.origin);return u.origin===location.origin?u.pathname+u.search:null;}catch{return null;}};
async function json(url){const r=await fetch(url,{signal:AbortSignal.timeout(15000)});const data=await r.json();if(!r.ok)throw Error(data.error||'内容暂不可用');return data;}
async function readText(url){
  const r=await fetch(url,{signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('原件暂不可用，请确认已登录且有权查看。');
  if(/text\/html/i.test(r.headers.get('content-type')||''))throw Error('该文件没有返回有效的文本。');
  const stream=r.body.getReader(),parts=[];let size=0,truncated=false;
  try{while(true){const {done,value}=await stream.read();if(done)break;const remain=256*1024-size;parts.push(value.slice(0,remain));size+=Math.min(value.length,remain);if(value.length>remain||size>=256*1024){truncated=true;break;}}}finally{await stream.cancel();}
  const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}
  return {text:new TextDecoder().decode(bytes),truncated};
}
function render(data){
  current=data;document.title=data.title+' · Luokixi';$('#reader-title').textContent=data.title;
  const download=local(data.downloadUrl);if(download){$('#reader-download').href=download;$('#reader-download').hidden=false;$('#reader-download').textContent=data.mode==='markdown'||data.extracted?'下载文本':'下载原件';$('#reader-download').download=data.filename||data.title+(data.mode==='markdown'?'.md':'');}
  if(download?.startsWith('/api/hub/mirror/')){$('#reader-download').dataset.accelerate='';$('#reader-download').textContent='加速下载原件';}
  else delete $('#reader-download').dataset.accelerate;
  $('#reader-note').textContent=[data.note,data.truncated?'预览已截取；下载可取得完整原件。':''].filter(Boolean).join(' ');
  const preview=local(data.previewUrl);let html='';
  if(data.mode==='pdf'&&preview)html='<div class="reader-pdf-host"><p role="status">正在加载 PDF 阅读器…</p></div>';
  else if(data.mode==='image'&&preview)html=`<img class="reader-image" src="${esc(preview)}" alt="${esc(data.title)}">`;
  else if(['audio','video'].includes(data.mode)&&preview)html=`<${data.mode} controls preload="metadata" src="${esc(preview)}"></${data.mode}>`;
  else if(data.mode==='archive')html=`<div class="reader-archive"><aside><label for="reader-filter">包内文件 · ${data.fileCount||0}</label><input id="reader-filter" type="search" placeholder="查找文件名"><ul id="reader-files">${(data.files||[]).map(f=>`<li data-name="${esc(f.name.toLowerCase())}">${f.readable?`<button type="button" data-member="${esc(f.name)}">${esc(f.name)}</button>`:`<span>${esc(f.name)}</span>`}<small>${Math.ceil(f.bytes/1024)} KB</small></li>`).join('')}</ul></aside><section><p id="member-name" class="muted">选择 README、许可证或代码文件直接阅读。</p><pre id="member-content" tabindex="0"></pre></section></div>`;
  else if(data.mode==='markdown')html=`<article class="reader-prose" lang="zh-CN">${renderMarkdown(data.text||'')}</article>${data.originalText?`<details class="reader-original"><summary>中外文对照 · 展开来源原文</summary><div class="reader-prose">${renderMarkdown(data.originalText)}</div><a href="${esc(download+'?lang=original')}" download>下载原文文本</a></details>`:''}`;
  else if(data.mode==='text')html=`<pre class="reader-text" tabindex="0">${esc(data.text||'暂无可展示的文字。')}</pre>`;
  else html='<p class="reader-empty">本站保留了原件。此格式可以下载后使用对应的软件打开。</p>';
  $('#reader-content').innerHTML=html;$('#reader-content').setAttribute('aria-busy','false');
  $('#reader-print').hidden=!['markdown','text','image'].includes(data.mode);
  $('#reader-filter')?.addEventListener('input',event=>{for(const row of document.querySelectorAll('#reader-files li'))row.hidden=!row.dataset.name.includes(event.target.value.toLowerCase());});
  if(data.mode==='pdf'&&preview)import('../js/pdf-reader.js').then(({mountPDF})=>mountPDF($('.reader-pdf-host'),preview)).catch(()=>{$('.reader-pdf-host').textContent='阅读器暂时无法加载，仍可下载原件。';});
}
$('#reader-print').onclick=()=>window.print();
$('#reader-back').onclick=event=>{if(document.referrer&&new URL(document.referrer).origin===location.origin&&history.length>1){event.preventDefault();history.back();}};
$('#reader-content').addEventListener('click',async event=>{
  const button=event.target.closest('[data-member]');if(!button)return;
  const turn=++serial;$('#member-name').textContent='正在读取…';
  try{const data=await json(apiPath+'?'+new URLSearchParams({member:button.dataset.member}));if(turn!==serial)return;$('#member-name').textContent=data.member;$('#member-content').textContent=data.text;}
  catch(error){if(turn===serial)$('#member-name').textContent=error.message;}
});
async function load(){
  const kind=params.get('kind'),id=params.get('id');
  if(['upload','mirror','entry'].includes(kind)&&/^[a-f\d-]+$/i.test(id||'')){
    apiPath=`/api/hub/reader/${kind}/${id}`;return json(apiPath);
  }
  if(kind==='document'&&/^[\w-]+$/.test(id||'')){
    const d=await json('/api/document/'+encodeURIComponent(id)),url='/api/file/'+encodeURIComponent(id);
    return {title:d.title,filename:d.title+'.'+(d.format==='html'?'md':d.format),extracted:d.format==='html',mode:d.format==='pdf'?'pdf':d.format==='mp3'?'audio':'text',previewUrl:url,downloadUrl:url,
      text:d.body||d.chunks?.map(c=>c.text).join('\n\n')||'',note:[d.rights,d.format==='html'?'本站保存的提取文本，非原网页完整副本。':''].filter(Boolean).join(' ')};
  }
  const file=params.get('file'),target=readerTarget(file||'',location.href);
  if(!target?.file)throw Error('文件入口无效，请从资料、项目或帖子打开。');
  const ext=file.split('.').pop().toLowerCase(),name=params.get('name')||decodeURIComponent(file.split('/').pop());
  if(file.startsWith('/api/hub/illustration/'))return {title:params.get('name')||'文章主题封面',mode:'image',previewUrl:target.file,downloadUrl:target.file,filename:'文章主题封面.svg',note:'根据本文标题和来源生成的主题封面，非事件实拍。'};
  const mode=/^(png|jpe?g|webp|gif)$/.test(ext)?'image':ext==='pdf'?'pdf':/^(mp3|wav|ogg|m4a|flac)$/.test(ext)?'audio':/^(mp4|webm)$/.test(ext)?'video':/\/(?:text|json)$/.test(file)||/^(txt|md|json|csv|py|js|ts|yaml|yml)$/.test(ext)?'text':'download';
  return {title:name,mode,previewUrl:target.file,downloadUrl:target.file,...(mode==='text'?await readText(target.file):{})};
}
load().then(render).catch(error=>{$('#reader-title').textContent='暂时无法打开';$('#reader-note').textContent=error.message;$('#reader-content').setAttribute('aria-busy','false');});
