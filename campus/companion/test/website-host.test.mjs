import test from 'node:test';
import assert from 'node:assert/strict';
import {createWebsiteHost} from '../website-host.mjs';

async function fixture({routing={},paid=false,rpcOverride}={}){
  const {createApp}=await import('../src/server.mjs');const calls=[],tools=[];
  const models={config:()=>({deepseekKey:'test',deepseekModel:'deepseek-flash',mcpServers:[],embeddingEngine:'off',agentEnabled:true,toolReflection:false}),
    usage:()=>({limit:200,spent:0,rows:[]}),
    complete:async(messages,options)=>{calls.push({messages,options});return {text:JSON.stringify(options.purpose==='routing'?{actions:[],advisor:'none',...routing}:{messages:[{type:'text',text:'我记得呀，继续说。'}]}),usage:{prompt_tokens:10,completion_tokens:10}};},
    chat:async(messages,options)=>{calls.push({messages,options});return {message:{role:'assistant',content:'',tool_calls:[{id:'finish1',type:'function',function:{name:'finish',arguments:JSON.stringify({answer:'找到了',findings:[],confidence:'low',gaps:[]})}}]},usage:{}};}};
  const app=await createApp({dbPath:':memory:',models,background:false});
  app.embedder.config=()=>({embeddingEngine:'off'});
  const state=app.service.state();state.memories.push({id:'old-memory',content:'用户喜欢雨后散步',category:'profile',source:'我喜欢雨后散步',confirmed:true});
  state.persona.relationship.trust=.7;state.persona.stable.address='小洛';app.store.save(state);
  app.store.addChat('user','我们昨天聊了雨后散步',app.service.clock()-60);
  const host=await createWebsiteHost({app,token:'test-secret',owner:7,background:false,paid,
    rpc:rpcOverride||(async(body)=>{tools.push(body);return {status:'done',result:{total:2,items:[]}};})});
  return {host,calls,tools};
}
const id=n=>String(n).padStart(64,'0');

test('explicit content chat executes immediately and writes the reply to the original memory',async()=>{
  const events=[];
  const f=await fixture({rpcOverride:async body=>{events.push(body);return body.op==='content-progress'?{id:body.id,state:body.state}:
    {enabled:true,today:{},jobs:[],day:'2026-10-09',maintenance:{enabled:true}};}});
  try{
    f.host.app.agent.run=async options=>{assert.equal(options.purpose,'website-maintenance');return {answer:'已核对并发布',gaps:[],stats:{toolCalls:3},
      trace:[{ok:true,receipt:{actionId:'real-receipt',completed:true,state:'published'}}]};};
    await f.host.enqueue({id:id(301),owner:7,kind:'chat',text:'请审核校圈测试',contentTask:'content-task-1',material:{}});
    await f.host.jobs.get(id(301)).promise;
    const job=f.host.jobs.get(id(301));assert.equal(job.state,'done');assert.equal(job.result.contentTask.state,'completed');
    assert.deepEqual(events.filter(e=>e.op==='content-progress').map(e=>e.state),['running','running','running','completed']);
    assert.ok(JSON.stringify(f.host.app.store.chats()).includes('请审核校圈测试'));
    assert.deepEqual(events.find(e=>e.state==='completed').result.actionIds,['real-receipt']);
  }finally{await f.host.close();}
});

test('chat without an operation receipt cannot be marked complete',async()=>{
  const events=[];
  const f=await fixture({rpcOverride:async body=>{events.push(body);return body.op==='content-progress'?{id:body.id,state:body.state}:
    {enabled:true,today:{},jobs:[],day:'2026-10-09',maintenance:{enabled:true}};}});
  try{
    f.host.app.agent.run=async()=>({answer:'我已经发布了',gaps:['没有执行工具'],trace:[],stats:{toolCalls:0}});
    await f.host.enqueue({id:id(302),owner:7,kind:'chat',text:'请发布校圈测试',contentTask:'content-task-2',material:{}});
    await f.host.jobs.get(id(302)).promise;
    assert.equal(f.host.jobs.get(id(302)).result.contentTask.state,'failed');
    assert.ok(!events.some(e=>e.op==='content-progress'&&e.state==='completed'));
  }finally{await f.host.close();}
});

