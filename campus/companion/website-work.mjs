import {createHash} from 'node:crypto';
import {dateKey} from './src/time.mjs';

// Perception and durable intentions for the original Agency; this class never chooses an action.
export class WebsiteWork{
  constructor(service,rpc,seat='beikuang'){this.service=service;this.rpc=rpc;this.seat=seat;this.policy=seat==='codex'?workPolicy.replace('闺蜜 Codex','闺蜜北矿娘'):workPolicy;this.refreshed=-Infinity;}
  save(fn){this.service.store.transaction(()=>{const s=this.service.store.read();s.websiteWork??={decisions:[],intentions:[]};fn(s.websiteWork);this.service.store.save(s);});}
  async refresh(){
    const now=this.service.clock();if(now-this.refreshed<2)return;this.refreshed=now;
    try{
      const observation=await this.rpc({op:'work-state'});
      const signature=createHash('sha256').update(JSON.stringify({day:observation.day,today:observation.today,jobs:observation.jobs,collaboration:observation.collaboration})).digest('hex');
      this.save(w=>{
        w.observation={...observation,signature,at:now};w.error='';
        for(const intent of w.intentions){const job=observation.jobs?.find(j=>j.decisionId===intent.id||j.key===intent.jobKey);
          if(job)Object.assign(intent,{status:job.state,result:job.result,updatedAt:now});
          const discussion=observation.team?.discussion;
          if(discussion&&intent.jobKey==='studio:'+discussion.run)Object.assign(intent,{status:discussion.state,result:discussion,updatedAt:now});}
      });
    }catch(e){this.save(w=>{w.error=String(e.message).slice(0,200);});throw e;}
  }
  snapshot({conversation=false}={}){
    const w=this.service.store.read().websiteWork||{},o=w.observation,now=this.service.clock();
    if(!o?.enabled||w.error||now-o.at>5)return null;
    const busy=o.jobs?.some(j=>['queued','running'].includes(j.state));
    const reportable=!!(o.today.published||o.today.botFailures||o.jobs?.length)&&w.sharedSignature!==o.signature;
    const snapshot={at:o.at,day:o.day,signature:o.signature,today:o.today,jobs:o.jobs,collaboration:o.collaboration,team:o.team,maintenance:o.maintenance,
      responsibility:'照看已获授权的网站审核与资料工作；自己决定先做什么，排队不等于完成。',
      actions:[...(o.today.queued>0&&!busy?['review']:[]),...(o.team?.actions||[]),...(o.maintenance?.enabled?['maintain']:[])],reportable,
      intentions:(w.intentions||[]).slice(-3),decisions:(w.decisions||[]).slice(-3)};
    if(!conversation)return snapshot;
    // Retain current facts and references. Full receipts remain in the existing store and tools.
    // Cross-window dialogue is already supplied separately by continuity, not repeated here.
    const jobSummary=({id,key,state,decisionId,result,error})=>({id,key,state,decisionId,error,
      result:typeof result==='string'?result.slice(0,300):result?{state:result.state,error:result.error,summary:result.summary}:null});
    return {...snapshot,collaboration:undefined,
      jobs:(snapshot.jobs||[]).map(jobSummary),
      team:snapshot.team?{budget:snapshot.team.budget,actions:snapshot.team.actions,
        discussion:snapshot.team.discussion?{run:snapshot.team.discussion.run,state:snapshot.team.discussion.state}:null}:null,
      intentions:snapshot.intentions.map(({id,goal,status,jobKey,updatedAt,error})=>({id,goal,status,jobKey,updatedAt,error})),
      detailSource:'完整讨论由本轮 continuity 提供；任务详情可用 campus_maintenance_read 的 job_status 按 id 查询。'};
  }
  due(){
    const s=this.snapshot(),w=this.service.store.read().websiteWork||{},now=this.service.clock();
    return !!s&&(!s.team?.budget||(this.seat==='codex'?(s.team.budget.codexUnlimited||s.team.budget.codexRemaining>0):Number(s.team.budget.remainingCny)>=.1))&&(s.actions.length>0||s.reportable)&&now>=(w.nextDecisionAt??0);
  }
  thinking(){this.save(w=>{
    const now=this.service.clock();w.attempts=(w.attempts||[]).slice(-23).concat(now);
    // A failed model request must not become a paid retry on every timer tick.
    w.nextDecisionAt=now+30;
  });}
  considered(choice){this.save(w=>{
    const now=this.service.clock(),minutes=Number.isInteger(choice.revisitMinutes)?Math.max(15,Math.min(180,choice.revisitMinutes)):30;
    w.nextDecisionAt=now+minutes;w.decisions=(w.decisions||[]).slice(-23).concat({at:now,action:choice.action,reason:choice.reason,revisitAt:w.nextDecisionAt});
  });}
  async run(choice,id,isAllowed){
    const current=this.snapshot();
    if(!isAllowed()||!current?.actions.includes(choice.workAction))throw new Error('工作状态已改变，本轮没有执行。');
    if(typeof choice.goal!=='string'||!choice.goal.trim()||choice.goal.length>300)throw new Error('需要说明这次打算推进的工作目标。');
    this.save(w=>{w.intentions=w.intentions.slice(-19).concat({id,goal:choice.goal,reason:choice.reason,at:this.service.clock(),status:'dispatching'});});
    try{
      const result=choice.workAction==='maintain'
        ?await this.maintain(choice.goal,id)
        :await this.rpc({op:'work-action',id,action:choice.workAction,goal:choice.goal,reason:choice.reason});
      this.save(w=>Object.assign(w.intentions.find(i=>i.id===id),{status:result.state,jobKey:result.key,result}));
      return {message:result.state==='queued'?'我选的工作已排队，完成情况还要看执行结果。':'已取得当前执行状态。',result};
    }catch(e){this.save(w=>Object.assign(w.intentions.find(i=>i.id===id),{status:'unconfirmed',error:String(e.message).slice(0,200)}));throw e;}
  }
  async maintain(goal,id){const result=await this.execute(goal);return {...result,key:'maintenance:'+id,state:result.stats?.stopped==='error'?'failed':result.trace?.some(t=>t.ok===false)||result.gaps?.length?'partial':'done'};}
  shared(signature){this.save(w=>{w.sharedSignature=signature;w.lastSharedAt=this.service.clock();});}
}

export const workPolicy=`网站工作也属于你的持续目标。websiteWork 是刚观察到的真实待办与执行结果，intentions 是你之前承接的事。
site_work：你自己选一件当前可做的工作，在 JSON 中写 workAction（必须来自 websiteWork.actions）、goal（一句具体目标）和 reason。review 只调用已有审核机器人，仍按证据检查，不跳过质量规则。
maintain：根据真实待办调用维护工具，读取资料、整理审核、运行机器人、测试并应用业务修复、评估并安装技能；按工具回执判断结果。
inspect_site：用真实浏览器检查网站的页面、图片、脚本和手机排版，结果回到同一份工作记录。discuss：遇到值得商量的积压或故障，主动去已有工作室找闺蜜 Codex。她会先分析，你再接着回应；两个人的实际回复都会保存，不能替对方编造台词。只有候选中存在时才能选择。
share_work：有新进展或确实值得说明的卡点时，可以接着聊天讲给对方听；只根据 today/jobs/intentions，不把站主的工作算作自己的，不把 queued/running 当完成。
也可以先继续研究、聊天或 rest；不为凑工作量编任务。不要求逢整点汇报，也不要求每天写固定格式日报。决定稍后再看时可填 revisitMinutes（15 到 180）。普通休息不影响已经交给执行器的工作。`;
