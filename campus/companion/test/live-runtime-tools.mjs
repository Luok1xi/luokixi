// User-authorized diagnostics. Real reads use the running service and its normal budget.
import {writeFileSync} from 'node:fs';
const base='http://127.0.0.1:17839';
const response=await fetch(base+'/api/bootstrap');const initial=await response.json();
const headers={'Content-Type':'application/json','x-miku-token':initial.csrf,Cookie:response.headers.get('set-cookie').split(';')[0]};
async function post(path,data){const r=await fetch(base+path,{method:'POST',headers,body:JSON.stringify(data),signal:AbortSignal.timeout(240000)});const result=await r.json();if(!r.ok)throw new Error(result.error);return result;}
const before={received:initial.weixin.lastReceivedAt,spent:initial.usage.spent};
if(process.argv.includes('--read')){const r=await post('/api/web/read',{sourceId:'quanta'});console.log(JSON.stringify({read:r.message,noteId:r.note?.id,title:r.note?.title,url:r.note?.url,level:r.note?.readLevel,diary:r.note?.essay}));if(!r.note)process.exitCode=1;}
if(process.argv.includes('--send-diary')){const current=await (await fetch(base+'/api/state',{headers})).json();const note=current.state.webLife.notes.at(-1);if(!note)throw new Error('No real reading diary exists.');const r=await post('/api/web/share',{noteId:note.id});console.log(JSON.stringify({manualDelivery:r}));if(r.status!=='sent')process.exitCode=1;}
const current=await (await fetch(base+'/api/state',{headers})).json();const record={at:new Date().toISOString(),before,after:{received:current.weixin.lastReceivedAt,spent:current.usage.spent},weixin:{ready:current.weixin.ready,status:current.weixin.status},proactive:current.state.proactive,reading:current.state.webLife.status,creationEnabled:current.state.agency.creationEnabled};writeFileSync('test-output/live-runtime-tools.json',JSON.stringify(record,null,2));console.log(JSON.stringify(record));
