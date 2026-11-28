// “看实车”的曲线和仪表：canvas 滚动曲线（每个像素列保留最小、最大值，尖峰不会被抽稀掉；车重启处断开），SVG 圆表和罗盘。
// 不加依赖。颜色从 CSS 变量读（robot-live.css 的 --rl-*），深浅色跟着页面走。

const TICKS = [0.2, 0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300, 600];

function niceRange(lo, hi) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [-1, 1];
  if (lo === hi) { const d = Math.abs(lo) * 0.1 || 1; return [lo - d, hi + d]; }
  const pad = (hi - lo) * 0.08;
  return [lo - pad, hi + pad];
}
const fmt = v => Math.abs(v) >= 1000 ? Math.round(v).toString() : Math.abs(v) >= 10 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(1) : v.toFixed(2);

// series：[{ key, label, color, axis: 'l' | 'r', scale: () => 乘数, dash }]；ghost = 对照（仿真）数据，同列名虚线画
export function createChart(canvas, store, { series, fixed = {}, unit = {} }) {
  const ctx = canvas.getContext('2d');
  let w = 0, h = 0, dpr = 1, lastLayout = '', cached = null;
  const PAD = { l: 44, r: 44, t: 8, b: 18 };

  function layout() {
    const r = canvas.getBoundingClientRect(), key = `${r.width}x${r.height}x${devicePixelRatio}`;
    if (key === lastLayout) return;
    lastLayout = key; dpr = devicePixelRatio || 1; w = Math.max(10, r.width); h = Math.max(10, r.height);
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  }

  // 每个像素列一个 [min, max]，车重启（段号变了）或缺值处断开
  function columns(src, key, k, t0, t1, plotW) {
    const out = new Array(Math.ceil(plotW) + 1);
    if (!src?.has(key)) return out;
    let run = 0, gap = true, previousSegment;
    for (let i = Math.max(0, src.find(t0) - 1); i < src.size; i++) {
      const t = src.t(i); if (t > t1) break;
      const v = src.v(key, i) * k; if (!Number.isFinite(v)) { gap = true; continue; }
      const segment = src.seg(i);
      if (gap || segment !== previousSegment) run++;
      gap = false; previousSegment = segment;
      const x = Math.round((t - t0) / (t1 - t0) * plotW);
      if (x < 0 || x >= out.length) continue;
      const c = out[x] || (out[x] = { min: v, max: v, first: v, last: v, firstRun: run, lastRun: run });
      if (v < c.min) c.min = v; if (v > c.max) c.max = v; c.last = v; c.lastRun = run;
    }
    return out;
  }

  function draw({ t0, t1, ghost, hoverT, marks = [] }) {
    layout();
    const plotW = Math.max(1, w - PAD.l - PAD.r), plotH = Math.max(1, h - PAD.t - PAD.b);
    const style = getComputedStyle(canvas), css = name => style.getPropertyValue(name).trim();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const grid = css('--rl-grid') || '#2a2d33', text = css('--rl-axis') || '#8a909b';
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    // 每列的像素数据和各轴量程
    const scales = series.map(s => s.scale ? s.scale() : 1), revision = store.version, ghostRevision = ghost?.store.version;
    // 悬停只改指针；数据、时间窗、缩放或对照改变时才重新扫描原始采样。
    const reusable = revision !== undefined && (!ghost || ghostRevision !== undefined) && cached
      && cached.revision === revision && cached.ghostStore === ghost?.store && cached.ghostRevision === ghostRevision && cached.offset === ghost?.offset
      && cached.t0 === t0 && cached.t1 === t1 && cached.width === plotW && scales.every((k, i) => k === cached.scales[i]);
    const cols = reusable ? cached.cols : series.map((s, i) => ({ s, k: scales[i], main: columns(store, s.key, scales[i], t0, t1, plotW),
      ghost: ghost ? columns(ghost.store, s.key, scales[i], t0 - ghost.offset, t1 - ghost.offset, plotW) : null }));
    cached = { revision, ghostStore: ghost?.store, ghostRevision, offset: ghost?.offset, t0, t1, width: plotW, scales, cols };
    const range = {};
    for (const axis of ['l', 'r']) {
      if (fixed[axis]) { range[axis] = fixed[axis]; continue; }
      let lo = Infinity, hi = -Infinity;
      for (const c of cols) if ((c.s.axis || 'l') === axis) for (const arr of [c.main, c.ghost]) if (arr) for (const p of arr) if (p) { if (p.min < lo) lo = p.min; if (p.max > hi) hi = p.max; }
      if (lo !== Infinity) range[axis] = niceRange(lo, hi);
    }
    const y = (axis, v) => { const [lo, hi] = range[axis] || [-1, 1]; return PAD.t + plotH - (v - lo) / (hi - lo) * plotH; };
    // 网格：横 4 条，竖按时间刻度
    ctx.strokeStyle = grid; ctx.lineWidth = 1; ctx.fillStyle = text;
    for (let k = 0; k <= 4; k++) { const yy = Math.round(PAD.t + plotH * k / 4) + 0.5; ctx.beginPath(); ctx.moveTo(PAD.l, yy); ctx.lineTo(PAD.l + plotW, yy); ctx.stroke(); }
    const span = (t1 - t0) / 1000, step = TICKS.find(s => span / s <= 6) || 600;
    for (let s = Math.ceil(t0 / 1000 / step) * step; s * 1000 <= t1; s += step) {
      const xx = Math.round(PAD.l + (s * 1000 - t0) / (t1 - t0) * plotW) + 0.5;
      ctx.beginPath(); ctx.moveTo(xx, PAD.t); ctx.lineTo(xx, PAD.t + plotH); ctx.stroke();
      ctx.textAlign = 'center'; ctx.fillText(`${+s.toFixed(1)}s`, xx, h - 4);
    }
    for (const axis of ['l', 'r']) {
      const r = range[axis]; if (!r) continue;
      ctx.textAlign = axis === 'l' ? 'right' : 'left';
      const xx = axis === 'l' ? PAD.l - 6 : PAD.l + plotW + 6;
      ctx.fillText(fmt(r[1]) + (unit[axis] ? ` ${unit[axis]}` : ''), xx, PAD.t + 9); ctx.fillText(fmt(r[0]), xx, PAD.t + plotH);
      if (r[0] < 0 && r[1] > 0) { ctx.save(); ctx.strokeStyle = text; ctx.globalAlpha = 0.35; ctx.setLineDash([2, 3]); const zy = Math.round(y(axis, 0)) + 0.5; ctx.beginPath(); ctx.moveTo(PAD.l, zy); ctx.lineTo(PAD.l + plotW, zy); ctx.stroke(); ctx.restore(); }
    }
    // 曲线：先画对照（虚线、淡），再画实车
    const line = (arr, axis, color, alpha, dash, width) => {
      if (!arr) return;
      ctx.save(); ctx.strokeStyle = color; ctx.globalAlpha = alpha; ctx.lineWidth = width; ctx.setLineDash(dash); ctx.lineJoin = 'round';
      ctx.beginPath();
      let prev = null;
      for (let x = 0; x < arr.length; x++) {
        const c = arr[x]; if (!c) continue;
        const X = PAD.l + x;
        if (prev && prev.run === c.firstRun && x - prev.x <= Math.max(3, plotW / 40)) ctx.lineTo(X, y(axis, c.first)); else ctx.moveTo(X, y(axis, c.first));
        if (c.max !== c.min) { ctx.lineTo(X, y(axis, c.max)); ctx.lineTo(X, y(axis, c.min)); }
        ctx.lineTo(X, y(axis, c.last));
        prev = { x, run: c.lastRun };
      }
      ctx.stroke(); ctx.restore();
    };
    for (const c of cols) line(c.ghost, c.s.axis || 'l', css(c.s.color) || c.s.color, 0.45, [4, 3], 1.2);
    for (const c of cols) line(c.main, c.s.axis || 'l', css(c.s.color) || c.s.color, 1, c.s.dash || [], 1.6);
    if (marks.length) {
      ctx.save();
      ctx.strokeStyle = text;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      for (const t of marks) {
        if (t < t0 || t > t1) continue;
        const x = PAD.l + (t - t0) / (t1 - t0) * plotW;
        ctx.moveTo(x, PAD.t);
        ctx.lineTo(x, PAD.t + plotH);
      }
      ctx.stroke();
      ctx.restore();
    }
    // 鼠标停的那一刻：竖线 + 每条线的点
    const readout = [];
    if (Number.isFinite(hoverT) && hoverT >= t0 && hoverT <= t1) {
      const xx = PAD.l + (hoverT - t0) / (t1 - t0) * plotW;
      ctx.save(); ctx.strokeStyle = text; ctx.globalAlpha = 0.6; ctx.beginPath(); ctx.moveTo(xx, PAD.t); ctx.lineTo(xx, PAD.t + plotH); ctx.stroke(); ctx.restore();
      for (const c of cols) {
        const v = nearest(store, c.s.key, hoverT) * c.k; if (!Number.isFinite(v)) continue;
        ctx.fillStyle = css(c.s.color) || c.s.color; ctx.beginPath(); ctx.arc(xx, y(c.s.axis || 'l', v), 3, 0, 7); ctx.fill();
        readout.push({ label: c.s.label, v, color: c.s.color });
      }
    }
    return { readout, plot: { left: PAD.l, width: plotW } };
  }
  return { draw };
}

