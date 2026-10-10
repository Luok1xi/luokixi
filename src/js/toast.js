// 全站提示条（Opus · 2026-10-10）：顶栏下方一枚深色胶囊，像灵动岛那样落下来。
// 替换原来地图、开源、项目、知识库各自的 toast()，以及校圈、口碑页顶部那行常常在屏幕外的状态文字。
//
//   toast('已收藏。')
//   toast('登录后才能收藏。', { href: 'auth.html', label: '去登录' })      // 第二个参数可以直接是操作链接（旧写法）
//   toast('没保存上', { tone: 'err', action: { label: '重试', onClick } })
//   const t = toast('正在打包…', { duration: 0 }); …; t.update('打包好了', { tone: 'ok' })
//
// - 一次只显示一条：新的来了，旧的先快速退场；
// - 停留时间按字数算（2.2–6.5 秒），带操作的至少 6.5 秒；鼠标悬停、获得焦点、切到后台时暂停；
// - 手指往上一拨就收起；
// - 作为 popover 放在顶层，弹窗打开时也盖得住；不支持 popover 的浏览器退回普通的固定定位。
// 只动 transform 和 opacity；系统要求减少动态效果时只淡入淡出。
import { DUR, EASE, reducedMotion, spring } from './motion.js';

const ICONS = {
  ok: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 12.5 4 4 8-9"/></svg>',
  err: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5.5M12 16.4v.1"/></svg>',
  info: '',
};
const canPopover = typeof HTMLElement !== 'undefined' && 'showPopover' in HTMLElement.prototype;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const safeHref = (raw) => {
  try {
    const u = new URL(raw, location.href);
    return /^https?:$/.test(u.protocol) ? u.href : '';
  } catch { return ''; }
};

let live; // 读屏用的常驻播报区（提示条本身每次新建，读屏不一定能读到）
let current = null;

function announce(text, urgent) {
  if (!live?.isConnected) {
    live = document.createElement('div');
    live.className = 'sr-only';
    live.setAttribute('aria-live', 'polite');
    document.body.append(live);
  }
  live.setAttribute('aria-live', urgent ? 'assertive' : 'polite');
  live.textContent = '';
  // 先清空再写，连续两条一样的话也会重读
  requestAnimationFrame(() => { live.textContent = text; });
}

function dwell(text, opts) {
  if (opts.duration != null) return opts.duration;
  const base = Math.min(6500, Math.max(2200, 1100 + [...text].length * 110));
  return opts.action ? Math.max(6500, base) : opts.tone === 'err' ? base + 1200 : base;
}

function normalize(arg) {
  if (!arg) return {};
  // 旧写法：toast(msg, { href, label })
  if (('href' in arg || 'onClick' in arg) && !('action' in arg) && !('tone' in arg)) return { action: arg };
  return arg;
}

function render(el, text, opts) {
  const tone = opts.tone && ICONS[opts.tone] != null ? opts.tone : 'info';
  el.dataset.tone = tone;
  el.setAttribute('role', tone === 'err' ? 'alert' : 'status');
  const a = opts.action;
  let action = '';
  if (a?.label) {
    const href = a.href ? safeHref(a.href) : '';
    action = href
      ? `<a class="lk-toast-act" href="${esc(href)}">${esc(a.label)}</a>`
      : `<button class="lk-toast-act" type="button">${esc(a.label)}</button>`;
  }
  el.innerHTML = `${ICONS[tone] ? `<span class="lk-toast-icon">${ICONS[tone]}</span>` : ''}<span class="lk-toast-text">${esc(text)}</span>${action}`;
  const btn = el.querySelector('button.lk-toast-act');
  if (btn && a.onClick) btn.addEventListener('click', () => { a.onClick(); current?.dismiss(); }, { once: true });
}

function pop(icon) {
  if (!icon?.animate || reducedMotion()) return;
  icon.animate([{ transform: 'scale(.4)', opacity: 0 }, { transform: 'scale(1.18)', opacity: 1, offset: 0.55 }, { transform: 'none', opacity: 1 }],
    { duration: 460, delay: 110, easing: EASE.out, fill: 'backwards' });
}

