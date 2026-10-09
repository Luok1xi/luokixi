import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.mjs';
import {Service} from '../src/service.mjs';
import {Chat} from '../src/chat.mjs';
import {Agency} from '../src/agency.mjs';
import {Scheduler} from '../src/reminders.mjs';
import {parseChain,recordDiscussed} from '../src/message-chain.mjs';
import {PublicReader} from '../src/public-reader.mjs';
import {dateMinute} from '../src/time.mjs';

test('model-selected bubbles preserve exact wording, repetitions and sticker-only replies',()=>{
 const messages=[{type:'text',text:'嗯！\n  等等～'},{type:'sticker',id:'eyes'},{type:'sticker',id:'eyes'}];
 assert.deepEqual(parseChain(JSON.stringify({messages})).messages,messages);
 assert.equal(parseChain('嗯……').text,'嗯……');
 assert.equal(parseChain('{"messages":[{"type":"sticker","id":"wave"}]}').messages.length,1);
 assert.equal(parseChain('{"messages":[]}',{allowSilence:true}).messages.length,0);
 for(const raw of ['','null','{"messages":[]}','{"messages":[','{"messages":[{"type":"text","text":"hi"},{"type":"sticker","id":"unknown"}]}',JSON.stringify({messages:Array(25).fill(messages[0])})])assert.throws(()=>parseChain(raw));
});
function fixture(){let now=dateMinute('2026-09-21','10:00');const store=new Store(':memory:',now),service=new Service(store,()=>now),requests=[];
 const models={config:()=>({deepseekKey:'test'}),complete:async(messages,opts)=>{requests.push({messages,opts});return {text:opts.purpose==='initiative-decision'?JSON.stringify({action:'chat',reason:'想接着刚才聊'}):JSON.stringify({messages:[{type:'text',text:'刚才那个思路，我还在想。'},{type:'sticker',id:'think'}]})};}};
 const chat=new Chat(service,models);store.addChat('user','刚才说的是测量误差',now-90);return {store,service,models,chat,requests,advance:m=>now+=m};}
test('both triggers use the same writer, persisted relationship, history and model-authored chain',async()=>{const f=fixture();try{
 const s=f.service.state();s.persona.stable.address='小明';f.store.save(s);
 const passive=await f.chat.compose({message:'你在想什么？'}),active=await f.chat.compose({trigger:'proactive'});
 assert.deepEqual(active.messages,passive.messages);
 for(const r of f.requests){assert.match(r.messages[0].content,/当前角色卡/);assert.match(r.messages[0].content,/小明/);assert.match(r.messages[1].content,/刚才说的是测量误差/);}
 assert.equal(f.requests[0].messages[0].content.split('\n只输出 JSON')[0].split('当前记录：')[0],f.requests[1].messages[0].content.split('\n只输出 JSON')[0].split('当前记录：')[0]);
}finally{f.store.close();}});
test('discussed web and research records cancel old pending or partly sending reports and persist',()=>{const f=fixture();try{
 const s=f.service.state();s.webLife.notes=[{id:'web1'}];s.research.items=[{id:'research1'}];f.store.save(s);
 f.store.enqueue('web',f.service.clock(),f.service.clock()+60,{kind:'proactive',webNoteId:'web1'},'weixin');
 f.store.enqueue('research',f.service.clock(),f.service.clock()+60,{kind:'proactive',researchItemId:'research1'},'weixin');
 f.store.db.prepare("UPDATE outbox SET status='sending' WHERE id='research'").run();recordDiscussed(f.store,['web1','research1'],f.service.clock());
 assert.ok(f.store.messages().every(r=>r.status==='cancelled'));assert.ok(f.store.read().webLife.notes[0].discussedAt);assert.ok(f.store.read().research.items[0].discussedAt);
}finally{f.store.close();}});

