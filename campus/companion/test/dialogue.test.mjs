import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.mjs';
import {Service} from '../src/service.mjs';
import {Chat} from '../src/chat.mjs';
import {dialogueFrame,dialogueContext,voiceIssues} from '../src/dialogue.mjs';

const config=()=>({deepseekKey:'test-only',openaiEnabled:false});
function fixture(){const store=new Store(':memory:',10000);return {store,service:new Service(store,()=>10000)};}
test('context preserves real history and forgetting clears it without replaying a scripted scene',async()=>{
 const f=fixture();try{
 f.store.addChat('user','你好',9999);f.store.addChat('assistant','你好，你叫什么名字？',9999);
 const frame=dialogueFrame(f.service.state(),'你好。','social');
 assert.equal(frame.alreadyMet,true);assert.equal(frame.questionBudget,undefined);
 assert.ok(dialogueContext(f.service.state(),frame).emotions);
 const models={config,complete:async(_,o)=>({text:(o.json && !['dialogue','initiative-share','initiative-reminder','work-log'].includes(o.purpose))?'{"actions":[],"act":"social"}':'嗨呀。'})};
 await new Chat(f.service,models).run('你好。');assert.equal(f.store.read().persona.stage,'new');
 f.service.command('memory.add',{content:'临时偏好'});
 f.service.command('memory.remove',{id:f.store.read().memories[0].id});
 assert.equal(dialogueFrame(f.service.state(),'你好','social').alreadyMet,false);
 }finally{f.store.close();}
});
test('offline style observations remain advisory and are not reply transformations',()=>{
 assert.ok(voiceIssues('你想聊什么？',{questionBudget:0}).length);
});
test('required task clarification bypasses cosmetic rewriting',async()=>{const f=fixture();try{let calls=0;const models={config,complete:async()=>{calls++;return {text:'{"actions":[],"clarification":"作业什么时候截止，还剩多久？"}'};}};const r=await new Chat(f.service,models).run('帮我安排作业');assert.equal(calls,1);assert.match(r.text,/什么时候截止/);}finally{f.store.close();}});
test('repair rejects re-introduction and renewed promises to change tone',()=>{const frame={phase:'repair',alreadyMet:true,questionBudget:0};assert.ok(voiceIssues('嗨，我是 Miku。',frame).length);assert.ok(voiceIssues('刚才那两句确实太像客服了。知道了，我放松点说。',frame).length);assert.deepEqual(voiceIssues('是我话太多了。',frame),[]);});
