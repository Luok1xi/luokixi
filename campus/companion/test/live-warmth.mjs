// Explicit real-model check. Fictional scenarios stay in isolated databases; usage hits the real budget.
import {DatabaseSync} from 'node:sqlite';
import {writeFileSync} from 'node:fs';
import {Store} from '../src/store.mjs';
import {Service} from '../src/service.mjs';
import {Chat} from '../src/chat.mjs';
import {Models} from '../src/models.mjs';
import {readConfig} from '../src/config.mjs';
import {nowMinute} from '../src/time.mjs';
if(!process.argv.includes('--paid-check'))throw new Error('Pass --paid-check to use the real model budget.');
const db=new DatabaseSync('data/miku.sqlite');db.exec('PRAGMA busy_timeout=5000');
const ledger={db,read:()=>JSON.parse(db.prepare('SELECT json FROM state WHERE id=1').get().json),transaction:fn=>{db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}};
const models=new Models(ledger,readConfig),before=models.usage().spent;
const calls=[],complete=models.complete.bind(models);models.complete=async(messages,opts)=>{const out=await complete(messages,opts);calls.push({purpose:opts.purpose||'dialogue',text:out.text});return out;};
const scenes=[{name:'轻松接话',history:[],messages:['在吗','没啥，就是想找你说说话','今天终于把机器人电机调通啦！']},{name:'旧冷淡历史后',history:[['user','你好'],['assistant','嗯。有事说事。']],messages:['你怎么总是这么冷淡呀','我想听你说话温柔一点','嘿嘿，你这样就挺可爱']}];
try{const results=await Promise.all(scenes.map(async scene=>{const store=new Store(':memory:',nowMinute()),service=new Service(store),chat=new Chat(service,models),rows=[];try{for(const [role,text]of scene.history)store.addChat(role,text,nowMinute());for(const message of scene.messages){let stream='';const result=await chat.run(message,{mode:'auto',onDelta:delta=>stream+=delta});rows.push({user:message,reply:result.text,streamMatches:stream===result.text,provider:result.provider,thinking:result.thinking});console.log(JSON.stringify({scene:scene.name,...rows.at(-1)}));}return {scene:scene.name,rows};}finally{store.close();}}));const report={at:new Date().toISOString(),model:readConfig().deepseekModel,costCny:models.usage().spent-before,calls,results};writeFileSync('test-output/live-warmth.json',JSON.stringify(report,null,2));console.log(JSON.stringify({costCny:report.costCny}));}finally{db.close();}
