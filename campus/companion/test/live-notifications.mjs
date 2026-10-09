// Two real-model samples, isolated fictional facts, local capture only. No messenger sends.
import {DatabaseSync} from 'node:sqlite';
import {writeFileSync} from 'node:fs';
import {Store} from '../src/store.mjs';
import {Service} from '../src/service.mjs';
import {Chat} from '../src/chat.mjs';
import {Models} from '../src/models.mjs';
import {Scheduler} from '../src/reminders.mjs';
import {readConfig} from '../src/config.mjs';
import {dateKey,dateMinute,nowMinute} from '../src/time.mjs';
if(!process.argv.includes('--paid-check'))throw Error('Explicit --paid-check required');
const db=new DatabaseSync('data/miku.sqlite');db.exec('PRAGMA busy_timeout=5000');
const ledger={db,read:()=>JSON.parse(db.prepare('SELECT json FROM state WHERE id=1').get().json),transaction:fn=>{db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}};
const models=new Models(ledger,readConfig),callIds=[];
const reserve=models.reserve.bind(models);models.reserve=(...args)=>{const r=reserve(...args);callIds.push(r.id);return r;};
const day=dateKey(nowMinute()),at=dateMinute(day,'07:10'),store=new Store(':memory:',at),service=new Service(store,()=>at),chat=new Chat(service,models),captured=[];
try{
  store.addChat('user','明天早上九点要去做实验，我怕忘了带记录本。',at-600);
  store.addChat('assistant','记下了。你先睡吧。',at-600);
  service.command('block.add',{title:'实验（携带记录本）',start:day+' 09:00',end:day+' 10:00'});
  const scheduler=new Scheduler(service,{chat,weixinReady:()=>true,sendWeixin:async p=>captured.push(p.messages)});
  await scheduler.deliver();
  const began=Date.now(),reply=await chat.compose({message:'在吗'});
  const charges=callIds.map(id=>db.prepare('SELECT cost,reserved,status,provider,purpose,latency_ms FROM usage WHERE id=?').get(id));
  const result={at:new Date().toISOString(),model:readConfig().deepseekModel,notification:captured[0]||[],reply:reply.messages,replyElapsedMs:Date.now()-began,charges,costCny:charges.reduce((n,r)=>n+(r.cost??r.reserved),0),remoteMessagesSent:0};
  writeFileSync('test-output/live-notifications.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{store.close();db.close();}
