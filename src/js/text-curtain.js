// 字帘：照 Marina Budarina 的设计（x.com/marina_uiux）——一整片细小的字竖着垂下来，像门口的帘子。纯文字，只作氛围。
// 每一列是一根 Verlet 绳子，挂在一条看不见的檐上；一列里接连写着好几个词，用“·”隔开。
// 不躲鼠标、不可点：指针扫过只轻轻带动一点；偶尔一阵风从左吹到右。
// 一套词一帘（课程 / 校园 / 四六级 / 开源 / 最近），隔一会儿从左到右收起、换词、再垂下，檐的弧度跟着变。
// 每换一帘随机挑一个词作“默认搜索”（onDefault），它在帘子里用主题色标出来，搜索框里显示成灰字。
// 画法：所有用得到的字预先画进同一张字形图（一张贴图，GPU 能整批画），逐帧只从这张图里取字，不再排版文字；
// 物理按 60 步/秒算，画的时候在前后两步之间插值——120/144Hz 的屏上也每一帧都在动，不会一顿一顿。
// 垂下、收起这种有终点的大动作不交给物理（突然拉长会让约束求解来回抖），按真实时间用公式算：
// 每列从檐下展开，像弹簧一样多冲一点再弹回来；同时像钟摆一样左右荡（越往下荡得越大，慢慢减弱）；
// 落定那一刻把当时荡的速度原样交给物理，接着荡、自然停下——弹性和振荡都在，又不会抖。
// 底部的淡出在画布里按高度算，不用 CSS 遮罩（遮罩每帧要多合成一遍）。
// 动态减少时字帘静止垂下；静止一会儿循环自动停下，不白耗电。
import { createCurtainPainter } from './curtain-painter.js';
import { springStep } from './spring-step.js';
import { constrainStrand, pointerImpulse } from './curtain-physics.js';

const ROOFS = {
  eave: (u) => -9 * Math.pow(Math.abs(u), 3), // 两头上翘
  arch: (u) => -7 * (1 - u * u), // 中间拱起
  flat: (u) => -4 * Math.pow(Math.abs(u), 8), // 几乎平直
};
const TOP = 14;
const G = 0.34;
const DAMP = 0.982;
const STEP = 1000 / 60;
const SEP = '·';

const lerp = (a, b, t) => a + (b - a) * t;
const easeOut = (t) => 1 - Math.pow(1 - t, 4);
const easeIn = (t) => t * t * t;
const glyphs = (t) => [...String(t)].filter((ch) => ch.trim());
// 每列一个固定的“深浅”，帘子看上去有前后
const shade = (k) => 0.42 + ((((Math.sin(k * 12.9898) * 43758.5453) % 1) + 1) % 1) * 0.4;

