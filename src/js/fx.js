// 全站交互动效（Opus · 2026-10-10 第三版），样式在 src/styles/motion.css 和 src/styles/ui.css。
// Apple 的做法：手指一碰就有反应（一帧之内），大东西走顺滑的 iOS 曲线，小东西（图标）才弹一下；
// 不做粒子、倾斜、数字从 0 数这类花样。只改 transform / opacity（以及独立的 scale / translate 属性）；
// 系统要求减少动态效果时直接到终态；等动画的地方都有超时兜底，后台标签页里也不会卡住。
//
// initFx()                 每页调用一次（shell.js）：按压引擎、分段控件、弹窗增强、液态金属按钮、滚动入场
// refreshFx(scope)         接口返回后渲染出来的内容调用一次（同样会增强新出现的弹窗和按钮）
//
// 反馈
//   pop(el)                图标弹一下（SF Symbols 的 bounce）
//   rollTo(el, text, dir)  数字换值：旧的往上滑走，新的从下面滑进来（SwiftUI 的 numericText）
//   shake(el)              出错时左右摇一下（macOS 密码错误）
//   toast(msg, opts)       顶部胶囊提示（见 toast.js）
// 操作
//   toggle(btn, opts)      点赞 / 收藏 / 关注：先变、后发请求，失败了退回去并提示
//   act(btn, task, opts)   提交类按钮：请求超过 150ms 才转圈，至少转 400ms 不闪；成功可短暂显示“✓ 已保存”
// 布局
//   reflow(scope, update)  列表筛选 / 排序 / 增删：留下来的滑到新位置，新来的淡入（GSAP Flip，按需加载）
//   stagger(els, frames)   一组元素依次进场（最多错开 6 个）
//   swap(el, update)       一块内容换成新的：旧的淡出、新的浮上来
// 弹窗（见 sheet.js）
//   openFrom(dlg, card) / closeTo(dlg) / dismiss(dlg) / confirmSheet({...})
import { DUR, EASE, reducedMotion, spring } from './motion.js';
import { toast } from './toast.js';
import { enhanceDialogs, openFrom, closeTo, dismiss, confirmSheet } from './sheet.js';
import { mountLiquid } from './liquid.js';

export { toast, openFrom, closeTo, dismiss, confirmSheet, mountLiquid };

const reduced = reducedMotion;
// 等动画结束，但最多等 ms 毫秒：页面在后台时动画不跑，界面状态（数字、弹窗）不能卡在半路
const settle = (anim, ms) => Promise.race([anim?.finished?.catch(() => {}), new Promise((r) => setTimeout(r, ms))]);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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

// 进入视口时加 .is-in（给需要的一次性样式用，例如评分条从左边长出来）
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
  enhanceDialogs(scope);
  mountLiquid(scope);
  initSegments(scope);
}

// ---------- 图标弹一下 ----------
// 用独立的 scale 属性，不覆盖元素自己的 transform；正在弹的时候再点不会从头再来
export function pop(el, { strength = 1 } = {}) {
  if (!el?.animate || reduced()) return null;
  if (el.getAnimations?.().some((a) => a.id === 'fx-pop' && a.playState === 'running')) return null;
  const k = (v) => 1 + (v - 1) * strength;
  const anim = el.animate([
    { scale: '1' },
    { scale: String(k(0.82)), offset: 0.2 },
    { scale: String(k(1.14)), offset: 0.55 },
    { scale: '1' },
  ], { duration: 480, easing: 'cubic-bezier(0.3, 0.7, 0.4, 1)' });
  anim.id = 'fx-pop';
  return anim;
}

// ---------- 出错时摇一下 ----------
export function shake(el) {
  if (!el?.animate || reduced()) return null;
  return el.animate([
    { translate: '0' }, { translate: '-8px 0' }, { translate: '7px 0' }, { translate: '-5px 0' }, { translate: '3px 0' }, { translate: '0' },
  ], { duration: 320, easing: 'linear' });
}

