import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.mjs';
import {Service} from '../src/service.mjs';
import {Chat} from '../src/chat.mjs';
import {Agency} from '../src/agency.mjs';
import {SelfStudy} from '../src/self-study.mjs';
import {ToolAgent} from '../src/agent.mjs';
import {CapabilityMemory} from '../src/capability-memory.mjs';
import {selfState,distress,feelFromReading} from '../src/self-state.mjs';
import {dateMinute} from '../src/time.mjs';
import {ensureWebLife} from '../src/web-life-state.mjs';
import {recordCharacterFeeling} from '../src/character-card.mjs';

const now=dateMinute('2026-09-19','10:00');
function fixture(){const store=new Store(':memory:',now);return {store,service:new Service(store,()=>now)};}
const edit=(store,fn)=>{const s=store.read();fn(s);store.save(s);};
const hurt=s=>{s.persona.conflicts=[{id:'c1',source:'滚',at:now-5,resolved:false}];s.persona.emotions.annoyed=.3;};

test('validated current feelings reach real activity pacing and decisions without inventing a relationship change',async()=>{
 const f=agencyFixture({action:'rest',reason:'今天心情不错，先留一会儿空闲'});try{
  edit(f.store,s=>{s.agency.lastAt=now-60;});
  assert.equal(f.agency.due(),false);
  const relationship=JSON.stringify(f.service.state().persona.relationship);
  edit(f.store,s=>recordCharacterFeeling(s.persona,{name:'happy',intensity:.8,evidence:'真棒',confidence:.9},'你真棒',now,'feeling-1'));
  assert.equal(f.agency.due(),true,'bright mood uses the original shorter initiative interval');
  await f.agency.run();assert.equal(f.seen[0].self.mood,'bright');
  assert.equal(f.seen[0].self.feeling.name,'happy');assert.equal(f.service.state().agency.runs.at(-1).status,'rest');
  assert.equal(f.store.messages().length,0,'mood never forces a message');
  assert.equal(JSON.stringify(f.service.state().persona.relationship),relationship);
  edit(f.store,s=>recordCharacterFeeling(s.persona,{name:'curious',intensity:.8,evidence:'机器人',confidence:.9},'机器人',now,'feeling-2'));
  const state=f.service.state();assert.ok(selfState(state,now).needs.knowledge>state.agency.needs.curiosity);
  assert.equal(selfState(state,now+1440).feeling.name,'neutral','old feelings decay');
 }finally{f.store.close();}
});

test('mood and cravings come from recorded state, and only sadness not caused by the user can be confided',()=>{
 const {store,service}=fixture();try{
  assert.equal(selfState(service.state(),now).mood,'calm');
  edit(store,hurt);let self=selfState(service.state(),now);assert.equal(self.mood,'hurt');assert.equal(self.withdrawn,true);assert.equal(self.confidable,false);
  edit(store,s=>{s.persona.conflicts[0]={...s.persona.conflicts[0],at:now-1800,resolved:true};s.persona.emotions={...s.persona.emotions,annoyed:0,sad:.2};});
  self=selfState(service.state(),now);assert.equal(self.mood,'low');assert.equal(self.confidable,false);
  edit(store,s=>{s.persona.conflicts=[];s.persona.emotions.sad=0;});store.addChat('user','回头聊',now-4*1440);
  self=selfState(service.state(),now);assert.equal(self.mood,'low');assert.equal(self.confidable,true);assert.ok(self.needs.love>.6);assert.match(self.cause,/想他/);
  assert.equal(selfState(service.state(),now,{usage:{spent:190,limit:200}}).mood,'tired');
  assert.equal(selfState(service.state(),now).needs.tokens,null);
  const p=service.state().persona;feelFromReading(p,'uplifting');assert.ok(p.emotions.smile>0);
  assert.ok(distress('我真的撑不住了'));assert.ok(!distress('早八好困'));
 }finally{store.close();}
});

