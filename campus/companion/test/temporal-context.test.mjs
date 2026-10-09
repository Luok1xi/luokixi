import test from 'node:test';
import assert from 'node:assert/strict';
import {dateMinute} from '../src/time.mjs';
import {calendarReference,datedHistory,temporalContext,timedTask} from '../src/temporal-context.mjs';
import {Store} from '../src/store.mjs';
import {Service} from '../src/service.mjs';
import {Chat} from '../src/chat.mjs';

test('reference calendar handles midnight, month/year boundaries, leap day and Monday-based weeks',()=>{
  const year=calendarReference(dateMinute('2026-12-31','23:59'));
  assert.equal(year.tomorrow,'2027-01-01');assert.equal(year.dayAfterTomorrow,'2027-01-02');
  assert.equal(year.nextWeek['周一'],'2027-01-04');
  assert.equal(calendarReference(dateMinute('2028-02-28','23:59')).tomorrow,'2028-02-29');
  assert.equal(calendarReference(dateMinute('2026-09-27')).nextWeek['周一'],'2026-09-28');
  assert.equal(calendarReference(dateMinute('2026-09-28')).thisWeek['周一'],'2026-09-28');
});

test('elapsed minutes and calendar days are separate; missing timestamps are unknown',()=>{
  const now=dateMinute('2026-09-27','00:01'),at=dateMinute('2026-09-26','23:59');
  const rows=datedHistory([{role:'user',text:'明天再聊',at},{role:'assistant',text:'旧记录，没有时间'}],now);
  assert.equal(rows[0].elapsedMinutes,2);assert.equal(rows[0].calendarDaysAgo,1);
  assert.equal(rows[0].sentAt,'2026-09-26 23:59');assert.equal(rows[1].sentAt,null);
  const context=temporalContext(now,[{role:'user',at}]);
  assert.equal(context.lastUserElapsedMinutes,2);assert.equal(context.calendarDaysSinceLastUser,1);
  assert.equal(context.timezone,'Asia/Shanghai');
});

test('old message reference is distinct from processing time and does not silently roll forward',()=>{
  const now=dateMinute('2026-09-27','00:10'),sent=dateMinute('2026-09-26','23:55');
  const context=temporalContext(now,[],sent);
  assert.equal(context.now,'2026-09-27 00:10');assert.equal(context.reference.tomorrow,'2026-09-27');
  assert.equal(context.processingDelayMinutes,15);
  assert.equal(temporalContext(now,[],-1).reference.today,'2026-09-27');
});

test('deadline classification does not reduce remaining effort or mark work done',()=>{
  const now=dateMinute('2026-09-26','23:00'),t={status:'open',remaining:120,deadline:now-10};
  const result=timedTask(t,now);assert.equal(result.deadlineStatus,'overdue');
  assert.equal(result.status,'open');assert.equal(result.remaining,120);assert.deepEqual(t,{status:'open',remaining:120,deadline:now-10});
});

test('routing and the shared writer both preserve original inbox timestamps and dated history',async()=>{
  const now=dateMinute('2026-09-27','00:10'),sent=dateMinute('2026-09-26','23:55'),store=new Store(':memory:',now),service=new Service(store,()=>now),requests=[];
  try{
    store.addChat('user','明天去图书馆',dateMinute('2026-09-22','18:00'));
    store.db.prepare('INSERT INTO inbox(id,text,at) VALUES(?,?,?)').run('delayed','明天是什么日期？',sent);
    const models={config:()=>({deepseekKey:'test'}),complete:async(messages,options)=>{requests.push({messages,options});return {text:options.purpose==='routing'?'\u007b"actions":[],"thinking":"fast"\u007d':'{"messages":[{"type":"text","text":"按你发这条消息的时间，是9月27日。"}]}'};}};
    await new Chat(service,models).run('明天是什么日期？',{requestId:'delayed'});
    for(const r of requests){
      const serialized=JSON.stringify(r.messages);assert.ok(serialized.includes('2026-09-22 18:00'));
      assert.ok(serialized.includes('2026-09-26 23:55'));assert.ok(serialized.includes('Asia/Shanghai'));
    }
    assert.equal(store.chats().filter(r=>r.role==='user').at(-1).at,sent);
  }finally{store.close();}
});