export function mountCurtain(host, { sets = [], onDefault = () => {}, onSet = () => {}, reduced = false, compact = false } = {}) {
  host.classList.add('tc');
  host.setAttribute('aria-hidden', 'true');
  host.innerHTML = '<canvas class="tc-canvas"></canvas>';
  let painter = createCurtainPainter(host.querySelector('canvas'));
  let canvas = painter.canvas;

  const size = compact ? 10.5 : 11.5; // 字号
  const pitch = compact ? 15 : 16.5; // 列距
  const line = size * 1.26; // 行距
  let W = 0, H = 0, dpr = 1;
  let list = sets.filter((s) => s.terms?.length);
  let current = 0;
  let strands = [];
  let pick = -1; // 这一帘的默认词（序号）
  let lastPick = '';
  let roofFrom = ROOFS[list[0]?.roof] ?? ROOFS.eave, roofTo = roofFrom, roofT = 1, roofStart = 0;
  let raf = 0, last = 0, acc = 0, calm = 0, running = false, paused = false, dead = false;
  let rect = null;
  let ink = '#1d1d1f', accent = '#0071e3', fontFamily = 'sans-serif';
  // 字形图：一张画布，ink 和 accent 两种颜色各一份；cell 是每格的设备像素边长
  let atlas = null, atlasPos = new Map(), cell = 0, atlasKey = '';
  const pointer = { x:0, y:0, vx:0, distance:0, inside:false, active:false };
  let gust = null, gustTimer = 0, rotateTimer = 0;
  let pendingSet = null, pauseAt = 0, offscreen = false;
  const events = new AbortController();
  const listen = (target, type, handler, options = {}) => target.addEventListener(type, handler, { ...options, signal: events.signal });
  const blocked = () => paused || offscreen || document.hidden;
  const physicalNow = () => pauseAt || performance.now();

  const pad = () => Math.max(8, W * 0.02);
  const uOf = (x) => ((x - pad()) / Math.max(1, W - 2 * pad())) * 2 - 1;
  const roofY = (x) => TOP + lerp(roofFrom(uOf(x)), roofTo(uOf(x)), roofT);

  function readStyle() {
    const cs = getComputedStyle(host);
    ink = cs.color || ink;
    accent = cs.getPropertyValue('--accent').trim() || accent;
    fontFamily = cs.fontFamily || fontFamily;
  }

  // 把所有帘子里会出现的字一次画进一张字形图（换帘时不再现场画新字）；字集、颜色、清晰度没变就不重画
  function buildAtlas() {
    const chars = new Set([SEP]);
    for (const set of list) for (const t of set.terms) for (const ch of glyphs(t)) chars.add(ch);
    const ratio = Math.min(2, devicePixelRatio || 1);
    const key = `${[...chars].join('')}|${ink}|${accent}|${ratio}|${fontFamily}`;
    if (key === atlasKey && atlas) return;
    atlasKey = key;
    cell = Math.ceil(size * 1.6 * ratio);
    const all = [...chars];
    const cols = Math.max(1, Math.ceil(Math.sqrt(all.length * 2)));
    const rows = Math.ceil((all.length * 2) / cols);
    atlas = document.createElement('canvas');
    atlas.width = cols * cell;
    atlas.height = rows * cell;
    const g = atlas.getContext('2d');
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    atlasPos = new Map();
    let k = 0;
    for (const [color, weight] of [[ink, 500], [accent, 700]]) {
      g.font = `${weight} ${size * ratio}px ${fontFamily}`;
      g.fillStyle = color;
      for (const ch of all) {
        const x = (k % cols) * cell, y = Math.floor(k / cols) * cell;
        g.fillText(ch, x + cell / 2, y + cell / 2);
        atlasPos.set(color + ch, [x, y]);
        k++;
      }
    }
  }

  // 一列写几个词：从第 k 个词开始接着写，写满这一列（底边参差一点）
  function build() {
    strands = [];
    const set = list[current];
    if (!set || !W || !H) return;
    const terms = set.terms;
    const cols = Math.max(3, Math.floor((W - 2 * pad()) / pitch) + 1);
    const step = (W - 2 * pad()) / (cols - 1);
    const rowsMax = Math.max(4, Math.floor((H - TOP - 10) / line));
    for (let k = 0; k < cols; k++) {
      const rows = rowsMax - Math.floor(((Math.sin(k * 7.13) + 1) / 2) * 3);
      const chars = [];
      let t = (k * 2 + Math.floor(k / 3)) % terms.length;
      while (chars.length < rows) {
        for (const ch of glyphs(terms[t])) chars.push({ ch, term: t });
        if (chars.length < rows) chars.push({ ch: SEP, term: -1 });
        t = (t + 1) % terms.length;
      }
      chars.length = rows;
      if (chars[rows - 1].term < 0) chars.pop();
      const x = pad() + k * step;
      const ay = roofY(x);
      const rest = [0, line * 0.8, ...chars.slice(1).map(() => line)];
      let y = ay;
      const nodes = rest.map((r) => { y += r; return { x, y, px: x, py: y }; });
      strands.push({ x, chars, nodes, rest, show: 1, fall: null, alpha: shade(k) });
    }
    choose();
  }

  // 随机挑一个默认词（尽量不和上一个重复，且确实挂在帘子上）
  function choose() {
    const set = list[current];
    const shown = [...new Set(strands.flatMap((s) => s.chars.map((g) => g.term)).filter((t) => t >= 0))];
    if (!set || !shown.length) { pick = -1; return; }
    const pool = shown.filter((t) => set.terms[t] !== lastPick);
    pick = (pool.length ? pool : shown)[Math.floor(Math.random() * (pool.length || shown.length))];
    lastPick = set.terms[pick];
    onDefault(lastPick, set);
  }

  // 垂下（dir 1）/ 收起（dir -1）：记下开始时偏离竖直的量，收起时这点偏离随进度消失；spread 让收起时往两边分开
  function fall(s, dir, dur, delay = 0, spread = 0) {
    const ay = roofY(s.x);
    let y = ay;
    const off = s.nodes.map((n, i) => {
      if (i) y += s.rest[i];
      return dir < 0 ? [n.x - s.x, n.y - y] : [0, 0];
    });
    // 垂下时每列荡的幅度：大多往同一边（像一阵风从左吹来），大小各不相同
    const swing = dir > 0 ? (Math.random() < 0.82 ? 1 : -1) * (7 + Math.random() * 6) : 0;
    s.fall = { dir, t0: physicalNow() + delay, dur, off, swing, spread: spread * (Math.sign(s.x - W / 2) || 1) };
  }

  // 长度：弹簧式展开，第一下多冲约 14% 再弹回，后面还有一下很小的
  const unroll = (seconds) => springStep(0, 0, 1, seconds, { stiffness: (2*Math.PI/.48)**2, damping: .55 })[0];
  // 左右荡：ω 接近这串字自己的摆动频率，落地后交给物理能接得上
  const SWAY_W = 5, SWAY_D = 1.2;
  const sway = (t) => Math.sin(SWAY_W * t) * Math.exp(-SWAY_D * t);
  const swayV = (t) => Math.exp(-SWAY_D * t) * (SWAY_W * Math.cos(SWAY_W * t) - SWAY_D * Math.sin(SWAY_W * t));

  // 按这一帧的真实时间摆好正在垂下 / 收起的列（不插值、不走物理）
  function applyFalls(now) {
    for (const s of strands) {
      const f = s.fall;
      if (!f) continue;
      const p = Math.min(1, Math.max(0, (now - f.t0) / f.dur));
      const e = f.dir > 0 ? (p >= 1 ? 1 : unroll(p*f.dur/1000)) : 1 - easeIn(p);
      s.show = f.dir > 0 ? Math.min(1, p * 2.2) : 1 - p;
      const ay = roofY(s.x), N = s.nodes.length;
      const ts = (p * f.dur) / 1000, swing = f.swing * sway(ts);
      let y = ay;
      for (let i = 0; i < N; i++) {
        const n = s.nodes[i];
        if (i) y += s.rest[i] * e;
        const k = f.dir < 0 ? 1 - p : 0;
        const w = Math.pow(i / (N - 1 || 1), 1.4);
        n.x = n.px = s.x + f.off[i][0] * k + f.spread * p * (i / N) + swing * w;
        n.y = n.py = (i ? y : ay) + f.off[i][1] * k;
      }
      if (p < 1) continue;
      s.fall = null;
      if (f.dir > 0) {
        s.show = 1;
        // 落定：把这一刻荡的速度交给物理（Verlet 的速度就是 x - px），接着荡、慢慢停
        const v = (f.swing * swayV(ts) * STEP) / 1000;
        for (let i = 1; i < N; i++) s.nodes[i].px = s.nodes[i].x - v * Math.pow(i / (N - 1 || 1), 1.4);
      } else s.show = 0;
    }
  }

  function step(now) {
    if (roofT < 1) roofT = easeOut(Math.min(1, (now - roofStart) / 700));
    for (const s of strands) {
      if (s.fall) continue;
      const a = s.nodes[0];
      a.x = a.px = s.x;
      a.y = a.py = roofY(s.x);
      let w = 0;
      if (gust) {
        const p = (now - gust.t0 - s.x * 0.8) / 300;
        if (p > 0 && p < 1) w = gust.dir * gust.f * Math.sin(Math.PI * p);
      }
      const N = s.nodes.length;
      for (let i = 1; i < N; i++) {
        const n = s.nodes[i];
        const vx = (n.x - n.px) * DAMP, vy = (n.y - n.py) * DAMP;
        n.px = n.x; n.py = n.y;
        n.x += vx + w * (i / N);
        n.y += vy + G;
      }
    }
    if (gust && now - gust.t0 > W * 0.8 + 400) gust = null;
    // 指针扫过：只顺着指针的方向轻轻带一下，不推开、不躲
    if (pointer.active) {
      pointer.vx = pointerImpulse(pointer.vx,pointer.distance);
      pointer.distance = 0;
      const r = 46;
      for (const s of strands) {
        const dxs = Math.abs(s.x - pointer.x);
        if (dxs > r || s.fall) continue;
        const f = (1 - dxs / r) * 0.05;
        for (let i = 1; i < s.nodes.length; i++) {
          const n = s.nodes[i];
          if (Math.abs(n.y - pointer.y) > r) continue;
          n.px -= pointer.vx * f;
        }
      }
      if (Math.abs(pointer.vx) < 0.05) pointer.active = false;
    }
    for (const s of strands) if (!s.fall) constrainStrand(s.nodes,s.rest);
  }

  // t：上一步到这一步之间的插值（0..1）；Verlet 的 px/py 正好就是上一步的位置
  function draw(t = 1) {
    if (!atlas) buildAtlas();
    painter.begin(atlas, cell);
    const fadeFrom = H * 0.78, fadeLen = H * 0.22;
    for (const s of strands) {
      const fade = s.show;
      if (fade <= 0) continue;
      const N = s.nodes;
      for (let i = 0; i < s.chars.length; i++) {
        const n = N[i + 1], prev = N[i], next = N[i + 2] ?? N[i + 1];
        // Programmed drop/sweep poses already use display time; interpolating
        // them again delays the pose and erases the velocity handoff.
        const blend = s.fall ? 1 : t;
        const x = n.px + (n.x - n.px) * blend, y = n.py + (n.y - n.py) * blend;
        if (y > H) break;
        const g = s.chars[i];
        const on = g.term >= 0 && g.term === pick;
        const low = y > fadeFrom ? Math.max(0, 1 - (y - fadeFrom) / fadeLen) : 1;
        const a = fade * low * (on ? 1 : g.term < 0 ? s.alpha * 0.45 : s.alpha);
        if (a < 0.02) continue;
        const pos = atlasPos.get((on ? accent : ink) + g.ch);
        if (!pos) continue;
        const px = prev.px + (prev.x - prev.px) * blend, py = prev.py + (prev.y - prev.py) * blend;
        const nx = next.px + (next.x - next.px) * blend, ny = next.py + (next.y - next.py) * blend;
        const dx = nx-px, dy = ny-py, length = Math.sqrt(dx*dx+dy*dy);
        // Normalize the tangent directly instead of atan2 + sin + cos per glyph.
        painter.glyph(x*dpr, y*dpr, length ? dy/length : 1, length ? -dx/length : 0, pos[0], pos[1], a);
      }
    }
    painter.flush();
  }

  function energy() {
    let e = 0;
    for (const s of strands)
      for (const n of s.nodes) e += (n.x - n.px) ** 2 + (n.y - n.py) ** 2;
    return e / Math.max(1, strands.length);
  }

  function frame(now) {
    raf = 0;
    if (dead || blocked()) { running = false; return; }
    if (pendingSet && now >= pendingSet.at) commitSet(pendingSet.index);
    acc += Math.min(80, now - (last || now));
    last = now;
    while (acc >= STEP) {
      step(now - acc + STEP);
      acc -= STEP;
    }
    applyFalls(now);
    draw(acc / STEP);
    const busy = pointer.active || gust || pendingSet || roofT < 1 || strands.some((s) => s.fall);
    calm = !busy && energy() < 0.003 ? calm + 1 : 0;
    if (calm > 40) { running = false; last = 0; acc = 0; return; }
    raf = requestAnimationFrame(frame);
  }

  function wake() {
    if (dead || blocked()) return;
    if (reduced) { draw(); return; }
    if (running) return;
    running = true;
    calm = 0;
    last = 0;
    raf = requestAnimationFrame(frame);
  }

  function settleStill() {
    for (const s of strands) {
      let y = roofY(s.x);
      s.show = 1;
      s.fall = null;
      s.nodes.forEach((n, i) => {
        y += i ? s.rest[i] : 0;
        n.x = n.px = s.x; n.y = n.py = i ? y : roofY(s.x);
      });
    }
    draw();
  }

  // 从左到右一列列垂下来
  function dropIn() {
    if (reduced) { settleStill(); return; }
    for (const s of strands) {
      s.show = 0;
      fall(s, 1, 1000, 30 + (s.x / Math.max(1, W)) * 480);
    }
    applyFalls(physicalNow());
    draw();
    wake();
  }

  function snapshot() {
    const ys = [];
    for (let k = 0; k <= 64; k++) {
      const u = -1 + k / 32;
      ys.push(lerp(roofFrom(u), roofTo(u), roofT));
    }
    return (u) => {
      const x = ((u + 1) / 2) * 64, i = Math.min(63, Math.max(0, Math.floor(x)));
      return lerp(ys[i], ys[i + 1], x - i);
    };
  }

  // 换一帘：先从左到右收起，再挂下一套词（新的默认词也在这时挑）
  function commitSet(i) {
    pendingSet = null;
    current = i;
    buildAtlas();
    roofFrom = snapshot();
    roofTo = ROOFS[list[i].roof] ?? ROOFS.eave;
    roofT = reduced ? 1 : 0;
    roofStart = physicalNow();
    onSet(list[i], i, list.length);
    build();
    dropIn();
  }

  function show(i) {
    if (!list.length || dead) return;
    i = ((i % list.length) + list.length) % list.length;
    // One replaceable transition, never a chain of uncancellable timer promises.
    // Repeated arrows retarget the current withdrawal instead of queuing resets.
    if (pendingSet) { pendingSet.index = i; return; }
    if (!reduced && strands.length) {
      for (const s of strands) fall(s, -1, 340, (s.x / Math.max(1, W)) * 380);
      pendingSet = { index:i, at:physicalNow()+720 };
      wake();
      return;
    }
    commitSet(i);
  }

  function scheduleGust() {
    clearTimeout(gustTimer);
    if (reduced || dead || blocked()) return;
    gustTimer = setTimeout(() => {
      if (!blocked()) {
        gust = { t0: performance.now(), dir: Math.random() < 0.7 ? 1 : -1, f: 0.4 + Math.random() * 0.3 };
        wake();
      }
      scheduleGust();
    }, 4000 + Math.random() * 3600);
  }

  function scheduleRotate() {
    clearTimeout(rotateTimer);
    if (dead || reduced || blocked() || list.length < 2) return;
    rotateTimer = setTimeout(() => {
      if (!blocked()) show(current + 1);
      scheduleRotate();
    }, 12000);
  }

  // 输入时拨开：从中间往两边甩开，再收起
  function part() {
    if (reduced) return;
    pendingSet = null;
    const mid = W / 2;
    for (const s of strands) fall(s, -1, 300, (Math.abs(s.x - mid) / Math.max(1, W)) * 160, 22);
    wake();
  }

  function measure() {
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return false;
    W = w;
    H = h;
    dpr = Math.min(2, devicePixelRatio || 1);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    rect = null;
    readStyle();
    buildAtlas();
    return true;
  }

  listen(host, 'pointermove', (e) => {
    if (e.pointerType !== 'mouse' || reduced || blocked()) return;
    rect ??= host.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    // Sample once per physical step, rather than using only the final 1000 Hz
    // mouse event. Entering from outside is not a fictitious sweep from x=0.
    if (pointer.inside) pointer.distance += x-pointer.x;
    pointer.inside = true; pointer.x = x; pointer.y = y;
    pointer.active ||= Math.abs(pointer.distance)>.5;
    if (pointer.active) wake();
  });
  const releasePointer = () => { rect=null;pointer.inside=false;pointer.distance=pointer.vx=0;pointer.active=false; };
  listen(host, 'pointerleave', releasePointer);
  const ro = new ResizeObserver(() => {
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h || (Math.abs(w-W)<2 && Math.abs(h-H)<2 && dpr===Math.min(2,devicePixelRatio||1))) return;
    const keep = pick >= 0 ? list[current]?.terms[pick] : '';
    measure();
    build();
    // 尺寸变了只重排，不换默认词
    if (keep) { const k = list[current].terms.indexOf(keep); if (k >= 0) { pick = k; lastPick = keep; onDefault(keep, list[current]); } }
    reduced ? settleStill() : dropIn();
  });
  ro.observe(host);
  const onTheme = () => { readStyle(); buildAtlas(); draw(); };
  listen(window, 'lk:theme', onTheme);
  const scheme = matchMedia('(prefers-color-scheme: dark)');
  listen(scheme, 'change', onTheme);
  function availability() {
    rect = null;
    if (blocked()) {
      releasePointer();
      if (!pauseAt) pauseAt = performance.now();
      cancelAnimationFrame(raf); raf = 0; running = false;
      clearTimeout(gustTimer); clearTimeout(rotateTimer);
      return;
    }
    if (pauseAt) {
      const elapsed = performance.now()-pauseAt;
      for (const s of strands) if (s.fall) s.fall.t0 += elapsed;
      if (pendingSet) pendingSet.at += elapsed;
      if (gust) gust.t0 += elapsed;
      roofStart += elapsed; pauseAt = 0;
      last = acc = 0;
    }
    scheduleGust(); scheduleRotate(); wake();
  }
  listen(document, 'visibilitychange', availability);
  const visibility = typeof IntersectionObserver === 'function' ? new IntersectionObserver(([entry]) => {
    offscreen = !entry.isIntersecting; availability();
  }) : null;
  visibility?.observe(host);
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  listen(motion, 'change', () => {
    reduced = motion.matches; pendingSet = null;
    cancelAnimationFrame(raf); raf = 0; running = false; last = acc = 0;
    if (reduced) { roofT = 1; gust = null; pointer.active = false; settleStill(); }
    availability();
  });
  listen(canvas, 'webglcontextlost', event => {
    event.preventDefault();
    // Driver/device resets must not leave a blank search curtain. Keep the
    // current physical pose and use the identical atlas in Canvas 2D.
    const replacement = canvas.cloneNode(false); canvas.replaceWith(replacement);
    painter.destroy(); painter = createCurtainPainter(replacement, { forceCanvas:true }); canvas = painter.canvas;
    draw(); wake();
  }, { once:true });

  measure();
  readStyle();
  buildAtlas();
  if (list.length) onSet(list[0], 0, list.length);
  build();
  if (reduced) settleStill();
  else dropIn();
  scheduleGust();
  scheduleRotate();

  return {
    get index() { return current; },
    get count() { return list.length; },
    get term() { return pick >= 0 ? list[current]?.terms[pick] ?? '' : ''; },
    part,
    show,
    next: () => show((pendingSet?.index ?? current) + 1),
    prev: () => show((pendingSet?.index ?? current) - 1),
    drop() {
      if (!strands.length) { measure(); build(); }
      dropIn();
    },
    setSets(next) {
      pendingSet = null;
      const id = list[current]?.id;
      list = next.filter((s) => s.terms?.length);
      buildAtlas();
      current = Math.max(0, list.findIndex((s) => s.id === id));
      roofFrom = roofTo = ROOFS[list[current]?.roof] ?? ROOFS.eave;
      roofT = 1;
      if (list.length) onSet(list[current], current, list.length);
      build();
      reduced ? settleStill() : dropIn();
      scheduleRotate();
    },
    pause() {
      paused = true;
      availability();
    },
    resume() {
      if (!paused) return;
      paused = false;
      availability();
    },
    destroy() {
      dead = true;
      cancelAnimationFrame(raf);
      clearTimeout(gustTimer);
      clearTimeout(rotateTimer);
      ro.disconnect();
      visibility?.disconnect(); events.abort(); painter.destroy();
    },
  };
}
