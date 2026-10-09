import {randomUUID} from 'node:crypto';
// Provider adapter only. Intent, emotion, memory, learning and tools are the original runtime.
export class CodexModels {
  constructor(rpc,config){this.rpc=rpc;this.readConfig=config;this.rows=[];this.conversationDraft=true;}
  config(){return {...this.readConfig(),modelConnected:true,deepseekKey:'',deepseekModel:'codex-cli',openaiEnabled:false};}
  usage(){return {provider:'codex',limit:this.config().monthlyLimit,spent:0,rows:this.rows.slice(-100),accounting:'Shared studio call counter; no API currency charge is invented.'};}
  async request(messages,options,kind){
    const start=Date.now(),id=randomUUID();
    const result=await this.rpc({op:'codex-model',id,messages,kind,tools:options.tools||[],json:options.json===true,purpose:options.purpose||'dialogue',
      thinking:options.deep===true?'deep':options.thinking});
    this.rows.push({id,provider:'codex',at:Math.floor(Date.now()/60000),purpose:options.purpose||'dialogue',cost:0,reserved:0});
    this.rows=this.rows.slice(-500);
    const common={provider:'codex',model:result.model,usage:result.usage||{},cost:0,latencyMs:Date.now()-start};
    if(kind==='chat')return {...common,message:result.message,finish:result.message.tool_calls?.length?'tool_calls':'stop'};
    if(options.stream&&options.onDelta)options.onDelta(result.text);
    return {...common,text:result.text};
  }
  complete(messages,options={}){return this.request(messages,options,'complete');}
  chat(messages,options={}){return this.request(messages,options,'chat');}
  research(){throw new Error('OpenAI 付费顾问未配置；请使用已接入的原版网页和论文工具。');}
}
