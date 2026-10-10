// 全站弹窗与底部面板（Opus · 2026-10-10）。页面照常用 <dialog> + showModal()，这里统一补上 iOS 的行为：
//
// enhanceDialogs(scope)  initFx / refreshFx 自动调用，页面不用改：
//   - Esc：从卡片“长”出来的弹窗收回卡片；填了内容的表单先问一句“放弃这次编辑？”
//   - 点背景关闭（data-dismiss="none" 的弹窗不关；aria-busy 正在提交时不关）
//   - 手机上：顶部有一根小横条，往下拖能关掉（跟手、看速度，没拖够就弹回去）；正在滚动的内容不会被误拖
// openFrom(dlg, card) / closeTo(dlg)  弹窗从被点的卡片长出来、收回去（桌面；手机走底部升起）
// dismiss(dlg)                        按上面的规则关闭（会问是否放弃未提交的内容）
// confirmSheet({...})                 代替 confirm() / prompt()：桌面是 iOS 提醒框，手机是底部操作表
//
// 只动 transform 和 opacity；等动画的地方都有超时兜底；系统要求减少动态效果时直接开关。
import { DUR, EASE, reducedMotion, spring } from './motion.js';

const narrow = () => matchMedia('(max-width: 760px)').matches;
const settle = (anim, ms) => Promise.race([anim?.finished?.catch(() => {}), new Promise((r) => setTimeout(r, ms))]);
const SKIP = '.story, .spot, .lk-alert, [data-sheet="off"]';
const seen = new WeakSet();

// ---------- 从卡片长出来 ----------
// 等比缩放（文字不会被拉扁），从卡片的上沿展开；容器很快变实，内容稍后淡入，不再透出后面的页面
const origins = new WeakMap();

export function openFrom(dlg, from) {
  if (!dlg) return;
  const flip = !reducedMotion() && !narrow() && from?.getBoundingClientRect;
  if (!flip) {
    delete dlg.dataset.motion;
    if (!dlg.open) dlg.showModal();
    return;
  }
  dlg.dataset.motion = 'flip';
  if (!dlg.open) dlg.showModal();
  const a = from.getBoundingClientRect(), b = dlg.getBoundingClientRect();
  if (!a.width || !b.width || a.height < 32) { fadeIn(dlg); return; }
  origins.set(dlg, from);
  const s = Math.max(0.3, Math.min(1, a.width / b.width));
  const dx = a.left + a.width / 2 - (b.left + b.width / 2), dy = a.top - b.top;
  dlg.style.transformOrigin = '50% 0';
  const grow = dlg.animate([
    { transform: `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) scale(${s.toFixed(3)})`, opacity: 0 },
    { opacity: 1, offset: 0.22 },
    { transform: 'none', opacity: 1 },
  ], { duration: DUR.medium, easing: EASE.ios });
  const done = () => { dlg.style.transformOrigin = ''; };
  grow.finished.then(done, done);
  [...dlg.children].forEach((child, i) => child.animate([{ opacity: 0 }, { opacity: 1 }],
    { duration: 220, delay: 110 + Math.min(i, 4) * 24, easing: 'ease-out', fill: 'backwards' }));
  backdrop(dlg, [0, 1], DUR.medium);
}

function fadeIn(dlg) {
  dlg.animate([{ opacity: 0, transform: 'translateY(12px) scale(.98)' }, { opacity: 1, transform: 'none' }], { duration: DUR.medium, easing: EASE.ios });
}

function backdrop(dlg, opacity, duration, easing = 'ease-out') {
  try {
    return dlg.animate({ opacity }, { duration, easing, pseudoElement: '::backdrop', fill: 'forwards' });
  } catch { return null; }
}

export async function closeTo(dlg) {
  if (!dlg?.open) return;
  const from = origins.get(dlg);
  origins.delete(dlg);
  if (reducedMotion() || dlg.dataset.motion !== 'flip') { finishClose(dlg); return; }
  let out;
  const a = from?.isConnected ? from.getBoundingClientRect() : null, b = dlg.getBoundingClientRect();
  [...dlg.children].forEach((child) => child.animate([{ opacity: 1 }, { opacity: 0 }], { duration: DUR.exitFast, easing: EASE.in, fill: 'forwards' }));
  if (!a?.width || a.bottom < 0 || a.top > innerHeight) {
    out = dlg.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(16px) scale(.97)' }], { duration: DUR.exit, easing: EASE.in, fill: 'forwards' });
  } else {
    const s = Math.max(0.3, Math.min(1, a.width / b.width));
    const dx = a.left + a.width / 2 - (b.left + b.width / 2), dy = a.top - b.top;
    dlg.style.transformOrigin = '50% 0';
    out = dlg.animate([
      { transform: 'none', opacity: 1 },
      { opacity: 1, offset: 0.6 },
      { transform: `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) scale(${s.toFixed(3)})`, opacity: 0 },
    ], { duration: 320, easing: EASE.ios, fill: 'forwards' });
  }
  backdrop(dlg, [1, 0], 260);
  await settle(out, 460);
  finishClose(dlg);
}

