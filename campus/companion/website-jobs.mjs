// Same runtime database as persona/memory, separate durable transport receipts.
// A process restart cannot erase completed replies or silently repeat a running call.
export class WebsiteJobs {
  constructor(db){
    this.db=db;
    db.exec(`CREATE TABLE IF NOT EXISTS website_jobs(
      id TEXT PRIMARY KEY, state TEXT NOT NULL, result TEXT, error TEXT, updated INTEGER NOT NULL)`);
    db.prepare("UPDATE website_jobs SET state='interrupted',error='原运行进程已中断，需要核验已有结果。' WHERE state='running'").run();
  }
  get(id){const r=this.db.prepare('SELECT state,result,error FROM website_jobs WHERE id=?').get(id);
    return r?{state:r.state,result:r.result?JSON.parse(r.result):undefined,error:r.error||undefined}:null;}
  put(id,row){this.db.prepare(`INSERT INTO website_jobs(id,state,result,error,updated) VALUES(?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET state=excluded.state,result=excluded.result,error=excluded.error,updated=excluded.updated`)
    .run(id,row.state,row.result?JSON.stringify(row.result):null,row.error||null,Date.now());}
}