// ---------- 数字换值 ----------
export async function rollTo(el, text, direction = 1) {
  if (!el) return;
  const value = String(text);
  if (el.textContent === value) return;
  if (reduced() || !el.animate) { el.textContent = value; return; }
  el.classList.add('fx-pop');
  el.getAnimations().forEach((a) => a.cancel());
  const out = el.animate([{ transform: 'none', opacity: 1 }, { transform: `translateY(${-50 * direction}%)`, opacity: 0 }],
    { duration: 120, easing: 'ease-in', fill: 'forwards' });
  await settle(out, 200);
  el.textContent = value;
  out.cancel();
  el.animate([{ transform: `translateY(${50 * direction}%)`, opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 260, easing: EASE.ios });
}

// ---------- 依次进场 ----------
export function stagger(els, keyframes = [{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }],
  { step = 30, cap = 6, delay = 0, duration = DUR.medium, easing = EASE.ios, max = 24 } = {}) {
  if (reduced()) return [];
  return [...els].slice(0, max).map((el, i) => el.animate(keyframes, { duration, easing, delay: delay + Math.min(i, cap) * step, fill: 'backwards' }));
}

// ---------- 一块内容换成新的 ----------
export async function swap(el, update) {
  if (!el || reduced() || !el.animate) { await update(); return; }
  const out = el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: DUR.exitFast, easing: EASE.in, fill: 'forwards' });
  await settle(out, 160);
  await update();
  out.cancel();
  el.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: DUR.standard, easing: EASE.out });
}

// ---------- 乐观切换：点赞 / 收藏 / 关注 ----------
// toggle(btn, {
//   request: (on) => hubApi.like(id, on),     必填：发请求，返回服务器结果
//   apply: (on) => {...},                     可选：改按钮上的文字、类名（aria-pressed 由这里设置）
//   count: el, delta: 1,                      可选：旁边的数字，先加减、动画滚过去
//   reconcile: (result, on) => {...},         可选：拿到服务器结果后以它为准（例如精确的计数）
//   guard: () => boolean,                     可选：返回 false 就不动（例如还没登录，先提示）
//   icon: el,                                 可选：要弹一下的图标，默认按钮里的第一个 svg
//   error: '没有收藏上',                       可选：失败时的提示
// })
// 同一个按钮的请求按顺序发，最后一次点击决定结果；失败时退回点之前的状态、摇一下、顶部提示。
const chains = new WeakMap();
const seqs = new WeakMap();
const numOf = (el) => {
  const raw = el?.dataset.n ?? el?.textContent ?? '';
  const n = Number(String(raw).replace(/[^\d-]/g, ''));
  return raw !== '' && Number.isFinite(n) ? n : null;
};

export function toggle(btn, { on, request, apply, count, delta = 1, reconcile, guard, icon, error } = {}) {
  if (!btn || !request) return Promise.resolve();
  if (guard && guard() === false) return Promise.resolve();
  const prev = btn.getAttribute('aria-pressed') === 'true';
  const next = on ?? !prev;
  const seq = (seqs.get(btn) ?? 0) + 1;
  seqs.set(btn, seq);
  const set = (v) => {
    btn.setAttribute('aria-pressed', String(v));
    apply?.(v);
    const n = numOf(count);
    if (n != null && v !== (btn.dataset.fxOn === 'true')) {
      const m = Math.max(0, n + (v ? delta : -delta));
      if (count.dataset.n != null) count.dataset.n = String(m);
      rollTo(count, String(m), v ? 1 : -1);
    }
    btn.dataset.fxOn = String(v);
  };
  btn.dataset.fxOn = String(prev);
  set(next);
  if (next) pop(icon ?? btn.querySelector('svg'));

  const run = (chains.get(btn) ?? Promise.resolve()).then(() => request(next)).then(
    (res) => {
      if (seqs.get(btn) === seq) reconcile?.(res, next);
      return res;
    },
    (err) => {
      if (seqs.get(btn) !== seq) return undefined;
      set(prev);
      shake(btn);
      toast(err?.message || error || '没有成功，请稍后再试。', { tone: 'err' });
      return undefined;
    },
  );
  chains.set(btn, run.catch(() => {}));
  return run;
}

