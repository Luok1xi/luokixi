import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
// Node test runner isolates each file. Select identity BEFORE importing the original runtime.
process.env.COMPANION_SEAT='codex';
const {createApp}=await import('../src/server.mjs');
const {createWebsiteHost}=await import('../website-host.mjs');
const {CodexModels}=await import('../src/codex-models.mjs');
const {characterCard}=await import('../src/character-card.mjs');
const {parseChain,stickers}=await import('../src/message-chain.mjs');
const {WebsiteWork}=await import('../website-work.mjs');
const {Store}=await import('../src/store.mjs');
const {Service}=await import('../src/service.mjs');
const {Chat}=await import('../src/chat.mjs');

test('one-call ordinary chat still applies emotion and style learning through the original engine',async()=>{
  const store=new Store(':memory:',10000),service=new Service(store,()=>10000),calls=[];
  const reply={messages:[{type:'text',text:'嗯。看到你来，很高兴。',speech:'来てくれて、嬉しい。',expression:'happy'}]};
  const models=new CodexModels(async body=>{calls.push(body);return {model:'fixture',text:JSON.stringify({actions:[],thinking:'fast',advisor:'none',act:'social',
    feeling:{name:'happy',intensity:.6,evidence:'做得很好',confidence:.95},appraisal:{event:'praise',evidence:'做得很好',confidence:.95},
    styleLearning:{rule:'少用客套，直接说重点',evidence:'说话直接一点'},reply})};},()=>({}));
  try{
    const result=await new Chat(service,models).run('做得很好，说话直接一点');
    assert.equal(calls.length,1);assert.equal(result.messages[0].speech,reply.messages[0].speech);
    assert.equal(service.state().persona.characterFeeling.name,'happy');
    assert.equal(service.state().persona.inner.styleRules.at(-1).source,'说话直接一点');
    assert.match(calls[0].messages[0].content,/清冷、克制/);
    assert.equal(service.state().chat.at(-1).text,reply.messages[0].text);
  }finally{store.close();}
});

test('actions, deep analysis and malformed drafts retain the original writer path',async()=>{
  for(const variant of ['action','filtered-action','deep','invalid']){
    const store=new Store(':memory:',10000),service=new Service(store,()=>10000),calls=[];
    const models=new CodexModels(async body=>{calls.push(body);return {model:'fixture',text:JSON.stringify(body.purpose==='routing'?{
      actions:['action','filtered-action'].includes(variant)?[{action:'memory.add',args:{content:'喜欢紫色',category:'profile',confirmed:true,source:'我喜欢紫色'}}]:[],thinking:'fast',advisor:'none',
      reply:variant==='invalid'?{}:{messages:[{type:'text',text:'未经实际执行的预写台词'}]}
    }:{messages:[{type:'text',text:'实际状态确认后的回复',expression:'composed'}]})};},()=>({}));
    try{
      const result=await new Chat(service,models).run(variant==='action'?'记住我喜欢紫色':'你好',{deep:variant==='deep'});
      assert.equal(calls.length,2,variant);assert.equal(result.text,'实际状态确认后的回复',variant);
      if(variant==='action')assert.equal(service.state().memories.at(-1).content,'喜欢紫色');
      if(variant==='filtered-action')assert.equal(service.state().memories.length,0,'unsupported memory is not written or claimed in a draft');
    }finally{store.close();}
  }
});

test('Codex preserves the original fast/deep choice instead of dropping it at the provider boundary',async()=>{
  const calls=[],models=new CodexModels(async b=>{calls.push(b);return {text:'{}',model:'same-model'};},()=>({}));
  await models.complete([{role:'user',content:'hello'}],{purpose:'routing',thinking:'fast'});
  await models.complete([{role:'user',content:'analyse'}],{purpose:'dialogue',thinking:'fast',deep:true});
  assert.equal(calls[0].thinking,'fast');assert.equal(calls[1].thinking,'deep');
  assert.equal(calls[1].messages[0].content,'analyse');
});

