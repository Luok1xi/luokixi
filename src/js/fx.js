// 全站交互动效（Opus · 2026-10-07 第二版），样式在 src/styles/motion.css。
// Apple 的做法：大东西走顺滑的 iOS 曲线，小东西（图标）弹一下；不做粒子、倾斜、数字从 0 数这类花样。
// 只改 transform 和 opacity；系统要求减少动态效果时直接到终态；等动画的地方都有超时兜底，后台标签页里也不会卡住。
//
// initFx()            每页调用一次（shell.js）：滚动入场兜底、分段控件、触屏按压
// refreshFx(scope)    接口返回后渲染出来的内容调用一次
// pop(el)             图标弹一下（SF Symbols 的 bounce）
// rollTo(el, text)    数字换值：旧的往上滑走，新的从下面滑进来（SwiftUI 的 numericText）
// openFrom(dlg, from) 弹窗从被点的卡片“长”出来（App Store 点开 Today 卡片），closeTo(dlg) 收回去
// setSegment(seg, i)  分段控件切到第 i 段
// tilt(el)            校圈头条卡：鼠标移动时整张卡朝鼠标微微倾斜，高光跟着走（Owner 点名保留的效果）
import { animate, SPRINGS } from './motion.js';

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
// 等动画结束，但最多等 ms 毫秒：页面在后台时动画不跑，界面状态（数字、弹窗）不能卡在半路
const settle = (anim, ms) => Promise.race([anim?.finished?.catch(() => {}), new Promise((r) => setTimeout(r, ms))]);
const IOS = 'cubic-bezier(0.32, 0.72, 0, 1)';

// ---------- 滚动入场：支持滚动时间线的浏览器纯 CSS；其余用 IntersectionObserver ----------
let io;
export function observeReveals(scope = document) {
  if (reduced() || CSS.supports?.('animation-timeline: view()')) return;
  if (!('IntersectionObserver' in window)) return;
  document.documentElement.classList.add('fx-io');
  io ??= new IntersectionObserver((entries) => entries.forEach((e) => {
    if (!e.isIntersecting) return;
    e.target.classList.add('is-in');
    io.unobserve(e.target);
  }), { rootMargin: '0px 0px -6% 0px', threshold: 0.08 });
  scope.querySelectorAll('.as-reveal:not(.is-in)').forEach((el) => io.observe(el));
}

// 进入视口时加 .is-in（给需要的一次性样式用）
let seenIO;
export function observeIn(scope = document) {
  const els = [...scope.querySelectorAll('.as-ratings:not(.is-in), [data-fx-in]:not(.is-in)')];
  if (!els.length) return;
  if (!('IntersectionObserver' in window)) { els.forEach((el) => el.classList.add('is-in')); return; }
  seenIO ??= new IntersectionObserver((entries) => entries.forEach((e) => {
    if (!e.isIntersecting) return;
    e.target.classList.add('is-in');
    seenIO.unobserve(e.target);
  }), { threshold: 0 });
  els.forEach((el) => seenIO.observe(el));
}

export function refreshFx(scope = document) {
  observeReveals(scope);
  observeIn(scope);
  scope.querySelectorAll('[data-tilt]').forEach(tilt);
}

// ---------- 校圈头条卡：一条按需弹簧，保留整卡倾斜、图片放大与跟随高光 ----------
const MAX_TILT = 6;
const tiltControllers = new WeakMap();
const hoverPointer = matchMedia('(hover: hover) and (pointer: fine)');
const tiltMotion = matchMedia('(prefers-reduced-motion: reduce)');
const clamp01 = (v) => Math.min(1, Math.max(0, v));

// 使用全站 interactive 弹簧的解析解，120/240Hz 与 60Hz 维持相同响应；重定向保留速度。
function stepTilt(axis, target, seconds) {
  const { response, damping } = SPRINGS.interactive;
  const w = 2 * Math.PI / response, wd = w * Math.sqrt(1 - damping * damping);
  const decay = Math.exp(-damping * w * seconds), sin = Math.sin(wd * seconds), cos = Math.cos(wd * seconds);
  const delta = axis.value - target;
  const velocity = axis.velocity;
  axis.value = target + decay * (delta * cos + (velocity + damping * w * delta) / wd * sin);
  axis.velocity = decay * (velocity * cos - (damping * w * velocity + w * w * delta) / wd * sin);
  if (Math.abs(axis.value - target) < 0.0001 && Math.abs(axis.velocity) < 0.002) {
    axis.value = target;
    axis.velocity = 0;
  }
}

export function disposeTilts(scope) {
  scope?.querySelectorAll('[data-tilt]').forEach((el) => tiltControllers.get(el)?.());
}

