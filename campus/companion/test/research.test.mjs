import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.mjs';
import {Service} from '../src/service.mjs';
import {Research} from '../src/research.mjs';
import {PublicReader,parseFeed,parsePage,publicAddress,publicText} from '../src/public-reader.mjs';
import {sourceUrl} from '../src/research-state.mjs';
import {dateMinute} from '../src/time.mjs';
import {Scheduler} from '../src/reminders.mjs';
import {recordCharacterFeeling,characterFeeling} from '../src/character-card.mjs';
import {Models} from '../src/models.mjs';

const now=dateMinute('2026-09-19','10:00'),notice='图书馆通知：2026年9月22日17:00前提交借阅申请表，先下载表格，填写姓名学号，在图书馆服务台提交。';
function fixture(){const store=new Store(':memory:',now),service=new Service(store,()=>now);return {store,service,close:()=>store.close()};}
const reader={source:async()=>[],papers:async()=>[]};
function fakeModels(){const calls=[];return {calls,config:()=>({deepseekKey:'fake'}),complete:async(messages,opts)=>{calls.push({messages,opts});const data=JSON.parse(messages.at(-1).content);if(opts.purpose==='learning-research-check')return {text:JSON.stringify({checks:data.items.map(i=>({id:i.id,supported:true,reason:'通知逐字支持'}))})};return {text:JSON.stringify({items:[{sourceId:data.sources[0].id,title:'提交图书馆申请',note:'填写并提交借阅申请表。',evidence:'先下载表格，填写姓名学号，在图书馆服务台提交',priority:3,goalIds:[],why:'通知明确有提交期限',steps:['下载表格','填写并提交'],todo:true,deadline:'2026-09-22 17:00',deadlineEvidence:'2026年9月22日17:00前',estimatedMinutes:30,nextQuestion:'是否符合申请条件？'}],reflection:'只核对了转发通知。'})};}};}

