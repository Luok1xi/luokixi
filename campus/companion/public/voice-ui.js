// Voice: settings card plus playback. Browser speech starts instantly; server engines fetch each line from
// /api/tts while the previous line is still playing, so long replies do not wait for the whole batch.
const strip=text=>String(text||'').replace(/\n*参考来源：[\s\S]*$/,'').replace(/https?:\/\/\S+/g,'').trim();
// Shared browser transport for the original console and website stage. Never auto-starts.
export function createBrowserVoice({onState=()=>{}}={}){
  const available=typeof window!=='undefined'&&'speechSynthesis' in window;
  let utterance=null,finish=null;
  function stop(){const done=finish;finish=null;utterance=null;if(available)window.speechSynthesis.cancel();done?.();onState('idle');}
  async function say(text,{rate=1,pitch=1.1}={}){
    stop();const line=strip(text);if(!available||!line)return;
    return new Promise(resolve=>{
      const u=new SpeechSynthesisUtterance(line);utterance=u;finish=resolve;
      const voice=window.speechSynthesis.getVoices().find(v=>/^zh/i.test(v.lang));if(voice)u.voice=voice;
      u.lang='zh-CN';u.rate=Math.max(.5,Math.min(2,rate));u.pitch=Math.max(.5,Math.min(1.5,pitch));
      u.onstart=()=>{if(utterance===u)onState('speaking');};
      const end=state=>{if(utterance!==u)return;utterance=null;finish=null;onState(state);resolve();};
      u.onend=()=>end('idle');u.onerror=e=>end(['canceled','interrupted'].includes(e.error)?'idle':'error');
      window.speechSynthesis.speak(u);
    });
  }
  return {available,say,stop,get speaking(){return Boolean(utterance);}};
}
export function initVoice({api,guard,notify,token,config}){
  const form=document.createElement('form');form.className='card';form.id='voice-form';
  form.innerHTML=`<p class="eyebrow">VOICE</p><h2>她的声音</h2><p>浏览器朗读不用安装，马上能用。GPT-SoVITS 或兼容 OpenAI 语音接口的服务需要你在电脑上另外启动，声音更像她。</p>
  <label>语音方式<select name="ttsEngine"><option value="off">不朗读</option><option value="browser">浏览器朗读（免安装）</option><option value="genie">Genie TTS（新世界角色包）</option><option value="gpt-sovits">GPT-SoVITS 本地服务</option><option value="openai">兼容 OpenAI 的语音接口</option></select></label>
  <label>服务地址<input name="ttsBase" placeholder="http://127.0.0.1:9880"></label>
  <label>Genie 角色名称<input name="ttsCharacter" placeholder="角色包内的名称"></label><label>Genie ONNX 模型文件夹<input name="ttsModelDir"></label><label>参考音频路径（GPT-SoVITS 所在电脑上的文件）<input name="ttsRefAudio" placeholder="D:/voices/meizha.wav"></label>
  <label>参考音频里说的话<input name="ttsPromptText"></label>
  <label>参考音频语言<select name="ttsPromptLang"><option value="zh">中文</option><option value="ja">日语</option><option value="en">英语</option><option value="yue">粤语</option><option value="ko">韩语</option><option value="auto">自动</option></select></label>
  <label>模型（兼容 OpenAI 接口）<input name="ttsModel"></label><label>音色<input name="ttsVoice"></label>
  <label>语速<input name="ttsSpeed" type="number" min="0.5" max="2" step="0.1"></label>
  <label>接口密钥（可选，不回显）<input name="ttsKey" type="password" autocomplete="off"></label>
  <div class="actions"><button class="primary">保存语音设置</button><button type="button" data-voice-test>试听一句</button></div>`;
  document.querySelector('#settings').append(form);
  const fill=()=>{const c=config();if(!c)return;for(const k of ['ttsCharacter','ttsModelDir','ttsEngine','ttsBase','ttsRefAudio','ttsPromptText','ttsPromptLang','ttsModel','ttsVoice','ttsSpeed'])if(c[k]!==undefined)form.elements[k].value=c[k];};setTimeout(fill);
  form.onsubmit=guard(async e=>{e.preventDefault();const f=form.elements,data={ttsCharacter:f.ttsCharacter.value,ttsModelDir:f.ttsModelDir.value,ttsEngine:f.ttsEngine.value,ttsBase:f.ttsBase.value,ttsRefAudio:f.ttsRefAudio.value,ttsPromptText:f.ttsPromptText.value,ttsPromptLang:f.ttsPromptLang.value,ttsModel:f.ttsModel.value,ttsVoice:f.ttsVoice.value,ttsSpeed:Number(f.ttsSpeed.value)||1};if(f.ttsKey.value)data.ttsKey=f.ttsKey.value;Object.assign(config(),await api('/api/config',data));f.ttsKey.value='';notify('语音设置已保存。');});
  form.querySelector('[data-voice-test]').onclick=guard(async()=>{await say(config().ttsProfilesPath?'これが今の声。聞こえる？':'这是我现在的声音，听得到吗？');});
  // Auto-read toggle lives next to the chat box; remembered per browser.
  let auto=false;try{auto=localStorage.getItem('voice:auto')==='1';}catch{}
  const toggle=document.createElement('label');toggle.className='voice-toggle';toggle.innerHTML='<input type="checkbox"> 朗读她的回复';const box=toggle.querySelector('input');box.checked=auto;
  box.onchange=()=>{auto=box.checked;try{localStorage.setItem('voice:auto',auto?'1':'0');}catch{}if(!auto)stop();};document.querySelector('#chat-form')?.after(toggle);
  let current=null,generation=0;const browserVoice=createBrowserVoice();
  function stop(){generation++;browserVoice.stop();current?.pause();current=null;}
  function browserSay(text){return browserVoice.say(text,{rate:Number(config().ttsSpeed)||1});}
  async function fetchAudio(text){const res=await fetch('/api/tts',{method:'POST',headers:{'Content-Type':'application/json','X-Miku-Token':token()},body:JSON.stringify({text,language:config().ttsProfilesPath?'ja':'zh'})});if(!res.ok)throw new Error((await res.json().catch(()=>({}))).error||'语音合成失败。');return URL.createObjectURL(await res.blob());}
  function play(url,run){return new Promise(resolve=>{if(run!==generation){resolve();return;}const audio=new Audio(url);current=audio;audio.onended=audio.onerror=()=>{URL.revokeObjectURL(url);resolve();};audio.play().catch(()=>resolve());});}
  // Speaks one line and resolves when it has finished.
  async function say(text,next){const engine=config().ttsEngine,line=strip(text);if(!line||engine==='off')return;const run=generation;
    if(engine==='browser')return browserSay(line);
    const url=await (next||fetchAudio(line));return play(url,run);}
  async function sayAll(lines){stop();const run=generation,texts=lines.map(strip).filter(Boolean);let pending=null;
    for(let i=0;i<texts.length&&run===generation;i++){const engine=config().ttsEngine;if(engine==='off')return;
      if(engine==='browser'){await browserSay(texts[i]);continue;}
      const url=await (pending||fetchAudio(texts[i]));pending=i+1<texts.length?fetchAudio(texts[i+1]):null;await play(url,run);}}
  document.addEventListener('companion:reply',e=>{if(!auto||e.detail.silent)return;const lines=(e.detail.messages||[]).filter(m=>m.type==='text').map(m=>config().ttsProfilesPath?m.speech:m.text).filter(Boolean);void sayAll(lines).catch(err=>notify(err.message,true));});
  return {say,stop,fetchAudio,enabled:()=>auto&&config().ttsEngine!=='off',refresh:fill};
}
