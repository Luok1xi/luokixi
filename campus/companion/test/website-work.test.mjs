import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.mjs';
import {Service} from '../src/service.mjs';
import {Chat} from '../src/chat.mjs';
import {Agency} from '../src/agency.mjs';
import {WebsiteWork} from '../website-work.mjs';
import {dateMinute} from '../src/time.mjs';

function fixture(choice){
  let now=dateMinute('2026-10-08','14:00');const store=new Store(':memory:',now),service=new Service(store,()=>now),calls=[],rpcCalls=[];
  let observation={enabled:true,day:'2026-10-08',today:{queued:305,published:0,ownerDecided:4,botFailures:0},jobs:[]};
  const models={config:()=>({deepseekKey:'test'}),usage:()=>({spent:0,limit:200}),complete:async(messages,options)=>{
    calls.push({messages,options});return {text:JSON.stringify(options.purpose==='initiative-decision'?choice:{messages:[{type:'text',text:'审核刚处理完一批，还有两份需要补证据。'}]})};
  }};
  const chat=new Chat(service,models),agency=new Agency(service,chat,models,{running:false});
  const work=new WebsiteWork(service,async body=>{rpcCalls.push(body);return body.op==='work-state'?observation:{key:'job-1',state:'queued'};});agency.work=work;
  store.addChat('user','帮我照看网站，不必按点念日报。',now-100);
  return {store,service,agency,work,calls,rpcCalls,advance:n=>now+=n,setObservation:o=>observation=o};
}

test('wake only perceives work; model may choose rest with no tool call or notification',async()=>{
  const f=fixture({action:'rest',reason:'这会儿先休息，半小时后再看积压。',revisitMinutes:30});try{
    await f.work.refresh();assert.equal(f.rpcCalls.length,1);assert.equal(f.calls.length,0);
    await f.agency.tick();assert.equal(f.rpcCalls.filter(x=>x.op==='work-action').length,0);
    assert.equal(f.store.messages().length,0);assert.equal(f.service.state().websiteWork.decisions[0].action,'rest');
    assert.equal(f.work.due(),false);
  }finally{f.store.close();}
});

test('original agency chooses a concrete goal and follows authoritative completion across restart',async()=>{
  const f=fixture({action:'site_work',workAction:'review',goal:'先处理积压的学校资料审核',reason:'现在有 305 条待办，先让审核器推进一批。',revisitMinutes:15});try{
    await f.work.refresh();await f.agency.tick();
    const request=f.rpcCalls.find(x=>x.op==='work-action');assert.ok(request);assert.equal(request.goal,'先处理积压的学校资料审核');
    assert.equal(f.store.messages().length,0,'starting work does not force a report');
    assert.equal(f.service.state().websiteWork.intentions[0].status,'queued');
    f.advance(3);f.setObservation({enabled:true,day:'2026-10-08',today:{queued:290,published:15,ownerDecided:4,botFailures:0},jobs:[{key:'job-1',decisionId:request.id,state:'done',result:{published:15}}]});
    await f.work.refresh();const restored=new WebsiteWork(f.service,()=>{});
    assert.equal(restored.snapshot().intentions[0].status,'done');assert.equal(restored.snapshot().intentions[0].result.published,15);
    assert.equal(restored.snapshot().today.ownerDecided,4);
    const prompt=JSON.parse(f.calls[0].messages[1].content);assert.equal(prompt.websiteWork.today.queued,305);
    assert.ok(prompt.candidates.includes('rest'));assert.ok(prompt.candidates.includes('site_work'));
  }finally{f.store.close();}
});

test('work report is an original-persona choice and is not offered twice for unchanged progress',async()=>{
  const f=fixture({action:'share_work',reason:'告诉他刚完成的进展和卡点。'});try{
    f.setObservation({enabled:true,day:'2026-10-08',today:{queued:2,published:15,ownerDecided:4,botFailures:1},jobs:[]});
    await f.work.refresh();await f.agency.tick();
    const reply=f.calls.find(x=>x.options.purpose==='initiative-share');assert.ok(reply);
    assert.match(reply.messages[1].content,/"ownerDecided":4/);
    assert.ok(f.store.messages().some(x=>x.payload.text.includes('两份')));
    assert.equal(f.work.snapshot().reportable,false);
  }finally{f.store.close();}
});

test('stale observation, pause and unknown work actions cannot trigger site changes',async()=>{
  const f=fixture({action:'site_work',workAction:'delete',goal:'删除',reason:'不允许'});try{
    await f.work.refresh();await f.agency.tick();assert.equal(f.rpcCalls.filter(x=>x.op==='work-action').length,0);
    f.advance(6);assert.equal(f.work.snapshot(),null);
    const s=f.service.state();s.agency.enabled=false;f.store.save(s);await f.work.refresh();await f.agency.tick();
    assert.equal(f.rpcCalls.filter(x=>x.op==='work-action').length,0);
  }finally{f.store.close();}
});

test('failed decisions retain a cooldown while authorized work has no daily thinking count cap',async()=>{
  const f=fixture({action:'rest',reason:'稍后再看。'});try{
    f.store.addChat('user','刚刚聊过，暂时不用主动发消息。',f.service.clock());
    let attempts=0;f.agency.models.complete=async()=>{attempts++;throw new Error('模型暂时离线');};
    await f.work.refresh();await f.agency.tick();
    assert.equal(attempts,1);assert.equal(f.work.due(),false);
    f.advance(1);await f.agency.tick();assert.equal(attempts,1,'no paid retry on the next timer wake');
    f.advance(30);await f.work.refresh();assert.equal(f.work.due(),true);
    for(let i=0;i<11;i++)f.work.thinking();
    f.advance(31);await f.work.refresh();
    assert.equal(new WebsiteWork(f.service,()=>{}).due(),true,'fresh observed work remains eligible after the cooldown across restart');
  }finally{f.store.close();}
});


test('Agency can choose a real joint discussion and observes its completion without sending fake chat',async()=>{
 const f=fixture({action:'site_work',workAction:'discuss',goal:'和 Codex 检查图片故障',reason:'浏览器发现了加载失败'});try{
  f.setObservation({enabled:true,day:'2026-10-08',today:{queued:0},jobs:[],team:{actions:['discuss'],discussion:null}});
  await f.work.refresh();await f.agency.tick();assert.equal(f.rpcCalls.find(c=>c.op==='work-action').action,'discuss');
  assert.equal(f.store.messages().length,0);
 }finally{f.store.close();}
});
