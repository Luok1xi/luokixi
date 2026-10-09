import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.mjs';
import {Service} from '../src/service.mjs';
import {Chat} from '../src/chat.mjs';




test('social wording, spelling and punctuation come unchanged from the model, including streamed delivery and retries',async()=>{
 const store=new Store(':memory:',10000);try{
 const service=new Service(store,()=>10000);let calls=0;const seen=[];
 const models={config:()=>({deepseekKey:'test',openaiEnabled:false}),complete:async(messages,o)=>{
 calls++;assert.notEqual(o.purpose,'voice-repair');seen.push(messages);
 if((o.json && !['dialogue','initiative-share','initiative-reminder','work-log'].includes(o.purpose)))return {text:JSON.stringify({actions:[],act:'social',thinking:'fast'})};
 const text='Miku。\n嗯……你想聊什么？';o.onDelta?.(text.slice(0,5));o.onDelta?.(text.slice(5));return {text};
 }};
 const chat=new Chat(service,models);
 for(const [i,message] of ['你是谁','你叫什么名字？','不要装萌行不行','可以查看好感度不','ni'].entries()){
 const shown=[];const r=await chat.run(message,{requestId:String(i),onDelta:x=>shown.push(x)});
 assert.equal(r.text,'Miku。\n嗯……你想聊什么？');assert.equal(r.provider,'deepseek');
 assert.equal(shown.join(''),r.text);assert.equal(seen.at(-1).at(-1).content,message);
 assert.equal(store.chats().filter(x=>x.role==='assistant').at(-1).text,r.text);
 const before=calls;assert.deepEqual(await chat.run(message,{requestId:String(i)}),r);assert.equal(calls,before);
 }assert.equal(calls,10);
 const prompt=seen.at(-1)[0].content;
 assert.ok(prompt.includes('"affection":0.2'));assert.ok(prompt.includes('AI'));
 }finally{store.close();}
});
test('social input needs a connected model, with no canned persona fallback',async()=>{
 const store=new Store(':memory:',10000);try{
 const chat=new Chat(new Service(store,()=>10000),{config:()=>({}),complete:async()=>{throw Error('unexpected');}});
 await assert.rejects(chat.run('你是谁'),/尚未连接/);
 assert.equal(store.chats().length,0);
 }finally{store.close();}
});
test('model appraisal determines contextual meaning, while ungrounded events cannot change state',async()=>{
 const store=new Store(':memory:',10000);try{
 let proposal={actions:[],act:'social',appraisal:{event:'playful',evidence:'你这个傻逼',confidence:1}};
 const service=new Service(store,()=>10000),chat=new Chat(service,{config:()=>({deepseekKey:'test',openaiEnabled:false}),complete:async(_,o)=>({text:(o.json && !['dialogue','initiative-share','initiative-reminder','work-log'].includes(o.purpose))?JSON.stringify(proposal):'听出来你在开玩笑。'})});
 await chat.run('你这个傻逼');assert.equal(store.read().persona.conflicts.length,0);
 assert.equal(store.read().persona.affect.recent.at(-1).event,'playful');
 proposal={actions:[],act:'correction',styleLearning:{evidence:'不要装萌',rule:'自然地表达'},appraisal:{event:'conflict',evidence:'不存在的辱骂',confidence:1}};
 await chat.run('不要装萌');assert.equal(store.read().persona.conflicts.length,0);
 assert.equal(store.read().persona.inner.styleRules.at(-1).source,'不要装萌');
 }finally{store.close();}
});
test('an incomplete routing response retries once before mutation and still preserves task clarification',async()=>{
  const store=new Store(':memory:',10000);try{
    let calls=0;const service=new Service(store,()=>10000);
    const chat=new Chat(service,{config:()=>({deepseekKey:'test',openaiEnabled:false}),complete:async()=>{
      calls++;assert.equal(store.read().tasks.length,0);
      if(calls===1)throw Error('模型在本轮预算内没有生成完整回答，请缩短问题后再试。');
      return {text:JSON.stringify({actions:[],clarification:'这份作业什么时候截止？'})};
    }});
    const r=await chat.run('帮我记一个作业');assert.equal(calls,2);assert.equal(r.text,'这份作业什么时候截止？');
    assert.equal(store.read().tasks.length,0);
  }finally{store.close();}
});
