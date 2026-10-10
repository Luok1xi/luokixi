// 液态金属按钮（.lm）：交互模型改编自 ThreeUI 的 LiquidMetalButton / Sylva 首屏按钮
// （MIT License，Copyright (c) 2026 Meng To，https://github.com/MengTo/threeui；许可证全文见 THIRD_PARTY_NOTICES.md）。
// 原作是每个按钮一个 WebGL 画布、一直在画；这里用 CSS 图层重做，静止时完全不耗电：
// 没有 rAF 循环、没有观察器；鼠标移动合并到一帧里写一次。
//   - 鼠标移上去（或键盘聚焦）：底部亮起一汪“熔化的金属”，边缘的彩色高光跟着光标微微转动
//   - 按下：高光一下子变亮，从按下的位置荡开一圈波纹；松手慢慢暗回去
//   - aria-busy="true"（真的在请求时）：边缘高光绕一圈一圈转
// 用法：<a class="lm"><span class="lm-label">打开</span></a>；放在图片或深色卡片上加 .is-glass。
// 每屏最多一个，只给真正的主操作。
const reduce = matchMedia('(prefers-reduced-motion: reduce)');
const LAYERS = '<span class="lm-metal" aria-hidden="true"><i class="lm-pool"></i></span><span class="lm-rim" aria-hidden="true"><i></i></span>';
const REST = 318; // 静止时高光的方向（左上方的灯），和 --lm-a 一致
const done = new WeakSet();

function enhance(el) {
  if (done.has(el)) return;
  done.add(el);
  el.querySelectorAll(':scope > .lm-metal, :scope > .lm-rim').forEach((n) => n.remove()); // 克隆来的旧图层
  if (!el.querySelector(':scope > .lm-label')) {
    const label = document.createElement('span');
    label.className = 'lm-label';
    label.append(...el.childNodes);
    el.append(label);
  }
  el.insertAdjacentHTML('afterbegin', LAYERS);
  const metal = el.firstElementChild;
  const pool = metal.firstElementChild;
  const lobe = el.querySelector('.lm-rim > i');
  const on = { over: false, press: false, focus: false };
  let box = null, frame = 0, px = 0, py = 0;

  const off = () => el.matches(':disabled, [aria-disabled="true"]');
  const sync = () => {
    el.classList.toggle('is-hot', on.over || on.press || on.focus);
    el.classList.toggle('is-press', on.press);
    if (!on.over && !on.press) { pool.style.translate = ''; lobe.style.rotate = ''; }
  };
  // 原作的高光并不直指光标，而是绕着固定的灯光方向左右摆（横向约 ±0.30 rad、纵向 ±0.15 rad），读起来像一圈被照亮的边
  const aim = () => {
    frame = 0;
    if (!box || reduce.matches || !(on.over || on.press)) return;
    const nx = Math.max(-1, Math.min(1, (px - box.left - box.width / 2) / (box.width / 2)));
    const ny = Math.max(-1, Math.min(1, (py - box.top - box.height / 2) / (box.height / 2)));
    lobe.style.rotate = `${(REST + nx * 17 + ny * 8.6).toFixed(1)}deg`;
    pool.style.translate = `${(nx * box.width * 0.24).toFixed(1)}px 0`;
  };
  const move = (e) => { px = e.clientX; py = e.clientY; if (!frame) frame = requestAnimationFrame(aim); };
  const ripple = (x, y) => {
    if (reduce.matches) return;
    const r = document.createElement('i');
    r.className = 'lm-ripple';
    r.style.cssText = `--x:${x.toFixed(1)}px;--y:${y.toFixed(1)}px`;
    const gone = () => r.remove();
    r.addEventListener('animationend', gone, { once: true });
    setTimeout(gone, 1200);
    metal.append(r);
  };

  el.addEventListener('pointerenter', (e) => {
    if (e.pointerType !== 'mouse' || off()) return;
    box = el.getBoundingClientRect();
    on.over = true; sync(); move(e);
  });
  el.addEventListener('pointermove', move, { passive: true });
  el.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') { on.over = false; sync(); } });
  el.addEventListener('pointerdown', (e) => {
    if (off() || e.button > 0) return;
    box = el.getBoundingClientRect();
    on.press = true; sync(); move(e);
    ripple(e.clientX - box.left, e.clientY - box.top);
    const ac = new AbortController();
    const up = () => { on.press = false; sync(); ac.abort(); };
    addEventListener('pointerup', up, { signal: ac.signal });
    addEventListener('pointercancel', up, { signal: ac.signal });
  });
  // 只有键盘聚焦才保持亮着；鼠标点完不该一直发光
  el.addEventListener('focus', () => { on.focus = el.matches(':focus-visible'); sync(); });
  el.addEventListener('blur', () => { on.focus = false; sync(); });
  el.addEventListener('keydown', (e) => {
    const activates = e.key === 'Enter' || (e.key === ' ' && el.tagName === 'BUTTON');
    if (!activates || e.repeat || off()) return;
    on.press = true; sync(); ripple(el.offsetWidth / 2, el.offsetHeight / 2);
  });
  el.addEventListener('keyup', () => { if (on.press) { on.press = false; sync(); } });
}

export function mountLiquid(scope = document) {
  scope.querySelectorAll?.('.lm').forEach(enhance);
}
