// 空间感图片滑轨：照 Agrumea Farm 产品详情页下面那条照片轨（GSAP Showcase 收录）。
// 照片装在固定画框里、比画框宽，随滑动反向平移，滑起来有纵深。视差本身是纯 CSS（depth-slider.css 的滚动驱动动画）；
// 这里补：桌面拖拽 + 惯性、前后按钮和页码，以及不支持滚动驱动动画的浏览器的手动视差。
// 原生横向滚动、吸附、触屏惯性、键盘（← →）都保留。
import { esc } from './data.js';
import '../styles/depth-slider.css';

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const ARROW = { prev: '<path d="m14.5 5.5-6.5 6.5 6.5 6.5"/>', next: '<path d="m9.5 5.5 6.5 6.5-6.5 6.5"/>' };

// 画框 + 照片的标记（地址和说明会转义）
export function depthSlides(urls, alt = '照片') {
  if (urls.length === 1) return `<span class="ds-frame is-still"><img class="ds-img" src="${esc(urls[0])}" alt="${esc(alt)}" loading="lazy" decoding="async" draggable="false"></span>`;
  return urls.map((src, i) => `<span class="ds-frame" style="--i:${i}"><img class="ds-img" src="${esc(src)}" alt="${esc(alt)}，第 ${i + 1} 张" loading="lazy" decoding="async" draggable="false"></span>`).join('');
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
  let raf = 0, glide = 0, drag = null, suppress = false;
  let geometry = null, paintedIndex = -1;
  const measure = () => geometry ??= {view: track.clientWidth, width: track.scrollWidth,
    frames: frames.map(f => ({left:f.offsetLeft, width:f.offsetWidth}))};

  // 还没显示出来（比如对话框还没打开）时尺寸都是 0，页码按第一张算
  const step = () => { const m = measure(); return (m.frames[1].left - m.frames[0].left) || m.view; };
  const index = () => {
    const w = step();
    return w > 0 ? Math.max(0, Math.min(frames.length - 1, Math.round(track.scrollLeft / w))) : 0;
  };
  const go = (i) => track.scrollTo({ left: Math.max(0, Math.min(frames.length - 1, i)) * step(), behavior: reduced() ? 'auto' : 'smooth' });

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
  const manual = !CSS.supports('animation-timeline: view()') && !reduced();
  const imgs = frames.map((f) => f.querySelector('.ds-img'));
  const count = ui?.querySelector('.ds-count'), previous = ui?.querySelector('[data-ds="prev"]'), next = ui?.querySelector('[data-ds="next"]');
  const paint = () => {
    raf = 0;
    const m = measure(), left = track.scrollLeft, i = index();
    if (ui) {
      if (i !== paintedIndex) { count.textContent = `${i + 1} / ${frames.length}`; paintedIndex = i; }
      if (previous.disabled !== (left < 4)) previous.disabled = left < 4;
      if (next.disabled !== (left > m.width - m.view - 4)) next.disabled = left > m.width - m.view - 4;
    }
    if (!manual) return;
    const view = m.view, x0 = m.frames[0].left;
    m.frames.forEach((f, k) => {
      const w = f.width, position = f.left - x0 - left;
      if (position > view + w || position + w < -w) return;
      const p = Math.max(0, Math.min(1, (view - position) / (view + w)));
      const t = (p - 0.5) * 2;
      imgs[k].style.transform = `translate3d(${(t * 10.9).toFixed(2)}%, 0, 0) scale(${(1 + Math.abs(t) * 0.06).toFixed(4)})`;
    });
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(paint); };
  track.addEventListener('scroll', schedule, { passive: true, signal });
  // 从隐藏到显示、窗口变化：尺寸一变就重算
  const ro = new ResizeObserver(() => { geometry = null; schedule(); });
  ro.observe(track);
  frames.forEach(frame => ro.observe(frame));
  signal.addEventListener('abort', () => ro.disconnect());
  paint();

  // 键盘
  track.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    go(index() + (e.key === 'ArrowRight' ? 1 : -1));
  }, { signal });

  // 桌面拖拽：拖的时候关掉吸附，松手后按速度滑一段，再吸到最近的一张
  const settle = () => {
    track.classList.remove('is-dragging');
    go(index());
  };
  track.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    cancelAnimationFrame(glide);
    drag = { x: e.clientX, left: track.scrollLeft, lx: e.clientX, lt: e.timeStamp, v: 0, moved: false, id: e.pointerId };
  }, { signal });
  track.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    if (!drag.moved && Math.abs(dx) < 5) return;
    if (!drag.moved) {
      drag.moved = true;
      track.setPointerCapture(e.pointerId);
      track.classList.add('is-dragging');
    }
    track.scrollLeft = drag.left - dx;
    const dt = Math.max(1, e.timeStamp - drag.lt);
    drag.v = drag.v * 0.6 + ((e.clientX - drag.lx) / dt) * 0.4;
    drag.lx = e.clientX;
    drag.lt = e.timeStamp;
  }, { signal });
  const release = () => {
    if (!drag) return;
    const { moved, v } = drag;
    drag = null;
    if (!moved) return;
    suppress = true;
    setTimeout(() => { suppress = false; }, 0);
    let vel = -v, last = performance.now();
    if (reduced() || Math.abs(vel) < .06) { settle(); return; }
    const tick = (now) => {
      const dt = Math.min(48, now - last), decay = Math.exp(-dt / 192); last = now;
      track.scrollLeft += vel * 192 * (1 - decay);
      vel *= decay;
      if (Math.abs(vel) > .038) glide = requestAnimationFrame(tick);
      else settle();
    };
    glide = requestAnimationFrame(tick);
  };
  track.addEventListener('pointerup', release, { signal });
  track.addEventListener('pointercancel', release, { signal });
  // 拖完松手不算点击
  track.addEventListener('click', (e) => { if (suppress) { e.preventDefault(); e.stopPropagation(); } }, { capture: true, signal });

  return () => {
    ac.abort();
    cancelAnimationFrame(raf);
    cancelAnimationFrame(glide);
    ui?.remove();
    delete track.dataset.depthSlider;
  };
}
