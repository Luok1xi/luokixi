import {stageCast,stagePose} from '../../campus/stage-catalog.js';
import {createCharacterSpeech} from './character-speech.js';
import {StagePlayback,dialogueRuns} from './stage-playback.js';
import {createCaptionMotion} from './caption-motion.js';
import {gameEmotes} from './game-emotes.js';
import '../styles/companion-stage.css';

// One presentation of the persisted chat, shared by both characters and the studio.
// Textbox paper / ink / emote vectors derive from the owner's 请不要攻略我.
export function mountCompanionStage(container,{seats=['beikuang']}={}){
  const cast=seats.filter(s=>stageCast[s]);if(!container||!cast.length)return;
  const section=document.createElement('section');section.className='companion-stage';section.dataset.cast=cast.length;
  section.setAttribute('aria-label',cast.map(s=>stageCast[s].name).join('与')+'的演出');
  section.innerHTML=`<div class="cs-toolbar"><span class="cs-title">在你面前</span><div>
    <button type="button" data-cs-auto aria-pressed="false">自动推进 · 关</button>
    <button type="button" data-cs-sound aria-pressed="true">声音 · 开</button>
    <button type="button" data-cs-history aria-expanded="false">对话历史</button>
    <button type="button" data-cs-toggle aria-expanded="true">收起</button></div></div>
    <div class="cs-scene"><div class="cs-light" aria-hidden="true"></div>
      <div class="cs-cast">${cast.map(s=>`<figure class="cs-actor" data-actor="${s}"><div class="cs-portrait" data-live></div><div class="cs-emote" aria-hidden="true"></div><figcaption>${stageCast[s].name}</figcaption></figure>`).join('')}</div>
      <div class="cs-caption"><div class="cs-caption-heading"><b data-cs-name></b><span data-cs-status></span></div>
        <p data-cs-text tabindex="0" role="button" aria-label="点击继续对白"></p>
        <div class="cs-controls"><button type="button" data-cs-prev aria-label="回看上一句">←</button><span data-cs-count></span><button type="button" data-cs-voice>重听</button><button type="button" data-cs-next>继续 ▸</button><button type="button" data-cs-latest hidden>回到当前</button></div>
      </div>
      <section class="cs-backlog" aria-label="已读对话历史" hidden><div class="cs-backlog-heading"><b>对话历史</b><button type="button" data-cs-history>返回演出</button></div><ol></ol></section>
    </div><p class="cs-error" role="status" hidden></p>`;
  container.append(section);
  const $=q=>section.querySelector(q),actors=new Map(),images=new Map(),historyNodes=new Map(),feed=new StagePlayback(),reduced=matchMedia('(prefers-reduced-motion: reduce)');
  const captionMotion=createCaptionMotion($('.cs-caption'),()=>reduced.matches);
  let dead=false,visible=true,collapsed=false,auto=false,sound=true,review=false,historyOpen=false,thinking=null,snapshot={},active=null,version=0,autoTimer=0,captionID=null,typing=false,inkTimer=0,rename=null,voiceState='idle';
  const available=()=>!dead&&visible&&!document.hidden&&!collapsed&&!review&&!historyOpen;
  const voice=createCharacterSpeech({onState:(state,message)=>{
    voiceState=state;section.dataset.voice=state;
    $('[data-cs-voice]').textContent=state==='loading'?'取消合成':state==='speaking'?'停止声音':state==='blocked'?'开启声音':'重听';
    if(state==='error'||state==='blocked'){$('.cs-error').textContent=message;$('.cs-error').hidden=false;}
    if(state==='speaking'&&available()&&sound){const next=feed.pending[0];if(next?.speech)voice.prefetch(next.speech,{seat:next.seat,expression:next.emotion});}
    mark();
  }});
  for(const seat of cast)actors.set(seat,{node:$(`[data-actor="${seat}"]`),url:'',version:0,motion:null});
  function load(url){
    if(!images.has(url))images.set(url,new Promise((resolve,reject)=>{const img=new Image();img.decoding='async';img.onload=()=>img.decode().catch(()=>{}).then(()=>resolve(img));img.onerror=reject;img.src=url;}).catch(e=>{images.delete(url);throw e;}));
    return images.get(url);
  }
  function pose(seat,emotion,activity){
    const actor=actors.get(seat),asset=stagePose(seat,emotion,activity);if(!actor||!asset||actor.url===asset.url)return;
    actor.url=asset.url;const epoch=++actor.version;
    load(asset.url).then(source=>{
      if(dead||actor.version!==epoch)return;
      const target=actor.node.querySelector('.cs-portrait'),previous=target.querySelector('img.is-visible'),img=source.cloneNode();
      img.alt=asset.name+'立绘';img.className='cs-sprite';img.dataset.pose=asset.pose;
      target.querySelectorAll('img:not(.is-visible)').forEach(n=>n.remove());target.append(img);
      requestAnimationFrame(()=>{if(dead||actor.version!==epoch){img.remove();return;}img.classList.add('is-visible');previous?.classList.remove('is-visible');});
      img.addEventListener('transitionend',()=>{if(img.classList.contains('is-visible'))target.querySelectorAll('img:not(.is-visible)').forEach(n=>n.remove());},{once:true});
      actor.node.dataset.ready='true';actor.node.dataset.pose=asset.pose;
    }).catch(()=>{if(!dead&&actor.version===epoch)actor.url='';});
  }
  function emote(line){
    for(const actor of actors.values()){actor.motion?.cancel();actor.node.querySelector('.cs-emote').replaceChildren();}
    const actor=actors.get(line?.seat),symbol=({happy:'♪',angry:'anger',sad:'sweat',awkward:'blush',curious:'?',question:'?',surprised:'!',think:'...',sleepy:'zzz'})[line?.emotion];
    if(!actor||!symbol)return;
    const el=actor.node.querySelector('.cs-emote');el.innerHTML=gameEmotes[symbol];
    if(reduced.matches)return;
    actor.motion=el.animate([{opacity:0,transform:'translateY(8px) scale(.85) rotate(-12deg)',offset:0},{opacity:1,transform:'translateY(0) scale(1) rotate(0)',offset:.1},{opacity:1,transform:'translateY(-8px) scale(1)',offset:.82},{opacity:0,transform:'translateY(-20px) scale(.98)',offset:1}],{duration:2300,easing:'cubic-bezier(.23,1,.32,1)',fill:'both'});
  }
  function mark(){
    if(dead)return;section.dataset.paused=String(!available());
    const speaking=voiceState==='speaking'||typing,seat=speaking?active?.seat:thinking||active?.seat;
    for(const [key,actor] of actors){actor.node.dataset.active=String(key===seat);actor.node.dataset.speaking=String(key===active?.seat&&speaking);actor.node.dataset.thinking=String(key===thinking&&!speaking);}
  }
  function reveal(){typing=false;clearTimeout(inkTimer);const p=$('[data-cs-text]');p.classList.add('is-complete');if(p.children.length)p.textContent=p.textContent;mark();}
  function caption(line,animate){
    if(captionID===line?.id)return;captionID=line?.id;clearTimeout(inkTimer);
    const p=$('[data-cs-text]'),words=line?.text||'从下面发一句话。回复到了，点这里继续。';p.replaceChildren();p.scrollTop=0;p.classList.toggle('is-complete',!animate||reduced.matches);
    p.setAttribute('aria-label',words+'。点击下一句');p.dataset.message=line?.id||'';
    if(!animate||reduced.matches||words.length>700){p.textContent=words;typing=false;return;}
    const {runs,duration}=dialogueRuns(words),fragment=document.createDocumentFragment();
    for(const run of runs){const span=document.createElement('span');span.className='cs-ink-run';span.setAttribute('aria-hidden','true');span.textContent=run.text;span.style.setProperty('--delay',run.delay+'ms');fragment.append(span);}
    p.append(fragment);typing=true;inkTimer=setTimeout(reveal,duration);
  }
  function controls(){
    const history=feed.history,index=history.findIndex(l=>l.id===active?.id);
    $('[data-cs-status]').textContent=historyOpen?'已读记录':review?'回看':feed.pending.length?`${feed.pending.length} 句新对白 · 点击继续`:thinking?'正在思考':'点击继续';
    $('[data-cs-prev]').disabled=index<=0;
    $('[data-cs-next]').disabled=review?index>=history.length-1:!feed.pending.length&&!typing&&!voice.speaking;
    $('[data-cs-count]').textContent=history.length?`${Math.max(0,index+1)} / ${history.length}`:'等你开口';
    $('[data-cs-latest]').hidden=!review;
    $('[data-cs-voice]').disabled=!active?.speech||collapsed;
    $('[data-cs-voice]').title=active&&!active.speech?'这条记录没有日语台词':'重听本句日语台词';
  }
  function display(line=active,animate=false){
    const changed=line?.id!==active?.id;active=line;
    const name=$('[data-cs-name]'),speaker=stageCast[line?.seat]?.name||cast.map(s=>stageCast[s].name).join(' · ');
    if(name.textContent!==speaker){name.textContent=speaker;rename?.cancel();if(animate&&!reduced.matches)rename=name.animate([{opacity:.35,transform:'translateX(-5px) rotate(-2deg)'},{opacity:1,transform:'translateX(0) rotate(-2deg)'}],{duration:200,easing:'cubic-bezier(.23,1,.32,1)'});}
    section.dataset.speaker=line?.seat||cast[0];caption(line,animate);controls();
    for(const seat of cast)pose(seat,seat===line?.seat?line.emotion||'neutral':snapshot.emotions?.[seat]||'neutral',seat===thinking&&voiceState!=='speaking'?'thinking':'idle');
    if(changed&&animate){captionMotion.tap();emote(line);}mark();
  }
  function interrupt(){version++;clearTimeout(autoTimer);autoTimer=0;voice.stop();reveal();}
  function schedule(ms=450){clearTimeout(autoTimer);if(auto&&available()&&feed.pending.length)autoTimer=setTimeout(()=>advance(),ms);}
  async function speak(line){
    const turn=version;$('.cs-error').hidden=true;
    // Start from the same audio element unlocked in the click gesture.
    const result=sound&&line?.speech?await voice.say(line.speech,{seat:line.seat,expression:line.emotion,language:'ja'}):null;
    if(dead||turn!==version)return;
    controls();if(result?.state==='blocked')return;
    schedule(result?.state==='ended'?450:Math.min(9000,Math.max(1800,(line?.text.length||0)*45)));
  }
  function advance(){
    if(!available())return;
    // Owner preference: a click interrupts AND advances, even while text is appearing.
    interrupt();const line=feed.next();if(!line){controls();return;}
    display(line,true);void speak(line);
  }
  function update(next={}){
    if(dead)return;snapshot=next;thinking=cast.includes(next.thinking)?next.thinking:null;
    const first=!feed.started;
    const fresh=feed.ingest((next.lines||[]).filter(l=>cast.includes(l.seat)&&typeof l.text==='string'&&l.text.trim()));
    display(first||!active?feed.current:active);
    if(fresh.length&&auto&&voiceState==='idle')schedule();
    if(historyOpen)renderHistory();
  }
  function navigate(delta){
    interrupt();review=true;const history=feed.history,index=history.findIndex(l=>l.id===active?.id);display(history[Math.max(0,Math.min(history.length-1,index+delta))],false);
  }
  function renderHistory(){
    const list=$('.cs-backlog ol'),frag=document.createDocumentFragment();
    const history=feed.history;
    if(history.length)list.querySelector('[data-empty]')?.remove();
    // Polling must not rebuild the open backlog or reset the user's reading position.
    for(const line of history){
      let row=historyNodes.get(line.id);
      if(!row){const li=document.createElement('li'),name=document.createElement('b'),p=document.createElement('p');li.append(name,p);frag.append(li);row={name,p};historyNodes.set(line.id,row);}
      const speaker=stageCast[line.seat]?.name||'';
      if(row.name.textContent!==speaker)row.name.textContent=speaker;
      if(row.p.textContent!==line.text)row.p.textContent=line.text;
    }
    list.append(frag);if(!list.children.length){const p=document.createElement('li');p.dataset.empty='true';p.textContent='还没有读过的对白。';list.append(p);}
  }
  function historyToggle(){
    historyOpen=!historyOpen;interrupt();$('.cs-backlog').hidden=!historyOpen;$('[data-cs-history]').setAttribute('aria-expanded',String(historyOpen));
    if(historyOpen){renderHistory();$('.cs-backlog ol').scrollTop=$('.cs-backlog ol').scrollHeight;$('.cs-backlog button').focus();}else{$('[data-cs-text]').focus({preventScroll:true});schedule();}
    controls();mark();
  }
  function click(e){
    if(e.target.closest('[data-cs-history]'))historyToggle();
    else if(e.target.closest('[data-cs-toggle]')){collapsed=!collapsed;$('.cs-scene').hidden=collapsed;$('[data-cs-toggle]').textContent=collapsed?'展开':'收起';$('[data-cs-toggle]').setAttribute('aria-expanded',String(!collapsed));interrupt();if(!collapsed)schedule();mark();}
    else if(e.target.closest('[data-cs-auto]')){auto=!auto;$('[data-cs-auto]').textContent='自动推进 · '+(auto?'开':'关');$('[data-cs-auto]').setAttribute('aria-pressed',String(auto));clearTimeout(autoTimer);if(auto&&!voice.speaking)schedule();}
    else if(e.target.closest('[data-cs-sound]')){sound=!sound;$('[data-cs-sound]').textContent='声音 · '+(sound?'开':'关');$('[data-cs-sound]').setAttribute('aria-pressed',String(sound));if(!sound){interrupt();schedule();}controls();}
    else if(e.target.closest('[data-cs-voice]')){if(voice.speaking){interrupt();controls();}else{interrupt();void speak(active);}}
    else if(e.target.closest('[data-cs-prev]'))navigate(-1);
    else if(e.target.closest('[data-cs-latest]')){interrupt();review=false;display(feed.current);schedule();}
    else if(e.target.closest('[data-cs-next],[data-cs-text]')){if(review)navigate(1);else advance();}
  }
  function suspend(){interrupt();captionMotion.stop();voice.cancelPrefetch();for(const actor of actors.values())actor.motion?.cancel();mark();}
  function visibility(){if(document.hidden)suspend();else schedule();mark();}
  function motionPreference(){if(reduced.matches){captionMotion.stop();rename?.cancel();reveal();for(const actor of actors.values())actor.motion?.cancel();}}
  function unlock(){if(!dead&&sound&&!voice.speaking)void voice.unlock();}
  function key(e){if(e.key==='Escape'&&historyOpen){e.preventDefault();historyToggle();}else if(e.target.matches('[data-cs-text]')&&['Enter',' '].includes(e.key)){e.preventDefault();if(review)navigate(1);else advance();}}
  const observer=new IntersectionObserver(entries=>{const next=entries[0].isIntersecting;if(!next&&visible)suspend();visible=next;if(visible)schedule();mark();},{threshold:.05});observer.observe(section);
  section.addEventListener('click',click);section.addEventListener('keydown',key);section.addEventListener('pointerdown',unlock);section.addEventListener('keydown',unlock);
  document.addEventListener('visibilitychange',visibility);reduced.addEventListener('change',motionPreference);display();
  return {update,destroy(){suspend();dead=true;voice.dispose();clearTimeout(inkTimer);rename?.cancel();observer.disconnect();document.removeEventListener('visibilitychange',visibility);reduced.removeEventListener('change',motionPreference);images.clear();historyNodes.clear();section.remove();}};
}
