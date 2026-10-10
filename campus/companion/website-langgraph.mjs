import {Annotation,StateGraph,START,END} from '@langchain/langgraph';
import {WebsiteCheckpointer} from './website-checkpointer.mjs';
import {isDeepStrictEqual} from 'node:util';

const State=Annotation.Root({
  id:Annotation(),execution:Annotation(),verification:Annotation(),reply:Annotation(),
});

// This graph transports work; the original agent still decides and the original Chat writes.
// An execution fence is committed BEFORE entering the agent. Replaying a graph node can therefore
// recover evidence, but cannot rerun an agent whose writes might already have reached the website.
export class WebsiteWorkflow{
  engine='langgraph';
  constructor({journal,seat,callbacks,checkpointer}){
    this.journal=journal;this.seat=seat;this.callbacks=callbacks;
    this.active=new Map();
    this.checkpointer=checkpointer||new WebsiteCheckpointer(journal.db);
    const node=(name,fn)=>async state=>{
      journal.checkpoint(state.id,{stage:name});
      await callbacks.progress?.(state.id,name);
      return fn(state,journal.get(state.id));
    };
    this.graph=new StateGraph(State)
      .addNode('prepare',node('prepare',async(state,row)=>{
        await callbacks.prepare(row.request);return {};
      }))
      .addNode('execute',node('execute',async(state,row)=>{
        if(row.workflow?.execution)return {execution:row.workflow.execution};
        const recovered=!!row.workflow?.executionStarted;
        if(!recovered)journal.checkpoint(state.id,{executionStarted:true});
        const execution=recovered?await callbacks.recover(row.request):await callbacks.execute(row.request);
        journal.checkpoint(state.id,{execution,recovered});return {execution};
      }))
      .addNode('verify',node('verify',async(state,row)=>{
        const verification=await callbacks.verify(row.request,state.execution);
        journal.checkpoint(state.id,{verification});return {verification};
      }))
      .addNode('compose',node('reply',async(state,row)=>{
        if(row.workflow?.reply)return {reply:row.workflow.reply};
        const interruptedReply=!!row.workflow?.replyStarted;
        journal.checkpoint(state.id,{replyStarted:true});
        const reply=interruptedReply?await callbacks.recoverReply(row.request,state.execution,state.verification)
          :await callbacks.reply(row.request,state.execution,state.verification);
        journal.checkpoint(state.id,{reply});return {reply};
      }))
      .addNode('remember',node('remember',async(state,row)=>{
        await callbacks.remember?.(row.request,state.reply);return {};
      }))
      .addEdge(START,'prepare').addEdge('prepare','execute').addEdge('execute','verify')
      .addEdge('verify','compose').addEdge('compose','remember').addEdge('remember',END)
      .compile({checkpointer:this.checkpointer});
  }
  run(request){
    const prior=this.journal.get(request.id);
    if(!prior)return Promise.reject(new Error('任务尚未登记。'));
    if(prior.request&&!isDeepStrictEqual(prior.request,request))return Promise.reject(new Error('同一任务编号不能用于不同指令。'));
    if(this.active.has(request.id))return this.active.get(request.id);
    const promise=this.advance(request).finally(()=>this.active.delete(request.id));
    this.active.set(request.id,promise);return promise;
  }
  async advance(request){
    const prior=this.journal.get(request.id);
    if(!prior)throw new Error('任务尚未登记。');
    if(prior.request&&!isDeepStrictEqual(prior.request,request))throw new Error('同一任务编号不能用于不同指令。');
    this.journal.put(request.id,{...prior,request,workflow:{...prior.workflow,engine:'langgraph',seat:this.seat}});
    const config={configurable:{thread_id:`website:${this.seat}:${request.id}`},durability:'sync'};
    const saved=await this.graph.getState(config);
    if(saved.values?.reply&&saved.next?.length===0)return saved.values.reply;
    const result=await this.graph.invoke(saved.createdAt?null:{id:request.id},config);
    return result.reply;
  }
  close(){}
}
