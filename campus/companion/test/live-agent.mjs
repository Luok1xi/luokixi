// Metered live check of DeepSeek function calling and one quick research run.
// Usage: node test/live-agent.mjs --paid-check ["问题"]   Costs go to the real usage ledger; state stays in memory.
import {DatabaseSync} from 'node:sqlite';
import {writeFile,mkdir} from 'node:fs/promises';
import {Store} from '../src/store.mjs';
import {Service} from '../src/service.mjs';
import {Models} from '../src/models.mjs';
import {readConfig} from '../src/config.mjs';
import {nowMinute} from '../src/time.mjs';
import {CapabilityMemory} from '../src/capability-memory.mjs';
import {PublicReader} from '../src/public-reader.mjs';
import {RepositoryReader} from '../src/research-cortex.mjs';
import {Skills} from '../src/skills.mjs';
import {ResearchToolkit} from '../src/research-tools.mjs';
import {ToolAgent} from '../src/agent.mjs';
if(!process.argv.includes('--paid-check'))throw Error('Pass --paid-check for a metered isolated test');
const question=process.argv.slice(2).find(a=>!a.startsWith('--'))||'ORB-SLAM3 相比 ORB-SLAM2 主要增加了哪些能力？请给出论文出处。';
const db=new DatabaseSync('data/miku.sqlite');db.exec('PRAGMA busy_timeout=5000');
const ledger={db,read:()=>JSON.parse(db.prepare('SELECT json FROM state WHERE id=1').get().json),transaction:fn=>{db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}};
const models=new Models(ledger,readConfig),before=models.usage().spent,report={at:new Date().toISOString(),isolatedTest:true,question,steps:[]};
const store=new Store(':memory:',nowMinute()),service=new Service(store,nowMinute),memory=new CapabilityMemory(service),publicReader=new PublicReader();
const reader={document:async url=>(await publicReader.source({url,kind:'page'}))[0]};
try{
  // 1. Protocol smoke test: tool call → tool result → final text, with and without thinking.
  const clock={type:'function',function:{name:'get_beijing_time',description:'返回当前北京时间',parameters:{type:'object',properties:{}}}};
  for(const thinking of process.argv.includes('--agent-only')?[]:['fast','deep']){
    const messages=[{role:'user',content:'现在北京时间几点？必须调用工具查询，然后用一句话回答。'}];
    const a=await models.chat(messages,{tools:[clock],thinking,maxOutput:thinking==='deep'?1200:300,purpose:'agent-quick'});
    const call=a.message.tool_calls?.[0];report.steps.push({check:'tool-call-'+thinking,toolCall:call?.function?.name||null,hasReasoning:!!a.message.reasoning_content,cost:a.cost});
    if(!call)throw new Error(thinking+' 模式没有返回工具调用：'+a.message.content.slice(0,200));
    messages.push(a.message,{role:'tool',tool_call_id:call.id,content:JSON.stringify({time:new Date().toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})})});
    const b=await models.chat(messages,{tools:[clock],thinking,maxOutput:thinking==='deep'?1200:300,purpose:'agent-quick'});
    report.steps.push({check:'tool-result-'+thinking,answer:b.message.content.slice(0,120),cost:b.cost});console.log('✔ 工具调用协议',thinking,'→',b.message.content.slice(0,60));
  }
  // 2. One quick research run with the real toolkit (keyless sources unless search keys are configured).
  const skills=new Skills(),toolkit=new ResearchToolkit({config:readConfig,reader,repositories:new RepositoryReader(),models,memory,skills,db:store.db});
  const agent=new ToolAgent({models,toolkit,skills,memory,config:readConfig});
  const r=await agent.run({task:question,mode:'quick',budget:0.35,onProgress:p=>console.log('  第',p.step,'轮：',p.text)});
  report.agent={answer:r.answer,confidence:r.confidence,findings:r.findings,gaps:r.gaps,sources:r.sources,stats:r.stats,trace:r.trace};
  console.log('\n结论：',r.answer,'\n来源：',r.sources.map(s=>s.ref+' '+s.title).join(' | '),'\n统计：',JSON.stringify(r.stats));
}catch(e){report.error=e.message;console.log('✘',e.message);}
finally{report.costCny=Math.round((models.usage().spent-before)*10000)/10000;await mkdir('test-output',{recursive:true});await writeFile('test-output/live-agent.json',JSON.stringify(report,null,2));console.log('本次实际计费约 ¥'+report.costCny+'，结果写入 test-output/live-agent.json');db.close();}