export function toast(message, options) {
  const opts = normalize(options);
  const text = String(message ?? '');
  current?.dismiss(true);

  const el = document.createElement('div');
  el.className = 'lk-toast';
  if (canPopover) el.popover = 'manual';
  render(el, text, opts);
  document.body.append(el);
  if (canPopover) { try { el.showPopover(); } catch { /* 已在顶层 */ } }
  announce(text, opts.tone === 'err');

  const reduced = reducedMotion();
  const s = spring('snappy');
  el.animate(reduced
    ? [{ opacity: 0 }, { opacity: 1 }]
    : [{ opacity: 0, transform: 'translateY(-16px) scale(.88)' }, { opacity: 1, transform: 'none' }],
  { duration: reduced ? DUR.fast : s.duration, easing: reduced ? 'ease-out' : s.easing });
  pop(el.querySelector('.lk-toast-icon'));

  let timer = 0, left = dwell(text, opts), since = 0, holds = 0, gone = false;
  const run = () => {
    clearTimeout(timer);
    if (holds || !left) return;
    since = performance.now();
    timer = setTimeout(() => handle.dismiss(), left);
  };
  const hold = () => {
    if (holds++ === 0 && since) { clearTimeout(timer); left = Math.max(800, left - (performance.now() - since)); since = 0; }
  };
  const release = () => { if (holds && --holds === 0) run(); };

  const handle = {
    el,
    update(nextText, nextOpts = {}) {
      if (gone) return handle;
      const o = normalize(nextOpts);
      render(el, String(nextText ?? ''), o);
      announce(String(nextText ?? ''), o.tone === 'err');
      pop(el.querySelector('.lk-toast-icon'));
      left = dwell(String(nextText ?? ''), o);
      if (!holds) run();
      return handle;
    },
    dismiss(fast = false) {
      if (gone) return;
      gone = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVis);
      if (current === handle) current = null;
      el.style.pointerEvents = 'none';
      const out = el.animate(reducedMotion()
        ? [{ opacity: 1 }, { opacity: 0 }]
        : [{ opacity: 1, transform: getComputedStyle(el).transform === 'none' ? 'none' : getComputedStyle(el).transform }, { opacity: 0, transform: 'translateY(-12px) scale(.94)' }],
      { duration: fast ? DUR.exitFast : DUR.exit, easing: EASE.in, fill: 'forwards' });
      const done = () => el.remove();
      out.finished.then(done, done);
      setTimeout(done, 400); // 后台标签页里动画不跑，也要移除
    },
  };
  current = handle;

  el.addEventListener('pointerenter', hold);
  el.addEventListener('pointerleave', release);
  el.addEventListener('focusin', hold);
  el.addEventListener('focusout', release);
  const onVis = () => (document.hidden ? hold() : release());
  document.addEventListener('visibilitychange', onVis);

  // 往上拨走：跟手，松手时看距离和速度
  el.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.lk-toast-act') || e.button > 0) return;
    const y0 = e.clientY, t0 = performance.now();
    let dy = 0, armed = false;
    hold();
    const move = (ev) => {
      dy = ev.clientY - y0;
      if (!armed && Math.abs(dy) > 4) { armed = true; el.setPointerCapture?.(e.pointerId); }
      if (armed) el.style.transform = `translateY(${dy < 0 ? dy : dy * 0.25}px)`;
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      removeEventListener('pointercancel', up);
      const v = dy / Math.max(1, performance.now() - t0);
      if (armed && (dy < -18 || v < -0.35)) { handle.dismiss(); return; }
      if (armed) {
        const from = el.style.transform;
        el.style.transform = '';
        const back = spring('interactive');
        el.animate([{ transform: from }, { transform: 'none' }], { duration: back.duration, easing: back.easing });
      }
      release();
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    addEventListener('pointercancel', up);
  });

  run();
  return handle;
}

toast.ok = (message, opts = {}) => toast(message, { ...normalize(opts), tone: 'ok' });
toast.error = (message, opts = {}) => toast(message, { ...normalize(opts), tone: 'err' });
