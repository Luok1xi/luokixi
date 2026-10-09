// Local character voices; never fall back to a system voice.
import {createHubClient} from '../../campus/hub-client.js';
import {spokenText} from '../../campus/shared/speech-text.mjs';
export function speechChunks(text,max=600){
  if(!Number.isInteger(max)||max<1)throw new RangeError('Invalid speech chunk size');
  const chunks=[];let current='';
  for(const sentence of String(text||'').match(/[^。！？.!?]+[。！？.!?]?|[。！？.!?]/gu)||[]){
    if(current&&[...current,...sentence].length>max){chunks.push(current);current='';}
    let chars=[...sentence];
    while(chars.length>max){
      // Keep a long sentence's clauses intact where possible; do not restart
      // the voice halfway through a Japanese phrase merely at character 120.
      let end=0;
      for(let i=max-1;i>=0;i--)if(/[、，,；;：:\s]/u.test(chars[i])){end=i+1;break;}
      if(!end)throw new RangeError('这段台词过长且没有自然停顿，请分句后朗读。');
      chunks.push(chars.splice(0,end).join(''));
    }
    current+=chars.join('');
  }
  if(current)chunks.push(current);return chunks;
}
let focusedVoice=null;
export function createCharacterSpeech({onState=()=>{}}={}){
  const api=createHubClient();let generation=0,audio=new Audio(),url=null,resolvePlayback=null,active=false,controller=null,unlocked=false;
  const prepared=new Map(),prefetches=new Map();
  audio.preload='auto';
  // Reuse the audio element unlocked by an actual user gesture after slow synthesis.
  async function unlock(){
    if(unlocked||active)return unlocked;
    audio.src='data:audio/wav;base64,UklGRiYAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQIAAAAAAA==';
    const epoch=generation;
    try{await audio.play();if(epoch===generation&&!active)audio.pause();unlocked=true;return true;}catch{return false;}
  }
  function stop(){generation++;active=false;controller?.abort();controller=null;audio.pause();audio.removeAttribute('src');audio.load();if(url)URL.revokeObjectURL(url);url=null;resolvePlayback?.();resolvePlayback=null;onState('idle');if(focusedVoice===stop)focusedVoice=null;}
  const bodyFor=(text,{seat='beikuang',expression='neutral',language='ja'}={})=>({text,seat,language,expression:expression==='sleepy'?'composed':expression});
  function prefetch(text,options={}){
    let chunk;try{chunk=speechChunks(spokenText(text))[0];}catch{return;}if(!chunk)return;
    const body=bodyFor(chunk,options),key=JSON.stringify(body);if(prepared.has(key)||prefetches.has(key))return;
    const abort=new AbortController();
    const promise=api.request('studio/voice',body,{signal:AbortSignal.any([abort.signal,AbortSignal.timeout(310000)])})
      .then(data=>{if(abort.signal.aborted)return;prepared.set(key,data);while(prepared.size>4)prepared.delete(prepared.keys().next().value);})
      .catch(()=>{}).finally(()=>{if(prefetches.get(key)?.abort===abort)prefetches.delete(key);});
    prefetches.set(key,{abort,promise});
  }
  async function say(text,{seat='beikuang',expression='neutral',language='ja'}={}){
    focusedVoice?.();stop();focusedVoice=stop;const turn=generation;active=true;controller=new AbortController();
    const clean=spokenText(text);
    if(!clean){stop();return {state:'empty'};}
    try{
      const chunks=speechChunks(clean);
      for(const [index,chunk] of chunks.entries()){
        if(turn!==generation)return {state:'cancelled'};onState('loading');
        const body=bodyFor(chunk,{seat,expression,language}),key=JSON.stringify(body);
        // A slow prefetch and playback share one synthesis request.
        if(prefetches.has(key))await prefetches.get(key).promise;
        if(turn!==generation)return {state:'cancelled'};
        const data=prepared.get(key)||await api.request('studio/voice',body,
          {signal:AbortSignal.any([controller.signal,AbortSignal.timeout(310000)])});
        if(turn!==generation)return {state:'cancelled'};
        const bytes=Uint8Array.from(atob(data.audio),c=>c.charCodeAt(0));url=URL.createObjectURL(new Blob([bytes],{type:data.type}));
        await new Promise((resolve,reject)=>{
          resolvePlayback=resolve;audio.src=url;audio.onended=resolve;audio.onerror=()=>reject(Error('角色语音未能播放，请重试。'));
          audio.play().then(()=>{
            unlocked=true;if(turn!==generation)return;
            onState('speaking');
            // Synthesize the next phrase during playback, instead of leaving
            // a full GPU synthesis wait between portions of one reply.
            if(chunks[index+1])prefetch(chunks[index+1],{seat,expression,language});
          }).catch(reject);
        });
        if(turn!==generation)return {state:'cancelled'};
        if(url)URL.revokeObjectURL(url);url=null;
      }
      stop();return {state:'ended'};
    }catch(e){
      if(turn!==generation)return {state:'cancelled'};
      stop();const state=e.name==='NotAllowedError'?'blocked':'error';
      onState(state,state==='blocked'?'点一下“开启声音”，后续新消息会自动朗读。':e.message);
      return {state};
    }
  }
  function cancelPrefetch(){for(const {abort} of prefetches.values())abort.abort();prefetches.clear();}
  function dispose(){stop();cancelPrefetch();prepared.clear();}
  return {available:true,say,stop,unlock,prefetch,cancelPrefetch,dispose,get speaking(){return active;}};
}
