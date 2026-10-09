import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.mjs';
import {Service} from '../src/service.mjs';
import {Models} from '../src/models.mjs';
import {Chat} from '../src/chat.mjs';
import {parseChain} from '../src/message-chain.mjs';
import {readFileSync} from 'node:fs';
import {characterCard} from '../src/character-card.mjs';

const now=29858340;
const chain=JSON.stringify({messages:[{type:'text',text:'等一下，刚才那句话我还记得呀。'}]});
function writer(responses){
  const store=new Store(':memory:',now),calls=[];
  const models={config:()=>({deepseekKey:'test'}),complete:async(messages,options)=>{
    calls.push({messages:structuredClone(messages),options});
    if(options.purpose==='routing')return {text:JSON.stringify({actions:[]})};
    const next=responses.shift();if(next instanceof Error)throw next;return {text:next};
  }};
  return {store,calls,chat:new Chat(new Service(store,()=>now),models)};
}

test('shared writer requests JSON and retries only expression, preserving wording and personality',async()=>{
  const f=writer(['{"messages":[',chain]);try{
    const reply=await f.chat.run('刚才说到哪里了？',{requestId:'repair'});
    assert.equal(reply.text,JSON.parse(chain).messages[0].text);
    assert.equal(f.calls.filter(c=>c.options.purpose==='routing').length,1);
    const writes=f.calls.filter(c=>c.options.purpose==='dialogue');assert.equal(writes.length,2);
    for(const call of writes){assert.equal(call.options.json,true);assert.equal(call.options.stream,false);assert.ok(call.messages[0].content.includes(characterCard.voice));}
    assert.equal(f.chat.service.state().chat.filter(m=>m.role==='user').length,1);
    assert.equal(f.chat.service.state().chat.filter(m=>m.role==='assistant').length,1);
  }finally{f.store.close();}
});

test('repeated malformed output returns an error and never teaches fallback wording to personality',async()=>{
  const f=writer(['{"messages":[','{"messages":[']);try{
    const reply=await f.chat.run('你好呀',{requestId:'broken'});
    assert.equal(reply.error.code,'invalid_message_chain');
    assert.equal(f.calls.length,3);assert.equal(f.chat.service.state().chat.filter(m=>m.role==='assistant').length,0);
    assert.equal(f.chat.service.state().chat.filter(m=>m.role==='user').length,1);
  }finally{f.store.close();}
});

test('network or budget error is not retried as a formatting fault',async()=>{
  const f=writer([new Error('每日 5 元总预算')]);try{
    const reply=await f.chat.run('你好呀',{requestId:'budget'});
    assert.equal(reply.error.code,'generation_failed');assert.equal(f.calls.length,2);
  }finally{f.store.close();}
});

test('cancelled composition never makes a second model call',async()=>{
  const f=writer(['{"messages":[',chain]);try{
    const reply=await f.chat.compose({message:'旧消息',isCurrent:()=>f.calls.length===0});
    assert.equal(reply.superseded,true);assert.equal(f.calls.length,1);
  }finally{f.store.close();}
});

test('complete fenced chains are accepted but incomplete or invalid chains remain rejected',()=>{
  assert.equal(parseChain('```json\n'+chain+'\n```').text,JSON.parse(chain).messages[0].text);
  assert.throws(()=>parseChain('```json\n{"messages":[\n```'));
  assert.throws(()=>parseChain('```json\n'+chain));
  assert.throws(()=>parseChain('{"messages":[{"type":"text","text":"半条"},'));
  assert.throws(()=>parseChain('{"messages":[{"type":"sticker","id":"missing"}]}'));
});

test('work log uses its own task instruction with the exact same persona',async()=>{
  const f=writer([chain]);try{
    await f.chat.compose({trigger:'report',material:{published:2,failed:1}});
    const call=f.calls[0];assert.equal(call.options.purpose,'work-log');
    assert.match(call.messages[0].content,/严格区分你做的、站主做的/);
    assert.ok(call.messages[0].content.includes(characterCard.voice));
    assert.doesNotMatch(call.messages[0].content,/对方要求你现在分享这条阅读记录/);
  }finally{f.store.close();}
});

test('QQ export and the card actually injected into chat have matching persona fields',()=>{
  const role=readFileSync(new URL('../roles/小煤渣.md',import.meta.url),'utf8');
  for(const field of ['identity','personality','voice','care','self','interests','lore'])assert.ok(role.includes(characterCard[field]),field);
  assert.doesNotMatch(role,/qq_send_message|\[SILENT\]|qq_mark_read/);
});

function streamModel(parts){
  const store=new Store(':memory:',now);
  const models=new Models(store,()=>({deepseekKey:'test',deepseekModel:'deepseek-flash',monthlyLimit:200}),{
    clock:()=>now,fetcher:async()=>new Response(new ReadableStream({start(controller){for(const part of parts)controller.enqueue(part);controller.close();}}))});
  return {store,models};
}
const sse=(text,finish)=>'data: '+JSON.stringify({choices:[{delta:{content:text},finish_reason:finish}],usage:finish?{prompt_tokens:20,completion_tokens:10}:undefined});

test('stream preserves final frame without a newline and Chinese characters split between bytes',async()=>{
  const bytes=Buffer.from(sse(chain.slice(0,-2),null)+'\r\n\r\n'+sse(chain.slice(-2),'stop'));
  const f=streamModel([...bytes].map(b=>Uint8Array.of(b)));try{
    const reply=await f.models.complete([{role:'user',content:'test'}],{stream:true,maxOutput:200});
    assert.equal(reply.text,chain);assert.equal(reply.usage.completion_tokens,10);assert.equal(parseChain(reply.text).messages.length,1);
  }finally{f.store.close();}
});

test('stream without a finish marker is a transport failure even if it resembles valid text',async()=>{
  const f=streamModel([Buffer.from(sse(chain,null)+'\n')]);try{
    await assert.rejects(f.models.complete([{role:'user',content:'test'}],{stream:true,maxOutput:200}),/传输未完整结束/);
  }finally{f.store.close();}
});
