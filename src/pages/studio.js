import '../js/ai-budget.js';
import {mountRobotConsole} from '../js/robot-console.js';
import { initShell } from '../js/shell.js';
import { createStudioClient } from '../../campus/studio-client.js';
import { esc } from '../js/data.js';
import { loginURL } from '../js/hub.js';
import { mountCompanionStage } from '../js/companion-stage.js';
import { stageLines,stageTurn } from '../../campus/stage-catalog.js';
import '../styles/products.css';
import '../styles/studio.css';
initShell();const api=createStudioClient(),$=s=>document.querySelector(s),names={beikuang:'北矿娘 · 总监督',codex:'Codex · 工程席',design:'设计席 · 由 Codex 运行',deepseek:'DeepSeek · 调研席'},states={done:'检查完成',dispatched:'已交给执行器',rest:'稍后再看',site_work:'处理网站工作',queued:'等待执行',running:'协作中',completed:'讨论完成',needs_input:'需要补充信息',awaiting_review:'候选修改待你审核',checks_failed:'检查未通过',approved:'你已确认候选版本',cancelled:'已取消',failed:'执行失败',interrupted:'等待续接',reconnecting:'等待执行器恢复',waiting_jobs:'等待实际执行结果',needs_attention:'执行后仍有未解决项'};
let renderedRuns=[],room=null,currentRun=null,poll=0,roomGeneration=0,preferredRoom=null;const busy=s=>['queued','running','interrupted','reconnecting','waiting_jobs'].includes(s);
const stageRoot=document.createElement('div');stageRoot.className='studio-stage';$('#studio-messages').before(stageRoot);
let stage=null,stageRoom=null;
function renderStage(runs){
 if(stageRoom!==room){stage?.destroy();stage=mountCompanionStage(stageRoot,{seats:['beikuang','codex'],history:true});stageRoom=room;}
 stage?.update({lines:stageLines(runs),thinking:stageTurn(runs[0]),error:runs[0]?.state==='failed'});
}
window.addEventListener('pagehide',()=>{clearTimeout(poll);stage?.destroy();stage=null;stageRoom=null;});
window.addEventListener('pageshow',e=>{if(e.persisted&&room)openRoom(room);});
function status(msg){$('#studio-status').textContent=msg;}
function promptHTML(value){
 const full=String(value||''),title=full.split(/\r?\n/).find(s=>s.trim())?.slice(0,240)||'工作讨论';
 return `<h3>${esc(title)}</h3>${full.trim()!==title?`<details class="studio-prompt"><summary>查看任务上下文</summary><pre>${esc(full)}</pre></details>`:''}`;
}
async function rooms(){const r=await api.rooms();preferredRoom=r.preferredRoom||null;$('#studio-rooms').innerHTML=r.items.map(x=>`<button data-room="${esc(x.id)}" aria-pressed="${x.id===room}"><b>${esc(x.title)}</b><small>${esc(x.created.slice(0,10))}</small></button>`).join('')||'<p class="small-note">还没有房间。创建一个，开始讨论。</p>';}
function renderRuns(runs){renderStage(runs);renderedRuns=runs;currentRun=runs[0]||null;$('#studio-messages').innerHTML=[...runs].reverse().map(r=>`<section class="studio-run"><p class="section-label">${esc(states[r.state]||r.state)}</p>${promptHTML(r.prompt)}${r.workflow?`<details class="studio-artifact"><summary>任务交接与执行凭据 · 已完成 ${r.messages.length}/${r.rounds} 轮</summary><pre>${esc(JSON.stringify(r.workflow,null,2))}</pre></details>`:''}${r.messages.map(m=>`<article class="studio-message"><header><b>${esc(names[m.seat]||m.seat)}</b><span>${esc(m.provider)} · ${esc(m.model)}</span></header><div>${esc(m.body)}</div></article>`).join('')}${r.error?`<p class="studio-error">${esc(r.error)}</p>`:''}${r.artifact&&Object.keys(r.artifact).length?`<details class="studio-artifact"><summary>查看候选修改与检查记录</summary><pre>${esc(JSON.stringify(r.artifact,null,2))}</pre></details>${r.state==='awaiting_review'?`<form class="studio-approve product-form" data-run="${esc(r.id)}"><label class="check-line"><input name="reviewed" type="checkbox" required>我已检查候选内容及验证范围，知道这不等于完整功能验收。</label><button class="btn btn-secondary">确认这份候选版本</button><p role="status"></p></form>`:''}<p class="small-note">候选文件单独保存，未发布；完整功能与浏览器验收以记录为准。</p>`:''}</section>`).join('')||'<div class="product-empty"><h3>写下你的第一个想法。</h3><p>成员会按你选择的顺序参与讨论。</p></div>';const working=busy(currentRun?.state);$('#studio-start').disabled=working;$('#studio-stop').hidden=!working;}
async function openRoom(id){room=id;const generation=++roomGeneration;clearTimeout(poll);try{const r=await api.room(id);if(generation!==roomGeneration)return;$('#studio-room-title').textContent=r.title;$('#studio-form').hidden=false;renderRuns(r.runs);$('#studio-rooms').querySelectorAll('[data-room]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.room===id)));if(busy(currentRun?.state))poll=setTimeout(()=>{if(!document.hidden&&room===id)openRoom(id);},2200);}catch(e){status(e.message);}}
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&room)openRoom(room);else clearTimeout(poll);});
$('#studio-rooms').onclick=e=>{const b=e.target.closest('[data-room]');if(b)openRoom(b.dataset.room);};$('#studio-new').onclick=()=>$('#studio-create').showModal();$('#studio-create-close').onclick=()=>$('#studio-create').close();
$('#studio-create-form').onsubmit=async e=>{e.preventDefault();const f=e.currentTarget,b=f.querySelector('button'),v=Object.fromEntries(new FormData(f));b.disabled=true;try{const r=await api.createRoom({title:v.title,brief:v.brief,contextFiles:v.files.split(/\r?\n/).map(x=>x.trim()).filter(Boolean)});$('#studio-create').close();f.reset();room=r.id;await rooms();await openRoom(r.id);}catch(err){$('#studio-create-status').textContent=err.message;}finally{b.disabled=false;}};
$('#studio-form').onsubmit=async e=>{e.preventDefault();const f=e.currentTarget,v=Object.fromEntries(new FormData(f)),seats=[...f.querySelectorAll('[name=seat]:checked')].map(x=>x.value);if(!seats.length){status('请至少选择一位成员。');return;}$('#studio-start').disabled=true;try{const r=await api.start(room,{prompt:v.prompt,mode:v.mode,rounds:Number(v.rounds),seats});currentRun=r;status('工作已排队。若长时间停在等待状态，请确认本机工作进程已启动。');f.elements.prompt.value='';await openRoom(room);}catch(err){status(err.message);$('#studio-start').disabled=false;}};
$('#studio-stop').onclick=async()=>{if(!currentRun)return;try{await api.stop(currentRun.id);status('已请求停止，当前调用结束后不再继续。');await openRoom(room);}catch(e){status(e.message);}};
async function init(){const c=await api.capabilities();$('#studio-access').hidden=false;const robots=document.createElement('section');robots.className='robot-console';$('#studio-activity').after(robots);const stopRobots=mountRobotConsole(robots);window.addEventListener('pagehide',stopRobots,{once:true});status('仅本机站主可用。');$('#studio-members').innerHTML=c.members.map(m=>`<article class="studio-member"><span class="studio-avatar" data-seat="${esc(m.id)}">${m.id==='beikuang'?'<img src="/art/beikuang/avatar.png" alt="北矿娘" width="64" height="64" style="width:100%;height:100%;object-fit:cover;border-radius:inherit">':m.id==='deepseek'?'≈':m.id==='codex'?'<img src="/art/companions/codex-avatar-v1.png" alt="Codex" width="64" height="64" style="width:100%;height:100%;object-fit:cover;border-radius:inherit">' :'✦'}</span><h2>${esc(names[m.id]||m.name)}</h2><p>${esc(m.role)}</p><small>${m.ready?'已配置 · 登录有效性在调用时检查':esc(m.reason)}</small></article>`).join('');$('#studio-seats').insertAdjacentHTML('beforeend',c.members.map(m=>`<label><input type="checkbox" name="seat" value="${esc(m.id)}" ${m.ready&&['beikuang','codex'].includes(m.id)?'checked':m.ready?'':'disabled'}>${esc(names[m.id])}</label>`).join(''));$('#studio-budget').textContent=`DeepSeek 每日上限 ¥${c.dailyCnyLimit} · 今日预留 ¥${c.budget.reservedCny}。${c.costScope}`;await rooms();}
init().then(()=>{const id=new URLSearchParams(location.search).get('room')||preferredRoom||$('#studio-rooms [data-room]')?.dataset.room;void refreshActivity();if(id)return openRoom(id);}).catch(e=>{$('#studio-status').innerHTML=`${esc(e.message)} <a href="${esc(loginURL())}">登录站主账号 →</a>`;});

