// Brand, letters and board chips hand off to the real navigation. Only transform/opacity animate.
// The SVG stays static: animating its stroke used to repaint the full opening overlay each frame.
// Once per tab session. A click/key skips from the current presentation in 180ms.
// 首页被浏览器预先渲染时（悬停在“首页”上），等真正切过来那一刻再播，不在后台白白播完。
const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
const MIN_MS = 1100;
const MAX_MS = 1800;

const anim = (el, frames, opts) => el.animate(frames, { fill: 'both', easing: EASE, ...opts });

export function playOpening(tasks = []) {
  const root = document.documentElement;
  if (!root.classList.contains('intro-pending')) return Promise.resolve(false);
  if (document.prerendering)
    return new Promise((r) => document.addEventListener('prerenderingchange', () => r(playOpening(tasks)), { once: true }));

  const mobile = matchMedia('(max-width: 760px)').matches;
  // 目标：桌面飞到顶栏的板块链接，手机飞到底部标签栏
  const targets = [...document.querySelectorAll(mobile ? '.tabbar a' : '.gn-links a')];
  const words = targets.map((a) => a.textContent.trim());

  const el = document.createElement('div');
  el.className = 'op';
  el.style.contain = 'layout paint';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = `
    <div class="op-core">
      <svg class="op-mark" viewBox="0 0 28 28">
        <defs><linearGradient id="op-grad" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stop-color="#0894ff"/><stop offset=".45" stop-color="#c959dd"/>
          <stop offset=".75" stop-color="#ff2e54"/><stop offset="1" stop-color="#ff9004"/>
        </linearGradient></defs>
        <path d="M5 6v16h18M10 17l5-10 4 6 5-9"/>
      </svg>
      <div class="op-word">${[...'Luokixi'].map((c) => `<span>${c}</span>`).join('')}</div>
      <p class="op-sub">今天，矿大发生了什么</p>
      <div class="op-boards">${words.map((w) => `<span>${w}</span>`).join('')}</div>
    </div>
    <div class="op-bar"><i></i></div>`;
  document.body.append(el);
  root.classList.remove('intro-pending');
  document.body.style.overflow = 'hidden';

  const mark = el.querySelector('.op-mark');
  anim(mark, [{ opacity: 0, transform: 'translateY(10px) scale(0.94)' }, { opacity: 1, transform: 'none' }], { duration: 480 });
  el.querySelectorAll('.op-word span').forEach((s, i) =>
    anim(s, [{ transform: 'translateY(70%)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 440, delay: 120 + i * 34 }),
  );
  anim(el.querySelector('.op-sub'), [{ transform: 'translateY(8px)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 360, delay: 320 });
  const chips = [...el.querySelectorAll('.op-boards span')];
  chips.forEach((s, i) =>
    anim(s, [{ transform: 'translateY(14px) scale(0.92)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 360, delay: 500 + i * 42 }),
  );

  // 真实进度：首页的几项数据加载完一项走一格
  const bar = el.querySelector('.op-bar i');
  let done = 0;
  const bump = () => { done++; if (!leaving && el.isConnected) bar.style.transform = `scaleX(${done / Math.max(1, tasks.length)})`; };
  const ready = Promise.allSettled(tasks.map((t) => Promise.resolve(t).finally(bump)));

  let resolveStart;
  const start = new Promise((r) => (resolveStart = r));
  let leaving = false;

  const exit = (event) => {
    if (leaving) return;
    leaving = true;
    removeEventListener('keydown', exit);
    el.style.pointerEvents = 'none';
    document.body.style.overflow = '';
    // Capture all current values before writing/cancelling, so a skip never flashes
    // hidden chips or resets a half-finished transform to its logical endpoint.
    const presentations = [...el.querySelectorAll('.op-mark,.op-word span,.op-sub,.op-boards span,.op-bar i')].map(node => {
      const style = getComputedStyle(node);
      return { node, transform: style.transform, opacity: style.opacity };
    });
    const complete = () => { el.remove(); resolveStart(true); };
    if (event?.type) {
      presentations.forEach(({ node, transform, opacity }) => { node.style.transform = transform; node.style.opacity = opacity; });
      el.getAnimations({ subtree: true }).forEach(animation => animation.cancel());
      anim(el, [{ opacity: 1 }, { opacity: 0 }], { duration: 180 }).finished.then(complete, complete);
      return;
    }
    const chipRects = chips.map((chip, i) => ({ from: chip.getBoundingClientRect(), to: targets[i]?.getBoundingClientRect(), height: chip.offsetHeight }));
    const brand = document.querySelector('.gn-brand')?.getBoundingClientRect();
    const m = mark.getBoundingClientRect();
    presentations.forEach(({ node, transform, opacity }) => { node.style.transform = transform; node.style.opacity = opacity; });
    el.getAnimations({ subtree: true }).forEach(animation => animation.cancel());
    chips.forEach((chip, i) => {
      const { from, to, height } = chipRects[i];
      if (!to?.width) return;
      const matrix = new DOMMatrixReadOnly(chip.style.transform === 'none' ? undefined : chip.style.transform);
      const dx = matrix.e + to.left + to.width / 2 - (from.left + from.width / 2);
      const dy = matrix.f + to.top + to.height / 2 - (from.top + from.height / 2);
      const k = Math.min(1, (to.height || 12) / height);
      anim(chip, [{ transform: chip.style.transform, opacity: chip.style.opacity }, { transform: `translate(${dx}px, ${dy}px) scale(${k})`, opacity: 0.15 }], { duration: 400, delay: i * 16 });
    });
    if (brand) {
      anim(mark, [{ transform: mark.style.transform }, { transform: `translate(${brand.left + 11 - (m.left + m.width / 2)}px, ${brand.top + brand.height / 2 - (m.top + m.height / 2)}px) scale(${22 / m.width})` }], { duration: 400 });
    }
    anim(el.querySelector('.op-word'), [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(0.96)' }], { duration: 220 });
    anim(el.querySelector('.op-sub'), [{ opacity: el.querySelector('.op-sub').style.opacity }, { opacity: 0 }], { duration: 160 });
    anim(el.querySelector('.op-bar'), [{ opacity: 1 }, { opacity: 0 }], { duration: 120 });
    // Reveal the rendered page once, without overlapping another hero entrance.
    anim(el, [{ opacity: 1 }, { opacity: 0 }], { duration: 380, delay: 100, easing: 'ease-out' }).finished.then(complete, complete);
  };

  Promise.race([
    Promise.all([ready, new Promise((r) => setTimeout(r, MIN_MS))]),
    new Promise((r) => setTimeout(r, MAX_MS)),
  ]).then(exit);
  el.addEventListener('click', exit);
  addEventListener('keydown', exit);
  return start;
}
