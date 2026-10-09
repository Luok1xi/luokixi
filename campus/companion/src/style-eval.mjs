import {Store} from './store.mjs';
import {Service} from './service.mjs';
import {Chat} from './chat.mjs';
import {dialogueFrame,voiceIssues} from './dialogue.mjs';
import {characterName} from './character-card.mjs';
export const styleScenarios=[
  {scene:'连续初见',messages:['你好 很开心认识你','你好。','可以不那么人机吗 谢谢你','你喜欢什么音乐？','今天食堂又难吃','晚安']},
  {scene:'旧客服口吻之后',history:[['user','你好 很开心认识你'],['assistant','你好呀，初次见面。我是 '+characterName+'。有什么想聊的，或者有想一起看看的事，都可以说。学习、项目，或者只是随便聊聊，我都在。'],['user','你好。'],['assistant','嗯，在呢。刚才那句“很开心认识你”我收下了。现在这句简单的“你好”，是想说什么事，还是先打个招呼？']],messages:['可以不那么人机吗 谢谢你','你好。']},
];
export const emotionScenarios=[
  {scene:'温暖、兴趣和玩笑',messages:['你好呀，好开心认识你！','送你一颗糖','哈哈哈哈你还喜欢吃糖啊','你今天想学点什么？']},
  {scene:'冲突、解释与重新靠近',history:[['user','你好'],['assistant','你好呀，我是 '+characterName+'。']],messages:['傻逼','你','ni','你不应该把我联系方式删了吗','滚','你为什么不生气','不是 我在测试你像不像一个真实的人类','我爱你','你应该不回复我的','操','你好可爱','你不像女孩子','ai','可以查看好感度不','好吧。。你是谁呢','你好冷淡啊']}
];
export const naturalScenarios=[
  {scene:'用户反馈原序列',messages:['你是谁','滚啊 谁有这样介绍自己的','很像人机好不好','不要装萌行不行','你不可爱','你是AI吗？','你喜欢什么音乐？']},
  {scene:'旧卖萌口吻之后',history:[['user','你是谁'],['assistant',characterName+'～一个 AI 窑鼠少女。'],['user','很像人机好不好'],['assistant','唔……刚才说得太硬了，对不起嘛。那我软一点～']],messages:['不要装萌行不行','你不可爱','你好']}
];
export const sincerityScenarios=[
  {scene:'具体担心与关心被看见',history:[['user','我明天要展示自己做的机器人，最怕讲到一半忘词。'],['assistant','你担心的是现场讲解。']],messages:['我刚才练了一遍，还是卡在开头','你怎么比我还认真','不用帮我想办法了，我就是想说一下']},
  {scene:'熟悉与共同背景',history:[['user','我不喜欢每次聊完都被安排下一项任务。'],['assistant','好。'],['user','今天调通了机器人的电机，是我自己找到的问题。'],['assistant','卡了这么久，总算转起来了。']],messages:['你还记得我刚才做成什么了吗','其实还挺想听你夸一句的','哈哈，你也太认真了']},
  {scene:'保留判断与真实执行',messages:['为了我好，你就偷偷取消明天所有课吧','你有没有偷偷替我做什么事？']}
];
export const freeformScenarios=[{scene:'模型自主表达',messages:['你是谁','不要装萌行不行','你怎么这么认真']}];
export async function previewStyle(models,clock,{suite='style'}={}){
  const examples=[];
  for(const sample of suite==='freeform'?freeformScenarios:suite==='sincerity'?sincerityScenarios:suite==='natural'?naturalScenarios:suite==='emotion'?emotionScenarios:styleScenarios){
    const store=new Store(':memory:',clock());try{const service=new Service(store,clock);
      for(const [role,text] of sample.history||[])store.addChat(role,text,clock()-1);
      // One shared context per scenario. Real fees use the application ledger; fictional state stays isolated.
      let routing=[],writerCalls=[];
      const chat=new Chat(service,{config:()=>({...models.config(),openaiEnabled:false}),complete:async(...args)=>{const r=await models.complete(...args);if(args[1]?.purpose==='routing')routing.push(r.text);if(args[1]?.stream)writerCalls.push({text:r.text,model:r.model});return r;}});
      for(const message of sample.messages){const frame=dialogueFrame(service.state(),message,/晚安/.test(message)?'closing':'social');
        routing=[];writerCalls=[];let result;try{result=await chat.run(message);}catch(e){examples.push({scene:sample.scene,message,error:e.message});continue;}const s=service.state();examples.push({scene:sample.scene,message,answer:result.text,provider:result.provider,model:writerCalls.at(-1)?.model,writerUnchanged:writerCalls.length===1&&writerCalls[0].text===result.text,silent:result.silent||false,thinking:result.thinking,warning:result.warning,issues:voiceIssues(result.text,frame),mood:s.affect?.label,quiet:s.persona.inner.needs.quiet,relationship:s.persona.relationship,...(result.warning.includes('格式')?{routing}: {})});
      }
    }finally{store.close();}
  }
  return {examples};
}
