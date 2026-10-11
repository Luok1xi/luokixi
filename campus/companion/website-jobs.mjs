import {createHash} from 'node:crypto';

function canonical(value){
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));
  return value;
}

// One stable action identity per task and exact operation. Never identify a write by its prose.
export function actionIdentity(scope,operation,args){
  const hash=createHash('sha256').update(JSON.stringify([scope,operation,canonical(args)])).digest('hex');
  return `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;
}

// Same runtime database as persona/memory, separate durable transport receipts.
// A process restart cannot erase completed replies or silently repeat a running call.
export class WebsiteJobs {
  constructor(db){
    this.db=db;
    db.exec(`CREATE TABLE IF NOT EXISTS website_jobs(
      id TEXT PRIMARY KEY, state TEXT NOT NULL, result TEXT, error TEXT, updated INTEGER NOT NULL)`);
    const columns=new Set(db.prepare('PRAGMA table_info(website_jobs)').all().map(r=>r.name));
    for(const name of ['request','workflow'])if(!columns.has(name))db.exec(`ALTER TABLE website_jobs ADD COLUMN ${name} TEXT`);
    db.exec(`CREATE TABLE IF NOT EXISTS website_actions(
      id TEXT PRIMARY KEY, job_id TEXT NOT NULL, operation TEXT NOT NULL, arguments TEXT NOT NULL,
      state TEXT NOT NULL, result TEXT, error TEXT, updated INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS website_actions_job ON website_actions(job_id);
      CREATE TABLE IF NOT EXISTS website_chat_recorded(id TEXT PRIMARY KEY, at INTEGER NOT NULL)`);
    db.prepare("UPDATE website_jobs SET state='interrupted',error='原运行进程已中断，需要核验已有结果。' WHERE state='running'").run();
  }
  get(id){const r=this.db.prepare('SELECT state,result,error,request,workflow FROM website_jobs WHERE id=?').get(id);
    return r?{state:r.state,result:r.result?JSON.parse(r.result):undefined,error:r.error||undefined,
      request:r.request?JSON.parse(r.request):undefined,workflow:r.workflow?JSON.parse(r.workflow):undefined}:null;}
  put(id,row){const old=this.get(id)||{};
    this.db.prepare(`INSERT INTO website_jobs(id,state,result,error,updated,request,workflow) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET state=excluded.state,result=excluded.result,error=excluded.error,
      updated=excluded.updated,request=excluded.request,workflow=excluded.workflow`)
    .run(id,row.state||old.state,row.result?JSON.stringify(row.result):null,row.error||null,Date.now(),
      JSON.stringify(row.request||old.request||null),JSON.stringify(row.workflow||old.workflow||null));}
  checkpoint(id,patch){const row=this.get(id);if(!row)throw new Error('任务尚未登记。');
    this.put(id,{...row,workflow:{...row.workflow,...patch,updated:Date.now()}});}
  recoverable(){return this.db.prepare("SELECT id FROM website_jobs WHERE state='interrupted' AND request IS NOT NULL ORDER BY updated LIMIT 128").all()
    .map(r=>({id:r.id,...this.get(r.id)})).filter(r=>r.request&&['journal','langgraph'].includes(r.workflow?.engine));}
  actions(jobId){return this.db.prepare('SELECT * FROM website_actions WHERE job_id=? ORDER BY updated,id').all(jobId).map(r=>({...r,
    arguments:JSON.parse(r.arguments),result:r.result?JSON.parse(r.result):undefined}));}
  action(id){const r=this.db.prepare('SELECT * FROM website_actions WHERE id=?').get(id);return r?{...r,
    arguments:JSON.parse(r.arguments),result:r.result?JSON.parse(r.result):undefined}:null;}
  prepareAction(jobId,id,operation,args){
    const json=JSON.stringify(canonical(args)),prior=this.action(id);
    if(prior){if(prior.job_id!==jobId||prior.operation!==operation||JSON.stringify(canonical(prior.arguments))!==json)
      throw new Error('同一操作编号不能用于另一任务或不同内容。');return prior;}
    this.db.prepare("INSERT INTO website_actions(id,job_id,operation,arguments,state,updated) VALUES(?,?,?,?,'sent',?)")
      .run(id,jobId,operation,json,Date.now());return null;
  }
  settleAction(id,{state,result,error}){this.db.prepare('UPDATE website_actions SET state=?,result=?,error=?,updated=? WHERE id=?')
    .run(state,result?JSON.stringify(result):null,error||null,Date.now(),id);}
  remember(id,store,fn){store.transaction(()=>{
    if(this.db.prepare('SELECT 1 FROM website_chat_recorded WHERE id=?').get(id))return;
    fn();this.db.prepare('INSERT INTO website_chat_recorded VALUES(?,?)').run(id,Date.now());
  });}
}
