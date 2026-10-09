import {createHash,randomInt} from 'node:crypto';
import {readConfig,saveConfig} from './config.mjs';
import {InboxBurst} from './inbox-burst.mjs';
import {characterName} from './character-card.mjs';
import {setTimeout as delay} from 'node:timers/promises';
export class Feishu{
  constructor(service,chat){this.service=service;this.chat=chat;this.burst=new InboxBurst(service.store);this.client=null;this.ws=null;this.pairing=null;this.status='未连接';this.inboundRunning=false;}
  pairingCode(){this.pairing={code:String(randomInt(100000,1000000)),expires:Date.now()+10*60e3,attempts:0};return {code:this.pairing.code,expires:this.pairing.expires};}
  async connect(){await this.close();this.closed=false;const c=readConfig();if(!c.feishuEnabled||!c.feishuAppId||!c.feishuAppSecret){this.status='未配置';return;}
    const lark=await import('@larksuiteoapi/node-sdk');this.client=new lark.Client({appId:c.feishuAppId,appSecret:c.feishuAppSecret,loggerLevel:lark.LoggerLevel.error});
    const dispatcher=new lark.EventDispatcher({}).register({'im.message.receive_v1':data=>this.receive(data),'card.action.trigger':data=>this.card(data)});
    this.ws=new lark.WSClient({appId:c.feishuAppId,appSecret:c.feishuAppSecret,loggerLevel:lark.LoggerLevel.error});this.status='正在建立长连接';
    await this.ws.start({eventDispatcher:dispatcher});this.status='已启动长连接，请在飞书完成事件配置';
  }
  async close(){this.closed=true;if(this.ws){this.ws.close({force:true});this.ws=null;}this.client=null;while(this.inboundRunning)await delay(25);}
  ready(){const c=readConfig();return !!(this.client&&c.feishuEnabled&&c.feishuUser);}
  info(){return {status:this.status,paired:!!readConfig().feishuUser,connection:this.ws?.getConnectionStatus?.()||null};}
  receive(data){const msg=data.message,uid=data.sender?.sender_id?.open_id;if(!msg||!msg.message_id||msg.chat_type!=='p2p'||msg.message_type!=='text'||!uid)return{};
    let content;try{content=JSON.parse(msg.content).text;}catch{return{};}if(typeof content!=='string'||content.length>8000)return{};
    const c=readConfig();if(uid!==c.feishuUser){if(!c.feishuUser&&this.pairing&&Date.now()<this.pairing.expires&&this.pairing.attempts<10&&content.startsWith('绑定 ')){this.pairing.attempts++;if(content.trim()==='绑定 '+this.pairing.code){saveConfig({feishuUser:uid});this.pairing=null;this.status='已绑定你的飞书账号';this.service.store.enqueue('feishu:reply:paired:'+msg.message_id,this.service.clock(),this.service.clock()+60,{kind:'reply',text:'绑定好了。我是 '+characterName+'，这里和电脑端共用同一份记忆与日程。'},'feishu');}}return{};}
    const sentAt=msg.create_time?Math.floor(Number(msg.create_time)/60000):this.service.clock();if(!Number.isFinite(sentAt)||sentAt>this.service.clock()+5||sentAt<=this.service.clock()-120)return{};
    this.service.store.db.prepare('INSERT OR IGNORE INTO inbox(id,text,at) VALUES(?,?,?)').run('feishu:'+msg.message_id,content,sentAt);this.burst.received('feishu:'+msg.message_id);return{};
  }
  card(data){const e=data.event||data;const uid=e.operator?.open_id;if(uid!==readConfig().feishuUser)return {toast:{type:'error',content:'这不是你的助手。'}};
    const value=e.action?.value;if(!value?.taskId||value.action!=='complete')return {toast:{type:'info',content:'请通过私聊修改安排。'}};
    const key='card:'+(e.token||e.context?.open_message_id||'')+':'+value.taskId;
    try{this.service.command('task.complete',{id:value.taskId},key,'feishu');return {toast:{type:'success',content:'已记录完成，计划已更新。'}};}catch{return {toast:{type:'info',content:'任务状态已变化，请查看最新安排。'}};}
  }
  async processInbox(){
    if(this.inboundRunning||this.closed)return;this.inboundRunning=true;
    try{const db=this.service.store.db,now=this.service.clock(),prefix='feishu:%';
      for(const done of db.prepare("SELECT i.* FROM inbox i WHERE i.id LIKE 'feishu:%' AND i.status='done' AND i.at>? AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.id='feishu:reply:'||i.id)").all(now-120)){
        const result=done.response?JSON.parse(done.response):{};if(result.text)this.service.store.enqueue('feishu:reply:'+done.id,now,done.at+120,{kind:'reply',text:result.text,messages:result.messages,replyScope:result.replyScope,replySeq:result.replySeq},'feishu');
      }
      db.prepare("UPDATE inbox SET status='expired' WHERE id LIKE 'feishu:%' AND status='pending' AND at<=?").run(now-120);
      for(let turn=0;turn<4&&!this.closed;turn++){
        if(!db.prepare("SELECT 1 FROM inbox WHERE id LIKE ? AND status='pending' LIMIT 1").get(prefix))return;
        await this.burst.settle(prefix,()=>!this.closed);if(this.closed)return;const batch=this.burst.claim(prefix);if(!batch)return;const {row}=batch;
        let result;
        try{result=await this.chat.run(row.text,{requestId:row.id,source:'feishu',isCurrent:()=>!this.closed&&this.burst.current(prefix,batch),replyScope:prefix,replySeq:batch.seq});
          if(result.superseded&&!result.applied){this.burst.retry(batch);continue;}
        }catch(e){result={text:'这次暂时没能处理：'+e.message};db.prepare("UPDATE inbox SET status='failed' WHERE id=?").run(row.id);}
        if(result.text&&this.burst.current(prefix,batch))this.service.store.enqueue('feishu:reply:'+row.id,this.service.clock(),row.at+120,{kind:'reply',text:result.text,messages:result.messages,replyScope:prefix,replySeq:batch.seq},'feishu');
      }
    }finally{this.inboundRunning=false;}
  }
  async send(payload,key){const c=readConfig();if(!this.ready())throw new Error('飞书未连接或未绑定。');const uuid=createHash('sha256').update(key).digest('hex').slice(0,32);
    const card={config:{wide_screen_mode:true},header:{template:'turquoise',title:{tag:'plain_text',content:payload.kind==='reply'?characterName:characterName+' · 今日陪伴'}},elements:[{tag:'div',text:{tag:'plain_text',content:payload.text.slice(0,12000)}}]};
    if(payload.taskId)card.elements.push({tag:'action',actions:[{tag:'button',text:{tag:'plain_text',content:'完成了'},type:'primary',value:{action:'complete',taskId:payload.taskId}}]});
    const res=await this.client.im.message.create({params:{receive_id_type:'open_id'},data:{receive_id:c.feishuUser,msg_type:'interactive',content:JSON.stringify(card),uuid}});
    if(res.code!==0)throw new Error(`飞书发送失败，错误码 ${res.code}`);return res.data?.message_id;
  }
}
