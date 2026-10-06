// 子导航里的锚点条：滚动时高亮当前分区，高亮底板像苹果的分段控件一样滑过去。
// <nav class="jumpbar"><a href="#y2025">2025</a>…<span class="jumpbar-pill"></span></nav>
import { reducedMotion } from './shell.js';

export function initJumpbar(bar) {
  const links = [...bar.querySelectorAll('a[href^="#"]')];
  const pill = bar.querySelector('.jumpbar-pill');
  const targets = links.map((a) => document.getElementById(decodeURIComponent(a.hash.slice(1)))).filter(Boolean);
  if (!targets.length) return;

  let active = null;
  const setActive = (a, instant = false) => {
    if (!a || a === active) return;
    active?.removeAttribute('aria-current');
    a.setAttribute('aria-current', 'true');
    active = a;
    pill.style.transition = instant || reducedMotion() ? 'none' : '';
    pill.style.width = `${a.offsetWidth}px`;
    pill.style.transform = `translateX(${a.offsetLeft}px)`;
    pill.style.opacity = '1';
    // 当前项滚进条的可视范围（手机上条会横向溢出）
    const left = a.offsetLeft - (bar.clientWidth - a.offsetWidth) / 2;
    bar.scrollTo({ left, behavior: instant || reducedMotion() ? 'auto' : 'smooth' });
  };

  // 视口上方 35% 处的那条线所在的分区即当前分区
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        setActive(links[targets.indexOf(e.target)]);
      });
    },
    { rootMargin: '-35% 0px -64% 0px' },
  );
  targets.forEach((t) => io.observe(t));

  requestAnimationFrame(() => setActive(links[0], true));
  addEventListener('resize', () => {
    if (!active) return;
    const a = active;
    active = null;
    setActive(a, true);
  });
}
