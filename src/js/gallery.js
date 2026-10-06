// 苹果官网式横向画廊：原生滚动 + 吸附，右下角翻页按钮，底部圆点指示。
// 不劫持页面滚动；触控板、触屏、键盘（←/→）都能用。
// 结构：
// <div class="gallery" data-gallery>
//   <div class="gallery-scroller" tabindex="0">…卡片…</div>
//   <div class="gallery-ui"><div class="dotnav"></div><div class="paddles">
//     <button class="paddle paddle-prev">…</button><button class="paddle paddle-next">…</button></div></div>
// </div>
import { reducedMotion } from './shell.js';

export function initGallery(root) {
  const scroller = root.querySelector('.gallery-scroller');
  const items = [...scroller.children];
  const prev = root.querySelector('.paddle-prev');
  const next = root.querySelector('.paddle-next');
  const dotnav = root.querySelector('.dotnav');
  if (!items.length) return;

  dotnav.innerHTML = items
    .map((it, i) => `<button type="button" class="dot" aria-label="${it.dataset.label ?? `第 ${i + 1} 项`}"></button>`)
    .join('');
  const dots = [...dotnav.children];

  const pad = () => parseFloat(getComputedStyle(scroller).scrollPaddingInlineStart) || 0;
  const current = () => {
    const x = scroller.scrollLeft + pad();
    let best = 0;
    let bestD = Infinity;
    items.forEach((it, i) => {
      const d = Math.abs(it.offsetLeft - x);
      if (d < bestD) [best, bestD] = [i, d];
    });
    return best;
  };
  const go = (i) => {
    const k = Math.max(0, Math.min(items.length - 1, i));
    scroller.scrollTo({ left: items[k].offsetLeft - pad(), behavior: reducedMotion() ? 'auto' : 'smooth' });
  };

  let raf = 0;
  const update = () => {
    raf = 0;
    const i = current();
    const max = scroller.scrollWidth - scroller.clientWidth - 2;
    dots.forEach((d, k) => d.setAttribute('aria-current', String(k === i)));
    prev.disabled = scroller.scrollLeft <= 2;
    next.disabled = scroller.scrollLeft >= max;
  };
  const schedule = () => (raf ||= requestAnimationFrame(update));

  prev.addEventListener('click', () => go(current() - 1));
  next.addEventListener('click', () => go(current() + 1));
  dots.forEach((d, k) => d.addEventListener('click', () => go(k)));
  scroller.addEventListener('scroll', schedule, { passive: true });
  addEventListener('resize', schedule);
  update();
}
