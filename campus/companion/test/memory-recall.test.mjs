import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.mjs';
import {Service} from '../src/service.mjs';
import {Chat} from '../src/chat.mjs';
import {recallMemories} from '../src/memory-recall.mjs';

const memory=(i,content)=>({id:'m'+i,content,category:'profile',confirmed:true,source:content,at:1000+i});
const filler=n=>Array.from({length:n},(_,i)=>memory(i+1,'第'+(i+1)+'周的社团值班记录'));

test('small memory sets are passed through unchanged',()=>{
 const rows=filler(12);assert.equal(recallMemories(rows,'花生'),rows);
});
test('an old memory returns when the current message shares words with it, newest memories stay',()=>{
 const rows=[memory(0,'用户对花生过敏'),...filler(80)],out=recallMemories(rows,'食堂今天的菜里有花生吗');
 assert.equal(out.length,40);assert.equal(out[0].id,'m0');
 assert.deepEqual(out.slice(-16),rows.slice(-16));
 assert.deepEqual(out.map(m=>m.at),[...out.map(m=>m.at)].sort((a,b)=>a-b));
});
test('an unrelated message keeps the previous latest-40 view',()=>{
 const rows=[memory(0,'用户对花生过敏'),...filler(80)];
 assert.deepEqual(recallMemories(rows,'晚安'),rows.slice(-40));
});
test('chat routing and writer prompts both see a relevant memory that the latest-40 window would drop',async()=>{
 const store=new Store(':memory:',10000);try{
  const service=new Service(store,()=>10000),s=store.read();s.memories=[memory(0,'用户对花生过敏'),...filler(80)];store.save(s);
  const systems=[];const models={config:()=>({deepseekKey:'test-only',openaiEnabled:false}),complete:async(messages,o)=>{systems.push(messages[0].content);return {text:(o.json && !['dialogue','initiative-share','initiative-reminder','work-log'].includes(o.purpose))?'{"actions":[],"act":"question"}':'有花生的话记得避开。'};}};
  await new Chat(service,models).run('食堂今天的菜里有花生吗');
  assert.equal(systems.length,2);for(const prompt of systems)assert.ok(prompt.includes('用户对花生过敏'));
 }finally{store.close();}
});
