import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.mjs';
import {Models} from '../src/models.mjs';
test('Pro handles text in both thinking modes and uses Pro prices; image input retains Flash rates',async()=>{
  const store=new Store(':memory:',29823000);try{const bodies=[];
    const m=new Models(store,()=>({deepseekKey:'test',deepseekModel:'deepseek-v4-pro',monthlyLimit:200}),{clock:()=>29823000,fetcher:async(u,o)=>{bodies.push(JSON.parse(o.body));return new Response(JSON.stringify({choices:[{message:{content:'ok'}}],usage:{prompt_tokens:1000,prompt_cache_hit_tokens:100,completion_tokens:100}}));}});
    const a=await m.complete([{role:'user',content:'你好'}],{thinking:'fast',maxOutput:128});
    await m.complete([{role:'user',content:'证明一个结论'}],{thinking:'deep',maxOutput:128});
    assert.equal(a.model,'deepseek-v4-pro');assert.equal(bodies[0].model,'deepseek-v4-pro');assert.equal(bodies[0].thinking.type,'disabled');assert.equal(bodies[1].model,'deepseek-v4-pro');assert.equal(bodies[1].thinking.type,'enabled');assert.ok(Math.abs(m.usage().spent-.02166)<1e-9);
    const image=await m.complete([{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,AA=='}}]}],{maxOutput:128});assert.equal(image.model,'deepseek-flash');assert.equal(bodies[2].model,'deepseek-flash');assert.ok(Math.abs(m.usage().spent-.024264)<1e-9);
  }finally{store.close();}
});
