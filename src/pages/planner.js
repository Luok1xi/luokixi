// Personal Campus: private plan reads and writes stay in IndexedDB on this device.
import { initShell, reducedMotion } from '../js/shell.js';
import { esc } from '../js/data.js';
import { normalizePlan, parseWeeks, dateOf, addDays, weekStart, occurrences, conflicts, calendarICS } from '../js/campus-plan.js';
import { mergeCampusPlans } from '../js/campus-merge.js';
import { prepareCampusData } from '../js/campus-geometry.js';
import { readPlan, writePlan, clearPlan, subscribePlan } from '../js/campus-store.js';
import '../styles/planner.css';
import '../styles/course-board.css';
import { createCourseBoard } from '../js/course-board.js';
import { placeTask, isFixed, reminderDue, mergeSchoolSchedule, previewPlacement, applyLocalPlacement, timeOf } from '../js/campus-schedule.js';
import { schoolBookmarklet, schoolOrigin, parseSchoolTable, fixedSchoolResult } from '../js/school-import.js';
import { createSharedSchedule, clubOccurrence, reservationOccurrence, appendSharedCalendar } from '../js/planner-shared.js';
import { hubState, loginURL } from '../js/hub.js';
initShell();
const $ = (selector) => document.querySelector(selector);
const TYPES = { course:'课程', personal:'个人日程', exam:'考试', activity:'校园活动', deadline:'作业截止', club:'社团训练', competition:'比赛', meeting:'会议' };
const DAYS = ['周日','周一','周二','周三','周四','周五','周六'];
const clone = (value) => structuredClone(value);
const id = () => crypto.randomUUID();
const dayName = (date) => DAYS[new Date(date+'T12:00:00Z').getUTCDay()];
const minutes = (time) => Number(time.slice(0,2))*60+Number(time.slice(3));
const safeURL = (value) => { try { const u=new URL(value); return /^https?:$/.test(u.protocol)&&!u.username&&!u.password ? u.href : ''; } catch { return ''; } };
const ext = (url,label) => safeURL(url) ? '<a class="btn btn-outline btn-sm" href="'+esc(safeURL(url))+'" target="_blank" rel="noopener noreferrer">'+esc(label)+' ↗</a>' : '';
const mapURL = (building,date='') => 'map.html?campus='+encodeURIComponent(building?.campus||'xueyuanlu')+(building?.osm?'&building='+encodeURIComponent(building.osm):'')+(date?'&date='+encodeURIComponent(date):'');
const params = new URLSearchParams(location.search);
let plan=normalizePlan(),revision=0,ready=false,invalidLocal=false,rawLocal,stale=false,busy=false,selected=dateOf();
try { const requested=params.get('date'); if(requested) { addDays(requested,0); selected=requested; } } catch { /* Invalid deep links keep today's usable plan. */ }
let editor=null,current=null,all=[],visible=[],catalogue=[],buildings=[],catalogueLoaded=false,placesLoaded=false,preview=null,imageURL=null,lastFile=null,reminders=false,toastTimer;
const warned=new Set();
function toast(text){ $('#cp-toast').textContent=text; $('#cp-toast').hidden=false; clearTimeout(toastTimer); toastTimer=setTimeout(()=>{$('#cp-toast').hidden=true;},5000); }
function status(text,error=false){ $('#cp-status').textContent=text; $('#cp-status').classList.toggle('is-error',error); if(error) toast(text);else {clearTimeout(toastTimer);$('#cp-toast').hidden=true;} }
function requireReady(){ if(!ready) throw new Error('本地数据库尚不可用。不会把私人日程退回到服务器或临时假保存。'); if(stale) throw new Error('另一个页面有新版本。请关闭编辑窗口后核对再修改，原数据未被覆盖。'); }
async function persist(next,message='已保存在此设备的本地数据库。',{repair=false}={}){
 requireReady(); if(invalidLocal&&!repair) throw new Error('旧数据需要修复。请先导出原数据，再导入有效备份。');
 if(busy) throw new Error('上一项保存还在进行，请稍等。');
 const checked=normalizePlan(next); checked.updated=new Date().toISOString(); busy=true;
 try { const saved=await writePlan(checked,revision); plan=saved.data; revision=saved.revision; invalidLocal=false; rawLocal=null; render(); status(message); toast(message); }
 catch(error){if(error.code==='conflict') stale=true; throw error;} finally{busy=false;}
}
function range(){const week=['week','cards'].includes(plan.settings.view);const first=week?weekStart(selected):selected;return[first,week?addDays(first,6):first];}
function weekNumber(date){if(!plan.term.starts)return null;const n=Math.floor((Date.parse(date)-Date.parse(plan.term.starts))/604800000)+1;return n>=1&&n<=plan.term.weeks?n:null;}
let sharedData={clubs:[],events:[],reservations:{items:[]}}, sharedSession={online:false,user:null}, selectedClub='', syncStatus='连接社团日程…',quickState=null,clubMode='create',sharedReady=false;
const shared=createSharedSchedule({changed:data=>{sharedData=data;sharedReady=true;if(!data.clubs.some(c=>c.id===selectedClub))selectedClub=data.clubs[0]?.id||'';syncStatus=data.clubs.length?'社团安排已同步':'';if(ready)render();},failed:e=>{syncStatus=e.status===401?'登录后同步社团安排':'社团服务暂时不可用';if(ready)render();}});
const managedClub=()=>sharedData.clubs.find(c=>c.id===selectedClub&&c.canManage);
const sharedEvents=()=>sharedData.events.map(clubOccurrence);
const reservationEvents=()=> (sharedData.reservations?.items||[]).filter(e=>e.date&&e.start&&e.end).map(reservationOccurrence);
const scheduledShared=(first,last)=>[...sharedEvents().filter(e=>!e.pending&&e.status!=='cancelled'),...reservationEvents()].filter(e=>e.date>=first&&e.date<=last);
function completeDay(date){return [...occurrences(plan,date,date),...scheduledShared(date,date)];}
function sharedChanges(placement){return placement.moves.map(m=>({id:m.item.sourceId,clubId:m.item.clubId,status:'scheduled',date:m.date,start:m.start,end:m.end}));}
async function moveSchedule(item,date,start,duration,options={}){
 if(item.source==='club'){
  if(!item.canManage)throw new Error('只有社长可以调整这个社团的活动。');
  if(options.unschedule){await shared.batch([{id:item.sourceId,clubId:item.clubId,status:'pending',duration}]);return true;}
  const placement=previewPlacement(completeDay(date),item,date,start,duration);if(!placement.ok)throw new Error(placement.message);
  await shared.batch(sharedChanges(placement));status('社团安排已同步。');return true;
 }
 if(options.unschedule)await persist(placeTask(plan,item,date,start,duration,options),'已放回本机待安排。');
 else{const placement=previewPlacement(completeDay(date),item,date,start,duration);if(!placement.ok)throw new Error(placement.message);await persist(applyLocalPlacement(plan,placement),'本机安排已更新。');}
 return true;
}
async function createClubTask(value){const club=managedClub();if(!club)throw new Error('先选择你管理的社团。');if(!value.title)throw new Error('写一个活动名称就好。');await shared.batch([{id:id(),clubId:club.id,title:value.title,location:value.location||'',duration:value.duration||60,status:'pending'}]);}
function quickFields(){const f=$('#cp-quick-form'),scheduled=f.elements.scheduled.checked;$('#cp-quick-time').hidden=!scheduled;for(const name of ['date','start','end'])f.elements[name].required=scheduled;f.elements.duration.disabled=scheduled;}
function openQuick(mode='club',item=null,seed={}){
 requireReady();const club=item?.source==='club'?sharedData.clubs.find(c=>c.id===item.clubId):sharedData.clubs.find(c=>c.id===selectedClub);
 if(mode==='club'&&!club){if(!sharedSession.user)return location.assign(loginURL());return openClubDialog();}
 if(mode==='club'&&!club.canManage)throw new Error('这个社团的活动由社长安排。');
 const f=$('#cp-quick-form');f.reset();quickState={mode,item,club};
 const value=item?.event||item||seed;f.elements.title.value=value.title||'';f.elements.location.value=value.location||'';
 selectCurrent(f.elements.duration,value.duration||(value.start&&value.end?minutes(value.end)-minutes(value.start):60),'保留原时长');
 f.elements.date.value=value.date||selected;f.elements.start.value=value.start||'09:00';f.elements.end.value=value.end||'10:00';
 f.elements.scheduled.checked=mode==='reservation'||Boolean(item&&!item.pending&&!item.event?.unscheduled)||seed.unscheduled===false;
 f.elements.scheduled.disabled=mode==='reservation';$('#cp-quick-schedule-label').hidden=mode==='reservation';
 $('#cp-quick-context').textContent=mode==='club'?club.name:mode==='reservation'?'本人已有预约':'保存在这台设备';
 $('#cp-quick-heading').textContent=item?'调整安排':mode==='reservation'?'记录已有预约':'安排事件';
 $('#cp-quick-note').textContent=mode==='club'?'保存后，所属社员的时间板会显示相同安排。':mode==='reservation'?'只记录你已在官方系统预约的时段；此处不会提交或验证预约。':'';
 $('#cp-quick-error').textContent='';$('#cp-quick-remove').hidden=!item||item.source==='reservation';$('#cp-quick-remove').textContent=mode==='club'?'取消活动':'删除记录';quickFields();$('#cp-quick').showModal();f.elements.title.focus();
}
async function showScheduleItem(item){
 if(!item)return;
 if(item.source==='club'){
  if(item.canManage)return openQuick('club',item);
  $('#cp-detail-title').textContent=item.clubName;$('#cp-detail-body').innerHTML=`<p class="cp-detail-time">${esc(item.title)}</p><p>${esc(item.pending?'尚未排期':item.date+' '+item.start+'–'+item.end)}</p>${item.location?'<p>'+esc(item.location)+'</p>':''}<p class="cp-fine">由社长安排 · 所属社员共享</p>`;$('#cp-detail').showModal();return;
 }
 if(item.source==='reservation'){$('#cp-detail-title').textContent=item.title;$('#cp-detail-body').innerHTML=`<p class="cp-detail-time">${esc(item.date+' '+item.start+'–'+item.end)}</p><p>${esc(item.location||'')}</p><p class="cp-fine">${esc(item.statusLabel||'本人提供的预约记录；未向学校核验。')}</p><a class="btn-link" href="reservations.html">查看预约助手 →</a>`;$('#cp-detail').showModal();return;}
 if(item.event?.tags?.includes('预约记录'))return openQuick('reservation',item);
 if(item.source==='event'&&!isFixed(item))return openQuick('local',item);
 return openDetail(item);
}
function openClubDialog(mode='create'){if(!sharedSession.user)return location.assign(loginURL());clubMode=mode;$('#cp-club-error').textContent='';const f=$('#cp-club-form');f.reset();f.elements.value.placeholder=mode==='create'?'输入社团名字':'粘贴社长给你的口令';f.elements.value.maxLength=mode==='create'?80:100;$('#cp-club-label').firstChild.textContent=mode==='create'?'社团名称':'邀请口令';$('#cp-club-note').textContent=mode==='create'?'创建后，你可以安排活动并邀请社员。':'加入后，这个社团的活动会显示在你的时间板。';f.querySelector('[type=submit]').textContent=mode==='create'?'创建':'加入';document.querySelectorAll('[data-club-mode]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.clubMode===mode)));if(!$('#cp-club-dialog').open)$('#cp-club-dialog').showModal();f.elements.value.focus();}
async function clubAction(action,value){try{
 if(action==='select'){selectedClub=value;render();return;}
 if(action==='login')return location.assign(loginURL());
 if(action==='manage')return openClubDialog();
 if(action==='reservation')return openQuick('reservation');
 if(action==='local')return openQuick('local');
 if(action==='invite'){const club=managedClub();if(!club)throw new Error('只有社长可以邀请社员。');$('#cp-invite-code').textContent='生成中…';$('#cp-invite-error').textContent='';$('#cp-invite-note').textContent=club.name;$('#cp-invite-dialog').showModal();try{const result=await shared.invite(club.id);$('#cp-invite-code').textContent=result.code;$('#cp-invite-note').textContent=club.name+' · 有效至 '+new Date(result.expiresAt).toLocaleDateString('zh-CN',{timeZone:'Asia/Shanghai'});}catch(e){$('#cp-invite-code').textContent='';$('#cp-invite-error').textContent=e.message;}}
 }catch(e){status(e.message,true);}}
$('#cp-quick-form').addEventListener('change',event=>{if(event.target.name==='scheduled')quickFields();if(event.target.name==='start'&&quickState?.mode!=='reservation'){const f=event.currentTarget,start=minutes(f.elements.start.value),duration=Number(f.elements.duration.value);if(start+duration<1440)f.elements.end.value=timeOf(start+duration);}});
$('#cp-quick-form').addEventListener('submit',async event=>{
 event.preventDefault();const f=event.target,button=f.querySelector('[type=submit]');button.disabled=true;
 try{const {mode,item,club}=quickState,title=f.elements.title.value.trim(),location=f.elements.location.value.trim(),scheduled=f.elements.scheduled.checked,date=f.elements.date.value,start=f.elements.start.value,end=f.elements.end.value,duration=scheduled?minutes(end)-minutes(start):Number(f.elements.duration.value);
  if(!title)throw new Error('请填写名称。');if(duration<15||duration>960)throw new Error('时长需要在 15 分钟至 16 小时之间。');
  if(mode==='club'){
   const source=item||{id:id(),source:'club',sourceId:'',clubId:club.id,clubName:club.name,title,canManage:true};source.sourceId ||= source.id;
   let changes=[{id:source.sourceId,clubId:club.id,title,location,status:scheduled?'scheduled':'pending',duration,...(scheduled?{date,start,end}:{})}];
   if(scheduled){const placement=previewPlacement(completeDay(date),source,date,minutes(start),duration);if(!placement.ok)throw new Error(placement.message);changes=[{...sharedChanges(placement)[0],title,location},...sharedChanges(placement).slice(1)];}
   await shared.batch(changes);
  }else{
   const next=clone(plan),source=item?.event||{},value={...source,id:source.id||id(),kind:source.kind||'personal',title,location,date,start:scheduled?start:'09:00',end:scheduled?end:timeOf(9*60+duration),unscheduled:!scheduled,repeat:source.repeat||'none',tags:mode==='reservation'?[...new Set([...(source.tags||[]),'预约记录'])]:source.tags||[],remindAtStart:true};
   if(source.repeat==='weekly'&&item?.id&&!source.unscheduled){value.id=id();value.repeat='none';value.until='';next.hiddenOccurrences=[...new Set([...next.hiddenOccurrences,item.id])];}
   const index=next.events.findIndex(e=>e.id===value.id);if(index<0)next.events.push(value);else next.events[index]=value;
   if(scheduled&&mode!=='reservation'){const proxy={...value,id:item?.id||'pending:'+value.id,source:'event',sourceId:value.id,event:value},placement=previewPlacement(completeDay(date),proxy,date,minutes(start),duration);if(!placement.ok)throw new Error(placement.message);await persist(applyLocalPlacement(next,placement),'本机安排已保存。');}
   else await persist(next,mode==='reservation'?'已有预约已记录；未向学校提交任何预约。':'已放入本机待安排。');
  }
  $('#cp-quick').close();
 }catch(e){$('#cp-quick-error').textContent=e.message;}finally{button.disabled=false;}
});
$('#cp-quick-remove').addEventListener('click',async()=>{try{const {item,mode,club}=quickState;if(!item)return;if(!confirm(mode==='club'?'取消这项活动？所属社员也会看到更新。':'删除这条本机记录？'))return;if(mode==='club')await shared.batch([{id:item.sourceId,clubId:club.id,status:'cancelled'}]);else{const next=clone(plan);next.events=next.events.filter(e=>e.id!==item.sourceId);await persist(next,'记录已删除。');}$('#cp-quick').close();}catch(e){$('#cp-quick-error').textContent=e.message;}});
$('#cp-club-dialog').addEventListener('click',event=>{const mode=event.target.closest('[data-club-mode]')?.dataset.clubMode;if(mode)openClubDialog(mode);});
$('#cp-club-form').addEventListener('submit',async event=>{event.preventDefault();const button=event.target.querySelector('[type=submit]');button.disabled=true;try{const value=event.target.elements.value.value.trim();if(clubMode==='create')await shared.create(value);else await shared.join(value);$('#cp-club-dialog').close();}catch(e){$('#cp-club-error').textContent=e.message;}finally{button.disabled=false;}});
$('#cp-invite-copy').addEventListener('click',async()=>{try{const value=$('#cp-invite-code').textContent;if(!value||value==='生成中…')return;await navigator.clipboard.writeText(value);$('#cp-invite-error').textContent='口令已复制。';}catch{$('#cp-invite-error').textContent='请选中口令手动复制。';}});
async function refreshShared(){if(!sharedSession.user||document.hidden||board.interacting||document.querySelector('#cp-quick[open],#cp-club-dialog[open]'))return;try{await shared.refresh();}catch{/* Local lessons remain available when the account service is offline. */}}
void hubState().then(async session=>{sharedSession=session;if(session.user)await refreshShared();else{syncStatus=session.online?'':'社团服务暂未连接';render();}});
const sharedTimer=setInterval(refreshShared,15000);addEventListener('visibilitychange',()=>{if(!document.hidden&&sharedSession.user)void refreshShared();});addEventListener('pagehide',()=>clearInterval(sharedTimer));

const board=createCourseBoard({root:$('#cp-days'),tray:$('#cp-task-tray'),move:moveSchedule,open:item=>void showScheduleItem(item),add:(kind,seed)=>openQuick('club',null,seed),error:text=>status(text,true),create:createClubTask,clubAction,begin:()=>status('')});
function render(){
 if(!['week','day'].includes(plan.settings.view))plan.settings.view='week';
 const [first,last]=range();all=[...occurrences(plan,first,last),...scheduledShared(first,last)];visible=all.filter(x=>x.source==='course'?plan.settings.showCourses:plan.settings.showEvents);
 const overlap=conflicts(all),view=plan.settings.view;
 $('#cp-date').value=selected;document.querySelectorAll('[data-view]').forEach(el=>el.setAttribute('aria-pressed',String(el.dataset.view===view)));
 const w=weekNumber(selected);$('#cp-term').textContent=plan.term.starts?(plan.term.label||'我的学期')+' · '+(w?'第 '+w+' 周':'非教学周'):'设置学期';
 $('#cp-no-term').hidden=Boolean(plan.term.starts||!plan.courses.some(c=>!c.hidden&&!c.cancelled));
 $('#cp-conflicts').innerHTML=overlap.length?'<details class="cp-conflict"><summary>'+overlap.length+' 处时间冲突</summary>'+overlap.map(p=>'<p>'+esc(p.date+' '+p.start+'—'+p.end+' · '+p.a.title+' / '+p.b.title)+'</p>').join('')+'</details>':'';
 board.render(plan,visible,selected,view,{clubs:sharedData.clubs,events:sharedEvents(),selectedClub,online:sharedSession.online,signedIn:Boolean(sharedSession.user),syncStatus,collisions:all});
 $('#cp-courses').innerHTML=plan.courses.length?'<div class="cp-rows">'+plan.courses.map(c=>'<article class="cp-row"><button class="cp-row-main" data-course-detail="'+esc(c.id)+'"><b>'+esc(c.name)+'</b><span>'+c.slots.map(s=>DAYS[s.day%7]+' '+s.start+'—'+s.end).join('；')+'</span><span>'+esc([c.teacher,c.room].filter(Boolean).join(' · '))+'</span></button><button class="btn-link" data-edit-course="'+esc(c.id)+'">'+(c.origin==='school'?'备注与提醒':'编辑')+'</button></article>').join('')+'</div>':'<p class="cp-fine">还没有课程。</p>';
 reminders=plan.settings.remindersEnabled;document.querySelectorAll('[data-plan-action="reminders"]').forEach(b=>{b.textContent=reminders?'提醒已开启':'开启提醒';b.setAttribute('aria-pressed',String(reminders));});
 $('#main').setAttribute('aria-busy','false');
}
function empty(title,text){return '<div class="cp-empty"><b>'+title+'</b><p>'+text+'</p></div>';}
function slotHTML(slot={id:id(),day:1,start:'08:00',end:'09:35'}){
 return '<div class="cp-slot" data-slot-id="'+esc(slot.id)+'"><div class="cp-slot-head"><label>星期<select name="slotDay">'+[1,2,3,4,5,6,7].map(day=>'<option value="'+day+'"'+(day===slot.day?' selected':'')+'>'+DAYS[day%7]+'</option>').join('')+'</select></label><button type="button" class="btn-link" data-remove-slot>移除</button></div><div class="cp-field-row"><label>开始<input type="time" name="slotStart" value="'+esc(slot.start)+'" required></label><label>结束<input type="time" name="slotEnd" value="'+esc(slot.end)+'" required></label></div></div>';
}
async function loadOptions(){
 if(!catalogueLoaded){try{const r=await fetch('data/courses.json');if(!r.ok)throw new Error();catalogue=(await r.json()).courses||[];catalogueLoaded=true;}catch{status('资料课程目录暂不可用，你仍可填写自己的课程。',true);}}
 if(!placesLoaded){
  const results=await Promise.allSettled(['xueyuanlu','shahe'].map(async campus=>{const r=await fetch('data/campus-map/'+campus+'.json');if(!r.ok)throw new Error();const data=prepareCampusData(await r.json());return(data.features||[]).filter(f=>f.properties?.name&&f.properties?.osm&&f.properties?.center&&!f.properties.context&&f.geometry?.type==='Polygon').map(f=>({campus,osm:f.properties.osm,name:f.properties.name,center:f.properties.center}));}));
  buildings=results.flatMap(r=>r.status==='fulfilled'?r.value:[]);placesLoaded=results.every(r=>r.status==='fulfilled');
 }
}
function selectCurrent(select,value,label){ if(![...select.options].some(x=>x.value===String(value))) select.insertAdjacentHTML('beforeend',option(String(value),label)); select.value=String(value); }
function option(value,label){return '<option value="'+esc(value)+'">'+esc(label)+'</option>';}
function editorFields(){
 const f=$('#cp-editor-form'),course=f.elements.kind.value==='course';
 $('#cp-course-fields').hidden=!course;$('#cp-event-fields').hidden=course;
 for(const field of $('#cp-course-fields').querySelectorAll('input,select'))field.disabled=!course;
 for(const field of $('#cp-event-fields').querySelectorAll('input,select,textarea'))field.disabled=course;
 for(const name of ['date','start','end'])f.elements[name].required=!course;
 f.elements.until.disabled=course||f.elements.repeat.value!=='weekly';f.elements.until.required=!course&&f.elements.repeat.value==='weekly';
 f.elements.repeat.disabled=course||Boolean(editor?.once);
 const locked=course&&editor?.source?.origin==='school'||!course&&editor?.source?.fixed;
 if(locked){for(const name of ['title','teacher','room','weeks','weekMode','date','start','end','repeat','until','unscheduled'])f.elements[name].disabled=true;for(const input of $('#cp-slots').querySelectorAll('input,select,button'))input.disabled=true;$('[data-plan-action="add-slot"]').disabled=true;}else{$('[data-plan-action="add-slot"]').disabled=false;}
f.elements.title.maxLength=course?80:160;
}
async function openEditor(type='personal',sourceId=null,once=null,seed=null){
 requireReady();if(once&&isFixed(once))throw new Error('学校课程时间已锁定，请导入学校最新课表更新。');$('#cp-detail').close();await loadOptions();const f=$('#cp-editor-form');f.reset();for(const field of f.querySelectorAll('input,select,textarea,button'))field.disabled=false;
 const source=type==='course'?plan.courses.find(c=>c.id===sourceId):plan.events.find(e=>e.id===sourceId);
 const value=seed||source||once?.event||once?.course||{};
 editor={type,sourceId,once,source};
 $('#cp-editor-title').textContent=once?'修改这一次安排':source?'编辑整组安排':'添加安排';
 f.elements.kind.disabled=Boolean(source||once);f.elements.kind.value=once?(once.source==='course'?'personal':once.kind):type;
 f.elements.title.value=once?.title||value.name||value.title||'';
 for(const field of ['teacher','room','floor','notes','participants','projectURL','registrationURL','sourceURL'])f.elements[field].value=value[field]||'';
 f.elements.weeks.value=value.weeks?.join(',')||'';f.elements.weekMode.value=value.weekMode||'all';
 f.elements.date.value=once?.date||value.date||selected;f.elements.start.value=once?.start||value.start||'09:00';f.elements.end.value=once?.end||value.end||'10:00';
 f.elements.location.value=once?.location||value.location||'';f.elements.unscheduled.checked=Boolean(value.unscheduled);f.elements.unscheduled.disabled=type==='course';
 f.elements.repeat.value=once?'none':value.repeat||'none';f.elements.until.value=once?'':value.until||'';
 f.elements.color.value=value.color||(type==='course'?'#0071e3':'#8c55c7');f.elements.tags.value=value.tags?.join(',')||'';f.elements.priority.value=value.priority||'normal';selectCurrent(f.elements.reminderMinutes,value.remindAtStart?-2:value.reminderMinutes??(source?-1:-2),'提前 '+value.reminderMinutes+' 分钟');
 f.elements.catalogueCourse.innerHTML=option('','暂不关联')+catalogue.map(c=>option(c.id,c.name)).join('');
 if(value.courseId&&type==='course'&&!catalogue.some(c=>c.id===value.courseId))f.elements.catalogueCourse.insertAdjacentHTML('beforeend',option(value.courseId,'保留原课程编号：'+value.courseId));
 f.elements.catalogueCourse.value=value.courseId||'';
 f.elements.localCourse.innerHTML=option('','不关联')+plan.courses.map(c=>option(c.id,c.name)).join('');if(type!=='course'){ const localId=once?.source==='course'?once.sourceId:value.courseId||''; if(localId&&!plan.courses.some(c=>c.id===localId))f.elements.localCourse.insertAdjacentHTML('beforeend',option(localId,'保留原关联：'+localId)); f.elements.localCourse.value=localId; }
 const original=value.building||once?.building; if(original&&!buildings.some(b=>b.campus===original.campus&&b.osm===original.osm))buildings.push(original);
 f.elements.building.innerHTML=option('','暂不定位')+buildings.map(b=>option(b.campus+'|'+b.osm,(b.campus==='shahe'?'沙河':'学院路')+' · '+b.name)).join('');
 f.elements.building.value=original?original.campus+'|'+original.osm:'';
 $('#cp-slots').innerHTML=(type==='course'&&source?source.slots:[{id:id(),day:1,start:'08:00',end:'09:35'}]).map(slotHTML).join('');
 $('#cp-editor-error').textContent='';editorFields();$('#cp-editor').showModal();f.elements.title.focus();
}
function sharedFields(f,value={}){

 const out={...value,building:clone(buildings.find(b=>b.campus+'|'+b.osm===f.elements.building.value)||null),floor:f.elements.floor.value.trim(),notes:f.elements.notes.value,tags:[...new Set(f.elements.tags.value.split(/[,，、]/).map(t=>t.trim()).filter(Boolean))],priority:f.elements.priority.value,color:f.elements.color.value};
 const reminder=Number(f.elements.reminderMinutes.value);out.remindAtStart=reminder===-2;if(reminder<0)delete out.reminderMinutes;else out.reminderMinutes=reminder;return out;
}
$('#cp-editor-form').addEventListener('change',editorFields);
$('#cp-editor-form').addEventListener('submit',async event=>{
 event.preventDefault();const button=event.target.querySelector('[type=submit]');button.disabled=true;
 try{const f=event.target,next=clone(plan),type=f.elements.kind.value;
  if(type==='course'){
   const value={...sharedFields(f,editor.source),id:editor.sourceId||id(),name:f.elements.title.value.trim(),teacher:f.elements.teacher.value.trim(),room:f.elements.room.value.trim(),courseId:f.elements.catalogueCourse.value,slots:[...$('#cp-slots').querySelectorAll('[data-slot-id]')].map(row=>({id:row.dataset.slotId,day:Number(row.querySelector('[name=slotDay]').value),start:row.querySelector('[name=slotStart]').value,end:row.querySelector('[name=slotEnd]').value})),weekMode:f.elements.weekMode.value};
   if(editor.source?.origin==='school'){for(const key of ['name','teacher','room','slots','weeks','weekMode','origin','sourceURL'])value[key]=clone(editor.source[key]);}
   const weeks=editor.source?.origin==='school'?editor.source.weeks:parseWeeks(f.elements.weeks.value,plan.term.weeks);if(weeks)value.weeks=weeks;else delete value.weeks;
   const index=next.courses.findIndex(c=>c.id===value.id);if(index<0)next.courses.push(value);else next.courses[index]=value;
  }else{
   const value={...sharedFields(f,!editor.once?editor.source:editor.once.event||editor.once.course),id:!editor.once&&editor.sourceId?editor.sourceId:id(),title:f.elements.title.value.trim(),kind:type,unscheduled:f.elements.unscheduled.checked,date:f.elements.date.value,start:f.elements.start.value,end:f.elements.end.value,location:f.elements.location.value.trim(),repeat:editor.once?'none':f.elements.repeat.value,until:!editor.once&&f.elements.repeat.value==='weekly'?f.elements.until.value:'',courseId:f.elements.localCourse.value,participants:f.elements.participants.value.trim(),sourceURL:f.elements.sourceURL.value.trim(),registrationURL:f.elements.registrationURL.value.trim(),projectURL:f.elements.projectURL.value.trim(),hidden:!editor.once&&Boolean(editor.source?.hidden),cancelled:!editor.once&&Boolean(editor.source?.cancelled)};
   if(editor.source?.fixed){for(const key of ['title','date','start','end','repeat','until','fixed','unscheduled'])value[key]=clone(editor.source[key]);}
   const index=next.events.findIndex(e=>e.id===value.id);if(index<0)next.events.push(value);else next.events[index]=value;
   if(editor.once&&!next.hiddenOccurrences.includes(editor.once.id))next.hiddenOccurrences.push(editor.once.id);
  }
  await persist(next,editor.once?'这一次已调动，其余重复安排保持原样。':'安排已保存。');$('#cp-editor').close();
 }catch(error){$('#cp-editor-error').textContent=error.message;}finally{button.disabled=false;}
});
function openSettings(){
 requireReady();const f=$('#cp-settings-form');f.elements.campus.value=plan.profile.campus==='shahe'?'shahe':'xueyuanlu';f.elements.label.value=plan.term.label;f.elements.starts.value=plan.term.starts;f.elements.weeks.value=plan.term.weeks;
 for(const name of ['hideWeekend','showCourses','showEvents','compact'])f.elements[name].checked=plan.settings[name];selectCurrent(f.elements.reminderMinutes,plan.settings.reminderMinutes,'提前 '+plan.settings.reminderMinutes+' 分钟');$('#cp-settings-error').textContent='';$('#cp-settings').showModal();
}
$('#cp-settings-form').addEventListener('submit',async event=>{event.preventDefault();try{const f=event.target,next=clone(plan);next.profile.campus=f.elements.campus.value;next.term={label:f.elements.label.value.trim(),starts:f.elements.starts.value,weeks:Number(f.elements.weeks.value)};for(const name of ['hideWeekend','showCourses','showEvents','compact'])next.settings[name]=f.elements[name].checked;next.settings.reminderMinutes=Number(f.elements.reminderMinutes.value);await persist(next,'学期与显示已保存。');$('#cp-settings').close();}catch(error){$('#cp-settings-error').textContent=error.message;}});
function courseLinks(course){
 if(!course)return '';
 const catalogueCourse=catalogue.find(c=>c.id===course.courseId);
 return '<div class="cp-actions"><a class="btn btn-outline btn-sm" href="materials.html?q='+encodeURIComponent(catalogueCourse?.name||course.name)+'">查找相关资料 →</a><a class="btn btn-outline btn-sm" href="'+(catalogueCourse?'reputation.html?course='+encodeURIComponent(catalogueCourse.id):'reputation.html?view=courses')+'">课程评价 →</a>'+ext('https://jwc.cumtb.edu.cn/jwwebxt.htm','学校教务入口')+'</div>'+(catalogueCourse?'':'<p class="cp-fine">这门课未关联本站公开课程目录；评价入口先进入课程目录，不会虚构开课关系。</p>');
}
async function openDetail(occurrenceOrId,sourceType='',sourceId=''){
 await loadOptions();let item=typeof occurrenceOrId==='object'?occurrenceOrId:all.find(x=>x.id===occurrenceOrId);
 if(!item&&sourceType){const source=sourceType==='course'?plan.courses.find(c=>c.id===sourceId):plan.events.find(e=>e.id===sourceId);if(!source)return;item={source:sourceType,sourceId,title:source.name||source.title,kind:sourceType==='course'?'course':source.kind,location:[source.building?.name,source.room||source.location,source.floor].filter(Boolean).join(' · '),building:source.building,[sourceType]:source};}
 if(!item)return status('安排已变动，请重新选择。',true);current=item;const source=item.course||item.event||{},course=item.course||plan.courses.find(c=>c.id===source.courseId);
 const next=occurrences(plan,item.date||selected,addDays(item.date||selected,7)).find(x=>x.id!==item.id&&(x.date>(item.date||selected)||x.start>=(item.end||'00:00')));
 $('#cp-detail-title').textContent=item.title;
 $('#cp-detail-body').innerHTML=(item.date?'<p class="cp-detail-time">'+esc(item.date)+' '+dayName(item.date)+' · '+esc(item.start)+'—'+esc(item.end)+'</p>':'')+'<p class="cp-fine">'+TYPES[item.kind]+' · '+esc(item.location||'地点待填写')+'</p><p class="cp-fine">此信息来自你的本地课程表与个人日程。</p>'+(source.teacher?'<p>教师：'+esc(source.teacher)+'</p>':'')+(source.floor?'<p>楼层：'+esc(source.floor)+'（本人填写）</p>':'')+(source.notes?'<p class="cp-detail-notes">'+esc(source.notes)+'</p>':'')+(source.tags?.length?'<p class="cp-tags">'+source.tags.map(t=>'<span>'+esc(t)+'</span>').join('')+'</p>':'')+(source.participants?'<p>参与人员：'+esc(source.participants)+'</p>':'')+'<div class="cp-actions">'+(item.building?'<a class="btn btn-primary btn-sm" href="'+esc(mapURL(item.building,item.date))+'">教室位置与地图导航 →</a>':'<a class="btn btn-outline btn-sm" href="map.html">在地图关联地点 →</a>')+ext(source.sourceURL,'查看官方／原始来源')+ext(source.registrationURL,'报名入口')+ext(source.projectURL,'相关项目')+'</div>'+courseLinks(course)+(next?'<div class="cp-next"><small>接下来</small><b>'+esc(next.title)+'</b><p>'+esc(next.date+' '+next.start+' · '+(next.location||'地点待填写'))+'</p><button class="btn-link" data-next-occ="'+esc(next.id)+'" data-next-date="'+next.date+'">查看下一项 →</button></div>':'')+'<div class="cp-actions">'+(item.id&&!isFixed(item)?'<button class="btn btn-outline btn-sm" data-plan-action="edit-one">调动这一次</button><button class="btn btn-outline btn-sm" data-plan-action="hide-one">停课／隐藏这一次</button>':'')+'<button class="btn btn-outline btn-sm" data-plan-action="edit-group">编辑整组</button><button class="btn btn-outline btn-sm" data-plan-action="hide-group">隐藏整组</button><button class="btn-link" data-plan-action="cancel-group">'+(item.source==='course'?'整门停课':'取消安排')+'</button><button class="btn-link" data-plan-action="delete-group">删除整组</button></div><p class="cp-fine">调动单次会保留原安排并新建替代事件；隐藏与停课均可恢复。</p>';
 if(!$('#cp-detail').open)$('#cp-detail').showModal();
}
function openHidden(){
 const rows=[];for(const [source,list] of [['course',plan.courses],['event',plan.events]])for(const item of list.filter(x=>x.hidden||x.cancelled))rows.push('<article class="cp-row"><div><b>'+esc(item.name||item.title)+'</b><p>'+esc(item.cancelled?'停课／已取消':'整组隐藏')+'</p></div><button class="btn-link" data-restore="'+esc(item.id)+'" data-source="'+source+'">恢复</button></article>');

 const byDate=new Map();for(const hiddenId of plan.hiddenOccurrences){const date=hiddenId.slice(-10);if(!byDate.has(date))byDate.set(date,new Map(occurrences(plan,date,date,{includeHidden:true}).map(x=>[x.id,x])));const item=byDate.get(date).get(hiddenId);rows.push('<article class="cp-row"><div><b>'+esc(item?.title||'原安排已变动')+'</b><p>'+esc(date)+' · 单次隐藏</p></div><button class="btn-link" data-restore="'+esc(hiddenId)+'" data-source="once">恢复</button></article>');}
 $('#cp-hidden-body').innerHTML=rows.length?'<div class="cp-rows">'+rows.join('')+'</div>':empty('没有隐藏或停课安排。','停课与调课记录不会删除整组课程。');if(!$('#cp-hidden').open)$('#cp-hidden').showModal();
}
function download(content,filename,type){
 const url=URL.createObjectURL(new Blob([content],{type})),link=Object.assign(document.createElement('a'),{href:url,download:filename});document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
}
function showPreview(result,{full=false,raw=null}={}){
 const courses=result.courses||[],events=result.events||[];
 if(!courses.length&&!events.length&&!full)throw new Error('没有可导入的课程或日程。');
 let merged,mergeError='';try{merged=mergeCampusPlans(plan,result);}catch(error){if(!full)throw error;mergeError=error.message;}
 const next=full?normalizePlan(raw):merged.plan;
 preview={result,full,raw,next,revision};
 $('#cp-import-preview').innerHTML='<section class="cp-preview"><h3>先核对，再加入</h3><p>'+courses.length+' 门课程 · '+events.length+' 项事件 · '+(full?'完整 JSON 备份，可合并或替换':result.school?'学校课程，确认后更新':'个人日程，合并后保留现有安排')+'</p>'+(result.school?'<label class="cp-check"><input type="checkbox" id="cp-replace-school" checked>更新学校课表，保留个人安排与手动课程</label>':'')+[...(result.warnings||[]),...(merged?.warnings||[]),...(mergeError?['暂不能合并：'+mergeError+'；可用完整备份替换。']:[])].map(w=>'<p class="notice">'+esc(w)+'</p>').join('')+'<div class="cp-rows">'+courses.map(c=>'<article class="cp-row"><div><b>'+esc(c.name)+'</b><p>'+c.slots.map(s=>DAYS[s.day%7]+' '+esc(s.start)+'—'+esc(s.end)).join('；')+'</p><p>'+esc([c.teacher,c.room].filter(Boolean).join(' · '))+'</p></div></article>').join('')+events.map(e=>'<article class="cp-row"><div><b>'+esc(e.title)+'</b><p>'+esc(e.date+' '+e.start+'—'+e.end+' · '+e.location)+'</p></div></article>').join('')+'</div><div class="cp-actions"><button class="btn btn-primary" data-plan-action="confirm-import"'+(mergeError?' disabled':'')+'>确认合并</button>'+(full?'<button class="btn btn-outline" data-plan-action="replace-import">用备份替换</button>':'')+'</div><p class="cp-fine">更新学校课表只替换先前导入的学校课程；取消勾选则合并。个人安排与手动课程保留。</p></section>';
}
function importKind(result){return $('#cp-import-source').value==='school'?fixedSchoolResult(result):result;}
function mergeImported(base,result){
 const starts=$('#cp-import-starts').value,weeks=Number($('#cp-import-weeks').value);
 if(result.courses?.length&&!starts)throw new Error('请填写第一教学周的周一。');
 const next=result.school&&$('#cp-replace-school')?.checked?mergeSchoolSchedule(base,result):mergeCampusPlans(base,result).plan;
 if(starts)next.term={...next.term,starts,weeks};
 return normalizePlan(next);
}
function importOptions(){const columnMap={};for(const key of ['title','weekday','date','start','end','teacher','room','weeks']){const value=$('#cp-column-'+key)?.value.trim();if(value)columnMap[key]=value;}return {term:{...plan.term,starts:$('#cp-import-starts').value||plan.term.starts,weeks:Number($('#cp-import-weeks').value)||plan.term.weeks},columnMap,periods:Object.fromEntries(($('#cp-period-times')?.value||'').split('\n').map((v,i)=>[i+1,v.trim()])),sheetName:$('#cp-sheet-name')?.value.trim()||undefined};}
async function parseFile(file){
 $('#cp-import-error').textContent='';preview=null;$('#cp-import-preview').innerHTML='';
 if(!file)return;lastFile=file;
 try{
  if(file.size>5*1024*1024)throw new Error('文件超过 5 MB，请拆分或导出为 CSV。');
  if(/\.school\.json$/i.test(file.name)){showPreview(parseSchoolTable(JSON.parse(await file.text()),importOptions()));}
  else if(/\.json$/i.test(file.name)){ const {parseCampusImport}=await import('../js/campus-import.js'); await parseCampusImport(file); const raw=JSON.parse(await file.text()),checked=normalizePlan(raw);if(raw.version!==1||!Array.isArray(raw.courses))throw new Error('请使用本站校园数据 JSON 备份。');showPreview({...checked,warnings:['完整备份包含个人资料、收藏与设置；只有“用备份替换”会恢复它们。']},{full:true,raw:checked});}
  else{const {parseCampusImport}=await import('../js/campus-import.js');showPreview(importKind(await parseCampusImport(file,importOptions())));}
 }catch(error){$('#cp-import-error').textContent='未导入，原数据保留：'+error.message;}
}
async function restoreLatest(){try{const saved=await readPlan();plan=saved.data;revision=saved.revision;invalidLocal=!!saved.corrupt;rawLocal=saved.raw;stale=false;render();status(invalidLocal?'原数据损坏，已保留。请导出后修复或导入有效备份。':'已读取另一页面的新版本。',invalidLocal);}catch(e){status(e.message,true);}}
async function action(name){
 if(['privacy','import','export','calendar','sample','persist-storage','clear'].includes(name)&&!ready&&name!=='export')requireReady();
 if(name==='add')return openQuick('club');
 if(name==='add-course')return openEditor('course');
 if(name==='add-competition')return openEditor('competition');
 if(name==='settings')return openSettings();
 if(name==='hidden')return openHidden();
 if(name==='privacy')return $('#cp-privacy-dialog').showModal();
 if(name==='import'){if(!$('#cp-import-dialog').open){$('#cp-import-starts').value=plan.term.starts;$('#cp-import-weeks').value=plan.term.weeks;}preview=null;$('#cp-import-preview').innerHTML='';$('#cp-import-error').textContent='';return $('#cp-import-dialog').showModal();}
 if(name==='add-slot'){$('#cp-slots').insertAdjacentHTML('beforeend',slotHTML());editorFields();return;}
 if(name==='today'){selected=dateOf();render();return;}
 if(name==='previous'||name==='next'){selected=addDays(selected,(name==='next'?1:-1)*(['week','cards'].includes(plan.settings.view)?7:1));render();return;}
 if(name==='export')return download(invalidLocal?(typeof rawLocal==='string'?rawLocal:JSON.stringify(rawLocal,null,2)):JSON.stringify(plan,null,2),'luokixi-我的校园-'+dateOf()+'.json','application/json;charset=utf-8');
 if(name==='calendar'){requireReady();download(appendSharedCalendar(calendarICS(plan),[...sharedEvents(),...reservationEvents()]),'luokixi-我的校园-'+dateOf()+'.ics','text/calendar;charset=utf-8');status('已导出。请导入系统日历，并核对时区与提醒；更新后需重新导入。');return;}
 if(name==='sample'){const {sampleCSV}=await import('../js/campus-import.js');return download(sampleCSV(),'luokixi-课程表模板.csv','text/csv;charset=utf-8');}
 if(name==='reparse-file'){if(!lastFile)throw new Error('请先选择要导入的文件。');return parseFile(lastFile);}
 if(name==='parse-text'){preview=null;$('#cp-import-preview').innerHTML='';$('#cp-import-error').textContent='';try{const {parseCampusText}=await import('../js/campus-import.js');showPreview(importKind(await parseCampusText($('#cp-import-text').value,importOptions())));}catch(error){$('#cp-import-error').textContent='未导入：'+error.message;}return;}
 if(name==='confirm-import'||name==='replace-import'){
  if(!preview)throw new Error('请重新解析文件。');if(preview.revision!==revision||stale)throw new Error('预览后本机计划发生变化，请关闭窗口，重新核对和解析。');
  if(name==='replace-import'&&!confirm('用完整备份替换课程、日程、个人资料和收藏？建议先导出当前数据。'))return;
  const next=name==='replace-import'?normalizePlan(preview.raw):mergeImported(plan,preview.result);
  await persist(next,name==='replace-import'?'完整校园备份已恢复。':'已合并导入，原课程和日程保留。',{repair:name==='replace-import'});preview=null;$('#cp-import-dialog').close();return;
 }
 if(name==='persist-storage'){const retained=await navigator.storage?.persist?.();status(retained?'浏览器已允许尽量保留本机数据，仍建议导出备份。':'浏览器未授予持久存储。你的数据仍在本机，请定期导出备份。');return;}
 if(name==='clear'){requireReady();if(!confirm('清除这个浏览器的全部校园课程、日程、收藏、到访与设置？请先导出备份。'))return;if(stale||busy)throw new Error('请先核对新版本。');const saved=await clearPlan(revision);plan=saved.data;revision=saved.revision;invalidLocal=false;rawLocal=null;warned.clear();render();$('#cp-privacy-dialog').close();status('本地校园数据已清除，公共投稿与社区账号保留。');return;}
 if(name==='reminders'){
  reminders=!plan.settings.remindersEnabled;
  if(reminders&&'Notification'in window&&Notification.permission==='default')await Notification.requestPermission();
  const n=clone(plan);n.settings.remindersEnabled=reminders;await persist(n,reminders?'提醒已开启。关闭网页后可用系统日历提醒。':'提醒已关闭。');
  status(reminders?'此页打开时会检查提醒；关闭网页后请使用系统日历。':'此页提醒已关闭。');checkReminders();return;
 }
 if(!current)return;
 if(name==='edit-one')return openEditor(current.kind==='course'?'personal':current.kind,null,current);
 if(name==='edit-group')return openEditor(current.source==='course'?'course':current.kind,current.sourceId);
 const next=clone(plan),list=current.source==='course'?next.courses:next.events,source=list.find(x=>x.id===current.sourceId);
 if(!source)return;
 if(name==='hide-one'){if(!current.id)return;next.hiddenOccurrences=[...new Set([...next.hiddenOccurrences,current.id])];}
 else if(name==='hide-group')source.hidden=true;
 else if(name==='cancel-group')source.cancelled=true;

 else if(name==='delete-group'){if(!confirm('删除这一整组安排？其他课程与事件保留。'))return;const field=current.source==='course'?'courses':'events';next[field]=list.filter(x=>x.id!==source.id);next.hiddenOccurrences=next.hiddenOccurrences.filter(v=>!(v.startsWith(current.source+':'+encodeURIComponent(source.id)+':')));}
 else return;
 await persist(next,'安排已更新。隐藏或停课可在管理中恢复。');$('#cp-detail').close();
}
document.addEventListener('click',async event=>{
 const close=event.target.closest('[data-plan-close]');if(close)return close.closest('dialog').close();
 try{
  const restore=event.target.closest('[data-restore]');if(restore){const next=clone(plan);if(restore.dataset.source==='once')next.hiddenOccurrences=next.hiddenOccurrences.filter(x=>x!==restore.dataset.restore);else{const source=(restore.dataset.source==='course'?next.courses:next.events).find(x=>x.id===restore.dataset.restore);source.hidden=false;source.cancelled=false;}await persist(next,'安排已恢复。');return openHidden();}
  const occ=event.target.closest('[data-occ]');if(occ)return await openDetail(occ.dataset.occ);
  const today=event.target.closest('[data-open-today]');if(today){const row=occurrences(plan,dateOf(),dateOf()).find(x=>x.id===today.dataset.openToday);return await openDetail(row);}
  const next=event.target.closest('[data-next-occ]');if(next){const row=occurrences(plan,next.dataset.nextDate,next.dataset.nextDate).find(x=>x.id===next.dataset.nextOcc);return await openDetail(row);}
  const c=event.target.closest('[data-edit-course]');if(c)return await openEditor('course',c.dataset.editCourse);
  const e=event.target.closest('[data-edit-event]');if(e)return await openEditor(plan.events.find(x=>x.id===e.dataset.editEvent)?.kind||'personal',e.dataset.editEvent);
  const cd=event.target.closest('[data-course-detail]');if(cd)return await openDetail(null,'course',cd.dataset.courseDetail);
  const ed=event.target.closest('[data-event-detail]');if(ed)return await openDetail(null,'event',ed.dataset.eventDetail);
  const view=event.target.closest('[data-view]')?.dataset.view;if(view){const n=clone(plan);n.settings.view=view;if(view==='day'&&event.target.closest('.cp-overview'))selected=dateOf();return await persist(n,'已切换视图。');}
  const name=event.target.closest('[data-plan-action]')?.dataset.planAction;if(name){event.target.closest('.cp-tools')?.removeAttribute('open');await action(name);}
 }catch(error){status(error.message,true); if($('#cp-import-dialog').open)$('#cp-import-error').textContent=error.message;}
});
$('#cp-slots').addEventListener('click',e=>e.target.closest('[data-remove-slot]')?.closest('.cp-slot').remove());
$('#cp-date').addEventListener('change',e=>{if(e.target.value){selected=e.target.value;render();}});
$('#cp-import').addEventListener('change',async e=>{await parseFile(e.target.files[0]);e.target.value='';});
$('#cp-import-image').addEventListener('change',e=>{
 const file=e.target.files[0];if(!file)return;if(file.size>10*1024*1024||!/^image\/(?:png|jpeg|webp)$/.test(file.type)){status('请选择不超过 10 MB 的 PNG、JPG 或 WebP 截图。',true);e.target.value='';return;}
 if(imageURL)URL.revokeObjectURL(imageURL);imageURL=URL.createObjectURL(file);$('#cp-image-preview').src=imageURL;$('#cp-image-preview').hidden=false;e.target.value='';
});
$('#cp-import-dialog').addEventListener('close',()=>{if(imageURL)URL.revokeObjectURL(imageURL);imageURL=null;$('#cp-image-preview').removeAttribute('src');$('#cp-image-preview').hidden=true;$('#cp-import-text').value='';preview=null;lastFile=null;});
subscribePlan(saved=>{
 if(busy||saved.revision===revision)return;
 if(document.querySelector('dialog[open]')){stale=true;status('另一个页面修改了计划。请关闭编辑窗口后核对新版本，避免覆盖。',true);return;}
 plan=saved.data;revision=saved.revision;invalidLocal=!!saved.corrupt;rawLocal=saved.raw;render();status('已同步此设备另一页面的更改。');
});
document.querySelectorAll('.cp-dialog').forEach(d=>d.addEventListener('close',()=>{if(stale&&!document.querySelector('dialog[open]'))void restoreLatest();}));
function checkReminders(){
 if(!ready||!plan.settings.remindersEnabled||invalidLocal)return;const now=Date.now();
 for(const row of [...occurrences(plan,addDays(dateOf(),-1),addDays(dateOf(),1)),...scheduledShared(addDays(dateOf(),-1),addDays(dateOf(),1))]){if(!reminderDue(row,plan.settings,now))continue;
 const key=row.id+':'+row.start;if(warned.has(key))continue;warned.add(key);const text=row.title+' · '+row.start+(row.location?' · '+row.location:'');toast(text);
 if('Notification'in window&&Notification.permission==='granted'){try{new Notification('Luokixi · 日程提醒',{body:text,tag:key});}catch{/* In-page reminder still works when system notifications are unavailable. */}}
 }
}
setInterval(checkReminders,15000);addEventListener('visibilitychange',()=>{if(!document.hidden)checkReminders();});
$('#cp-school-bookmark').href=schoolBookmarklet(location.origin);
let pendingSchoolPayload=null;
addEventListener('message',event=>{
 if(!params.has('school-import')||event.source!==window.opener||!schoolOrigin(event.origin)||event.data?.type!=='luokixi:school-table'||event.data.payload?.origin!==event.origin)return;
 pendingSchoolPayload=event.data.payload;void receiveSchool();
});
async function receiveSchool(){if(!ready||!pendingSchoolPayload)return;try{await action('import');showPreview(parseSchoolTable(pendingSchoolPayload,importOptions()));$('#cp-school-transfer').textContent='已从学校页面提取，请核对后导入。';}catch(e){$('#cp-import-error').textContent=e.message;$('#cp-school-transfer').textContent='已收到课表，需要补充识别设置。';}}
$('#cp-period-times').addEventListener('change',()=>{if(pendingSchoolPayload)void receiveSchool();});
if(params.has('school-import')&&window.opener){let attempts=0;const ping=setInterval(()=>{window.opener.postMessage({type:'luokixi:school-ready'},'*');if(pendingSchoolPayload||++attempts>40)clearInterval(ping);},250);}
try{
 const saved=await readPlan();plan=saved.data;revision=saved.revision;invalidLocal=!!saved.corrupt;rawLocal=saved.raw;ready=true;if(saved.revision===0&&matchMedia('(max-width:600px)').matches)plan.settings.view='day';if(['week','day'].includes(params.get('view')))plan.settings.view=params.get('view');render();void receiveSchool();checkReminders();
 status(invalidLocal?'旧数据未被改动。请先导出原数据，再导入有效备份。':'',invalidLocal);
 if(params.has('course'))await openDetail(null,'course',params.get('course'));
 if(params.has('event'))await openDetail(null,'event',params.get('event'));
 if(params.has('building')){await loadOptions();const building=buildings.find(b=>b.osm===params.get('building')&&b.campus===(params.get('campus')||plan.profile.campus));if(building)openQuick('reservation',null,{location:building.name});}
}catch(error){$('#main').setAttribute('aria-busy','false');$('#cp-days').innerHTML=empty('本地数据库暂不可用。','请检查浏览器存储权限。未使用服务器保存私人数据。');status(error.message,true);}


// Public shell assets only: campus-worker never caches accounts or personal API data.
if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['127.0.0.1','localhost','[::1]'].includes(location.hostname))) {
 navigator.serviceWorker.register('campus-worker.js', { updateViaCache:'none' }).catch(() => {
  $('#cp-offline-state').textContent='离线页面缓存未启用。你的本机日程仍保存在数据库，可正常导出备份。';
 });
}
