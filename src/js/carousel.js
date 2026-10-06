// Collins-style perspective fan, inspired by https://www.dimi.me/lab/collins-carousel
// Independent vanilla implementation. No Motion+ source, dependency or demo assets.
import '../styles/carousel.css';
import '../styles/collins-carousel.css';
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
export function mountCarousel(root,{interval=7000,onChange}={}) {
 const viewport=root.querySelector('.hc-viewport'),slides=[...root.querySelectorAll('.hc-slide')],dots=[...root.querySelectorAll('.hc-dot')],play=root.querySelector('.hc-play'),motion=matchMedia('(prefers-reduced-motion: reduce)'),n=slides.length;
 if(!viewport||!n)return {go(){},next(){},prev(){},enter(){},index:0};
 root.classList.add('hc-collins');
 const cards=slides.map(el=>({el,media:el.querySelector('.hc-media'),copy:el.querySelector('.hc-copy'),links:[...el.querySelectorAll('a,button')]}));
 let width=slides[0].offsetWidth||600,active=0,position=0,target=0,velocity=0,frame=0,lastTime=0,drag=null,playing=!motion.matches&&n>1,autoTimer=0,direction=1,suppressClickUntil=0;
 const pauses=new Set(document.hidden?['hidden']:[]),announcement=document.createElement('p'),counter=document.createElement('span');
 announcement.className='sr-only';announcement.setAttribute('aria-live','polite');root.append(announcement);
 counter.className='hc-counter';root.querySelector('.hc-controls')?.prepend(counter);
 viewport.setAttribute('aria-label','精选新闻轮播，可左右拖动');root.style.setProperty('--hc-interval',`${interval}ms`);
 function draw(){cards.forEach(({el,media,copy},i)=>{
   const d=i-position,a=Math.abs(d),near=Math.min(a,1),x=Math.sign(d)*width*(near*.53+Math.max(0,a-1)*.23),r=-Math.sign(d)*(near*38+Math.min(1,Math.max(0,a-1))*8),z=-width*.48*a;
   el.style.transform=motion.matches?`translate3d(${(i-active)*width*1.08}px,0,0)`:`perspective(${width*2}px) translate3d(${x.toFixed(2)}px,0,${z.toFixed(2)}px) rotateY(${r.toFixed(2)}deg)`;
   el.style.opacity=a>2.8?'0':String(Math.max(.38,1-a*.18));el.style.zIndex=String(100-Math.round(a*10));el.style.pointerEvents=a>2.8?'none':'';
   if(copy)copy.style.opacity=String(motion.matches?+(i===active):clamp(1-a*2.3,0,1));
   if(media)media.style.transform=`translate3d(${(-d*18).toFixed(1)}px,0,0) scale(1.06)`;
 });}
 function settle(now){const dt=Math.min((now-lastTime)/1000||1/60,.032);lastTime=now;velocity+=((target-position)*225-velocity*30)*dt;position+=velocity*dt;draw();if(Math.abs(target-position)<.0007&&Math.abs(velocity)<.009){position=target;velocity=0;frame=0;draw();root.classList.remove('is-settling');}else frame=requestAnimationFrame(settle);}
 function animateTo(){if(motion.matches){cancelAnimationFrame(frame);frame=0;position=target;velocity=0;draw();return;}root.classList.add('is-settling');if(!frame){lastTime=performance.now();frame=requestAnimationFrame(settle);}}
 function sync(){slides.forEach((s,i)=>{const on=i===active;s.classList.toggle('is-active',on);s.setAttribute('aria-hidden',String(!on));cards[i].links.forEach(el=>el.tabIndex=on?0:-1);});dots.forEach((d,i)=>{d.classList.toggle('is-active',i===active);d.setAttribute('aria-selected',String(i===active));d.tabIndex=i===active?0:-1;});root.querySelectorAll('.hc-arrow').forEach(b=>b.disabled=Number(b.dataset.dir)<0?active===0:active===n-1);counter.textContent=`${String(active+1).padStart(2,'0')} / ${String(n).padStart(2,'0')}`;root.dataset.carouselIndex=String(active);}
 function schedule(){clearTimeout(autoTimer);dots.forEach(d=>d.classList.remove('is-running'));const paused=!playing||pauses.size>0||motion.matches;root.classList.toggle('is-paused',Boolean(paused));play?.classList.toggle('is-off',!playing);play?.setAttribute('aria-label',playing?'暂停自动播放':'继续自动播放');if(paused)return;const dot=dots[active];if(dot){void dot.offsetWidth;dot.classList.add('is-running');}autoTimer=setTimeout(()=>{if(active===n-1)direction=-1;if(active===0)direction=1;go(active+direction);},interval);}
 function pause(reason,enabled){enabled?pauses.add(reason):pauses.delete(reason);schedule();}
 function go(i,{user=false,instant=false}={}){const previous=active;active=clamp(Math.round(i),0,n-1);target=active;sync();if(instant||motion.matches){cancelAnimationFrame(frame);frame=0;position=target;velocity=0;draw();}else animateTo();schedule();if(previous!==active){onChange?.(active,slides[active],{user});if(user)announcement.textContent=`第 ${active+1} 张：${slides[active].querySelector('.hc-title')?.textContent||''}`;}}
 const next=o=>go(active+1,o),prev=o=>go(active-1,o);
 root.querySelectorAll('.hc-arrow').forEach(b=>b.addEventListener('click',()=>go(active+Number(b.dataset.dir),{user:true})));dots.forEach((b,i)=>b.addEventListener('click',()=>go(i,{user:true})));play?.addEventListener('click',()=>{playing=!playing;schedule();});
 root.addEventListener('pointerenter',e=>e.pointerType==='mouse'&&pause('hover',true));root.addEventListener('pointerleave',e=>e.pointerType==='mouse'&&pause('hover',false));root.addEventListener('focusin',()=>pause('focus',true));root.addEventListener('focusout',e=>!root.contains(e.relatedTarget)&&pause('focus',false));
 root.addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key)||/INPUT|TEXTAREA|SELECT/.test(e.target.tagName))return;e.preventDefault();go(e.key==='Home'?0:e.key==='End'?n-1:active+(e.key==='ArrowRight'?1:-1),{user:true,instant:true});if(e.target.classList.contains('hc-dot'))dots[active]?.focus();});
 viewport.addEventListener('dragstart',e=>e.preventDefault());
 viewport.addEventListener('pointerdown',e=>{if(e.button!==0||drag||e.target.closest('button,a,input'))return;drag={id:e.pointerId,x:e.clientX,y:e.clientY,start:position,lastX:e.clientX,lastTime:performance.now(),speed:0,moved:false};});
 viewport.addEventListener('pointermove',e=>{if(!drag||drag.id!==e.pointerId)return;const dx=e.clientX-drag.x,dy=e.clientY-drag.y;if(!drag.moved){if(Math.abs(dy)>Math.abs(dx)&&Math.abs(dy)>8){drag=null;return;}if(Math.abs(dx)<6)return;drag.moved=true;cancelAnimationFrame(frame);frame=0;viewport.setPointerCapture(e.pointerId);pause('drag',true);root.classList.add('is-dragging');}const now=performance.now();drag.speed=(e.clientX-drag.lastX)/Math.max(8,now-drag.lastTime);drag.lastX=e.clientX;drag.lastTime=now;const raw=drag.start-dx/width;position=raw<0?raw*.13:raw>n-1?n-1+(raw-(n-1))*.13:raw;velocity=0;draw();});
 function end(e,cancelled=false){if(!drag||drag.id!==e.pointerId)return;const d=drag;drag=null;if(viewport.hasPointerCapture(e.pointerId))viewport.releasePointerCapture(e.pointerId);root.classList.remove('is-dragging');pause('drag',false);if(!d.moved)return;suppressClickUntil=performance.now()+300;const speed=performance.now()-d.lastTime<90?d.speed:0,predicted=position-speed*150/width;go(cancelled?active:Math.abs(speed)>.45?active+(speed<0?1:-1):Math.round(predicted),{user:true});}
 viewport.addEventListener('pointerup',e=>end(e));viewport.addEventListener('pointercancel',e=>end(e,true));viewport.addEventListener('lostpointercapture',e=>{if(drag)end(e,true);});
 viewport.addEventListener('click',e=>{if(performance.now()<suppressClickUntil){e.preventDefault();e.stopImmediatePropagation();return;}const slide=e.target.closest('.hc-slide');if(slide&&!slide.classList.contains('is-active')){e.preventDefault();e.stopPropagation();go(slides.indexOf(slide),{user:true});}},true);
 new IntersectionObserver(([entry])=>pause('offscreen',!entry.isIntersecting),{threshold:.2}).observe(root);
 new ResizeObserver(()=>{width=slides[0].offsetWidth||width;draw();}).observe(viewport);
 document.addEventListener('visibilitychange',()=>pause('hidden',document.hidden));motion.addEventListener('change',()=>{if(motion.matches)playing=false;go(active,{instant:true});});
 addEventListener('pagehide',()=>{cancelAnimationFrame(frame);clearTimeout(autoTimer);frame=0;});addEventListener('pageshow',()=>{position=target;velocity=0;draw();schedule();});
 function enter(){if(!motion.matches)viewport.animate([{opacity:0,transform:'translateY(16px)'},{opacity:1,transform:'translateY(0)'}],{duration:260,easing:'cubic-bezier(.23,1,.32,1)'});}
 sync();draw();schedule();return{go,next,prev,enter,get index(){return active;}};
}
