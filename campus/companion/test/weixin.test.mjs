import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.mjs';
import {Service} from '../src/service.mjs';
import {Chat} from '../src/chat.mjs';
import {Weixin,parseWeixinJson,trustedWeixinBase,WEIXIN_BASE} from '../src/weixin.mjs';
import {Scheduler} from '../src/reminders.mjs';
import {dateMinute} from '../src/time.mjs';
import {createDecipheriv} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {trustedCdn} from '../src/weixin-media.mjs';
const at=dateMinute('2026-09-19','12:00');
const response=data=>new Response(JSON.stringify(data));
function fixture(fetcher=async()=>response({ret:0})){
 const store=new Store(':memory:',at),service=new Service(store,()=>at);let calls=0;
 const models={config:()=>({deepseekKey:'test',openaiEnabled:false}),complete:async(_,o)=>{calls++;return {text:(o.json && !['dialogue','initiative-share','initiative-reminder','work-log'].includes(o.purpose))?'{"actions":[],"act":"social"}':'这是模型写的回复。'};}};
 const chat=new Chat(service,models),weixin=new Weixin(service,chat,{fetcher});
 weixin.save({enabled:true,token:'PRIVATE-TOKEN',user:'owner',bot:'bot-id',base:WEIXIN_BASE,epoch:'epoch',cursor:'',contextToken:'PRIVATE-CONTEXT'});
 return {store,service,chat,weixin,calls:()=>calls,close:async()=>{await weixin.close();store.close();}};
}
const msg=(id='1',extra={})=>({message_id:id,create_time_ms:at*60000,from_user_id:'owner',to_user_id:'bot-id',message_type:1,message_state:2,context_token:'next-context',item_list:[{type:1,text_item:{text:'你好'}}],...extra});
test('iLink preserves uint64 IDs and rejects credential forwarding to arbitrary endpoints',()=>{
 const d=parseWeixinJson('{"message_id":18446744073709551615,"text":"message_id: 123"}');assert.equal(d.message_id,'18446744073709551615');assert.equal(d.text,'message_id: 123');
 for(const x of ['http://ilinkai.weixin.qq.com','https://ilinkai.weixin.qq.com.evil.test','https://user:pass@ilinkai.weixin.qq.com','https://127.0.0.1','https://ilinkai.weixin.qq.com/path'])assert.throws(()=>trustedWeixinBase(x));
 assert.equal(trustedWeixinBase(WEIXIN_BASE),WEIXIN_BASE);
});
test('QR login uses unauthenticated requests and only stores verified owner credentials locally',async()=>{
 const f=fixture(async(url,o)=>{assert.equal(o.headers.Authorization,undefined);return response(url.includes('get_bot_qrcode')?{qrcode:'qr',qrcode_img_content:'https://liteapp.weixin.qq.com/q/test'}:{status:'confirmed',bot_token:'NEW-SECRET',ilink_bot_id:'bot-id',ilink_user_id:'owner',baseurl:WEIXIN_BASE});});
 try{f.weixin.connect=()=>{};const login=await f.weixin.startLogin();assert.match(login.image,/^data:image\/png;base64,/);await f.weixin.pollLogin(login.id);assert.equal(f.weixin.account().token,'NEW-SECRET');assert.equal(f.weixin.ready(),false);
 const publicData=JSON.stringify({info:f.weixin.info(),state:f.service.state()});assert.ok(!publicData.includes('NEW-SECRET'));assert.ok(!publicData.includes('PRIVATE-CONTEXT'));
 }finally{await f.close();}
});
test('owner-only text inbox rejects groups, other accounts, old messages and duplicate progress',async()=>{
 const f=fixture();try{const a=f.weixin.account();for(const m of [msg('1',{from_user_id:'stranger'}),msg('2',{group_id:'group'}),msg('3',{message_type:2}),msg('4',{create_time_ms:(at-121)*60000}),msg('5',{to_user_id:'other-bot'})])f.weixin.receive(m,a);
 assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM inbox').get().n,0);f.weixin.receive(msg('6'),a);f.weixin.receive(msg('6'),a);f.weixin.save(a);await f.weixin.processInbox();await f.weixin.processInbox();
 assert.equal(f.calls(),2);assert.equal(f.store.chats().length,2);assert.equal(f.store.messages().filter(x=>x.channel==='weixin').length,1);
 assert.equal(f.store.messages()[0].payload.text,'这是模型写的回复。');
 }finally{await f.close();}
});
test('cursor advances with durable inbound data and can recover replies without another model call',async()=>{
 const f=fixture(async()=>response({ret:0,get_updates_buf:'cursor-next',msgs:[msg('7')]}));try{await f.weixin.pollOnce();await f.weixin.inflight;assert.equal(f.weixin.account().cursor,'cursor-next');
 f.store.db.exec("DELETE FROM outbox WHERE channel='weixin'");await f.weixin.processInbox();assert.equal(f.calls(),2);assert.equal(f.store.messages().length,1);
 }finally{await f.close();}
});
test('non-text input receives a capability notice and never feeds unknown media to the model',async()=>{
 const f=fixture();try{const a=f.weixin.account();f.weixin.receive(msg('8',{item_list:[{type:2,image_item:{}}]}),a);f.weixin.save(a);await f.weixin.processInbox();assert.equal(f.calls(),0);assert.match(f.store.messages()[0].payload.text,/单张图片/);}finally{await f.close();}
});
test('HTTP 200 with ret -2 is failure, blocks retries until a new owner message refreshes context',async()=>{
 const f=fixture(async()=>response({ret:-2,errmsg:'PRIVATE-TOKEN'}));try{
 f.store.enqueue('weixin:reply:one',at,at+60,{kind:'reply',text:'hello'},'weixin');
 const scheduler=new Scheduler(f.service,{weixinReady:()=>f.weixin.ready(),sendWeixin:(p,k)=>f.weixin.send(p,k)});await scheduler.deliver();
 assert.notEqual(f.store.messages()[0].status,'sent');assert.equal(f.weixin.ready(),false);assert.ok(!f.store.messages()[0].error.includes('PRIVATE-TOKEN'));
 const a=f.weixin.account();f.weixin.receive(msg('9'),a);f.weixin.save(a);assert.equal(f.weixin.ready(),true);
 }finally{await f.close();}
});

