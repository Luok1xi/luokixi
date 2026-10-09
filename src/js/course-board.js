import { DragDropManager, Draggable, Droppable, Feedback, PointerSensor, KeyboardSensor, PointerActivationConstraints } from '@dnd-kit/dom';
import { esc } from './data.js';
import { dateOf, addDays, weekStart } from './campus-plan.js';
import { minutesOf, timeOf, isFixed, previewPlacement } from './campus-schedule.js';
import { createPlannerSprings } from './planner-spring.js';

const DAY = ['日','一','二','三','四','五','六'], PX = 1.1;
const durationOf = item => item.duration || minutesOf(item.end) - minutesOf(item.start);
const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const editable = item => !isFixed(item) && item.canManage !== false;
const subtitle = item => item.source === 'club' ? item.title : item.location || (item.source === 'reservation' ? '本人预约记录' : '');
const headline = item => item.clubName || item.title;
const color = item => item.source === 'club' ? 'var(--g2)' : item.source === 'reservation' || item.event?.tags?.includes('预约记录') ? 'var(--ok)' : isFixed(item) ? 'var(--accent)' : 'var(--g4)';

export function createCourseBoard({ root, tray, move, open, add, error, create, clubAction, begin }) {
  const springs = createPlannerSprings();
  let manager, entities = [], items = [], plan, dates = [], selected, boardKey = '', context = {}, active = null, lastEnd = 0, deferred = null, destroyed = false;
  let firstMinute = 7 * 60, endMinute = 23 * 60, lastPointer = null, velocity = { x: 0, y: 0 }, releaseRect = null, pointerGrab = null;
  const cardNodes = new Map(), pendingNodes = new Map();
  function clearDnd() { for (const entity of entities) entity.destroy(); entities = []; manager?.destroy(); manager = null; }
  function say(message) { const status = root.querySelector('.cb-drop-status'); if (status && status.textContent !== message) status.textContent = message; }
  function slotsFor(list) {
    const positions = new Map(), sorted = [...list].sort((a,b) => a.start.localeCompare(b.start) || b.end.localeCompare(a.end));
    let group = [], end = '';
    const finish = () => { const lanes=[]; for(const item of group){let lane=lanes.findIndex(e=>e<=item.start);if(lane<0)lane=lanes.length;lanes[lane]=item.end;positions.set(item.id,{lane});}for(const item of group)positions.get(item.id).width=100/lanes.length;group=[]; };
    for(const item of sorted){if(group.length&&item.start>=end)finish();group.push(item);end=group.length===1?item.end:(end>item.end?end:item.end);}if(group.length)finish();return positions;
  }
  function content(item, pending = false) {
    return `<div class="cb-event-top"><span class="cb-item-kind">${item.source === 'club' ? '社团' : item.source === 'reservation' || item.event?.tags?.includes('预约记录') ? '预约' : isFixed(item) ? '主课 · 固定' : '本机安排'}</span>${editable(item) ? `<button class="cb-grip" data-drag-handle aria-label="拖动 ${esc(headline(item))} ${esc(item.title)}；空格开始，方向键移动，Escape 取消">⠿</button>` : '<span class="cb-lock" aria-label="时间固定">⌑</span>'}</div><button class="cb-event-content" ${pending ? 'data-edit-pending' : 'data-board-open'}="${esc(item.id)}"><b>${esc(!pending&&durationOf(item)<45?item.title:headline(item))}</b><span>${esc(subtitle(item))}</span><time>${pending ? durationOf(item) + ' 分钟' : esc(item.start + '–' + item.end)}</time></button>${!pending && editable(item) ? `<button class="cb-resize" data-resize="${esc(item.id)}" aria-label="调整 ${esc(item.title)} 的时长"></button>` : ''}`;
  }
  function updateCard(node, item, pending = false) {
    const signature = JSON.stringify([item.title,item.clubName,item.start,item.end,item.duration,item.location,item.canManage,item.source,isFixed(item)]);
    if (node.dataset.signature !== signature) {
      const kind=String(editable(item))+':'+pending;
      if(!node.firstElementChild||node.dataset.structure!==kind){node.innerHTML=content(item,pending);node.dataset.structure=kind;}
      else{node.querySelector('.cb-event-content b').textContent=!pending&&durationOf(item)<45?item.title:headline(item);node.querySelector('.cb-event-content span').textContent=subtitle(item);node.querySelector('time').textContent=pending?durationOf(item)+' 分钟':item.start+'–'+item.end;}
      node.dataset.signature = signature;
    }
    node.style.setProperty('--event-color', color(item));
    node.className = `${pending ? 'cb-pending' : 'cb-event'} ${isFixed(item) ? 'is-fixed' : editable(item) ? 'is-flex' : 'is-shared'} ${!pending && durationOf(item) < 45 ? 'is-short' : ''}`;
  }
  function buildCalendar() {
    cardNodes.clear(); root.className = 'cb-board'; root.style.setProperty('--board-days', dates.length);
    root.innerHTML = `<div class="cb-scroll" tabindex="0" aria-label="课表时间板，可横向和纵向滚动"><div class="cb-calendar"><div class="cb-day-head"><span class="cb-timezone">GMT+8</span>${dates.map(d=>`<div class="cb-day-name ${d===dateOf()?'is-today':''}"><span>周${DAY[new Date(d).getUTCDay()]}</span><b>${Number(d.slice(-2))}</b></div>`).join('')}</div><div class="cb-time-body" style="height:${(endMinute-firstMinute)*PX}px"><div class="cb-ruler">${Array.from({length:Math.ceil((endMinute-firstMinute)/60)},(_,i)=>`<time style="top:${i*60*PX}px">${timeOf(firstMinute+i*60)}</time>`).join('')}</div>${dates.map(d=>`<section class="cb-column" data-board-date="${d}" aria-label="${d}"><div class="cb-drop-well" aria-hidden="true"><b></b><span></span></div></section>`).join('')}</div></div></div><p class="cb-drop-status" role="status" aria-live="polite">从左边拖入活动 · 15 分钟吸附</p>`;
    const scroll = root.querySelector('.cb-scroll');
    scroll.addEventListener('scroll', () => { if (active) track(active.event); }, { passive:true });
    scroll.scrollTop = Math.max(0, (8 * 60 - firstMinute) * PX - 20);
  }
  function renderTray() {
    if (!tray.querySelector('.cb-club-area')) {
      tray.innerHTML = `<section class="cb-club-area"><div class="cb-tray-head"><h2>我的社团</h2><button class="cb-round" data-club-action="manage" aria-label="创建或加入社团">＋</button></div><div class="cb-club-selector"></div><div class="cb-club-compose"></div><div class="cb-inbox" data-drop-inbox aria-label="社团待安排活动"></div></section><section class="cb-reservations"><div class="cb-tray-head"><h2>我的预约</h2><button class="cb-round" data-club-action="reservation" aria-label="记录已有预约">＋</button></div><div class="cb-reservation-list"></div><a href="reservations.html" class="cb-side-link">图书馆预约助手 <span>↗</span></a></section><details class="cb-local"><summary>本机其他安排 <span class="cb-local-count"></span></summary><div class="cb-local-inbox"></div><button class="cb-side-link" data-club-action="local">＋ 记一件事</button></details><div class="cb-key"><span><i class="is-fixed"></i>主课</span><span><i class="is-club"></i>社团</span><span><i class="is-booking"></i>预约</span></div><p class="cb-sync-state" role="status"></p>`;
    }
    const clubs = context.clubs || [], club = clubs.find(c => c.id === context.selectedClub) || clubs[0];
    const selector = tray.querySelector('.cb-club-selector'), selectorKey = JSON.stringify([clubs.map(c=>[c.id,c.name,c.role,c.memberCount]),club?.id,context.online,context.signedIn]);
    if (selector.dataset.key !== selectorKey) {
      selector.dataset.key = selectorKey;
      selector.innerHTML = clubs.length ? `<label class="cb-club-label"><span class="sr-only">当前社团</span><select data-select-club>${clubs.map(c=>`<option value="${esc(c.id)}"${club?.id===c.id?' selected':''}>${esc(c.name)}</option>`).join('')}</select></label><div class="cb-club-meta"><span>${club.canManage?'社长':'社员'} · ${club.memberCount} 人</span>${club.canManage?'<button data-club-action="invite">邀请社员 ↗</button>':''}</div>` : `<div class="cb-club-empty"><span class="cb-club-mark" aria-hidden="true">◌</span><p>${context.signedIn ? '还没有加入社团' : '登录后查看社团安排'}</p><button class="cb-side-link" data-club-action="${context.signedIn?'manage':'login'}">${context.signedIn?'创建或加入':'登录账号'} →</button></div>`;
    }
    const compose = tray.querySelector('.cb-club-compose'), composeKey = (club?.id || '') + ':' + Boolean(club?.canManage);
    if (compose.dataset.key !== composeKey) {
      compose.dataset.key = composeKey;
      compose.innerHTML = club?.canManage ? `<form class="cb-quick-form"><label class="sr-only" for="cb-quick-title">安排事件名称</label><div class="cb-quick-line"><input id="cb-quick-title" name="title" maxlength="120" required placeholder="安排什么？" autocomplete="off" enterkeyhint="done"><button type="submit" aria-label="添加待安排活动">↵</button></div><details><summary>60 分钟 · 更多</summary><div class="cb-quick-options"><label>时长<select name="duration"><option value="30">30 分钟</option><option value="60" selected>1 小时</option><option value="90">1.5 小时</option><option value="120">2 小时</option><option value="180">3 小时</option></select></label><label>地点<input name="location" maxlength="160" placeholder="可稍后填写"></label></div></details><p class="cb-quick-error" role="alert"></p></form>` : club ? '<p class="cb-member-note">社长的排期会同步到这里。</p>' : '';
    }
    const pending = [ ...(context.events || []).filter(e => e.pending && e.clubId === club?.id), ...plan.events.filter(e => e.unscheduled && !e.hidden && !e.cancelled).map(e => ({ ...e, id:'pending:'+e.id,sourceId:e.id,source:'event',event:e })) ];
    const wanted = new Set(pending.map(i=>i.id));
    for (const [key,node] of pendingNodes) if (!wanted.has(key)) { springs.stop(node); node.remove(); pendingNodes.delete(key); }
    const inbox = tray.querySelector('.cb-inbox'), local = tray.querySelector('.cb-local-inbox');
    for (const item of pending) {
      let node = pendingNodes.get(item.id);
      if (!node) { node = document.createElement('article'); node.dataset.pending = item.id; pendingNodes.set(item.id,node); }
      updateCard(node,item,true); const parent = item.source === 'club' ? inbox : local; if(node.parentNode!==parent)parent.append(node);
    }
    tray.querySelector('.cb-local-count').textContent = String(pending.filter(i=>i.source==='event').length || '');
    inbox.classList.toggle('is-empty',!pending.some(i=>i.source==='club'));
    inbox.dataset.empty = club?.canManage ? '写个名称，再拖到右边。' : club ? '活动安排在右侧时间板' : '';
    const reservations = items.filter(i=>i.source==='reservation'||i.event?.tags?.includes('预约记录'));
    tray.querySelector('.cb-reservation-list').innerHTML = reservations.length ? reservations.slice(0,3).map(i=>`<button data-reservation-open="${esc(i.id)}"><b>${esc(i.title)}</b><span>${esc(i.date.slice(5)+' '+i.start)}</span></button>`).join('') : '<p>已有预约，放进时间板。</p>';
    tray.querySelector('.cb-sync-state').textContent = context.syncStatus || '';
  }
  function render(nextPlan, list, date, view, shared = {}) {
    if (active) { deferred = [nextPlan,list,date,view,shared]; return; }
    clearDnd();
    const rects = new Map([...cardNodes].map(([key,node])=>[key,node.getBoundingClientRect()]));
    plan=nextPlan;items=list;selected=date;context=shared;
    const first = view === 'day' ? date : weekStart(date);
    dates=Array.from({length:view==='day'?1:7},(_,i)=>addDays(first,i)).filter(d=>!(view!=='day'&&plan.settings.hideWeekend&&[0,6].includes(new Date(d).getUTCDay())));
    firstMinute=Math.min(7*60,...items.map(x=>Math.floor(minutesOf(x.start)/60)*60));endMinute=Math.min(1439,Math.max(23*60,...items.map(x=>Math.ceil(minutesOf(x.end)/60)*60)));
    const key=dates.join('|')+':'+firstMinute+':'+endMinute;
    const changed=key!==boardKey; if(changed){boardKey=key;buildCalendar();}
    const ids = new Set(items.map(i=>i.id));
    for(const [key,node] of cardNodes)if(!ids.has(key)){springs.stop(node);node.remove();cardNodes.delete(key);}
    for(const day of dates){
      const dayItems=items.filter(i=>i.date===day),positions=slotsFor(dayItems),column=root.querySelector(`[data-board-date="${day}"]`);
      for(const item of dayItems){
        let node=cardNodes.get(item.id);if(!node){node=document.createElement('article');node.dataset.boardItem=item.id;cardNodes.set(item.id,node);}
        const before=rects.get(item.id);springs.stop(node);updateCard(node,item);
        const {lane,width}=positions.get(item.id);node.style.top=(minutesOf(item.start)-firstMinute)*PX+'px';node.style.height=Math.max(21,durationOf(item)*PX-3)+'px';node.style.left=`calc(${lane*width}% + 4px)`;node.style.width=`calc(${width}% - 8px)`;
        if(node.parentNode!==column)column.append(node);
        if(before&&!changed){const after=node.getBoundingClientRect();springs.target(node,0,0,{from:{x:before.left-after.left,y:before.top-after.top}});}
      }
    }
    renderTray();bindDnd();
    const now=new Date(Date.now()+8*3600000),minute=now.getUTCHours()*60+now.getUTCMinutes(),today=root.querySelector(`[data-board-date="${dateOf()}"]`);
    root.querySelectorAll('.cb-now').forEach(n=>n.remove());if(today&&minute>=firstMinute&&minute<endMinute)today.insertAdjacentHTML('beforeend',`<div class="cb-now" style="top:${(minute-firstMinute)*PX}px"><span>现在</span></div>`);
  }
  function currentPending(id) {
    const shared=(context.events||[]).find(e=>e.id===id);if(shared)return shared;
    const event=plan.events.find(e=>'pending:'+e.id===id);return event?{...event,id,sourceId:event.id,source:'event',event}:null;
  }
  function bindDnd() {
    const columnWidth=root.querySelector('.cb-column')?.getBoundingClientRect().width || 130;
    manager=new DragDropManager({sensors:[PointerSensor.configure({activationConstraints:[new PointerActivationConstraints.Distance({value:6})]}),KeyboardSensor.configure({offset:{x:columnWidth,y:15*PX}})]});
    for(const el of root.querySelectorAll('[data-board-date]'))entities.push(new Droppable({id:el.dataset.boardDate,element:el,accept:['task','resize']},manager));
    const inbox=tray.querySelector('[data-drop-inbox]');entities.push(new Droppable({id:'inbox',element:inbox,accept:'task'},manager));
    const register=(node,item)=>{if(!editable(item))return;entities.push(new Draggable({id:item.id,element:node,handle:node.querySelector('[data-drag-handle]'),type:'task',plugins:[Feedback.configure({feedback:'clone',dropAnimation:null,keyboardTransition:null})],data:{item}},manager));const handle=node.querySelector('[data-resize]');if(handle)entities.push(new Draggable({id:'resize:'+item.id,element:handle,handle,type:'resize',plugins:[Feedback.configure({feedback:'clone',dropAnimation:null})],data:{item}},manager));};
    for(const item of items){const node=cardNodes.get(item.id);if(node)register(node,item);}
    for(const [key,node] of pendingNodes){const item=currentPending(key);if(item)register(node,item);}
    manager.monitor.addEventListener('dragstart',event=>{
      const {source,position}=event.operation;if(!source)return;
      begin?.();
      const item=source.data.item, node=source.element,keyboard=event.operation.activatorEvent instanceof KeyboardEvent;
      const grab=!keyboard&&pointerGrab?.node===node?pointerGrab:null,rect=grab?.rect||node.getBoundingClientRect(),initial=grab?.point||position.initial||position.current;
      active={event,item,node,originRect:rect,grabY:initial.y-rect.top,initialPointerY:initial.y,initialColumnTop:grab?.columnTop??root.querySelector(`[data-board-date="${item.date}"]`)?.getBoundingClientRect().top,keyboard,preview:null,blockedKey:'',date:item.date||selected};
      springs.stop(node);lastPointer={...position.current,t:performance.now()};velocity={x:0,y:0};root.classList.add('is-dragging');tray.classList.add('is-dragging');
      say('选择时间，其他可调整活动会让开。Escape 取消。');
    });
    manager.monitor.addEventListener('dragmove',track);manager.monitor.addEventListener('dragover',track);
    manager.monitor.addEventListener('dragend',endDrag);
  }
  function candidate(event) {
    if(!active)return null;const op=event.operation,point=op.position.current;
    const scroll=root.querySelector('.cb-scroll').getBoundingClientRect();
    let column;
    if(active.keyboard&&(active.item.pending||active.item.event?.unscheduled)){
      const index=Math.max(0,Math.min(dates.length-1,Math.max(0,dates.indexOf(selected))+Math.round(op.transform.x/(root.querySelector('.cb-column').getBoundingClientRect().width||130))));column=root.querySelector(`[data-board-date="${dates[index]}"]`);
      return {date:dates[index],start:9*60+Math.round(op.transform.y/PX/15)*15,duration:durationOf(active.item),column};
    }
    if(point.x<scroll.left||point.x>scroll.right||point.y<scroll.top||point.y>scroll.bottom)return null;
    for(const node of root.querySelectorAll('.cb-column')){const box=node.getBoundingClientRect();if(point.x>=box.left&&point.x<=box.right){column=node;break;}}
    if(!column)return null;
    const rect=column.getBoundingClientRect(),resize=op.source?.type==='resize';
    const minute=Math.round((point.y-rect.top-(resize?0:active.grabY))/PX/15)*15+firstMinute;
    const start=resize?minutesOf(active.item.start):Math.max(firstMinute,minute),duration=resize?Math.round((durationOf(active.item)+(point.y-active.initialPointerY+(active.initialColumnTop-rect.top))/PX)/15)*15:durationOf(active.item);
    if(resize&&column.dataset.boardDate!==active.item.date)return null;
    return{date:column.dataset.boardDate,start,duration,column};
  }
  function restorePreview(except = new Set()) {
    for(const [key,node]of cardNodes){node.classList.remove('is-yielding','is-refusing');if(!except.has(key)&&node!==active?.node)springs.target(node,0,0);}
    root.querySelectorAll('.cb-drop-well').forEach(n=>n.classList.remove('is-visible','is-blocked'));
  }
  function track(event) {
    if(!active)return;active.event=event;
    const point=event.operation.position.current,now=performance.now();if(lastPointer&&now-lastPointer.t>4){const dt=(now-lastPointer.t)/1000;velocity={x:(point.x-lastPointer.x)/dt,y:(point.y-lastPointer.y)/dt};lastPointer={...point,t:now};}
    const at=candidate(event);
    if(!at){restorePreview();active.preview=null;active.at=null;active.signature='';say(event.operation.target?.id==='inbox'?'放回待安排':'拖到时间板，或按 Escape 取消');return;}
    const signature=[at.date,at.start,at.duration].join('|');if(active.signature===signature)return;active.signature=signature;
    const placement=previewPlacement(context.collisions||items,active.item,at.date,at.start,at.duration);active.preview=placement;active.at=at;
    const yielded=new Set(placement.yielded.map(m=>m.item.id));restorePreview(yielded);
    for(const moved of placement.yielded){const node=cardNodes.get(moved.item.id);if(node){node.classList.add('is-yielding');springs.target(node,0,(minutesOf(moved.start)-minutesOf(moved.item.start))*PX);}}
    const blockedKey=placement.blocked.map(i=>i.id).join('|');
    for(const blocked of placement.blocked){const node=cardNodes.get(blocked.id);if(node){node.classList.add('is-refusing');if(blockedKey!==active.blockedKey&&!active.keyboard)springs.target(node,0,0,{from:{x:5,y:0},velocity:{x:-180,y:0}});}}
    active.blockedKey=blockedKey;
    const well=at.column.querySelector('.cb-drop-well');well.style.top=(Math.max(firstMinute,at.start)-firstMinute)*PX+'px';well.style.height=Math.max(18,at.duration*PX-3)+'px';well.classList.add('is-visible');well.classList.toggle('is-blocked',!placement.ok);well.querySelector('b').textContent=at.start>=0&&at.start<1440?timeOf(at.start):'';well.querySelector('span').textContent=placement.ok?'松手安排':'时间冲突';
    say(placement.ok?`${at.date} ${timeOf(at.start)}–${timeOf(at.start+at.duration)} · ${placement.message}`:placement.message);
  }
  function flightFor(drag, rect, destination) {
    if(reduce()||drag.keyboard)return null;
    const node=drag.node.cloneNode(true);node.removeAttribute('popover');node.removeAttribute('data-dnd-dragging');node.removeAttribute('data-dnd-dropping');node.removeAttribute('data-pending');node.removeAttribute('data-board-item');node.classList.add('cb-flight');node.querySelectorAll('button').forEach(b=>b.tabIndex=-1);node.setAttribute('aria-hidden','true');
    node.style.cssText=`--event-color:${color(drag.item)};position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;margin:0;transform:none;translate:none;z-index:10000;pointer-events:none;`;
    if(destination.target){node.className='cb-event cb-flight is-flex';node.innerHTML=content({...drag.item,start:timeOf(drag.at.start),end:timeOf(drag.at.start+drag.at.duration)},false);node.style.width=destination.width+'px';node.style.height=destination.height+'px';}
    document.body.append(node);springs.target(node,destination.left-rect.left,destination.top-rect.top,{from:{x:0,y:0,sx:rect.width/(destination.width||rect.width),sy:rect.height/(destination.height||rect.height)},velocity:{x:Math.max(-1800,Math.min(1800,velocity.x)),y:Math.max(-1800,Math.min(1800,velocity.y))}});return node;
  }
  async function endDrag(event) {
    if(!active)return;
    const drag=active,op=event.operation,at=drag.at,placement=drag.preview,source=op.source;
    releaseRect=source?.element?.getBoundingClientRect()||drag.originRect;lastEnd=Date.now();
    const inbox=op.target?.id==='inbox',cancelled=event.canceled||(!at&&!inbox),blocked=at&&!placement?.ok;
    const targetRect=at?.column.getBoundingClientRect();const destination=!cancelled&&!blocked&&!inbox?{left:targetRect.left+4,top:targetRect.top+(at.start-firstMinute)*PX,width:targetRect.width-8,height:at.duration*PX-3,target:true}:drag.originRect;
    const flight=flightFor(drag,releaseRect,destination);
    root.classList.remove('is-dragging');tray.classList.remove('is-dragging');active=null;pointerGrab=null;
    // The toolkit restores its own placeholder and focus at the end of this frame.
    await new Promise(resolve=>requestAnimationFrame(resolve));
    if(flight)drag.node.classList.add('is-committing');
    if(cancelled||blocked){restorePreview();say(blocked?placement.message:'已取消，时间没有改变。');if(blocked)error(placement.message);}
    else{
      try{const result=await move(drag.item,at?.date||drag.item.date,at?.start??minutesOf(drag.item.start||'09:00'),at?.duration||durationOf(drag.item),{unschedule:inbox,placement});if(result===false)throw new Error('保存未完成，已回到原位置。');say(inbox?'已放回待安排。':'已安排 · 社员将在各自日程中看到更新');}
      catch(e){restorePreview();error(e.message);if(flight){springs.target(flight,drag.originRect.left-releaseRect.left,drag.originRect.top-releaseRect.top);}}
    }
    root.querySelectorAll('.cb-drop-well').forEach(n=>n.classList.remove('is-visible','is-blocked'));root.querySelectorAll('.is-yielding,.is-refusing').forEach(n=>n.classList.remove('is-yielding','is-refusing'));
    if(flight){setTimeout(()=>{springs.stop(flight);flight.remove();drag.node.classList.remove('is-committing');},reduce()?0:420);}else drag.node.classList.remove('is-committing');
    if(deferred){const next=deferred;deferred=null;render(...next);}
  }
  // Capture before dnd-kit's distance activation moves the source into its
  // feedback layer. The activating event is a pointermove, not pointerdown.
  const rememberGrab=event=>{
    const handle=event.target.closest('[data-drag-handle],[data-resize]');
    if(!handle){pointerGrab=null;return;}
    const node=handle.matches('[data-resize]')?handle:handle.closest('[data-board-item],[data-pending]');
    if(node)pointerGrab={node,point:{x:event.clientX,y:event.clientY},rect:node.getBoundingClientRect(),columnTop:handle.closest('[data-board-date]')?.getBoundingClientRect().top};
  };
  root.addEventListener('pointerdown',rememberGrab,true);tray.addEventListener('pointerdown',rememberGrab,true);
  root.addEventListener('click',event=>{
    if(active||Date.now()-lastEnd<250||event.target.closest('[data-drag-handle],[data-resize]'))return;
    const id=event.target.closest('[data-board-open]')?.dataset.boardOpen;if(id)return open(items.find(x=>x.id===id));
    const column=event.target.closest('[data-board-date]');if(column&&!event.target.closest('.cb-event')){const minute=Math.max(firstMinute,Math.floor((event.clientY-column.getBoundingClientRect().top)/PX/15)*15+firstMinute);if(minute+60<1440)add('club',{date:column.dataset.boardDate,start:timeOf(minute),end:timeOf(minute+60),unscheduled:false});}
  });
  tray.addEventListener('click',event=>{
    if(active||Date.now()-lastEnd<250||event.target.closest('[data-drag-handle]'))return;
    const pendingId=event.target.closest('[data-edit-pending]')?.dataset.editPending;if(pendingId)return open(currentPending(pendingId));
    const reservation=event.target.closest('[data-reservation-open]')?.dataset.reservationOpen;if(reservation)return open(items.find(i=>i.id===reservation));
    const action=event.target.closest('[data-club-action]')?.dataset.clubAction;if(action)clubAction(action);
  });
  tray.addEventListener('change',event=>{
    if(event.target.matches('[data-select-club]'))clubAction('select',event.target.value);
    if(event.target.name==='duration')event.target.closest('details').querySelector('summary').textContent=event.target.value+' 分钟 · 更多';
  });
  tray.addEventListener('submit',async event=>{
    if(!event.target.matches('.cb-quick-form'))return;event.preventDefault();const form=event.target,button=form.querySelector('[type=submit]');button.disabled=true;form.querySelector('.cb-quick-error').textContent='';
    try{await create({title:form.elements.title.value.trim(),duration:Number(form.elements.duration.value),location:form.elements.location.value.trim()});form.elements.title.value='';form.elements.title.focus();}catch(e){form.querySelector('.cb-quick-error').textContent=e.message;}finally{button.disabled=false;}
  });
  return{render,get interacting(){return Boolean(active);},destroy(){destroyed=true;clearDnd();springs.destroy();}};
}
