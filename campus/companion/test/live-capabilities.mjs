// Isolated dialogue probe: real model billing, no fabricated user turns in live memory.
import {DatabaseSync} from 'node:sqlite';
import {writeFileSync} from 'node:fs';
import {Store} from '../src/store.mjs';
import {Service} from '../src/service.mjs';
import {Models} from '../src/models.mjs';
import {Chat} from '../src/chat.mjs';
import {readConfig} from '../src/config.mjs';
import {nowMinute} from '../src/time.mjs';
if(!process.argv.includes('--paid-check'))throw new Error('Explicit --paid-check required');
const boot=await (await fetch('http://127.0.0.1:17839/api/bootstrap')).json();
const db=new DatabaseSync('data/miku.sqlite');db.exec('PRAGMA busy_timeout=5000');
const ledger={db,read:()=>JSON.parse(db.prepare('SELECT json FROM state WHERE id=1').get().json),transaction:fn=>{db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}};
// Synthetic empty profile only; never copy the user's private history into a diagnostic prompt.
const store=new Store(':memory:',nowMinute());
const service=new Service(store),models=new Models(ledger,readConfig),before=models.usage().spent,chat=new Chat(service,models);
// No fetch needed for a capability question; unexpected research is detected, not silently simulated.
chat.webLife={available:()=>service.state().webLife.sources.filter(x=>x.enabled),run:async()=>{throw new Error('Capability query unexpectedly tried to read.');}};
chat.runtimeInfo=()=>({connected:true,enabled:true,weixinReady:boot.weixin.ready,reason:boot.state.proactive.reason});
try{const result=await chat.run('你现在能自己上网找东西看、主动给我发日记了吗？');const record={at:new Date().toISOString(),text:result.text,warning:result.warning,webResult:result.webResult,advisor:result.advisor,costCny:models.usage().spent-before};writeFileSync('test-output/live-capabilities.json',JSON.stringify(record,null,2));console.log(JSON.stringify(record));}finally{store.close();db.close();}
