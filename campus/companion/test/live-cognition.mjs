import {DatabaseSync} from 'node:sqlite';
import {mkdir,writeFile} from 'node:fs/promises';
import {Store} from '../src/store.mjs';
import {Service} from '../src/service.mjs';
import {Models} from '../src/models.mjs';
import {Learning} from '../src/learning.mjs';
import {ResearchCortex} from '../src/research-cortex.mjs';
import {readConfig} from '../src/config.mjs';
import {nowMinute} from '../src/time.mjs';
if(!process.argv.includes('--paid-check'))throw new Error('Pass --paid-check');
const db=new DatabaseSync('data/miku.sqlite');db.exec('PRAGMA busy_timeout=5000');const ledger={db,read:()=>JSON.parse(db.prepare('SELECT json FROM state WHERE id=1').get().json),transaction:fn=>{db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}};const store=new Store(':memory:',nowMinute()),service=new Service(store),models=new Models(ledger,readConfig),before=models.usage().spent;
try{const cortex=new ResearchCortex(service,models),card=await cortex.run({manual:true}),report={at:new Date().toISOString(),research:{message:card.message,status:card.card?.status,commit:card.card?.commit,evidence:card.card?.evidence,title:card.card?.title}};console.log(JSON.stringify(report));const lesson=process.argv.includes('--card-only')?{message:'课程已验证，本次不重复调用'}:await new Learning(service,models).run({manual:true,topicId:'robotics'});report.learning={message:lesson.message,before:lesson.session?.baselineScore,after:lesson.session?.score,gain:lesson.session?.gain,evidence:lesson.session?.evidence};report.costCny=models.usage().spent-before;await mkdir('test-output',{recursive:true});await writeFile(process.argv.includes('--card-only')?'test-output/live-cognition-research.json':'test-output/live-cognition.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));if(!card.card||!process.argv.includes('--card-only')&&!lesson.session)process.exitCode=1;}finally{store.close();db.close();}