test('official implicit success without ret is accepted once, while nonzero errcode still fails',async()=>{
 let sends=0;const f=fixture(async()=>{sends++;return response({});});try{
  const key='weixin:reply:implicit';f.store.enqueue(key,at,at+60,{kind:'reply',text:'日记'},'weixin');
  const scheduler=new Scheduler(f.service,{weixinReady:()=>f.weixin.ready(),sendWeixin:(p,k)=>f.weixin.send(p,k)});
  await scheduler.deliver();await scheduler.deliver();assert.equal(sends,1);assert.equal(f.store.messages()[0].status,'sent');
  f.weixin.fetcher=async()=>response({errcode:-14});await assert.rejects(f.weixin.send({text:'另一条'},'other'),/授权已失效/);assert.equal(f.weixin.ready(),false);
 }finally{await f.close();}
});
test('multi-part transport preserves Unicode and retries only unsent parts using stable IDs',async()=>{
 const sent=[],f=fixture(async(_,o)=>{const data=JSON.parse(o.body);sent.push(data.msg);if(sent.length===2)return response({ret:1});return response({ret:0});});try{
 const text='🙂'.repeat(2000);await assert.rejects(f.weixin.send({text},'large'));await f.weixin.send({text},'large');assert.equal(sent.length,3);assert.equal(sent[1].client_id,sent[2].client_id);assert.equal(sent[0].item_list[0].text_item.text+sent[2].item_list[0].text_item.text,text);
 }finally{await f.close();}
});
test('forgetting does not recreate old replies; disconnect purges credentials and stops pending delivery',async()=>{
 const f=fixture();try{const a=f.weixin.account();f.weixin.receive(msg('10'),a);f.weixin.save(a);await f.weixin.processInbox();f.store.purgeDerived();await f.weixin.processInbox();assert.equal(f.store.messages().filter(x=>x.status==='pending').length,0);
 await f.weixin.disconnect();assert.equal(f.weixin.account(),null);assert.equal(f.weixin.ready(),false);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM weixin_private').get().n,0);
 }finally{await f.close();}
});
test('weixin reminder delivery honors quiet hours and expiration',async()=>{
 const f=fixture();try{f.service.clock=()=>dateMinute('2026-09-19','23:00');const now=f.service.clock();let sends=0;const scheduler=new Scheduler(f.service,{weixinReady:()=>true,sendWeixin:async()=>{sends++;}});
 f.store.enqueue('weixin:quiet',now,now+600,{kind:'reminder',text:'later'},'weixin');f.store.enqueue('weixin:old',now-60,now-1,{kind:'reminder',text:'old'},'weixin');await scheduler.deliver();assert.equal(sends,0);assert.equal(f.store.db.prepare("SELECT status FROM outbox WHERE id='weixin:old'").get().status,'expired');
 }finally{await f.close();}
});

