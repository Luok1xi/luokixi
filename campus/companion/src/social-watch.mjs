import {dateKey,startOfDay} from './time.mjs';
import {createHash} from 'node:crypto';

export class SocialWatch{
  constructor(service,library,readers){
    Object.assign(this,{service,library,readers,db:service.store.db,inflight:null,closed:false});
    this.db.exec(`CREATE TABLE IF NOT EXISTS social_settings(platform TEXT PRIMARY KEY,enabled INTEGER NOT NULL DEFAULT 0,epoch INTEGER NOT NULL DEFAULT 0,last_poll INTEGER,detail TEXT,status TEXT,next_poll INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS social_sources(platform TEXT NOT NULL,remote TEXT NOT NULL,source_id TEXT,dirty_since INTEGER,last_changed INTEGER,last_attempt INTEGER,analyzed_revision INTEGER DEFAULT 0,PRIMARY KEY(platform,remote));
      CREATE TABLE IF NOT EXISTS social_seen(platform TEXT NOT NULL,remote TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(platform,remote,id));
      CREATE TABLE IF NOT EXISTS social_attempts(at INTEGER NOT NULL,source_id TEXT NOT NULL);`);
    for(const platform of Object.keys(readers))this.db.prepare("INSERT OR IGNORE INTO social_settings(platform,status,detail) VALUES(?,'disabled','未启用自动读取')").run(platform);
  }
  status(){return {channels:this.db.prepare('SELECT * FROM social_settings').all(),sources:this.db.prepare('SELECT platform,source_id,last_changed,analyzed_revision FROM social_sources WHERE source_id IS NOT NULL').all(),todayAnalyses:this.db.prepare('SELECT COUNT(*) n FROM social_attempts WHERE at>=?').get(startOfDay(this.service.clock())).n};}
  configure(platform,enabled){
    if(!Object.hasOwn(this.readers,platform)||typeof enabled!=='boolean')throw Error('读取设置无效。');
    this.db.prepare("UPDATE social_settings SET enabled=?,epoch=epoch+1,next_poll=0,status=?,detail=? WHERE platform=?").run(+enabled,enabled?'waiting':'disabled',enabled?'等待下一次自动读取':'已暂停；已保存的片段可单独删除',platform);
    this.db.prepare("UPDATE outbox SET status='cancelled' WHERE status IN ('pending','sending') AND json_extract(payload,'$.socialPlatform')=?").run(platform);
    this.readers[platform].reset?.();return this.status();
  }
  valid(payload){
    const setting=this.db.prepare('SELECT * FROM social_settings WHERE platform=?').get(payload.socialPlatform);
    const source=this.db.prepare('SELECT revision FROM conversation_sources WHERE id=?').get(payload.socialSourceId);
    return !!setting?.enabled&&setting.epoch===payload.socialEpoch&&source?.revision===payload.socialRevision;
  }
  ingest(platform,threads){
    let added=0;
    for(const thread of threads.slice(0,3)){
      if(typeof thread.remote!=='string'||!thread.remote||thread.remote.length>200||!Array.isArray(thread.messages))continue;
      const messages=thread.messages.filter(m=>m&&typeof m.id==='string'&&m.id.length<200&&!this.db.prepare('SELECT 1 FROM social_seen WHERE platform=? AND remote=? AND id=?').get(platform,thread.remote,m.id));
      if(!messages.length)continue;
      this.service.store.transaction(()=>{
        const old=this.db.prepare('SELECT * FROM social_sources WHERE platform=? AND remote=?').get(platform,thread.remote),exists=old?.source_id&&this.db.prepare('SELECT 1 FROM conversation_sources WHERE id=?').get(old.source_id);
        const saved=this.library.import({title:thread.title,kind:thread.kind,messages,sourceId:exists?old.source_id:undefined},{managed:true});
        const now=this.service.clock();for(const m of messages)this.db.prepare('INSERT OR IGNORE INTO social_seen VALUES(?,?,?,?)').run(platform,thread.remote,m.id,now);
        this.db.prepare(`INSERT INTO social_sources(platform,remote,source_id,dirty_since,last_changed) VALUES(?,?,?,?,?) ON CONFLICT(platform,remote) DO UPDATE SET source_id=excluded.source_id,dirty_since=COALESCE(social_sources.dirty_since,excluded.dirty_since),last_changed=excluded.last_changed`).run(platform,thread.remote,saved.sourceId,now,now);
        added+=saved.added;
      });
    }
    return added;
  }
  tick(){if(this.closed||this.inflight)return this.inflight||Promise.resolve();this.inflight=this.run().finally(()=>this.inflight=null);return this.inflight;}
  async run(){
    for(const platform of Object.keys(this.readers)){
      const row=this.db.prepare('SELECT * FROM social_settings WHERE platform=?').get(platform),now=this.service.clock();
      if(!row.enabled||row.next_poll>now||this.closed)continue;
      const allowed=()=>!this.closed&&this.db.prepare('SELECT enabled,epoch FROM social_settings WHERE platform=?').get(platform)?.epoch===row.epoch;
      this.db.prepare('UPDATE social_settings SET next_poll=? WHERE platform=?').run(now+1,platform);
      try{
        const result=await this.readers[platform].scan();if(!allowed())continue;
        if(!Array.isArray(result.threads))throw Error('读取组件返回格式错误。');
        const count=this.ingest(platform,result.threads);this.readers[platform].ack?.(result.threads);
        this.db.prepare('UPDATE social_settings SET status=?,detail=?,last_poll=?,next_poll=? WHERE platform=?').run(String(result.status).slice(0,30),String(result.detail).slice(0,500)+(count?' 新增 '+count+' 条。':''),now,now+(result.status==='blocked'?10:1),platform);
      }catch{this.readers[platform].reset?.();this.db.prepare("UPDATE social_settings SET status='blocked',detail='读取或保存失败，稍后自动重试；未把失败当成没有新消息。',next_poll=? WHERE platform=?").run(now+10,platform);}
    }
    if(this.closed||this.library.chat.active||this.service.store.read().persona.paused)return;
    if(this.db.prepare("SELECT 1 FROM inbox WHERE status='pending' LIMIT 1").get())return;
    const now=this.service.clock(),attempts=this.db.prepare('SELECT COUNT(*) n,MAX(at) last FROM social_attempts WHERE at>=?').get(startOfDay(now));
    if(attempts.n>=8||attempts.last!=null&&now-attempts.last<30)return;
    const candidate=this.db.prepare(`SELECT s.*,c.revision,x.epoch FROM social_sources s JOIN conversation_sources c ON c.id=s.source_id JOIN social_settings x ON x.platform=s.platform WHERE x.enabled=1 AND s.dirty_since IS NOT NULL AND (s.last_changed<=? OR s.dirty_since<=?) AND (s.last_attempt IS NULL OR s.last_attempt<=?) ORDER BY s.dirty_since LIMIT 1`).get(now-2,now-15,now-120);
    if(!candidate)return;
    const payload={kind:'proactive',socialPlatform:candidate.platform,socialEpoch:candidate.epoch,socialSourceId:candidate.source_id,socialRevision:candidate.revision,policyVersion:5};
    const allowed=()=>!this.closed&&this.valid(payload);
    this.db.prepare('INSERT INTO social_attempts VALUES(?,?)').run(now,candidate.source_id);this.db.prepare('UPDATE social_sources SET last_attempt=? WHERE platform=? AND remote=?').run(now,candidate.platform,candidate.remote);
    try{
      const result=await this.library.analyze(candidate.source_id,{automatic:true,allowed});if(!allowed())return;
      this.db.prepare('UPDATE social_sources SET analyzed_revision=?,dirty_since=NULL WHERE platform=? AND remote=?').run(result.revision,candidate.platform,candidate.remote);
      if(result.notify&&result.text){
        const key=createHash('sha256').update(candidate.source_id+':'+result.revision).digest('hex').slice(0,24);
        const conversationId=this.db.prepare("SELECT MAX(id) id FROM chat WHERE role='user'").get().id;
        this.service.store.transaction(()=>{for(const channel of ['local','weixin','feishu'])this.service.store.enqueue(channel+':social:'+key,now,now+60,{...payload,conversationId,text:result.text,messages:result.messages},channel);});
      }
    }catch{if(allowed())this.db.prepare("UPDATE social_settings SET detail='消息已采集，自动分析暂未完成；请检查模型余额与连接。' WHERE platform=?").run(candidate.platform);}
  }
  async close(){this.closed=true;await this.inflight;}
}
