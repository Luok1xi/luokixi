import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.mjs';
import {Service} from '../src/service.mjs';
import {Chat} from '../src/chat.mjs';
import {Weixin,WEIXIN_BASE} from '../src/weixin.mjs';
import {InboxBurst} from '../src/inbox-burst.mjs';
import {Scheduler} from '../src/reminders.mjs';
import {dateMinute} from '../src/time.mjs';

function fixture(){
  const now=dateMinute('2026-09-27','12:00'),store=new Store(':memory:',now),service=new Service(store,()=>now),requests=[];
  const models={config:()=>({deepseekKey:'test'}),complete:async(messages,o)=>{requests.push({messages,o});return {text:o.purpose==='routing'?JSON.stringify({actions:[],act:'sharing'}):JSON.stringify({messages:[{type:'text',text:'这是完整回答'}]})};}};
  const chat=new Chat(service,models),weixin=new Weixin(service,chat,{burstOptions:{quietMs:0}});
  weixin.save({enabled:true,token:'test',user:'owner',bot:'bot',base:WEIXIN_BASE,epoch:'test',contextToken:'test'});
  const receive=(id,text)=>{const a=weixin.account();weixin.receive({message_id:String(id),create_time_ms:now*60000,from_user_id:'owner',to_user_id:'bot',message_type:1,message_state:2,item_list:[{type:1,text_item:{text}}]},a);weixin.save(a);};
  return {now,store,service,models,requests,chat,weixin,receive,close:async()=>{await weixin.close();store.close();}};
}
test('three short bubbles become one semantic turn and one outgoing chain',async()=>{
  const f=fixture();try{f.receive(1,'我刚才');f.receive(2,'想说的是');f.receive(3,'明天一起看机器人比赛');await f.weixin.processInbox();
    assert.equal(f.requests.length,2);assert.equal(f.store.chats().filter(x=>x.role==='user').length,1);assert.equal(f.store.chats()[0].text,'我刚才\n想说的是\n明天一起看机器人比赛');
    assert.equal(f.store.messages().length,1);assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM inbox WHERE status='batched'").get().n,3);
    await f.weixin.processInbox();assert.equal(f.requests.length,2);
  }finally{await f.close();}
});
test('input during intent extraction merges before any task mutation',async()=>{
  const f=fixture();try{
    const original=f.models.complete;let interrupted=false;
    f.models.complete=async(messages,o)=>{const response=await original(messages,o);if(o.purpose==='routing'&&!interrupted){interrupted=true;f.receive(2,'先别创建，我还没想好截止时间');response.text=JSON.stringify({actions:[{action:'task.add',args:{title:'实验',remaining:60,deadline:'2026-09-29 18:00'}}]});}return response;};
    f.receive(1,'记一个实验任务');await f.weixin.processInbox();assert.equal(f.store.read().tasks.length,0);
    assert.equal(f.requests.length,3);assert.equal(f.store.messages().length,1);assert.match(f.store.chats().find(x=>x.role==='user').text,/先别创建/);
  }finally{await f.close();}
});
test('input during writing suppresses stale text without repeating already committed actions',async()=>{
  const f=fixture();try{const original=f.models.complete;let routes=0,interrupted=false;
    f.models.complete=async(messages,o)=>{const response=await original(messages,o);if(o.purpose==='routing'&&routes++===0)response.text=JSON.stringify({actions:[{action:'task.add',args:{title:'实验',remaining:60,deadline:'2026-09-29 18:00'}}]});if(o.purpose==='dialogue'&&!interrupted){interrupted=true;f.receive(2,'另外我明天下午有空');response.text=JSON.stringify({messages:[{type:'text',text:'已经过时的回答'}]});}return response;};
    f.receive(1,'帮我记实验任务');await f.weixin.processInbox();assert.equal(f.store.read().tasks.length,1);
    assert.equal(f.store.messages().filter(x=>x.payload.kind==='reply').length,1);assert.equal(f.store.chats().filter(x=>x.role==='assistant').length,1);assert.ok(!JSON.stringify(f.store.chats()).includes('已经过时的回答'));
    const writer=f.requests.filter(x=>x.o.purpose==='dialogue').at(-1);assert.ok(JSON.stringify(writer.messages).includes('帮我记实验任务'));assert.ok(JSON.stringify(writer.messages).includes('另外我明天下午有空'));
  }finally{await f.close();}
});
test('queued reply becomes ineligible when another bubble arrives before sending',async()=>{
  const f=fixture();try{f.receive(1,'你好');await f.weixin.processInbox();const payload=f.store.messages()[0].payload;f.receive(2,'我还有下半句');const scheduler=new Scheduler(f.service,{chat:f.chat,weixinReady:()=>true,sendWeixin:async()=>{throw Error('stale reply must not send');}});assert.equal(scheduler.maySend(payload,f.now),false);await scheduler.deliver();assert.equal(f.store.messages()[0].status,'cancelled');}finally{await f.close();}
});
test('quiet window extends on arrivals but has a maximum wait',async()=>{
  const store=new Store(':memory:',0);let time=1000,sleeps=0;try{
    const b=new InboxBurst(store,{clock:()=>time,quietMs:1800,maxWaitMs:5000,sleep:async ms=>{time+=ms;b.received('weixin:'+ ++sleeps);}});b.received('weixin:0');await b.settle('weixin:%');assert.equal(time,6000);assert.ok(sleeps>=2);
  }finally{store.close();}
});
test('media boundaries are kept separate and unfinished batches resume after reconstruction',()=>{
  const store=new Store(':memory:',0);try{
    for(const [id,text] of [['wx:1','a'],['wx:2','b'],['wx:3','image']])store.db.prepare('INSERT INTO inbox(id,text,at) VALUES(?,?,?)').run(id,text,0);
    let b=new InboxBurst(store);const first=b.claim('wx:%',{media:id=>id==='wx:3'});assert.equal(first.row.text,'a\nb');b=new InboxBurst(store);assert.equal(b.claim('wx:%').row.id,first.row.id);
    b.retry(first);assert.equal(store.db.prepare("SELECT COUNT(*) n FROM inbox WHERE status='pending'").get().n,3);
  }finally{store.close();}
});