// ---------- 提交类按钮 ----------
// const r = await act(btn, () => hubApi.save(data), { success: '已保存' })
// 失败时摇一下并在顶部提示（error: false 关掉提示），返回 undefined；throws: true 时把错误继续抛出去
export async function act(btn, task, { success = '', error = true, throws = false, minBusy = 400 } = {}) {
  if (!btn) return task();
  if (btn.dataset.busy === '1') return undefined;
  btn.dataset.busy = '1';
  const wasDisabled = btn.disabled;
  btn.style.setProperty('--busy-ink', getComputedStyle(btn).color);
  btn.style.minWidth = `${btn.getBoundingClientRect().width}px`;
  if ('disabled' in btn) btn.disabled = true;
  else btn.setAttribute('aria-disabled', 'true');
  let shownAt = 0;
  const show = setTimeout(() => { btn.setAttribute('aria-busy', 'true'); shownAt = performance.now(); }, 150);
  const restore = () => {
    clearTimeout(show);
    btn.removeAttribute('aria-busy');
    if ('disabled' in btn) btn.disabled = wasDisabled;
    else btn.removeAttribute('aria-disabled');
    btn.style.minWidth = '';
    delete btn.dataset.busy;
  };
  try {
    const res = await task();
    clearTimeout(show);
    if (shownAt) await wait(Math.max(0, minBusy - (performance.now() - shownAt)));
    restore();
    if (success && btn.isConnected) flashDone(btn, success);
    return res;
  } catch (err) {
    clearTimeout(show);
    if (shownAt) await wait(Math.max(0, 240 - (performance.now() - shownAt)));
    restore();
    if (btn.isConnected) shake(btn);
    if (error) toast(typeof error === 'string' ? error : err?.message || '没有成功，请稍后再试。', { tone: 'err' });
    if (throws) throw err;
    return undefined;
  }
}

function flashDone(btn, label) {
  btn.dataset.done = label;
  btn.style.minWidth = `${btn.getBoundingClientRect().width}px`;
  setTimeout(() => {
    if (!btn.isConnected) return;
    delete btn.dataset.done;
    btn.style.minWidth = '';
  }, 1300);
}

// ---------- 列表重排（GSAP Flip，按需加载） ----------
// await reflow(listEl, () => { listEl.innerHTML = render(items) })
// 列表项要带 data-flip-id（同一个东西在新旧两次渲染里用同一个 id）。只给视口附近的项做动画；
// 项很多、或系统要求减少动态效果时直接换。
export async function reflow(scope, update, { selector = '[data-flip-id]', duration = 0.42, enter = true, cap = 40, absolute = false } = {}) {
  if (!scope || reduced()) { await update(); return null; }
  let gsap, Flip;
  try {
    const mod = await import('./gsap.js');
    gsap = mod.gsap;
    Flip = await mod.loadFlip();
  } catch {
    await update();
    return null;
  }
  const near = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.bottom > -160 && r.top < innerHeight + 160;
  };
  const before = [...scope.querySelectorAll(selector)];
  Flip.killFlipsOf(before);
  const state = Flip.getState(before.filter(near).slice(0, cap));
  await update();
  const after = [...scope.querySelectorAll(selector)].filter(near).slice(0, cap);
  if (!after.length) return null;
  return Flip.from(state, {
    targets: after,
    duration,
    ease: 'ios',
    scale: true,
    simple: true,
    absolute,
    prune: true,
    stagger: Math.min(0.012, 0.24 / after.length),
    onEnter: enter ? (els) => gsap.fromTo(els, { opacity: 0, scale: 0.96 }, { opacity: 1, scale: 1, duration: 0.3, ease: 'out', stagger: 0.02, clearProps: 'opacity,transform' }) : undefined,
    onComplete: () => gsap.set(after, { clearProps: 'transform' }),
  });
}

// ---------- 按压引擎 ----------
// 手指（或鼠标）一按下就收一点，松手用弹簧弹回；按得太快也保证看得见。
// 用独立的 scale 属性，所以不会覆盖元素自己的 transform / transition。收多少按面积：小按钮多一点，卡片和整行少一点。
// 拖动超过 10px（开始滚动或拖拽）立刻松开。不想要的元素加 data-press="none"。
const PRESSABLE = [
  'button', '.btn', '[role="button"]', '.as-get', '.ap-pill', '.glass-pill', '.gn-me', '.lm',
  'a.ap-card', 'button.ap-card', '.ap-row', '.as-card', '.as-lockup', '.as-chart-row', '.as-review', '.as-today',
  '.rp-cell', '.cs-post', '.mt-row', '.td-quick-item', '.v3-today', '.v3-pill', 'a.res', 'button.res',
  '.pd-act', '.cx-act', '.cx-player', '.mt-chip', '.player-btn', '.paddle', '.rail-btn', '.fx-press', '[data-press]',
].join(',');
const NO_PRESS = '[data-press="none"], .tabbar a, .leaflet-container, input, select, textarea, label, .lk-toast';
const pressing = new WeakMap();

