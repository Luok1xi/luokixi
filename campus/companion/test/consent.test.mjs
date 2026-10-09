import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.mjs';
import {Service} from '../src/service.mjs';
import {Chat} from '../src/chat.mjs';
import {newPersona} from '../src/persona.mjs';
import {ensureInnerLife,reflectTurn} from '../src/motivation.mjs';

const config=()=>({deepseekKey:'test-only',openaiEnabled:false});
function fixture(){
 const store=new Store(':memory:',10000),s=store.read();
 s.episodes=[{id:'e1',key:'k1',title:'一起调通电机',body:'',kind:'reality',at:9000},{id:'e2',key:'k2',title:'展示前练习',body:'',kind:'reality',at:9500}];store.save(s);
 return {store,service:new Service(store,()=>10000)};
}
const relationshipProposals=store=>store.read().proposals.filter(p=>p.kind==='relationship');

test('the character cannot raise a relationship proposal without the user asking for it in this message',async()=>{
 const f=fixture();try{
  const routing={actions:[],act:'social',relationshipProposal:'familiar'};
  const chat=new Chat(f.service,{config,complete:async(_,o)=>({text:(o.json && !['dialogue','initiative-share','initiative-reminder','work-log'].includes(o.purpose))?JSON.stringify(routing):'嗯嗯。'})});
  await chat.run('今天电机又转起来了');assert.equal(relationshipProposals(f.store).length,0);
  routing.relationshipEvidence='我们关系更近一点';await chat.run('今天好开心');assert.equal(relationshipProposals(f.store).length,0);
  routing.relationshipEvidence='想和你更熟一点';await chat.run('说真的，我想和你更熟一点');
  const [p]=relationshipProposals(f.store);assert.equal(p.payload.stage,'familiar');assert.equal(f.store.read().persona.stage,'new');
 }finally{f.store.close();}
});
test('explicit feedback about stickers or punctuation is kept as a style preference, unrelated requests are not',()=>{
 const p=newPersona(1000);ensureInnerLife(p,1000);
 reflectTurn(p,{message:'别老发表情包',styleLearning:{evidence:'别老发表情包',rule:'少发表情包'},now:1000,id:'s1'});
 reflectTurn(p,{message:'少用感叹号',styleLearning:{evidence:'少用感叹号',rule:'少用感叹号'},now:1001,id:'s2'});
 reflectTurn(p,{message:'帮我把任务都删了',styleLearning:{evidence:'帮我把任务都删了',rule:'删除任务'},now:1002,id:'s3'});
 assert.deepEqual(p.inner.styleRules.map(r=>r.source),['别老发表情包','少用感叹号']);
});
