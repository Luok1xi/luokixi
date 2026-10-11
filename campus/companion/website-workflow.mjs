import {isDeepStrictEqual} from 'node:util';

// The existing character database is the durable boundary. Transport checkpoints
// never replace the upstream agent, personality, conversation or model budget.
export class WebsiteWorkflow {
  engine='journal';
  constructor({journal,seat,callbacks}) {
    Object.assign(this,{journal,seat,callbacks});this.active=new Map();
  }
  run(request) {
    const prior=this.journal.get(request.id);
    if(!prior)return Promise.reject(new Error('任务尚未登记。'));
    if(prior.request&&!isDeepStrictEqual(prior.request,request))
      return Promise.reject(new Error('同一任务编号不能用于不同指令。'));
    if(this.active.has(request.id))return this.active.get(request.id);
    const promise=this.advance(request).finally(()=>this.active.delete(request.id));
    this.active.set(request.id,promise);return promise;
  }
  async advance(request) {
    const {journal,callbacks}=this,id=request.id;
    const prior=journal.get(id);
    journal.put(id,{...prior,request,workflow:{...prior.workflow,engine:this.engine,seat:this.seat}});
    const saved=()=>journal.get(id).workflow;
    const stage=async name=>{journal.checkpoint(id,{stage:name});await callbacks.progress?.(id,name);};
    if(saved().finished)return saved().reply;
    if(!saved().prepared){await stage('prepare');await callbacks.prepare(request);journal.checkpoint(id,{prepared:true});}
    let execution=saved().execution;
    if(!Object.hasOwn(saved(),'execution')) {
      await stage('execute');
      const recovered=!!saved().executionStarted;
      journal.checkpoint(id,{executionStarted:true});
      execution=recovered?await callbacks.recover(request):await callbacks.execute(request);
      journal.checkpoint(id,{execution:execution??null,recovered});
    }
    await stage('verify');
    const verification=await callbacks.verify(request,execution);
    journal.checkpoint(id,{verification});
    let reply=saved().reply;
    if(!Object.hasOwn(saved(),'reply')) {
      await stage('reply');
      const interrupted=!!saved().replyStarted;
      journal.checkpoint(id,{replyStarted:true});
      reply=interrupted?await callbacks.recoverReply(request,execution,verification)
        :await callbacks.reply(request,execution,verification);
      journal.checkpoint(id,{reply});
    }
    await stage('remember');await callbacks.remember?.(request,reply);
    journal.checkpoint(id,{stage:'completed',finished:true});return reply;
  }
  close(){}
}

// LangGraph is the default. The dependency-free journal engine remains an explicit
// recovery option; both engines preserve the original agent and use the same store.
export async function createWebsiteWorkflow(options) {
  if(process.env.COMPANION_WORKFLOW_ENGINE==='journal')return new WebsiteWorkflow(options);
  const {WebsiteWorkflow:LangGraphWorkflow}=await import('./website-langgraph.mjs');
  const workflow=new LangGraphWorkflow(options);workflow.engine='langgraph';return workflow;
}

export function recoveredExecution(actions){
  const trace=actions.map(row=>({tool:row.operation,operation:row.operation,
    target:row.arguments?.key||row.arguments?.id||'',ok:row.state==='done',recovered:true,
    ...(row.state==='done'?{receipt:{...row.result,operation:row.operation,actionId:row.id}}
      :{error:row.error||'操作结果尚未确认。'})}));
  const unresolved=actions.filter(a=>a.state!=='done');
  return {answer:'重启后仅核验已发出的操作，没有重复执行原指令。',trace,
    stats:{toolCalls:0,stopped:'recovered',recoveredActions:actions.length},
    gaps:unresolved.map(a=>`${a.operation}：${a.error||'操作结果未确认'}`)
      .concat(actions.length?[]:['上次执行中断，没有可核验的工具回执；原指令未重复执行。'])};
}
