// Explicit paid integration check; isolated persona and artifacts, real shared usage ledger.
import {DatabaseSync} from 'node:sqlite';
import {writeFileSync} from 'node:fs';
import {Store} from '../src/store.mjs';
import {Service} from '../src/service.mjs';
import {Chat} from '../src/chat.mjs';
import {Models} from '../src/models.mjs';
import {Agency} from '../src/agency.mjs';
import {readConfig} from '../src/config.mjs';
import {dateMinute,dateKey,nowMinute} from '../src/time.mjs';
if(!process.argv.includes('--paid-check'))throw new Error('Pass --paid-check to use the real budget.');
const db=new DatabaseSync('data/miku.sqlite');db.exec('PRAGMA busy_timeout=5000');
const ledger={db,read:()=>JSON.parse(db.prepare('SELECT json FROM state WHERE id=1').get().json),transaction:fn=>{db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}};
const models=new Models(ledger,readConfig),before=models.usage().spent,now=dateMinute(dateKey(nowMinute()),'10:00');
const store=new Store(':memory:',now),service=new Service(store,()=>now),chat=new Chat(service,models),agency=new Agency(service,chat,models,{running:false});
try{const s=service.state();s.study.enabled=false;s.agency.needs.creation=.9;store.save(s);const result=await agency.run();const a=service.state().agency;if(!['done','rest'].includes(a.runs[0]?.status))throw Error(JSON.stringify(result));const report={model:readConfig().deepseekModel,costCny:models.usage().spent-before,result,runs:a.runs,artifacts:a.artifacts};writeFileSync('test-output/live-agency.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));}finally{store.close();db.close();}
