// 全站动效工具：Apple 式弹簧、共享元素转场。
//
// 弹簧沿用 SwiftUI 公开的参数口径：response（无阻尼时一次往返的秒数）和 dampingFraction（阻尼比，1 为不回弹）。
// 解析解采样成 CSS linear() 缓动，交给浏览器合成线程去跑；不支持 linear() 的浏览器退回近似的 cubic-bezier。
// 预设与 SwiftUI 同名：smooth（不回弹）、snappy（轻微回弹）、bouncy（明显回弹）、interactive（跟手）。
// 转场优先用 View Transitions（WebKit / Chromium 都已支持），只动 transform 和 opacity；系统要求减少动态效果时直接切换。
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export const SPRINGS = {
  smooth: { response: 0.5, damping: 1 },
  snappy: { response: 0.42, damping: 0.85 },
  bouncy: { response: 0.5, damping: 0.7 },
  interactive: { response: 0.18, damping: 0.86 },
};

// 弹簧从 0 走到 1 的位移函数
function curve({ response, damping }) {
  const w0 = (2 * Math.PI) / response;
  if (damping < 1) {
    const wd = w0 * Math.sqrt(1 - damping * damping);
    const k = (damping * w0) / wd;
    return (t) => 1 - Math.exp(-damping * w0 * t) * (Math.cos(wd * t) + k * Math.sin(wd * t));
  }
  return (t) => 1 - Math.exp(-w0 * t) * (1 + w0 * t);
}

// 位移与终点的差距小于 0.2% 之后视为停稳
function settle(params) {
  const x = curve(params);
  let last = 0;
  for (let t = 0; t < 3; t += 1 / 240) if (Math.abs(1 - x(t)) > 0.002) last = t;
  return Math.max(0.2, last);
}

const cache = new Map();
const supportsLinear = typeof CSS !== 'undefined' && CSS.supports?.('transition-timing-function', 'linear(0, 1)');

// 返回 { easing, duration }，duration 单位毫秒，可直接传给 element.animate()
export function spring(name = 'smooth') {
  const params = typeof name === 'string' ? SPRINGS[name] ?? SPRINGS.smooth : name;
  const key = `${params.response}/${params.damping}`;
  if (cache.has(key)) return cache.get(key);
  const sec = settle(params);
  const x = curve(params);
  let easing = 'cubic-bezier(0.22, 1, 0.36, 1)';
  if (supportsLinear) {
    const n = Math.min(64, Math.max(24, Math.round(sec * 60)));
    const pts = [];
    for (let i = 0; i <= n; i++) pts.push(i === n ? 1 : +x((i / n) * sec).toFixed(4));
    easing = `linear(${pts.join(', ')})`;
  } else if (params.damping < 0.9) {
    easing = 'cubic-bezier(0.34, 1.36, 0.64, 1)';
  }
  const out = { easing, duration: Math.round(sec * 1000) };
  cache.set(key, out);
  return out;
}

// 把弹簧写成 CSS 变量，样式表里用 var(--spring-snappy) / var(--spring-snappy-dur)
export function installSprings(root = document.documentElement) {
  for (const name of Object.keys(SPRINGS)) {
    const s = spring(name);
    root.style.setProperty(`--spring-${name}`, s.easing);
    root.style.setProperty(`--spring-${name}-dur`, `${s.duration}ms`);
  }
}

// element.animate 的弹簧版；减少动态效果时直接到终态
export function animate(el, keyframes, { spring: name = 'smooth', delay = 0, fill = 'both' } = {}) {
  if (!el?.animate) return null;
  if (reducedMotion()) {
    const last = Array.isArray(keyframes) ? keyframes.at(-1) : null;
    if (last) Object.assign(el.style, last);
    return null;
  }
  const s = spring(name);
  return el.animate(keyframes, { duration: s.duration, easing: s.easing, delay, fill });
}

// 同页共享元素转场：update() 里改 DOM，带 view-transition-name 的元素会从旧位置“长”到新位置。
// 不支持或要求减少动态效果时直接执行 update()。html 上临时挂一个类名，方便样式表单独写这次转场。
export async function transition(update, kind = 'swap') {
  const root = document.documentElement;
  if (!document.startViewTransition || reducedMotion()) {
    await update();
    return;
  }
  root.classList.add(`vt-${kind}`);
  let guard;
  try {
    const vt = document.startViewTransition(update);
    // 页面在后台、或者动画被系统挂起时，最多等 2 秒就直接跳到结果，不让界面卡在半路
    guard = setTimeout(() => vt.skipTransition(), 2000);
    await vt.finished;
  } catch {
    // 转场被打断（例如连续点击）时，DOM 更新本身已经完成
  } finally {
    clearTimeout(guard);
    root.classList.remove(`vt-${kind}`);
  }
}
