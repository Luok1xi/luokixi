// Collins perspective fan. Sample the spring once, then let WAAPI composite it.
import { planMotion } from './carousel-motion.js';
import '../styles/carousel.css';
import '../styles/collins-carousel.css';
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

export function mountCarousel(root, { interval = 7000, onChange } = {}) {
  const viewport = root.querySelector('.hc-viewport'), slides = [...root.querySelectorAll('.hc-slide')];
  const dots = [...root.querySelectorAll('.hc-dot')], play = root.querySelector('.hc-play');
  const motion = matchMedia('(prefers-reduced-motion: reduce)'), n = slides.length;
  if (!viewport || !n) return { go() {}, next() {}, prev() {}, enter() {}, pause() {}, index: 0 };
  root.classList.add('hc-collins');
  const cards = slides.map(el => ({ el, copy: el.querySelector('.hc-copy'), links: [...el.querySelectorAll('a,button')] }));
  let width = slides[0].offsetWidth || 600, active = 0, position = 0, target = 0, velocity = 0;
  let run = null, drag = null, dragFrame = 0, progressAnimation, autoTimer = 0;
  let playing = !motion.matches && n > 1, direction = 1, suppressClickUntil = 0;
  const pauses = new Set(document.hidden ? ['hidden'] : []);
  const announcement = document.createElement('p'), counter = document.createElement('span');
  announcement.className = 'sr-only'; announcement.setAttribute('aria-live', 'polite'); root.append(announcement);
  counter.className = 'hc-counter'; root.querySelector('.hc-controls')?.prepend(counter);
  viewport.setAttribute('aria-label', '精选新闻轮播，可左右拖动');
  root.style.setProperty('--hc-interval', `${interval}ms`);

  function visual(i, p) {
    const d = i - p, a = Math.abs(d), near = Math.min(a, 1);
    const x = Math.sign(d) * width * (near * .53 + Math.max(0, a - 1) * .23);
    const r = -Math.sign(d) * (near * 38 + Math.min(1, Math.max(0, a - 1)) * 8);
    return {
      transform: motion.matches ? `translate3d(${(i - active) * width * 1.08}px,0,0)`
        : `perspective(${width * 2}px) translate3d(${x.toFixed(2)}px,0,${(-width * .48 * a).toFixed(2)}px) rotateY(${r.toFixed(2)}deg)`,
      opacity: Math.max(.38, 1 - a * .18),
      copy: motion.matches ? +(i === active) : clamp(1 - a * 2.3, 0, 1),
    };
  }
  // Stacking and visibility change at interaction boundaries, never on every frame.
  function prepare(from = position, to = from) {
    cards.forEach(({ el }, i) => {
      const visible = i >= Math.min(from, to) - 2.8 && i <= Math.max(from, to) + 2.8;
      el.style.visibility = visible ? 'visible' : 'hidden';
      el.style.zIndex = String(100 - Math.round(Math.abs(i - to) * 10));
      el.style.pointerEvents = visible ? '' : 'none';
    });
  }
  function draw(p = position) {
    cards.forEach(({ el, copy }, i) => {
      if (el.style.visibility === 'hidden') return;
      const v = visual(i, p); el.style.transform = v.transform; el.style.opacity = String(v.opacity);
      if (copy) copy.style.opacity = String(v.copy);
    });
  }
  function interrupt() {
    cancelAnimationFrame(dragFrame); dragFrame = 0;
    if (!run) return;
    const old = run; run = null;
    const state = old.plan.sample(Number(old.clock.currentTime) || 0);
    position = state.position; velocity = state.velocity;
    draw(); old.animations.forEach(a => a.cancel()); root.classList.remove('is-settling');
  }
  function finish() {
    const old = run; run = null; position = target; velocity = 0;
    prepare(); draw(); old?.animations.forEach(a => a.cancel()); root.classList.remove('is-settling');
  }
  function cancelDrag() {
    const previous = drag; drag = null;
    if (previous?.moved) suppressClickUntil = performance.now() + 300;
    cancelAnimationFrame(dragFrame); dragFrame = 0;
    if (previous && viewport.hasPointerCapture(previous.id)) viewport.releasePointerCapture(previous.id);
    pauses.delete('drag'); root.classList.remove('is-dragging');
  }
  function animateTo() {
    if (motion.matches || (Math.abs(position - target) < .0007 && Math.abs(velocity) < .009)) { finish(); return; }
    const plan = planMotion({ from: position, to: target, velocity });
    prepare(position, target);
    const animations = [];
    cards.forEach(({ el, copy }, i) => {
      if (el.style.visibility === 'hidden') return;
      const frames = plan.frames.map(f => ({ ...visual(i, f.position), offset: f.offset }));
      const options = { duration: plan.duration, easing: 'linear', fill: 'both' };
      animations.push(el.animate(frames.map(f => ({ offset: f.offset, transform: f.transform, opacity: f.opacity })), options));
      if (copy) animations.push(copy.animate(frames.map(f => ({ offset: f.offset, opacity: f.copy })), options));
    });
    const current = { plan, animations, clock: animations[0] };
    run = current; root.classList.add('is-settling');
    current.clock.finished.then(() => { if (run === current) finish(); }, () => {});
  }
  function sync() {
    slides.forEach((s, i) => {
      const on = i === active; s.classList.toggle('is-active', on); s.setAttribute('aria-hidden', String(!on));
      cards[i].links.forEach(el => { el.tabIndex = on ? 0 : -1; });
    });
    dots.forEach((d, i) => { d.classList.toggle('is-active', i === active); d.setAttribute('aria-selected', String(i === active)); d.tabIndex = i === active ? 0 : -1; });
    root.querySelectorAll('.hc-arrow').forEach(b => { b.disabled = Number(b.dataset.dir) < 0 ? active === 0 : active === n - 1; });
    counter.textContent = `${String(active + 1).padStart(2, '0')} / ${String(n).padStart(2, '0')}`;
    root.dataset.carouselIndex = String(active);
  }
  function schedule() {
    clearTimeout(autoTimer); progressAnimation?.cancel();
    const paused = !playing || pauses.size > 0 || motion.matches;
    root.classList.toggle('is-paused', Boolean(paused)); play?.classList.toggle('is-off', !playing);
    play?.setAttribute('aria-label', playing ? '暂停自动播放' : '继续自动播放');
    if (paused) return;
    progressAnimation = dots[active]?.querySelector('i')?.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { duration: interval, fill: 'forwards' });
    autoTimer = setTimeout(() => { if (active === n - 1) direction = -1; if (active === 0) direction = 1; go(active + direction); }, interval);
  }
  function pause(reason, enabled) {
    enabled ? pauses.add(reason) : pauses.delete(reason);
    if (enabled && ['hidden', 'offscreen'].includes(reason)) { cancelDrag(); finish(); }
    schedule();
  }
  function go(i, { user = false, instant = false } = {}) {
    interrupt(); const previous = active; active = clamp(Math.round(i), 0, n - 1); target = active;
    sync(); if (instant || motion.matches) finish(); else animateTo(); schedule();
    if (previous !== active) {
      onChange?.(active, slides[active], { user });
      if (user) announcement.textContent = `第 ${active + 1} 张：${slides[active].querySelector('.hc-title')?.textContent || ''}`;
    }
  }
  const next = o => go(active + 1, o), prev = o => go(active - 1, o);
  root.querySelectorAll('.hc-arrow').forEach(b => b.addEventListener('click', () => go(active + Number(b.dataset.dir), { user: true })));
  dots.forEach((b, i) => b.addEventListener('click', () => go(i, { user: true })));
  play?.addEventListener('click', () => { playing = !playing; schedule(); });
  root.addEventListener('pointerenter', e => e.pointerType === 'mouse' && pause('hover', true));
  root.addEventListener('pointerleave', e => e.pointerType === 'mouse' && pause('hover', false));
  root.addEventListener('focusin', () => pause('focus', true));
  root.addEventListener('focusout', e => !root.contains(e.relatedTarget) && pause('focus', false));
  root.addEventListener('keydown', e => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key) || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    e.preventDefault(); go(e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : active + (e.key === 'ArrowRight' ? 1 : -1), { user: true, instant: true });
    if (e.target.classList.contains('hc-dot')) dots[active]?.focus();
  });
  viewport.addEventListener('dragstart', e => e.preventDefault());
  viewport.addEventListener('pointerdown', e => {
    if (e.button !== 0 || drag || e.target.closest('button,a,input')) return;
    interrupt(); prepare(position, active); draw();
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, start: position, lastX: e.clientX, lastTime: performance.now(), speed: 0, moved: false, stack: Math.round(position) };
  });
  viewport.addEventListener('pointermove', e => {
    if (!drag || drag.id !== e.pointerId) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved) {
      if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 8) { drag = null; animateTo(); return; }
      if (Math.abs(dx) < 6) return;
      drag.moved = true; viewport.setPointerCapture(e.pointerId); pause('drag', true); root.classList.add('is-dragging');
    }
    const now = performance.now(); drag.speed = (e.clientX - drag.lastX) / Math.max(8, now - drag.lastTime);
    drag.lastX = e.clientX; drag.lastTime = now;
    const raw = drag.start - dx / width;
    position = raw < 0 ? raw * .13 : raw > n - 1 ? n - 1 + (raw - (n - 1)) * .13 : raw;
    velocity = -drag.speed * 1000 / width;
    if (!dragFrame) dragFrame = requestAnimationFrame(() => {
      dragFrame = 0;
      if (drag && drag.stack !== Math.round(position)) { drag.stack = Math.round(position); prepare(position); }
      draw();
    });
  });
  function end(e, cancelled = false) {
    if (!drag || drag.id !== e.pointerId) return;
    const d = drag; drag = null;
    if (viewport.hasPointerCapture(e.pointerId)) viewport.releasePointerCapture(e.pointerId);
    root.classList.remove('is-dragging'); pause('drag', false);
    if (!d.moved) { animateTo(); return; }
    suppressClickUntil = performance.now() + 300;
    const speed = performance.now() - d.lastTime < 90 ? d.speed : 0;
    velocity = -speed * 1000 / width;
    const predicted = position - speed * 150 / width;
    go(cancelled ? active : Math.abs(speed) > .45 ? active + (speed < 0 ? 1 : -1) : Math.round(predicted), { user: true });
  }
  // A press released outside the viewport must not leave stale drag state.
  addEventListener('pointerup', e => end(e));
  addEventListener('pointercancel', e => end(e, true));
  viewport.addEventListener('lostpointercapture', e => { if (drag) end(e, true); });
  viewport.addEventListener('click', e => {
    if (performance.now() < suppressClickUntil) { e.preventDefault(); e.stopImmediatePropagation(); return; }
    const slide = e.target.closest('.hc-slide');
    if (slide && !slide.classList.contains('is-active')) { e.preventDefault(); e.stopPropagation(); go(slides.indexOf(slide), { user: true }); }
  }, true);
  new IntersectionObserver(([entry]) => pause('offscreen', !entry.isIntersecting), { threshold: .2 }).observe(root);
  new ResizeObserver(() => { const nextWidth = slides[0].offsetWidth || width; if (nextWidth !== width) { cancelDrag(); interrupt(); width = nextWidth; finish(); schedule(); } }).observe(viewport);
  document.addEventListener('visibilitychange', () => pause('hidden', document.hidden));
  document.addEventListener('luokixi:story', e => pause('story', e.detail.open));
  motion.addEventListener('change', () => { cancelDrag(); if (motion.matches) playing = false; go(active, { instant: true }); });
  addEventListener('pagehide', () => { cancelDrag(); finish(); clearTimeout(autoTimer); progressAnimation?.cancel(); });
  addEventListener('pageshow', () => { finish(); schedule(); });
  sync(); prepare(); draw(); schedule();
  return { go, next, prev, pause, enter() {}, get index() { return active; } };
}
