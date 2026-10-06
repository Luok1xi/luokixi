// 首页开场：标志描线 → 品牌字升起 → 六个板块名排成一行 → 每个字飞回顶栏里自己的位置，页面同时淡入。
// 开场直接“接”到真实导航上，而不是播完再切。只用 Web Animations（不依赖 GSAP），除了标志描线外只动 transform 和 opacity。
// 每个标签页会话首次进入时播放；系统要求减少动态效果时不播；点任意处、按任意键立即进入；数据最多等 2.6 秒。
// 首页被浏览器预先渲染时（悬停在“首页”上），等真正切过来那一刻再播，不在后台白白播完。
const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
const MIN_MS = 1250;
const MAX_MS = 2600;

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

  const path = el.querySelector('path');
  const len = path.getTotalLength();
  path.style.strokeDasharray = len;
  anim(path, [{ strokeDashoffset: len }, { strokeDashoffset: 0 }], { duration: 900, easing: 'cubic-bezier(0.65, 0, 0.35, 1)' });
  el.querySelectorAll('.op-word span').forEach((s, i) =>
    anim(s, [{ transform: 'translateY(70%)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 700, delay: 220 + i * 45 }),
  );
  anim(el.querySelector('.op-sub'), [{ transform: 'translateY(8px)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 600, delay: 620 });
  const chips = [...el.querySelectorAll('.op-boards span')];
  chips.forEach((s, i) =>
    anim(s, [{ transform: 'translateY(14px) scale(0.92)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 560, delay: 760 + i * 70 }),
  );

  // 真实进度：首页的几项数据加载完一项走一格
  const bar = el.querySelector('.op-bar i');
  let done = 0;
  const bump = () => anim(bar, [{ transform: `scaleX(${done / Math.max(1, tasks.length)})` }, { transform: `scaleX(${++done / Math.max(1, tasks.length)})` }], { duration: 300 });
  const ready = Promise.allSettled(tasks.map((t) => Promise.resolve(t).finally(bump)));

  let resolveStart;
  const start = new Promise((r) => (resolveStart = r));
  let leaving = false;

  const exit = () => {
    if (leaving) return;
    leaving = true;
    removeEventListener('keydown', exit);
    el.style.pointerEvents = 'none';
    document.body.style.overflow = '';
    // 每个板块名从开场的位置飞到导航里的位置（FLIP：先量两边的位置，再只用 transform 过去）
    chips.forEach((chip, i) => {
      const to = targets[i]?.getBoundingClientRect();
      const from = chip.getBoundingClientRect();
      if (!to?.width) return;
      const dx = to.left + to.width / 2 - (from.left + from.width / 2);
      const dy = to.top + to.height / 2 - (from.top + from.height / 2);
      const k = Math.min(1, (to.height || 12) / from.height);
      anim(chip, [{ transform: 'none', opacity: 1 }, { transform: `translate(${dx}px, ${dy}px) scale(${k})`, opacity: 0.2 }], { duration: 620, delay: i * 24, easing: 'cubic-bezier(0.5, 0, 0.2, 1)' });
    });
    const brand = document.querySelector('.gn-brand')?.getBoundingClientRect();
    const mark = el.querySelector('.op-mark');
    if (brand) {
      const m = mark.getBoundingClientRect();
      anim(mark, [{ transform: 'none' }, { transform: `translate(${brand.left + 11 - (m.left + m.width / 2)}px, ${brand.top + brand.height / 2 - (m.top + m.height / 2)}px) scale(${22 / m.width})` }], { duration: 620, easing: 'cubic-bezier(0.5, 0, 0.2, 1)' });
    }
    anim(el.querySelector('.op-word'), [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(0.96)' }], { duration: 320 });
    anim(el.querySelector('.op-sub'), [{ opacity: 1 }, { opacity: 0 }], { duration: 240 });
    anim(el.querySelector('.op-bar'), [{ opacity: 1 }, { opacity: 0 }], { duration: 200 });
    anim(el, [{ opacity: 1 }, { opacity: 0 }], { duration: 520, delay: 300, easing: 'ease-out' }).finished.then(() => el.remove());
    setTimeout(() => resolveStart(true), 260);
  };

  Promise.race([
    Promise.all([ready, new Promise((r) => setTimeout(r, MIN_MS))]),
    new Promise((r) => setTimeout(r, MAX_MS)),
  ]).then(exit);
  el.addEventListener('click', exit);
  addEventListener('keydown', exit);
  return start;
}
