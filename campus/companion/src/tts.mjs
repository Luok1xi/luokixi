import {createHash} from 'node:crypto';
import {mkdirSync,existsSync,readFileSync,writeFileSync,readdirSync,statSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {spokenText} from '../../shared/speech-text.mjs';
// Speech synthesis. "browser" speaks inside the page with the Web Speech API: no server and no wait.
// GPT-SoVITS (api_v2 /tts) and OpenAI-compatible /v1/audio/speech servers return audio, cached by text.
export const ttsEngines=['off','browser','gpt-sovits','genie','openai'];
export const speakable=spokenText;
// Keep commas inside one utterance: cut5 used to restart Nanami's voice at every
// Japanese comma. Full sentence boundaries remain audible; phonemes are not filtered.
export function sentencePhrasing(text){
  const sentences=text.replace(/([。！？!?])\s*/gu,'$1\n').split(/\n+/u).filter(Boolean);
  return sentences.flatMap(sentence=>{
    if([...sentence].length<=160)return [sentence];
    const clauses=sentence.match(/[^、，,]+[、，,]?/gu)||[sentence],parts=[];let group='';
    for(const clause of clauses){if(group&&[...group,...clause].length>160){parts.push(group);group='';}group+=clause;}
    if(group)parts.push(group);return parts;
  }).join('\n');
}
// Per imported voice, independent of personality and sprite emotion. Include the
// effective values in the cache key so tuning cannot replay an older recording.
export function gptSovitsTuning(config){
  if(config.ttsPhrasing==='sentence')return {...gptSovitsTuning({...config,ttsPhrasing:undefined,ttsCompatibility:undefined}),text_split_method:'cut0'};
  // Upstream's adapter leaves sampling and inter-fragment silence to the engine.
  // Do not mix our experimental cut2/seed/silence overrides into this mode.
  if(config.ttsCompatibility==='shinsekai')return {text_split_method:'cut5'};
  const raw=config.ttsTuning||{},tuning={text_split_method:'cut5',fragment_interval:0.3,top_k:15,top_p:1,temperature:1,repetition_penalty:1.35,seed:-1};
  const ranges={fragment_interval:[0,1],top_k:[1,100],top_p:[0.05,1],temperature:[0.1,2],repetition_penalty:[1,2],seed:[-1,2147483647]};
  if(raw.text_split_method!==undefined){
    if(!/^cut[0-5]$/.test(raw.text_split_method))throw new Error('语音分句方式无效。');
    tuning.text_split_method=raw.text_split_method;
  }
  for(const [name,[min,max]] of Object.entries(ranges)){
    if(raw[name]===undefined)continue;
    if(typeof raw[name]!=='number'||!Number.isFinite(raw[name])||raw[name]<min||raw[name]>max||(['top_k','seed'].includes(name)&&!Number.isInteger(raw[name])))throw new Error('语音参数无效：'+name);
    tuning[name]=raw[name];
  }
  return tuning;
}
export class Speech{
  constructor({config,dir,fetcher=fetch,limit=200}){Object.assign(this,{config,dir,fetcher,limit});this.tail=Promise.resolve();}
  profile(seat='beikuang'){
    if(!['beikuang','codex'].includes(seat))throw new Error('语音角色无效。');
    const c=this.config();if(!c.ttsProfilesPath)return c;
    const registry=JSON.parse(readFileSync(c.ttsProfilesPath,'utf8'));
    const id=registry.seats?.[seat],p=registry.profiles?.[id];
    if(!p?.ready)throw new Error(p?.reason||'该角色没有可用语音包。');
    return {...c,...p,ttsEngine:p.engine,profileId:id};
  }
  status(seat='beikuang'){const c=this.profile(seat);return {engine:c.ttsEngine,server:['gpt-sovits','genie','openai'].includes(c.ttsEngine),speed:c.ttsSpeed,seat,voice:c.name||c.ttsCharacter||c.ttsVoice,...(c.ttsEngine==='gpt-sovits'?{tuning:gptSovitsTuning(c)}:{})};}
  synthesize(text,options={}){const pending=this.tail.then(()=>this.generate(text,options));this.tail=pending.catch(()=>{});return pending;}
  async generate(text,{expression="neutral",seat='beikuang',language='zh'}={}){
    if(!['zh','ja','en'].includes(language))throw new Error('朗读语言无效。');
    const c=this.profile(seat),spoken=speakable(text),input=c.ttsPhrasing==='sentence'?sentencePhrasing(spoken):spoken;
    if(!['gpt-sovits','genie','openai'].includes(c.ttsEngine))throw new Error('当前语音方式不需要服务器合成。');
    if(!input)throw new Error('没有可以朗读的文字。');
    if([...input].length>600)throw new Error('这段台词过长，请在句间分段后朗读。');
    const tuning=c.ttsEngine==='gpt-sovits'?gptSovitsTuning(c):null;
    const ref=c.ttsRefAudio&&existsSync(c.ttsRefAudio)?statSync(c.ttsRefAudio):null;
    const key=createHash('sha256').update(JSON.stringify([c.ttsEngine,c.ttsBase,c.ttsModel,c.ttsVoice,c.ttsRefAudio,ref&&[ref.size,ref.mtimeMs],c.ttsPromptText,c.ttsPromptLang,c.ttsSpeed,c.ttsCharacter,c.ttsModelDir,c.ttsGptWeights,c.ttsSovitsWeights,c.sourceSha256,tuning,seat,language,expression,input])).digest('hex').slice(0,32);
    const type=['gpt-sovits','genie'].includes(c.ttsEngine)?'audio/wav':'audio/mpeg',file=join(this.dir,key+(type==='audio/wav'?'.wav':'.mp3'));
    if(existsSync(file))return {audio:readFileSync(file),type,cached:true};
    const base=new URL(c.ttsBase).href.replace(/\/+$/,'');
    if(c.ttsEngine==='gpt-sovits'&&(c.ttsGptWeights||c.ttsSovitsWeights)){
      if(!['127.0.0.1','localhost','[::1]'].includes(new URL(base).hostname))throw new Error('角色模型切换仅允许本机服务。');
      if(!c.ttsGptWeights||!c.ttsSovitsWeights)throw new Error('角色需要完整的 GPT 和 SoVITS 模型。');
      // One queue covers loading and synthesis; another speaker cannot swap weights mid-utterance.
      const signature=JSON.stringify([base,c.ttsGptWeights,c.ttsSovitsWeights]);
      if(this.loaded!==signature){
        this.loaded=null;
        for(const [path,weights] of [['set_gpt_weights',c.ttsGptWeights],['set_sovits_weights',c.ttsSovitsWeights]]){
          const url=new URL(base+'/'+path);url.searchParams.set('weights_path',weights);
          const r=await this.fetcher(url.href,{signal:AbortSignal.timeout(90000)});
          if(!r.ok)throw new Error('角色模型加载失败：'+path+' HTTP '+r.status);
        }
        this.loaded=signature;
      }
    }
    if(c.ttsEngine==='genie'){
      if(!c.ttsCharacter||!c.ttsModelDir)throw new Error('Genie 角色模型尚未配置；需要角色名称和 ONNX 模型文件夹。');
      const local=new URL(base);if(!['127.0.0.1','localhost','[::1]'].includes(local.hostname))throw new Error('Genie 模型加载仅允许本机服务。');
      const signature=JSON.stringify([base,c.ttsCharacter,c.ttsModelDir,c.ttsRefAudio,c.ttsPromptText,c.ttsPromptLang]);
      if(this.loaded!==signature){
        this.loaded=null;
        const post=async(path,body)=>{const r=await this.fetcher(base+'/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});if(!r.ok)throw new Error('角色语音加载失败：'+path+' HTTP '+r.status);};
        await post('load_character',{character_name:c.ttsCharacter,onnx_model_dir:c.ttsModelDir,language:c.ttsPromptLang});
        if(c.ttsRefAudio&&c.ttsPromptText)await post('set_reference_audio',{character_name:c.ttsCharacter,audio_path:c.ttsRefAudio,audio_text:c.ttsPromptText,language:c.ttsPromptLang});
        this.loaded=signature;
      }
    }
    const request=c.ttsEngine==='genie'?{url:base+'/tts',body:{character_name:c.ttsCharacter,text:input,split_sentence:false}}:c.ttsEngine==='gpt-sovits'
      ?{url:base+'/tts',body:{text:input,text_lang:language,ref_audio_path:c.ttsRefAudio,prompt_text:c.ttsPromptText,prompt_lang:c.ttsPromptLang,...tuning,batch_size:1,media_type:'wav',streaming_mode:false,speed_factor:c.ttsSpeed}}
      :{url:base+'/v1/audio/speech',body:{model:c.ttsModel,voice:c.ttsVoice,input,response_format:'mp3',speed:c.ttsSpeed},auth:c.ttsKey};
    let res;
    try{res=await this.fetcher(request.url,{method:'POST',headers:{'Content-Type':'application/json',...(request.auth?{Authorization:'Bearer '+request.auth}:{})},body:JSON.stringify(request.body),signal:AbortSignal.timeout(180000)});}
    catch(e){this.loaded=null;throw new Error('角色语音服务没有完成合成，请查看本机语音服务状态。',{cause:e});}
    const audio=Buffer.from(await res.arrayBuffer());
    if(!res.ok||!/^audio\//.test(res.headers.get('content-type')||'')){let detail='';try{detail=JSON.parse(audio.toString('utf8')).message||'';}catch{}throw new Error('语音合成失败（HTTP '+res.status+'）'+(detail?'：'+String(detail).slice(0,200):'')+'。');}
    if(audio.length>10*1024*1024)throw new Error('合成的音频过大。');
    mkdirSync(this.dir,{recursive:true});writeFileSync(file,audio);this.prune();
    return {audio,type,cached:false};
  }
  prune(){const files=readdirSync(this.dir).map(name=>({name,at:statSync(join(this.dir,name)).mtimeMs})).sort((a,b)=>b.at-a.at);for(const f of files.slice(this.limit))unlinkSync(join(this.dir,f.name));}
}
