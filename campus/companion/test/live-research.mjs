// Explicit paid verification only: isolated test goals/notes, real shared budget ledger.
import {DatabaseSync} from 'node:sqlite';
import {writeFileSync,mkdirSync} from 'node:fs';
import {Store} from '../src/store.mjs';
import {Service} from '../src/service.mjs';
import {Models} from '../src/models.mjs';
import {readConfig} from '../src/config.mjs';
import {Research} from '../src/research.mjs';
import {nowMinute} from '../src/time.mjs';
if(!process.argv.includes('--paid-check'))throw new Error('This check calls the paid model. Pass --paid-check explicitly.');
const db=new DatabaseSync('data/miku.sqlite');db.exec('PRAGMA busy_timeout=5000');
const ledger={db,read:()=>JSON.parse(db.prepare('SELECT json FROM state WHERE id=1').get().json),transaction:fn=>{db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}};
const store=new Store(':memory:',nowMinute()),service=new Service(store),models=new Models(ledger,readConfig),before=models.usage().spent;
try{service.command('research.goal',{title:'验收测试：关注机器人导航研究',evidence:'隔离测试，不是用户的真实目标',keywords:'robot navigation'});const engine=new Research(service,models);const result=await engine.run({manual:true});const record={at:new Date().toISOString(),result,run:store.read().research.runs[0],items:store.read().research.items,costCny:models.usage().spent-before};mkdirSync('test-output',{recursive:true});writeFileSync('test-output/research-live-model.json',JSON.stringify(record,null,2));console.log(JSON.stringify({result,status:record.run?.status,costCny:record.costCny,count:record.items.length,first:record.items[0]?.title,error:record.run?.error}));}finally{store.close();db.close();}