test('when hurt she may choose not to reply, but never to someone who is struggling',async()=>{
 const {store,service}=fixture();try{
  edit(store,hurt);const prompts=[];let writer='{"messages":[]}';
  const chat=new Chat(service,{config:()=>({deepseekKey:'test-only',openaiEnabled:false}),complete:async(messages,o)=>{if((o.json && !['dialogue','initiative-share','initiative-reminder','work-log'].includes(o.purpose)))return {text:'{"actions":[],"act":"social"}'};prompts.push(messages[0].content);return {text:writer};}});
  const quiet=await chat.run('在干嘛');assert.equal(quiet.silent,true);assert.equal(quiet.text,'');
  assert.match(prompts.at(-1),/可以选择这次不回/);assert.equal(store.chats().filter(c=>c.role==='assistant').length,0);
  writer='{"messages":[{"type":"text","text":"我在。你先说说怎么了。"}]}';
  const heard=await chat.run('我真的撑不住了');assert.equal(heard.text,'我在。你先说说怎么了。');
  assert.doesNotMatch(prompts.at(-1),/可以选择这次不回/);assert.match(prompts.at(-1),/很难受/);
 }finally{store.close();}
});

function agencyFixture(decision,{selfStudy=null}={}){
 const {store,service}=fixture(),seen=[];
 const models={config:()=>({deepseekKey:'test-only'}),complete:async(messages,o)=>{if((o.json && !['dialogue','initiative-share','initiative-reminder','work-log'].includes(o.purpose))){seen.push(JSON.parse(messages[1].content));return {text:JSON.stringify(decision)};}return {text:'{"messages":[{"type":"text","text":"好久没聊啦，有点想你。"}]}'};}};
 const chat=new Chat(service,models),agency=new Agency(service,chat,models,{running:false,run:async()=>({message:'没有读到资料。'})},null,selfStudy);
 return {store,service,agency,seen};
}

test('hurt keeps her from reaching out; missing someone lets her confide once a day',async()=>{
 const f=agencyFixture({action:'confide',reason:'有点想他'});try{
  f.store.addChat('user','回头聊',now-4*1440);
  edit(f.store,hurt);assert.equal(f.agency.canShare(f.service.state()),false);assert.match(f.agency.shareStatus().reason,/自己待一会儿/);
  edit(f.store,s=>{s.persona.conflicts=[];s.persona.emotions.annoyed=0;});
  await f.agency.run();assert.ok(f.seen[0].candidates.includes('confide'));assert.equal(f.seen[0].self.mood,'low');
  const a=f.service.state().agency;assert.equal(a.runs.at(-1).status,'queued');assert.equal(a.lastConfideAt,now);
  assert.match(f.store.messages()[0].payload.text,/想你/);
 }finally{f.store.close();}
});

test('she studies only a topic she was offered, and uplifting reading is what she wants to share first',async()=>{
 const runs=[],selfStudy={due:()=>true,topics:()=>[{topic:'机器人',origin:'interest'}],run:async pick=>{runs.push(pick);return {message:'学懂了一点',entry:{id:'k1'}};}};
 let f=agencyFixture({action:'study',reason:'想弄懂',topic:'机器人'},{selfStudy});try{
  edit(f.store,s=>{ensureWebLife(s).notes=[{id:'n1',at:now-60,note:'普通新闻',feeling:'neutral'},{id:'n2',at:now-90,note:'小猫学会开门',feeling:'uplifting'},{id:'n3',at:now-30,note:'另一条普通新闻'}];});
  await f.agency.run();assert.equal(runs[0].topic,'机器人');assert.equal(f.service.state().agency.runs.at(-1).status,'done');
  assert.ok(f.seen[0].candidates.includes('study'));assert.equal(f.seen[0].webNote.id,'n2');
 }finally{f.store.close();}
 f=agencyFixture({action:'study',reason:'想弄懂',topic:'没给过的题目'},{selfStudy});try{
  await f.agency.run();assert.equal(runs.length,1);assert.equal(f.service.state().agency.runs.at(-1).status,'failed');
 }finally{f.store.close();}
});