test('a completed write cannot hide a different failed operation in the same chat task',async()=>{
  const events=[],f=await fixture({rpcOverride:async body=>{events.push(body);return body.op==='content-progress'?{id:body.id,state:body.state}:
    {enabled:true,today:{},jobs:[],day:'2026-10-10',maintenance:{enabled:true}};}});
  try{
    f.host.app.agent.run=async()=>({answer:'其中一项已完成',gaps:[],stats:{toolCalls:2},trace:[
      {ok:true,operation:'content_publish',target:'page/site',receipt:{operation:'content_publish',key:'page/site',actionId:'real-receipt',completed:true,publication:{verified:true}}},
      {ok:false,operation:'content_review',target:'entry/other',error:'权限拒绝'}]});
    await f.host.enqueue({id:id(303),owner:7,kind:'chat',text:'请修改页面并审核帖子',contentTask:'content-task-3'});
    await f.host.jobs.get(id(303)).promise;
    assert.equal(f.host.jobs.get(id(303)).result.contentTask.state,'failed');
    assert.ok(!events.some(e=>e.op==='content-progress'&&e.state==='completed'));
  }finally{await f.host.close();}
});

test('studio cannot mark a failed tool complete when the final answer omits gaps',async()=>{
  const f=await fixture({rpcOverride:async()=>({enabled:true,today:{},jobs:[],day:'2026-10-10',maintenance:{enabled:true}})});
  try{
    f.host.app.agent.run=async()=>({answer:'检查结束',gaps:[],stats:{toolCalls:1},
      trace:[{ok:false,operation:'content_review',target:'entry/test',error:'权限拒绝'}]});
    await f.host.enqueue({id:id(308),owner:7,kind:'studio',text:'',material:{goal:'审核测试帖子',maintenance:{enabled:true}}});
    await f.host.jobs.get(id(308)).promise;
    const job=f.host.jobs.get(id(308));assert.equal(job.state,'done',job.error);
    assert.equal(job.result.verification.complete,false);
    assert.deepEqual(job.result.verification.failures,[{operation:'content_review',target:'entry/test',error:'权限拒绝'}]);
    const writer=f.calls.find(c=>c.options.purpose==='studio-collaboration');assert.ok(writer);
    assert.match(JSON.stringify(writer.messages),/权限拒绝/);
  }finally{await f.host.close();}
});

test('a nonoverlapping version conflict retries once without leaving an ambiguous receipt',async()=>{
  let writes=0;const f=await fixture({rpcOverride:async body=>{
    if(body.op==='maintenance'&&body.operation==='content_publish'){
      writes++;if(writes===1){const error=Error('内容版本已变化，请重新读取。');error.status=409;throw error;}
      return {completed:true,key:'page/site',revision:3,publication:{verified:true}};
    }
    if(body.operation==='content_read')return {key:'page/site',revision:2,data:{body:'原正文'}};
    return {};
  }});
  try{
    const jobId=id(304);f.host.journal.put(jobId,{state:'running'});
    const result=await f.host.app.agent.withWebsiteJob(jobId,()=>f.host.app.registry.execute('content_publish',{
      key:'page/site',revision:1,patch:{body:'新正文'},before:{body:'原正文'},reason:'修订'},{maxRisk:'publish'}));
    assert.equal(result.retried,true);assert.equal(writes,2);
    assert.deepEqual(f.host.journal.actions(jobId).map(r=>r.state).sort(),['done','failed']);
  }finally{await f.host.close();}
});

test('ambiguous timeout queries the same action without repeating a publication',async()=>{
  let writes=0,queries=0;const f=await fixture({rpcOverride:async body=>{
    if(body.operation==='content_publish'){writes++;throw Error('连接中断，结果未确认');}
    if(body.operation==='action_status'){queries++;return {state:'running'};}
    return {};
  }});
  try{
    const jobId=id(305);f.host.journal.put(jobId,{state:'running'});
    const args={key:'page/site',revision:1,patch:{body:'新正文'},reason:'修订'};
    const call=()=>f.host.app.agent.withWebsiteJob(jobId,()=>f.host.app.registry.execute('content_publish',args,{maxRisk:'publish'}));
    await assert.rejects(call(),/结果未确认/);await assert.rejects(call(),/结果尚未确认/);
    assert.equal(writes,1);assert.equal(queries,1);
  }finally{await f.host.close();}
});

test('a duplicate transport identifier cannot be reused for a different chat instruction',async()=>{
  const f=await fixture();try{
    const body={id:id(306),owner:7,kind:'chat',text:'原指令'};
    await f.host.enqueue(body);await f.host.jobs.get(body.id).promise;
    await assert.rejects(f.host.enqueue({...body,text:'不同指令'}),/不同指令/);
  }finally{await f.host.close();}
});

