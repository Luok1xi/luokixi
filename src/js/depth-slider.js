// 空间感图片滑轨：照 Agrumea Farm 产品详情页下面那条照片轨（GSAP Showcase 收录）。
// 照片装在固定画框里、比画框宽，随滑动反向平移，滑起来有纵深。视差本身是纯 CSS（depth-slider.css 的滚动驱动动画）；
// 这里补：桌面拖拽 + 惯性、前后按钮和页码，以及不支持滚动驱动动画的浏览器的手动视差。
// 原生横向滚动、吸附、触屏惯性、键盘（← →）都保留。
import { esc } from './data.js';
import { springStep } from './spring-step.js';
import { SPRINGS } from './motion.js';
import '../styles/depth-slider.css';

const preference = matchMedia('(prefers-reduced-motion: reduce)');
const reduced = () => preference.matches;
const nativeParallax = CSS.supports('animation-timeline: view()');
const snapSpring = { stiffness: ((2 * Math.PI) / SPRINGS.smooth.response) ** 2, damping: SPRINGS.smooth.damping };
const ARROW = { prev: '<path d="m14.5 5.5-6.5 6.5 6.5 6.5"/>', next: '<path d="m9.5 5.5 6.5 6.5-6.5 6.5"/>' };

// 画框 + 照片的标记（地址和说明会转义）
export function depthSlides(urls, alt = '照片', { open = false } = {}) {
  return urls.map((src, i) => `<span class="ds-frame${urls.length === 1 ? ' is-still' : ''}" style="--i:${i}"${open ? ` role="button" tabindex="0" data-image-open="${i}" aria-label="放大查看第 ${i + 1} 张图片"` : ''}><img class="ds-img" src="${esc(src)}" alt="${esc(alt)}，第 ${i + 1} 张" loading="lazy" decoding="async" draggable="false"></span>`).join('');
}

