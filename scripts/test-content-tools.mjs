import test from 'node:test';
import assert from 'node:assert/strict';
import {mountMaintenance} from '../campus/companion/website-maintenance.mjs';
function setup(rpc){const definitions=new Map();const app={registry:{group(){},register(d){definitions.set(d.name,d);}},agent:{},service:{store:{read:()=>({websiteWork:{observation:{maintenance:{enabled:true}}}})}}};mountMaintenance(app,rpc);return{app,definitions};}
test('content tools expose concrete target and version schemas',()=>{
 const {definitions}=setup(async()=>({}));
 assert.deepEqual(definitions.get('content_review').required,['key','revision','decision','reason']);
 assert.deepEqual(definitions.get('content_publish').required,['key','revision','patch','reason']);
 assert.equal(definitions.get('content_search').risk,'read');assert.equal(definitions.get('content_publish').risk,'publish');
});
test('one non-overlapping conflict retry and task binding',async()=>{
 const calls=[];const {app,definitions}=setup(async body=>{calls.push(body);if(body.operation==='content_read')return{revision:3,data:{body:'old',summary:'other changed'}};
 if(calls.length===1)throw Error('内容版本已变化，请重新读取。');return{completed:true,state:'published'};});
 const result=await app.agent.withContentTask('task-1',()=>definitions.get('content_publish').handler({key:'entry/id',revision:2,patch:{body:'new'},before:{body:'old'},reason:'修正'}));
 assert.equal(result.retried,true);assert.equal(calls.length,3);assert.equal(calls[2].arguments.revision,3);
 assert.ok(calls.every(c=>c.contentTask==='task-1'));assert.notEqual(calls[0].id,calls[2].id);
});
test('overlapping change is preserved, never blindly overwritten',async()=>{
 const calls=[];const {definitions}=setup(async body=>{calls.push(body);if(body.operation==='content_read')return{revision:3,data:{body:'other author'}};throw Error('内容版本已变化');});
 await assert.rejects(()=>definitions.get('content_publish').handler({key:'entry/id',revision:2,patch:{body:'new'},before:{body:'old'},reason:'修正'}),/操作编号/);
 assert.equal(calls.length,2);
});
test('timeout is not automatically replayed',async()=>{
 let count=0;const {definitions}=setup(async()=>{count++;throw Error('请求超时');});
 await assert.rejects(()=>definitions.get('content_review').handler({key:'entry/id',revision:1,decision:'approve',reason:'已核对'}),/action_status/);
 assert.equal(count,1);
});
