import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.mjs';
import {Service} from '../src/service.mjs';
import {Chat} from '../src/chat.mjs';
import {Scheduler} from '../src/reminders.mjs';
import {dateMinute} from '../src/time.mjs';

function fixture(time='07:10'){
  let now=dateMinute('2026-09-22',time),calls=0;
  const store=new Store(':memory:',now),service=new Service(store,()=>now),requests=[],deliveries=[];
  const models={config:()=>({deepseekKey:'test'}),complete:async(messages,options)=>{
    calls++;requests.push({messages,options});
    return {text:JSON.stringify({messages:[{type:'text',text:'九点的实验记得带记录本。'}, {type:'text',text:'昨晚那个问题，等你回来再接着聊。'}]})};
  }};
  const chat=new Chat(service,models),scheduler=new Scheduler(service,{chat,feishuReady:()=>true,weixinReady:()=>true,
    sendFeishu:async p=>{deliveries.push({channel:'feishu',payload:p});return 'f';},
    sendWeixin:async p=>{deliveries.push({channel:'weixin',payload:p});return 'w';}});
  const addWork=()=>service.command('block.add',{title:'实验',start:'2026-09-22 09:00',end:'2026-09-22 10:00'});
  return {store,service,models,chat,scheduler,requests,deliveries,addWork,get calls(){return calls;},advance:n=>now+=n};
}

test('default meals do not become morning broadcasts; old empty morning queues are retired',async()=>{
  const f=fixture();try{
    f.service.command('replan');assert.equal(f.store.messages().filter(r=>r.id.includes(':morning:')).length,0);
    for(const c of ['local','feishu','weixin'])f.store.enqueue(c+':morning:2026-09-22',f.service.clock(),f.service.clock()+60,{kind:'reminder',text:'今天的安排\n早餐\n午餐'},c);
    await f.scheduler.deliver();assert.equal(f.calls,0);assert.equal(f.deliveries.length,0);
    assert.ok(f.store.messages().every(r=>r.status==='cancelled'));
  }finally{f.store.close();}
});

test('one model-written chain serves every channel; idle sync does not overwrite drafts or rewrite rows',async()=>{
  const f=fixture();try{
    f.addWork();await Promise.all([f.scheduler.deliver(),f.scheduler.deliver()]);
    assert.equal(f.calls,1);assert.equal(f.deliveries.length,2);assert.equal(f.store.chats().length,1);
    assert.equal(f.requests[0].options.purpose,'initiative-reminder');
    assert.ok(f.requests[0].messages[0].content.includes('当前角色卡'));
    assert.deepEqual(f.deliveries[0].payload.messages,f.deliveries[1].payload.messages);
    assert.equal(f.store.chats()[0].text,f.deliveries[0].payload.text);
    const before=f.store.db.prepare('SELECT total_changes() n').get().n;
    f.service.syncReminders(f.store.read(),f.service.clock());
    assert.equal(f.store.db.prepare('SELECT total_changes() n').get().n,before);
    await f.scheduler.deliver();assert.equal(f.calls,1);
  }finally{f.store.close();}
});

test('unallocated real work remains visible even when today has no course or flexible block',()=>{
  const f=fixture();try{
    f.service.command('task.add',{title:'未排入的实验',remaining:30,deadline:'2026-09-22 09:00'});
    const s=f.store.read(),task=s.tasks[0];s.plan.allocations=[];s.plan.unscheduled=[{taskId:task.id,title:task.title,minutes:30}];
    f.store.save(s);f.service.syncReminders(s,f.service.clock());
    const row=f.store.messages().find(r=>r.id==='local:morning:2026-09-22');assert.equal(row.payload.notice.unscheduled[0].taskId,task.id);
  }finally{f.store.close();}
});

test('a persisted draft survives a sender failure and Scheduler reconstruction without another model call',async()=>{
  const f=fixture();try{
    f.addWork();f.scheduler.sendWeixin=async()=>{throw Error('offline');};await f.scheduler.deliver();
    assert.equal(f.calls,1);f.advance(2);f.service.syncReminders(f.store.read(),f.service.clock());
    const sent=[];await new Scheduler(f.service,{chat:f.chat,weixinReady:()=>true,sendWeixin:async p=>sent.push(p)}).deliver();
    assert.equal(f.calls,1);assert.equal(sent.length,1);assert.equal(f.store.chats().length,1);
  }finally{f.store.close();}
});

test('routine silence and unavailable models never fall back to canned morning speech',async()=>{
  for(const unavailable of [false,true]){
    const f=fixture();try{
      f.addWork();let calls=0;f.models.complete=async()=>{calls++;if(unavailable)throw Error('budget');return {text:'{"messages":[]}'};};
      await f.scheduler.deliver();assert.equal(calls,1);assert.equal(f.deliveries.length,0);assert.equal(f.store.chats().length,0);
      assert.ok(f.store.messages().every(r=>r.status==='cancelled'));
    }finally{f.store.close();}
  }
});