/** 给 .ds-track 装上拖拽、按钮和页码；返回卸载函数 */
export function mountDepthSlider(track, { controls = true, enter = true } = {}) {
  if (!track || track.dataset.depthSlider === 'on') return () => {};
  const frames = [...track.querySelectorAll('.ds-frame')];
  if (frames.length < 2) return () => {};
  track.dataset.depthSlider = 'on';
  track.tabIndex = 0;
  track.setAttribute('role', 'region');
  track.setAttribute('aria-roledescription', '照片滑轨');
  track.setAttribute('aria-label', `${frames.length} 张照片，左右键切换`);
  if (enter) track.classList.add('ds-enter');
  const ac = new AbortController();
  const { signal } = ac;
  let raf = 0, motion = null, drag = null, suppress = false, suppressTimer = 0;
  let geometry = null, paintedIndex = -1;
  const measure = () => geometry ??= {view: track.clientWidth, width: track.scrollWidth,
    frames: frames.map(f => ({left:f.offsetLeft, width:f.offsetWidth}))};

  // 还没显示出来（比如对话框还没打开）时尺寸都是 0，页码按第一张算
  const step = () => { const m = measure(); return (m.frames[1].left - m.frames[0].left) || m.view; };
  const index = () => {
    const w = step();
    return w > 0 ? Math.max(0, Math.min(frames.length - 1, Math.round(track.scrollLeft / w))) : 0;
  };
  const clamp = value => Math.max(0, Math.min(measure().width - measure().view, value));

  let ui = null;
  if (controls) {
    ui = document.createElement('div');
    ui.className = 'ds-ui';
    ui.innerHTML = `<button type="button" class="ds-btn" data-ds="prev" aria-label="上一张"><svg viewBox="0 0 24 24" aria-hidden="true">${ARROW.prev}</svg></button><span class="ds-count num" aria-live="polite"></span><button type="button" class="ds-btn" data-ds="next" aria-label="下一张"><svg viewBox="0 0 24 24" aria-hidden="true">${ARROW.next}</svg></button>`;
    track.after(ui);
    ui.addEventListener('click', (e) => {
      const b = e.target.closest('[data-ds]');
      if (b) go(index() + (b.dataset.ds === 'next' ? 1 : -1));
    }, { signal });
  }

  // 不支持滚动驱动动画时，手动算视差（只写 transform）
  const manual = () => !nativeParallax && !reduced();
  const imgs = frames.map((f) => f.querySelector('.ds-img'));
  const count = ui?.querySelector('.ds-count'), previous = ui?.querySelector('[data-ds="prev"]'), next = ui?.querySelector('[data-ds="next"]');
  const paint = () => {
    if (!ui && !manual()) return;
    const m = measure(), left = track.scrollLeft, i = index();
    if (ui) {
      if (i !== paintedIndex) { count.textContent = `${i + 1} / ${frames.length}`; paintedIndex = i; }
      if (previous.disabled !== (left < 4)) previous.disabled = left < 4;
      if (next.disabled !== (left > m.width - m.view - 4)) next.disabled = left > m.width - m.view - 4;
    }
    if (!manual()) return;
    const view = m.view, x0 = m.frames[0].left;
    m.frames.forEach((f, k) => {
      const w = f.width, position = f.left - x0 - left;
      if (position > view + w || position + w < -w) return;
      const p = Math.max(0, Math.min(1, (view - position) / (view + w)));
      const t = (p - 0.5) * 2;
      imgs[k].style.transform = `translate3d(${(t * 10.9).toFixed(2)}%, 0, 0) scale(${(1 + Math.abs(t) * 0.06).toFixed(4)})`;
    });
  };
  // One display-synced callback owns dragging, settling and the fallback paint.
  const flushDrag = () => {
    if (!drag?.pending) return;
    drag.pending = false;
    track.scrollLeft = clamp(drag.left - (drag.lx - drag.x));
  };
  const finish = target => {
    motion = null;
    track.scrollTo({ left: target, behavior: 'instant' });
    track.classList.remove('is-dragging');
  };
  const tick = now => {
    raf = 0;
    flushDrag();
    if (motion) {
      const m = motion, dt = Math.max(0, (now - m.at) / 1000);
      [m.position, m.velocity] = springStep(m.position, m.velocity, m.target, dt, snapSpring);
      m.at = now;
      const position = clamp(m.position);
      const atEdge = position !== m.position;
      if (atEdge || (Math.abs(m.position - m.target) < .5 && Math.abs(m.velocity) < 10)) finish(m.target);
      else track.scrollLeft = position;
    }
    paint();
    if (motion) schedule();
  };
  const schedule = () => {
    if (!raf && !signal.aborted && (drag?.pending || motion || ui || manual())) raf = requestAnimationFrame(tick);
  };
  // Native scroll timelines already animate previews; don't enqueue empty JS frames.
  if (ui || !nativeParallax) track.addEventListener('scroll', schedule, { passive: true, signal });
  // 从隐藏到显示、窗口变化：尺寸一变就重算
  const ro = new ResizeObserver(() => { geometry = null; schedule(); });
  ro.observe(track);
  // Every frame has the same grid column width; the first frame covers column changes.
  ro.observe(frames[0]);
  signal.addEventListener('abort', () => ro.disconnect());
  paint();

  const releaseCapture = pointer => {
    if (pointer && track.hasPointerCapture(pointer.id)) track.releasePointerCapture(pointer.id);
  };
  const interrupt = () => {
    cancelAnimationFrame(raf); raf = 0;
    const pointer = drag; drag = null; motion = null;
    releaseCapture(pointer);
    // Stop a browser smooth-scroll from the current presentation position too.
    track.scrollTo({ left: track.scrollLeft, behavior: 'instant' });
    track.classList.remove('is-dragging');
  };
  const snap = (target, velocity = 0) => {
    const from = track.scrollLeft;
    target = clamp(Number.isFinite(target) ? target : from);
    if (reduced() || (Math.abs(from - target) < .5 && Math.abs(velocity) < 10)) {
      finish(target); schedule(); return;
    }
    track.classList.add('is-dragging');
    motion = { position: from, target, velocity, at: performance.now() };
    schedule();
  };
  const go = i => {
    interrupt(); geometry = null;
    // Buttons and keys keep the browser's smooth scrolling; only mouse release needs a spring.
    track.scrollTo({ left: clamp(Math.max(0, Math.min(frames.length - 1, i)) * step()),
      behavior: reduced() ? 'instant' : 'smooth' });
  };
  // 键盘
  track.closest('a')?.addEventListener('dragstart', event => event.preventDefault(), { signal });
  track.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    go(index() + (e.key === 'ArrowRight' ? 1 : -1));
  }, { signal });

  track.addEventListener('wheel', () => {
    if (drag || motion) { interrupt(); schedule(); }
  }, { passive: true, signal });
  // Preserve pointer speed across release; momentum and snap now share one spring.
  track.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse') { interrupt(); return; }
    if (e.button !== 0) return;
    interrupt(); geometry = null; measure();
    track.classList.add('is-dragging');
    drag = { x: e.clientX, left: track.scrollLeft, lx: e.clientX, lt: e.timeStamp,
      samples: [{ x: e.clientX, t: e.timeStamp }], pending: false, moved: false, id: e.pointerId };
  }, { signal });
  track.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    if (!drag.moved && Math.abs(dx) < 5) return;
    if (!drag.moved) {
      drag.moved = true;
      track.setPointerCapture(e.pointerId);
    }
    drag.lx = e.clientX;
    drag.lt = e.timeStamp;
    drag.samples.push({ x: e.clientX, t: e.timeStamp });
    while (drag.samples.length > 2 && drag.samples[0].t < e.timeStamp - 80) drag.samples.shift();
    drag.pending = true;
    schedule();
  }, { signal });
  const release = e => {
    if (!drag || e.pointerId !== drag.id) return;
    flushDrag();
    const d = drag;
    drag = null; releaseCapture(d);
    if (!d.moved) { track.classList.remove('is-dragging'); schedule(); return; }
    suppress = true;
    clearTimeout(suppressTimer);
    suppressTimer = setTimeout(() => { suppress = false; suppressTimer = 0; }, 0);
    const first = d.samples[0], last = d.samples.at(-1);
    const velocity = e.type === 'pointerup' && e.timeStamp - d.lt < 80
      ? -(last.x - first.x) / Math.max(1, last.t - first.t) : 0;
    const from = track.scrollLeft, projected = clamp(from + velocity * 192);
    const distance = step(), target = distance > 0 ? Math.round(projected / distance) * distance : 0;
    const outward = (from <= .5 && velocity <= 0) || (from >= clamp(Infinity) - .5 && velocity >= 0);
    snap(target, outward ? 0 : velocity * 1000);
  };
  track.addEventListener('pointerup', release, { signal });
  track.addEventListener('pointercancel', release, { signal });
  track.addEventListener('lostpointercapture', e => release({ pointerId: e.pointerId, type: 'pointercancel' }), { signal });
  track.addEventListener('pointerleave', () => {
    if (drag && !drag.moved) { interrupt(); schedule(); }
  }, { signal });
  // 拖完松手不算点击
  track.addEventListener('click', (e) => { if (suppress) { e.preventDefault(); e.stopPropagation(); } }, { capture: true, signal });
  preference.addEventListener('change', () => {
    if (reduced() && motion) finish(motion.target);
    imgs.forEach(image => { image.style.transform = ''; });
    schedule();
  }, { signal });

  return () => {
    interrupt();
    ac.abort();
    clearTimeout(suppressTimer);
    track.classList.remove('ds-enter');
    imgs.forEach(image => { image.style.transform = ''; });
    ui?.remove();
    delete track.dataset.depthSlider;
  };
}

// The same rail is mounted after each asynchronous preview render.
export function mountDepthPreviews(scope, options = {}) {
  const disposers = [...scope.querySelectorAll('.ds-track')].map(track => mountDepthSlider(track, { controls:false, enter:false, ...options }));
  return () => disposers.forEach(dispose => dispose());
}
