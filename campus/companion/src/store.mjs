import {migrateCharacterVoice,migrateCharacterIdentity} from './character-card.mjs';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { defaultSettings } from './planner.mjs';
import { newPersona } from './persona.mjs';
import {ensureInnerLife} from './motivation.mjs';
import {ensureAffect} from './affect.mjs';
import {ensureStudy} from './curriculum.mjs';
import {createHash} from 'node:crypto';
export const tombstone=value=>'sha256:'+createHash('sha256').update(value).digest('hex');
export function initialState(now) {
  return { schemaVersion:2, revision:0, settings:structuredClone(defaultSettings), tasks:[], courses:[], blocks:[], memories:[], workLogs:[], dailyCaps:{}, restUntil:0, persona:newPersona(now), plan:null, planHistory:[], summaries:[], episodes:[], drafts:[], proposals:[], lastDaily:null, createdAt:now };
}
export class Store {
  constructor(path, now) {
    if (path!==':memory:') mkdirSync(dirname(path),{recursive:true});
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, request TEXT NOT NULL, response TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chat (id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS conversation_context (id INTEGER PRIMARY KEY CHECK(id=1), epoch INTEGER NOT NULL DEFAULT 0, through_id INTEGER NOT NULL DEFAULT 0, summary TEXT NOT NULL DEFAULT '', updated_at INTEGER);
      INSERT OR IGNORE INTO conversation_context(id) VALUES(1);
      CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, due INTEGER NOT NULL, expires INTEGER NOT NULL, payload TEXT NOT NULL, channel TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_try INTEGER NOT NULL, sent_at INTEGER, error TEXT, lease_until INTEGER, remote_id TEXT);
      CREATE TABLE IF NOT EXISTS inbox (id TEXT PRIMARY KEY, text TEXT NOT NULL, at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', response TEXT);
      CREATE TABLE IF NOT EXISTS usage (id TEXT PRIMARY KEY, month TEXT NOT NULL, provider TEXT NOT NULL, reserved REAL NOT NULL, cost REAL, status TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER, at INTEGER NOT NULL, latency_ms INTEGER);
      CREATE INDEX IF NOT EXISTS outbox_due ON outbox(status,next_try);`);
    if (!this.db.prepare('SELECT 1 FROM state WHERE id=1').get()) this.db.prepare('INSERT INTO state VALUES(1,?)').run(JSON.stringify(initialState(now)));
    if(!this.db.prepare('PRAGMA table_info(chat)').all().some(c=>c.name==='messages'))this.db.exec('ALTER TABLE chat ADD COLUMN messages TEXT');
    const s=this.read();
    if(s.schemaVersion<2) { const initial=initialState(now); for(const k of ['planHistory','episodes','drafts','proposals']) s[k]??=initial[k]; s.persona=newPersona(now);s.schemaVersion=2;this.save(s); }
    if(!s.persona.inner){ensureInnerLife(s.persona,now);this.save(s);}
    if(!s.persona.affect){ensureAffect(s.persona,now);this.save(s);}
    migrateCharacterVoice(s.persona,now);migrateCharacterIdentity(s.persona,now);
    ensureStudy(s);for(const row of s.study.sessions)if(row.status==='reading'){row.status='failed';row.error='上次学习在关机或重启时中断，没有记作完成。';}this.save(s);
    if(!this.db.prepare('PRAGMA table_info(usage)').all().some(c=>c.name==='purpose'))this.db.exec("ALTER TABLE usage ADD COLUMN purpose TEXT NOT NULL DEFAULT 'dialogue'");
    this.db.exec("UPDATE outbox SET status='cancelled' WHERE status='pending' AND id LIKE '%:proactive:%' AND json_extract(payload,'$.policyVersion') IS NULL");
    this.db.prepare("UPDATE outbox SET status='pending',lease_until=NULL WHERE status='sending'").run();
  }
  read() { return JSON.parse(this.db.prepare('SELECT json FROM state WHERE id=1').get().json); }
  save(state) { this.db.prepare('UPDATE state SET json=? WHERE id=1').run(JSON.stringify(state)); }
  transaction(fn) { const depth=this.depth||0;this.depth=depth+1;const savepoint='nested_'+depth;this.db.exec(depth?'SAVEPOINT '+savepoint:'BEGIN IMMEDIATE');try{const result=fn();this.db.exec(depth?'RELEASE '+savepoint:'COMMIT');return result;}catch(e){this.db.exec(depth?'ROLLBACK TO '+savepoint:'ROLLBACK');if(depth)this.db.exec('RELEASE '+savepoint);throw e;}finally{this.depth=depth;} }
  audit(at,kind,detail) { this.db.prepare('INSERT INTO history(at,kind,detail) VALUES(?,?,?)').run(at,kind,JSON.stringify(detail)); }
  addChat(role,text,at,messages=null) { this.db.prepare('INSERT INTO chat(role,text,at,messages) VALUES(?,?,?,?)').run(role,text,at,messages?JSON.stringify(messages):null); }
  chats() { return this.db.prepare('SELECT * FROM chat ORDER BY id DESC LIMIT 80').all().reverse().map(r=>({...r,messages:r.messages?JSON.parse(r.messages):null})); }
  history() { return this.db.prepare('SELECT * FROM history ORDER BY id DESC LIMIT 50').all().map(r=>({...r,detail:JSON.parse(r.detail)})); }
  purgeDerived(){
    this.db.exec("UPDATE conversation_context SET epoch=epoch+1,through_id=0,summary='',updated_at=NULL WHERE id=1");
    if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='crawl_cache'").get())this.db.exec('DELETE FROM crawl_cache; UPDATE crawl_epoch SET value=value+1');
    if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='tool_cache'").get())this.db.exec('DELETE FROM tool_cache');
    if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='research_cards'").get())this.db.exec('DELETE FROM research_cards; UPDATE cortex_meta SET value=value+1 WHERE id=1');
    if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='capability_runs'").get())this.db.exec('DELETE FROM capability_runs');
    if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='tool_lessons'").get())this.db.exec('DELETE FROM tool_lessons');
    if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='memory_vectors'").get())this.db.exec('DELETE FROM memory_vectors');
    if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='vision_cache'").get())this.db.exec('DELETE FROM vision_cache; UPDATE vision_epoch SET value=value+1 WHERE id=1');
    if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='weixin_private'").get())this.db.exec("DELETE FROM weixin_private WHERE key LIKE 'inbound-media:%'");
    this.db.exec('DELETE FROM chat; DELETE FROM history;');
    for(const c of this.db.prepare('SELECT id,request FROM commands').all())this.db.prepare('UPDATE commands SET request=?,response=? WHERE id=?').run(c.request.startsWith('sha256:')?c.request:tombstone(c.request),JSON.stringify({message:'该操作已经处理；相关历史内容已清理，不会重复执行。'}),c.id);
    for(const m of this.db.prepare('SELECT id,text FROM inbox').all())this.db.prepare("UPDATE inbox SET text=?,response=?,status='done' WHERE id=?").run(m.text.startsWith('sha256:')?m.text:tombstone(m.text),JSON.stringify({text:'这条消息的处理记录已清理，不会重新执行。',provider:'offline',results:[]}),m.id);
    this.db.exec("DELETE FROM outbox WHERE status IN ('pending','sending'); UPDATE outbox SET payload='{\"kind\":\"forgotten\",\"text\":\"相关历史内容已清理。\"}',error=NULL;");
  }
  messages() { return this.db.prepare('SELECT * FROM outbox ORDER BY due DESC LIMIT 100').all().map(r=>({...r,payload:JSON.parse(r.payload)})); }
  enqueue(id,due,expires,payload,channel) {
    this.db.prepare("INSERT OR IGNORE INTO outbox(id,due,expires,payload,channel,next_try) VALUES(?,?,?,?,?,?)").run(id,due,expires,JSON.stringify(payload),channel,due);
  }
  close() { this.db.close(); }
}
