// Synthetic role checks: no real chat history, no messaging adapters; usage stays in the actual ledger.
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,writeFileSync} from 'node:fs';
import {Models} from '../src/models.mjs';
import {readConfig} from '../src/config.mjs';
import {Store} from '../src/store.mjs';
import {Service} from '../src/service.mjs';
import {Chat} from '../src/chat.mjs';
import {nowMinute} from '../src/time.mjs';

if(!process.argv.includes('--paid-check'))throw new Error('Requires --paid-check');
const naming=process.argv.includes('--naming');
const campus=process.argv.includes('--campus');
const db=new DatabaseSync('data/miku.sqlite');db.exec('PRAGMA busy_timeout=5000');
const ledger={db,read:()=>JSON.parse(db.prepare('SELECT json FROM state WHERE id=1').get().json),transaction:fn=>{db.exec('BEGIN IMMEDIATE');try{const value=fn();db.exec('COMMIT');return value;}catch(error){db.exec('ROLLBACK');throw error;}}};
const models=new Models(ledger,()=>({...readConfig(),openaiEnabled:false}));
const before=models.usage().spent,records=[];
try{
  if(naming){
    const result=await models.complete([
      {role:'system',content:'你在试演一个北矿娘：以中国矿业大学（北京）为灵感的娇小成年大学生角色，黑红头发、白额带、黑白旗袍制服、白袜和小矿灯。性格亲近有主见，像熟人聊天，会接梗、吐槽自己，认真求助就认真帮。角色还没有定名。现在只做虚构试聊，不是假装在真实群里发消息。不要取古风或端庄正式的人名，不写策划案，不解释为什么巧妙，不套用动物娘的现成名字。'},
      {role:'user',content:'群友调侃：你们学校这么小，怎么还叫矿大啊。你会怎么接？给出六种独立的短回复，每句顺嘴自称一个让人记得住的外号。外号要像网友会叫的，能从矿业、煤、校园小、大学生日常这些关联自然冒出来。不要每句都硬谐音，不要叫井然。'}
    ],{maxOutput:900,thinking:'fast',purpose:'persona-preview'});
    records.push({kind:'naming',text:result.text,model:result.model});
  }else{
    const store=new Store(':memory:',nowMinute());
    try{
      const service=new Service(store),chat=new Chat(service,models);
      for(const message of campus?['你这么小，会不会觉得自己不如别的大学娘','如果分数和专业都合适，你想让我去你那里吗','不过我也可能选别的学校']:['你这学校没我小区大，怎么还叫矿大','所以现在该叫你什么，Miku不算你了吗','早八上完感觉人没了','别劝我学习，我就吐槽一下','不开玩笑了，二次方程的判别式怎么用，举个例子']){
        if(models.usage().spent-before>0.8)throw new Error('Preview cost cap reached');
        const result=await chat.compose({message,trigger:'reply'});
        records.push({message,text:result.text,messages:result.messages});
        store.addChat('user',message,nowMinute());store.addChat('assistant',result.text,nowMinute(),result.messages);
      }
    }finally{store.close();}
  }
  const report={at:new Date().toISOString(),synthetic:true,records,costCny:models.usage().spent-before};
  mkdirSync('test-output',{recursive:true});
  writeFileSync(`test-output/beikuang-${naming?'naming':campus?'campus':'dialogue'}.json`,JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
}finally{db.close();}
