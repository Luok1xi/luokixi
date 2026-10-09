import {ensureWebLife,webLifeCommand} from './web-life-state.mjs';
import {siteCommand} from './site-hub.mjs';
import {saveBreakfastHabit} from './life-context.mjs';
import {syncScheduledNotices} from './scheduled-notices.mjs';
import {ensureAgency} from './agency-state.mjs';
import { randomUUID } from 'node:crypto';
import { dateKey,dateMinute,nowMinute,startOfDay,stamp,clockText,integer,text,weekday,overlap } from './time.mjs';
import { plan } from './planner.mjs';
import { decay,recordEvent,expression,personaDescription,stageLabels } from './persona.mjs';
import {tombstone} from './store.mjs';
import {characterName} from './character-card.mjs';
import {affectView,applyAffect} from './affect.mjs';
import {ensureStudy} from './curriculum.mjs';
import {ensureResearch,researchCommand} from './research-state.mjs';

export const id=()=>randomUUID();
const pick=(xs,key)=>{const found=xs.find(x=>x.id===key);if(!found)throw new Error('找不到这条记录，请刷新后重试。');return found;};
const bool=(v,def)=>v===undefined?def:typeof v==='boolean'?v:(()=>{throw new Error('开关值不正确。');})();
export function courseData(a){
  if(a.id!==undefined&&(typeof a.id!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(a.id)))throw new Error('课程记录编号无效。');
  const c={id:a.id||id(),title:text(a.title),weekday:integer(a.weekday,1,7,'星期'),start:text(a.start,5),end:text(a.end,5),location:String(a.location||'').slice(0,100),teacher:String(a.teacher||'').slice(0,100),weekFrom:integer(a.weekFrom??1,1,60,'起始周'),weekTo:integer(a.weekTo??18,1,60,'结束周'),parity:a.parity||'all',travelBefore:integer(a.travelBefore??15,0,120,'课前通勤'),travelAfter:integer(a.travelAfter??10,0,120,'课后通勤'),cancelledDates:a.cancelledDates||[]};
  if(dateMinute('2026-01-01',c.start)>=dateMinute('2026-01-01',c.end)||c.weekFrom>c.weekTo||!['all','odd','even'].includes(c.parity))throw new Error('课程时间或周次不正确。');
  if(!Array.isArray(c.cancelledDates)||c.cancelledDates.length>120)throw new Error('取消日期不正确。');for(const d of c.cancelledDates)dateMinute(d);
  return c;
}
export function taskData(a,now){
  const remaining=integer(a.remaining,1,100000,'剩余分钟'),deadline=typeof a.deadline==='string'?dateMinute(a.deadline.slice(0,10),a.deadline.slice(11,16)||'23:59'):integer(a.deadline,0,100000000,'截止时间');
  return {id:a.id||id(),title:text(a.title),remaining,estimated:remaining,deadline,priority:integer(a.priority??2,1,3,'优先级'),splittable:bool(a.splittable,true),minBlock:integer(a.minBlock??30,5,240,'最小时间块'),location:String(a.location||'').slice(0,100),notBefore:a.notBefore?parseTime(a.notBefore):now,status:'open',createdAt:now};
}
export const parseTime=v=>typeof v==='number'?integer(v,0,100000000,'时间'):dateMinute(String(v).slice(0,10),String(v).slice(11,16)||'00:00');
export function planText(p,day){
  const rows=[...p.fixed.filter(b=>!['rest','travel'].includes(b.kind)),...p.allocations].filter(b=>dateKey(b.start)===day).sort((a,b)=>a.start-b.start);
  return rows.length?rows.map(b=>`${clockText(b.start)}—${clockText(b.end)} ${b.title}${b.location?' · '+b.location:''}`).join('\n'):'今天没有已排入的课程或任务，可以先告诉我接下来要做什么。';
}
export class Service{
  constructor(store,clock=nowMinute){this.store=store;this.clock=clock;}
  state(){const s=this.store.read();decay(s.persona,this.clock());ensureStudy(s);ensureResearch(s);ensureAgency(s,this.clock());ensureWebLife(s);const affect=affectView(s.persona,this.clock());return {...s,affect,expression:expression(s.persona),mood:affect.label,stageLabel:stageLabels[s.persona.stage],chat:this.store.chats(),notifications:this.store.messages()};}
  command(action,args={},commandId=id(),source='local'){
    if(action==='proposal.confirm')return this.confirm(args.id,commandId,source);
    text(commandId,200);const request=JSON.stringify({action,args});
    return this.store.transaction(()=>{
      const old=this.store.db.prepare('SELECT request,response FROM commands WHERE id=?').get(commandId);
      if(old){if(old.request!==request&&old.request!==tombstone(request))throw new Error('同一个请求编号不能重复执行不同操作。');return JSON.parse(old.response);}
      const now=this.clock(),s=this.store.read();decay(s.persona,now);let result={message:'已保存。'},replan=false,purge=false;
      const episode=(key,title,body,kind='reality')=>{if(!s.episodes.some(e=>e.key===key))s.episodes.push({id:id(),key,title,body,kind,at:now});};
      switch(action){
        case 'research.goal':case 'research.goal.remove':case 'research.source':case 'research.source.remove':case 'research.notice':case 'research.settings':case 'research.feedback':case 'research.clear':{
          result=researchCommand(s,action,args,now);
          if(['research.clear','research.settings','research.source.remove','research.goal.remove','research.feedback'].includes(action))this.store.db.exec("UPDATE outbox SET status='cancelled' WHERE id LIKE '%:research:%' AND status='pending'");
          break;
        }
        case 'research.accept':{
          const row=pick(ensureResearch(s).items,args.id);if(row.taskId){result.message='这份通知已经加入计划，不会重复创建。';break;}
          if(!row.todo)throw new Error('这条资料不是学校待办。');
          const task=taskData({title:row.title,remaining:args.remaining,deadline:args.deadline,priority:row.priority,minBlock:Math.min(30,args.remaining),splittable:true},now);
          if(task.deadline<=now)throw new Error('截止时间已过，请先核对通知。');
          task.source={kind:'research-notice',itemId:row.id,url:row.source.url,evidence:row.evidence};s.tasks.push(task);row.taskId=task.id;row.status='scheduled';replan=true;result.message='已核对通知并加入计划。';break;
        }
        case 'task.add':{const t=taskData({...args,id:id()},now);s.tasks.push(t);replan=true;result.message=`已记录「${t.title}」，剩余 ${t.remaining} 分钟，截止 ${stamp(t.deadline)}。`;break;}
        case 'task.update':{const t=pick(s.tasks,args.id);if(t.status!=='open')throw new Error('该任务已经结束。');
          for(const k of ['remaining','priority','minBlock'])if(args[k]!==undefined)t[k]=integer(args[k],k==='priority'?1:k==='minBlock'?5:1,k==='priority'?3:k==='minBlock'?240:100000,k);
          if(args.deadline!==undefined)t.deadline=parseTime(args.deadline);if(args.notBefore!==undefined)t.notBefore=parseTime(args.notBefore);if(args.title!==undefined)t.title=text(args.title);if(args.splittable!==undefined)t.splittable=bool(args.splittable);replan=true;result.message=`已更新「${t.title}」，现在还需要 ${t.remaining} 分钟。`;break;}
        case 'task.progress':{const t=pick(s.tasks,args.id);if(t.status!=='open')throw new Error('该任务已经结束。');const minutes=integer(args.minutes,1,1440,'实际用时');s.workLogs.push({id:id(),taskId:t.id,title:t.title,minutes,at:now});t.remaining=args.remaining===undefined?Math.max(0,t.remaining-minutes):integer(args.remaining,0,100000,'剩余分钟');if(!t.remaining){t.status='done';recordEvent(s.persona,'completed',`你确认完成了${t.title}`,now,commandId);episode('first-goal','一起完成的第一件事',`你确认完成了「${t.title}」。`);}replan=true;result.message=`已记录 ${minutes} 分钟进度，剩余 ${t.remaining} 分钟。`;break;}
        case 'task.complete':{const t=pick(s.tasks,args.id);if(t.status==='done'){result.message='这项任务已经完成，不会重复记录。';break;}if(t.status!=='open')throw new Error('任务已取消。');t.status='done';t.remaining=0;recordEvent(s.persona,'completed',`你确认完成了${t.title}`,now,commandId);episode('first-goal','一起完成的第一件事',`你确认完成了「${t.title}」。`);replan=true;result.message=`「${t.title}」已标记完成。做得不错……这次是真的替你高兴。`;break;}
        case 'task.cancel':{pick(s.tasks,args.id).status='cancelled';replan=true;result.message='任务已取消，对应提醒也会失效。';break;}
        case 'course.save':{const c=courseData(args);const i=s.courses.findIndex(x=>x.id===c.id);if(i<0)s.courses.push(c);else s.courses[i]=c;replan=true;result.message=`已保存课程「${c.title}」。`;break;}
        case 'course.cancelDate':{const c=pick(s.courses,args.id);dateMinute(args.date);if(!c.cancelledDates.includes(args.date))c.cancelledDates.push(args.date);replan=true;result.message=`已取消 ${args.date} 的${c.title}。`;break;}
        case 'course.remove':s.courses=s.courses.filter(c=>c.id!==args.id);replan=true;break;
        case 'block.add':{const b={id:id(),title:text(args.title),start:parseTime(args.start),end:parseTime(args.end)};if(b.start>=b.end||b.end-b.start>30*1440)throw new Error('固定安排的时间不正确。');s.blocks.push(b);replan=true;break;}
        case 'block.remove':s.blocks=s.blocks.filter(b=>b.id!==args.id);replan=true;break;
        case 'rest':s.restUntil=args.until?parseTime(args.until):startOfDay(now)+1440;if(s.restUntil<=now||s.restUntil>now+7*1440)throw new Error('休息结束时间须在未来七天内。');recordEvent(s.persona,'tired','你明确提出休息或状态不好',now,commandId);replan=true;result.message=`好，${stamp(s.restUntil)} 前的弹性学习任务会移开，固定安排仍保留。`;break;
        case 'replan':replan=true;result.message='已重新检查并安排后续时间。';break;
        case 'plan.undo':{const h=s.planHistory.at(-1);if(!h||h.revision!==s.revision)throw new Error('之后已有新的状态变化，不能直接撤销；请重新规划。');
          if((h.plan.allocations||[]).some(b=>b.start<now))throw new Error('原计划已有时间段过去，请重新规划。');
          const probe=plan({...s,plan:h.plan,restUntil:h.restUntil, tasks:s.tasks.map(t=>({...t,notBefore:h.notBefore?.[t.id]??t.notBefore}))},now);
          if(JSON.stringify(probe.allocations)!==JSON.stringify(h.plan.allocations))throw new Error('原安排已不符合当前工时或固定安排，请重新规划。');
          s.plan=probe;s.restUntil=h.restUntil;for(const t of s.tasks)t.notBefore=h.notBefore?.[t.id]??t.notBefore;s.planHistory.pop();result.message='已恢复上一版可行的时间安排，已记录的真实进度保留。';break;}
        case 'life.breakfast':saveBreakfastHabit(s.settings,args);result.message='早餐习惯已保存，作为聊天参考；不会自动创建提醒或固定日程。';break;
        case 'settings':{const cfg=s.settings;for(const k of ['wake','sleep','morning','evening','quietStart','quietEnd'])if(args[k]!==undefined){dateMinute('2026-01-01',args[k]);cfg[k]=args[k];}
          if(cfg.wake>=cfg.sleep)throw new Error('第一版要求起床时间早于当日睡觉时间。');
          for(const [k,min,max]of [['dailyMinutes',30,720],['focusMax',20,180],['breakMinutes',5,60],['horizon',1,30],['reminderLead',0,120],['maxReminders',1,20]])if(args[k]!==undefined)cfg[k]=integer(args[k],min,max,k);
          if(args.semesterStart!==undefined){if(weekday(dateMinute(args.semesterStart))!==1)throw new Error('学期第一周起点请填写星期一。');cfg.semesterStart=args.semesterStart;}
          if(args.remindersPaused!==undefined)cfg.remindersPaused=bool(args.remindersPaused);replan=true;break;}
        case 'memory.add':{const m={id:id(),content:text(args.content,2000),category:['profile','behavior','relationship','event'].includes(args.category)?args.category:'profile',confirmed:bool(args.confirmed,true),source:text(args.source||'用户在本地明确记录',3000),at:now};s.memories.push(m);recordEvent(s.persona,'remembered','你记录了一条记忆',now,commandId);result.message='记忆已保存。';break;}
        case 'memory.update':{const m=pick(s.memories,args.id);m.content=text(args.content,2000);m.confirmed=bool(args.confirmed,true);m.source='用户明确更正';m.at=now;purge=true;result.message='记忆已更正，近期对话及衍生摘要已清理，避免旧结论再次被引用。';break;}
        case 'memory.remove':pick(s.memories,args.id);s.memories=s.memories.filter(m=>m.id!==args.id);purge=true;result.message='已忘记这条记忆，同时清理近期对话和衍生摘要。独立的课表、任务仍保留。';break;
        case 'web.settings':case 'web.source':case 'web.source.toggle':case 'web.clear':result=webLifeCommand(s,action,args);this.store.db.exec("UPDATE outbox SET status='cancelled' WHERE id LIKE '%:proactive:%' AND status IN ('pending','sending')");break;
        case 'agency.settings':{const a=ensureAgency(s,now);for(const [key,max] of Object.entries({dailyBurstLimit:48,maxUnanswered:48})){if(args[key]!==undefined){if(!Number.isInteger(args[key])||args[key]<0||args[key]>max)throw new Error('主动消息次数应为0到48的整数，0表示不设此限制。');a[key]=args[key];}}a.shareCheckLimit=Math.max(12,a.dailyBurstLimit?Math.min(48,a.dailyBurstLimit*2):48);a.enabled=bool(args.enabled,a.enabled);a.epoch++;this.store.db.exec("UPDATE outbox SET status='cancelled' WHERE id LIKE '%:proactive:%' AND status IN ('pending','sending')");result.message=a.enabled?'自主活动已开启。':'自主活动已暂停。';break;}
        case 'site.settings':case 'site.draft.discard':result=siteCommand(s,action,args);break;
        case 'tools.group':{if(typeof args.group!=='string'||!/^[a-z][a-z0-9_]{0,40}$/.test(args.group)||args.group==='default'||!['on','search','off'].includes(args.state))throw new Error('工具组设置无效。');s.toolGroups={...s.toolGroups,[args.group]:args.state};result.message='工具组设置已保存。';break;}
        case 'agency.clear':{const a=ensureAgency(s,now);a.epoch++;a.artifacts=[];a.runs=a.runs.map(r=>({id:r.id,at:r.at,mode:r.mode,status:'cleared'}));this.store.db.exec("UPDATE outbox SET status='cancelled' WHERE id LIKE '%:proactive:%' AND status IN ('pending','sending')");result.message='已清理自主活动内容，保留次数限制。';break;}
        case 'study.settings':{const st=ensureStudy(s);if(args.enabled!==undefined)st.enabled=bool(args.enabled);if(args.monthlyLimit!==undefined)st.monthlyLimit=integer(args.monthlyLimit,1,30,'每月学习预算');result.message=st.enabled?'自主学习已开启，每天最多一节。':'自主学习已暂停。';break;}
        case 'study.clear':{if(this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='research_cards'").get())this.store.db.exec('DELETE FROM research_cards; UPDATE cortex_meta SET value=value+1 WHERE id=1');const st=ensureStudy(s);st.epoch++;st.sessions=[];st.status='学习笔记已清理';result.message='已清理学习笔记与成绩；当天调用限制和费用保留。';break;}
        case 'persona.treat':{const before=s.persona.affect.lastTreatAt;applyAffect(s.persona,{event:'treat',message:'你送了一颗虚拟糖果',now,id:commandId});result.message=before===s.persona.affect.lastTreatAt?'虚拟糖果已记录；今日情绪奖励不重复累计，不产生模型费用。':'给 '+characterName+' 送了一颗虚拟糖果，不产生模型费用。';break;}
        case 'persona.pause':s.persona.paused=bool(args.paused,true);result.message=s.persona.paused?'已暂停角色关系互动，日程服务照常。':'角色互动已恢复。';break;
        case 'persona.address':s.persona.stable.address=text(args.address,30);episode('nickname','我们的称呼',`你明确约定 ${characterName} 称呼你为「${s.persona.stable.address}」。`,'roleplay');result.message=`称呼已更新为「${s.persona.stable.address}」。`;break;
        case 'persona.stage':{const order=Object.keys(stageLabels),n=order.indexOf(args.stage),cur=order.indexOf(s.persona.stage);if(n<0)throw new Error('关系阶段不正确。');if(n>cur)throw new Error('关系推进通过共同事件与对话提议确认；这里仅支持降低关系阶段。');s.persona.stage=args.stage;result.message='关系设定已调整，正常助理功能保留。';break;}
        case 'episode':{const kind=args.kind;
          if(!['intro','interest','repair'].includes(kind))throw new Error('事件不正确。');
          const content=text(args.content||({intro:'你好，'+characterName+'。',interest:'我想聊聊最近的兴趣。',repair:'我们把刚才的误会说清楚吧。'})[kind],1000);
          episode(kind,({intro:'初次见面',interest:'交换一点兴趣',repair:'把误会说开'})[kind],content,'roleplay');
          recordEvent(s.persona,kind==='repair'?'repaired':kind==='interest'?'interest':'greeting',content,now,commandId);
          if(!s.persona.milestones.includes(kind))s.persona.milestones.push(kind);
          result.message='纪念事件已记录。';break;}
        case 'proposal.create':{if(s.proposals.length>30)s.proposals=s.proposals.filter(p=>p.expires>now);const p={id:id(),kind:text(args.kind,30),payload:args.payload,reason:text(args.reason||'需要你确认',1000),revision:s.revision+1,expires:now+60};s.proposals.push(p);result={message:'已生成待确认方案。',proposal:p};break;}
        case 'draft.add':{if(!Array.isArray(args.courses)||args.courses.length>100)throw new Error('课表草稿不正确。');const draft={id:id(),courses:args.courses.map(courseData),notes:String(args.notes||'请核对周次、日期和时间').slice(0,3000),at:now};s.drafts.push(draft);result={message:'课表草稿已生成，确认后才会写入。',draft};break;}
        case 'draft.confirm':{const d=pick(s.drafts,args.id);const cs=(args.courses||d.courses).map(courseData);if(cs.length>100)throw new Error('课程数量过多。');s.courses.push(...cs.map(c=>({...c,id:id()})));s.drafts=s.drafts.filter(x=>x.id!==d.id);replan=true;result.message=`已确认导入 ${cs.length} 门课程。`;break;}
        case 'proposal.reject':s.proposals=s.proposals.filter(p=>p.id!==args.id);break;
        case 'relationship.confirm':{const p=pick(s.proposals,args.id);if(p.kind!=='relationship'||p.expires<now)throw new Error('关系提议不存在或已过期。');
          const order=Object.keys(stageLabels);if(order.indexOf(p.payload.stage)!==order.indexOf(s.persona.stage)+1)throw new Error('当前关系状态已变化。');
          s.persona.stage=p.payload.stage;s.persona.relationship.intimacy=Math.min(.8,s.persona.relationship.intimacy+.12);s.persona.relationship.affection=Math.min(.8,s.persona.relationship.affection+.1);episode('stage:'+p.payload.stage,`关系：${stageLabels[p.payload.stage]}`,'你与 '+characterName+' 在对话后明确确认了这段关系。','roleplay');s.proposals=s.proposals.filter(x=>x.id!==p.id);result.message='我记住了。我们按彼此舒服的节奏，继续相处。';break;}
        default:throw new Error('不支持的操作。');
      }
      if(purge){const w=ensureWebLife(s);w.epoch++;w.notes=[];w.seen=[];w.status='更正记忆后已清理衍生见闻。';w.attempts=w.attempts.map(({id,at,sourceId})=>({id,at,sourceId,status:'cleared'}));const a=ensureAgency(s,now);a.epoch++;a.artifacts=[];a.runs=a.runs.map(r=>({id:r.id,at:r.at,mode:r.mode,status:'cleared'}));const r=ensureResearch(s);r.epoch++;r.items=[];r.notices=[];r.runs=[];r.goals=[];r.status='更正记忆时已清理目标与衍生资料，避免旧结论被再次使用。';if(s.site)s.site.drafts=s.site.drafts.filter(d=>!['draft','blocked'].includes(d.status));if(s.selfStudy){s.selfStudy.epoch++;s.selfStudy.knowledge=[];s.selfStudy.attempts=s.selfStudy.attempts.map(({id,at})=>({id,at,status:'cleared'}));}s.summaries=[];s.episodes=[];s.proposals=[];s.persona.events=[];s.persona.conflicts=[];delete s.persona.characterFeeling;s.persona.stable.address='你';if(s.persona.inner){s.persona.inner.styleRules=[];s.persona.inner.appraisals=[];s.persona.inner.languageNotes=[];}if(s.persona.affect){s.persona.affect.recent=[];s.persona.affect.listeningUntil=0;}s.planHistory=[];this.store.purgeDerived();}
      if(replan){const previous=s.plan;const next=plan(s,now);if(previous)s.planHistory.push({revision:s.revision+1,plan:previous,restUntil:this.store.read().restUntil,notBefore:Object.fromEntries(this.store.read().tasks.map(t=>[t.id,t.notBefore]))});s.planHistory=s.planHistory.slice(-10);s.plan=next;result.plan=next;result.message+='\n'+this.changeText(next);}
      s.revision++;this.store.save(s);this.store.audit(now,action,{source,revision:s.revision});
      this.store.db.prepare('INSERT INTO commands(id,request,response,at) VALUES(?,?,?,?)').run(commandId,request,JSON.stringify(result),now);
      this.syncReminders(s,now);return result;
    });
  }
  changeText(p){const changed=p.changes.filter(c=>c.before.length||c.after.length).slice(0,8).map(c=>`${c.title}：${c.after.length?c.after.map(b=>`${stamp(b.start)}—${clockText(b.end)}`).join('；'):'未排入后续计划'}`);return [...changed,...p.unscheduled.map(t=>`待处理：${t.title}还有 ${t.minutes} 分钟未排入。${t.reason}`),...p.warnings.slice(0,4).map(w=>w.message)].join('\n')||'原来的安排仍然可行，已保留。';}
  confirm(proposalId,commandId,source){text(commandId,200);text(proposalId,200);const request=JSON.stringify({action:'proposal.confirm',args:{id:proposalId}});return this.store.transaction(()=>{const prior=this.store.db.prepare('SELECT request,response FROM commands WHERE id=?').get(commandId);if(prior){if(prior.request!==request&&prior.request!==tombstone(request))throw new Error('同一个请求编号不能重复执行不同操作。');return JSON.parse(prior.response);}const s=this.store.read(),p=pick(s.proposals,proposalId);if(p.expires<=this.clock())throw new Error('提议已过期，请重新提出。');let result;if(p.kind==='relationship')result=this.command('relationship.confirm',{id:p.id},commandId,source);else{if(p.kind!=='action')throw new Error('提议类型不正确。');if(p.revision!==s.revision)throw new Error('提议之后已有新的安排，请重新提出并核对最新状态。');result=this.command(p.payload.action,p.payload.args,commandId,source);const updated=this.store.read();updated.proposals=updated.proposals.filter(x=>x.id!==p.id);this.store.save(updated);}this.store.db.prepare('UPDATE commands SET request=? WHERE id=?').run(request,commandId);return result;});}
  syncReminders(s,now){syncScheduledNotices(this.store,s,now);}
}