test('self-study keeps only quote-verified findings, follows up the question, and later shows up in chat',async()=>{
 const {store,service}=fixture();try{
  let answer={answer:'刚体在平面里有三个自由度。',findings:[{claim:'平面刚体三个自由度',sources:['S1'],quote:'three degrees of freedom',verified:true},{claim:'没核实的说法',sources:['S2'],verified:false}],sources:[{ref:'S1',title:'Modern Robotics',url:'https://example.org/dof'},{ref:'S2',title:'Blog',url:'https://example.org/blog'}],followups:['空间里呢？'],confidence:'medium',stats:{}};
  const tasks=[],study=new SelfStudy(service,{config:()=>({deepseekKey:'test-only'})},{run:async o=>{tasks.push(o);return answer;}});
  edit(store,s=>{ensureWebLife(s).notes=[{id:'q1',at:now-30,note:'读到自由度',question:'平面刚体有几个自由度？'}];});
  assert.equal(study.topics()[0].origin,'question');assert.ok(study.due());
  const r=await study.run(study.topics()[0]);assert.ok(r.entry);assert.equal(tasks[0].purpose,'learning-agent');
  const s=service.state();assert.equal(s.selfStudy.knowledge[0].points.length,1);assert.deepEqual(s.selfStudy.knowledge[0].sources.map(x=>x.ref),['S1']);
  assert.equal(s.webLife.notes[0].followedUpAt,now);assert.ok(!study.topics().some(t=>t.origin==='question'));assert.ok(s.persona.emotions.proud>0);
  answer={...answer,findings:[answer.findings[1]]};const failed=await study.run({topic:'机器人',origin:'interest'});
  assert.equal(failed.entry,undefined);assert.equal(service.state().selfStudy.knowledge.length,1);assert.ok(service.state().persona.emotions.sad>0);
  const prompts=[];const chat=new Chat(service,{config:()=>({deepseekKey:'test-only',openaiEnabled:false}),complete:async(messages,o)=>{prompts.push(messages[0].content);return {text:(o.json && !['dialogue','initiative-share','initiative-reminder','work-log'].includes(o.purpose))?'{"actions":[],"act":"question"}':'三个。'};}});
  await chat.run('平面刚体到底几个自由度');assert.ok(prompts.every(p=>p.includes('刚体在平面里有三个自由度')));
 }finally{store.close();}
});

test('the tool agent writes usage lessons after a failing run and reads them on the next run',async()=>{
 const {store,service}=fixture();try{
  const memory=new CapabilityMemory(service),call=(id,name,args)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}}),seen=[];
  const steps=[{tool_calls:[call('1','wiki_search',{query:'刚体'})]},{tool_calls:[call('2','finish',{answer:'没查到',findings:[],confidence:'low'})]},{tool_calls:[call('3','finish',{answer:'再试',findings:[],confidence:'low'})]}];
  const models={chat:async messages=>{seen.push(messages[0].content);return {message:{role:'assistant',content:'',...steps.shift()},cost:0};},complete:async()=>({text:JSON.stringify({lessons:[{tool:'wiki_search',lesson:'维基接口限流时换 scholar_search 或改用英文术语'},{tool:'made_up',lesson:'不存在的工具不该被记下'},{tool:'wiki_search',lesson:'去 https://example.org 找'}]})})};
  const toolkit={status:()=>({}),definitions:()=>[{type:'function',function:{name:'wiki_search',parameters:{}}}],execute:async()=>{throw new Error('HTTP 429（接口限流）');}};
  const agent=new ToolAgent({models,toolkit,memory});
  await agent.run({task:'刚体自由度'});await agent.pending;
  assert.deepEqual(memory.lessons().map(l=>l.lesson),['维基接口限流时换 scholar_search 或改用英文术语']);
  await agent.run({task:'另一个问题'});assert.match(seen.at(-1),/用工具的心得[\s\S]*维基接口限流/);
  service.command('memory.add',{content:'临时'});service.command('memory.remove',{id:store.read().memories[0].id});assert.equal(memory.lessons().length,0);
 }finally{store.close();}
});
