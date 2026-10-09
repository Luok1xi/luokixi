import test from 'node:test';
import assert from 'node:assert/strict';
import {Models,modelErrorMessage} from '../src/models.mjs';
import {Store} from '../src/store.mjs';
test('network permission failure is explained at the model boundary',async()=>{
  const store=new Store(':memory:',0);try{const models=new Models(store,()=>({deepseekKey:'test-only',monthlyLimit:200}),{clock:()=>0,fetcher:async()=>{throw new TypeError('fetch failed',{cause:Object.assign(new Error('blocked'),{code:'EACCES'})});}});
    await assert.rejects(models.complete([{role:'user',content:'connection check'}]),/运行环境禁止联网/);
    assert.equal(models.usage().rows[0].status,'uncertain');
  }finally{store.close();}
});
test('transport errors have actionable messages without exposing raw diagnostics',()=>{
  for(const code of ['ENOTFOUND','EAI_AGAIN','ECONNREFUSED','ECONNRESET','UND_ERR_CONNECT_TIMEOUT']){const text=modelErrorMessage(new TypeError('fetch failed',{cause:{code,message:'sensitive diagnostics'}}));assert.ok(!text.includes('fetch failed'));assert.ok(!text.includes('sensitive'));}
});
