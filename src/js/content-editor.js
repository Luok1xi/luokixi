import {hubApi,hubState} from './hub.js';
import {esc} from './data.js';
import '../styles/content-editor.css';
let permitted=false,dialog,view,bodyEditor,loadSerial=0;
function disposeBody(){bodyEditor?.destroy();bodyEditor=null;}
const q=s=>dialog.querySelector(s);
function openDialog(){
  if(!dialog){dialog=document.createElement('dialog');dialog.className='content-editor';document.body.append(dialog);
    dialog.addEventListener('close',()=>{++loadSerial;disposeBody();});}
  if(!dialog.open)dialog.showModal();
}
export async function openContentEditor(key){
  if(!permitted)return;openDialog();disposeBody();const serial=++loadSerial;dialog.innerHTML='<p role="status">读取当前版本…</p>';
  try{const current=await hubApi.request('management/read?'+new URLSearchParams({key}));if(serial!==loadSerial||!dialog.open)return;view=current;render();}
  catch(e){if(serial!==loadSerial||!dialog.open)return;dialog.innerHTML=`<p role="alert">${esc(e.message)}</p><button data-close>关闭</button>`;q('[data-close]').onclick=()=>dialog.close();}
}
function render(){
  const d=view.data,m=d.media||{};
  dialog.innerHTML=`<form class="ce-form"><header><h2>编辑并发布</h2><button type="button" data-close aria-label="关闭">×</button></header>
    <p class="ce-meta">${esc(view.key)} · 第 ${view.revision} 版 · ${esc(view.state)}</p>
    <label>标题<input name="title" value="${esc(d.title||'')}" maxlength="160"></label>
    <label>简介<textarea name="summary" rows="3">${esc(d.dek??d.summary??d.description??'')}</textarea></label>
    <label>正文<textarea name="body" rows="7">${esc(d.body||'')}</textarea></label>
    <fieldset><legend>配图</legend><label>上传原图<input name="file" type="file" accept="image/png,image/jpeg,image/webp"></label>
      <label>图片地址<input name="src" value="${esc(m.src||'')}"></label><img class="ce-preview" alt="配图预览" hidden>
      <label>图片说明<input name="alt" value="${esc(m.alt||'')}"></label><label>出处<input name="sourceUrl" type="url" value="${esc(m.sourceUrl||'')}"></label>
      <label>署名<input name="credit" value="${esc(m.credit||'')}"></label>
      <label>显示方式<select name="fit"><option value="cover">焦点裁切</option><option value="contain" ${m.fit==='contain'?'selected':''}>完整显示</option></select></label>
      <label>水平焦点<input name="fx" type="range" min="0" max="100" value="${parseFloat(m.focal?.split(' ')[0]??'50%')}"></label>
      <label>纵向焦点<input name="fy" type="range" min="0" max="100" value="${parseFloat(m.focal?.split(' ')[1]??'50%')}"></label></fieldset>
    <details><summary>完整字段、来源与分类</summary><textarea name="json" rows="14" spellcheck="false">${esc(JSON.stringify(d,null,2))}</textarea></details>
    <label>修改说明<input name="reason" required value="站内编辑并发布" maxlength="1500"></label>
    ${view.kind==='place'?'<label><input type="checkbox" name="locationChecked" required>已核对地点与来源</label>':''}
    ${d.supervisorQuestions?.length?'<label><input type="checkbox" name="supervisorQuestionsResolved" required>待确认事项已处理</label>':''}
    <p data-status role="status"></p><footer><button type="submit" class="btn btn-primary">保存并公开</button>
    ${view.state==='pending'?'<button type="button" data-review="approve">通过</button><button type="button" data-review="reject">退回</button>':''}
    <button type="button" data-history>版本记录与恢复</button></footer><div data-history-list></div></form>`;
  q('[data-close]').onclick=()=>dialog.close();
  const textarea=q('[name=body]'),serial=loadSerial;
  import('./rich-body.js').then(({mountRichBody})=>{
    if(serial===loadSerial&&textarea.isConnected&&dialog.open)bodyEditor=mountRichBody(textarea,{format:d.bodyFormat});
  }).catch(()=>{/* The canonical text field stays usable if the enhancement cannot load. */});
  const preview=()=>{const img=q('.ce-preview'),src=q('[name=src]').value;
    if(src&&!/^(https?:\/\/|\/art\/|\/api\/hub\/)/.test(src))return;
    img.hidden=!src;img.src=src;img.style.objectFit=q('[name=fit]').value;img.style.objectPosition=`${q('[name=fx]').value}% ${q('[name=fy]').value}%`;};
  for(const name of ['src','fit','fx','fy'])q(`[name=${name}]`).addEventListener('input',preview);preview();
  q('[name=file]').onchange=async e=>{try{const file=e.target.files[0];if(!file)return;const uploaded=await hubApi.upload(file);
    q('[name=src]').value=uploaded.url;q('[name=alt]').value ||=file.name;preview();}catch(e){q('[data-status]').textContent=e.message;}};
  q('form').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.target);
    try{const proposed=JSON.parse(f.get('json'));
      if(!proposed||Array.isArray(proposed)||typeof proposed!=='object')throw new Error('完整字段需为对象。');
      const fields={title:f.get('title'),[view.kind==='featured'?'dek':view.kind==='github'?'description':'summary']:f.get('summary'),body:f.get('body')};
      for(const [k,v]of Object.entries(fields)){const initial=k==='title'?d.title||'':k==='body'?d.body||'':d.dek??d.summary??d.description??'';if(v!==initial)proposed[k]=v;}
      if(fields.body!==(d.body||''))proposed.bodyFormat=bodyEditor?.getFormat()||d.bodyFormat||'plain';
      if(f.get('src'))proposed.media={...m,src:f.get('src'),alt:f.get('alt'),sourceUrl:f.get('sourceUrl'),credit:f.get('credit'),fit:f.get('fit'),focal:`${f.get('fx')}% ${f.get('fy')}%`,originalSrc:m.originalSrc||m.src||f.get('src')};
      const patch=Object.fromEntries(Object.entries(proposed).filter(([k,v])=>JSON.stringify(v)!==JSON.stringify(d[k])));
      if(!Object.keys(patch).length){q('[data-status]').textContent='没有修改内容。';return;}
      q('[type=submit]').disabled=true;q('[data-status]').textContent='发布中…';
      await hubApi.request('management/publish',{key:view.key,revision:view.revision,patch,reason:f.get('reason'),locationChecked:f.has('locationChecked'),supervisorQuestionsResolved:f.has('supervisorQuestionsResolved')});location.reload();
    }catch(e){q('[data-status]').textContent=e.message;q('[type=submit]').disabled=false;}};
  dialog.querySelectorAll('[data-review]').forEach(b=>b.onclick=async()=>{try{
    await hubApi.request('management/review',{key:view.key,revision:view.revision,decision:b.dataset.review,reason:q('[name=reason]').value});location.reload();
  }catch(e){q('[data-status]').textContent=e.message;}});
  q('[data-history]').onclick=async()=>{try{const history=await hubApi.request('management/history?'+new URLSearchParams({key:view.key}));
    q('[data-history-list]').innerHTML=history.items.map(r=>`<details><summary>第 ${r.revision} 版 · ${esc(r.actor)} · ${esc(r.created)}</summary><p>${esc(r.reason)}</p><pre>${esc(JSON.stringify(r.data,null,2))}</pre><button type="button" data-restore="${r.revision}">恢复此版本</button></details>`).join('')||'暂无历史版本';
    dialog.querySelectorAll('[data-restore]').forEach(b=>b.onclick=async()=>{try{await hubApi.request('management/publish',{key:view.key,revision:view.revision,restoreRevision:Number(b.dataset.restore),reason:'恢复第 '+b.dataset.restore+' 版'});location.reload();}catch(e){q('[data-status]').textContent=e.message;}});
  }catch(e){q('[data-status]').textContent=e.message;}};
}
function decorate(root){
  for(const node of [...(root.matches?.('[data-content-key]')?[root]:[]),...root.querySelectorAll('[data-content-key]')]){
    if(node.querySelector(':scope > [data-edit-content]'))continue;
    const b=document.createElement('button');b.type='button';b.className='ce-inline';b.dataset.editContent=node.dataset.contentKey;b.textContent='编辑';
    b.onclick=e=>{e.stopPropagation();e.preventDefault();void openContentEditor(b.dataset.editContent);};node.append(b);
  }
}
export async function installContentEditor(){
  const state=await hubState();permitted=!!state.user?.developer;if(!permitted)return;
  const bar=document.createElement('aside');bar.className='ce-toolbar';bar.innerHTML='<a href="/manage/">管理中心</a><button type="button" data-content-list>编辑内容</button><button type="button" data-page-copy>页面说明</button>';
  document.body.append(bar);bar.querySelector('[data-page-copy]').onclick=()=>openContentEditor('page/site');
  bar.querySelector('[data-content-list]').onclick=async()=>{
    openDialog();disposeBody();++loadSerial;dialog.innerHTML='<header><h2>网站内容</h2><button data-close>关闭</button></header><form data-search><input name="q" placeholder="搜索标题、项目、新闻…"><select name="state"><option value="">全部状态</option><option value="pending">待审核</option><option value="published">已公开</option></select><button>搜索</button></form><div data-list></div>';q('[data-close]').onclick=()=>dialog.close();
    const search=async()=>{try{const result=await hubApi.request('management?'+new URLSearchParams(new FormData(q('[data-search]'))));
      q('[data-list]').innerHTML=result.items.map(r=>`<button class="ce-list-row" data-key="${esc(r.key)}"><b>${esc(r.data.title||r.data.fullName||r.key)}</b><span>${esc(r.kind)} · ${esc(r.state)} · 第 ${r.revision} 版</span></button>`).join('');
      dialog.querySelectorAll('[data-key]').forEach(b=>b.onclick=()=>{dialog.close();void openContentEditor(b.dataset.key);});
    }catch(e){q('[data-list]').textContent=e.message;}};q('[data-search]').onsubmit=e=>{e.preventDefault();void search();};await search();
  };
  decorate(document);let scheduled=false;const roots=new Set();new MutationObserver(records=>{
    for(const r of records)for(const node of r.addedNodes)if(node.nodeType===1&&(node.matches('[data-content-key]')||node.querySelector('[data-content-key]')))roots.add(node);
    if(!roots.size||scheduled)return;scheduled=true;requestAnimationFrame(()=>{scheduled=false;for(const root of roots)if(root.isConnected)decorate(root);roots.clear();});
  }).observe(document.body,{childList:true,subtree:true});
  const initialKey=new URLSearchParams(location.search).get('edit');if(initialKey)void openContentEditor(initialKey);
}
export function taskProgressHTML(tasks){
  const labels={queued:'已接收',running:'执行中',completed:'完成',failed:'失败',merged:'合并处理'};
  return (tasks||[]).slice(0,8).map(t=>`<details class="ce-task" ${['queued','running'].includes(t.state)?'open':''}><summary>${esc(labels[t.state]||t.state)} · ${esc(t.progress||'内容任务')} · ${esc(t.id.slice(0,8))}</summary><p>${esc(t.error||'')}</p>${t.result?.actionIds?.length?`<p>已保留 ${t.result.actionIds.length} 份操作回执</p>`:''}${t.result?.reportWarnings?.length?`<p>执行备注：${esc(t.result.reportWarnings.join('；'))}</p>`:''}<small>任务编号 ${esc(t.id)} · ${esc(t.updated)}</small></details>`).join('');
}