// 离 t 最近的有值点（前后各找 400 个）
export function nearest(src, key, t) {
  if (!src?.has(key)) return NaN;
  const i = src.find(t);
  let best = NaN, distance = Infinity;
  for (const direction of [-1, 1]) {
    for (let d = 0; d < 400; d++) {
      const j = direction < 0 ? i - 1 - d : i + d;
      if (j < 0 || j >= src.size) break;
      const v = src.v(key, j); if (!Number.isFinite(v)) continue;
      const delta = Math.abs(src.t(j) - t);
      if (delta < distance) { best = v; distance = delta; }
      break;
    }
  }
  return best;
}

// ---------- SVG 仪表 ----------
const arcPath = (cx, cy, r, a0, a1) => {
  const p = a => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  const [x0, y0] = p(a0), [x1, y1] = p(a1);
  return `M${x0.toFixed(2)},${y0.toFixed(2)}A${r},${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${x1.toFixed(2)},${y1.toFixed(2)}`;
};
const A0 = Math.PI * 0.75, A1 = Math.PI * 2.25;   // 270° 弧：左下到右下

// 圆表：value 为 null 时只画刻度；mark = 目标值的小三角；level = good / warn / bad 决定颜色
export function gaugeSVG({ value, min, max, mark = null, level = 'good', ticks = 5 }) {
  const f = v => A0 + (Math.min(Math.max(v, min), max) - min) / (max - min) * (A1 - A0);
  const tick = [...Array(ticks + 1)].map((_, k) => { const a = A0 + k / ticks * (A1 - A0); return `<line x1="${(60 + 41 * Math.cos(a)).toFixed(1)}" y1="${(60 + 41 * Math.sin(a)).toFixed(1)}" x2="${(60 + 46 * Math.cos(a)).toFixed(1)}" y2="${(60 + 46 * Math.sin(a)).toFixed(1)}"/>`; }).join('');
  const m = mark === null || !Number.isFinite(mark) ? '' : (() => { const a = f(mark); return `<circle class="rl-g-mark" cx="${(60 + 52 * Math.cos(a)).toFixed(1)}" cy="${(60 + 52 * Math.sin(a)).toFixed(1)}" r="3"/>`; })();
  return `<svg viewBox="0 0 120 104" class="rl-gauge" data-level="${level}" aria-hidden="true">
    <path class="rl-g-track" d="${arcPath(60, 60, 50, A0, A1)}"/>
    ${value === null || !Number.isFinite(value) ? '' : `<path class="rl-g-fill" d="${arcPath(60, 60, 50, A0, Math.max(A0 + 0.001, f(value)))}"/>`}
    <g class="rl-g-ticks">${tick}</g>${m}</svg>`;
}