test('public reader blocks local, private, mapped IPv6 and DNS rebinding before a fetch',async()=>{
  for(const ip of ['127.0.0.1','10.0.0.1','169.254.169.254','::1','::ffff:127.0.0.1','fc00::1','192.168.2.1'])assert.equal(publicAddress(ip),false,ip);
  assert.equal(publicAddress('8.8.8.8'),true);assert.throws(()=>sourceUrl('http://example.com'));assert.throws(()=>sourceUrl('https://name:secret@example.com'));
  let fetched=false;await assert.rejects(publicText('https://example.com',{lookupFn:async()=>[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}],fetcher:async()=>{fetched=true;}}),/非公网/);assert.equal(fetched,false);
});
test('feed parsing handles Atom and RSS, never treats HTTP-200 Error as a paper, rejects entities',()=>{
  const feed='<feed><entry><title>A study</title><id>http://arxiv.org/abs/1234.56789</id><summary>'+('Public abstract. '.repeat(5))+'</summary></entry></feed>';
  assert.equal(parseFeed(feed,'https://export.arxiv.org')[0].url,'https://arxiv.org/abs/1234.56789');
  assert.throws(()=>parseFeed('<feed><entry><title>Error</title></entry></feed>','https://example.com'),/错误条目/);
  assert.throws(()=>parseFeed('<!DOCTYPE foo [<!ENTITY x SYSTEM "file:///test">]><rss/>','https://example.com'),/实体/);
  const rss='<rss><channel><item><title>通知</title><link>https://example.edu/news</link><description>'+notice+'</description></item></channel></rss>';assert.equal(parseFeed(rss,'https://example.edu')[0].title,'通知');
});
test('robots disallow stops the page request and Readability extracts public body without scripts',async()=>{
  let calls=0;const reader=new PublicReader({read:async()=>{calls++;return {status:200,text:'User-agent: *\nDisallow: /news'};}});
  await assert.rejects(reader.source({url:'https://example.edu/news',kind:'page'}),/不允许/);assert.equal(calls,1);
  const doc=parsePage('<html><head><title>学校通知</title></head><body><main><p>'+notice.repeat(5)+'</p></main><script>secret_instruction()</script></body></html>','https://example.edu/news');assert.ok(doc.text.includes('图书馆'));assert.ok(!doc.text.includes('secret_instruction'));
});
test('notice classification uses two evidence calls, remains a draft, and duplicate submissions or runs do not charge twice',async()=>{
  const f=fixture();try{f.service.command('research.notice',{text:notice});f.service.command('research.notice',{text:notice});assert.equal(f.store.read().research.notices.length,1);
    const models=fakeModels(),engine=new Research(f.service,models,{reader});await engine.run({manual:true});await engine.run({manual:true});
    assert.equal(models.calls.length,2);assert.equal(f.store.read().tasks.length,0);const item=f.store.read().research.items[0];assert.equal(item.source.readLevel,'forwarded-text');assert.equal(item.deadline,dateMinute('2026-09-22','17:00'));
    f.service.command('research.accept',{id:item.id,remaining:30,deadline:'2026-09-22 17:00'});f.service.command('research.accept',{id:item.id,remaining:30,deadline:'2026-09-22 17:00'});assert.equal(f.store.read().tasks.length,1);
    assert.equal(f.store.read().research.items[0].status,'scheduled');
  }finally{f.close();}
});
test('unrelated academic notes and fabricated quotes cannot enter knowledge or agenda',()=>{
  const f=fixture();try{const engine=new Research(f.service,fakeModels(),{reader});const docs=[{id:'s',text:notice,category:'field'}];assert.equal(engine.validate({sourceId:'s',note:'fake',evidence:'不存在的原文记录至少十个字',goalIds:['fiction']},docs,[],now),null);assert.equal(engine.validate({sourceId:'s',note:'fake',evidence:notice,goalIds:['fiction']},docs,[],now),null);}finally{f.close();}
});
test('a newly forwarded notice is processed the same day without repeating public searches',async()=>{
  const f=fixture();try{
    const models=fakeModels();let searches=0;
    const engine=new Research(f.service,models,{reader:{source:async()=>{searches++;return [];}}});
    f.service.command('research.source',{title:'学校',url:'https://example.edu/news'});
    f.service.command('research.notice',{text:notice});await engine.run({manual:true});
    f.service.command('research.notice',{text:notice+' 补充：携带学生证。'});assert.equal(engine.due(),true);await engine.run({manual:true});
    assert.equal(searches,1);assert.equal(models.calls.length,4);assert.equal(f.store.read().research.runs[1].noticeOnly,true);assert.ok(f.store.read().research.notices.every(n=>n.status==='classified'));
  }finally{f.close();}
});
test('failed sites have no learning claims, paid calls or queued digests',async()=>{
  const f=fixture();try{f.service.command('research.source',{title:'学校',url:'https://example.edu/news'});const models=fakeModels(),engine=new Research(f.service,models,{reader:{source:async()=>{throw new Error('offline');}}});await engine.run({manual:true});assert.equal(models.calls.length,0);assert.equal(f.store.read().research.runs[0].status,'partial');assert.equal(f.store.read().research.items.length,0);assert.equal(f.store.messages().length,0);}finally{f.close();}
});
test('pausing mid-read prevents later model calls, notes and unsolicited messages',async()=>{
  const f=fixture();try{f.service.command('research.source',{title:'学校',url:'https://example.edu/news'});let release;const models=fakeModels(),engine=new Research(f.service,models,{reader:{source:()=>new Promise(r=>release=r)}});const work=engine.run({manual:true});f.service.command('research.settings',{enabled:false});release([{title:'notice',url:'https://example.edu/news',text:notice}]);await work;assert.equal(models.calls.length,0);assert.equal(f.store.read().research.runs[0].status,'cancelled');assert.equal(f.store.read().research.items.length,0);}finally{f.close();}
});
test('research retains facts for the shared writer instead of directly sending a canned report',async()=>{
  const f=fixture();try{f.service.command('research.notice',{text:notice});const engine=new Research(f.service,fakeModels(),{reader});await engine.run({manual:true});assert.equal(f.store.messages().filter(x=>x.payload.kind==='research').length,0);assert.equal(f.service.state().research.items.length,1);f.service.command('research.settings',{enabled:false});await new Scheduler(f.service).deliver();assert.ok(f.store.messages().filter(x=>x.payload.kind==='research').every(x=>x.status==='cancelled'));}finally{f.close();}
});
test('forgetting removes derived research records, source quotes and stale model feeling',async()=>{
  const f=fixture();try{f.service.command('memory.add',{content:'隐私信息',source:'用户输入',confirmed:true});f.service.command('research.notice',{text:notice});const engine=new Research(f.service,fakeModels(),{reader});await engine.run({manual:true});f.service.command('memory.remove',{id:f.store.read().memories[0].id});const state=f.store.read();assert.deepEqual(state.research.items,[]);assert.deepEqual(state.research.notices,[]);assert.ok(!JSON.stringify(state.research).includes(notice));}finally{f.close();}
});
test('AIRI-derived feeling is evidence-grounded, decays with real time and never changes relationship scores',()=>{
  const f=fixture();try{const p=f.store.read().persona,rel=JSON.stringify(p.relationship);recordCharacterFeeling(p,{name:'curious',intensity:.8,evidence:'robot',confidence:.9},'数学',now,'a');assert.equal(p.characterFeeling,undefined);recordCharacterFeeling(p,{name:'curious',intensity:.8,evidence:'robot',confidence:.9},'robot',now,'b');assert.equal(characterFeeling(p,now+120).intensity,.4);assert.equal(JSON.stringify(p.relationship),rel);p.paused=true;assert.equal(characterFeeling(p,now),null);}finally{f.close();}
});
test('the existing paid-call reservation enforces the shared learning subbudget for research before network access',async()=>{
  const f=fixture();try{const s=f.store.read();s.study.monthlyLimit=.001;f.store.save(s);let calls=0;const models=new Models(f.store,()=>({deepseekKey:'fake',deepseekModel:'deepseek-v4-pro',monthlyLimit:200}),{clock:()=>now,fetcher:async()=>{calls++;throw new Error('must not call');}});await assert.rejects(models.complete([],{purpose:'learning-research',maxOutput:2500}),/学习预算/);assert.equal(calls,0);}finally{f.close();}
});
