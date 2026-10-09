import {characterVoice} from './character-voice.mjs';
import {conversationPolicy} from './conversation.mjs';
import {characterName} from './character-card.mjs';
export class Advisor{
  constructor(models){this.models=models;this.pending=new Map();}
  async suggest({kind='none',message,context,requestId}){
    if(kind==='none')return {status:'not_needed',text:'',sources:[]};
    const c=this.models.config();if(!c.openaiEnabled||!c.openaiKey)return {status:'unavailable',text:'',sources:[],note:kind==='research'?'OpenAI 资料顾问未连接，这次没有联网检索。':'OpenAI 顾问未连接，由 DeepSeek 独立回应。'};
    const key=requestId+':'+kind;if(this.pending.has(key))return this.pending.get(key);
    const work=(async()=>{try{
      if(kind==='research'){const result=await this.models.research(message);return {...result,status:'used',kind};}
      const compact={relationship:context.persona.stage,address:context.persona.stable.address,mood:context.persona.emotions,innerIntent:context.persona.inner?.intent,conflicts:context.persona.conflicts.slice(-2),memories:context.memories?.slice(-4),tasks:context.tasks?.slice(0,3).map(t=>({title:t.title,remaining:t.remaining,deadline:t.deadline})),recent:context.recent?.slice(-4),situation:kind==='proactive'?'角色想主动分享兴趣，可建议保持安静':'用户正在和角色说话'};
      const result=await this.models.complete([{role:'system',content:'你只给 DeepSeek 少量回应建议，不扮演'+characterName+'直接回答，不提出工具命令或新增事实。用不超过180个中文字符说明这句话的交际目的、先回应什么、适合的口气、是否应当停在这里。不要写完整回话范本，不把聊天变成服务邀请。参考规则：'+conversationPolicy+'\n'+characterVoice},{role:'user',content:JSON.stringify({message:String(message).slice(0,2000),context:compact})}],{provider:'openai',maxOutput:1536,purpose:'advisor',thinking:'fast'});
      return {status:'used',kind,text:result.text.slice(0,800),sources:[]};
    }catch(e){return {status:'unavailable',text:'',sources:[],note:e.message};}finally{this.pending.delete(key);}})();this.pending.set(key,work);return work;
  }
}
