import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,unlinkSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {QQReader} from '../src/social-readers.mjs';
test('QQ reader isolates single-chat failures, acknowledges only saved successes and never permits send APIs',async()=>{
  const root=mkdtempSync(join(tmpdir(),'miku-social-reader-')),config=join(root,'data','social-qq-private.json');mkdirSync(join(root,'data'));writeFileSync(config,JSON.stringify({endpoint:'http://127.0.0.1:17841',token:'test-only'}));const actions=[];
  const reader=new QQReader(root,{fetcher:async(url,options)=>{const action=new URL(url).pathname.slice(1);actions.push(action);assert.equal(options.redirect,'error');let data={};
    if(action==='get_recent_contact')data=[{chatType:1,peerUin:'1',msgId:'x',peerName:'private'},{chatType:2,peerUin:'2',msgId:'y',peerName:'group'}];
    if(action==='get_friend_msg_history')return new Response(JSON.stringify({retcode:200,status:'failed'}));
    if(action==='get_group_msg_history')data={messages:[{message_id:123,time:1790452800,sender:{nickname:'sender'},message:[{type:'text',data:{text:'meeting changed'}}]}]};
    return new Response(JSON.stringify({retcode:0,status:'ok',data}));}});
  try{const first=await reader.scan();assert.equal(first.status,'partial');assert.equal(first.threads[1].messages.length,1);assert.equal(first.threads[0].cursor,null);reader.ack(first.threads);const second=await reader.scan();assert.equal(second.threads.length,1);assert.equal(second.status,'partial');assert.equal(actions.filter(x=>x==='get_group_msg_history').length,1);
    await assert.rejects(reader.call('send_group_msg',{}),/只允许读取/);assert.ok(actions.every(x=>x.startsWith('get_')));
  }finally{unlinkSync(config);rmdirSync(join(root,'data'));rmdirSync(root);}
});
