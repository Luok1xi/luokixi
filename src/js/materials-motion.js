import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { CustomEase } from 'gsap/CustomEase';
import { reducedMotion } from './shell.js';
import { esc } from './data.js';

gsap.registerPlugin(ScrollTrigger, CustomEase);
CustomEase.create('material-out', '0.22,1,0.36,1');
CustomEase.create('material-ios', '0.32,0.72,0,1');

export function mountHeroBooks(root) {
  const media=gsap.matchMedia();
  media.add('(prefers-reduced-motion: no-preference)',()=>{
    const mobile=matchMedia('(max-width:760px)').matches;
    const books=[...root.children];
    books.forEach((book,index)=>gsap.to(book,{y:index===2?35:-25,x:index===0?(mobile?-115:-155):index===1?(mobile?110:160):0,rotation:index===0?-22:index===1?20:-3,z:index===2?65:-45,ease:'none',scrollTrigger:{trigger:root.closest('.mt-hero'),start:'top top',end:'bottom top',scrub:.5}}));
  });
  return()=>media.revert();
}

export function createBagMotion(dialog,trigger) {
  let motion,closing=false;
  const finish=()=>{motion?.kill();motion=null;dialog.close();gsap.set(dialog,{clearProps:'transform,opacity'});closing=false;};
  const close=()=>{if(!dialog.open||closing)return;closing=true;if(reducedMotion()||!motion||motion.time()<.001){finish();return;}motion.eventCallback('onReverseComplete',finish).timeScale(Math.max(1,motion.time()/.28)).reverse();};
  const open=(instant=false)=>{
    if(dialog.open)return;
    dialog.showModal();
    if(reducedMotion()||instant)return;
    const a=trigger.getBoundingClientRect(),b=dialog.getBoundingClientRect();
    motion=gsap.timeline().fromTo(dialog,{x:a.left+a.width/2-b.left-b.width/2,y:a.top+a.height/2-b.top-b.height/2,scale:.15,opacity:.3},{x:0,y:0,scale:1,opacity:1,duration:.4,ease:'material-ios'},0)
      .fromTo([...dialog.querySelectorAll('.mt-bag-row')].slice(0,8),{y:22,opacity:0},{y:0,opacity:1,duration:.25,stagger:{amount:.12},ease:'material-out'},.12);
  };
  return {open,close};
}

// The book owns its scroll pose. Hover acts on a separate inner layer, so the
// two inputs never fight over a transform. Only nearby rows own ScrollTriggers.
export function mountShelfMotion(root) {
  if (reducedMotion()) return () => {};
  const live = new Map();
  const fine = matchMedia('(hover:hover) and (pointer:fine)');
  const touch = matchMedia('(max-width:760px)').matches;
  const io = new IntersectionObserver(entries => entries.forEach(({ target: row, isIntersecting }) => {
    if (!isIntersecting) {
      const animation = live.get(row);
      animation?.scrollTrigger?.kill(); animation?.kill(); live.delete(row);
      row.querySelector('.mt-book-float')?.style.removeProperty('will-change');
      return;
    }
    if (live.has(row)) return;
    const book = row.querySelector('.mt-book-float');
    book.style.willChange = 'transform';
    const direction = Number(row.dataset.index) % 2 ? -1 : 1;
    const animation = gsap.timeline({scrollTrigger: {trigger:row,start:'top bottom',end:'bottom top',scrub:.35}})
      .fromTo(book, {y:touch?45:90,z:-95,rotationX:12,rotationY:direction*24,rotationZ:direction*9,scale:.86},
        {y:0,z:40,rotationX:0,rotationY:direction*-10,rotationZ:direction*-4,scale:1,duration:.5,ease:'none'})
      .to(book,{y:touch?-45:-90,z:-60,rotationX:-10,rotationY:direction*-24,rotationZ:direction*-7,scale:.9,duration:.5,ease:'none'});
    live.set(row,animation);
  }),{rootMargin:'220px 0px'});
  root.querySelectorAll('.mt-row').forEach(row=>io.observe(row));
  const move = event => {
    if (!fine.matches) return;
    const stage = event.target.closest('.mt-cover-stage');
    if (!stage) return;
    const r=stage.getBoundingClientRect();
    gsap.to(stage.querySelector('.mt-book-tilt'),{rotationY:((event.clientX-r.left)/r.width-.5)*14,rotationX:-((event.clientY-r.top)/r.height-.5)*10,duration:.28,ease:'material-out',overwrite:true});
  };
  const leave = event => {
    const stage=event.target.closest('.mt-cover-stage');
    if(stage&&!stage.contains(event.relatedTarget))gsap.to(stage.querySelector('.mt-book-tilt'),{rotationX:0,rotationY:0,duration:.28,ease:'material-out',overwrite:true});
  };
  root.addEventListener('pointermove',move);
  root.addEventListener('pointerout',leave);
  const media=matchMedia('(prefers-reduced-motion: reduce)');
  const cleanup=()=>{io.disconnect();live.forEach(a=>{a.scrollTrigger?.kill();a.kill();});live.clear();root.querySelectorAll('.mt-book-tilt').forEach(el=>gsap.killTweensOf(el));root.querySelectorAll('.mt-book-float').forEach(el=>el.style.removeProperty('will-change'));root.removeEventListener('pointermove',move);root.removeEventListener('pointerout',leave);media.removeEventListener('change',preference);};
  const preference=event=>{if(event.matches)cleanup();};
  media.addEventListener('change',preference);
  return cleanup;
}

