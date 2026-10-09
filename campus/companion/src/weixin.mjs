import {downloadWeixinImage} from './vision.mjs';
import {uploadSticker} from './weixin-media.mjs';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import QRCode from 'qrcode';
import {InboxBurst} from './inbox-burst.mjs';
import {characterName} from './character-card.mjs';

// Independent text/image adapter implementing Tencent's documented iLink protocol.
// Reference and scope: WECHAT-GUIDE.md. No OpenClaw agent or third-party relay is involved.
export const WEIXIN_BASE='https://ilinkai.weixin.qq.com';
export function trustedWeixinBase(value){
  const u=new URL(value);
  if(u.protocol!=='https:'||u.username||u.password||u.port||u.search||u.hash||u.pathname!=='/'||
    !/^(?:[a-z0-9-]+\.)*ilinkai\.weixin\.qq\.com$/i.test(u.hostname))throw new Error('微信返回了尚未支持的服务地址，未发送登录凭证。');
  return u.origin;
}
export function parseWeixinJson(text){return JSON.parse(text,(key,value,context)=>
  ['message_id','msg_id','svr_id'].includes(key)&&typeof value==='number'?context.source:value);}
const safeString=(value,max=4096)=>typeof value==='string'&&value.length>0&&value.length<=max;

export class Weixin{
  constructor(service,chat,{fetcher=fetch,burstOptions={}}={}){
    this.service=service;this.chat=chat;this.db=service.store.db;this.fetcher=fetcher;
    this.burst=new InboxBurst(service.store,burstOptions);
    this.db.exec('CREATE TABLE IF NOT EXISTS weixin_private (key TEXT PRIMARY KEY,json TEXT NOT NULL)');
    this.status='未连接微信';this.login=null;this.inflight=null;this.loop=null;this.controller=null;this.closed=false;
  }
  account(){const row=this.db.prepare("SELECT json FROM weixin_private WHERE key='account'").get();return row?JSON.parse(row.json):null;}
  save(account){this.db.prepare("INSERT INTO weixin_private VALUES('account',?) ON CONFLICT(key) DO UPDATE SET json=excluded.json").run(JSON.stringify(account));}
  enabled(){const a=this.account();return !!(a?.enabled&&a.token);}
  ready(){const a=this.account();return !!(a?.enabled&&a.token&&a.contextToken&&!a.authExpired&&!a.contextExpired);}
  info(){if(this.closed)return {status:'服务已关闭',paired:false,enabled:false,ready:false};const a=this.account();return {status:this.status,paired:!!a?.token,enabled:!!a?.enabled,ready:this.ready(),
    account:a?.user?`${a.user.slice(0,3)}…${a.user.slice(-4)}`:null,lastReceivedAt:a?.lastReceivedAt||null,
    loginStatus:this.login?.status||null,loginExpires:this.login?.expires||null,
    login:this.login&&Date.now()<this.login.expires?{id:this.login.id,image:this.login.image,expires:this.login.expires}:null,
    supports:['文字与图片私聊','连续文字与表情图片发送','共享记忆与日程','有有效会话时发送提醒'],pending:this.db.prepare("SELECT COUNT(*) n FROM outbox WHERE channel='weixin' AND status='pending'").get().n};}
  async request(path,{account=null,base=account?.base||WEIXIN_BASE,data,signal,timeout=45000}={}){
    base=trustedWeixinBase(base);const headers={'iLink-App-Id':'bot','iLink-App-ClientVersion':String(0x020408)};
    if(data!==undefined){headers['Content-Type']='application/json';headers.AuthorizationType='ilink_bot_token';headers['X-WECHAT-UIN']=Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64');}
    if(account){headers.Authorization=`Bearer ${account.token}`;data={...data,base_info:{channel_version:'2.4.8',bot_agent:'Miku/0.1.0'}};}
    let res;try{res=await this.fetcher(base+'/'+path,{method:data===undefined?'GET':'POST',headers,body:data===undefined?undefined:JSON.stringify(data),redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(timeout)]):AbortSignal.timeout(timeout)});}catch(e){
      if(signal?.aborted)throw e;if(e.name==='TimeoutError')throw e;throw new Error('微信网络连接失败，请检查网络后重试。');
    }
    if(!res.ok)throw new Error(`微信接口返回 HTTP ${res.status}。`);
    // Bound the streamed body, and never expose server errors containing credentials.
    let bytes=0,parts=[];for await(const part of res.body){bytes+=part.length;if(bytes>2*1024*1024)throw new Error('微信响应过大。');parts.push(part);}
    const out=parseWeixinJson(Buffer.concat(parts).toString('utf8'));
    if(!out||typeof out!=='object'||Array.isArray(out))throw new Error('微信响应格式无效。');
    const code=[out.ret,out.errcode].find(v=>v!==undefined&&v!==0);
    if(code!==undefined){const error=new Error(code===-14?'微信授权已失效，请重新扫码。':code===-2?'微信会话凭证已失效，请在微信给 '+characterName+' 发一条新消息。':`微信接口未成功（代码 ${Number(code)||'未知'}）。`);error.code=code;throw error;}
    return out;
  }
  async startLogin(){
    if(this.loginBusy)throw new Error('二维码正在生成，请稍候。');this.loginBusy=true;
    try{const data=await this.request('ilink/bot/get_bot_qrcode?bot_type=3',{data:{local_token_list:[]}});
      if(!safeString(data.qrcode)||!safeString(data.qrcode_img_content,8192))throw new Error('微信没有返回可用二维码。');
      const target=new URL(data.qrcode_img_content);if(target.protocol!=='https:'||!/(^|\.)weixin\.qq\.com$/.test(target.hostname))throw new Error('二维码地址无法核验。');
      const login={id:randomUUID(),qrcode:data.qrcode,status:'wait',base:WEIXIN_BASE,expires:Date.now()+5*60e3,redirects:0};
      login.image=await QRCode.toDataURL(data.qrcode_img_content,{width:280,margin:2});this.login=login;this.status='请用你自己的手机微信扫码并确认';
      return {id:login.id,expires:login.expires,image:login.image,message:this.status};
    }finally{this.loginBusy=false;}
  }
  async pollLogin(id,verifyCode){
    const login=this.login;if(!login||login.id!==id)throw new Error('请重新生成二维码。');
    if(Date.now()>login.expires){login.status='expired';this.status='二维码已过期，请重新生成';return this.info();}
    if(login.polling)return this.info();
    if(verifyCode!==undefined&&!/^\d{4,12}$/.test(verifyCode))throw new Error('请输入手机显示的数字验证码。');
    login.polling=true;
    try{const out=await this.request('ilink/bot/get_qrcode_status?qrcode='+encodeURIComponent(login.qrcode)+(verifyCode?'&verify_code='+encodeURIComponent(verifyCode):''),{base:login.base,timeout:40000});
      if(this.login!==login||this.closed)return this.info();login.status=out.status;
      if(out.status==='scaned_but_redirect'){if(++login.redirects>3)throw new Error('微信登录重定向过多，请重新扫码。');login.base=trustedWeixinBase('https://'+out.redirect_host);}
      else if(out.status==='confirmed'){
        if(!safeString(out.bot_token)||!safeString(out.ilink_bot_id,300)||!safeString(out.ilink_user_id,300))throw new Error('微信未返回完整的账号信息，请重新扫码。');
        const base=trustedWeixinBase(out.baseurl||login.base);await this.stopPolling();
        await this.chat.exclusive(()=>this.service.store.transaction(()=>{
          this.db.exec("UPDATE outbox SET status='cancelled' WHERE channel='weixin' AND status IN ('pending','sending'); UPDATE inbox SET status='expired' WHERE id LIKE 'weixin:%' AND status='pending'");
          this.save({token:out.bot_token,bot:out.ilink_bot_id,user:out.ilink_user_id,base,enabled:true,epoch:randomUUID(),cursor:'',contextToken:null});
          // Recreate future schedule notifications for this binding; never revive old replies.
          this.db.prepare("DELETE FROM outbox WHERE channel='weixin' AND status='cancelled' AND due>? AND id NOT LIKE '%:reply:%' AND id NOT LIKE '%:proactive:%' AND id NOT LIKE '%:digest:%'").run(this.service.clock());
          this.service.syncReminders(this.service.store.read(),this.service.clock());
        }));
        this.login=null;this.status='微信已授权，请先在微信发一条消息';this.connect();
      }else if(out.status==='need_verifycode')this.status='请填写手机微信显示的配对验证码';
      else if(out.status==='scaned')this.status='已扫码，请在手机微信确认';
      else if(out.status==='expired'||out.status==='verify_code_blocked')this.status='二维码已失效，请重新生成';
      else if(out.status==='binded_redirect'){this.login=null;this.status=this.account()?'微信已绑定，正在恢复连接':'微信提示已绑定，但本机没有凭证；请在手机解除旧绑定后重试';if(this.account())this.connect();}
      return this.info();
    }catch(e){if(e.name==='TimeoutError')return this.info();throw e;}finally{login.polling=false;}
  }
  connect(){if(this.loop||this.closed||!this.enabled())return;const controller=new AbortController();this.controller=controller;
    this.loop=this.monitor(controller.signal).finally(()=>{this.loop=null;});
  }
  async monitor(signal){let failures=0;while(!signal.aborted&&this.enabled()){
    try{const a=this.account();if(a.authExpired)return;await this.pollOnce(signal);failures=0;
      await delay(1200,null,{signal});
    }catch(e){if(signal.aborted)return;if(e.name==='TimeoutError')continue;
      this.status=e.message;const a=this.account();if(e.code===-14){if(a){a.authExpired=true;this.save(a);}return;}
      try{await delay(Math.min(60000,2000*2**Math.min(failures++,5)),null,{signal});}catch{return;}
    }
  }}
  async pollOnce(signal){const account=this.account();if(!account?.enabled)return;
    const out=await this.request('ilink/bot/getupdates',{account,data:{get_updates_buf:account.cursor||''},signal});
    if(signal?.aborted||this.account()?.epoch!==account.epoch)return;
    this.service.store.transaction(()=>{
      const current=this.account();for(const msg of Array.isArray(out.msgs)?out.msgs:[])this.receive(msg,current);
      if(safeString(out.get_updates_buf,512000))current.cursor=out.get_updates_buf;this.save(current);
    });
    this.status=this.ready()?'微信已连接':'微信已授权，等待你发一条新消息';
    void this.processInbox();
  }
  receive(msg,a){
    if(!msg||msg.message_type!==1||msg.group_id||msg.from_user_id!==a.user||(msg.to_user_id&&msg.to_user_id!==a.bot)||!Array.isArray(msg.item_list)||msg.message_state===1)return;
    if(!safeString(String(msg.message_id??''),100)||!/^\d+$/.test(String(msg.message_id)))return;
    const now=this.service.clock(),at=Math.floor(Number(msg.create_time_ms)/60000);if(!Number.isFinite(at)||at>now+5||at<=now-120)return;
    const key=`weixin:${a.epoch}:${msg.message_id}`;
    if(this.db.prepare('SELECT 1 FROM inbox WHERE id=?').get(key))return;
    if(safeString(msg.context_token,16384)){a.contextToken=msg.context_token;a.contextExpired=false;}
    a.lastReceivedAt=now;
    const parts=msg.item_list.filter(x=>x.type===1&&typeof x.text_item?.text==='string').map(x=>x.text_item.text);
    const images=msg.item_list.filter(x=>x.type===2&&x.image_item?.media).map(x=>x.image_item);const content=parts.join('\n').trim()||(images.length?'看看这张图片':'');const unsupported=msg.item_list.some(x=>![1,2].includes(x.type)||x.type===2&&!x.image_item?.media)||images.length>1||!content||content.length>8000;
    if(unsupported){this.db.prepare("INSERT OR IGNORE INTO inbox(id,text,at,status,response) VALUES(?,?,?,'done',?)").run(key,'[非文字或过长消息]',at,JSON.stringify({text:'目前支持 8000 字以内的文字或单张图片；视频、语音和文件尚未接通。'}));return;}
    this.db.prepare('INSERT OR IGNORE INTO inbox(id,text,at) VALUES(?,?,?)').run(key,content,at);
    this.burst.received(key);
    if(images.length)this.db.prepare('INSERT OR REPLACE INTO weixin_private VALUES(?,?)').run('inbound-media:'+key,JSON.stringify(images[0]));
  }
  processInbox(){if(this.inflight||this.closed||!this.enabled())return this.inflight||Promise.resolve();
    this.inflight=this.processOne().catch(()=>{this.status='微信消息处理失败，请查看电脑端状态';}).finally(()=>{this.inflight=null;});return this.inflight;
  }
  async processOne(){
    const a=this.account(),prefix=`weixin:${a.epoch}:%`;
    const allowed=()=>!this.closed&&this.account()?.epoch===a.epoch&&this.enabled();
    const queueDone=()=>{const now=this.service.clock();for(const row of this.db.prepare("SELECT * FROM inbox WHERE id LIKE ? AND status='done' AND at>? AND NOT EXISTS (SELECT 1 FROM outbox WHERE id='weixin:reply:'||inbox.id)").all(prefix,now-120)){
      if(row.text.startsWith('sha256:'))continue;const result=row.response?JSON.parse(row.response):{};
      if(result.text)this.service.store.enqueue('weixin:reply:'+row.id,now,row.at+120,{kind:'reply',text:result.text,messages:result.messages,epoch:a.epoch,replyScope:result.replyScope,replySeq:result.replySeq},'weixin');
    }};
    queueDone();this.db.prepare("UPDATE inbox SET status='expired' WHERE id LIKE ? AND status='pending' AND at<=?").run(prefix,this.service.clock()-120);
    for(let turn=0;turn<4&&allowed();turn++){
      if(!this.db.prepare("SELECT 1 FROM inbox WHERE id LIKE ? AND status='pending' LIMIT 1").get(prefix))return;
      await this.burst.settle(prefix,allowed);if(!allowed())return;
      const batch=this.burst.claim(prefix,{media:id=>!!this.db.prepare('SELECT 1 FROM weixin_private WHERE key=?').get('inbound-media:'+id)});if(!batch)return;const {row}=batch;
      try{
        const media=this.db.prepare('SELECT json FROM weixin_private WHERE key=?').get('inbound-media:'+row.id);
        const imageBuffer=media?await downloadWeixinImage(JSON.parse(media.json),this.fetcher):null;
        if(!allowed()||this.db.prepare('SELECT status FROM inbox WHERE id=?').get(row.id)?.status!=='pending')return;
        const result=await this.chat.run(row.text,{requestId:row.id,source:'weixin',imageBuffer,isCurrent:()=>allowed()&&this.burst.current(prefix,batch),replyScope:prefix,replySeq:batch.seq});
        if(result.superseded&&!result.applied){this.burst.retry(batch);continue;}
        this.db.prepare('DELETE FROM weixin_private WHERE key=?').run('inbound-media:'+row.id);if(allowed())queueDone();
      }catch{
        this.db.prepare('DELETE FROM weixin_private WHERE key=?').run('inbound-media:'+row.id);
        this.status='微信消息处理失败；请检查图片格式、模型余额或网络后重新发送';
        this.db.prepare("UPDATE inbox SET status='failed' WHERE id=?").run(row.id);
        if(allowed()&&this.burst.current(prefix,batch))this.service.store.enqueue('weixin:reply:'+row.id,this.service.clock(),this.service.clock()+120,{kind:'reply',text:'这次没有处理成功。请在电脑端检查模型连接与预算，再重新发送。',epoch:a.epoch,replyScope:prefix,replySeq:batch.seq},'weixin');
      }
    }
  }
  async send(payload,key){const a=this.account();if(!this.ready())throw new Error('微信尚无有效会话，请先在微信发一条消息。');if(payload.epoch&&payload.epoch!==a.epoch)throw new Error('这条消息属于旧的微信绑定。');
    if(typeof payload.text!=='string'||!payload.text.trim())throw new Error('微信消息为空。');
    // Keep model wording intact; chunk only at Unicode code points for transport limits.
    const chunks=[];for(const part of payload.messages||[{type:'text',text:payload.text}]){if(part.type==='sticker'){chunks.push(part);continue;}const chars=Array.from(part.text);for(let i=0;i<chars.length;i+=1800)chunks.push({type:'text',text:chars.slice(i,i+1800).join('')});}
    const check=()=>{
      if(!this.ready()||this.account()?.epoch!==a.epoch)throw new Error('微信绑定已变化，停止发送。');
      if(payload.replySeq!==undefined&&this.burst.latest(payload.replyScope)!==payload.replySeq){this.db.prepare("UPDATE outbox SET status='cancelled' WHERE id=?").run(key);throw new Error('收到了后续消息，停止发送旧回复。');}
      if(payload.socialSourceId&&!this.social?.valid(payload)){this.db.prepare("UPDATE outbox SET status='cancelled' WHERE id=?").run(key);throw new Error('聊天来源或读取权限已变化，停止发送。');}
      if(payload.kind==='proactive'&&(this.db.prepare("SELECT 1 FROM inbox WHERE status='pending' AND id LIKE 'weixin:%' LIMIT 1").get()||payload.conversationId!==undefined&&payload.conversationId!==this.db.prepare("SELECT MAX(id) id FROM chat WHERE role='user'").get().id)){this.db.prepare("UPDATE outbox SET status='cancelled' WHERE id=?").run(key);throw new Error('对方继续说话了，停止余下主动消息。');}
      const queued=this.db.prepare('SELECT status FROM outbox WHERE id=?').get(key);if(queued&&queued.status!=='sending')throw new Error('这组消息已取消。');
      if(payload.agencyEpoch!==undefined){const state=this.service.store.read();if(!state.agency.enabled||state.agency.epoch!==payload.agencyEpoch||(payload.researchEpoch!==undefined&&(!state.research.enabled||state.research.epoch!==payload.researchEpoch||state.research.items.find(n=>n.id===payload.researchItemId)?.discussedAt))||(payload.webNoteId&&state.webLife.notes.find(n=>n.id===payload.webNoteId)?.discussedAt))throw new Error('对话或主动设置已变化，停止余下消息。');}
    };
    for(const [index,part] of chunks.entries()){
      const partKey=`sent:${a.epoch}:${key}:${index}`;if(this.db.prepare('SELECT 1 FROM weixin_private WHERE key=?').get(partKey))continue;
      if(index&&payload.messages)await delay(450);check();
      const clientId='miku-'+createHash('sha256').update(partKey).digest('hex').slice(0,32);
      try{const item=part.type==='sticker'?await uploadSticker(this,a,part.id):{type:1,text_item:{text:part.text}};check();await this.request('ilink/bot/sendmessage',{account:a,data:{msg:{from_user_id:'',to_user_id:a.user,client_id:clientId,message_type:2,message_state:2,context_token:this.account().contextToken,item_list:[item]}}});
        // Tencent's official client accepts HTTP-success JSON without a ret field.
        // request() has already rejected any nonzero ret/errcode. Requiring ret===0
        // here incorrectly retried accepted sends (commonly an empty JSON response).
        this.db.prepare('INSERT OR IGNORE INTO weixin_private VALUES(?,?)').run(partKey,JSON.stringify({at:this.service.clock()}));
      }catch(e){const current=this.account();if(current?.epoch===a.epoch&&(e.code===-2||e.code===-14)){current.contextExpired=e.code===-2;current.authExpired=e.code===-14;this.save(current);}this.status=e.message;throw e;}
    }return createHash('sha256').update(key).digest('hex').slice(0,32);
  }
  async stopPolling(){this.controller?.abort();await this.loop;this.controller=null;}
  async disconnect(){this.login=null;await this.stopPolling();await this.inflight;await this.chat.exclusive(()=>{
    this.db.exec("DELETE FROM weixin_private; UPDATE outbox SET status='cancelled' WHERE channel='weixin' AND status IN ('pending','sending'); UPDATE inbox SET status='expired' WHERE id LIKE 'weixin:%' AND status='pending'");
  });this.status='已断开微信并删除本机登录凭证';}
  async close(){this.closed=true;this.login=null;await this.stopPolling();await this.inflight;}
}
