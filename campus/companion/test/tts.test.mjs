import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Speech,speakable,gptSovitsTuning} from '../src/tts.mjs';
import {writeFileSync} from 'node:fs';

const base={ttsBase:'http://127.0.0.1:9880',ttsRefAudio:'D:/voices/meizha.wav',ttsPromptText:'你好呀',ttsPromptLang:'zh',ttsModel:'tts-1',ttsVoice:'alloy',ttsSpeed:1.1,ttsKey:''};

test('two imported voices switch both checkpoints serially and keep separate audio caches',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'voice-seats-'));try{
  const profiles=join(dir,'profiles.json');
  writeFileSync(profiles,JSON.stringify({seats:{beikuang:'nanami',codex:'rem'},profiles:Object.fromEntries(['nanami','rem'].map(id=>[id,{ready:true,name:id,engine:'gpt-sovits',ttsGptWeights:id+'.ckpt',ttsSovitsWeights:id+'.pth',ttsRefAudio:id+'.wav'}]))}));
  const calls=[];let loaded='';let active=0,peak=0;
  const speech=new Speech({config:()=>({...base,ttsProfilesPath:profiles}),dir:join(dir,'audio'),fetcher:async(url,o)=>{
   calls.push(url);active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,2));active--;
   if(url.includes('set_sovits'))loaded=new URL(url).searchParams.get('weights_path').split('.')[0];
   if(url.endsWith('/tts'))assert.equal(JSON.parse(o.body).ref_audio_path,loaded+'.wav');
   return url.endsWith('/tts')?audio():new Response('{}');
  }});
  await Promise.all([speech.synthesize('同一句话',{seat:'beikuang'}),speech.synthesize('同一句话',{seat:'codex'})]);
  assert.equal(peak,1);assert.equal(calls.length,6);assert.equal(speech.status('codex').voice,'rem');
  assert.equal((await speech.synthesize('同一句话',{seat:'beikuang'})).cached,true);assert.equal(calls.length,6);
  await speech.synthesize('下一句话',{seat:'beikuang'});assert.equal(calls.length,9);
  await assert.rejects(speech.synthesize('测试',{seat:'unknown'}),/角色无效/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
const audio=(type='audio/wav')=>new Response(new Uint8Array([82,73,70,70]),{status:200,headers:{'Content-Type':type}});

test('Shinsekai-compatible mode cleans stage actions and leaves acoustic defaults to the engine',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'tts-original-'));try{
  const calls=[];const speech=new Speech({config:()=>({...base,ttsEngine:'gpt-sovits',ttsCompatibility:'shinsekai',ttsTuning:{text_split_method:'cut2',fragment_interval:0.12,seed:42}}),dir,fetcher:async(url,o)=>{calls.push(JSON.parse(o.body));return audio();}});
  const dialogue='（息を吸う）今日は*小声で*確認するね。(微笑む)大丈夫。';
  await speech.synthesize(dialogue,{language:'ja'});
  assert.deepEqual(calls[0],{text:'今日は確認するね。大丈夫。',text_lang:'ja',ref_audio_path:base.ttsRefAudio,prompt_text:base.ttsPromptText,prompt_lang:base.ttsPromptLang,text_split_method:'cut5',batch_size:1,media_type:'wav',streaming_mode:false,speed_factor:base.ttsSpeed});
  await assert.rejects(speech.synthesize('（ため息）*うなずく*'),/朗读/);
  await assert.rejects(speech.synthesize('あ'.repeat(601)),/过长/);
  assert.equal(calls.length,1,'empty actions and overlong input never synthesize partial speech');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('Japanese synthesis sends ja and cannot reuse a Chinese-language cache entry',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'tts-ja-'));try{
  const langs=[];const speech=new Speech({config:()=>({...base,ttsEngine:'gpt-sovits'}),dir,fetcher:async(url,o)=>{langs.push(JSON.parse(o.body).text_lang);return audio();}});
  await speech.synthesize('確認',{language:'ja'});await speech.synthesize('確認',{language:'zh'});
  assert.equal((await speech.synthesize('確認',{language:'ja'})).cached,true);
  assert.deepEqual(langs,['ja','zh']);await assert.rejects(speech.synthesize('確認',{language:'invalid'}),/语言无效/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('GPT-SoVITS gets the api_v2 /tts body, results are cached by text, and citations are not read aloud',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'tts-'));try{
    const calls=[];const speech=new Speech({config:()=>({...base,ttsEngine:'gpt-sovits'}),dir,fetcher:async(url,o)=>{calls.push({url,body:JSON.parse(o.body)});return audio();}});
    const first=await speech.synthesize('今天也辛苦啦。\n\n参考来源：\n[S1] 某网页\nhttps://example.org');
    assert.equal(first.type,'audio/wav');assert.equal(first.cached,false);
    assert.equal(calls[0].url,'http://127.0.0.1:9880/tts');
    assert.deepEqual(calls[0].body,{text:'今天也辛苦啦。',text_lang:'zh',ref_audio_path:'D:/voices/meizha.wav',prompt_text:'你好呀',prompt_lang:'zh',...gptSovitsTuning({}),batch_size:1,media_type:'wav',streaming_mode:false,speed_factor:1.1});
    assert.equal((await speech.synthesize('今天也辛苦啦。')).cached,true);assert.equal(calls.length,1);assert.equal(readdirSync(dir).length,1);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('live voice tuning invalidates old audio without changing the other character',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'tts-tuning-'));try{
  const file=join(dir,'profiles.json');
  const registry={seats:{beikuang:'nanami',codex:'rem'},profiles:{nanami:{ready:true,engine:'gpt-sovits'},rem:{ready:true,engine:'gpt-sovits'}}};
  const save=()=>writeFileSync(file,JSON.stringify(registry));save();
  const calls=[];const speech=new Speech({config:()=>({...base,ttsProfilesPath:file}),dir:join(dir,'audio'),fetcher:async(_,o)=>{calls.push(JSON.parse(o.body));return audio();}});
  await speech.synthesize('でも、今日は大丈夫。',{language:'ja'});
  registry.profiles.nanami.ttsTuning={text_split_method:'cut2',fragment_interval:0.12,seed:42};save();
  assert.equal((await speech.synthesize('でも、今日は大丈夫。',{language:'ja'})).cached,false);
  assert.equal(calls.at(-1).text_split_method,'cut2');assert.equal(calls.at(-1).fragment_interval,0.12);
  assert.equal(calls.at(-1).seed,42);
  assert.equal((await speech.synthesize('でも、今日は大丈夫。',{language:'ja'})).cached,true);
  assert.equal(speech.status('codex').tuning.text_split_method,'cut5');
  for(const ttsTuning of [{fragment_interval:NaN},{fragment_interval:-1},{top_k:1.5},{seed:'42'},{text_split_method:'unknown'}])assert.throws(()=>gptSovitsTuning({ttsTuning}),/语音/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('OpenAI-compatible speech sends the key only as a header, and server errors are reported, not cached',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'tts-'));try{
    let seen;const speech=new Speech({config:()=>({...base,ttsEngine:'openai',ttsBase:'https://tts.example.org/',ttsKey:'secret'}),dir,fetcher:async(url,o)=>{seen={url,headers:o.headers,body:JSON.parse(o.body)};return audio('audio/mpeg');}});
    assert.equal((await speech.synthesize('[表情包：开心] 好耶')).type,'audio/mpeg');
    assert.equal(seen.url,'https://tts.example.org/v1/audio/speech');assert.equal(seen.headers.Authorization,'Bearer secret');
    assert.deepEqual(seen.body,{model:'tts-1',voice:'alloy',input:'好耶',response_format:'mp3',speed:1.1});
    const broken=new Speech({config:()=>({...base,ttsEngine:'gpt-sovits'}),dir:join(dir,'b'),fetcher:async()=>new Response(JSON.stringify({message:'ref audio missing'}),{status:400,headers:{'Content-Type':'application/json'}})});
    await assert.rejects(broken.synthesize('你好'),/HTTP 400.*ref audio missing/);
    await assert.rejects(new Speech({config:()=>({...base,ttsEngine:'browser'}),dir}).synthesize('你好'),/不需要服务器/);
    assert.equal(speakable('看这里 https://example.org 呀'),'看这里 呀');
  }finally{rmSync(dir,{recursive:true,force:true});}
});


test('Genie loads a character once, serializes speech and reuses cached audio',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'genie-'));try{
  const calls=[];let active=0,peak=0;
  const speech=new Speech({dir,config:()=>({...base,ttsEngine:'genie',ttsCharacter:'Nanami',ttsModelDir:'D:/voices/Nanami'}),fetcher:async(url,o)=>{
   calls.push({url,body:JSON.parse(o.body)});active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,3));active--;
   return url.endsWith('/tts')?audio():new Response('{}',{status:200});
  }});
  await Promise.all([speech.synthesize('第一句'),speech.synthesize('第二句')]);
  assert.equal(calls.filter(c=>c.url.endsWith('/load_character')).length,1);assert.equal(peak,1);
  assert.equal(calls.at(-1).body.character_name,'Nanami');
  assert.equal((await speech.synthesize('第一句')).cached,true);
  const missing=new Speech({dir,config:()=>({...base,ttsEngine:'genie'})});await assert.rejects(missing.synthesize('未配置'),/尚未配置/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