// 罗盘：航向（imu_sum，左转为正）指针 + 目标航向小点；数学角度：0° 朝上，左转逆时针
export function compassSVG(yaw, target) {
  const pt = (deg, r) => { const a = (-deg - 90) * Math.PI / 180; return [60 + r * Math.cos(a), 60 + r * Math.sin(a)]; };
  const ticks = [...Array(24)].map((_, k) => { const [x0, y0] = pt(k * 15, k % 6 ? 45 : 41), [x1, y1] = pt(k * 15, 49); return `<line x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}"/>`; }).join('');
  const needle = Number.isFinite(yaw) ? (() => { const [x, y] = pt(yaw, 38), [bx, by] = pt(yaw + 180, 10); return `<line class="rl-c-needle" x1="${bx.toFixed(1)}" y1="${by.toFixed(1)}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}"/><circle class="rl-c-hub" cx="60" cy="60" r="3.5"/>`; })() : '';
  const tgt = Number.isFinite(target) ? (() => { const [x, y] = pt(target, 53); return `<circle class="rl-g-mark" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3"/>`; })() : '';
  return `<svg viewBox="0 0 120 120" class="rl-compass" aria-hidden="true"><circle class="rl-g-track" cx="60" cy="60" r="50"/><g class="rl-g-ticks">${ticks}</g>${tgt}${needle}</svg>`;
}

// 迷你折线（电池掉压一类）：values 按时间排好
export function sparkSVG(values, { lo, hi } = {}) {
  if (values.length < 2) return '<svg viewBox="0 0 100 24" class="rl-spark"></svg>';
  let min = Infinity, max = -Infinity;
  const indices = [];
  // 100 像素内保留每列首、末和极值，长记录不生成上万个 SVG 点，也不漏掉单点掉压。
  for (let col = 0; col < 100; col++) {
    const start = Math.floor(col * values.length / 100), end = Math.floor((col + 1) * values.length / 100);
    if (end <= start) continue;
    let low = start, high = start;
    for (let i = start; i < end; i++) {
      if (values[i] < values[low]) low = i;
      if (values[i] > values[high]) high = i;
    }
    min = Math.min(min, values[low]); max = Math.max(max, values[high]);
    for (const i of [...new Set([start, low, high, end - 1])].sort((a, b) => a - b)) indices.push(i);
  }
  const a = lo ?? min, b = hi ?? max, d = b - a || 1;
  const pts = indices.map(i => `${(i / (values.length - 1) * 100).toFixed(1)},${(22 - (values[i] - a) / d * 20).toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 100 24" preserveAspectRatio="none" class="rl-spark" aria-hidden="true"><polyline points="${pts}"/></svg>`;
}
