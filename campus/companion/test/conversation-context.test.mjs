import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.mjs';
import {ConversationContext} from '../src/conversation-context.mjs';
import {ToolRegistry} from '../src/tool-registry.mjs';
const at=29823000;
const fill=(store,n=40,size=300)=>{for(let i=0;i<n;i++)store.addChat(i%2?'assistant':'user',`消息${i+1}：`+'原文'.repeat(size),at+i);};

test('all older turns compact in contiguous batches; originals and recent turns survive',async()=>{
 const store=new Store(':memory:',at);fill(store,240);const covered=[],prompts=[];
 const models={complete:async(messages)=>{const data=JSON.parse(messages[1].content);prompts.push(data);covered.push(...data.messages.map(m=>m.id));return {text:JSON.stringify({summary:'早期偏好、纠正和未完成任务汇总；只有明确回执才写成完成。已覆盖到消息 '+data.throughId})};}};
 const c=new ConversationContext(store,models,()=>at),before=JSON.stringify(c.project(at)).length;
 const identity=store.read().persona;
 const result=await c.compact();assert.equal(result.state,'done');assert.ok(result.batches>1);
 assert.deepEqual(covered,Array.from({length:228},(_,i)=>i+1));
 assert.ok(prompts.slice(1).every(p=>p.previous.includes('已覆盖到消息')));
 const after=c.project(at);assert.equal(after.history.length,12);assert.equal(after.summary.throughId,228);
 assert.equal(store.db.prepare('SELECT count(*) n FROM chat').get().n,240);
 assert.deepEqual(store.read().persona,identity);assert.ok(JSON.stringify(after).length<before/3);
 const registry=new ToolRegistry();c.register(registry);
 const ctx={maxRisk:'read',active:new Set(['conversation_history'])};
 const old=await registry.execute('conversation_history',{query:'消息1：'},ctx);assert.equal(old.messages[0].id,1);
 store.close();
});

test('background compaction is single flight and forgetting invalidates an in-flight summary',async()=>{
 const store=new Store(':memory:',at);fill(store);let finish,calls=0;
 const c=new ConversationContext(store,{complete:()=>{calls++;return new Promise(r=>{finish=r;});}},()=>at);
 const first=c.schedule(),second=c.schedule();assert.equal(first,second);assert.equal(calls,1);
 store.purgeDerived();finish({text:JSON.stringify({summary:'这份旧摘要不得在清除历史后重新出现。'})});
 assert.equal((await first).state,'superseded');assert.equal(c.project(at).summary,null);
 assert.equal(c.project(at).history.length,0);store.close();
});

test('failed summary retains original context and never borrows the other character memory',async()=>{
 const a=new Store(':memory:',at),b=new Store(':memory:',at);fill(a);
 b.addChat('user','仅给Codex的独立记忆',at);
 const ca=new ConversationContext(a,{complete:async()=>({text:'{"summary":'})},()=>at);
 const cb=new ConversationContext(b,{},()=>at);
 const result=await ca.schedule();assert.equal(result.state,'deferred');assert.equal(ca.project(at).history.length,40);
 assert.equal(ca.project(at).summary,null);assert.equal(cb.project(at).history.length,1);
 assert.ok(!JSON.stringify(ca.project(at)).includes('仅给Codex'));
 a.close();b.close();
});

test('new messages arriving during compaction stay outside the committed prefix',async()=>{
 const store=new Store(':memory:',at);fill(store);let finish;
 const c=new ConversationContext(store,{complete:()=>new Promise(r=>{finish=r;})},()=>at);
 const work=c.compact();store.addChat('user','新决定不能被旧摘要吞掉',at+50);
 finish({text:JSON.stringify({summary:'旧对话已整理，新的用户决定必须优先读取原文。'})});await work;
 assert.equal(c.project(at).history.at(-1).text,'新决定不能被旧摘要吞掉');
 assert.equal(c.record().through_id,28);store.close();
});