test('image protocol encrypts real PNG, sends ordered bubbles, retries only failed parts',async()=>{
 const sent=[],uploads=[];let latestUpload,fail=true;
 const f=fixture(async(url,o)=>{
  if(url.includes('/getuploadurl')){latestUpload=JSON.parse(o.body);uploads.push(latestUpload);return response({upload_param:'upload-token'});}
  if(url.startsWith('https://novac2c.cdn.weixin.qq.com/')){
   assert.equal(o.headers.Authorization,undefined);assert.equal(o.redirect,'error');
   const decipher=createDecipheriv('aes-128-ecb',Buffer.from(latestUpload.aeskey,'hex'),null),plain=Buffer.concat([decipher.update(o.body),decipher.final()]);
   assert.deepEqual(plain,readFileSync(new URL('../public/stickers/emoji_u1f440.png',import.meta.url)));
   return new Response('',{headers:{'x-encrypted-param':'download-token'}});
  }
  const data=JSON.parse(o.body);sent.push(data.msg);
  if(data.msg.item_list[0].type===2&&fail){fail=false;return response({ret:1});}return response({});
 });try{
  const payload={text:'文字与表情',messages:[{type:'text',text:'等等🙂'},{type:'sticker',id:'eyes'},{type:'text',text:'看这边'}]};
  await assert.rejects(f.weixin.send(payload,'chain'));await f.weixin.send(payload,'chain');
  assert.deepEqual(sent.map(s=>s.item_list[0].type),[1,2,2,1]);assert.equal(sent[1].client_id,sent[2].client_id);
  assert.equal(sent[0].item_list[0].text_item.text,'等等🙂');
  assert.equal(Buffer.from(sent[2].item_list[0].image_item.media.aes_key,'base64').toString(),uploads.at(-1).aeskey);
 }finally{await f.close();}
});
test('pause during image upload cancels remaining chain without rescheduling it',async()=>{
 let sent=0;const f=fixture(async(url,o)=>{
  if(url.includes('/getuploadurl'))return response({upload_param:'upload'});
  if(url.startsWith('https://novac2c.cdn.weixin.qq.com/')){f.service.command('agency.settings',{enabled:false});return new Response('',{headers:{'x-encrypted-param':'image'}});}
  sent++;return response({});
 });try{
  f.store.enqueue('weixin:proactive:pause',at,at+60,{kind:'proactive',text:'表情',messages:[{type:'sticker',id:'eyes'},{type:'text',text:'不应发出'}],agencyEpoch:f.service.state().agency.epoch,policyVersion:4},'weixin');
  await new Scheduler(f.service,{weixinReady:()=>true,sendWeixin:(p,k)=>f.weixin.send(p,k)}).deliver();
  assert.equal(sent,0);assert.equal(f.store.messages()[0].status,'cancelled');
 }finally{await f.close();}
});
test('media credentials cannot be uploaded to an arbitrary CDN',()=>{
 for(const u of ['http://novac2c.cdn.weixin.qq.com/x','https://novac2c.cdn.weixin.qq.com.evil.test/x','https://user:secret@novac2c.cdn.weixin.qq.com/x','https://127.0.0.1/x'])assert.throws(()=>trustedCdn(u));
});
