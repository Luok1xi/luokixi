import {randomUUID} from 'node:crypto';
import {dateKey,clockText} from './time.mjs';
import {isQuiet} from './reminders.mjs';
import {selfState} from './self-state.mjs';
import {clip} from './research-tools.mjs';

// Self-directed study: she picks a real open question, goal or interest and learns it with the same
// read-only research agent used in chat. Only quote-verified findings are kept as knowledge.
export const ensureSelfStudy=s=>s.selfStudy??={epoch:0,attempts:[],knowledge:[]};
export class SelfStudy{
  constructor(service,models,agent,{dailyLimit=3,cooldown=120,budget=.15}={}){Object.assign(this,{service,models,agent,dailyLimit,cooldown,budget,running:false});}
  topics(s=this.service.state()){
    const learned=new Set(ensureSelfStudy(s).knowledge.filter(k=>k.origin!=='interest').map(k=>k.topic));
    const questions=[...s.study.sessions.filter(x=>x.status==='done'),...s.webLife.notes].filter(x=>x.question?.trim()&&!x.followedUpAt).slice(-3).map(x=>({topic:clip(x.question,120),origin:'question',parentId:x.id}));
    const goals=(s.research?.goals||[]).filter(g=>g.active).slice(-3).map(g=>({topic:clip(g.title,120),origin:'goal'}));
    const interests=(s.agency?.interests?.study||[]).map(t=>({topic:t,origin:'interest'}));
    return [...questions,...goals,...interests].filter(t=>t.topic&&!learned.has(t.topic)).slice(0,8);
  }
  due(s=this.service.state(),self=selfState(s,this.service.clock(),{usage:this.models.usage?.()})){
    const now=this.service.clock(),attempts=ensureSelfStudy(s).attempts,last=attempts.at(-1);
    return !this.running&&s.agency.enabled&&s.study.enabled&&!s.persona.paused&&!isQuiet(s.settings,now)&&clockText(now)>='08:00'&&!!(this.models.config().deepseekKey||this.models.config().modelConnected)
      &&attempts.filter(a=>dateKey(a.at)===dateKey(now)).length<this.dailyLimit&&(!last||now-last.at>=this.cooldown)
      &&self.needs.knowledge>=.4&&!(self.needs.tokens>.85)&&this.topics(s).length>0;
  }
  save(fn){this.service.store.transaction(()=>{const s=this.service.store.read();fn(ensureSelfStudy(s),s);this.service.store.save(s);});}
  async run({topic,origin='interest',parentId=null,isAllowed=()=>true}={}){
    if(this.running)return {message:'正在学习，不重复开始。'};
    if(typeof topic!=='string'||!topic.trim())throw new Error('学习题目无效。');
    const s=this.service.state(),epoch=ensureSelfStudy(s).epoch,id=randomUUID();this.running=true;
    const allowed=()=>{const current=this.service.state();return isAllowed()&&current.study.enabled&&!current.persona.paused&&ensureSelfStudy(current).epoch===epoch;};
    this.save(st=>{st.attempts=st.attempts.slice(-59).concat({id,at:this.service.clock(),topic,origin,status:'studying'});});
    try{
      const before=ensureSelfStudy(s).knowledge.filter(k=>k.topic===topic).slice(-3).map(k=>clip(k.summary,80));
      const r=await this.agent.run({task:`为自己学习（不是回答别人）：${topic}。挑一个具体、你还没弄懂的点，找 2—3 个可靠来源读原文，弄懂后提交：answer 用自己的话讲清楚学到了什么，findings 每条附原文逐字引文，followups 写一个还想继续弄清的问题。`+(before.length?'之前学过这些，换个角度或往深一点：'+before.join('；'):''),mode:'quick',budget:this.budget,purpose:'learning-agent'});
      if(!allowed())return {message:'学习已暂停或清理，结果未采用。'};
      const points=r.findings.filter(f=>f.verified).map(({claim,sources,quote})=>({claim,sources,quote}));
      if(!points.length)throw new Error('没有核实到原文依据，这次不算学会。');
      const used=new Set(points.flatMap(p=>p.sources));
      const entry={id,at:this.service.clock(),topic,origin,summary:clip(r.answer,700),points:points.slice(0,6),sources:r.sources.filter(x=>used.has(x.ref)),question:clip(r.followups?.[0]||'',200),confidence:r.confidence};
      this.save((st,current)=>{st.knowledge=st.knowledge.slice(-59).concat(entry);Object.assign(st.attempts.find(a=>a.id===id)||{},{status:'done',result:'学会了：'+clip(entry.summary,60)});
        const parent=parentId&&[...current.webLife.notes,...current.study.sessions].find(n=>n.id===parentId);if(parent)parent.followedUpAt=entry.at;
        current.persona.emotions.proud=Math.min(1,current.persona.emotions.proud+.06);});
      return {message:'学懂了一点：'+topic,entry};
    }catch(e){
      this.save((st,current)=>{const row=st.attempts.find(a=>a.id===id);if(row&&st.epoch===epoch){row.status='failed';row.result=clip(e.message,300);current.persona.emotions.sad=Math.min(1,current.persona.emotions.sad+.04);}});
      return {message:'这次没学成：'+e.message};
    }finally{this.save(st=>{const row=st.attempts.find(a=>a.id===id);if(row?.status==='studying'){row.status='cancelled';row.result='完成前被暂停。';}});this.running=false;}
  }
}