test('the original agent can execute the registered review tool and return a verified receipt to the private chat',async()=>{
  const events=[],target='entry/00000000-0000-4000-a000-000000000001';
  const f=await fixture({rpcOverride:async body=>{
    events.push(body);
    if(body.op==='maintenance'&&body.operation==='content_review')return {key:target,completed:true,state:'published',revision:1,publication:{verified:true}};
    if(body.op==='content-progress')return {id:body.id,state:body.state,progress:body.progress};
    return {enabled:true,today:{},jobs:[],day:'2026-10-10',maintenance:{enabled:true}};
  }});
  try{
    let turns=0;f.host.app.models.chat=async()=>({message:{role:'assistant',content:'',tool_calls:[{
      id:'tool-'+turns,type:'function',function:turns++===0?
        {name:'content_review',arguments:JSON.stringify({key:target,revision:1,decision:'approve',reason:'已核对正文和来源'})}:
        {name:'finish',arguments:JSON.stringify({answer:'已通过审核',findings:[],confidence:'high',gaps:[]})}
    }]},usage:{}});
    await f.host.enqueue({id:id(307),owner:7,kind:'chat',text:'请审核 '+target,contentTask:'content-task-7'});
    await f.host.jobs.get(id(307)).promise;
    const job=f.host.jobs.get(id(307));assert.equal(job.state,'done',job.error);
    assert.equal(job.result.contentTask.state,'completed');
    const write=events.find(e=>e.operation==='content_review');assert.ok(write);
    assert.equal(write.contentTask,'content-task-7');
    assert.equal(f.host.journal.actions(id(307))[0].state,'done');
    assert.equal(job.result.maintenance.trace[0].receipt.publication.verified,true);
    assert.ok(JSON.stringify(f.host.app.store.chats()).includes('请审核 '+target));
  }finally{await f.host.close();}
});

test('authorized studio uses original tool executor before the same persona writes its reply',async()=>{
  const f=await fixture({rpcOverride:async()=>({enabled:true,today:{queued:1},jobs:[],day:'2026-10-09',maintenance:{enabled:true}})});
  try{
    const executed=[];f.host.app.agent.run=async task=>{executed.push(task);return {answer:'已排队，尚未完成',stats:{toolCalls:1},trace:[{tool:'campus_maintenance',ok:true}],gaps:['等待运行结果']};};
    await f.host.enqueue({id:id(101),owner:7,kind:'studio',text:'',material:{goal:'检查图片',maintenance:{enabled:true},history:[
      {seat:'codex',body:'old-task-only'+'.'.repeat(1000)},
      {seat:'beikuang',body:'当前任务',execution:{trace:[{receipt:{id:'new-task-only',state:'queued'}}]}}
    ]}});
    await f.host.jobs.get(id(101)).promise;
    const job=f.host.jobs.get(id(101));assert.equal(job.state,'done');assert.equal(executed.length,1);
    assert.equal(job.result.maintenance.stats.toolCalls,1);
    assert.ok(executed[0].task.includes('new-task-only'));assert.ok(!executed[0].task.includes('old-task-only'));
    assert.ok(f.calls.some(c=>JSON.stringify(c.messages).includes('等待运行结果')));
    assert.ok(f.calls.some(c=>c.messages[0].content.includes('你自己的工具执行器已经运行')));
  }finally{await f.host.close();}
});

test('maintenance status reads never invent a new action identity',async()=>{
  const f=await fixture({rpcOverride:async body=>body.op==='maintenance'?{state:'done',actionId:body.arguments.id}:{}});
  try{
    const result=await f.host.app.registry.execute('campus_maintenance_read',{operation:'action_status',arguments:{id:'original-action'}});
    assert.equal(result.actionId,'original-action');
  }finally{await f.host.close();}
});

test('failed maintenance reads do not invent an undefined operation receipt',async()=>{
  const f=await fixture({rpcOverride:async()=>{throw Error('任务不存在');}});
  try{
    await assert.rejects(f.host.app.registry.execute('campus_maintenance_read',{operation:'job_status',arguments:{id:'missing'}}),e=>e.message.includes('任务不存在')&&!e.message.includes('undefined')&&!e.message.includes('action_status'));
  }finally{await f.host.close();}
});

test('studio material cannot grant tools when current website policy is paused',async()=>{
  const f=await fixture({rpcOverride:async()=>({enabled:true,today:{},jobs:[],day:'2026-10-09',maintenance:{enabled:false}})});
  try{
    f.host.app.agent.run=async()=>{throw Error('must not execute');};
    await f.host.enqueue({id:id(102),owner:7,kind:'studio',text:'',material:{goal:'检查图片',maintenance:{enabled:true}}});
    await f.host.jobs.get(id(102)).promise;
    assert.equal(f.host.jobs.get(id(102)).state,'done');assert.equal(f.host.jobs.get(id(102)).result.maintenance,null);
  }finally{await f.host.close();}
});

