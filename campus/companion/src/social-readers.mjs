import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {stamp} from './time.mjs';
const exec=promisify(execFile);

export class WechatReader{
  constructor(root){this.root=root;this.offset=0;}
  async scan(){
    try{const {stdout}=await exec(resolve(this.root,'tools/wechat-reader/.venv/Scripts/python.exe'),[resolve(this.root,'tools/wechat-reader/read.py'),'--offset',String(this.offset)],{windowsHide:true,timeout:45000,maxBuffer:512000,env:{...process.env,PYTHONIOENCODING:'utf-8'}});this.offset+=2;return JSON.parse(stdout);}
    catch{return {status:'blocked',detail:'微信读取组件不可用或超时，未读取到聊天。',threads:[]};}
  }
}

export class QQReader{
  constructor(root,{fetcher=fetch}={}){this.root=root;this.fetcher=fetcher;this.seen=new Map();this.offset=0;}
  reset(){this.seen.clear();}
  ack(threads){for(const t of threads)if(t.cursor)this.seen.set(t.cursor.key,t.cursor.value);}
  async call(action,params={}){
    if(!['get_login_info','get_recent_contact','get_friend_msg_history','get_group_msg_history'].includes(action))throw Error('只允许读取 QQ 消息。');
    const config=JSON.parse((await readFile(resolve(this.root,'data/social-qq-private.json'),'utf8')).replace(/^\uFEFF/,''));
    if(config.endpoint!=='http://127.0.0.1:17841'||typeof config.token!=='string'||!config.token)throw Error('QQ 本机连接配置无效。');
    const response=await this.fetcher(config.endpoint+'/'+action,{method:'POST',redirect:'error',headers:{Authorization:'Bearer '+config.token,'Content-Type':'application/json'},body:JSON.stringify(params),signal:AbortSignal.timeout(12000)});
    if(!response.ok)throw Error('QQ 读取接口暂不可用。');
    const body=await response.text();if(body.length>2000000)throw Error('QQ 返回内容超出读取上限。');
    const result=JSON.parse(body);if(result.retcode!==0||result.status==='failed')throw Error('QQ 尚未登录或读取接口拒绝请求。');return result.data;
  }
  async scan(){
    try{
      await this.call('get_login_info');const contacts=await this.call('get_recent_contact',{count:50});
      if(!Array.isArray(contacts))throw Error('QQ 会话返回格式无效。');
      const changed=contacts.filter(c=>['1','2'].includes(String(c.chatType))&&this.seen.get(String(c.chatType)+':'+c.peerUin)!==String(c.msgId));
      const offset=changed.length?this.offset%changed.length:0,chosen=[...changed.slice(offset),...changed.slice(0,offset)].slice(0,3),threads=[];let partial=0;this.offset+=3;
      for(const c of chosen){
        const group=String(c.chatType)==='2',remote=(group?'group:':'private:')+c.peerUin;
        if(!/^\d+$/.test(String(c.peerUin)))continue;
        let data,historyFailed=false;
        try{data=await this.call(group?'get_group_msg_history':'get_friend_msg_history',{[group?'group_id':'user_id']:String(c.peerUin),count:40,disable_get_url:true,parse_mult_msg:false});}
        catch{partial++;historyFailed=true;data={messages:c.lastestMsg?[c.lastestMsg]:[]};}
        if(!Array.isArray(data?.messages))throw Error('QQ 消息返回格式无效。');
        let size=0;const messages=[];
        for(const m of data.messages.slice(-40)){
          const text=Array.isArray(m.message)?m.message.map(p=>p.type==='text'?p.data?.text||'':p.type==='at'?'@'+p.data?.qq:'['+String(p.type).slice(0,30)+'，未读取内容]').join(''):String(m.raw_message||'');
          if(!text.trim()||text.length>8000||size+text.length>16000)continue;size+=text.length;
          const at=Number(m.time),id=m.message_id;if(id==null||typeof id==='number'&&!Number.isSafeInteger(id))continue;
          messages.push({id:String(id),sender:String(m.sender?.card||m.sender?.nickname||m.user_id||'未知发送人').slice(0,100),text,at:Number.isFinite(at)&&at>0?stamp(Math.floor(at/60)):null});
        }
        threads.push({remote,title:String(c.remark||c.peerName||remote).slice(0,100),kind:group?'competition':'personal',messages,cursor:historyFailed?null:{key:String(c.chatType)+':'+c.peerUin,value:String(c.msgId)}});
      }
      return {status:partial?'partial':'ready',detail:'已读取近期会话并按变化增量获取文字；每轮最多3个会话、每段40条，不代表完整历史。'+(partial?partial+' 个会话历史暂不可用，仅保留接口返回的最近消息。':''),threads};
    }catch{return {status:'blocked',detail:'QQ 读取服务尚未登录或不可达；请在本机 QQ 采集登录页完成扫码。',threads:[]};}
  }
}
