import {initShell} from '../js/shell.js';
import {hubApi,hubState,loginURL} from '../js/hub.js';
import {esc} from '../js/data.js';
import '../styles/products.css';
import '../styles/reservations.css';
initShell();
const $=s=>document.querySelector(s), form=$('#seat-form'); let items=[],requestKey=crypto.randomUUID(), loading=false;
const fmt=v=>new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(v));
const tomorrow=new Date(Date.now()+86400000).toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'});
form.elements.starts.value=tomorrow+'T09:00';form.elements.ends.value=tomorrow+'T11:00';form.elements.remindAt.value=tomorrow+'T06:30';
form.elements.campus.value=new URLSearchParams(location.search).get('campus')==='shahe'?'shahe':'xueyuanlu';
const json=path=>hubApi.request('bookings'+path);
async function refresh(){if(loading)return;loading=true;$('#seat-refresh').disabled=true;try{const r=await json('');items=r.items;render();}catch(e){$('#seat-list').innerHTML=`<p>${esc(e.message)} <a href="${esc(loginURL())}">登录后查看 →</a></p>`;}finally{loading=false;$('#seat-refresh').disabled=false;}}
function render(){$('#seat-list').innerHTML=items.length?items.map(p=>`<article class="seat-task"><div><span class="seat-state" data-state="${esc(p.state)}">${esc(p.stateLabel)}</span><h3>${p.campus==='shahe'?'沙河':'学院路'} · ${fmt(p.starts)}</h3><p>学习至 ${fmt(p.ends)} · 提醒时间 ${fmt(p.remindAt)}</p><p>${esc(p.preference||'未指定座位偏好')}</p></div><div class="seat-actions">${['scheduled','action_required','reported_reserved'].includes(p.state)?`<a href="${esc(p.calendarUrl)}" download>导入日历</a><button data-action="copy" data-id="${p.id}">复制计划</button><a href="https://lib.cumtb.edu.cn/" target="_blank" rel="noopener">去官网预约 ↗</a>${p.state!=='reported_reserved'?`<button data-action="reserved" data-id="${p.id}">我已在学校预约</button>`:`<button data-action="checkin" data-id="${p.id}">我已签到</button>`}<button data-action="cancel" data-id="${p.id}">取消助手任务</button>`:''}</div><small>状态由本人反馈，未向学校核验。取消助手任务不会取消学校系统中的预约。</small></article>`).join(''):'<div class="product-empty"><h3>还没有预约任务</h3><p>创建一个计划，给下一次专注留好时间。</p></div>';}
form.onsubmit=async e=>{e.preventDefault();const s=await hubState();if(!s.user){location.href=loginURL();return;}const b=form.querySelector('[type=submit]');b.disabled=true;try{const v=Object.fromEntries(new FormData(form));for(const k of ['starts','ends','remindAt'])v[k]=new Date(v[k]+':00+08:00').toISOString();await hubApi.request('bookings',{...v,requestKey});requestKey=crypto.randomUUID();$('#seat-message').textContent='任务已保存。建议导入日历，关闭网页也能收到日历提醒。';await refresh();}catch(err){$('#seat-message').textContent=err.message;}finally{b.disabled=false;}};
$('#seat-list').onclick=async e=>{const b=e.target.closest('[data-action]');if(!b)return;const p=items.find(x=>x.id===b.dataset.id);b.disabled=true;try{if(b.dataset.action==='copy'){await navigator.clipboard.writeText(`${p.campus==='shahe'?'沙河':'学院路'}图书馆\n${fmt(p.starts)} — ${fmt(p.ends)}\n座位偏好：${p.preference||'不限'}\n请在学校官方系统完成预约。`);b.textContent='已复制';return;}if(b.dataset.action==='reserved'&&!confirm('确认你已在学校官方系统预约成功？这里只记录你的反馈，不代替学校凭证。'))return;if(b.dataset.action==='checkin'&&!confirm('确认你已经完成学校要求的签到？'))return;await hubApi.request(`bookings/${p.id}/action`,{version:p.version,action:b.dataset.action,confirmedByOwner:true});await refresh();}catch(err){$('#seat-message').textContent=err.message;}finally{b.disabled=false;}};
$('#seat-refresh').onclick=refresh;
json('/capabilities').then(c=>$('#seat-rules').href=c.rulesUrl).catch(()=>$('#seat-rules').hidden=true);
refresh();const timer=setInterval(()=>{if(!document.hidden)refresh();},30000);addEventListener('pagehide',()=>clearInterval(timer));