let flight,lastTarget;
export function cancelBookTransfer() {
  flight?.kill();flight=null;
  document.querySelectorAll('.mt-transfer').forEach(el=>el.remove());
  if(lastTarget){gsap.killTweensOf(lastTarget);gsap.set(lastTarget,{clearProps:'transform,opacity'});lastTarget=null;}
}
export function flyBookToBag(from,target) {
  if (!from || !target) return;
  // One transfer actor at a time, even on rapid repeated clicks.
  cancelBookTransfer();lastTarget=target;
  gsap.killTweensOf(target);
  if (reducedMotion()) {gsap.fromTo(target,{opacity:.5},{opacity:1,duration:.16});return;}
  const a=from.getBoundingClientRect(), b=target.getBoundingClientRect();
  if (!a.width||!b.width)return;
  const actor=from.cloneNode(true);
  actor.classList.add('mt-transfer'); actor.setAttribute('aria-hidden','true');
  Object.assign(actor.style,{left:`${a.left}px`,top:`${a.top}px`,width:`${a.width}px`,height:`${a.height}px`});
  const host=from.closest('dialog[open]')||document.body;
  host.append(actor);
  const dx=b.left+b.width/2-a.left-a.width/2,dy=b.top+b.height/2-a.top-a.height/2;
  flight=gsap.timeline({onComplete:()=>{actor.remove();flight=null;}})
    .to(actor,{x:dx*.34,y:Math.min(-70,dy*.25-95),rotation:-12,scale:.64,duration:.2,ease:'power2.out'})
    .to(actor,{x:dx,y:dy,rotation:5,scale:.1,opacity:.15,duration:.32,ease:'power2.inOut'},'-=0.035')
    .to(target,{scaleX:1.12,scaleY:.92,rotation:-3,duration:.12,ease:'power2.out'},'-=0.08')
    .to(target,{scaleX:1,scaleY:1,rotation:0,duration:.25,ease:'elastic.out(1,.65)'});
}

