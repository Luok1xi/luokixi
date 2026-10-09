import {dateKey,clockText,startOfDay} from './time.mjs';
import {decay} from './persona.mjs';
import {scheduledNotices,noticePayload,routineNotice} from './scheduled-notices.mjs';
export function isQuiet(settings,now){const t=clockText(now),a=settings.quietStart,b=settings.quietEnd;return a===b?false:a>b?t>=a||t<b:t>=a&&t<b;}

export class Scheduler{
  constructor(service,{chat=null,sendFeishu=null,feishuReady=()=>false,sendWeixin=null,weixinReady=()=>false}={}){
    Object.assign(this,{service,chat,sendFeishu,feishuReady,sendWeixin,weixinReady,running:false,inflight:null});
  }
  daily(){
    const svc=this.service,now=svc.clock(),day=dateKey(now),s=svc.store.read();
    if(s.lastDaily!==day){
      svc.command('replan',{},'daily-plan:'+day,'scheduler');
      svc.store.transaction(()=>{
        const state=svc.store.read();decay(state.persona,now);
        if(state.lastDaily){
          state.summaries.push({id:'summary:'+day,at:now,kind:'facts',text:`截至 ${day}：${state.tasks.filter(t=>t.status==='done').length} 项任务明确完成，${state.tasks.filter(t=>t.status==='open').length} 项待确认。未回复不代表违约。`,memoryIds:[]});
          state.summaries=state.summaries.slice(-30);
        }
        state.lastDaily=day;svc.store.save(state);
      });
    }
    svc.syncReminders(svc.store.read(),now);
  }
  async tick(){if(this.running)return;this.running=true;try{this.daily();await this.deliver();}finally{this.running=false;}}
  deliver(){
    if(!this.inflight)this.inflight=this.deliverPending().finally(()=>{this.inflight=null;});
    return this.inflight;
  }
  refreshNotices(){
    const {store,clock}=this.service,now=clock(),current=new Map(scheduledNotices(store.read(),now).map(r=>[r.key,r]));
    for(const row of store.db.prepare("SELECT * FROM outbox WHERE status IN ('pending','sending') AND (json_extract(payload,'$.notice') IS NOT NULL OR id LIKE '%:morning:%' OR id LIKE '%:evening:%' OR json_extract(payload,'$.kind')='review')").all()){
      const old=JSON.parse(row.payload),key=old.noticeId||row.id.slice(row.channel.length+1);
      if(routineNotice(old)&&old.noticeDraft&&old.noticeDraft.conversationId!==store.db.prepare("SELECT MAX(id) id FROM chat WHERE role='user'").get().id){
        store.db.prepare("UPDATE outbox SET status='cancelled',error='已有新对话，普通提醒旧稿不再补发。' WHERE id=?").run(row.id);continue;
      }
      let next=current.get(key);
      if(old.notice?.type==='digest'){
        const items=old.notice.items.filter(item=>item.expires>now&&(!item.noticeKey||current.get(item.key)?.payload.noticeKey===item.noticeKey));
        if(items.length)next={due:row.due,expires:Math.min(...items.map(i=>i.expires)),payload:this.digestPayload(key,items)};
      }
      if(!next){store.db.prepare("UPDATE outbox SET status='cancelled',error='事项已失效或没有实际内容。' WHERE id=?").run(row.id);continue;}
      if(old.noticeKey!==next.payload.noticeKey||row.due!==next.due||row.expires!==next.expires)
        store.db.prepare('UPDATE outbox SET payload=?,due=?,expires=? WHERE id=?').run(JSON.stringify(next.payload),next.due,next.expires,row.id);
    }
  }
  digestPayload(key,items){
    return noticePayload(key,{type:'digest',items},{kind:'digest',text:[...new Set(items.map(x=>x.text).filter(Boolean))].join('\n')});
  }
  mergeOverdue(channel,now){
    const {store}=this.service;
    const overdue=store.db.prepare("SELECT * FROM outbox WHERE channel=? AND status='pending' AND due<? AND expires>? AND (json_extract(payload,'$.kind') IS NULL OR json_extract(payload,'$.kind') IN ('reminder','task')) AND id NOT LIKE '%:morning:%'").all(channel,now-30,now);
    if(overdue.length<2)return;
    const items=overdue.map(r=>{const p=JSON.parse(r.payload);return {key:p.noticeId||r.id.slice(channel.length+1),noticeKey:p.noticeKey||null,facts:p.notice||null,text:p.text,expires:r.expires};}).sort((a,b)=>a.key.localeCompare(b.key));
    const key=`digest:${dateKey(now)}:${Math.floor(now/60)}`,payload=this.digestPayload(key,items);
    store.transaction(()=>{
      if(store.db.prepare('SELECT status FROM outbox WHERE id=?').get(channel+':'+key))return;
      for(const r of overdue)store.db.prepare("UPDATE outbox SET status='superseded' WHERE id=? AND status='pending'").run(r.id);
      store.enqueue(channel+':'+key,now,Math.min(...items.map(i=>i.expires)),payload,channel);
    });
  }
  maySend(payload,now){
    if(payload.kind==='reply')return payload.replySeq===undefined||this.service.store.db.prepare('SELECT COALESCE(MAX(seq),0) seq FROM inbox_arrivals WHERE id LIKE ?').get(payload.replyScope).seq===payload.replySeq;
    const s=this.service.store.read();
    if(s.settings.remindersPaused||isQuiet(s.settings,now))return false;
    if(payload.kind==='research')return false;
    if(payload.kind!=='proactive')return true;
    if(payload.socialSourceId&&!this.social?.valid(payload))return false;
    if(this.service.store.db.prepare("SELECT 1 FROM inbox WHERE status='pending' AND (id LIKE 'weixin:%' OR id LIKE 'feishu:%') LIMIT 1").get())return false;
    if(payload.conversationId!==undefined&&payload.conversationId!==this.service.store.db.prepare("SELECT MAX(id) id FROM chat WHERE role='user'").get().id)return false;
    return !s.persona.paused&&
      (payload.researchEpoch===undefined||(s.research?.enabled&&s.research.epoch===payload.researchEpoch&&!s.research.items.find(n=>n.id===payload.researchItemId)?.discussedAt))&&
      (payload.webEpoch===undefined||(s.webLife?.enabled&&s.webLife.epoch===payload.webEpoch&&!s.webLife.notes.find(n=>n.id===payload.webNoteId)?.discussedAt))&&
      (payload.agencyEpoch===undefined||(s.agency?.enabled&&s.agency.epoch===payload.agencyEpoch));
  }
  async express(payload){
    if(!payload.notice||payload.noticeDraft)return payload;
    const {store}=this.service,key=payload.noticeKey;
    const cached=store.db.prepare("SELECT payload FROM outbox WHERE json_extract(payload,'$.noticeKey')=? AND json_extract(payload,'$.noticeDraft') IS NOT NULL LIMIT 1").get(key);
    if(cached)return JSON.parse(cached.payload);
    let output,mode='model';
    try{
      if(!this.chat)throw new Error('表达模型未接入');
      output=await this.chat.exclusive(()=>this.chat.compose({trigger:'notification',act:'sharing',material:{notice:payload.notice}}));
      if(!output.messages?.some(m=>m.type==='text'&&m.text.trim())){
        if(routineNotice(payload))return null;
        throw new Error('必要提醒没有可发送的文字');
      }
    }catch(e){
      if(routineNotice(payload))return null;
      // Important deadlines still work without paid models, visibly as factual system notifications.
      mode='system';output={text:'系统提醒：'+payload.text,messages:[{type:'text',text:'系统提醒：'+payload.text}]};
    }
    return {...payload,text:output.text,messages:output.messages,noticeDraft:{key,mode,at:this.service.clock(),conversationId:store.db.prepare("SELECT MAX(id) id FROM chat WHERE role='user'").get().id}};
  }
  recordDelivery(row,payload,remote,now){
    const {store}=this.service;
    store.transaction(()=>{
      store.db.prepare("UPDATE outbox SET status='sent',sent_at=?,remote_id=?,error=NULL,lease_until=NULL WHERE id=?").run(now,remote||null,row.id);
      if(row.channel==='local'&&(payload.kind==='proactive'||payload.noticeDraft?.mode==='model'))store.addChat('assistant',payload.text,now,payload.messages);
      if(!payload.agencyRunId)return;
      const s=store.read(),a=s.agency,r=a?.runs.find(x=>x.id===payload.agencyRunId);
      if(!r||!['queued','delivered'].includes(r.status)||a.epoch!==payload.agencyEpoch)return;
      if(r.status==='queued')a.needs.expression=Math.max(.05,a.needs.expression-.15);
      r.status='delivered';r.deliveries??={};r.deliveries[row.channel]={status:'sent',at:now};
      r.result=r.deliveries.weixin?'微信接口已接受这条消息；手机通知仍以设备实收为准。':r.deliveries.feishu?'已发送到飞书；微信送达状态请查看主动消息通道。':'已出现在电脑聊天中；微信是否送达请查看主动消息通道。';
      store.save(s);
    });
  }
  async deliverPending(){
    const svc=this.service,db=svc.store.db,now=svc.clock();
    db.prepare("UPDATE outbox SET status='expired' WHERE status IN ('pending','sending') AND expires<=?").run(now);
    db.prepare("UPDATE outbox SET status='pending' WHERE status='sending' AND lease_until<=?").run(now);
    db.exec("UPDATE outbox SET status='cancelled' WHERE status IN ('pending','sending') AND json_extract(payload,'$.kind')='research'");
    this.refreshNotices();
    for(const channel of ['local','feishu','weixin']){
      if(channel==='weixin'&&!this.weixinReady()||channel==='feishu'&&!this.feishuReady())continue;
      this.mergeOverdue(channel,svc.clock());
      const rows=db.prepare("SELECT * FROM outbox WHERE channel=? AND status='pending' AND next_try<=? AND due<=? AND expires>? ORDER BY due LIMIT 20").all(channel,svc.clock(),svc.clock(),svc.clock());
      for(const row of rows){
        let payload=JSON.parse(row.payload);
        const current=svc.store.read(),at=svc.clock(),reply=payload.kind==='reply';
        // User turns and ongoing learning keep the conversation lock; optional drafting can wait.
        if(payload.notice&&!payload.noticeDraft&&this.chat?.active)continue;
        if(!this.maySend(payload,at)){
          if(payload.kind==='reply'||payload.kind==='proactive'&&!current.settings.remindersPaused&&!isQuiet(current.settings,at))db.prepare("UPDATE outbox SET status='cancelled' WHERE id=?").run(row.id);
          continue;
        }
        const sent=db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE channel=? AND status='sent' AND sent_at>=? AND COALESCE(json_extract(payload,'$.kind'),'reminder') NOT IN ('reply','proactive')").get(channel,startOfDay(at)).n;
        const recent=db.prepare("SELECT MAX(sent_at) AS at FROM outbox WHERE channel=? AND status='sent' AND id NOT LIKE '%:reply:%'").get(channel).at;
        if(!reply&&((payload.kind!=='proactive'&&sent>=current.settings.maxReminders)||(recent!=null&&at-recent<10)))continue;
        if(db.prepare("UPDATE outbox SET status='sending',lease_until=?,attempts=attempts+1 WHERE id=? AND status='pending'").run(at+3,row.id).changes!==1)continue;
        try{
          const userId=db.prepare("SELECT MAX(id) id FROM chat WHERE role='user'").get().id;
          const needsDraft=!!payload.notice&&!payload.noticeDraft;
          const expressed=await this.express(payload);
          this.refreshNotices();
          const fresh=db.prepare('SELECT * FROM outbox WHERE id=?').get(row.id),freshPayload=JSON.parse(fresh.payload);
          if(fresh.status!=='sending')continue;
          if(fresh.expires<=svc.clock()){db.prepare("UPDATE outbox SET status='expired',lease_until=NULL WHERE id=?").run(row.id);continue;}
          if(fresh.due>svc.clock()||freshPayload.noticeKey!==payload.noticeKey||!this.maySend(payload,svc.clock())){
            db.prepare("UPDATE outbox SET status='pending',lease_until=NULL WHERE id=?").run(row.id);continue;
          }
          if(needsDraft&&userId!==db.prepare("SELECT MAX(id) id FROM chat WHERE role='user'").get().id){
            db.prepare("UPDATE outbox SET status='pending',next_try=?,lease_until=NULL WHERE json_extract(payload,'$.noticeKey')=? AND status IN ('pending','sending')").run(svc.clock()+1,payload.noticeKey);continue;
          }
          if(!expressed){
            db.prepare("UPDATE outbox SET status='cancelled',error='本次没有需要补充的提醒表达。',lease_until=NULL WHERE json_extract(payload,'$.noticeKey')=? AND status IN ('pending','sending')").run(payload.noticeKey);continue;
          }
          payload=expressed;
          if(payload.noticeDraft)db.prepare("UPDATE outbox SET payload=? WHERE json_extract(payload,'$.noticeKey')=? AND status IN ('pending','sending')").run(JSON.stringify(payload),payload.noticeKey);
          const remote=channel==='local'?null:await(channel==='weixin'?this.sendWeixin(payload,row.id):this.sendFeishu(payload,row.id));
          this.recordDelivery(row,payload,remote,svc.clock());
        }catch(e){
          db.prepare("UPDATE outbox SET status=?,next_try=?,error=?,lease_until=NULL WHERE id=? AND status='sending'").run(row.attempts>=5?'failed':'pending',svc.clock()+Math.min(60,2**row.attempts),String(e.message).slice(0,300),row.id);
        }
      }
    }
  }
}