// 关掉，并清掉这次动画留下的状态；之后再用普通 showModal() 打开时照常有进场动画
function finishClose(dlg) {
  dlg.classList.add('is-instant');
  dlg.close();
  dlg.getAnimations({ subtree: true }).forEach((an) => an.cancel());
  dlg.style.transform = '';
  dlg.style.transformOrigin = '';
  requestAnimationFrame(() => requestAnimationFrame(() => {
    dlg.classList.remove('is-instant');
    if (!dlg.open) delete dlg.dataset.motion;
  }));
}

// ---------- 关闭（带“放弃编辑？”） ----------
export async function dismiss(dlg, { force = false } = {}) {
  if (!dlg?.open) return false;
  if (!force && dlg.dataset.dirty === '1') {
    const ok = await confirmSheet({ title: '放弃这次编辑？', message: '填写的内容还没有提交，关掉就没有了。', confirmLabel: '放弃', cancelLabel: '继续编辑', destructive: true });
    if (!ok) return false;
  }
  if (dlg.dataset.motion === 'flip') await closeTo(dlg);
  else dlg.close();
  return true;
}

// ---------- 自动增强页面上的弹窗 ----------
export function enhanceDialogs(scope = document) {
  scope.querySelectorAll?.('dialog').forEach(enhance);
}

function enhance(dlg) {
  if (seen.has(dlg) || dlg.matches(SKIP)) return;
  seen.add(dlg);

  // 用户自己改过表单才算“有未提交的内容”；代码填的值不算
  dlg.addEventListener('input', (e) => { if (e.isTrusted && e.target.closest?.('form')) dlg.dataset.dirty = '1'; });
  dlg.addEventListener('submit', () => { delete dlg.dataset.dirty; });
  dlg.addEventListener('close', () => { delete dlg.dataset.dirty; dlg.style.transform = ''; });

  dlg.addEventListener('cancel', (e) => {
    if (dlg.dataset.dismiss === 'none' || dlg.getAttribute('aria-busy') === 'true') { e.preventDefault(); return; }
    if (dlg.dataset.motion === 'flip' || dlg.dataset.dirty === '1') {
      e.preventDefault();
      dismiss(dlg);
    }
  });

  // 点背景：按下和松开都在弹窗外面才算（拖选文字拖出界不算）
  let downOutside = false;
  const outside = (e) => {
    if (e.target !== dlg) return false;
    const r = dlg.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };
  dlg.addEventListener('pointerdown', (e) => { downOutside = outside(e); });
  dlg.addEventListener('click', (e) => {
    const hit = downOutside && outside(e);
    downOutside = false;
    if (!hit || dlg.dataset.dismiss === 'none' || dlg.getAttribute('aria-busy') === 'true') return;
    dismiss(dlg);
  });

  if (!dlg.querySelector(':scope > .sheet-grabber')) dlg.insertAdjacentHTML('afterbegin', '<div class="sheet-grabber" aria-hidden="true"></div>');
  dragToDismiss(dlg);
}

// 找到手指下面真正在滚的那一层（弹窗本身或里面的列表）
function scroller(node, root) {
  for (let el = node instanceof Element ? node : null; el && el !== root.parentElement; el = el.parentElement) {
    if (el.scrollHeight > el.clientHeight + 1) {
      const oy = getComputedStyle(el).overflowY;
      if (oy === 'auto' || oy === 'scroll' || el === root) return el;
    }
    if (el === root) break;
  }
  return null;
}

// 橡皮筋：往上拖越拖越沉
const rubber = (d, size) => (1 - 1 / ((d * 0.55) / size + 1)) * size;

