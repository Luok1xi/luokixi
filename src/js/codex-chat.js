import './ai-budget.js';
import { createStudioClient } from '../../campus/studio-client.js';
import { esc } from './data.js';
import {taskProgressHTML} from './content-editor.js';
import { mountCompanionStage } from './companion-stage.js';
import { stageLines, stageTurn } from '../../campus/stage-catalog.js';
import '../styles/beikuang.css';

const api=createStudioClient();
const busy=run=>run && ['queued','running'].includes(run.state);
const avatar=cls=>`<span class="${cls} codex-avatar" aria-hidden="true"><img src="/art/companions/codex-avatar-v1.png" alt="" decoding="async"></span>`;
const icon=avatar('bk-avatar');
const MOODS={neutral:'平静',happy:'心情不错',sad:'有些低落',angry:'认真',think:'在想事情',awkward:'有点不好意思',composed:'从容'};
const QUICK=['今天进度怎么样？','查查资料库','今天辛苦啦'];
const timeOf=iso=>iso?new Date(iso).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}):'';
let partsShown=new Map(),partTimer=0,stickerCatalogue=new Map(),lastData=null;
const arrow='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg>';
let root=null,timer=0,generation=0,current=null,sending=false,rendered='',requestError='';
let stage=null;
const $=s=>root?.querySelector(s);

export function stopCodexChat(){
  stage?.destroy();stage=null;clearTimeout(partTimer);partTimer=0;partsShown=new Map();lastData=null;
  generation+=1;clearTimeout(timer);
  root?.removeEventListener('submit',onSubmit);
  root?.removeEventListener('click',onClick);
  root?.removeEventListener('keydown',onKey);root?.removeEventListener('input',grow);
  document.removeEventListener('visibilitychange',onVisibility);
  root=null;current=null;sending=false;rendered='';requestError='';
}

export function mountCodexChat(container){
  stopCodexChat();root=container;
  root.innerHTML=`<section class="bk" aria-label="Codex 对话">
    <header class="bk-head">${icon}<div class="bk-id"><h2>Codex</h2><p data-codex-line>连接本机 Codex…</p></div>
      <div class="bk-head-actions"><button class="as-get is-small" type="button" data-ai-budget>额度设置</button><a class="as-get is-small" href="http://127.0.0.1:17840" target="_blank" rel="noopener">记忆与学习</a><a class="as-get is-small" href="#beikuang">北矿娘</a><a class="as-get is-small" href="studio.html">双人工作室</a><button class="as-get is-small" type="button" data-codex-stop hidden>停止回复</button></div></header>
    <div class="bk-stats" data-codex-stats></div><div data-codex-stage></div><div class="bk-thread" role="log" aria-live="polite" data-codex-thread></div>
    <form class="bk-compose" data-codex-form><div class="bk-quick">${QUICK.map(q=>`<button type="button" class="as-tag" data-codex-quick="${esc(q)}">${esc(q)}</button>`).join('')}</div><div class="bk-field"><label class="sr-only" for="codex-input">和 Codex 说</label>
      <textarea id="codex-input" rows="1" maxlength="6000" placeholder="和 Codex 说点什么…" enterkeyhint="send"></textarea>
      <button class="bk-send" type="submit" aria-label="发送给 Codex">${arrow}</button></div><p class="bk-note" role="status" data-codex-note></p></form>
    </section>`;
  root.addEventListener('submit',onSubmit);root.addEventListener('click',onClick);root.addEventListener('keydown',onKey);root.addEventListener('input',grow);
  stage=mountCompanionStage($('[data-codex-stage]'),{seats:['codex']});
  document.addEventListener('visibilitychange',onVisibility);
  const version=generation;
  fetch('/art/beikuang/stickers/catalogue.json').then(r=>r.json()).then(d=>{
    if(version!==generation||!root)return;
    stickerCatalogue=new Map((d.items||[]).filter(s=>/^\/art\/beikuang\/stickers\/[a-z0-9_]+\.png$/.test(s.url)).map(s=>[s.id,s]));
    if(lastData)render(lastData);
  }).catch(()=>{});
  refresh();
}