test('conversation work context keeps statuses and lookup IDs without duplicating heavy receipts',()=>{
  const state={websiteWork:{observation:{enabled:true,at:10,today:{queued:2,published:3},jobs:[{id:'job-1',state:'running',result:{state:'running',trace:['large receipt']}}],
    collaboration:{messages:['long discussion']},team:{budget:{codexRemaining:3},actions:['discuss'],discussion:{run:'run-1',state:'running',messages:['long history']}},
    maintenance:{enabled:true}},intentions:[{id:'intent-1',goal:'repair search',status:'running',jobKey:'job-1',result:{trace:['large receipt']}}],decisions:[]}};
  const before=JSON.stringify(state),work=new WebsiteWork({clock:()=>10,store:{read:()=>state}},()=>{});
  const compact=work.snapshot({conversation:true});
  assert.equal(compact.today.published,3);assert.equal(compact.jobs[0].id,'job-1');assert.equal(compact.jobs[0].state,'running');
  assert.equal(compact.intentions[0].goal,'repair search');assert.equal(compact.team.discussion.run,'run-1');
  assert.ok(!JSON.stringify(compact).includes('large receipt'));assert.ok(!JSON.stringify(compact).includes('long discussion'));
  assert.deepEqual(work.snapshot().collaboration,{messages:['long discussion']});
  assert.equal(JSON.stringify(state),before,'durable records are never trimmed');
});
test('Codex runs original emotion, memory, learning, tools and writer with own card and durable state',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'codex-original-')),seen=[];
  const rpc=async b=>{seen.push(b);if(b.op==='continuity')return {available:true,conversations:[{ownerSaid:'昨天在工作室约定先修搜索'}]};
    if(b.op==='tool')return {total:1,items:[{id:'known'}]};
    if(b.op==='voice')return {audio:Buffer.from('RIFF-test').toString('base64'),type:'audio/wav',cached:true};
    if(b.op==='codex-model')return {model:'codex-fixture',text:JSON.stringify(b.purpose==='routing'?{
      actions:[],advisor:'none',act:'sharing',feeling:{name:'happy',intensity:.7,evidence:'做得很好',confidence:.95},appraisal:{event:'praise',evidence:'做得很好',confidence:.95},
      styleLearning:{rule:'少用客套，直接说重点',evidence:'说话直接一点'}}:{messages:[{type:'text',text:'我记着。先修搜索。',speech:'覚えてる。まず検索を直そう。',expression:'think'}]})};return {};};
  const models=new CodexModels(rpc,()=>({monthlyLimit:200,mcpServers:[],embeddingEngine:'off',agentEnabled:true}));
  let host;
  try{
    const app=await createApp({dbPath:join(dir,'codex.sqlite'),models,background:false});
    app.embedder.config=()=>({embeddingEngine:'off'});
    assert.equal(characterCard.name,'Codex');assert.deepEqual(app.service.state().memories,[]);
    host=await createWebsiteHost({app,rpc,token:'fixture',owner:7,background:false});
    const audio=await app.speech.synthesize('覚えてる。');assert.equal(audio.audio.toString(),'RIFF-test');assert.equal(seen.find(b=>b.op==='voice').language,'ja');
    for(const key of ['chat','agency','learning','research','cortex','inquiry','memoryWriter','webLife','selfStudy','tools','registry','scheduler','projects','vision'])assert.ok(app[key],key);
    const id='a'.repeat(64);await host.enqueue({id,owner:7,kind:'chat',text:'做得很好，说话直接一点',material:{history:['duplicate studio transcript marker'],collaboration:{large:'duplicate maintenance marker'}}});await host.jobs.get(id).promise;
    const result=host.jobs.get(id);assert.equal(result.state,'done',result.error);
    assert.equal(result.result.messages[0].speech,'覚えてる。まず検索を直そう。');
    const s=app.service.state();assert.equal(s.persona.stable.name,'Codex');assert.equal(s.persona.characterFeeling.name,'happy');assert.ok(s.persona.emotions.blush>0);
    assert.equal(s.persona.inner.styleRules.at(-1).source,'说话直接一点');assert.equal(s.memories.length,0);
    const writer=seen.find(b=>b.purpose==='dialogue');assert.match(JSON.stringify(writer.messages),/昨天在工作室约定先修搜索/);assert.match(writer.messages[0].content,/清冷、克制/);
    assert.doesNotMatch(JSON.stringify(writer.messages),/duplicate studio transcript marker|duplicate maintenance marker/);
    assert.ok(!stickers.some(s=>s.id.startsWith('moyu_')));
    await host.close();host=null;
    const reopened=await createApp({dbPath:join(dir,'codex.sqlite'),models,background:false});
    assert.equal(reopened.service.state().persona.characterFeeling.name,'happy');assert.equal(reopened.service.state().chat.at(-1).text,'我记着。先修搜索。');
    await reopened.close();
  }finally{if(host)await host.close();rmSync(dir,{recursive:true,force:true});}
});
test('Japanese speech stays attached to its message and legacy messages remain readable',()=>{
  assert.equal(parseChain(JSON.stringify({messages:[{type:'text',text:'你好',speech:'こんにちは。'}]})).messages[0].speech,'こんにちは。');
  assert.equal(parseChain('{"messages":[{"type":"text","text":"旧消息"}]}').text,'旧消息');
});
