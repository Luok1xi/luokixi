// 贡献热力图：平面网格（GitHub 式）与 3D 城市（canvas 等轴投影）。
// 数据统一为 { start: 'YYYY-MM-DD', counts: number[] }，counts[i] 是 start 之后第 i 天的次数。
import { reducedMotion } from './shell.js';

const DAY = 86400e3;
const WEEK_CN = ['一', '二', '三', '四', '五', '六', '日'];

const parse = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};
const fmtDate = (ms) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()} 年 ${d.getUTCMonth() + 1} 月 ${d.getUTCDate()} 日`;
};
const mondayIndex = (ms) => (new Date(ms).getUTCDay() + 6) % 7; // 周一 = 0

// 只按“有记录的那些天”分档；最高的约 3% 单独一档（橙色）
export function levelsOf(counts) {
  const nz = counts.filter((n) => n > 0).sort((a, b) => a - b);
  if (!nz.length) return () => 0;
  const q = (p) => nz[Math.min(nz.length - 1, Math.floor(p * nz.length))];
  const [a, b, c, top] = [q(0.25), q(0.55), q(0.85), q(0.97)];
  return (n) => (n <= 0 ? 0 : n <= a ? 1 : n <= b ? 2 : n <= c ? 3 : n >= top && n > c ? 5 : 4);
}

// 把 counts 排成 周 × 7 的格子；today 之后的格子标记为未来
function layout({ start, counts }) {
  const t0 = parse(start);
  const offset = mondayIndex(t0);
  const today = Date.now() + 8 * 3600e3;
  return counts.map((n, i) => {
    const ms = t0 + i * DAY;
    return { n, ms, col: Math.floor((i + offset) / 7), row: (i + offset) % 7, future: ms > today };
  });
}

let tipEl;
export function tip() {
  tipEl ??= Object.assign(document.body.appendChild(document.createElement('div')), { className: 'tip' });
  return {
    show(x, y, text) {
      tipEl.textContent = text;
      tipEl.style.left = `${x}px`;
      tipEl.style.top = `${y}px`;
      tipEl.classList.add('is-on');
    },
    hide() {
      tipEl.classList.remove('is-on');
    },
  };
}

const describe = (cell, unit) => `${fmtDate(cell.ms)} · ${cell.n ? `${cell.n} ${unit}` : '没有记录'}`;

// ---------------- 平面网格 ----------------

export function renderGrid(el, data, { unit = '次' } = {}) {
  const cells = layout(data);
  const level = levelsOf(data.counts);
  const cols = cells.at(-1).col + 1;
  const months = [];
  let lastMonth = -1;
  for (const c of cells) {
    const m = new Date(c.ms).getUTCMonth();
    if (m !== lastMonth && c.row === 0) {
      months.push({ col: c.col, label: `${m + 1}月` });
      lastMonth = m;
    }
  }
  el.classList.add('heat');
  el.innerHTML = `
    <div class="heat-days" aria-hidden="true">${WEEK_CN.map((d, i) => `<span>${i % 2 === 0 ? d : ''}</span>`).join('')}</div>
    <div class="heat-scroll">
      <div class="heat-months" style="width:calc(${cols} * (var(--cell) + var(--gap)))">${months
        .map((m) => `<span style="left:calc(${m.col} * (var(--cell) + var(--gap)))">${m.label}</span>`)
        .join('')}</div>
      <div class="heat-grid" role="img" aria-label="${data.label ?? '贡献热力图'}">${[...Array(cells[0].row)]
        .map(() => '<i class="is-future"></i>')
        .join('')}${cells
        .map((c, i) => `<i data-i="${i}" data-l="${level(c.n)}" style="--w:${c.col}"${c.future ? ' class="is-future"' : ''}></i>`)
        .join('')}</div>
    </div>
    <div class="heat-legend" aria-hidden="true">少 <i></i><i data-l="1"></i><i data-l="2"></i><i data-l="3"></i><i data-l="4"></i><i data-l="5"></i> 多</div>`;
  const t = tip();
  const grid = el.querySelector('.heat-grid');
  grid.addEventListener('pointerover', (e) => {
    const i = e.target.dataset?.i;
    if (i == null) return;
    const r = e.target.getBoundingClientRect();
    t.show(r.left + r.width / 2, r.top, describe(cells[i], unit));
  });
  grid.addEventListener('pointerleave', () => t.hide());
  // 最近的日期在右边，默认滚到最右
  const sc = el.querySelector('.heat-scroll');
  requestAnimationFrame(() => (sc.scrollLeft = sc.scrollWidth));
  const io = new IntersectionObserver(([e]) => {
    if (!e.isIntersecting) return;
    el.classList.add('is-in');
    io.disconnect();
  });
  io.observe(el);
}

// ---------------- 3D 城市 ----------------

const rgb = (s) => {
  const m = s.match(/\d+(\.\d+)?/g)?.map(Number) ?? [0, 0, 0];
  return m.slice(0, 3);
};
const hexRGB = (h) => {
  const v = h.trim().replace('#', '');
  return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16));
};
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const css = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
const shade = (c, k) => c.map((v) => Math.round(v * k));
const easeOut = (t) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);

export function mountCity(canvas, data, { unit = '次', onEmpty } = {}) {
  const ctx = canvas.getContext('2d');
  const cells = layout(data);
  const level = levelsOf(data.counts);
  const max = Math.max(1, ...data.counts);
  const empty = !data.counts.some((n) => n > 0);
  const cols = cells.at(-1).col + 1;
  const t = tip();
  let geo;
  let palette;
  let hover = -1;
  let raf = 0;
  // 升起动画：-1 = 不做动画（减少动态效果），0 = 还没开始（柱子先贴地），>0 = 开始时间
  let born = reducedMotion() ? -1 : 0;
  let live = false;

  function readPalette() {
    const cs = getComputedStyle(document.documentElement);
    const bg = rgb(getComputedStyle(document.body).backgroundColor);
    const fg = rgb(getComputedStyle(document.body).color);
    const g = ['--g1', '--g2', '--g3', '--g4'].map((v) => hexRGB(cs.getPropertyValue(v)));
    palette = { bg, base: mix(bg, fg, 0.09), levels: [null, mix(bg, g[0], 0.5), g[0], g[1], g[2], g[3]], glow: g[0] };
  }

  function measure() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    const W = canvas.clientWidth;
    const pad = 12;
    const s = (W - pad * 2) / (cols * 0.92 + 7 * 0.4);
    const H = s * 7; // 最高的柱子
    const U = [s * 0.92, s * 0.3];
    const V = [-s * 0.4, s * 0.5];
    const ox = pad + 7 * 0.4 * s;
    const oy = pad + H;
    const height = Math.ceil(oy + cols * U[1] + 7 * V[1] + pad);
    canvas.style.height = `${height}px`;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    geo = { s, H, U, V, P: (c, r) => [ox + c * U[0] + r * V[0], oy + c * U[1] + r * V[1]] };
  }

  const heightOf = (cell, now) => {
    if (cell.future) return 0;
    if (empty) {
      // 没有数据时的装饰性波纹（不代表任何记录）
      const phase = now / 900 - (cell.col * 0.32 + cell.row * 0.55);
      return geo.s * (0.25 + 0.55 * (1 + Math.sin(phase)) * 0.5);
    }
    const target = cell.n ? geo.s * 0.6 + Math.pow(cell.n / max, 0.6) * geo.H : geo.s * 0.18;
    const k = born === -1 ? 1 : born === 0 ? 0 : easeOut((now - born - cell.col * 16) / 900);
    return Math.max(geo.s * 0.12, target * k);
  };

  const colorOf = (cell, i, now) => {
    if (empty) {
      const crest = (1 + Math.sin(now / 900 - (cell.col * 0.32 + cell.row * 0.55))) / 2;
      return mix(palette.base, palette.glow, crest * crest * 0.55);
    }
    const l = level(cell.n);
    const c = l ? palette.levels[l] : palette.base;
    return i === hover ? mix(c, [255, 255, 255], 0.35) : c;
  };

  // 画一根柱子：顶面 + 正面（朝下）+ 右侧面
  function bar(cell, i, now) {
    const { P } = geo;
    const g = 0.14;
    const h = heightOf(cell, now);
    const [c0, c1, r0, r1] = [cell.col + g, cell.col + 1 - g, cell.row + g, cell.row + 1 - g];
    const a = P(c0, r0), b = P(c1, r0), c = P(c1, r1), d = P(c0, r1);
    const up = (p) => [p[0], p[1] - h];
    const col = colorOf(cell, i, now);
    const poly = (pts, fill) => {
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (const p of pts.slice(1)) ctx.lineTo(p[0], p[1]);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
    };
    poly([d, c, up(c), up(d)], css(shade(col, 0.66))); // 正面
    poly([b, c, up(c), up(b)], css(shade(col, 0.8))); // 右侧
    poly([up(a), up(b), up(c), up(d)], css(col)); // 顶面
    return [up(a), up(b), up(c), up(d)];
  }

  let tops = [];
  function draw(now = performance.now()) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    tops = new Array(cells.length);
    // 从后往前：行从上到下，同一行内列从左到右
    for (let r = 0; r < 7; r++) for (let i = 0; i < cells.length; i++) if (cells[i].row === r && !cells[i].future) tops[i] = bar(cells[i], i, now);
  }

  const animating = (now) => empty || (born > 0 && now - born < 900 + cols * 16 + 50);
  function loop(now) {
    draw(now);
    raf = live && animating(now) ? requestAnimationFrame(loop) : 0;
  }
  const kick = () => {
    if (!raf && live) raf = requestAnimationFrame(loop);
  };

  const inside = (p, q) => {
    let hit = false;
    for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
      if (q[i][1] > p[1] !== q[j][1] > p[1] && p[0] < ((q[j][0] - q[i][0]) * (p[1] - q[i][1])) / (q[j][1] - q[i][1]) + q[i][0]) hit = !hit;
    }
    return hit;
  };

  canvas.addEventListener('pointermove', (e) => {
    if (empty || !tops.length) return;
    const r = canvas.getBoundingClientRect();
    const p = [e.clientX - r.left, e.clientY - r.top];
    let found = -1;
    // 顶面后画的在前面，倒序找第一个命中的
    for (let row = 6; row >= 0 && found < 0; row--)
      for (let i = cells.length - 1; i >= 0; i--) if (cells[i].row === row && tops[i] && inside(p, tops[i])) { found = i; break; }
    if (found !== hover) {
      hover = found;
      draw();
    }
    if (found >= 0) t.show(e.clientX, e.clientY - 6, describe(cells[found], unit));
    else t.hide();
  });
  canvas.addEventListener('pointerleave', () => {
    hover = -1;
    t.hide();
    draw();
  });

  const setup = () => {
    readPalette();
    measure();
    draw();
  };
  setup();
  if (empty) onEmpty?.();
  const ro = new ResizeObserver(() => {
    measure();
    draw();
  }); ro.observe(canvas);
  const onTheme = () => {
    readPalette();
    draw();
  };
  addEventListener('lk:theme', onTheme);
  const scheme=matchMedia('(prefers-color-scheme: dark)'); scheme.addEventListener('change', setup);

  // 进入视口才开始升起；离开视口暂停波纹
  const io = new IntersectionObserver(([e]) => {
    live = e.isIntersecting && !reducedMotion();
    if (live && !empty && born === 0) born = performance.now();
    if (live) kick();
  });
  io.observe(canvas);
  const visibility=()=>{live=!document.hidden && !reducedMotion() && canvas.getBoundingClientRect().bottom>0;if(live)kick();};
  document.addEventListener('visibilitychange',visibility);
  return()=>{live=false;cancelAnimationFrame(raf);io.disconnect();ro.disconnect();removeEventListener('lk:theme',onTheme);scheme.removeEventListener('change',setup);document.removeEventListener('visibilitychange',visibility);t.hide();};
}
