// Synthetic conversation only; live credentials stay server-side and billing uses the actual ledger.
import {DatabaseSync} from 'node:sqlite';
import {writeFileSync} from 'node:fs';
import {Store} from '../src/store.mjs';
import {Service} from '../src/service.mjs';
import {Models} from '../src/models.mjs';
import {Chat} from '../src/chat.mjs';
import {readConfig} from '../src/config.mjs';
import {nowMinute} from '../src/time.mjs';
if(!process.argv.includes('--paid-check'))throw new Error('Explicit --paid-check required');
const db=new DatabaseSync('data/miku.sqlite');db.exec('PRAGMA busy_timeout=5000');
const ledger={db,read:()=>JSON.parse(db.prepare('SELECT json FROM state WHERE id=1').get().json),transaction:fn=>{db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}};
const store=new Store(':memory:',nowMinute()),service=new Service(store),models=new Models(ledger,readConfig),chat=new Chat(service,models),before=models.usage().spent,records=[];
try{
 const s=service.state();s.webLife.notes=[{id:'synthetic-note',title:'测试材料：传感器噪声',note:'模拟测试资料，不是真实联网阅读：传感器测量存在噪声，不能把单次读数看作绝对精确。',evidence:'传感器测量存在噪声',readLevel:'test-fixture',at:nowMinute()}];store.save(s);
 store.addChat('user','刚才那个测量噪声的例子，我大概懂了。你先休息一下',nowMinute()-45);
 store.addChat('assistant','嗯，我也缓缓。',nowMinute()-45);
 for(const input of [{message:'在吗'},{trigger:'proactive',material:{reason:'模拟间隔一段时间后想来聊聊；测量噪声已经谈过，不重新播报。'}}]){
  const began=Date.now(),result=await chat.compose(input);records.push({trigger:input.trigger||'reply',messages:result.messages,noteIds:result.noteIds,elapsedMs:Date.now()-began});
  store.addChat('assistant',result.text,nowMinute(),result.messages);
 }
 const record={at:new Date().toISOString(),records,costCny:models.usage().spent-before};writeFileSync('test-output/live-chain.json',JSON.stringify(record,null,2));console.log(JSON.stringify(record));
}finally{store.close();db.close();}