test('website turn runs original Chat with old memories, relationship, self state and original writer',async()=>{
  const f=await fixture({routing:{appraisal:{event:'praise',evidence:'你真好',confidence:.9}}});
  try{await f.host.enqueue({id:id(1),owner:7,kind:'chat',text:'你真好，还记得昨天吗？',material:{today:{published:3}}});await f.host.jobs.get(id(1)).promise;
    const result=f.host.jobs.get(id(1));assert.equal(result.state,'done');assert.equal(result.result.engine,'campus-companion');
    assert.equal(result.result.text,'我记得呀，继续说。');assert.ok(f.host.app.service.state().persona.emotions.blush>0);
    const writer=f.calls.find(x=>x.options.purpose==='dialogue');assert.ok(writer);
    assert.match(writer.messages[0].content,/用户喜欢雨后散步/);assert.match(writer.messages[0].content,/小洛/);
    assert.match(writer.messages[0].content,/"self":/);assert.match(writer.messages[0].content,/"trust":0.7/);
    assert.match(writer.messages[0].content,/"website":\{"today":\{"published":3\}/);
    assert.equal(f.host.app.chat.context().website,undefined,'website data must not leak into a later unrelated conversation');
    assert.match(writer.messages[1].content,/我们昨天聊了雨后散步/);
    const count=f.calls.length;await f.host.enqueue({id:id(1),owner:7,kind:'chat',text:'你真好，还记得昨天吗？'});assert.equal(f.calls.length,count);
  }finally{await f.host.close();}
});

test('original registry retains web research and can execute website library tools',async()=>{
  const f=await fixture();try{const names=f.host.app.registry.names();
    for(const name of ['read_page','scholar_search','read_paper','campus_library_search','campus_library_read'])assert.ok(names.has(name),name);
    const result=await f.host.app.registry.execute('campus_library_search',{query:'六级'});
    assert.equal(result.result.total,2);assert.equal(f.tools[0].name,'library_search');
    assert.ok(f.host.app.agency);assert.ok(f.host.app.selfStudy);assert.ok(f.host.app.memoryWriter);assert.ok(f.host.app.semantic||f.host.app.chat.semantic);
  }finally{await f.host.close();}
});

test('fresh studio continuity reaches the original private writer without replacing identity',async()=>{
 const f=await fixture({rpcOverride:async body=>body.op==='continuity'?{available:true,conversations:[{ownerSaid:'资料按大学分类',messages:[{speaker:'codex',body:'只是候选，尚未上架'}]}]}:{}});
 try{
  await f.host.enqueue({id:id(71),owner:7,kind:'chat',text:'接着刚才工作室的事情说'});
  await f.host.jobs.get(id(71)).promise;
  const p=f.calls.find(x=>x.options.purpose==='dialogue').messages[0].content;
  assert.match(p,/资料按大学分类/);assert.match(p,/尚未上架/);assert.match(p,/speaker.*codex/);
  assert.match(p,/七海千秋只是/);assert.match(p,/你不是七海本人/);assert.match(p,/同一个你/);
  assert.equal(f.host.app.service.state().persona.stable.name,'小煤渣');
  assert.equal(f.host.app.service.state().persona.relationship.trust,.7);
 }finally{await f.host.close();}
});

test('no identity fallback on original engine error and cancellation suppresses its delivery',async()=>{
  const f=await fixture();try{f.host.app.chat.run=async()=>{throw new Error('original-down');};
    await f.host.enqueue({id:id(2),owner:7,kind:'chat',text:'你好'});await f.host.jobs.get(id(2)).promise;
    assert.equal(f.host.jobs.get(id(2)).state,'failed');assert.match(f.host.jobs.get(id(2)).error,/original-down/);
    let release;f.host.app.chat.run=()=>new Promise(r=>{release=r;});
    await f.host.enqueue({id:id(3),owner:7,kind:'chat',text:'旧消息'});f.host.jobs.get(id(3)).cancelled=true;release({text:'不能发出去'});
    await f.host.jobs.get(id(3)).promise;assert.equal(f.host.jobs.get(id(3)).result.superseded,true);
    assert.equal(f.host.jobs.get(id(3)).result.text,'');
  }finally{await f.host.close();}
});

test('all original model calls stop before payment when unified website budget refuses',async()=>{
  const f=await fixture({paid:true,rpcOverride:async()=>{throw new Error('每日 5 元总预算');}});
  try{await assert.rejects(f.host.app.models.complete([{role:'user',content:'hello'}]),/5 元/);assert.equal(f.calls.length,0);}
  finally{await f.host.close();}
});

test('bridge HTTP requires its private credential and the bound owner',async()=>{
  const f=await fixture();try{await new Promise(r=>f.host.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+f.host.server.address().port;
    assert.equal((await fetch(base+'/status')).status,403);
    const r=await fetch(base+'/jobs',{method:'POST',headers:{Authorization:'Bearer test-secret','Content-Type':'application/json'},body:JSON.stringify({id:id(4),owner:8,kind:'chat',text:'不能读别人的记忆'})});
    assert.equal(r.status,400);assert.equal(f.calls.length,0);
    const ok=await fetch(base+'/status',{headers:{Authorization:'Bearer test-secret'}});assert.equal(ok.status,200);
    assert.equal((await ok.json()).engine,'campus-companion');
  }finally{await f.host.close();}
});

test('busy conversation and a failed background engine cannot block reminders or enabled site maintenance',async()=>{
  const f=await fixture();try{
    const ran=[];f.host.app.chat.active=1;
    f.host.app.social.tick=async()=>{ran.push('social');throw new Error('source offline');};
    f.host.app.siteKeeper.due=()=>true;f.host.app.siteKeeper.tick=async()=>{ran.push('site');};
    f.host.app.scheduler.tick=async()=>{ran.push('reminders');};
    f.host.app.agency.tick=async()=>{throw new Error('must not start while chatting');};
    await f.host.tick();assert.deepEqual(ran,['social','site','reminders']);
    assert.match(f.host.status().backgroundError,/source offline/);
    f.host.app.siteKeeper.due=()=>false;ran.length=0;await f.host.tick();assert.deepEqual(ran,['social','reminders']);
  }finally{f.host.app.chat.active=0;await f.host.close();}
});

test('structured generation failure remains an error even after a tool already completed',async()=>{
  const f=await fixture();try{
    f.host.app.chat.run=async()=>({text:'已执行结果：已保存\n\n暂时无法生成对话：格式错误',error:{code:'invalid_message_chain',message:'格式错误'}});
    await f.host.enqueue({id:id(5),owner:7,kind:'chat',text:'记住这件事'});await f.host.jobs.get(id(5)).promise;
    assert.equal(f.host.jobs.get(id(5)).state,'failed');assert.equal(f.host.jobs.get(id(5)).error,'格式错误');
  }finally{await f.host.close();}
});

test('existing studio seat shares the original persona and never records colleague text as owner chat',async()=>{
  const f=await fixture();try{
    const before=f.host.app.service.state().chat.length;
    await f.host.enqueue({id:id(6),owner:7,kind:'studio',text:'',material:{
      goal:'核对分类',history:[{seat:'codex',body:'这是嵌入式项目。'}],checks:[],
      collaboration:{relationship:'北矿娘和 Codex 是闺蜜。'}}});
    await f.host.jobs.get(id(6)).promise;
    assert.equal(f.host.jobs.get(id(6)).state,'done');
    const writer=f.calls.find(c=>c.options.purpose==='studio-collaboration');assert.ok(writer);
    assert.match(writer.messages[0].content,/用户喜欢雨后散步/);
    assert.match(writer.messages[0].content,/既有 AI 工作室/);
    assert.match(writer.messages[1].content,/这是嵌入式项目/);
    assert.equal(f.host.app.service.state().chat.length,before);
    const count=f.calls.length;await f.host.enqueue({id:id(6),owner:7,kind:'studio',text:''});
    assert.equal(f.calls.length,count,'same studio turn never repeats the paid request');
  }finally{await f.host.close();}
});

test('repeatedly due background engines do not starve original autonomous decisions',async()=>{
  const f=await fixture();try{
    const turns=[];
    f.host.app.cortex.due=f.host.app.inquiry.due=f.host.app.webLife.dailyDue=f.host.app.memoryWriter.due=f.host.app.agency.due=()=>true;
    f.host.app.cortex.run=async()=>turns.push('cortex');f.host.app.inquiry.run=async()=>turns.push('inquiry');
    f.host.app.webLife.daily=async()=>turns.push('reading');f.host.app.memoryWriter.run=async()=>turns.push('memory');
    f.host.app.agency.tick=async()=>turns.push('agency');
    for(let i=0;i<6;i++)await f.host.tick();
    assert.deepEqual(turns,['cortex','inquiry','reading','memory','agency','cortex']);
    f.host.app.chat.active=1;await f.host.tick();assert.equal(turns.length,6);
  }finally{f.host.app.chat.active=0;await f.host.close();}
});