export function createBookReader({getItem,cover,inBag,bagLabel,onBag}) {
  const reader=document.createElement('dialog');
  reader.className='mt-reader';reader.id='material-reader';reader.dataset.motion='flip';reader.setAttribute('aria-labelledby','mt-reader-title');
  document.body.append(reader);
  let timeline,origin,focusReturn,active,closing=false,previousOverflow='';
  const main=document.querySelector('main.mt');
  const finish=()=>{
    cancelBookTransfer();
    timeline?.kill();timeline=null;
    origin?.classList.remove('is-taken');
    gsap.set(main,{clearProps:'transform,opacity,transformOrigin'});
    reader.querySelectorAll('audio').forEach(audio=>audio.pause());
    reader.close();reader.innerHTML='';
    document.documentElement.style.overflow=previousOverflow;
    focusReturn?.focus({preventScroll:true});active=null;closing=false;
  };
  const close=()=>{
    if(!reader.open||closing)return;
    closing=true;
    if(reducedMotion()||!timeline||timeline.time()<.001){finish();return;}
    timeline.eventCallback('onReverseComplete',finish).reverse();
  };
  const open=(item,button,keyboard=false)=>{
    if(!item||reader.open)return;
    active=item;focusReturn=button;origin=button.querySelector('.mt-book')?button:(button.closest('.mt-row')?.querySelector('.mt-book-button')||button);
    const source=origin.querySelector('.mt-book');
    const box=source?.getBoundingClientRect()||button.getBoundingClientRect();
    const roleNames={paper:'试卷',answer:'答案',audio:'听力',other:'文件'};
    const files=item.files||[item],roles=item.roles||{other:files};
    const tabs=item.isSuite?['paper','answer','audio',...(roles.other?.length?['other']:[])]:Object.keys(roles).filter(role=>roles[role].length);
    const first=tabs.find(role=>roles[role]?.length)||tabs[0];
    const available=files.filter(file=>!file.external);
    const meta=[['分类',item.course],['收录',`${files.length} 份${item.external?'来源':'文件'}${item.pages?` · ${item.pages} 页`:''}`],['年份',item.year]].filter(([,value])=>value);
    const fileHTML=file=>`<article class="mt-reader-file"><div><span class="mt-reader-file-type">${esc(String(file.format||'FILE').toUpperCase())}${file.pages?` · ${esc(file.pages)} 页`:''}</span><h3>${esc(file.title)}</h3>${file.note?`<p>${esc(file.note)}</p>`:''}</div>
      ${/^(mp3|wav|m4a|ogg|aac|flac)$/i.test(file.format)?`<audio controls preload="none" src="${esc(file.url)}" aria-label="${esc(file.title)}">当前浏览器不支持音频播放，请打开原文件。</audio>`:''}
      <div class="mt-reader-file-actions"><a href="${esc(file.url)}" target="_blank" rel="noopener">${file.external?'前往原站':'站内查看'} ↗</a>${file.external?'':`<a href="${esc(file.url)}" download>下载 ↓</a>${file.format==='pdf'&&/^\/api\/file\//.test(file.url)?`<a href="question-workshop.html?document=${encodeURIComponent(file.id)}">题目工坊 ↗</a>`:''}<button class="mt-add" type="button" data-add="${esc(file.id)}" aria-pressed="${inBag(file)}" aria-label="${inBag(file)?'从资料袋拿出':'放入资料袋'}：${esc(file.title)}"><span aria-hidden="true">${inBag(file)?'✓':'＋'}</span><em>${bagLabel(file)}</em></button>`}</div>
      ${file.rights?`<p class="mt-reader-rights">${esc(file.rights)}</p>`:''}${file.source?`<p class="mt-reader-rights">来源：${esc(file.source)}</p>`:''}</article>`;
    reader.innerHTML=`<div class="mt-reader-wash"></div><button type="button" class="mt-reader-close" aria-label="合上资料，返回书架">← 返回书架</button>
      <div class="mt-reader-layout"><div class="mt-reader-object" aria-hidden="true">${cover(item)}<div class="mt-reader-paper"><small>LUOKIXI / 资料库</small><b>${esc(item.course||'学习资料')}</b><span>${esc(item.year||item.kind||'')}</span><em>${files.length} 份文件 · 按册收好</em></div></div>
      <section class="mt-reader-content"><p class="mt-reader-kicker">${esc(item.kind||'资料')} / ${esc(item.course||'')}</p><h2 id="mt-reader-title">${esc(item.title)}</h2>
       ${item.isSuite?`<p class="mt-reader-note">${item.missingRoles.length?`当前尚缺${item.missingRoles.map(role=>roleNames[role]).join('、')}。已有文件可单独查看或一起收好。`:'原卷、答案与听力收在同一册，切换下方标签即可查看。'}</p>`:item.note?`<p class="mt-reader-note">${esc(item.note)}</p>`:''}
       <dl>${meta.map(([key,value])=>`<div><dt>${key}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>
       ${available.length>1?`<div class="mt-reader-suite-action"><button class="mt-add" type="button" data-add="${esc(item.id)}" aria-pressed="${inBag(item)}"><span aria-hidden="true">${inBag(item)?'✓':'＋'}</span><em>${bagLabel(item)}</em></button><small>按原文件收好 · 不重复加入</small></div>`:''}
       <div class="mt-reader-tabs" role="tablist" aria-label="本册内容">${tabs.map(role=>`<button type="button" role="tab" id="material-tab-${role}" aria-controls="material-panel-${role}" aria-selected="${role===first}" tabindex="${role===first?0:-1}" data-material-tab="${role}">${roleNames[role]}<span>${roles[role]?.length||'待补'}</span></button>`).join('')}</div>
       ${tabs.map(role=>`<div class="mt-reader-panel" role="tabpanel" id="material-panel-${role}" aria-labelledby="material-tab-${role}" tabindex="0" ${role===first?'':'hidden'}>${roles[role]?.length?roles[role].map(fileHTML).join(''):`<p class="mt-reader-missing">本套${roleNames[role]}尚未收录。可以先查看已收录的其他文件。</p>`}</div>`).join('')}
       <p class="mt-reader-status" data-reader-status role="status" aria-live="polite"></p>
      </section></div><button type="button" class="mt-reader-bag" data-book-bag><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.5 8h13l-1 12.5h-11zM9 8V6.5a3 3 0 0 1 6 0V8"/></svg><span>资料袋</span><b data-reader-count>${document.querySelector('#bag-count').textContent}</b></button>`;
    const tabButtons=[...reader.querySelectorAll('[data-material-tab]')];
    const selectTab=button=>{
      reader.querySelectorAll('audio').forEach(audio=>audio.pause());
      tabButtons.forEach(tab=>{const on=tab===button;tab.setAttribute('aria-selected',String(on));tab.tabIndex=on?0:-1;reader.querySelector(`#material-panel-${tab.dataset.materialTab}`).hidden=!on;});
    };
    tabButtons.forEach((tab,index)=>{
      tab.onclick=()=>selectTab(tab);
      tab.onkeydown=event=>{
        let next;
        if(event.key==='ArrowRight')next=(index+1)%tabButtons.length;
        if(event.key==='ArrowLeft')next=(index+tabButtons.length-1)%tabButtons.length;
        if(event.key==='Home')next=0;
        if(event.key==='End')next=tabButtons.length-1;
        if(next===undefined)return;
        event.preventDefault();selectTab(tabButtons[next]);tabButtons[next].focus();
      };
    });
    previousOverflow=document.documentElement.style.overflow;
    reader.showModal();document.documentElement.style.overflow='hidden';
    main.style.transformOrigin=`50% ${window.scrollY+innerHeight/2-main.offsetTop}px`;
    origin.classList.add('is-taken');
    const object=reader.querySelector('.mt-reader-object'),dest=object.getBoundingClientRect();
    const book=object.querySelector('.mt-book'),front=book.querySelector('.mt-book-front');
    const content=reader.querySelector('.mt-reader-content');
    reader.querySelector('.mt-reader-close').onclick=close;
    reader.querySelector('[data-book-bag]').onclick=()=>{finish();onBag();};
    reader.querySelector('.mt-reader-close').focus({preventScroll:true});
    if(reducedMotion()||keyboard){gsap.set(front,{rotationY:-145});return;}
    const sx=box.width/dest.width,sy=box.height/dest.height;
    timeline=gsap.timeline({defaults:{ease:'material-ios'}})
      .fromTo(reader.querySelector('.mt-reader-wash'),{opacity:0},{opacity:1,duration:.28},0)
      .to(main,{scale:.97,opacity:.24,duration:.4},0)
      .fromTo(object,{x:box.left+box.width/2-dest.left-dest.width/2,y:box.top+box.height/2-dest.top-dest.height/2,scaleX:sx,scaleY:sy,rotation:0},{x:0,y:0,scaleX:1,scaleY:1,rotation:0,duration:.52},0)
      .fromTo(front,{rotationY:0},{rotationY:-145,duration:.45},.16)
      .fromTo(reader.querySelector('.mt-reader-paper'),{opacity:0},{opacity:1,duration:.2},.14)
      .fromTo(content,{x:-32,opacity:0},{x:0,opacity:1,duration:.32},.2)
      .fromTo(reader.querySelectorAll('.mt-reader-close,.mt-reader-bag'),{opacity:0},{opacity:1,duration:.18},.12);
  };
  const click=event=>{const button=event.target.closest('[data-book]');if(button)open(getItem(button.dataset.book),button,event.detail===0);};
  document.addEventListener('click',click);
  reader.addEventListener('cancel',event=>{event.preventDefault();close();});
  reader.addEventListener('click',event=>{if(event.target===reader||event.target.classList.contains('mt-reader-wash'))close();});
  reader.addEventListener('close',()=>{if(active)finish();});
  return {reader,close,active:()=>active};
}