$('#studio-messages').addEventListener('submit',async e=>{
 const f=e.target.closest('.studio-approve');if(!f)return;e.preventDefault();
 const run=renderedRuns.find(x=>x.id===f.dataset.run),button=f.querySelector('button');
 if(!run?.artifact?.hash||!f.elements.reviewed.checked)return;
 button.disabled=true;
 try{await api.approve(run.id,run.artifact.hash,true);status('已记录你确认的候选版本，网站尚未发布。');await openRoom(room);}
 catch(err){f.querySelector('[role=status]').textContent=err.message;button.disabled=false;}
});

let activityTimer=0,activityBusy=false;
async function refreshActivity(){
 clearTimeout(activityTimer);if(document.hidden||activityBusy)return;activityBusy=true;
 try{
  const data=await api.activity(),team=data.team||{},inspection=team.inspection,discussion=team.discussion;
  $('#studio-activity').innerHTML=`<h2>她们正在做什么</h2><p>${esc(team.discussionReason||'正在读取原版自主状态')}</p>
   <p>原版阅读笔记 ${data.readingNotes??'—'} 条 · 学习记录 ${data.studySessions??'—'} 次</p>
   ${discussion?`<p><a href="studio.html?room=${esc(discussion.room)}">打开最近的主动讨论 →</a>${esc(states[discussion.state]||discussion.state)}</p>`:'<p class="small-note">还没有自主发起的讨论记录。</p>'}
   ${inspection?`<details><summary>网页巡检：${esc(states[inspection.state]||inspection.state)} · ${esc(inspection.at)}</summary><p>${esc(inspection.error||inspection.result?.scope||'等待执行')}</p><ul>${(inspection.result?.issues||[]).map(i=>`<li>${esc(i.path)} · ${i.width}px · ${esc(i.error||(i.overflow?'横向溢出':'图片或脚本异常'))}</li>`).join('')}</ul></details>`:''}
   <button class="btn btn-secondary" type="button" data-inspect ${team.actions?.includes('inspect_site')?'':'disabled'}>检查网页</button>
   <details><summary>她的最近决定与执行结果</summary><ul>${(data.decisions||[]).map(d=>`<li>${esc(d.action)}：${esc(d.reason)}</li>`).join('')||'<li>暂无新决定</li>'}</ul><ul>${(data.intentions||[]).map(i=>`<li>${esc(i.goal)}：${esc(states[i.status]||i.status)}</li>`).join('')}</ul></details>
   ${data.runtimeError?`<p role="status">${esc(data.runtimeError)}</p>`:''}`;
  await rooms();
 }catch(e){$('#studio-activity').textContent=e.message;}
 finally{activityBusy=false;activityTimer=setTimeout(refreshActivity,20000);}
}
$('#studio-activity').addEventListener('click',async e=>{const b=e.target.closest('[data-inspect]');if(!b)return;b.disabled=true;try{await api.inspect();await refreshActivity();}catch(error){status(error.message);b.disabled=false;}});
window.addEventListener('ai-budget-changed',()=>{void refreshActivity();api.capabilities().then(c=>{$('#studio-budget').textContent=`DeepSeek 每日上限 ¥${c.dailyCnyLimit} · 今日预留 ¥${c.budget.reservedCny}`;}).catch(e=>status(e.message));});
document.addEventListener('visibilitychange',()=>{if(document.hidden)clearTimeout(activityTimer);else if(!$('#studio-access').hidden)void refreshActivity();});
window.addEventListener('pagehide',()=>clearTimeout(activityTimer));