function note(text){const node=$('[data-codex-note]');if(node)node.textContent=text;}
function render(data){
  stage?.update({lines:stageLines(data.runs),thinking:stageTurn(data.runs[0]),emotions:{codex:data.emotion?.name},error:!data.ready});
  current=data.runs[0]||null;
  $('[data-codex-line]').textContent=data.ready?'Codex · 和工作室共用记忆':data.reason;
  const box=$('[data-codex-thread]');
  const nearBottom=box.scrollHeight-box.scrollTop-box.clientHeight<100;
  const first=!lastData;lastData=data;
  $('[data-codex-stats]').innerHTML=`<span class="bk-stat">心情 <b>${esc(MOODS[data.emotion?.name]||'平静')}</b></span><span class="bk-stat">${data.ready?'已连接':'连接待恢复'}</span><a class="bk-skills" href="studio.html">维护与工具记录 ›</a>`;
  let lastDay='';
  const html=taskProgressHTML(data.contentTasks)+[...data.runs].reverse().map(run=>{
    const stamp=run.created||run.updated;
    const day=stamp?new Date(stamp).toLocaleDateString('zh-CN',{month:'long',day:'numeric'}):'';
    const heading=day&&day!==lastDay?`<p class="bk-day">${esc(day)}</p>`:'';lastDay=day;
    return heading+`${run.prompt?`<div class="bk-row is-me"><div class="bk-bubble">${esc(run.prompt)}</div><time>${esc(timeOf(stamp))}</time></div>`:''}
    ${run.messages.map(m=>{
      const parts=m.messages?.length?m.messages:[{type:'text',text:m.body}];
      const key=m.id||run.id+':'+m.seat;
      if(!partsShown.has(key))partsShown.set(key,first||document.hidden?parts.length:1);
      const count=partsShown.get(key);
      if(count<parts.length&&!partTimer&&!document.hidden){const version=generation;partTimer=setTimeout(()=>{partTimer=0;if(version!==generation||!root)return;partsShown.set(key,count+1);render(lastData);},matchMedia('(prefers-reduced-motion: reduce)').matches?0:Math.min(320,2400/parts.length));}
      return `<div class="bk-row is-her">${avatar('bk-mini')}<div class="bk-stack">${parts.slice(0,count).map(p=>{
        const sticker=stickerCatalogue.get(p.id);
        return `<div class="bk-bubble">${p.type==='text'?esc(p.text):sticker?`<img class="bk-sticker" src="${esc(sticker.url)}" alt="${esc(sticker.label)}" width="148" height="148" decoding="async">`:'[表情暂不可用]'}</div>`;
      }).join('')}</div><time>${esc(timeOf(m.created||stamp))}</time></div>`;
    }).join('')}
    ${run.error?`<p class="bk-note" role="status">${esc(run.error)}</p>`:''}
    ${run.state==='cancelled'?'<p class="bk-note">本次回复已停止。</p>':''}`;
  }).join('')||`<div class="bk-empty">${avatar('bk-avatar is-big')}<b>Codex</b><p>在这里接着聊。私聊和工作室都保留在她自己的记忆中。</p></div>`;
  if(html!==rendered){box.innerHTML=html;rendered=html;if(nearBottom)box.scrollTop=box.scrollHeight;}
  const working=busy(current);
  $('[data-codex-stop]').hidden=!working;
  $('[type=submit]').disabled=working||sending||!data.ready;
  note(working?(current.state==='running'?'Codex 正在回复…':data.waitingForWork?'消息已收到，正在等当前工作收尾…':data.workerAvailable?'消息已收到，准备回复…':'工作进程暂未就绪，消息保留在队列。'):data.reason||requestError||'');
}

async function refresh(){
  if(!root||document.hidden)return;
  clearTimeout(timer);const version=generation;
  try{const data=await api.codexChat();if(!root||version!==generation)return;render(data);}
  catch(error){if(!root||version!==generation)return;note(error.message);}
  if(root&&version===generation)timer=setTimeout(refresh,busy(current)?1600:10000);
}

async function onSubmit(event){
  if(!event.target.matches('[data-codex-form]'))return;
  event.preventDefault();if(sending||busy(current))return;
  const area=$('#codex-input'),body=area.value.trim();if(!body)return;
  const version=generation;requestError='';sending=true;clearTimeout(timer);$('[type=submit]').disabled=true;note('正在发送…');
  try{const run=await api.tellCodex(body);if(!root||version!==generation)return;current=run;area.value='';area.style.height='auto';if(lastData)render({...lastData,runs:[run,...lastData.runs.filter(r=>r.id!==run.id)]});}
  catch(error){if(root&&version===generation){requestError=error.message;note(error.message);}}
  finally{if(root&&version===generation){sending=false;await refresh();}}
}

async function onClick(event){
  const quick=event.target.closest('[data-codex-quick]');if(quick){const area=$('#codex-input');area.value=quick.dataset.codexQuick;grow({target:area});area.focus();return;}
  if(!event.target.closest('[data-codex-stop]')||!current)return;
  const version=generation;try{await api.stop(current.id);if(root&&version===generation)await refresh();}
  catch(error){if(root&&version===generation){requestError=error.message;note(error.message);}}
}
function onKey(event){if(event.target.id==='codex-input'&&event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();$('[data-codex-form]').requestSubmit();}}
function grow(event){if(event.target.id!=='codex-input')return;event.target.style.height='auto';event.target.style.height=Math.min(event.target.scrollHeight,160)+'px';}
function onVisibility(){if(document.hidden){clearTimeout(timer);clearTimeout(partTimer);partTimer=0;for(const run of lastData?.runs||[])for(const m of run.messages)partsShown.set(m.id||run.id+':'+m.seat,m.messages?.length||1);}else refresh();}