export function tilt(el) {
  if (!el || tiltControllers.has(el)) return;
  el.dataset.fxTilt = '1';
  el.classList.add('fx-tilt');
  const sheen = document.createElement('span');
  sheen.className = 'fx-sheen';
  sheen.setAttribute('aria-hidden', 'true');
  el.append(sheen);
  const events = new AbortController();
  const listen = (node, type, fn, options = {}) => node.addEventListener(type, fn, { ...options, signal: events.signal });
  let frame = 0, lastTime = 0, rect = null, active = false;
  let targetX = 0, targetY = 0, pointerX = 0, pointerY = 0, viewportX = scrollX, viewportY = scrollY, lastCard = '', lastSheen = '';
  const x = { value: 0, velocity: 0 }, y = { value: 0, velocity: 0 }, scale = { value: 1, velocity: 0 };
  const allowed = () => !tiltMotion.matches && hoverPointer.matches && !document.hidden;
  const reset = () => {
    cancelAnimationFrame(frame);
    frame = lastTime = 0;
    active = false;
    rect = null;
    targetX = targetY = 0;
    x.value = y.value = x.velocity = y.velocity = scale.velocity = 0;
    scale.value = 1;
    el.classList.remove('is-tilting', 'is-settling');
    el.style.transform = sheen.style.transform = lastCard = lastSheen = '';
  };
  const paint = (time) => {
    frame = 0;
    if (!allowed() || !el.isConnected) { reset(); return; }
    if (active && rect) {
      targetX = clamp01((pointerX + viewportX - rect.left) / rect.width) - 0.5;
      targetY = clamp01((pointerY + viewportY - rect.top) / rect.height) - 0.5;
    }
    const dt = Math.min(0.064, (time - (lastTime || time - 1000 / 60)) / 1000);
    lastTime = time;
    stepTilt(x, targetX, dt);
    stepTilt(y, targetY, dt);
    stepTilt(scale, active ? 1.01 : 1, dt);
    const cardValue = `perspective(1000px) rotateX(${(-y.value * MAX_TILT).toFixed(3)}deg) rotateY(${(x.value * MAX_TILT).toFixed(3)}deg) scale(${scale.value.toFixed(5)})`;
    const sheenValue = `translate3d(${(x.value * 50).toFixed(2)}%, ${(y.value * 50).toFixed(2)}%, 0)`;
    if (cardValue !== lastCard) el.style.transform = lastCard = cardValue;
    if (sheenValue !== lastSheen) sheen.style.transform = lastSheen = sheenValue;
    const moving = x.velocity || y.velocity || scale.velocity || x.value !== targetX || y.value !== targetY || scale.value !== (active ? 1.01 : 1);
    if (moving) frame = requestAnimationFrame(paint);
    else {
      lastTime = 0;
      if (!active) reset();
    }
  };
  const wake = () => { if (!frame) { lastTime = 0; frame = requestAnimationFrame(paint); } };
  const point = (e) => {
    if (e.pointerType !== 'mouse' || (!active && !allowed())) return;
    if (!rect) {
      // 保存未变形时的文档坐标。滚动只改变 scrollX/Y，不能重测旋转后的包围盒。
      const b = el.getBoundingClientRect();
      viewportX = scrollX; viewportY = scrollY;
      rect = { left: b.left + viewportX, top: b.top + viewportY, width: b.width, height: b.height };
    }
    if (!active) { active = true; el.classList.add('is-tilting', 'is-settling'); }
    pointerX = e.clientX;
    pointerY = e.clientY;
    wake();
  };
  const leave = () => {
    if (!active) return;
    active = false;
    targetX = targetY = 0;
    el.classList.remove('is-tilting');
    wake();
  };
  listen(el, 'pointerenter', point, { passive: true });
  listen(el, 'pointermove', point, { passive: true });
  listen(el, 'pointerleave', leave, { passive: true });
  listen(el, 'pointercancel', reset, { passive: true });
  listen(window, 'scroll', () => { viewportX = scrollX; viewportY = scrollY; if (active) wake(); }, { passive: true });
  listen(window, 'blur', reset);
  listen(window, 'resize', reset, { passive: true });
  listen(window, 'pagehide', reset);
  listen(document, 'visibilitychange', () => { if (document.hidden) reset(); });
  listen(tiltMotion, 'change', reset);
  listen(hoverPointer, 'change', reset);
  const sizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(reset) : null;
  sizeObserver?.observe(el);
  const dispose = () => {
    reset();
    events.abort();
    sizeObserver?.disconnect();
    sheen.remove();
    el.classList.remove('fx-tilt');
    delete el.dataset.fxTilt;
    tiltControllers.delete(el);
  };
  tiltControllers.set(el, dispose);
  return dispose;
}