function dragToDismiss(dlg) {
  let g = null;
  dlg.addEventListener('touchstart', (e) => {
    g = null;
    if (!narrow() || e.touches.length !== 1 || dlg.dataset.dismiss === 'none' || dlg.getAttribute('aria-busy') === 'true') return;
    if (e.target.closest('input, textarea, select, [contenteditable="true"], [data-no-drag], .leaflet-container')) return;
    const t = e.touches[0], r = dlg.getBoundingClientRect();
    const head = t.clientY - r.top < 56;
    const sc = scroller(e.target, dlg);
    if (!head && sc && sc.scrollTop > 0) return;
    g = { x: t.clientX, y: t.clientY, head, sc, h: r.height, on: false, dy: 0, trail: [] };
  }, { passive: true });

  dlg.addEventListener('touchmove', (e) => {
    if (!g) return;
    const t = e.touches[0];
    const dx = t.clientX - g.x, dy = t.clientY - g.y;
    if (!g.on) {
      if (Math.abs(dy) < 8 && Math.abs(dx) < 8) return;
      // 横向手势、或者在内容里往上滑（正常滚动），都交还给浏览器
      if (Math.abs(dx) > Math.abs(dy) || (dy < 0 && !g.head) || (!g.head && g.sc && g.sc.scrollTop > 0)) { g = null; return; }
      g.on = true;
      dlg.classList.add('is-dragging');
    }
    e.preventDefault();
    g.dy = dy;
    const now = performance.now();
    g.trail.push([now, dy]);
    while (g.trail.length > 2 && now - g.trail[0][0] > 90) g.trail.shift();
    const y = dy >= 0 ? dy : -rubber(-dy, g.h * 0.5);
    dlg.style.transform = `translateY(${y.toFixed(1)}px)`;
  }, { passive: false });

  const end = async () => {
    const s = g;
    g = null;
    if (!s?.on) return;
    dlg.classList.remove('is-dragging');
    const [t0, y0] = s.trail[0] ?? [0, 0], [t1, y1] = s.trail.at(-1) ?? [1, 0];
    const v = (y1 - y0) / Math.max(1, t1 - t0); // px/ms，向下为正
    const from = dlg.style.transform;
    const away = s.dy > Math.min(140, s.h * 0.25) || v > 0.6;
    if (away && dlg.dataset.dirty !== '1') {
      dlg.style.transform = '';
      const out = dlg.animate([{ transform: from }, { transform: 'translateY(100%)' }],
        { duration: Math.max(160, Math.min(300, ((s.h - s.dy) / Math.max(0.8, v)) | 0)), easing: EASE.out, fill: 'forwards' });
      backdrop(dlg, [1, 0], 260);
      await settle(out, 420);
      finishClose(dlg);
      return;
    }
    // 没拖够（或有未提交的内容）：弹回去
    dlg.style.transform = '';
    const back = spring('snappy');
    dlg.animate([{ transform: from }, { transform: 'none' }], { duration: back.duration, easing: back.easing });
    if (away) dismiss(dlg);
  };
  dlg.addEventListener('touchend', end);
  dlg.addEventListener('touchcancel', end);
}

// ---------- 代替 confirm() / prompt() ----------
// confirmSheet({ title, message, confirmLabel, cancelLabel, destructive, input: { label, placeholder, value, required, multiline } })
// → 确认返回 true（有输入框时返回填的文字），取消返回 false / null
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
let alertSeq = 0;

export function confirmSheet({ title = '确定吗？', message = '', confirmLabel = '确定', cancelLabel = '取消', destructive = false, input = null } = {}) {
  return new Promise((resolve) => {
    const id = `lk-alert-${++alertSeq}`;
    const dlg = document.createElement('dialog');
    dlg.className = 'lk-alert';
    dlg.setAttribute('aria-labelledby', `${id}-t`);
    if (message) dlg.setAttribute('aria-describedby', `${id}-m`);
    const field = input
      ? `<label class="lk-alert-field"><span class="sr-only">${esc(input.label || title)}</span>${input.multiline
        ? `<textarea name="v" rows="3" placeholder="${esc(input.placeholder || '')}"${input.required ? ' required' : ''}>${esc(input.value || '')}</textarea>`
        : `<input name="v" placeholder="${esc(input.placeholder || '')}" value="${esc(input.value || '')}"${input.required ? ' required' : ''}>`}</label>`
      : '';
    dlg.innerHTML = `<form method="dialog">
      <div class="lk-alert-body"><h2 id="${id}-t">${esc(title)}</h2>${message ? `<p id="${id}-m">${esc(message)}</p>` : ''}${field}</div>
      <div class="lk-alert-actions">
        <button type="submit" value="cancel" class="lk-alert-cancel">${esc(cancelLabel)}</button>
        <button type="submit" value="ok" class="lk-alert-ok${destructive ? ' is-destructive' : ''}">${esc(confirmLabel)}</button>
      </div></form>`;
    document.body.append(dlg);
    const ok = dlg.querySelector('.lk-alert-ok');
    const box = dlg.querySelector('[name="v"]');
    const sync = () => { if (box && input?.required) ok.disabled = !box.value.trim(); };
    box?.addEventListener('input', sync);
    sync();
    let result = input ? null : false;
    dlg.addEventListener('click', (e) => {
      // 点背景 = 取消
      if (e.target === dlg) dlg.close('cancel');
    });
    dlg.querySelector('form').addEventListener('submit', (e) => {
      const v = e.submitter?.value;
      if (v === 'ok') result = input ? box.value.trim() : true;
    });
    dlg.addEventListener('close', () => {
      resolve(result);
      setTimeout(() => dlg.remove(), 400);
    }, { once: true });
    dlg.showModal();
    // 删除这类危险操作，默认焦点放在“取消”上（iOS 的做法）
    (box ?? (destructive ? dlg.querySelector('.lk-alert-cancel') : ok)).focus();
  });
}