test('public journals retain original emotion and learned voice without replaying private stale facts',async()=>{const f=fixture();try{
 const s=f.service.state();s.persona.emotions.proud=.42;
 s.persona.characterFeeling={name:'happy',intensity:.8,evidence:'私聊暗号PRIVATE-ONLY',at:f.service.clock(),id:'mood'};
 s.persona.inner.styleRules=[{rule:'简短而自然',kind:'user-style-preference',source:'不要播报'}];
 s.memories.push({id:'private',content:'私聊暗号PRIVATE-ONLY',confirmed:true});f.store.save(s);
 f.store.addChat('assistant','旧故障OLD-BLOCKER：邮箱验证没通过，今天写了二十条',f.service.clock());
 const before=JSON.stringify(f.service.state());
 await f.chat.compose({trigger:'report',material:{workLog:{periodDays:7,published:3}}});
 const request=f.requests.at(-1),prompt=JSON.stringify(request.messages);
 assert.match(prompt,/简短而自然/);assert.match(prompt,/happy/);assert.match(prompt,/0.42/);
 assert.match(prompt,/periodDays/);assert.doesNotMatch(prompt,/PRIVATE-ONLY|OLD-BLOCKER|测量误差/);
 assert.equal(JSON.stringify(f.service.state()),before);
 const privateWriter=f.chat.writerStep({message:'接着聊'});
 assert.match(JSON.stringify(privateWriter.messages),/PRIVATE-ONLY|OLD-BLOCKER/);
}finally{f.store.close();}});
test('can initiate multiple batches without a new reply, observes configured cap and pause',async()=>{const f=fixture();try{
 const a=new Agency(f.service,f.chat,f.models,{running:false}),scheduler=new Scheduler(f.service);
 f.service.command('agency.settings',{dailyBurstLimit:2,maxUnanswered:0});
 await a.runShare();await scheduler.deliver();f.advance(31);await a.runShare();await scheduler.deliver();
 assert.equal(f.store.chats().filter(r=>r.role==='assistant').length,2);assert.equal(a.canShare(f.service.state()),false);
 assert.ok(f.store.chats().filter(r=>r.role==='assistant').every(r=>r.messages[1].id==='think'));
 f.service.command('agency.settings',{enabled:false});assert.equal(a.shareDue(),false);
}finally{f.store.close();}});
test('ordinary reminder quota does not silently prevent a permitted proactive batch',async()=>{const f=fixture();try{
 const s=f.service.state();s.settings.maxReminders=1;f.store.save(s);
 f.store.enqueue('local:old',f.service.clock()-60,f.service.clock()+60,{kind:'reminder',text:'old'},'local');
 f.store.db.prepare("UPDATE outbox SET status='sent',sent_at=? WHERE id='local:old'").run(f.service.clock()-60);
 f.store.enqueue('local:proactive:new',f.service.clock(),f.service.clock()+60,{kind:'proactive',text:'hello',policyVersion:4},'local');
 await new Scheduler(f.service).deliver();assert.equal(f.store.db.prepare("SELECT status FROM outbox WHERE id='local:proactive:new'").get().status,'sent');
}finally{f.store.close();}});
test('robots cache avoids duplicate downloads but enforces rules on every requested path',async()=>{
 const urls=[],r=new PublicReader({read:async url=>{urls.push(url);return {status:200,text:url.endsWith('robots.txt')?'User-agent: *\nDisallow: /private':`<html><head><title>A</title></head><body><article>${'A public paragraph about mathematics. '.repeat(40)}</article></body></html>`};}});
 await r.source({url:'https://example.com/a'});await r.source({url:'https://example.com/b'});await assert.rejects(r.source({url:'https://example.com/private'}),/不允许/);
 assert.equal(urls.filter(u=>u.endsWith('robots.txt')).length,1);assert.ok(!urls.includes('https://example.com/private'));
 for(const c of r.robotsCache.values())c.until=0;await r.source({url:'https://example.com/c'});assert.equal(urls.filter(u=>u.endsWith('robots.txt')).length,2);
});
test('normal answer registers a discussed article and prevents its older pending push',async()=>{const f=fixture();try{
 const s=f.service.state();s.webLife.notes=[{id:'w1',title:'编码器',note:'测量存在噪声',at:f.service.clock()-60}];f.store.save(s);
 f.store.enqueue('weixin:proactive:old',f.service.clock(),f.service.clock()+60,{kind:'proactive',webNoteId:'w1',text:'旧稿',policyVersion:4},'weixin');
 f.models.complete=async(m,o)=>({text:o.purpose==='routing'?JSON.stringify({actions:[],act:'question'}):JSON.stringify({messages:[{type:'text',text:'读的是编码器测量噪声。'}],references:[{noteId:'w1',evidence:'编码器测量噪声'}]})});
 await f.chat.run('今天读了什么？');assert.ok(f.store.read().webLife.notes[0].discussedAt);assert.equal(f.store.messages()[0].status,'cancelled');
}finally{f.store.close();}});
test('academic findings use the shared writer and old fixed reports are retired',async()=>{const f=fixture();try{
 const s=f.service.state();s.research.enabled=true;s.research.items=[{id:'r1',title:'讲座通知',note:'明天有讲座',priority:3,at:f.service.clock()-60,source:{url:'https://example.com/notice'}}];f.store.save(s);
 f.store.enqueue('weixin:research:legacy',f.service.clock(),f.service.clock()+60,{kind:'research',text:'今天整理到这些'},'weixin');
 const a=new Agency(f.service,f.chat,f.models,{running:false});assert.equal(f.store.messages()[0].status,'cancelled');
 f.models.complete=async(m,o)=>{f.requests.push({messages:m,opts:o});return {text:o.purpose==='initiative-decision'?JSON.stringify({action:'share_research',reason:'讲座和目标有关'}):JSON.stringify({messages:[{type:'text',text:'这场讲座你可能会喜欢。'}]})};};
 await a.runShare();assert.equal(f.store.messages().filter(r=>r.payload.kind==='proactive').length,3);assert.match(f.requests.at(-1).messages[0].content,/当前角色卡/);assert.equal(f.store.read().research.items[0].sharedAt,f.service.clock());
}finally{f.store.close();}});
