import { initShell } from '../js/shell.js';
import { campusApi as api, campusAvailable } from '../../campus/client.js';
import '../styles/knowledge.css';

initShell();
const $ = selector => document.querySelector(selector);
const e = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const url = value => { try { const u = new URL(value); return /^https?:$/.test(u.protocol) ? u.href : ''; } catch { return ''; } };
const date = value => new Date(value).toLocaleDateString('zh-CN');
let mode='local', offset=0, meta, currentDoc, sequence=0, polling, toastTimer;
const tag = value => `<span class="tag">${e(value)}</span>`;
function toast(message) { const node=$('#kb-toast');node.textContent=message;node.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>node.hidden=true,6000); }
function showError(error) { toast(error.message || String(error)); }
function empty(title, detail) { return `<div class="kb-empty"><strong>${e(title)}</strong>${e(detail)}</div>`; }
async function refreshMeta() {
  meta=await api.meta();
  $('#connection').textContent='本机知识库已连接。资料、摘录与复习记录保存在这台电脑。';
  $('#summary').innerHTML=`<span><strong>${meta.documents}</strong> 份资料</span><span><strong>${meta.scopes['本校资料']||0}</strong> 份本校资料</span><span><strong>${meta.pages}</strong> 页原卷与正文</span><span>课程可持续添加</span>`;
  $('#pending-count').textContent=meta.pending||'';$('#due-count').textContent=meta.due||'';
  const selected=$('#course-filter').value;
  $('#course-filter').innerHTML='<option value="">全部课程</option>'+meta.courses.map(c=>`<option value="${e(c.name)}">${e(c.name)}（${c.count}）</option>`).join('');
  $('#course-filter').value=selected;
  $('#course-names').innerHTML=meta.courses.map(c=>`<option value="${e(c.name)}"></option>`).join('');
}
function documentRow(d) {
  return `<article class="kb-item"><div class="kb-file-icon" aria-hidden="true">${e(d.format.toUpperCase())}</div><div><h3>${e(d.title)}</h3><div class="kb-tags">${tag(d.course)}${tag(d.scope)}${tag(d.kind)}${d.year?tag(d.year):''}${d.extract_status==='scan'?tag('扫描件 · 查看原卷'):''}</div><p class="kb-snippet">${e(d.snippet||d.extract_status)}</p><span class="kb-source">${e(d.origin)}${d.match_page&&$('#query').value?`，命中第 ${d.match_page} 页`:''}${d.source_url?' · '+e(new URL(d.source_url).hostname):''}</span></div><div class="kb-item-actions"><button type="button" class="btn btn-secondary btn-sm" data-document="${e(d.id)}" data-page="${d.match_page||1}">${mode==='pending'?'查看并核对':'阅读与摘录'}</button></div></article>`;
}
async function loadResults() {
  const serial=++sequence;
  $('#next').hidden=true;$('#previous').hidden=true;$('#result-count').textContent='读取中…';
  $('#results').innerHTML=empty('正在读取','本地全文检索会返回对应的原卷页码。');
  try {
    if(mode==='cards')return await loadCards(serial);
    if(mode==='web') {
      const q=$('#query').value.trim();
      $('#result-title').textContent='公开来源';
      if(!q){$('#result-count').textContent='';$('#results').innerHTML=empty('先描述你想找的资料','例如：中国矿业大学 北京 大学物理 期末试卷。也可以使用 site:cumtb.edu.cn 限定学校官网。');return;}
      $('#results').innerHTML=empty('正在检索公开网站','网络搜索可能需要十几秒；结果不会自动入库。');
      const data=await api.searchWeb(q);if(serial!==sequence)return;
      $('#result-count').textContent=`${data.items.length} 条网络结果`;
      $('#results').innerHTML=data.items.map(r=>`<article class="kb-item"><div class="kb-file-icon" aria-hidden="true">WEB</div><div><h3><a href="${e(url(r.href))}" target="_blank" rel="noopener noreferrer">${e(r.title)}</a></h3><p class="kb-snippet">${e(r.body)}</p><span class="kb-source">${e(r.href)}</span></div><button type="button" class="btn btn-secondary btn-sm" data-crawl="${e(url(r.href))}">采集此页</button></article>`).join('')||empty('没有找到结果','换一组课程关键词、学校全称或指定网站再试。');return;
    }
    const data=await api.catalogue({q:$('#query').value,course:$('#course-filter').value,scope:$('#scope-filter').value,kind:$('#kind-filter').value,status:mode==='pending'?'pending':'ready',offset});
    if(serial!==sequence)return;
    $('#result-title').textContent=mode==='pending'?'核对后再入库':($('#course-filter').value||'课程资料');
    $('#result-count').textContent=`${data.total} 份${data.total?` · ${offset+1}–${Math.min(offset+30,data.total)}`:''}`;
    $('#results').innerHTML=data.items.map(documentRow).join('')||empty(mode==='pending'?'暂时没有待核对资料':'没有匹配的资料',mode==='pending'?'从“全网找资料”选择来源，或收录一个公开网址。':'更换关键词或清除筛选；还未收录的课程可以添加公开资料。');
    $('#previous').hidden=offset===0;$('#next').hidden=offset+30>=data.total;
  } catch(error) {
    if(serial!==sequence)return;
    $('#result-count').textContent='';$('#results').innerHTML=empty('暂时无法读取',error.message);showError(error);
  }
}
async function changeMode(next) {
  mode=next;offset=0;
  document.querySelectorAll('[data-mode]').forEach(b=>next===b.dataset.mode?b.setAttribute('aria-current','page'):b.removeAttribute('aria-current'));
  $('#search-section').hidden=next==='cards';$('#local-filters').hidden=next==='web';$('#web-hint').hidden=next!=='web';$('#review-toolbar').hidden=next!=='cards';$('#jobs').hidden=next!=='pending';
  if(next==='pending'){$('#query').value='';$('#course-filter').value='';$('#scope-filter').value='';$('#kind-filter').value='';await pollJobs();}
  await loadResults();
}
function openCrawl(value='') { $('#crawl-url').value=value;$('#crawl-dialog').showModal();$('#crawl-url').focus(); }
async function pollJobs() {
  const data=await api.jobs();
  $('#jobs').innerHTML=data.items.slice(0,5).map(j=>`<div class="kb-job"><strong>${e({queued:'等待采集',running:'正在采集',done:'采集完成',partial:'部分完成',failed:'采集未成功',interrupted:'任务中断'}[j.state])}</strong><p>${e(j.message)}</p>${['queued','running'].includes(j.state)?`<progress value="${j.progress}" max="${j.total||1}" aria-label="采集进度"></progress>`:''}<details><summary>查看每页结果</summary><ul>${j.details.map(d=>`<li>${e(d.url)}：${e(d.ok?(d.created?'已进入待核对':'重复内容，沿用已有资料'):d.error)}</li>`).join('')}</ul></details></div>`).join('')||'<p class="kb-note">还没有采集任务。</p>';
  clearTimeout(polling);
  if(data.items.some(j=>['queued','running'].includes(j.state)))polling=setTimeout(()=>pollJobs().then(()=>{refreshMeta();if(mode==='pending')loadResults();}).catch(showError),2500);
}
async function openDocument(id,page=1) {
  try {
    currentDoc=await api.document(id);const d=currentDoc;
    page=Math.min(Math.max(1,Number(page)),d.pages||1);
    const source=d.source_url?`<a href="${e(url(d.source_url))}" target="_blank" rel="noopener noreferrer">查看来源网页</a>`:'本机原始资料';
    const preview=d.format==='pdf'?`<iframe id="pdf-frame" title="原始 PDF" src="${api.file(id)}#page=${page}"></iframe>`:d.format==='mp3'?`<audio controls preload="metadata" src="${api.file(id)}"></audio>`:`<pre class="kb-extracted">${e(d.body)}</pre>`;
    const curate=d.status==='pending'?`<form id="curate-form" class="kb-form"><h3>核对资料信息</h3><label>课程<input name="course" value="${e(d.course)}" list="course-names" required maxlength="80"></label><label>资料范围<select name="scope"><option>外部资料</option><option>通用考试</option><option>本校资料</option></select></label><label>年份 / 学年<input name="year" maxlength="30" placeholder="无法核实时留空"></label><label>类型<select name="kind"><option>资料</option><option>试卷</option><option>试卷与答案</option><option>答案解析</option></select></label><label class="kb-check"><input type="checkbox" required>已核对来源、课程及使用许可</label><button class="btn btn-primary" type="submit">确认入库</button></form>`:'';
    $('#document-content').innerHTML=`<div class="kb-dialog-head"><h2>${e(d.title)}</h2><button type="button" class="btn btn-secondary" data-close="document-dialog">关闭</button></div><div class="kb-tags">${tag(d.course)}${tag(d.scope)}${tag(d.kind)}</div><div class="kb-reader-tools">${source}${['pdf','mp3'].includes(d.format)?`<a class="btn btn-link" href="${api.file(id)}" target="_blank" rel="noopener">单独打开原件</a>`:''}${d.pages?`<label>第 <select id="reader-page" aria-label="原卷页码">${Array.from({length:d.pages},(_,i)=>`<option ${i+1===page?'selected':''}>${i+1}</option>`).join('')}</select> 页 / ${d.pages}</label>`:''}</div><p class="kb-note">${e(d.extract_status==='scan'?'扫描资料：请以原卷阅读和抄录题目，尚未 OCR。':d.extract_status)}</p><div class="kb-related">${d.related.map(r=>`<button class="btn btn-secondary btn-sm" data-document="${e(r.id)}" type="button">${e(r.kind)}</button>`).join('')}</div><div class="kb-reader-grid"><div class="kb-preview">${preview}${d.format==='pdf'?'<details><summary>查看本页提取文字（用于检索）</summary><pre id="page-text" class="kb-extracted"></pre></details>':''}<p class="kb-note">${e(d.rights)}</p></div><aside>${curate}<form id="card-form" class="kb-form"><h3>摘录为复习卡</h3><p>保留原卷与页码。先写下问题，再补自己的解题过程或核对后的答案。</p><label>题目 / 知识点<textarea name="question" id="card-question" required maxlength="8000" placeholder="记下需要练习的一题，或尚未理解的知识点"></textarea></label><label>参考笔记 / 答案<textarea name="answer" maxlength="12000" placeholder="可先留空，核对原卷后补充"></textarea></label><button class="btn btn-primary" type="submit">保存到我的复习</button></form></aside></div>`;
    function showPage(){const p=Number($('#reader-page')?.value||1);const t=d.chunks.find(c=>c.page===p)?.text||'此页未提取到文字，请查看原卷。';if($('#page-text'))$('#page-text').textContent=t;if($('#pdf-frame'))$('#pdf-frame').src=`${api.file(id)}#page=${p}`;}
    $('#reader-page')?.addEventListener('change',showPage);showPage();
    $('#card-form').addEventListener('submit',async event=>{event.preventDefault();const form=event.currentTarget;try{await api.addCard({docid:id,page:Number($('#reader-page')?.value||1),question:form.elements.question.value,answer:form.elements.answer.value});form.reset();toast('复习卡已保存，来源与页码已关联。');await refreshMeta();}catch(error){showError(error);}});
    $('#curate-form')?.addEventListener('submit',async event=>{event.preventDefault();const values=Object.fromEntries(new FormData(event.currentTarget));try{await api.curate({id,...values});$('#document-dialog').close();toast('资料已入库。');await refreshMeta();await loadResults();}catch(error){showError(error);}});
    if(!$('#document-dialog').open)$('#document-dialog').showModal();
  }catch(error){showError(error);}
}
async function loadCards(serial) {
  const data=await api.cards();if(serial!==sequence)return;
  $('#result-title').textContent='我的复习';$('#result-count').textContent=`${data.items.length} 张卡片`;
  $('#results').innerHTML=data.items.map(c=>`<article class="kb-review"><div class="kb-tags">${tag(c.course)}${tag(c.due<=new Date().toISOString()?'今天待复习':'下次 '+date(c.due))}${tag('已复习 '+c.attempts+' 次')}</div><p class="question">${e(c.question)}</p><details><summary>展开参考笔记</summary><div class="answer">${e(c.answer||'还没有参考笔记。请打开原卷核对。')}</div></details><div class="kb-reader-tools"><button class="btn btn-primary btn-sm" data-review="${e(c.id)}" data-correct="true" type="button">已经掌握</button><button class="btn btn-secondary btn-sm" data-review="${e(c.id)}" data-correct="false" type="button">还要再练</button><button class="btn btn-link" data-document="${e(c.docid)}" data-page="${c.page}" type="button">回到原卷第 ${c.page} 页</button></div><span class="kb-source">${e(c.title)}</span></article>`).join('')||empty('把需要再练的一题留下','在资料里点击“阅读与摘录”，保存第一张复习卡。复习计划会根据自评结果安排下一次练习。');
}
document.addEventListener('click',async event=>{
  const close=event.target.closest('[data-close]');if(close)$('#'+close.dataset.close).close();
  const tab=event.target.closest('[data-mode]');if(tab)changeMode(tab.dataset.mode).catch(showError);
  const doc=event.target.closest('[data-document]');if(doc)openDocument(doc.dataset.document,doc.dataset.page||1);
  const crawl=event.target.closest('[data-crawl]');if(crawl)openCrawl(crawl.dataset.crawl);
  const review=event.target.closest('[data-review]');if(review){review.disabled=true;try{await api.review(review.dataset.review,review.dataset.correct==='true');toast('复习已记录，下次日期已更新。');await refreshMeta();await loadResults();}catch(error){showError(error);review.disabled=false;}}
});
$('#search-form').addEventListener('submit',event=>{event.preventDefault();offset=0;loadResults();});
['course-filter','scope-filter','kind-filter'].forEach(id=>$('#'+id).addEventListener('change',()=>{offset=0;loadResults();}));
$('#next').addEventListener('click',()=>{offset+=30;loadResults();});$('#previous').addEventListener('click',()=>{offset=Math.max(0,offset-30);loadResults();});
$('#open-crawl').addEventListener('click',()=>openCrawl());
$('#crawl-form').addEventListener('submit',async event=>{event.preventDefault();const button=event.currentTarget.querySelector('button[type=submit]');button.disabled=true;try{await api.crawl({url:$('#crawl-url').value,course:$('#crawl-course').value||'未分类',limit:Number($('#crawl-limit').value),dynamic:$('#crawl-dynamic').checked});$('#crawl-dialog').close();toast('已开始采集，结果将进入待核对。');await changeMode('pending');}catch(error){showError(error);}finally{button.disabled=false;}});
$('#add-course').addEventListener('click',()=>$('#course-dialog').showModal());
$('#course-form').addEventListener('submit',async event=>{event.preventDefault();try{const name=$('#new-course').value.trim();await api.addCourse(name);$('#course-dialog').close();await refreshMeta();$('#course-filter').value=name;loadResults();toast('课程已添加，可以收录对应资料。');}catch(error){showError(error);}});
$('#backup').addEventListener('click',async()=>{try{const data=await api.backup();const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});const objectUrl=URL.createObjectURL(blob);const a=document.createElement('a');a.href=objectUrl;a.download='Luokixi-复习备份-'+new Date().toISOString().slice(0,10)+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(objectUrl),1000);toast('复习记录已导出；原始资料需另行备份。');}catch(error){showError(error);}});
$('#restore').addEventListener('click',()=>$('#backup-file').click());
$('#backup-file').addEventListener('change',async event=>{try{const file=event.target.files[0];if(!file)return;if(file.size>1024*1024)throw new Error('备份文件超过 1 MB。');const data=await api.restore(JSON.parse(await file.text()));toast(`导入 ${data.restored} 张复习卡；缺少来源而跳过 ${data.skipped} 张。`);await refreshMeta();await loadResults();}catch(error){showError(error);}finally{event.target.value='';}});
if (campusAvailable) {
  refreshMeta().then(loadResults).catch(error=>{$('#connection').textContent='知识库服务未连接。请启动本机服务后刷新；已有四六级和矿大资料页面仍可使用。';$('#results').innerHTML=empty('需要连接知识库服务','实时搜索、采集与复习卡需要本机服务运行。请使用“启动学校知识库”入口打开。');$('#result-count').textContent='';});
} else {
  $('#connection').textContent='当前为静态浏览版本。实时搜索、资料采集和复习记录需要本机知识库服务。';
  $('#summary').textContent='源代码开放，可在自己的电脑运行。';
  $('#results').innerHTML=empty('在电脑上启动知识库','打开项目文件夹，双击“启动学校知识库.cmd”，浏览器会自动打开可用版本。尚未安装运行环境时，先按 campus/README.md 完成安装。现有四六级目录和矿大资料页仍可浏览。');
  $('#result-count').textContent='';
  document.querySelectorAll('.kb button,.kb input,.kb select').forEach(node=>node.disabled=true);
}