function pressScale(el) {
  if (el.dataset.press && el.dataset.press !== 'none' && !Number.isNaN(Number(el.dataset.press))) return Number(el.dataset.press);
  const r = el.getBoundingClientRect();
  const area = r.width * r.height;
  return area > 26000 ? 0.985 : area > 3200 ? 0.96 : 0.92;
}

function currentScale(el) {
  const s = getComputedStyle(el).scale;
  const n = parseFloat(s);
  return s === 'none' || !Number.isFinite(n) ? 1 : n;
}

function pressDown(el) {
  const prev = pressing.get(el);
  prev?.anim?.cancel();
  const from = currentScale(el);
  prev?.release?.cancel();
  const to = pressScale(el);
  const anim = el.animate([{ scale: String(from) }, { scale: String(to) }], { duration: DUR.instant, easing: 'ease-out', fill: 'forwards' });
  const state = { anim, at: performance.now(), to };
  pressing.set(el, state);
  return state;
}

function pressUp(el) {
  const state = pressing.get(el);
  if (!state || state.up) return;
  state.up = true;
  const go = () => {
    if (pressing.get(el) !== state) return;
    const from = currentScale(el);
    state.anim.cancel();
    const s = spring(state.to > 0.97 ? 'snappy' : 'interactive');
    state.release = el.animate([{ scale: String(from) }, { scale: '1' }], { duration: s.duration, easing: s.easing });
    state.release.finished.then(() => { if (pressing.get(el) === state) pressing.delete(el); }, () => {});
  };
  // 点得太快也要让人看见按下去了
  const held = performance.now() - state.at;
  if (held < 70) setTimeout(go, 70 - held); else go();
}

function initPress() {
  if (!('animate' in Element.prototype)) return;
  document.addEventListener('pointerdown', (e) => {
    if (e.button > 0 || reduced()) return;
    const el = e.target.closest?.(PRESSABLE);
    if (!el || el.closest(NO_PRESS) || el.matches(':disabled, [aria-disabled="true"], [aria-busy="true"]')) return;
    pressDown(el);
    const x0 = e.clientX, y0 = e.clientY;
    const ac = new AbortController();
    const up = () => { ac.abort(); pressUp(el); };
    addEventListener('pointerup', up, { signal: ac.signal });
    addEventListener('pointercancel', up, { signal: ac.signal });
    addEventListener('dragstart', up, { signal: ac.signal });
    addEventListener('pointermove', (ev) => {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) > 10) up();
    }, { signal: ac.signal, passive: true });
    addEventListener('scroll', up, { signal: ac.signal, passive: true, capture: true });
  }, { passive: true, capture: true });

  // 键盘：空格 / 回车按下也有同样的反馈
  document.addEventListener('keydown', (e) => {
    if ((e.key !== ' ' && e.key !== 'Enter') || e.repeat || reduced()) return;
    const el = document.activeElement?.closest?.(PRESSABLE);
    if (!el || el !== document.activeElement || el.closest(NO_PRESS) || el.matches(':disabled')) return;
    pressDown(el);
    const up = (ev) => {
      if (ev.type === 'keyup' && ev.key !== e.key) return;
      removeEventListener('keyup', up);
      removeEventListener('blur', up, true);
      pressUp(el);
    };
    addEventListener('keyup', up);
    addEventListener('blur', up, true);
  });
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
const segSeen = new WeakSet();
function initSegments(scope = document) {
  scope.querySelectorAll('.as-seg').forEach((seg) => {
    const items = seg.querySelectorAll(':scope > a, :scope > button');
    seg.style.setProperty('--n', String(items.length || 1));
    if (segSeen.has(seg)) return;
    segSeen.add(seg);
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
  initPress();
  refreshFx();
}
