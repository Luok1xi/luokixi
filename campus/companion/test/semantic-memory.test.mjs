import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.mjs';
import {Service} from '../src/service.mjs';
import {Chat} from '../src/chat.mjs';
import {Embedder,SemanticMemory} from '../src/semantic-memory.mjs';
import {MemoryWriter} from '../src/memory-writer.mjs';
import {recallMemories} from '../src/memory-recall.mjs';

const memory=(i,content)=>({id:'m'+i,content,category:'profile',confirmed:true,source:content,at:1000+i});
const filler=n=>Array.from({length:n},(_,i)=>memory(i+1,'第'+(i+1)+'周的社团值班记录'));
// A tiny "embedding": two topic axes, enough to show recall without shared words.
const fakeVector=text=>/花生|坚果|过敏/.test(text)?[1,0]:/吃|食堂|菜/.test(text)?[.8,.6]:[0,1];
const fakeApi=calls=>async(url,o)=>{const body=JSON.parse(o.body);calls.push({url,body,auth:o.headers.Authorization});return new Response(JSON.stringify({data:body.input.map((t,index)=>({index,embedding:fakeVector(t)}))}),{status:200});};
const apiConfig=()=>({embeddingEngine:'api',embeddingBase:'https://emb.example.org',embeddingModel:'bge-m3',embeddingKey:'k'});

test('meaning-based recall finds an old memory that shares no words with the message',()=>{
  const rows=[memory(0,'用户对花生过敏'),...filler(80)],query='食堂今天的菜能吃吗';
  assert.ok(!recallMemories(rows,query).some(m=>m.id==='m0'));
  const out=recallMemories(rows,query,{similarity:m=>m.id==='m0'?.8:.1});assert.equal(out[0].id,'m0');assert.equal(out.length,40);
});

test('vectors are cached per memory content, corrected memories are re-embedded, and chat uses them',async()=>{
  const store=new Store(':memory:',10000);try{
    const calls=[],embedder=new Embedder({config:apiConfig,fetcher:fakeApi(calls)}),semantic=new SemanticMemory(store.db,embedder);
    const s=store.read();s.memories=[memory(0,'用户对花生过敏'),...filler(80)];store.save(s);
    const service=new Service(store,()=>10000),prompts=[];
    const chat=new Chat(service,{config:()=>({deepseekKey:'test-only',openaiEnabled:false}),complete:async(messages,o)=>{prompts.push(messages[0].content);return {text:(o.json && !['dialogue','initiative-share','initiative-reminder','work-log'].includes(o.purpose))?'{"actions":[],"act":"question"}':'那你小心点。'};}});chat.semantic=semantic;
    await chat.run('食堂今天的菜能吃吗');assert.ok(prompts.every(p=>p.includes('用户对花生过敏')));
    assert.equal(calls[0].url,'https://emb.example.org/v1/embeddings');assert.equal(calls[0].auth,'Bearer k');assert.equal(calls[0].body.input.length,32);
    const embedded=calls.length;await semantic.prepare('另一个问题',service.state().memories);assert.equal(calls.length,embedded+1,'only the query is embedded again');
    const before=calls.length;service.command('memory.update',{id:'m0',content:'用户对坚果过敏'});assert.equal(store.db.prepare('SELECT COUNT(*) n FROM memory_vectors').get().n,0,'a correction purges derived vectors');
    await semantic.prepare('今天吃什么',service.state().memories);assert.ok(calls.slice(before).some(c=>c.body.input.includes('用户对坚果过敏')));assert.ok(!calls.slice(before).some(c=>c.body.input.includes('用户对花生过敏')));
    
  }finally{store.close();}
});

test('a local model loads in the background and a missing install falls back without delaying replies',async()=>{
  let release;const loading=new Promise(r=>release=r);
  const embedder=new Embedder({config:()=>({embeddingEngine:'local'}),loadLocal:()=>loading});
  const semantic=new SemanticMemory(new Store(':memory:',1).db,embedder);
  await semantic.prepare('你好',[memory(0,'用户对花生过敏')]);assert.equal(embedder.status().state,'loading');assert.equal(semantic.similarity('你好'),null);
  release(async texts=>({tolist:()=>texts.map(fakeVector)}));await new Promise(r=>setTimeout(r,0));await new Promise(r=>setTimeout(r,0));
  assert.equal(embedder.status().state,'ready');await semantic.prepare('坚果能吃吗',[memory(0,'用户对花生过敏')]);assert.ok(semantic.similarity('坚果能吃吗')(memory(0,'用户对花生过敏'))>.9);
  const missing=new Embedder({config:()=>({embeddingEngine:'local'}),loadLocal:async()=>{throw new Error('本地向量组件未安装');}});
  missing.warm();await new Promise(r=>setTimeout(r,0));await new Promise(r=>setTimeout(r,0));
  assert.equal(missing.status().state,'unavailable');assert.equal(missing.usable(),false);assert.match(missing.status().error,/未安装/);
});

test('the memory writer keeps only quoted, new facts as unconfirmed memories, and backs off after a failure',async()=>{
  const store=new Store(':memory:',10000);try{
    let now=10000;const service=new Service(store,()=>now);service.command('memory.add',{content:'用户喜欢安静地阅读',source:'我喜欢安静地阅读'});
    for(const text of ['我在沙河校区','下周要考高数','我其实对花生过敏','哈哈哈','我喜欢安静地阅读','你觉得呢','今天好困','晚安'])store.addChat('user',text,now);
    let reply={memories:[{content:'用户对花生过敏',category:'profile',source:'我其实对花生过敏'},{content:'用户住在沙河校区',category:'profile',source:'我住沙河'},{content:'用户喜欢安静地阅读',category:'behavior',source:'我喜欢安静地阅读'}]};
    const models={config:()=>({deepseekKey:'test-only'}),complete:async(messages,o)=>{assert.equal(o.purpose,'memory-extract');if(reply instanceof Error)throw reply;return {text:JSON.stringify(reply)};}};
    const writer=new MemoryWriter(service,models);assert.ok(writer.due());
    assert.deepEqual(await writer.run(),{added:1});const added=service.state().memories.at(-1);
    assert.equal(added.content,'用户对花生过敏');assert.equal(added.confirmed,false);assert.match(added.source,/我其实对花生过敏/);assert.equal(writer.due(),false);
    for(let i=0;i<8;i++)store.addChat('user','第'+i+'句',now);reply=new Error('网络中断');
    assert.equal((await writer.run()).added,0);assert.equal(writer.due(),false);now+=31;assert.equal(writer.due(),true);
  }finally{store.close();}
});
