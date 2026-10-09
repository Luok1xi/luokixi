import { fuzzySearch } from '../js/fuzzy-search.js';
import { attachSearchSuggestions } from '../js/search-suggestions.js';
import { normalizeUniversityCatalogue, filterUniversityResources, universityCounts, selectionPayload, UNIVERSITY_PAGE_SIZE, BANK_PAGE_SIZE, COMPOSE_LIMIT, UNIVERSITY_KINDS, UNIVERSITY_PHASES } from '../js/university-catalogue.js';
import { initShell } from '../js/shell.js';
import { hubApi, hubState, loginURL } from '../js/hub.js';
import { esc } from '../js/data.js';
import gsap from 'gsap';
import '../styles/question-workshop.css';

initShell();
const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const stateNames = { queued:'等待识别',extracting:'正在识别',needs_review:'待核对',shelved:'已入私人架',failed:'识别未完成' };
let user=null, mode='local', capabilities={}, documents=[], papers=[], paper=null, timer=0, dirty=false, busy=false, sourceURL='', paperEpoch=0, schoolCourses=[], intakeCourse='';
const status=(message,error=false)=>{ $('#qw-status').textContent=message;$('#qw-status').classList.toggle('is-error',error); };
const active=()=>['queued','extracting'].includes(paper?.state);
const safeURL=(value)=>{ if(typeof value!=='string'||!value.trim())return '';try { const u=new URL(value,location.href);return ['http:','https:'].includes(u.protocol)?u.href:''; }catch{return '';} };
const animateIn=(node)=>{ if(!matchMedia('(prefers-reduced-motion: reduce)').matches)gsap.fromTo(node,{opacity:.25,y:12},{opacity:1,y:0,duration:.24,ease:'power2.out',overwrite:true,clearProps:'transform,opacity'}); };
function markDirty(){ dirty=true;$('#qw-dirty').textContent='有修改待保存'; }
function parsePages(value){
  const pages=new Set();
  for(const part of value.replaceAll('，',',').split(',').map(v=>v.trim()).filter(Boolean)){
    const m=part.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if(!m)throw new Error('页码请写成 1-3,5 这样的形式。');
    const first=Number(m[1]),last=Number(m[2]||m[1]);
    if(first<1||last<first||last-first>=12||last>1000)throw new Error('一次请选择 1–12 页，页码应从 1 开始。');
    for(let p=first;p<=last;p++)pages.add(p);
  }
  if(!pages.size||pages.size>12)throw new Error('一次请选择 1–12 页。');
  return [...pages].sort((a,b)=>a-b);
}
function changeMode(next){
  mode=next;
  document.querySelectorAll('[data-mode]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.mode===mode)));
  document.querySelectorAll('[data-source-panel]').forEach(p=>p.hidden=p.dataset.sourcePanel!==mode);
  $('#qw-pages-label').hidden=mode==='text';
}
document.querySelectorAll('[data-mode]').forEach(b=>b.addEventListener('click',()=>changeMode(b.dataset.mode)));
$('#qw-file').addEventListener('change',()=>{
  const f=$('#qw-file').files[0];$('#qw-file-name').textContent=f?.name||'';
  if(f&&/\.(png|jpe?g|webp)$/i.test(f.name))$('#qw-pages').value='1';
});
function setBusy(value){
  busy=value;$('#qw-start').disabled=value;$('#qw-save').disabled=value;
  for(const id of ['qw-create','qw-editor','qw-shelf','qw-sources','qw-university']){const node=$(`#${id}`);node.inert=value;node.setAttribute('aria-busy',String(value));}
}
function canLeave(){return !dirty||window.confirm('这份题册还有未保存的修改，确定离开吗？');}
async function loadDocuments(){
  if(!['127.0.0.1','localhost'].includes(location.hostname))return;
  try{
    const response=await fetch('/api/library/collections',{cache:'no-store',signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw new Error();
    const result=await response.json();
    documents=(result.collections||[]).flatMap(c=>(c.files||[]).map(f=>({...f,suiteTitle:c.title}))).filter(f=>/pdf|png|jpeg|jpg|webp|text/i.test(f.format||f.type||f.url||''));
    if(!documents.length){
      // Catalog fallback preserves verified document IDs when an older organizer is running.
      let offset=0,total=1;
      while(offset<total&&offset<500){const res=await fetch(`/api/catalogue?offset=${offset}`);if(!res.ok)break;const data=await res.json();documents.push(...(data.items||[]).filter(d=>d.format==='pdf'));total=data.total||0;offset+=30;}
    }
    const seen=new Set();documents=documents.filter(d=>!seen.has(d.id)&&seen.add(d.id));
    $('#qw-document').innerHTML='<option value="">选择一份原卷或讲义</option>'+documents.map(d=>`<option value="${esc(d.id)}">${esc(d.title||d.name||d.suiteTitle)}${d.kind?' · '+esc(d.kind):''}</option>`).join('');
    const selected=params.get('document');if(documents.some(d=>d.id===selected))$('#qw-document').value=selected;
  }catch{$('#qw-document').innerHTML='<option value="">本机资料暂不可用，可上传原稿</option>';}
}
$('#qw-create').addEventListener('submit',async event=>{
  event.preventDefault();if(busy)return;
  if(!user){location.href=loginURL();return;}
  setBusy(true);status('');
  try{
    const body={sourceKind:mode,pages:mode==='text'?[]:parsePages($('#qw-pages').value)};
    if(mode==='local'){
      const doc=documents.find(d=>d.id===$('#qw-document').value);if(!doc)throw new Error('先选择一份资料。');
      body.documentId=doc.id;body.title=doc.title||doc.name||doc.suiteTitle;body.course=doc.course||'';body.category=/cet[46]|[四六]级/.test(doc.groupKey||doc.group_key||doc.title||'')?'四六级':'课程练习';
    }else if(mode==='upload'){
      const file=$('#qw-file').files[0];if(!file)throw new Error('先选择图片、PDF 或文本原稿。');
      if(file.size>25*1024*1024)throw new Error('文件超过 25 MB，请先拆分。');
      status('正在把原件存入你的私人空间…');
      const upload=await hubApi.upload(file);body.uploadId=upload.id;body.title=file.name.replace(/\.[^.]+$/,'');
    }else{
      body.text=$('#qw-text').value.trim();if(!body.text)throw new Error('先粘贴题目原文。');
      body.title=body.text.split('\n').find(Boolean).slice(0,48)||'文字题稿';
    }
    if(intakeCourse&&mode!=='local'){body.course=intakeCourse;body.category='通识选修';}
    const result=await hubApi.request('question-papers',body);
    dirty=false;await openPaper(result);await loadShelf();status('原稿已保存，北矿娘正在本机整理。');
  }catch(error){status(error.message,true);}finally{setBusy(false);}
});
async function openPaper(value){
  clearTimeout(timer);const epoch=++paperEpoch;
  try{
    const result=typeof value==='string'?await hubApi.request(`question-papers/${encodeURIComponent(value)}`):value;
    if(epoch!==paperEpoch)return;
    paper=result;dirty=false;
    const u=new URL(location.href);u.searchParams.set('paper',paper.id);u.searchParams.delete('document');history.replaceState({},'',u);
    $('#qw-intake').hidden=true;$('#qw-working').hidden=!active();$('#qw-editor').hidden=active();
    $('#qw-dirty').textContent='已保存 · 仅本人可见';
    if(active()){
      $('#qw-progress').textContent=paper.state==='extracting'?'正在读取所选原页并识别文字。复杂页面可能需要一些时间。':'任务已排队，处理开始后会自动更新。';
      timer=setTimeout(()=>pollPaper(epoch),1800);
    }else{
      renderEditor();animateIn($('#qw-editor'));
      if(paper.state==='failed')status(paper.error||'这次识别没有完成，原稿仍已保留。',true);
    }
  }catch(error){status(error.message,true);}
}
async function pollPaper(epoch){
  if(epoch!==paperEpoch||!paper)return;
  if(document.hidden){timer=setTimeout(()=>pollPaper(epoch),3000);return;}
  try{
    const result=await hubApi.request(`question-papers/${encodeURIComponent(paper.id)}`);
    if(epoch!==paperEpoch)return;
    if(['queued','extracting'].includes(result.state)){
      paper=result;$('#qw-progress').textContent=result.state==='extracting'?'正在识别原页、切分题目并检查疑点…':'任务排队中，完成后会自动显示。';timer=setTimeout(()=>pollPaper(epoch),1800);
    }else{await openPaper(result);await loadShelf();status(result.state==='failed'?result.error:`已整理 ${result.questionCount} 道题。${result.state==='shelved'?'已放入私人架。':'请对照原稿核对标出的疑点。'}`,result.state==='failed');}
  }catch(error){status(error.message,true);timer=setTimeout(()=>pollPaper(epoch),5000);}
}
function renderEditor(){
  $('#qw-title').value=paper.title;$('#qw-course').value=paper.course;
  if(![...$('#qw-category').options].some(o=>o.value===paper.category))$('#qw-category').add(new Option(paper.category,paper.category));
  $('#qw-category').value=paper.category;
  $('#qw-coverage').checked=Boolean(paper.review?.sourceCoverageConfirmed||paper.sourceMeta?.sourceCoverageConfirmed);
  $('#qw-review-line').textContent=`${stateNames[paper.state]||paper.state} · ${paper.questions?.length||0} 道题 · ${paper.review?.blockingCount||0} 项待核对 · 答案未作学术验证`;
  const sourcePages=paper.selectedPages?.length?paper.selectedPages:(paper.extractedPages||[]).map(p=>p.page);
  $('#qw-source-page').innerHTML=[...new Set(sourcePages.length?sourcePages:[1])].map(p=>`<option value="${p}">${p}</option>`).join('');
  const textOnly=!['local','upload'].includes(paper.sourceKind)||/\.(txt|md)$/i.test(paper.sourceName);
  $('#qw-source-page').closest('label').hidden=textOnly;
  $('.qw-source-toolbar>strong').textContent=textOnly?'原文':'原稿';
  $('#qw-source-note').textContent=[...(paper.review?.issues||[]).map(i=>i.message),paper.sourceMeta?.attribution||''].filter(Boolean).join('\n');
  const rawUrl=paper.sourceKind==='local'&&paper.sourceDocumentId?`/api/file/${encodeURIComponent(paper.sourceDocumentId)}`:paper.sourceUploadId?`/api/hub/uploads/${encodeURIComponent(paper.sourceUploadId)}/file`:safeURL(paper.sourceMeta?.readerUrl||paper.sourceMeta?.sourceUrl||'');
  $('#qw-original').hidden=!rawUrl;if(rawUrl)$('#qw-original').href=rawUrl;
  const sources=Array.isArray(paper.sourceMeta?.sources)?paper.sourceMeta.sources:[];
  $('#qw-provenance').hidden=!sources.length;$('#qw-provenance-list').innerHTML=sourceListHTML(sources);
  renderQuestions();renderSource();renderPrint();renderStudy();setView('edit');
}
function sourceListHTML(sources,print=false){
  return sources.length?`<ul>${sources.map(s=>{const title=[s.schoolName,s.title||s.sourceTitle,s.license,s.attribution].filter(Boolean).join(' · '),url=safeURL(s.sourceUrl||s.url);return `<li>${esc(title||'来源资料')}${url?print?` · ${esc(url)}`:` · <a href="${esc(url)}" target="_blank" rel="noopener">原始出处 ↗</a>`:''}</li>`;}).join('')}</ul>`:'';
}
function questionCitation(q){
  return [q.source?.schoolName,q.source?.title||q.source?.sourceTitle||paper.sourceName||paper.title,q.source?.originalNumber?`原题 ${q.source.originalNumber}`:'',q.source?.pages?.length?'原稿 '+q.source.pages.join('、')+' 页':''].filter(Boolean).join(' · ');
}
function questionHTML(q,index){
  const source=q.source?.title||q.source?.sourceTitle?questionCitation(q):(q.source?.pages||[]).map(p=>`第 ${p} 页`).join('、')||(q.source?.method==='source-xml'?'教材原文':'手动题目');
  const confidence=Number.isFinite(q.confidence)?` · 识别 ${Math.round(q.confidence*100)}%`:'';
  return `<article class="qw-question" data-id="${esc(q.id)}"><header><b>${String(index+1).padStart(2,'0')}</b><span>${esc(source+confidence)}</span><div class="qw-question-tools"><button type="button" data-action="source" aria-label="查看第 ${index+1} 题原页">原页</button><button type="button" data-action="up" aria-label="上移第 ${index+1} 题" ${index===0?'disabled':''}>↑</button><button type="button" data-action="down" aria-label="下移第 ${index+1} 题" ${index===paper.questions.length-1?'disabled':''}>↓</button><button type="button" data-action="remove" aria-label="移除第 ${index+1} 题">移除</button></div></header>
    ${(q.issues||[]).length?`<ul class="qw-issues">${q.issues.map(i=>`<li>${esc(i.message)}</li>`).join('')}</ul>`:''}
    <label>题干<textarea data-field="stem" rows="4" maxlength="16000">${esc(q.stem||'')}</textarea></label>
    <label>选项 <small>每项一行，无选项可留空</small><textarea data-field="options" rows="${Math.max(2,Math.min(6,q.options?.length||0))}" maxlength="16000">${esc((q.options||[]).map(o=>`${o.label}. ${o.text}`).join('\n'))}</textarea></label>
    <details><summary>答案、解析与知识点${q.answer?'':' · 答案未知'}</summary><label>答案<textarea data-field="answer" rows="2" maxlength="8000">${esc(q.answer||'')}</textarea></label><label>解析<textarea data-field="explanation" rows="3" maxlength="16000">${esc(q.explanation||'')}</textarea></label><label>知识点 <small>每项一行</small><textarea data-field="knowledgePoints" rows="2" maxlength="4000">${esc((q.knowledgePoints||[]).join('\n'))}</textarea></label></details>
    <label class="qw-check"><input data-field="confirmed" type="checkbox" ${q.confirmed?'checked':''}>已对照原稿核对题干、选项与公式</label><label class="qw-check"><input data-field="allowUnknownAnswer" type="checkbox" ${q.allowUnknownAnswer?'checked':''}>没有答案时，按“答案未知”保留此题</label></article>`;
}
function renderQuestions(){
  $('#qw-questions').innerHTML=paper.questions?.length?paper.questions.map(questionHTML).join(''):'<p class="qw-small">没有可靠切分出题目。可对照左侧原稿，点击“补一道题”手动整理。</p>';
}
$('#qw-questions').addEventListener('input',event=>{
  const field=event.target.dataset.field;if(!field)return;
  const q=paper.questions.find(q=>q.id===event.target.closest('[data-id]').dataset.id);if(!q)return;
  if(field==='options')q.options=event.target.value.split('\n').filter(v=>v.trim()).map((v,i)=>{const m=v.match(/^\s*([A-Ha-h])[.．、:：)）]\s*(.*)$/);return {label:m?m[1].toUpperCase():String.fromCharCode(65+i),text:m?m[2]:v.trim()};});
  else if(field==='knowledgePoints')q.knowledgePoints=event.target.value.split('\n').map(v=>v.trim()).filter(Boolean);
  else q[field]=event.target.type==='checkbox'?event.target.checked:event.target.value;
  if(!['confirmed','allowUnknownAnswer'].includes(field)){q.confirmed=false;event.target.closest('[data-id]').querySelector('[data-field=confirmed]').checked=false;}
  markDirty();
});
$('#qw-questions').addEventListener('click',event=>{
  const button=event.target.closest('[data-action]');if(!button)return;
  const node=button.closest('[data-id]');const index=paper.questions.findIndex(q=>q.id===node.dataset.id);if(index<0)return;
  const action=button.dataset.action;
  if(action==='source'){
    const page=paper.questions[index].source?.pages?.[0];if(page){$('#qw-source-page').value=page;renderSource();if(innerWidth<601)$('#qw-source-page').scrollIntoView({block:'center'});}
    else {const url=safeURL(paper.questions[index].source?.sourceUrl);if(url)window.open(url,'_blank','noopener');}
    return;
  }
  if(action==='remove'){paper.questions.splice(index,1);}
  else {const next=index+(action==='up'?-1:1);if(next<0||next>=paper.questions.length)return;[paper.questions[index],paper.questions[next]]=[paper.questions[next],paper.questions[index]];}
  markDirty();renderQuestions();
});
$('#qw-add').addEventListener('click',()=>{
  if(!paper)return;
  paper.questions.push({id:`manual-${crypto.randomUUID()}`,number:String(paper.questions.length+1),stem:'',options:[],answer:'',explanation:'',knowledgePoints:[],type:'written',confirmed:false,allowUnknownAnswer:false,source:{pages:[],regions:[],method:'manual'},confidence:null,issues:[]});
  markDirty();renderQuestions();$('#qw-questions .qw-question:last-child textarea')?.focus();
});
for(const id of ['qw-title','qw-course','qw-category','qw-coverage'])$(`#${id}`).addEventListener('input',markDirty);
function renderSource(){
  if(!paper)return;
  const page=Number($('#qw-source-page').value||1);
  const extracted=paper.extractedPages?.find(p=>p.page===page);
  $('#qw-source-text').textContent=extracted?.text||paper.rawText||'此页没有可用文字，请对照原图。';
  const image=['local','upload'].includes(paper.sourceKind)&&!/\.(txt|md)$/i.test(paper.sourceName);
  $('#qw-source-image').hidden=!image;$('#qw-source-text').hidden=image;
  if(image){sourceURL=`/api/hub/question-papers/${encodeURIComponent(paper.id)}/source?page=${page}`;$('#qw-source-image').src=sourceURL;}
}
$('#qw-source-image').addEventListener('error',()=>{$('#qw-source-image').hidden=true;$('#qw-source-text').hidden=false;$('#qw-source-note').textContent='原图预览暂不可用，可打开原件核对。';});
$('#qw-source-page').addEventListener('change',renderSource);
$('#qw-save').addEventListener('click',async()=>{
  if(!paper||busy)return;setBusy(true);status('');
  try{
    const result=await hubApi.request(`question-papers/${encodeURIComponent(paper.id)}/save`,{revision:paper.revision,title:$('#qw-title').value,course:$('#qw-course').value,category:$('#qw-category').value,questions:paper.questions,confirmSourceCoverage:$('#qw-coverage').checked});
    paper=result;dirty=false;renderEditor();$('#qw-dirty').textContent='已保存 · 仅本人可见';status(result.state==='shelved'?'结构检查通过，已按课程归入你的私人架。答案仍保留来源状态。':'修改已保存，剩余疑点已标在题目旁。');await loadShelf();
  }catch(error){status(error.status===409?'这份题册已在其他页面更新。你的修改仍保留在这里，请先导出 JSON，再刷新核对。':error.message,true);}finally{setBusy(false);}
});
function setView(view){
  document.querySelectorAll('[data-view]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.view===view)));
  for(const key of ['edit','print','study'])$(`#qw-${key}-view`).hidden=view!==key;
  if(view==='print')renderPrint();if(view==='study')renderStudy();
}
document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>setView(b.dataset.view)));
function renderPrint(){
  if(!paper)return;
  const show=$('#qw-show-answer').checked;const node=$('#qw-print-paper');
  node.style.setProperty('--columns',$('#qw-columns').value);node.style.setProperty('--paper-font',`${$('#qw-font-size').value}pt`);
  node.innerHTML=`<h2>${esc($('#qw-title').value||paper.title)}</h2><p class="qw-print-meta">${esc($('#qw-course').value||'自用题册')} · ${paper.questions.length} 道题 · ${dirty?'未保存排版':'私人副本'}</p><div class="qw-print-items">${paper.questions.map((q,i)=>`<section class="qw-print-item"><p><b>${i+1}.</b> ${esc(q.stem)}</p>${q.options?.length?`<ol>${q.options.map(o=>`<li>${esc(o.label)}. ${esc(o.text)}</li>`).join('')}</ol>`:'<div class="qw-print-blank"></div>'}${show?`<div class="qw-print-answer"><p>答案：${esc(q.answer||'未知')}</p>${q.explanation?`<p>解析：${esc(q.explanation)}</p>`:''}<small>答案未经学术正确性验证</small></div>`:''}<div class="qw-print-citation">${esc(questionCitation(q))}${q.confirmed?'':' · 识别待核对'}</div></section>`).join('')}</div>${paper.sourceMeta?.attribution?`<p class="qw-print-citation">${esc(paper.sourceMeta.attribution)}</p>`:''}`;
  if(paper.sourceMeta?.license)node.insertAdjacentHTML('beforeend',`<p class="qw-print-citation">${esc([paper.sourceMeta.license,paper.sourceMeta.licenseUrl,paper.sourceMeta.sourceUrl,paper.sourceMeta.changes,'此副本在 Luokixi 中重新排版；题目可能含用户编辑。'].filter(Boolean).join(' · '))}</p>`);
  if(paper.sourceMeta?.sources?.length)node.insertAdjacentHTML('beforeend',`<div class="qw-print-citation"><strong>来源清单</strong>${sourceListHTML(paper.sourceMeta.sources,true)}</div>`);
}
for(const id of ['qw-columns','qw-font-size','qw-show-answer'])$(`#${id}`).addEventListener('change',renderPrint);
$('#qw-print').addEventListener('click',()=>{renderPrint();window.print();});
function renderStudy(){
  if(!paper)return;
  const rows=paper.questions.flatMap((q,i)=>(q.knowledgePoints||[]).map(point=>({point,q,i})));
  const terms=paper.sourceMeta?.keyTerms||[];
  $('#qw-study-view').innerHTML=rows.length||terms.length?`<p class="qw-small">来自这份题册已整理的知识点；是否属于考试重点，请以课程要求为准。</p>${rows.map(({point,q,i})=>`<article class="qw-study-item"><h3>${esc(point)}</h3>${q.explanation?`<p>${esc(q.explanation)}</p>`:''}<small>第 ${i+1} 题 · ${q.source?.pages?.length?'原稿 '+q.source.pages.join('、')+' 页':'手动整理'} · ${q.confirmed?'已对照原稿':'待核对'}</small></article>`).join('')}${terms.map(t=>`<article class="qw-study-item"><h3>${esc(t.term)}</h3><p>${esc(t.definition)}</p><small>教材原文术语 · ${safeURL(t.sourceUrl)?`<a href="${esc(safeURL(t.sourceUrl))}" target="_blank" rel="noopener">来源 ↗</a>`:''}</small></article>`).join('')}`:'<p class="qw-small">还没有提取或填写知识点。可在题目中的“答案、解析与知识点”里整理；这里不会凭空生成必考重点。</p>';
}
$('#qw-export-text').addEventListener('click',()=>{
  if(!paper)return;
  const lines = ['# '+($('#qw-title').value || paper.title), '', '课程：'+$('#qw-course').value, '', dirty ? '包含尚未保存的编辑。' : '私人学习副本。', ''];
  paper.questions.forEach((q,i)=>{
    lines.push('## '+(i+1)+'. '+q.stem, '');
    for(const o of q.options || [])lines.push(o.label+'. '+o.text);
    lines.push('', '答案：'+(q.answer || '待补充'));
    if(q.explanation)lines.push('解析：'+q.explanation);
    lines.push(questionCitation(q), '');
  });
  const url=URL.createObjectURL(new Blob([lines.join('\n')],{type:'text/markdown;charset=utf-8'}));
  const link=document.createElement('a');link.href=url;link.download=(paper.title || '题册').replace(/[<>:"/\\|?*]/g,'_')+'.md';link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
});
$('#qw-export').addEventListener('click',()=>{
  if(!paper)return;
  const payload={schemaVersion:1,...paper,title:$('#qw-title').value,course:$('#qw-course').value,category:$('#qw-category').value,exportedAt:new Date().toISOString(),unsavedChanges:dirty};
  const url=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:'application/json;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=(payload.title||'题册').replace(/[<>:"/\\|?*]/g,'_')+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
function newSource(){
  if(!canLeave())return;clearTimeout(timer);paperEpoch++;paper=null;dirty=false;$('#qw-editor').hidden=true;$('#qw-working').hidden=true;$('#qw-intake').hidden=false;
  const u=new URL(location.href);u.searchParams.delete('paper');history.replaceState({},'',u);status('');$('#qw-intake').scrollIntoView({block:'start'});
}
$('#qw-new').addEventListener('click',newSource);$('#qw-working-back').addEventListener('click',newSource);
async function loadShelf(){
  if(!user)return;
  try{const result=await hubApi.request('question-papers');papers=result.papers||[];renderShelf();}catch(error){status(error.message,true);}
}
function renderShelf(){
  const term=$('#qw-shelf-filter').value.trim();const rows=fuzzySearch(papers,term,{getText:p=>[p.course,p.category].join(' '),limit:Infinity});
  $('#qw-papers').innerHTML=rows.length?rows.map(p=>`<button class="qw-shelf-row" data-paper="${esc(p.id)}" type="button"><i aria-hidden="true"></i><span><strong>${esc(p.title)}</strong><small>${esc([p.course||'未分课程',p.category,`${p.questionCount} 道题`].join(' / '))}</small></span><span>${esc(stateNames[p.state]||p.state)} ↗</span></button>`).join(''):`<p class="qw-small">${term?'没有匹配的题册。':'这里会保存你整理过的题册。'}</p>`;
}
attachSearchSuggestions($('#qw-shelf-filter'), { getItems:()=>papers, getText:p=>[p.course,p.category].join(' '), getMeta:p=>[p.course,p.category].filter(Boolean).join(' · '), onSelect:()=>renderShelf() });
$('#qw-shelf-filter').addEventListener('input',event=>{if(!event.isComposing)renderShelf();});
$('#qw-shelf-filter').addEventListener('compositionend',renderShelf);
$('#qw-papers').addEventListener('click',event=>{const b=event.target.closest('[data-paper]');if(b&&canLeave())openPaper(b.dataset.paper);});

// Public catalogue reads never start a crawl. Expensive extraction stays in the worker.
const university = { data:normalizeUniversityCatalogue(), group:'all', page:0, rows:[], loading:false, request:0, filterTimer:0, selections:new Map(), banks:new Map(), bank:null, bankPage:0, bankRequest:0, bankController:null };
const selectionKey='luokixi.question-selection.v1';
try {
  const saved=JSON.parse(sessionStorage.getItem(selectionKey)||'null');
  if(saved?.expires>Date.now()&&Array.isArray(saved.items))for(const row of saved.items.slice(0,COMPOSE_LIMIT)){
    if(typeof row.bankId!=='string'||typeof row.questionId!=='string'||row.bankId.length>160||row.questionId.length>160)continue;
    if(!university.selections.has(row.bankId))university.selections.set(row.bankId,new Set());
    university.selections.get(row.bankId).add(row.questionId);
  }
}catch{/* Session storage is optional, and contains public identifiers only. */}
const universityText=(row)=>row.searchText;
const shortDate=(value)=>{const date=new Date(value);return Number.isNaN(date.getTime())?'':date.toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});};
function universityFilters(){return {group:university.group,...Object.fromEntries(['school','course','year','kind','phase'].map(key=>[key,$(`#qw-university-${key}`).value]))};}
function universityCandidates(){return filterUniversityResources(university.data.resources,universityFilters());}
function catalogueOptions(id,values,defaultLabel){
  const node=$(`#qw-university-${id}`),previous=node.value;
  node.innerHTML=`<option value="">${defaultLabel}</option>`+values.map(([value,label])=>`<option value="${esc(value)}">${esc(label)}</option>`).join('');
  if(values.some(([value])=>value===previous))node.value=previous;
}
function renderUniversityFilters(){
  const group=university.group;
  catalogueOptions('school',university.data.schools.filter(s=>group==='all'||s.groups.includes(group)).map(s=>[s.id,s.name]),'全部学校');
  const base=filterUniversityResources(university.data.resources,{group,school:$('#qw-university-school').value});
  const courses=[...new Set(base.map(r=>r.course).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'zh-CN')).map(c=>[c,c]);
  if(base.some(r=>!r.course))courses.push(['__unknown','课程待核实']);
  catalogueOptions('course',courses,'全部课程');
  const years=[...new Set(base.map(r=>r.year).filter(Boolean))].sort((a,b)=>Number(b)-Number(a)).map(y=>[y,y]);
  if(base.some(r=>!r.year))years.push(['__unknown','年份未标明']);
  catalogueOptions('year',years,'全部年份');
}
function renderUniversityRows(resetPage=false){
  if(resetPage)university.page=0;
  university.rows=fuzzySearch(universityCandidates(),$('#qw-university-q').value.trim(),{getText:universityText,limit:Infinity});
  const counts=universityCounts(university.rows),pages=Math.ceil(university.rows.length/UNIVERSITY_PAGE_SIZE);
  university.page=Math.max(0,Math.min(university.page,pages-1));
  $('#qw-university-summary').textContent=`${counts.schools} 所院校 · ${counts.resources} 份目录资料 · ${counts.originals} 份有原件 · ${counts.questions} 道可选题`;
  const rows=university.rows.slice(university.page*UNIVERSITY_PAGE_SIZE,(university.page+1)*UNIVERSITY_PAGE_SIZE);
  $('#qw-university-results').innerHTML=rows.length?rows.map(row=>{
    const link=safeURL(row.url||row.sourceUrl),checked=shortDate(row.checkedAt);
    const evidence=row.evidence.filter(e=>e&&e.field&&e.matched).slice(0,8);
    const failure=row.sourceFailure||(row.sourceStatus==='failed'?'最近检查未完成；保留上次索引。':'');
    return `<article class="qw-university-row"><span class="qw-university-spine" aria-hidden="true">${esc(row.format?.toUpperCase()||'DOC')}</span><div class="qw-university-body"><div class="qw-university-meta"><span>${esc(row.schoolName)}</span><span>${esc(row.course||'课程待核实')}</span><span>${esc(row.year||'年份未标明')}</span></div><h3>${esc(row.title)}</h3><p>${esc([UNIVERSITY_KINDS[row.kind],row.sourceName,checked?'检查 '+checked:'尚无检查时间'].filter(Boolean).join(' / '))}</p>${failure?`<p class="qw-university-failure">${esc(typeof failure==='string'?failure:'最近检查未完成')}</p>`:''}${evidence.length?`<details><summary>归类依据</summary><ul>${evidence.map(e=>`<li>${esc(({course:'课程',kind:'资料类型',year:'年份',college:'院系',term:'学期'})[e.field]||e.field)}：${esc(String(e.value||e.matched))} · ${esc(e.origin==='path'?'文件路径':e.origin==='filename'?'文件名':e.origin||'来源元数据')}${typeof e.confidence==='number'?` · ${Math.round(e.confidence*100)}%`:''}</li>`).join('')}</ul></details>`:''}</div><div class="qw-university-actions"><span class="qw-university-phase" data-phase="${esc(row.phase)}">${esc(UNIVERSITY_PHASES[row.phase])}${row.bankId?` · ${row.questionCount} 题`:''}</span>${row.bankId?`<button type="button" class="qw-plain" data-university-bank="${esc(row.bankId)}">选择题目 ↗</button>`:''}${link?`<a href="${esc(link)}" target="_blank" rel="noopener">${row.bankId?'查看出处':'查看原文'} ↗</a>`:'<small>来源链接待补充</small>'}</div></article>`;
  }).join(''):`<div class="qw-university-empty"><p>${university.data.resources.length?'当前条件下没有匹配资料。':'跨校目录还没有收录资料。'}</p><small>${university.data.resources.length?'试试课程简称，或重置学校与年份筛选。':'有原始文件和结构化题目后，会分别显示真实数量。'}</small>${university.data.resources.length?'<button type="button" class="qw-plain" data-university-reset>重置筛选 ↗</button>':''}</div>`;
  $('#qw-university-page').textContent=pages?`${university.page+1} / ${pages}`:'0 / 0';
  $('#qw-university-prev').disabled=university.page===0;
  $('#qw-university-next').disabled=!pages||university.page>=pages-1;
}
async function loadUniversity(){
  if(university.loading)return;university.loading=true;const request=++university.request;
  $('#qw-university-results').setAttribute('aria-busy','true');$('#qw-university-reload').disabled=true;
  $('#qw-university-summary').textContent=university.data.resources.length?'正在检查目录更新…':'正在读取来源目录…';
  try{
    const response=await fetch('/api/library/university-sources',{cache:'no-cache',signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error(response.status===404?'跨校来源服务尚未连接。':'来源目录读取失败，请稍后重试。');
    const raw=await response.json();if(request!==university.request)return;
    university.data=normalizeUniversityCatalogue(raw);university.banks.clear();
    let removedSelections=0;
    for(const [id,ids] of university.selections)if(!university.data.bankMap.has(id)){removedSelections+=ids.size;university.selections.delete(id);}
    if(removedSelections)status(`${removedSelections} 道先前选题的来源已不在当前目录中，请重新选择。`);
    const updated=shortDate(university.data.generatedAt);
    const failed=university.data.failures.length;
    $('#qw-university-note').textContent=[updated?`目录更新 ${updated}`:'本机来源目录',`${university.data.schools.length} 所院校已列入来源范围`,failed?`${failed} 项采集未完成，已收录内容仍可查找`:'', '“已取正文”仍需识题；只有可选题项目能组成题册。'].filter(Boolean).join(' · ');
    $('#qw-university-failures').hidden=!failed;
    $('#qw-university-failures>ul').innerHTML=university.data.failures.slice(0,12).map(f=>{const source=university.data.sources.find(s=>s.id===f.sourceId);const message=typeof f==='string'?f:f.message||f.reason||f.error||'本次检查未完成';return `<li>${esc([source?.name,typeof message==='string'?message:'本次检查未完成'].filter(Boolean).join(' · '))}</li>`;}).join('')+(failed>12?`<li>另有 ${failed-12} 项；已取得的目录仍可使用。</li>`:'');
    renderUniversityFilters();renderUniversityRows();renderCompose();
  }catch(error){
    if(request!==university.request)return;
    $('#qw-university-summary').textContent=error.name==='TimeoutError'?'来源目录响应超时。':error.message;
    if(!university.data.resources.length)$('#qw-university-results').innerHTML='<div class="qw-university-empty"><p>目录暂不可用</p><small>私人题册和上传识题仍可继续使用。</small><button class="qw-plain" type="button" data-university-retry>重新读取 ↻</button></div>';
    else $('#qw-university-note').textContent='暂未取得更新，下面保留本次打开时的目录。';
  }finally{if(request===university.request){university.loading=false;$('#qw-university-reload').disabled=false;$('#qw-university-results').setAttribute('aria-busy','false');}}
}
function resetUniversity(){
  clearTimeout(university.filterTimer);$('#qw-university-q').value='';university.group='all';
  document.querySelectorAll('[data-university-group]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.universityGroup==='all')));
  for(const key of ['school','course','year','kind','phase'])$(`#qw-university-${key}`).value='';
  renderUniversityFilters();renderUniversityRows(true);
}
attachSearchSuggestions($('#qw-university-q'),{getItems:universityCandidates,getText:universityText,getMeta:r=>[r.schoolName,r.course,UNIVERSITY_KINDS[r.kind]].filter(Boolean).join(' · '),onSelect:()=>{clearTimeout(university.filterTimer);renderUniversityRows(true);}});
$('#qw-university-q').addEventListener('input',event=>{if(event.isComposing)return;clearTimeout(university.filterTimer);university.filterTimer=setTimeout(()=>renderUniversityRows(true),120);});
$('#qw-university-q').addEventListener('compositionend',()=>{clearTimeout(university.filterTimer);renderUniversityRows(true);});
$('#qw-university-search').addEventListener('submit',event=>{event.preventDefault();clearTimeout(university.filterTimer);renderUniversityRows(true);});
$('#qw-university-reload').addEventListener('click',loadUniversity);$('#qw-university-clear').addEventListener('click',resetUniversity);
document.querySelectorAll('[data-university-group]').forEach(button=>button.addEventListener('click',()=>{university.group=button.dataset.universityGroup;document.querySelectorAll('[data-university-group]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));renderUniversityFilters();renderUniversityRows(true);}));
for(const key of ['school','course','year','kind','phase'])$(`#qw-university-${key}`).addEventListener('change',()=>{if(key==='school')renderUniversityFilters();renderUniversityRows(true);});
for(const [id,delta] of [['prev',-1],['next',1]])$(`#qw-university-${id}`).addEventListener('click',()=>{university.page+=delta;renderUniversityRows();$('#qw-university-summary').scrollIntoView({block:'nearest'});});
$('#qw-university-results').addEventListener('click',event=>{const bank=event.target.closest('[data-university-bank]');if(bank)openUniversityBank(bank.dataset.universityBank);if(event.target.closest('[data-university-retry]'))loadUniversity();if(event.target.closest('[data-university-reset]'))resetUniversity();});

function renderCompose(){
  const selected=selectionPayload(university.selections),count=selected.questionIds.length;
  $('#qw-compose').hidden=!count;$('#qw-compose-count').textContent=`${count} 道题 · ${selected.bankIds.length} 份来源`;
  $('#qw-compose-submit').textContent=user?'组成私人题册 ↗':'登录后组卷 ↗';
  try{if(count)sessionStorage.setItem(selectionKey,JSON.stringify({items:selected.questionIds,expires:Date.now()+86400000}));else sessionStorage.removeItem(selectionKey);}catch{/* Optional session continuity across sign-in. */}
  if(university.bank)$('#qw-bank-selected').textContent=`本份已选 ${university.selections.get(university.bank.id)?.size||0} 题 · 共 ${count} / ${COMPOSE_LIMIT} 题`;
}
function renderBankQuestions(){
  const bank=university.bank;if(!bank)return;
  const pages=Math.ceil(bank.questions.length/BANK_PAGE_SIZE);
  university.bankPage=Math.max(0,Math.min(university.bankPage,pages-1));
  const selected=university.selections.get(bank.id)||new Set();
  $('#qw-bank-title').textContent=bank.title||'来源题目';
  $('#qw-bank-note').textContent=[bank.schoolName,bank.course,`${bank.questions.length} 道结构化题目`,bank.license,'答案状态与出处保留，入架后可继续核对。'].filter(Boolean).join(' · ');
  $('#qw-bank-questions').innerHTML=bank.questions.slice(university.bankPage*BANK_PAGE_SIZE,(university.bankPage+1)*BANK_PAGE_SIZE).map((q,index)=>`<label class="qw-bank-question"><input type="checkbox" data-bank-question="${esc(q.id)}" ${selected.has(q.id)?'checked':''}><span><small>${university.bankPage*BANK_PAGE_SIZE+index+1} / ${esc(({choice:'选择题','multiple-choice':'选择题',written:'问答题',fill:'填空题',judgement:'判断题'})[q.type]||'题目')} · ${esc(q.answerStatus==='provided'?'附来源答案，待核对':q.answerStatus==='unknown'?'答案未知':'答案状态待核对')}</small><strong>${esc((q.stem||'题干待核对').slice(0,1400))}</strong>${q.stem?.length>1400?'<small>较长题干在私人题册中显示全文。</small>':''}${Array.isArray(q.options)&&q.options.length?`<span class="qw-bank-options">${q.options.slice(0,8).map(o=>`${esc(o.label)}. ${esc(String(o.text||'').slice(0,240))}`).join('<br>')}</span>`:''}</span></label>`).join('')||'<p class="qw-small">这份来源还没有可选择的结构化题目。</p>';
  $('#qw-bank-page').textContent=pages?`${university.bankPage+1} / ${pages}`:'0 / 0';
  $('#qw-bank-prev').disabled=university.bankPage===0;$('#qw-bank-next').disabled=!pages||university.bankPage>=pages-1;
  for(const id of ['all','none','import'])$(`#qw-bank-${id}`).disabled=!bank.questions.length;
  $('#qw-bank-all').textContent=`选择整份 · ${bank.questions.length} 题`;
  renderCompose();
}
async function openUniversityBank(bankId){
  university.bankController?.abort();const ticket=++university.bankRequest;university.bank=null;university.bankPage=0;
  $('#qw-bank-title').textContent='读取题目';$('#qw-bank-note').textContent='正在读取这份来源已整理的题目…';$('#qw-bank-questions').replaceChildren();$('#qw-bank-selected').textContent='';$('#qw-bank-page').textContent='0 / 0';
  for(const id of ['all','none','import','prev','next'])$(`#qw-bank-${id}`).disabled=true;
  const dialog=$('#qw-bank-dialog');if(!dialog.open)dialog.showModal();
  try{
    let bank=university.banks.get(bankId);
    if(!bank){
      const controller=new AbortController();university.bankController=controller;
      const timeout=setTimeout(()=>controller.abort(),15000);
      let result;try{const response=await fetch(`/api/library/university-sources/banks/${encodeURIComponent(bankId)}`,{signal:controller.signal,cache:'no-cache'});if(!response.ok)throw new Error(response.status===404?'这份题目已更新或不再提供，请刷新来源目录。':'暂时无法读取题目，请重试。');result=await response.json();}finally{clearTimeout(timeout);}
      bank=result.bank;
      if(!bank||bank.id!==bankId||!Array.isArray(bank.questions))throw new Error('题目目录格式不完整，请刷新后重试。');
      const seen=new Set();bank={...bank,questions:bank.questions.filter(q=>q&&typeof q.id==='string'&&!seen.has(q.id)&&seen.add(q.id))};
      if(university.banks.size>=6)university.banks.delete(university.banks.keys().next().value);
      university.banks.set(bankId,bank);
    }
    if(ticket!==university.bankRequest||!dialog.open)return;
    const previous=university.selections.get(bank.id);
    if(previous){const ids=new Set(bank.questions.map(q=>q.id));const current=new Set([...previous].filter(id=>ids.has(id)));if(current.size)university.selections.set(bank.id,current);else university.selections.delete(bank.id);}
    university.bank=bank;renderBankQuestions();
  }catch(error){if(ticket!==university.bankRequest||!dialog.open)return;$('#qw-bank-title').textContent='题目暂不可用';$('#qw-bank-note').textContent=error.name==='AbortError'?'题目读取超时，请重试。':error.message;$('#qw-bank-questions').innerHTML=`<button type="button" class="qw-plain" data-bank-retry="${esc(bankId)}">重新读取 ↻</button>`;}
}
function closeUniversityBank(){university.bankRequest++;university.bankController?.abort();$('#qw-bank-dialog').close();}
$('#qw-bank-close').addEventListener('click',closeUniversityBank);$('#qw-bank-done').addEventListener('click',closeUniversityBank);
$('#qw-bank-dialog').addEventListener('cancel',()=>{university.bankRequest++;university.bankController?.abort();});
$('#qw-bank-questions').addEventListener('click',event=>{const retry=event.target.closest('[data-bank-retry]');if(retry)openUniversityBank(retry.dataset.bankRetry);});
$('#qw-bank-questions').addEventListener('change',event=>{
  const input=event.target.closest('[data-bank-question]'),bank=university.bank;if(!input||!bank)return;
  const selected=university.selections.get(bank.id)||new Set();
  if(input.checked){if(selectionPayload(university.selections).questionIds.length>=COMPOSE_LIMIT){input.checked=false;$('#qw-bank-note').textContent=`每份题册最多 ${COMPOSE_LIMIT} 道题，请先取消部分选题。`;return;}selected.add(input.dataset.bankQuestion);}else selected.delete(input.dataset.bankQuestion);
  if(selected.size)university.selections.set(bank.id,selected);else university.selections.delete(bank.id);renderCompose();
});
$('#qw-bank-all').addEventListener('click',()=>{
  const bank=university.bank;if(!bank)return;
  const rest=selectionPayload(university.selections).questionIds.length-(university.selections.get(bank.id)?.size||0);
  if(rest+bank.questions.length>COMPOSE_LIMIT){$('#qw-bank-note').textContent=`选择整份会超过 ${COMPOSE_LIMIT} 题，请逐题选择，或先取消其他来源。`;return;}
  university.selections.set(bank.id,new Set(bank.questions.map(q=>q.id)));renderBankQuestions();
});
$('#qw-bank-none').addEventListener('click',()=>{if(university.bank)university.selections.delete(university.bank.id);renderBankQuestions();});
for(const [id,delta] of [['prev',-1],['next',1]])$(`#qw-bank-${id}`).addEventListener('click',()=>{university.bankPage+=delta;renderBankQuestions();$('#qw-bank-questions').scrollTop=0;});
$('#qw-compose-clear').addEventListener('click',()=>{university.selections.clear();renderCompose();});
$('#qw-compose').addEventListener('submit',async event=>{
  event.preventDefault();if(busy)return;if(!user){location.href=loginURL();return;}if(!canLeave())return;
  const selection=selectionPayload(university.selections);if(!selection.questionIds.length)return;
  const title=$('#qw-compose-title').value.trim()||'跨校练习题册';setBusy(true);
  try{const result=await hubApi.request('question-papers/compose',{title,...selection});university.selections.clear();renderCompose();await openPaper(result);await loadShelf();$('#qw-editor').scrollIntoView({block:'start'});status('已组成私人题册，每题原始出处与来源清单均已保留。');}catch(error){status(error.message,true);}finally{setBusy(false);}
});
$('#qw-bank-import').addEventListener('click',async()=>{
  const bank=university.bank;if(!bank||busy)return;if(!user){location.href=loginURL();return;}if(!canLeave())return;
  if(bank.questions.length>COMPOSE_LIMIT){$('#qw-bank-note').textContent=`每份题册最多 ${COMPOSE_LIMIT} 道题，请先选题后组卷。`;return;}
  const button=$('#qw-bank-import');button.disabled=true;setBusy(true);
  try{const result=await hubApi.request('question-papers/import-university',{bankId:bank.id});closeUniversityBank();await openPaper(result);await loadShelf();$('#qw-editor').scrollIntoView({block:'start'});status('整份已存入私人题架，来源和答案状态已保留。');}catch(error){$('#qw-bank-note').textContent=error.message;}finally{button.disabled=false;setBusy(false);}
});

async function loadSources(){
  if(!['127.0.0.1','localhost'].includes(location.hostname)){$('#qw-sources').hidden=true;return;}
  try{
    const res=await fetch('/api/library/sources',{cache:'no-store',signal:AbortSignal.timeout(10000)});if(!res.ok)throw new Error();const data=await res.json();
    const sources=(data.sources||[]).filter(s=>safeURL(s.url));
    schoolCourses=data.schoolCourseCandidates||[];
    const labels={'school-official-notice':'学校官方通知','external-open-textbook':'开放教材 · 非校内题库','competition-link-only':'竞赛官方原文'};
    $('#qw-source-links').innerHTML=(schoolCourses.length?`<details class="qw-course-catalog"><summary>本学期通识选修 <span>${schoolCourses.length} 门 · 官方目录</span></summary><p class="qw-small">以下为学校公开课程目录。平台内课件与题库尚未收录，可选择课程整理自己的资料。</p><div class="qw-course-list">${schoolCourses.map(c=>`<article><div><h3>${esc(c.name)}</h3><small>${esc([c.officialCode,c.teacher,c.academicYear,c.term].filter(Boolean).join(' / '))}</small>${c.intro?`<details><summary>课程简介</summary><p>${esc(c.intro)}</p>${safeURL(c.introSourceUrl)?`<a href="${esc(safeURL(c.introSourceUrl))}" target="_blank" rel="noopener">简介出处 ↗</a>`:''}</details>`:''}${safeURL(c.sourceUrl)?`<a href="${esc(safeURL(c.sourceUrl))}" target="_blank" rel="noopener">目录原件 ↗</a>`:''}</div><button type="button" data-course-intake="${esc(c.id)}">整理资料 ↗</button></article>`).join('')}</div></details>`:'')+(sources.length?sources.map(s=>`<article class="qw-source-link"><div><h3>${esc(s.title)}</h3><p>${esc([labels[s.scope]||'外部资料来源',s.license,s.status==='failed'?'最近采集未完成':'',s.checkedAt?'核对 '+s.checkedAt.slice(0,10):''].filter(Boolean).join(' · '))}</p>${(s.items||[]).slice(0,4).map(i=>safeURL(i.url)?`<p><a href="${esc(safeURL(i.url))}" target="_blank" rel="noopener">${esc(i.title)} ↗</a></p>`:'').join('')}</div><a href="${esc(safeURL(s.url))}" target="_blank" rel="noopener">查看来源 ↗</a></article>`).join(''):'<p class="qw-small">尚无核对过的来源。通识课将以教务公开目录与实际收录资料为准。</p>')+(data.questionBanks||[]).map(bank=>`<article class="qw-source-link"><div><h3>${esc(bank.title)}</h3><p>${bank.questions?.length||0} 道题 · ${bank.keyTerms?.length||0} 个术语 · 英文原文 · 非校内题库</p><p>${esc(bank.license)}</p></div><button class="qw-solid" type="button" data-import-bank="${esc(bank.id)}">整理到我的题架 ↗</button></article>`).join('');
    const catalog=data.schoolCourseCatalog;
    if(catalog){
      const heading=$('.qw-course-catalog>summary>span');if(heading)heading.textContent=`已核实 ${schoolCourses.length} 门${catalog.announcedCourseCount?` / 公布 ${catalog.announcedCourseCount} 门`:''}`;
      const notice=$('.qw-course-catalog>.qw-small');if(notice&&catalog.state==='verification-required')notice.textContent='官方目录附件需要在学校页面完成验证码，完整名单尚未取得。以下仅列出通知中已确认的课程；平台内课件与题库尚未收录。';
      if(notice&&catalog.attachments?.length)notice.insertAdjacentHTML('afterend',`<p class="qw-small">${catalog.attachments.filter(a=>safeURL(a.url)).map(a=>`<a href="${esc(safeURL(a.url))}" target="_blank" rel="noopener">${a.kind==='catalogue'?'官方完整目录':'官方课程简介'} ↗</a>`).join('　')}</p>`);
      document.querySelectorAll('.qw-course-list>article>div>a').forEach(a=>{a.textContent='官方出处 ↗';});
    }
  }catch{$('#qw-source-links').innerHTML='<p class="qw-small">来源目录暂不可用，已保存的题册仍可使用。</p>';}
}
$('#qw-source-links').addEventListener('click',async event=>{
  const courseButton=event.target.closest('[data-course-intake]');
  if(courseButton){
    const course=schoolCourses.find(c=>c.id===courseButton.dataset.courseIntake);if(!course||!canLeave())return;
    dirty=false;newSource();intakeCourse=course.name;$('#qw-selected-course').hidden=false;$('#qw-selected-course').textContent=`正在整理：${course.name}`;changeMode('upload');return;
  }
  const button=event.target.closest('[data-import-bank]');if(!button)return;
  if(!user){location.href=loginURL();return;}if(!canLeave())return;button.disabled=true;
  try{const result=await hubApi.request('question-papers/import-source',{bankId:button.dataset.importBank});await openPaper(result);await loadShelf();$('#qw-editor').scrollIntoView({block:'start'});status('已按来源整理进你的私人题架；原文许可、答案状态和术语均已保留。');}catch(error){status(error.message,true);}finally{button.disabled=false;}
});
window.addEventListener('beforeunload',event=>{if(dirty){event.preventDefault();event.returnValue='';}});
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&active()){clearTimeout(timer);pollPaper(paperEpoch);}});
async function boot(){
  $('#qw-login').href=loginURL();
  const outcomes=await Promise.allSettled([loadDocuments(),loadSources(),loadUniversity(),(async()=>{
    const session=await hubState();user=session.user;$('#qw-auth').hidden=Boolean(user);$('#qw-start').textContent=user?'交给北矿娘 ↗':'登录后整理 ↗';renderCompose();
    if(session.online){capabilities=await hubApi.request('question-papers/capabilities');$('#qw-capability').textContent=capabilities.imageOcr?'本机 OCR · 原稿留存':'文字整理可用 · 图片 OCR 未就绪';
      if(capabilities.localRequiresStaff&&user&&!user.moderator){$('#qw-local-note').textContent='本机公共原件由维护者整理；你可以上传自己的图片或 PDF。';changeMode('upload');}
      await loadShelf();if(user&&params.get('paper'))await openPaper(params.get('paper'));
    }else{$('#qw-capability').textContent='识题服务尚未连接';$('#qw-start').disabled=true;status('当前可以浏览资料。识题与私人保存需要连接本机服务。');}
  })()]);
  const failed=outcomes.find(item=>item.status==='rejected');
  if(failed){$('#qw-capability').textContent='识题服务暂不可用';$('#qw-start').disabled=true;status(failed.reason?.message||'识题服务暂不可用，请稍后刷新。',true);}
}
boot().catch(error=>status(error.message,true));
