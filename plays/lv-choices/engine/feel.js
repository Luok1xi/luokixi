/* =====================================================================
   feel.js —— 手感：弹簧曲线 · 按下去的回弹 · 点哪里冒小心心 · 按钮上的小声音
   ---------------------------------------------------------------------
   1. 弹簧：和 iOS 一样用阻尼弹簧，不用普通的缓动曲线。
        GSAP 里：ease: 'spring'（轻微回弹）/ 'springPop'（Q 弹）/ 'springSoft'（不回弹，稳稳停住）
        CSS 里：var(--spring) / var(--spring-pop) / var(--spring-soft)（linear() 采样出来的同一条曲线）
   2. 按下去：所有按钮用独立的 scale 属性缩一下，松手弹回来（不和各自的 transform 打架）。
   3. 点一下舞台：冒几颗小心心 / 星星（第一章粉色，第二章冷蓝，黑卡纸上是金粉）。
      用 Web Animations，只动 transform 和 opacity，全程在合成线程上跑。
   4. 小声音：按钮被点时，按种类说一个音节（audio.js 的 LV.audio.voice）。
      情绪重的地方（描字、翻书、删掉、揭纸条）不出声。
   ===================================================================== */
(function () {
  'use strict';
  const LV = window.LV;
  const gsap = window.gsap;

  /* ------------------------------------------------------------------
     弹簧
     ------------------------------------------------------------------ */
  function spring(zeta, omega) {
    const f = zeta < 1
      ? (t) => {
        const wd = omega * Math.sqrt(1 - zeta * zeta);
        return 1 - Math.exp(-zeta * omega * t) * (Math.cos(wd * t) + ((zeta * omega) / wd) * Math.sin(wd * t));
      }
      : (t) => 1 - Math.exp(-omega * t) * (1 + omega * t);
    const end = f(1);
    return (t) => (t >= 1 ? 1 : t <= 0 ? 0 : f(t) / end);
  }
  const SPRINGS = {
    spring: spring(0.74, 9.4),        // iOS 默认那种：过冲 3%，干脆
    springPop: spring(0.55, 12),      // Q 弹：过冲 12%，按钮、贴纸、心心
    springSoft: spring(1, 8.2),       // 不过冲：大面板、翻页、镜头
  };
  Object.keys(SPRINGS).forEach((k) => gsap.registerEase(k, SPRINGS[k]));
  LV.springs = SPRINGS;

  // 同一条曲线给 CSS 用：linear() 采样 40 个点（老浏览器退回 cubic-bezier）
  const css = Object.keys(SPRINGS).map((k) => {
    const pts = [];
    for (let i = 0; i <= 40; i++) pts.push(SPRINGS[k](i / 40).toFixed(4));
    return `--${k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}: linear(${pts.join(',')});`;
  }).join('');
  const style = document.createElement('style');
  style.textContent =
    ':root{--spring:cubic-bezier(.2,.9,.25,1.08);--spring-pop:cubic-bezier(.34,1.56,.64,1);--spring-soft:cubic-bezier(.22,1,.36,1)}' +
    `@supports (transition-timing-function: linear(0, 1)) { :root { ${css} } }`;
  document.head.appendChild(style);

  // iPhone 的 Safari：不挂一个 touchstart，:active 就不会触发
  document.addEventListener('touchstart', () => {}, { passive: true });

  /* ------------------------------------------------------------------
     点一下，冒小心心
     ------------------------------------------------------------------ */
  const stage = document.getElementById('stage');
  const HEART = '<svg viewBox="0 0 100 100"><path d="M50 88 C18 64 6 46 8 30 C10 14 30 6 50 26 C70 6 90 14 92 30 C94 46 82 64 50 88Z"/></svg>';
  const STAR = '<svg viewBox="0 0 100 100"><path d="M50 4 C54 36 64 46 96 50 C64 54 54 64 50 96 C46 64 36 54 4 50 C36 46 46 36 50 4Z"/></svg>';
  const PALETTE = {
    gloss: ['#ff8fb8', '#ffb3cf', '#f6d27a', '#c9b3ff', '#ffffff'],
    glass: ['#9fc6f5', '#d9ecff', '#ffffff', '#b9c8ff'],
    paper: ['#f6d27a', '#fff3c4', '#f4a6c8'],
  };
  const reduced = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let lastTap = 0;
  function sparkle(x, y) {
    const m = stage.dataset.medium || 'gloss';
    const quiet = m === 'paper' || m === 'real' || m === 'collage' || stage.classList.contains('her-world');
    const cols = quiet ? PALETTE.paper : PALETTE[m] || PALETTE.gloss;
    const n = quiet ? 4 : 6;
    for (let i = 0; i < n; i++) {
      const el = document.createElement('i');
      el.className = 'fx-tap' + (quiet ? ' dust' : '');
      el.innerHTML = quiet ? '' : Math.random() < 0.55 ? HEART : STAR;
      const size = quiet ? LV.rand(5, 9) : LV.rand(16, 30);
      el.style.cssText = `left:${x}px;top:${y}px;width:${size}px;height:${size}px;color:${LV.pick(cols)};background:${quiet ? 'currentColor' : 'none'}`;
      stage.appendChild(el);
      const a = -Math.PI / 2 + LV.rand(-1.3, 1.3), d = LV.rand(40, quiet ? 70 : 110);
      const dx = Math.cos(a) * d, dy = Math.sin(a) * d;
      const rot = LV.rand(-40, 40);
      const anim = el.animate([
        { transform: 'translate(-50%,-50%) scale(.2) rotate(0deg)', opacity: 0 },
        { transform: `translate(calc(-50% + ${dx * 0.55}px), calc(-50% + ${dy * 0.55}px)) scale(1.1) rotate(${rot * 0.6}deg)`, opacity: 1, offset: 0.35 },
        { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy + 26}px)) scale(.6) rotate(${rot}deg)`, opacity: 0 },
      ], { duration: LV.rand(620, 900), easing: 'cubic-bezier(.2,.8,.3,1)' });
      anim.onfinish = () => el.remove();
    }
  }
  stage.addEventListener('pointerdown', (e) => {
    if (reduced() || LV.play.skipping()) return;
    const now = performance.now();
    if (now - lastTap < 90) return;
    lastTap = now;
    const p = LV.toStage(e.clientX, e.clientY);
    sparkle(p.x, p.y);
  }, { passive: true });
  LV.feel = { sparkle };

  /* ------------------------------------------------------------------
     按钮上的小声音
     ------------------------------------------------------------------ */
  const V = (n) => LV.audio && LV.audio.voice && LV.audio.voice(n);
  const cute = () => {
    const m = stage.dataset.medium || 'gloss';
    return (m === 'gloss' || m === 'glass') && !stage.classList.contains('her-world');
  };
  const later = (fn) => setTimeout(fn, 0);                // 等按钮自己的处理先跑完，再看它变成了什么状态
  document.addEventListener('click', (e) => {
    const t = e.target.closest && e.target.closest('button, .choice, .slot, .t2-row');
    if (!t) return;
    const q = (s) => t.matches(s);
    if (q('#quickmenu button')) {
      const act = t.dataset.act;
      if (act === 'auto') later(() => V(LV.play.auto ? 'un' : 'unn'));
      else if (act === 'skip') later(() => V(LV.play.skip ? 'pyon' : 'unn'));
      else V({ save: 'hai', load: 'hai', log: 'nya', settings: 'un', files: 'pi', menu: 'hai' }[act] || 'ta');
    } else if (q('.side-btn')) V(t.dataset.k === '__back' || t.dataset.k === 'back' ? 'unn' : t.dataset.k === 'title' ? 'eh' : 'ta');
    else if (q('.toggle')) later(() => V(t.classList.contains('on') ? 'ya' : 'unn'));
    else if (q('[data-a=yes], [data-a=ok]')) V('hai');
    else if (q('[data-a=no]')) V('mou');
    else if (q('.pager button')) V('pi');
    else if (q('.slot')) V(t.classList.contains('ghost') ? 'eh' : 'ta');
    // Owner 10-01：游戏里的按钮只用普通的点击音；女孩子的声音只在开始界面（标题菜单）和开场动画里出现。
    else if (q('.t2-row')) LV.audio && LV.audio.voice && LV.audio.voice('hai', { girl: true });
  }, true);
})();
