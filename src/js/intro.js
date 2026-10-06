// 开场动画（参考 lxj5820/dsh-boot-animation 的思路，MIT）：
//  · 进度条反映真实的数据加载，而不是假进度
//  · 交叉溶解：开场还在淡出时，首屏就开始入场，两者重叠，而不是播完再切
//  · 多层兜底：最短 1.5 秒保证完整感，最长 4.2 秒无论如何都放行
//  · 点击任意处 / 按任意键 / “跳过”立即进入；每个会话只播一次
import { gsap } from 'gsap';

const SESSION_KEY = 'lk-intro';
const MIN_MS = 1500;
const MAX_MS = 4200;
const OVERLAP_MS = 380;

export function playIntro(tasks) {
  const root = document.documentElement;
  if (!root.classList.contains('intro-pending')) return Promise.resolve(false);

  const el = document.createElement('div');
  el.className = 'intro';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = `
    <div class="intro-core">
      <svg class="intro-mark" viewBox="0 0 28 28">
        <defs>
          <linearGradient id="intro-grad" x1="0" y1="1" x2="1" y2="0">
            <stop offset="0" stop-color="#0894ff"/><stop offset=".45" stop-color="#c959dd"/>
            <stop offset=".75" stop-color="#ff2e54"/><stop offset="1" stop-color="#ff9004"/>
          </linearGradient>
        </defs>
        <path d="M5 6v16h18M10 17l5-10 4 6 5-9"/>
      </svg>
      <div class="intro-word">${[...'Luokixi'].map((c) => `<span>${c}</span>`).join('')}</div>
      <p class="intro-sub">四六级 · 矿大资料</p>
    </div>
    <div class="intro-bar"><i></i></div>
    <button class="intro-skip" type="button" tabindex="-1">跳过</button>`;
  document.body.append(el);
  root.classList.remove('intro-pending');
  document.body.style.overflow = 'hidden';
  try { sessionStorage.setItem(SESSION_KEY, '1'); } catch { /* 隐私模式 */ }

  const path = el.querySelector('path');
  const len = path.getTotalLength();
  gsap.set(path, { strokeDasharray: len, strokeDashoffset: len });

  gsap
    .timeline()
    .to(path, { strokeDashoffset: 0, duration: 1.1, ease: 'power2.inOut' })
    .from(
      el.querySelectorAll('.intro-word span'),
      { yPercent: 70, opacity: 0, filter: 'blur(10px)', duration: 0.8, stagger: 0.045, ease: 'power3.out' },
      0.32,
    )
    .from(el.querySelector('.intro-sub'), { opacity: 0, y: 8, duration: 0.6, ease: 'power2.out' }, 0.8);

  // 真实进度
  const bar = el.querySelector('.intro-bar i');
  let done = 0;
  const bump = () => gsap.to(bar, { scaleX: ++done / tasks.length, duration: 0.45, ease: 'power2.out' });
  const ready = Promise.allSettled(tasks.map((t) => Promise.resolve(t).finally(bump)));

  let resolveStart;
  const start = new Promise((r) => (resolveStart = r));
  let exiting = false;

  const exit = () => {
    if (exiting) return;
    exiting = true;
    removeEventListener('keydown', exit);
    el.style.pointerEvents = 'none';
    document.body.style.overflow = '';
    gsap.to(bar, { scaleX: 1, duration: 0.2 });
    gsap
      .timeline({ onComplete: () => el.remove() })
      .to(el.querySelector('.intro-core'), { scale: 1.14, filter: 'blur(16px)', opacity: 0, duration: 0.85, ease: 'power2.in' }, 0)
      .to(el.querySelector('.intro-bar'), { opacity: 0, duration: 0.3 }, 0)
      .to(el, { opacity: 0, duration: 0.9, ease: 'power1.inOut' }, 0.18);
    setTimeout(() => resolveStart(true), OVERLAP_MS);
  };

  Promise.race([
    Promise.all([ready, new Promise((r) => setTimeout(r, MIN_MS))]),
    new Promise((r) => setTimeout(r, MAX_MS)),
  ]).then(exit);
  el.addEventListener('click', exit);
  addEventListener('keydown', exit);

  return start;
}