// ---------- 图标弹一下 ----------
export function pop(el) {
  if (!el?.animate || reduced()) return;
  el.animate([
    { transform: 'scale(1)' },
    { transform: 'scale(0.8)', offset: 0.2 },
    { transform: 'scale(1.14)', offset: 0.55 },
    { transform: 'scale(1)' },
  ], { duration: 480, easing: 'cubic-bezier(0.3, 0.7, 0.4, 1)' });
}

// ---------- 数字换值 ----------
export async function rollTo(el, text, direction = 1) {
  if (!el) return;
  const value = String(text);
  if (el.textContent === value) return;
  if (reduced() || !el.animate) { el.textContent = value; return; }
  el.classList.add('fx-pop');
  const out = el.animate([{ transform: 'none', opacity: 1 }, { transform: `translateY(${-50 * direction}%)`, opacity: 0 }],
    { duration: 120, easing: 'ease-in', fill: 'forwards' });
  await settle(out, 200);
  el.textContent = value;
  out.cancel();
  el.animate([{ transform: `translateY(${50 * direction}%)`, opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 260, easing: IOS });
}

// ---------- 弹窗从卡片长出来（FLIP：先放到终点，再从起点的位置和大小回来） ----------
const origins = new WeakMap();
export function openFrom(dlg, from) {
  if (!dlg) return;
  dlg.dataset.motion = 'flip';
  if (!dlg.open) dlg.showModal();
  if (reduced() || !from?.getBoundingClientRect) return;
  const a = from.getBoundingClientRect(), b = dlg.getBoundingClientRect();
  if (!a.width || !b.width) return;
  origins.set(dlg, from);
  const sx = a.width / b.width, sy = a.height / b.height;
  const dx = a.left + a.width / 2 - (b.left + b.width / 2), dy = a.top + a.height / 2 - (b.top + b.height / 2);
  dlg.animate([
    { transform: `translate(${dx}px, ${dy}px) scale(${sx.toFixed(3)}, ${sy.toFixed(3)})`, opacity: 0.5 },
    { transform: 'none', opacity: 1 },
  ], { duration: 460, easing: IOS });
  // 内容晚一点淡入，盖住放大过程中的拉伸
  [...dlg.children].forEach((child, i) => animate(child, [{ opacity: 0 }, { opacity: 1 }], { spring: 'smooth', delay: 90 + i * 30, fill: 'backwards' }));
}

export async function closeTo(dlg) {
  if (!dlg?.open) return;
  const from = origins.get(dlg);
  if (reduced() || !from?.isConnected) { dlg.close(); return; }
  const a = from.getBoundingClientRect(), b = dlg.getBoundingClientRect();
  let out;
  if (!a.width || a.bottom < 0 || a.top > innerHeight) {
    out = dlg.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(16px) scale(0.97)' }], { duration: 200, easing: 'ease-in', fill: 'forwards' });
  } else {
    const sx = a.width / b.width, sy = a.height / b.height;
    const dx = a.left + a.width / 2 - (b.left + b.width / 2), dy = a.top + a.height / 2 - (b.top + b.height / 2);
    out = dlg.animate([{ transform: 'none', opacity: 1 }, { transform: `translate(${dx}px, ${dy}px) scale(${sx.toFixed(3)}, ${sy.toFixed(3)})`, opacity: 0 }],
      { duration: 300, easing: IOS, fill: 'forwards' });
  }
  await settle(out, 420);
  dlg.close();
  out.cancel();
}

// ---------- 分段控件：等宽分段，滑块用 translateX 滑到当前段 ----------
export function setSegment(seg, index) {
  if (!seg) return;
  const items = [...seg.querySelectorAll(':scope > a, :scope > button')];
  if (!items.length) return;
  const i = Math.max(0, Math.min(items.length - 1, index));
  seg.style.setProperty('--n', String(items.length));
  seg.style.setProperty('--i', String(i));
  items.forEach((it, k) => {
    if (it.tagName === 'BUTTON') it.setAttribute('aria-pressed', String(k === i));
  });
}

// 页面上已有的分段控件：只写段数；当前段由 store.css 的 :has() 规则跟着 aria-current / .is-active 走
function initSegments(scope = document) {
  scope.querySelectorAll('.as-seg').forEach((seg) => {
    const items = seg.querySelectorAll(':scope > a, :scope > button');
    seg.style.setProperty('--n', String(items.length || 1));
    seg.classList.add('is-static');
    requestAnimationFrame(() => requestAnimationFrame(() => seg.classList.remove('is-static')));
  });
}

// iOS Safari 只有注册过 touchstart 才会给链接和按钮加 :active
function enableTouchActive() {
  document.addEventListener('touchstart', () => {}, { passive: true });
}

export function initFx() {
  enableTouchActive();
  initSegments();
  refreshFx();
}
