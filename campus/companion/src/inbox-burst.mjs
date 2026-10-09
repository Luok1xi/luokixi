import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

// Transport receipt order is separate from the user's original (minute) timestamp.
export class InboxBurst{
  constructor(store,{quietMs=1800,maxWaitMs=12000,clock=Date.now,sleep=delay}={}){
    Object.assign(this,{store,db:store.db,quietMs,maxWaitMs,clock,sleep});
    this.db.exec('CREATE TABLE IF NOT EXISTS inbox_arrivals(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,received_ms INTEGER NOT NULL)');
  }
  received(id){this.db.prepare('INSERT OR IGNORE INTO inbox_arrivals(id,received_ms) VALUES(?,?)').run(id,this.clock());}
  latest(prefix){return this.db.prepare('SELECT COALESCE(MAX(seq),0) seq FROM inbox_arrivals WHERE id LIKE ?').get(prefix).seq;}
  async settle(prefix,allowed=()=>true){
    const start=this.clock();
    while(allowed()){
      const last=this.db.prepare('SELECT MAX(received_ms) at FROM inbox_arrivals WHERE id LIKE ?').get(prefix).at;
      const remaining=Math.min(this.quietMs-(this.clock()-(last??0)),this.maxWaitMs-(this.clock()-start));
      if(remaining<=0)return;await this.sleep(remaining);
    }
  }
  claim(prefix,{media=()=>false}={}){
    return this.store.transaction(()=>{
      // An unfinished durable batch is resumed with the same request ID after restart.
      const existing=this.db.prepare("SELECT * FROM inbox WHERE id LIKE ? AND status='pending' AND id LIKE '%:burst-%' ORDER BY rowid LIMIT 1").get(prefix);
      if(existing)return {row:existing,seq:this.latest(prefix),members:[]};
      const candidates=this.db.prepare("SELECT * FROM inbox WHERE id LIKE ? AND status='pending' ORDER BY rowid LIMIT 40").all(prefix);
      if(!candidates.length)return null;
      const rows=[];let size=0;
      for(const row of candidates){if(rows.length&&(media(row.id)||media(rows[0].id)||size+row.text.length+1>8000))break;rows.push(row);size+=row.text.length+1;}
      if(rows.length===1)return {row:rows[0],seq:this.latest(prefix),members:[]};
      const id=rows[0].id+':burst-'+createHash('sha256').update(JSON.stringify(rows.map(x=>x.id))).digest('hex').slice(0,24);
      const row={id,text:rows.map(x=>x.text).join('\n'),at:rows[0].at};
      this.db.prepare('INSERT OR IGNORE INTO inbox(id,text,at) VALUES(?,?,?)').run(id,row.text,row.at);
      for(const original of rows)this.db.prepare("UPDATE inbox SET status='batched',response=? WHERE id=?").run(JSON.stringify({batchId:id}),original.id);
      return {row,seq:this.latest(prefix),members:rows.map(x=>x.id)};
    });
  }
  current(prefix,batch){return this.latest(prefix)===batch.seq;}
  retry(batch){
    this.store.transaction(()=>{
      const members=this.db.prepare("SELECT id FROM inbox WHERE status='batched' AND json_extract(response,'$.batchId')=?").all(batch.row.id);
      if(!members.length)return;
      this.db.prepare("UPDATE inbox SET status='superseded' WHERE id=?").run(batch.row.id);
      for(const m of members)this.db.prepare("UPDATE inbox SET status='pending',response=NULL WHERE id=?").run(m.id);
    });
  }
}