test('budget failure retains a real deadline as an explicit system notification, once per channel',async()=>{
  const f=fixture('10:00');try{
    f.service.command('task.add',{title:'提交实验记录',remaining:30,deadline:'2026-09-23 10:00'});
    f.store.db.prepare("UPDATE outbox SET status='cancelled' WHERE id NOT LIKE '%:deadline:%'").run();
    let calls=0;f.models.complete=async()=>{calls++;throw Error('budget');};
    await f.scheduler.deliver();assert.equal(calls,1);assert.equal(f.deliveries.length,2);
    assert.match(f.deliveries[0].payload.text,/^系统提醒：.*提交实验记录/);
    assert.equal(f.store.chats().length,0);
  }finally{f.store.close();}
});

test('completing work while a review is being written cancels its draft on all channels',async()=>{
  const f=fixture('21:31');try{
    f.service.command('task.add',{title:'作业',remaining:30,deadline:'2026-09-22 23:59'});
    const t=f.store.read().tasks[0];f.store.db.prepare("UPDATE outbox SET status='cancelled' WHERE id NOT LIKE '%:evening:%'").run();
    f.models.complete=async()=>{const s=f.store.read();s.tasks[0].status='done';s.tasks[0].remaining=0;f.store.save(s);return {text:'{"messages":[{"type":"text","text":"旧任务提醒"}]}'};};
    await f.scheduler.deliver();assert.equal(f.deliveries.length,0);assert.equal(f.store.chats().length,0);
    assert.ok(f.store.messages().filter(r=>r.id.includes(':evening:')).every(r=>r.status==='cancelled'));
  }finally{f.store.close();}
});

test('pause and expiration during model generation are rechecked before sending',async()=>{
  for(const expire of [false,true]){
    const f=fixture();try{
      f.addWork();f.models.complete=async()=>{if(expire)f.advance(300);else{const s=f.store.read();s.settings.remindersPaused=true;f.store.save(s);}return {text:'{"messages":[{"type":"text","text":"尚未送出的消息"}]}'};};
      await f.scheduler.deliver();assert.equal(f.deliveries.length,0);assert.equal(f.store.chats().length,0);
    }finally{f.store.close();}
  }
});

test('new user context during writing defers all sibling drafts instead of sending stale speech',async()=>{
  const f=fixture();try{
    f.addWork();let calls=0;f.models.complete=async()=>{calls++;f.store.addChat('user','这件事刚聊过了',f.service.clock());return {text:'{"messages":[{"type":"text","text":"过时的提醒"}]}'};};
    await f.scheduler.deliver();assert.equal(calls,1);assert.equal(f.deliveries.length,0);
    assert.equal(f.store.chats().filter(r=>r.role==='assistant').length,0);
  }finally{f.store.close();}
});

test('an unsent proactive draft is cancelled after a newer user turn',async()=>{
  const f=fixture('12:00');try{
    f.store.addChat('user','刚才的话题',f.service.clock()-30);const id=f.store.chats().at(-1).id;
    f.store.enqueue('local:proactive:old',f.service.clock(),f.service.clock()+60,{kind:'proactive',policyVersion:5,conversationId:id,text:'旧话题的补充'},'local');
    f.store.addChat('user','换个话题',f.service.clock());await f.scheduler.deliver();
    assert.equal(f.store.messages()[0].status,'cancelled');assert.equal(f.store.chats().filter(r=>r.role==='assistant').length,0);
  }finally{f.store.close();}
});

test('ordinary proactive writing reads state once and does not inject the schedule into casual conversation',async()=>{
  const f=fixture();try{
    f.addWork();const real=f.service.state.bind(f.service);let reads=0;f.service.state=()=>{reads++;return real();};
    const original=f.chat.context.bind(f.chat),contexts=[];f.chat.context=(...args)=>{const c=original(...args);contexts.push(c);return c;};
    await f.chat.compose({trigger:'proactive',material:{reason:'想继续聊音乐'}});
    assert.equal(reads,1);assert.equal(contexts[0].plan,null);assert.deepEqual(contexts[0].tasks,[]);
    await f.chat.compose({message:'今天有什么事？'});assert.ok(contexts[1].plan);
  }finally{f.store.close();}
});

test('a delivery request inside the conversation lock does not deadlock or start competing drafts',async()=>{
  const f=fixture();try{
    f.addWork();f.store.enqueue('weixin:reply:manual',f.service.clock(),f.service.clock()+10,{kind:'reply',text:'用户要求立即发送的消息'},'weixin');
    await f.chat.exclusive(()=>f.scheduler.deliver());
    assert.equal(f.calls,0);assert.equal(f.deliveries.length,1);assert.equal(f.deliveries[0].payload.kind,'reply');
    await f.scheduler.deliver();assert.equal(f.calls,1);
  }finally{f.store.close();}
});

test('a routine draft waiting for the phone is retired when the user has already resumed talking',async()=>{
  const f=fixture();try{
    f.addWork();f.scheduler.weixinReady=()=>false;await f.scheduler.deliver();assert.equal(f.calls,1);
    f.store.addChat('user','实验的事情已经处理好了，我们聊别的吧',f.service.clock());
    f.scheduler.weixinReady=()=>true;await f.scheduler.deliver();
    assert.equal(f.deliveries.filter(r=>r.channel==='weixin').length,0);
    assert.equal(f.store.messages().find(r=>r.id==='weixin:morning:2026-09-22').status,'cancelled');
  }finally{f.store.close();}
});
