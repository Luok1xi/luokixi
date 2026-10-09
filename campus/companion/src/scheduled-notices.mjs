import {createHash} from 'node:crypto';
import {dateKey,dateMinute,stamp,clockText} from './time.mjs';
import {reviewTasks} from './review-tasks.mjs';

// Scheduling owns facts. Chat owns expression; routine notices have no canned speech.
export function noticePayload(key,notice,{kind='reminder',text='',...extra}={}){
  const noticeKey=createHash('sha256').update(JSON.stringify({key,notice})).digest('hex');
  return {kind,text,...extra,notice,noticeKey,noticeId:key};
}

export function scheduledNotices(s,now){
  if(!s.plan)return [];
  const rows=[],day=dateKey(now);
  const add=(key,due,expires,notice,options)=>{
    if(expires>now)rows.push({key,due,expires,payload:noticePayload(key,notice,options)});
  };
  for(const b of s.plan.fixed.filter(b=>b.kind==='course')){
    const travel=s.courses.find(c=>c.id===b.sourceId)?.travelBefore||0;
    add(b.id,b.start-travel-s.settings.reminderLead,b.start,
      {type:'course',title:b.title,start:stamp(b.start),location:b.location||null,travelMinutes:travel,locationKnown:false},
      {text:`${clockText(b.start)} ${b.title}${b.location?' · '+b.location:''}；预留通勤 ${travel} 分钟。`});
  }
  for(const t of s.tasks.filter(t=>t.status==='open'&&t.remaining>0)){
    add('deadline:'+t.id+':'+t.deadline,t.deadline-1440,t.deadline,
      {type:'deadline',taskId:t.id,title:t.title,deadline:stamp(t.deadline),remainingMinutes:t.remaining},
      {text:`「${t.title}」截止 ${stamp(t.deadline)}，记录中剩余 ${t.remaining} 分钟。`});
  }
  for(const b of s.plan.allocations){
    add(b.id,b.start-s.settings.reminderLead,b.start+15,
      {type:'task',taskId:b.taskId,title:b.title,start:stamp(b.start),minutes:b.end-b.start},
      {kind:'task',taskId:b.taskId,text:`${clockText(b.start)}「${b.title}」，预留 ${b.end-b.start} 分钟。`});
  }
  const items=[...s.plan.fixed.filter(b=>!['rest','travel','meal'].includes(b.kind)),...s.plan.allocations]
    .filter(b=>dateKey(b.start)===day).sort((a,b)=>a.start-b.start)
    .map(b=>({title:b.title,start:clockText(b.start),end:clockText(b.end),location:b.location||null}));
  const unscheduled=(s.plan.unscheduled||[]).filter(t=>s.tasks.some(x=>x.id===t.taskId&&x.status==='open'));
  if(items.length||unscheduled.length)add('morning:'+day,dateMinute(day,s.settings.morning),dateMinute(day,'12:00'),
    {type:'morning',day,items,unscheduled},{kind:'morning'});
  const review=reviewTasks(s,day);
  if(review.length)add('evening:'+day,dateMinute(day,s.settings.evening),dateMinute(day,s.settings.quietStart),
    {type:'review',day,tasks:review.map(t=>({id:t.id,title:t.title,remainingMinutes:t.remaining})),progress:'unknown_until_confirmed'},
    {kind:'review',reviewDay:day,taskIds:review.map(t=>t.id)});
  return rows;
}

export function syncScheduledNotices(store,s,now){
  const candidates=scheduledNotices(s,now);
  const insert=store.db.prepare("INSERT OR IGNORE INTO outbox(id,due,expires,payload,channel,next_try) VALUES(?,?,?,?,?,?)");
  const update=store.db.prepare("UPDATE outbox SET payload=?,due=?,expires=? WHERE id=? AND status='pending' AND (json_extract(payload,'$.noticeKey') IS NOT ? OR due<>? OR expires<>?)");
  for(const channel of ['local','feishu','weixin']){
    const ids=new Set(candidates.map(c=>channel+':'+c.key));
    for(const old of store.db.prepare("SELECT id FROM outbox WHERE channel=? AND status IN ('pending','sending')").all(channel)){
      if(!ids.has(old.id)&&!/:reply:|:proactive:|:digest:/.test(old.id))store.db.prepare("UPDATE outbox SET status='cancelled' WHERE id=?").run(old.id);
    }
    for(const c of candidates){
      const id=channel+':'+c.key,payload=JSON.stringify(c.payload);
      insert.run(id,c.due,c.expires,payload,channel,c.due);
      // Preserve the shared, already-written draft when the underlying facts have not changed.
      update.run(payload,c.due,c.expires,id,c.payload.noticeKey,c.due,c.expires);
    }
  }
}

export const routineNotice=payload=>['morning','review'].includes(payload.notice?.type);
