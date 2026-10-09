import {DatabaseSync} from 'node:sqlite';
import {writeFile,mkdir} from 'node:fs/promises';
import {Store} from '../src/store.mjs';
import {Service} from '../src/service.mjs';
import {Models} from '../src/models.mjs';
import {readConfig} from '../src/config.mjs';
import {dateKey,dateMinute,nowMinute} from '../src/time.mjs';
import {Inquiry} from '../src/inquiry.mjs';
import {CrawlEngine} from '../src/crawl-engine.mjs';
import {PublicReader} from '../src/public-reader.mjs';
if(!process.argv.includes('--paid-check'))throw Error('Pass --paid-check for a metered isolated test');
const db=new DatabaseSync('data/miku.sqlite');db.exec('PRAGMA busy_timeout=5000');const ledger={db,read:()=>JSON.parse(db.prepare('SELECT json FROM state WHERE id=1').get().json),transaction:fn=>{db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}};
const at=dateMinute(dateKey(nowMinute()),'10:00'),store=new Store(':memory:',at),service=new Service(store,()=>at),models=new Models(ledger,readConfig),publicReader=new PublicReader(),reader=new CrawlEngine({service,reader:{document:async url=>(await publicReader.source({url,kind:'page'}))[0]}}),before=models.usage().spent;
const complete=models.complete.bind(models);models.complete=async(m,o)=>{console.log('stage',o.purpose);return complete(m,o);};
try{const s=service.state();s.webLife.notes=[{id:'isolated-test-question',at:at-120,title:'工具学习问题验证',question:'How can autonomous agents learn reusable tool-use skills from execution feedback?',url:'https://aclanthology.org/2025.acl-long.1266/'}];store.save(s);const result=await new Inquiry(service,models,{reader}).run();const report={at:new Date().toISOString(),isolatedTest:true,message:result.message,note:result.note,costCny:models.usage().spent-before};await mkdir('test-output',{recursive:true});await writeFile('test-output/live-inquiry.json',JSON.stringify(report,null,2));console.log(JSON.stringify({message:report.message,title:result.note?.title,readLevel:result.note?.readLevel,applicationStatus:result.note?.applicationStatus,costCny:report.costCny}));if(!result.note)process.exitCode=1;}finally{await reader.tail;store.close();db.close();}
