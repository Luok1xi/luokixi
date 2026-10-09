import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Store} from '../src/store.mjs';
import {Service} from '../src/service.mjs';
import {CrawlEngine} from '../src/crawl-engine.mjs';
import {Inquiry} from '../src/inquiry.mjs';
import {Scheduler} from '../src/reminders.mjs';
import {WebTools} from '../src/web-tools.mjs';
import {StickerFinder} from '../src/sticker-finder.mjs';
import {expressiveStickers,parseChain} from '../src/message-chain.mjs';
import {dateMinute} from '../src/time.mjs';
const at=dateMinute('2026-09-21','21:00'),body='Robotic control requires feedback from sensors. Sampling noise affects the measured state and must be evaluated independently.';
function fixture(){const store=new Store(':memory:',at),service=new Service(store,()=>at);return {store,service};}
test('Crawlee deduplicates concurrent URLs, bounds concurrency, and reuses persistent cache after reconstruction',async()=>{
 const f=fixture();let calls=0,active=0,maximum=0;const reader={document:async url=>{calls++;active++;maximum=Math.max(maximum,active);await new Promise(r=>setTimeout(r,15));active--;return {url,text:body};}};
 try{const c=new CrawlEngine({...f,reader});const rows=await c.documents(['https://example.com/a','https://example.com/b','https://example.com/a']);assert.equal(rows.length,2);assert.equal(calls,2);assert.equal(maximum,2);const restarted=new CrawlEngine({...f,reader});assert.equal((await restarted.document('https://example.com/a')).cached,true);assert.equal(calls,2);await Promise.all([c.document('https://example.com/c'),c.document('https://example.com/c')]);assert.equal(calls,3);await c.tail;}finally{f.store.close();}
});
test('Crawlee retries transient errors once, but never repeats verification or policy refusals',async()=>{
 const f=fixture(),calls={};const reader={document:async url=>{calls[url]=(calls[url]||0)+1;if(url.endsWith('verify'))throw Error('需要验证码');if(url.endsWith('policy'))throw Error('robots 不允许');if(calls[url]===1)throw Error('socket closed');return {url,text:body};}};
 try{const c=new CrawlEngine({...f,reader});const rows=await c.documents(['https://example.com/retry','https://example.com/verify','https://example.com/policy']);assert.ok(rows[0].document);assert.match(rows[1].error,/验证码/);assert.match(rows[2].error,/robots/);assert.deepEqual(Object.values(calls),[2,1,1]);await c.tail;}finally{f.store.close();}
});
test('forgetting invalidates in-flight crawler results and does not refill the cache',async()=>{
 const f=fixture();let release,started;const ready=new Promise(r=>started=r),reader={document:()=>{started();return new Promise(r=>release=r);}};
 try{const c=new CrawlEngine({...f,reader}),pending=c.document('https://example.com/old');const rejected=assert.rejects(pending,/清除/);await ready;f.store.purgeDerived();release({text:body});await rejected;await c.tail;assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM crawl_cache').get().n,0);}finally{f.store.close();}
});
test('zero-task evening review is absent; legacy queued reviews are cancelled before overdue merging',async()=>{
 const f=fixture();try{f.service.command('replan');assert.equal(f.store.messages().filter(x=>x.status==='pending'&&x.id.includes(':evening:')).length,0);let sent=0;for(const channel of ['local','feishu'])f.store.enqueue(channel+':evening:2026-09-21',at-60,at+30,{text:'今天辛苦了。0 项任务仍待你确认进度'},channel);await new Scheduler(f.service,{feishuReady:()=>true,sendFeishu:async()=>{sent++;}}).deliver();assert.equal(sent,0);for(const r of f.store.db.prepare("SELECT status FROM outbox WHERE id LIKE '%:evening:%'").all())assert.equal(r.status,'cancelled');}finally{f.store.close();}
});
test('evening review rechecks completed tasks and names only unresolved work',async()=>{
 const f=fixture();try{f.service.command('task.add',{title:'当日作业',remaining:30,deadline:'2026-09-21 23:59'});const task=f.service.state().tasks[0];assert.ok(f.store.messages().some(r=>r.id.includes(':evening:')&&r.payload.notice?.tasks.some(t=>t.title==='当日作业')));const s=f.store.read();s.tasks[0].status='done';s.tasks[0].remaining=0;f.store.save(s);await new Scheduler(f.service).deliver();assert.equal(f.store.messages().filter(x=>x.status==='pending'&&x.id.includes(':evening:')).length,0);}finally{f.store.close();}
});
test('bulk tool validates every input URL before any network call and preserves partial failures',async()=>{
 let calls=0;const tools=new WebTools({reader:{documents:async urls=>{calls++;return urls.map(url=>({url,error:'HTTP 403'}));}}});const bad=await tools.run({tool:'read_many',urls:['https://example.com/secret'],evidence:'比较'},'比较 https://example.com/public');assert.match(bad.error,/本次用户消息/);assert.equal(calls,0);const result=await tools.run({tool:'read_many',urls:['https://example.com/public'],evidence:'比较'},'比较 https://example.com/public');assert.equal(calls,1);assert.equal(result.result[0].error,'HTTP 403');
});
function inquiryFixture({bad=false,review=true,evidenceId}={}){
 const f=fixture(),s=f.service.state();s.webLife.notes=[{id:'parent',at:at-90,title:'控制',question:'采样噪声如何影响反馈？',url:'https://example.com/parent'}];f.store.save(s);
 const calls=[],models={config:()=>({deepseekKey:'test'}),complete:async(m,o)=>{calls.push(o.purpose);const values={'learning-inquiry-plan':{questionId:'parent',query:'robot feedback sampling'},'learning-inquiry-select':{indices:[0]},'learning-inquiry-note':{sourceIndex:0,note:'资料说明机器人控制依赖传感器反馈，测量噪声必须单独验证。',evidence:bad?'invented evidence not in paper':'Robotic control requires feedback',application:'先比较不同采样率下的测量误差。',question:'滤波如何影响延迟？'},'learning-inquiry-check':{supported:review}};if(o.purpose==='learning-inquiry-note'&&evidenceId!==undefined)values[o.purpose]={...values[o.purpose],evidenceId,evidence:undefined};return {text:JSON.stringify(values[o.purpose])};}};
 const entry={url:'https://arxiv.org/abs/2601.00001',title:'Feedback',text:body,readLevel:'abstract-or-feed'},reader={documents:async()=>[{url:entry.url,error:'HTTP 403'}]},search={papers:async()=>[entry]};return {...f,calls,inquiry:new Inquiry(f.service,models,{reader,search})};
}
test('autonomous inquiry follows a real question, preserves abstract-only limits and leaves application untested',async()=>{
 const f=inquiryFixture();try{assert.equal(f.inquiry.due(),true);const r=await f.inquiry.run();assert.ok(r.note);assert.equal(r.note.parentQuestionId,'parent');assert.equal(r.note.readLevel,'abstract-or-feed');assert.equal(r.note.applicationStatus,'untested');assert.match(r.note.limitations[0],/摘要/);assert.equal(f.inquiry.due(),false);assert.equal(f.calls.length,4);await f.inquiry.run();assert.equal(f.calls.length,4);}finally{f.store.close();}
});
test('unsupported inquiry evidence never resolves the parent question or becomes knowledge',async()=>{
 for(const options of [{bad:true},{review:false}]){const f=inquiryFixture(options);try{const r=await f.inquiry.run();assert.equal(r.note,undefined);assert.equal(f.service.state().webLife.notes.length,1);assert.equal(f.service.state().webLife.notes[0].followedUpAt,undefined);assert.equal(f.service.state().webLife.attempts.at(-1).status,'failed');}finally{f.store.close();}}
});
test('Miku catalogue contains real PNGs and preserves the model-selected expressive chain',async()=>{
 for(const s of expressiveStickers.filter(x=>x.id.startsWith('miku_'))){const b=await readFile(new URL('../public/stickers/'+s.file,import.meta.url));assert.equal(b.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.ok(b.length>30000);}const reply=parseChain(JSON.stringify({messages:[{type:'sticker',id:'miku_07'},{type:'text',text:'怎么啦'}]}));assert.equal(reply.messages[0].id,'miku_07');assert.equal(reply.messages[1].text,'怎么啦');
});
test('online sticker discovery pins public collection and caches daily checks without downloading existing art',async()=>{
 const f=fixture();let calls=0;try{const finder=new StickerFinder(f.service,{read:async url=>{calls++;return {status:200,text:JSON.stringify(url.includes('/commits/')?{sha:'a'.repeat(40)}:[{name:'Miku_01.png',size:70000,type:'file'}])};},downloads:{download:()=>{throw Error('must reuse');}}});const a=await finder.find('害羞');assert.equal(a.stickers[0].id,'miku_07');assert.equal(a.discovery.status,'checked');await finder.find('音乐');assert.equal(calls,2);}finally{f.store.close();}
});

test('evidence IDs are bound to actual text; clearing notes preserves inquiry daily cap',async()=>{for(const evidenceId of [0,999]){const f=inquiryFixture({evidenceId});try{const r=await f.inquiry.run();assert.equal(!!r.note,evidenceId===0);if(r.note)assert.ok(body.includes(r.note.evidence));f.service.command('web.clear');assert.equal(f.service.state().webLife.attempts.at(-1).kind,'inquiry');}finally{f.store.close();}}});
