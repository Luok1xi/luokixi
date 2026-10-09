// Real public reading + model writing/checking. Test notes remain isolated, costs use the real ledger.
import {DatabaseSync} from 'node:sqlite';
import {writeFileSync} from 'node:fs';
import {Store} from '../src/store.mjs';
import {Service} from '../src/service.mjs';
import {Models} from '../src/models.mjs';
import {readConfig} from '../src/config.mjs';
import {WebLife} from '../src/web-life.mjs';
import {nowMinute} from '../src/time.mjs';
if(!process.argv.includes('--paid-check'))throw new Error('Explicit --paid-check required.');
const db=new DatabaseSync('data/miku.sqlite');db.exec('PRAGMA busy_timeout=5000');
const ledger={db,read:()=>JSON.parse(db.prepare('SELECT json FROM state WHERE id=1').get().json),transaction:fn=>{db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}};
const store=new Store(':memory:',nowMinute()),service=new Service(store),models=new Models(ledger,readConfig),before=models.usage().spent;
try{const web=new WebLife(service,models),result=await web.run({sourceId:'quanta'}),state=service.state();const record={at:new Date().toISOString(),model:readConfig().deepseekModel,costCny:models.usage().spent-before,result,attempts:state.webLife.attempts};writeFileSync('test-output/live-web-life.json',JSON.stringify(record,null,2));console.log(JSON.stringify({status:state.webLife.attempts[0]?.status,costCny:record.costCny,title:result.note?.title,level:result.note?.readLevel,essay:result.note?.essay,error:result.message}));if(!result.note)process.exitCode=1;}finally{store.close();db.close();}
