import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.mjs';
import {Service} from '../src/service.mjs';
import {Chat} from '../src/chat.mjs';
import {ConversationLibrary} from '../src/conversation-library.mjs';
import {SocialWatch} from '../src/social-watch.mjs';
import {dateMinute} from '../src/time.mjs';

function fixture(){let now=dateMinute('2026-09-27','12:00'),calls=0,reads=0;const store=new Store(':memory:',now),service=new Service(store,()=>now);
  const models={config:()=>({deepseekKey:'test'}),complete:async(messages,o)=>{calls++;if(o.purpose==='initiative-social-analysis'){const m=JSON.parse(messages.at(-1).content).messages[0];return {text:JSON.stringify({notify:true,summary:'活动地点变化',advice:[],todos:[{title:'确认新的集合地点',priority:3,deadlineText:null,steps:[],evidence:[{messageId:m.id,quote:m.text}]}],uncertainties:[]})};}return {text:'{"messages":[{"type":"text","text":"群里刚改了地点，你出门前看一下。"}]}'};}};
  const chat=new Chat(service,models),library=new ConversationLibrary(service,models,chat),thread={remote:'group:1',title:'比赛',kind:'competition',messages:[{id:'1',sender:'队长',text:'集合地点改为南门',at:'2026-09-27 12:00'}]},reader={scan:async()=>{reads++;return {status:'ready',detail:'test',threads:[thread]};}},social=new SocialWatch(service,library,{qq:reader});
  return {store,service,chat,library,social,reader,thread,advance:n=>now+=n,calls:()=>calls,reads:()=>reads,close:async()=>{await social.close();store.close();}};
}
test('background collection requires enable, deduplicates scans, batches analysis and queues one shared expression',async()=>{
  const f=fixture();try{await f.social.tick();assert.equal(f.reads(),0);f.social.configure('qq',true);await f.social.tick();assert.equal(f.calls(),0);assert.equal(f.library.sources()[0].count,1);
    f.advance(3);await f.social.tick();assert.equal(f.calls(),2);assert.equal(f.library.sources()[0].count,1);assert.equal(f.store.messages().length,3);assert.equal(f.store.read().tasks.length,0);
    f.advance(35);await f.social.tick();assert.equal(f.calls(),2);assert.equal(f.store.messages().length,3);
    const p=f.store.messages()[0].payload;assert.equal(f.social.valid(p),true);f.social.configure('qq',false);assert.equal(f.social.valid(p),false);assert.ok(f.store.messages().every(x=>x.status==='cancelled'));
  }finally{await f.close();}
});
test('pause while source read is pending prevents import and model calls',async()=>{
  const f=fixture();let release;try{f.reader.scan=()=>new Promise(r=>release=r);f.social.configure('qq',true);const job=f.social.tick();f.social.configure('qq',false);release({status:'ready',detail:'test',threads:[f.thread]});await job;assert.equal(f.library.sources().length,0);assert.equal(f.calls(),0);}finally{await f.close();}
});
test('deleting an automatic source invalidates queued suggestions and old snapshots do not resurrect it',async()=>{
  const f=fixture();try{f.social.configure('qq',true);await f.social.tick();f.advance(3);await f.social.tick();const p=f.store.messages()[0].payload;f.library.remove(p.socialSourceId);assert.equal(f.social.valid(p),false);f.advance(2);await f.social.tick();assert.equal(f.library.sources().length,0);}finally{await f.close();}
});
test('unreadable source is reported and backs off rather than fabricating an empty success',async()=>{
  const f=fixture();try{f.reader.scan=async()=>({status:'blocked',detail:'UI tree unavailable',threads:[]});f.social.configure('qq',true);await f.social.tick();assert.equal(f.social.status().channels[0].status,'blocked');assert.equal(f.calls(),0);assert.equal(f.library.sources().length,0);}finally{await f.close();}
});
