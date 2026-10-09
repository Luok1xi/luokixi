// 全站搜索浮层（⌘K / Ctrl+K / “/”，以及各处带 data-search 的搜索框）。
// 展开：搜索胶囊从你点的那个按钮里“长”出来，放大镜飞进输入框，结果面板带着波浪边从胶囊下面淌出来，内容逐行升起。
// 顺滑的关键：开合动画全部交给合成线程（WAAPI 只动 transform / opacity，没有一行逐帧脚本），主线程再忙也不掉帧；
// 动的是不带模糊的“影子”，真正的玻璃（胶囊是 Lens 式液态玻璃，面板是磨砂）落定后才淡入；
// 模块、样式、DOM、位移图都在页面空闲时提前备好，点下去只剩“开始动”。逐字、逐行的入场都是 CSS 动画。
// 空状态挂着“字帘”（text-curtain.js）：自动换帘、风吹；每换一帘随机挑一个词当默认搜索，灰字显示在输入框里，空着按回车就搜它。
// 功能：范围标签（带数量，Tab 切换）、> 命令 / @ 成员 / # 校圈 前缀、命中高亮、行内补全（→ 采纳）、预览面板、
// 最近搜索与最近打开（只存在这台设备上）、快捷操作、⌘/Ctrl+↵ 新标签打开、⇧↵ 在板块里看全部。
// 图标统一用全站的石墨色 app-icon，选中色只用 accent。数据和匹配沿用 search.js / fuzzy-search.js；不向站外发请求。
import { esc } from './data.js';
import { hubState } from './hub.js';
import { CATEGORIES } from './schema.js';
import { appIcon } from './app-icons.js';
import { fuzzySearch, createFuzzyIndex, normalizeSearchText, searchTokens } from './fuzzy-search.js';
import { buildIndex, fallbackIndex, remoteSearch, GROUPS, ORDER, CAMPUS, PAGES } from './search.js';
import { liquid } from './liquid-glass.js';
import { mountCurtain } from './text-curtain.js';
import { springStep } from './spring-step.js';
import '../styles/spotlight.css';

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const narrow = () => innerWidth <= 640;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 本机记忆：最近搜索 / 最近打开（只存在这台设备上，可以清除） ----------
const RECENT = 'lk-search-recent';
const OPENED = 'lk-search-opened';
const read = (k) => { try { const v = JSON.parse(localStorage.getItem(k)); return Array.isArray(v) ? v : []; } catch { return []; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 隐私模式下不记 */ } };
function remember(q) {
  q = q.trim();
  if (q && q.length <= 60) write(RECENT, [{ q, t: Date.now() }, ...read(RECENT).filter((x) => x.q !== q)].slice(0, 8));
}
function rememberOpen(it) {
  write(OPENED, [{ title: it.title, href: it.href, group: it.group, icon: it.icon, sub: it.sub, t: Date.now() }, ...read(OPENED).filter((x) => x.href !== it.href)].slice(0, 6));
}

// ---------- 图标：全站同一套石墨色线条符号 ----------
const LINE = {
  review: '<path d="M11.5 3.6a.6.6 0 0 1 1 0l2.3 4.7 5.2.8a.6.6 0 0 1 .3 1l-3.7 3.7.9 5.1a.6.6 0 0 1-.9.6L12 17l-4.6 2.5a.6.6 0 0 1-.9-.6l.9-5.1-3.7-3.7a.6.6 0 0 1 .3-1l5.2-.8z"/>',
  project: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/>',
  theme: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17a8.5 8.5 0 0 0 0-17z" fill="currentColor" stroke="none"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2.5"/><path d="M16 8V5.5A2.5 2.5 0 0 0 13.5 3h-8A2.5 2.5 0 0 0 3 5.5v8A2.5 2.5 0 0 0 5.5 16H8"/>',
  top: '<path d="M5 4h14M12 20V9M7 13l5-5 5 5"/>',
  doc: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
  more: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2M8.5 11h5M11 8.5v5"/>',
};
const symbol = (svg) => `<span class="ap-symbol app-icon" aria-hidden="true"><svg class="app-icon__glyph" viewBox="0 0 24 24">${svg}</svg></span>`;
const ICON = {
  post: appIcon('post'), place: appIcon('pin'), collect: appIcon('upload'),
  review: symbol(LINE.review), project: symbol(LINE.project), theme: symbol(LINE.theme), copy: symbol(LINE.copy), top: symbol(LINE.top),
};

// ---------- 快捷操作（和顶栏“发布”菜单同一批入口，外加几个页面操作） ----------
const ACTIONS = [
  { id: 'post', title: '发帖', sub: '校圈 · 分享动态、经验和新发现', href: 'circle.html?compose=1', kw: 'post compose 发布 帖子 提问' },
  { id: 'place', title: '标地点', sub: '校园 · 拍照标出地点或限时活动', href: 'map.html?add=place#explore', kw: 'place 地点 标注 活动 地图 标一个地点' },
  { id: 'review', title: '写评价', sub: '口碑 · 给老师或课程打分', href: 'reputation.html', kw: 'review 评价 打分 老师 课程 口碑 写课程评价' },
  { id: 'project', title: '发项目', sub: '开源广场 · 作品、工具和代码', href: 'contribute.html#project', kw: 'project 项目 开源 作品 发布项目' },
  { id: 'collect', title: '收集', sub: '链接或文件 · 私人保存，也可以提交共建', href: 'collect.html', kw: 'collect 收集 收藏 上传 资源' },
  { id: 'theme', title: '外观', sub: '浅色 / 深色', run: 'theme', kw: 'theme dark light 深色 浅色 夜间 外观 主题 切换外观' },
  { id: 'copy', title: '复制链接', sub: '把当前页面地址复制下来', run: 'copy', kw: 'copy link 复制 链接 分享 网址 复制本页链接' },
  { id: 'top', title: '回到顶部', sub: '滚回页面最上面', run: 'top', kw: 'top 顶部 回到' },
].map((a) => ({ ...a, group: '操作', svg: true }));

const GROUP_ORDER = ['操作', ...ORDER];
const LABEL = { 开源项目: '开源' };
const USE = { teaching: '教学', lab: '实验', library: '图书馆', sports: '体育', canteen: '餐饮', dorm: '宿舍', hall: '会堂', other: '' };
const iconOf = (it) => (it.group === '操作' ? ICON[it.id] : it.group === '更多' ? symbol(LINE.more) : `<span class="ap-symbol app-icon is-text" aria-hidden="true">${esc(it.icon ?? '')}</span>`);

// ---------- 状态 ----------
let dlg = null;
const ui = {};
let index = null;
let indexedSearch = null;
let indexJob = null;
let online = null;
const st = {
  raw: '', mode: 'home', scope: 'all', sel: 0, flat: [], keys: new Set(), tabsSig: '',
  remote: [], remoteFor: '', pending: false, composing: false, rev: 0, timer: 0,
  origin: null, closing: null, anims: [], settleTimer: 0, flyTimer: 0, ready: Promise.resolve(), readyDone: null,
  glass: [], curtain: null, curtainSets: null, defaultTerm: '', pvItem: null, lastPv: 0,
  statusText: '', toastTimer: 0, liveTimer: 0, angle: null, specRaf: 0, barRect: null, ghostRest: '', escAt: 0, modeTimer: 0,
  diffuse: 0,
};

// ---------- 玻璃的透明度：iOS 27 那样一根滑杆，从清透到磨砂（只存在这台设备上） ----------
const GLASS_KEY = 'lk-glass-level';
function glassLevel() {
  try {
    const v = localStorage.getItem(GLASS_KEY);
    return v === null ? 50 : clamp(Number(v) || 0, 0, 100);
  } catch { return 50; }
}

// 用户的档位 + 背后内容越复杂越多扩散一点；只改几个变量，玻璃本身在 CSS 里
function applyGlass(level = glassLevel()) {
  if (!dlg) return;
  const t = clamp(level / 100 + st.diffuse * 0.22, 0, 1);
  const set = (k, v) => dlg.style.setProperty(k, v);
  set('--sl-tint-bar', `${Math.round(34 + t * 58)}%`);
  set('--sl-tint-panel', `${Math.round(64 + t * 32)}%`);
  set('--sl-blur-bar', `${(3 + t * 15).toFixed(1)}px`);
  set('--sl-blur-panel', `${(10 + t * 22).toFixed(1)}px`);
  const range = dlg.querySelector('.sl-glassctl input');
  if (!range) return;
  if (Number(range.value) !== level) range.value = String(level);
  range.style.setProperty('--v', String(level));
}

// 打开前看一眼胶囊和面板背后是什么：图片、视频、画布、背景图越多，越复杂（iOS 27：复杂背景扩散得更好）
function backdropComplexity() {
  const w = Math.min(880, innerWidth - 32), left = (innerWidth - w) / 2;
  const top = Math.max(innerHeight * 0.09, 64), h = Math.min(innerHeight - top - 20, 680);
  let hits = 0, total = 0;
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) {
      total++;
      const x = left + (w * (i + 0.5)) / 3, y = top + (h * (j + 0.5)) / 3;
      const stack = document.elementsFromPoint(x, y).slice(0, 4);
      if (stack.some((el) => /^(IMG|VIDEO|CANVAS|PICTURE|IFRAME)$/.test(el.tagName) || getComputedStyle(el).backgroundImage !== 'none')) hits++;
    }
  return total ? hits / total : 0;
}

const TEMPLATE = `
  <div class="sl-shades" aria-hidden="true">
    <i class="sl-cap sl-cap-l"></i><i class="sl-mid"></i><i class="sl-cap sl-cap-r"></i>
    <div class="sl-pool"><div class="sl-pour"><svg class="sl-wave" viewBox="0 0 400 44" preserveAspectRatio="none"><path d="M0 0H400V20C350 44 300 6 240 22S120 44 70 24 20 14 0 26Z"/></svg></div></div>
  </div>
  <div class="sl-stage">
    <div class="sl-bar">
      <span class="sl-glow" aria-hidden="true"><i></i></span>
      <span class="sl-rim" aria-hidden="true"><i></i></span>
      <span class="sl-glare" aria-hidden="true"></span>
      <svg class="sl-mag" viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m20 20-4.8-4.8"/></svg>
      <div class="sl-inner">
        <div class="sl-field">
          <span class="sl-ghost" aria-hidden="true"></span>
          <input type="search" autofocus aria-label="搜索资料、帖子、楼、老师、项目" autocomplete="off" spellcheck="false" enterkeyhint="search"
            role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="sl-list" aria-haspopup="listbox">
          <span class="sl-ph" aria-hidden="true"><span class="sl-ph-text"></span><kbd class="kbd sl-ph-key">↵</kbd></span>
        </div>
        <button class="sl-clear" type="button" aria-label="清除" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 8 8 8M16 8l-8 8"/></svg></button>
        <kbd class="kbd sl-esc">esc</kbd>
        <button class="sl-cancel" type="button">取消</button>
      </div>
    </div>
    <div class="sl-panel" data-mode="home">
      <span class="sl-rim" aria-hidden="true"></span>
      <div class="sl-scopes" role="tablist" aria-label="搜索范围" hidden><span class="sl-scope-ink" aria-hidden="true"></span><div class="sl-scope-row"></div></div>
      <div class="sl-body">
        <section class="sl-home" aria-label="开始搜索">
          <div class="sl-stagebox">
            <div class="sl-hero">
              <p class="sl-hero-kicker sl-rise"><b class="sl-hero-num num">01</b><span class="sl-hero-total num">/ 01</span><span class="sl-hero-tag">字帘</span></p>
              <h3 class="sl-hero-title"></h3>
              <p class="sl-hero-tip sl-rise">输入框里的灰字取自这一帘<br>空着按回车，就搜它</p>
              <div class="sl-hero-nav sl-rise"><button type="button" data-curtain="-1"><span aria-hidden="true">‹</span> <span class="sl-hero-prev"></span></button><button type="button" data-curtain="1"><span class="sl-hero-next"></span> <span aria-hidden="true">›</span></button></div>
            </div>
            <div class="sl-curtain"></div>
          </div>
          <div class="sl-home-row">
            <div class="sl-acts-wrap">
              <div class="sl-sec sl-rise"><span>快捷操作</span><small>输入 &gt; 也能找到</small></div>
              <div class="sl-acts">${ACTIONS.map((a, i) => `<button type="button" class="sl-act sl-rise" data-act="${i}" style="--i:${i}">${ICON[a.id]}<span>${a.title}</span></button>`).join('')}</div>
            </div>
            <div class="sl-recent"></div>
          </div>
        </section>
        <section class="sl-results" hidden>
          <div class="sl-scroll">
            <span class="sl-hl" aria-hidden="true" hidden></span>
            <ul class="sl-list" id="sl-list" role="listbox" aria-label="搜索结果"></ul>
          </div>
          <aside class="sl-pv" aria-label="预览"></aside>
        </section>
      </div>
      <footer class="sl-foot">
        <span class="sl-keys" data-for="results"><span><kbd class="kbd">↑</kbd><kbd class="kbd">↓</kbd> 选择</span><span><kbd class="kbd">↵</kbd> 打开</span><span><kbd class="kbd" data-mod>Ctrl</kbd><kbd class="kbd">↵</kbd> 新标签</span><span><kbd class="kbd">Tab</kbd> 换范围</span><span><kbd class="kbd">→</kbd> 补全</span></span>
        <span class="sl-keys" data-for="home"><span><kbd class="kbd">↵</kbd> 搜灰字</span><span><kbd class="kbd">&gt;</kbd> 命令</span><span><kbd class="kbd">@</kbd> 同学</span><span><kbd class="kbd">#</kbd> 校圈</span></span>
        <span class="sl-foot-end">
          <span class="sl-status"></span>
          <label class="sl-glassctl" title="玻璃：往左清透，往右磨砂">
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none"/></svg>
            <input type="range" min="0" max="100" step="1" value="50" aria-label="玻璃透明度：往左更清透，往右更磨砂">
          </label>
        </span>
      </footer>
    </div>
    <span class="sl-live" role="status" aria-live="polite"></span>
  </div>
  <svg class="sl-fly" viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m20 20-4.8-4.8"/></svg>`;

function ensure() {
  if (dlg) return dlg;
  dlg = document.createElement('dialog');
  dlg.className = 'sl';
  dlg.setAttribute('aria-label', '全站搜索');
  dlg.innerHTML = TEMPLATE;
  document.body.append(dlg);
  const $ = (s) => dlg.querySelector(s);
  Object.assign(ui, {
    stage: $('.sl-stage'), bar: $('.sl-bar'), inner: $('.sl-inner'), mag: $('.sl-bar .sl-mag'), glare: $('.sl-glare'), rimDial: $('.sl-bar .sl-rim i'),
    shades: $('.sl-shades'), capL: $('.sl-cap-l'), mid: $('.sl-mid'), capR: $('.sl-cap-r'), pool: $('.sl-pool'), pour: $('.sl-pour'), wave: $('.sl-wave'),
    input: $('.sl-field input'), ph: $('.sl-ph'), phText: $('.sl-ph-text'), ghost: $('.sl-ghost'), clear: $('.sl-clear'), cancel: $('.sl-cancel'),
    panel: $('.sl-panel'), scopes: $('.sl-scopes'), scopeRow: $('.sl-scope-row'), ink: $('.sl-scope-ink'),
    home: $('.sl-home'), curtainHost: $('.sl-curtain'), acts: $('.sl-acts'), recent: $('.sl-recent'),
    heroNum: $('.sl-hero-num'), heroTotal: $('.sl-hero-total'), heroTitle: $('.sl-hero-title'), heroPrev: $('.sl-hero-prev'), heroNext: $('.sl-hero-next'), heroNav: $('.sl-hero-nav'),
    results: $('.sl-results'), scroll: $('.sl-scroll'), hl: $('.sl-hl'), list: $('.sl-list'), pv: $('.sl-pv'),
    status: $('.sl-status'), live: $('.sl-live'), fly: $('.sl-fly'),
  });
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  dlg.querySelectorAll('[data-mod]').forEach((k) => (k.textContent = mac ? '⌘' : 'Ctrl'));
  bind();
  return dlg;
}

// ---------- 查询 ----------
function parse(raw) {
  const t = raw.trimStart();
  if (t.startsWith('>') || t.startsWith('》')) return { cmd: true, q: t.slice(1).trim() };
  if (t.startsWith('@')) return { forced: '成员', q: t.slice(1).trim() };
  if (t.startsWith('#') || t.startsWith('＃')) return { forced: '校圈', q: t.slice(1).trim() };
  return { q: raw.trim() };
}
const normQ = (q) => searchTokens(q).join(' ');

function compute() {
  const p = parse(st.raw);
  if (p.cmd) {
    const acts = p.q ? fuzzySearch(ACTIONS, p.q, { limit: 20 }) : ACTIONS;
    return { cmd: true, q: p.q, scope: '操作', counts: new Map([['操作', acts.length]]), total: acts.length, groups: acts.length ? [['操作', acts]] : [] };
  }
  const q = p.q;
  const base = index ?? fallbackIndex();
  const local = q ? (indexedSearch ? indexedSearch(q, 400) : fuzzySearch(base, q, { limit: 400 })) : p.forced ? base.filter((it) => it.group === p.forced).slice(0, 40) : [];
  const remote = q && st.remoteFor === normQ(q) ? st.remote : [];
  const acts = q && !p.forced ? fuzzySearch(ACTIONS, q, { limit: 3 }) : [];
  const seen = new Set(), all = [];
  for (const it of [...acts, ...local, ...remote]) {
    const key = `${it.group}|${it.href ?? it.run}`;
    if (!seen.has(key)) { seen.add(key); all.push(it); }
  }
  const counts = new Map();
  for (const it of all) counts.set(it.group, (counts.get(it.group) || 0) + 1);
  const scope = p.forced || st.scope;
  let groups;
  if (scope === 'all') {
    // 板块按各自最好的一条排先后；命令只有标题以输入开头时才排最前
    const order = [];
    const lead = acts.some((a) => normalizeSearchText(a.title).startsWith(normalizeSearchText(q)));
    if (acts.length && lead) order.push('操作');
    for (const it of [...local, ...remote]) if (!order.includes(it.group)) order.push(it.group);
    if (acts.length && !lead) order.push('操作');
    const per = new Map(order.map((g) => [g, []]));
    for (const it of all) {
      const arr = per.get(it.group);
      if (arr && arr.length < (it.group === '操作' ? 3 : 5)) arr.push(it);
    }
    groups = [...per.entries()].filter(([, a]) => a.length);
  } else {
    const arr = all.filter((it) => it.group === scope).slice(0, 40);
    groups = arr.length ? [[scope, arr]] : [];
  }
  return { q, scope, forced: p.forced, counts, total: all.length, groups };
}

// 命中高亮：原词和别名展开后的词都标出来
function mark(title, q) {
  const text = String(title ?? '');
  if (!q) return esc(text);
  const lower = text.toLocaleLowerCase('en-US');
  const tokens = [...new Set([normalizeSearchText(q), ...searchTokens(q), ...normalizeSearchText(q).split(' ')])].filter((t) => t && t.length <= 40).sort((a, b) => b.length - a.length);
  const hit = new Array(text.length).fill(false);
  for (const t of tokens) {
    let i = lower.indexOf(t);
    while (i >= 0) {
      for (let k = i; k < i + t.length; k++) hit[k] = true;
      i = lower.indexOf(t, i + t.length);
    }
  }
  let out = '', open = false;
  for (let i = 0; i < text.length; i++) {
    if (hit[i] && !open) { out += '<mark>'; open = true; }
    if (!hit[i] && open) { out += '</mark>'; open = false; }
    out += esc(text[i]);
  }
  return open ? `${out}</mark>` : out;
}

function queryRemote() {
  clearTimeout(st.timer);
  const ticket = ++st.rev;
  const p = parse(st.raw);
  const q = p.cmd ? '' : p.q;
  if (!q || !online || st.composing) {
    st.pending = false;
    status();
    return;
  }
  st.pending = true;
  status();
  st.timer = setTimeout(async () => {
    const r = await remoteSearch(q);
    if (ticket !== st.rev || st.composing || !dlg.open || parse(st.raw).q !== q) return;
    st.remote = r;
    st.remoteFor = normQ(q);
    st.pending = false;
    paint();
    status();
  }, 220);
}

// ---------- 画结果 ----------
function rowHTML(it, id, q, fresh, k) {
  return `<li class="sl-row${fresh ? ' is-new' : ''}" role="option" id="sl-opt-${id}" aria-selected="false" data-i="${id}"${fresh ? ` style="--k:${Math.min(k, 12)}"` : ''}>
    <a href="${esc(it.href ?? '#')}" tabindex="-1"${it.external ? ' target="_blank" rel="noopener"' : ''}>
      ${iconOf(it)}
      <span class="sl-txt"><span class="sl-ttl">${mark(it.title, q)}</span><span class="sl-sub">${esc(it.sub ?? '')}</span></span>
      <span class="sl-enter" aria-hidden="true">${it.run ? '执行' : '打开'} ↵</span>
    </a></li>`;
}

function paint() {
  if (st.mode !== 'results' || !dlg?.open) return;
  const r = compute();
  renderScopes(r);
  const flat = [];
  const keys = new Set();
  let k = 0;
  let html = '';
  for (const [group, arr] of r.groups) {
    const label = LABEL[group] ?? group;
    const more = !r.cmd && r.q && GROUPS[group]?.[1]?.(r.q);
    html += `<li class="sl-grp" role="presentation"><span>${label}</span><b class="num">${r.counts.get(group) ?? arr.length}</b>${more ? `<a href="${esc(more)}" tabindex="-1">在${label}里看全部 ›</a>` : ''}</li>`;
    for (const it of arr) {
      const key = `${it.group}|${it.href ?? it.run}`;
      const fresh = !st.keys.has(key);
      keys.add(key);
      html += rowHTML(it, flat.length, r.q, fresh, fresh ? k++ : 0);
      flat.push(it);
    }
  }
  if (!r.groups.length) {
    const other = r.scope !== 'all' && !r.forced && !r.cmd ? r.total : 0;
    html += `<li class="sl-empty" role="presentation"><b>${r.cmd ? '没有这个命令' : r.q ? `${r.scope === 'all' ? '' : `${LABEL[r.scope] ?? r.scope}里`}没有找到“${esc(r.q)}”` : '输入要找的内容'}</b>${other ? `<button type="button" data-scope="all">在全部范围里看 ${other} 条 ›</button>` : r.cmd ? '<span>试试“外观”“发帖”“复制”</span>' : '<span>换个说法，或者去下面两个地方看看</span>'}</li>`;
  }
  if (!r.cmd && r.q) {
    const tail = [
      { group: '更多', title: `在课程资料与经验里搜“${r.q}”`, sub: '按课程、学期和获取方式筛选；继续查看经验与问答', href: `search.html?q=${encodeURIComponent(r.q)}` },
    ];
    if (!r.groups.length) tail.push({ group: '更多', title: '在校圈发帖问问', sub: '没人整理过？问一句，说不定有同学有', href: 'circle.html?compose=1' });
    html += '<li class="sl-grp" role="presentation"><span>更多</span></li>';
    for (const it of tail) {
      const key = `更多|${it.href}`;
      const fresh = !st.keys.has(key);
      keys.add(key);
      html += rowHTML(it, flat.length, '', fresh, fresh ? k++ : 0);
      flat.push(it);
    }
  }
  ui.list.innerHTML = html;
  st.keys = keys;
  st.flat = flat;
  if (st.sel >= flat.length) st.sel = 0;
  select(st.sel, { scroll: false, instant: true });
  if (!flat.length) ui.pv.innerHTML = '';
  clearTimeout(st.liveTimer);
  st.liveTimer = setTimeout(() => { ui.live.textContent = r.q || r.cmd ? `找到 ${r.total} 条` : ''; }, 600);
}

function renderScopes(r) {
  const tabs = r.cmd ? [['操作', '命令', r.total]] : r.forced
    ? [[r.forced, LABEL[r.forced] ?? r.forced, r.counts.get(r.forced) ?? 0]]
    : [['all', '全部', r.total], ...GROUP_ORDER.filter((g) => r.counts.get(g) || g === st.scope).map((g) => [g, LABEL[g] ?? g, r.counts.get(g) ?? 0])];
  const active = r.cmd ? '操作' : r.forced || st.scope;
  const sig = tabs.map(([id]) => id).join('|');
  if (sig !== st.tabsSig) {
    st.tabsSig = sig;
    ui.scopeRow.innerHTML = tabs.map(([id, label]) => `<button type="button" class="sl-scope" role="tab" data-scope="${esc(id)}" aria-selected="false" tabindex="-1">${esc(label)} <b class="num"></b></button>`).join('');
  }
  for (const [id, , n] of tabs) {
    const b = ui.scopeRow.querySelector(`[data-scope="${CSS.escape(id)}"]`);
    if (!b) continue;
    b.setAttribute('aria-selected', String(id === active));
    b.querySelector('b').textContent = n;
  }
  moveInk();
}

// ---------- 跟随：弹簧一直追着目标，目标随时可以变（按住方向键、鼠标扫过都连贯，不会跳回去重来） ----------
// 每帧只写一次 transform；速度越快拉得越长，停下时收回并带一点点回弹。几组数值一起追（位置、宽度）。
function follower(apply, { k = 640, damping = 0.86 } = {}) {
  let x = null, v = null, to = null, raf = 0, last = 0;
  const tick = (now) => {
    const dt = Math.min(0.25, last ? (now - last) / 1000 : 1 / 60);
    last = now;
    let rest = true;
    for (let i = 0; i < x.length; i++) {
      [x[i], v[i]] = springStep(x[i], v[i], to[i], dt, { stiffness:k, damping });
      if (Math.abs(to[i] - x[i]) > 0.15 || Math.abs(v[i]) > 3) rest = false;
    }
    if (rest) { x = [...to]; v = v.map(() => 0); }
    apply(x, v);
    raf = rest ? 0 : requestAnimationFrame(tick);
  };
  return {
    set(target, instant = false) {
      to = [...target];
      if (instant || x === null || reduced()) {
        cancelAnimationFrame(raf);
        raf = 0;
        x = [...to];
        v = to.map(() => 0);
        apply(x, v);
        return;
      }
      // A caller can change the raster width once when retargeting. Restore the
      // current presentation immediately; all intermediate frames use transform.
      apply(x, v);
      if (!raf) { last = 0; raf = requestAnimationFrame(tick); }
    },
    reset() { cancelAnimationFrame(raf); raf = 0; x = null; },
  };
}

// 范围滑块：位置和宽度一起追；跑得快时略微压扁
let inkWidth = 1;
const inkFollow = follower(([x, w], [vx]) => {
  const squash = Math.min(0.12, Math.abs(vx) / 6000);
  ui.ink.style.transform = `translate3d(${x.toFixed(2)}px, 0, 0) scale(${(w/inkWidth).toFixed(4)}, ${(1 - squash).toFixed(4)})`;
});

function moveInk({ quiet = false } = {}) {
  const b = ui.scopeRow.querySelector('[aria-selected="true"]');
  if (!b) { ui.ink.style.opacity = '0'; inkFollow.reset(); return; }
  const left = b.offsetLeft-ui.scopeRow.scrollLeft, width = b.offsetWidth;
  ui.ink.style.opacity = '1';
  if (inkWidth !== width) { inkWidth = width || 1; ui.ink.style.width = `${inkWidth}px`; }
  inkFollow.set([left, width], quiet);
}

function cycleScope(dir) {
  const r = compute();
  if (r.cmd || r.forced) return false;
  const ids = [...ui.scopeRow.querySelectorAll('[data-scope]')].map((b) => b.dataset.scope);
  if (ids.length < 2) return false;
  const i = ids.indexOf(st.scope);
  setScope(ids[(i + dir + ids.length) % ids.length]);
  return true;
}

function setScope(id) {
  st.scope = id;
  st.sel = 0;
  paint();
  const label = id === 'all' ? '全部' : LABEL[id] ?? id;
  ui.live.textContent = `范围：${label}`;
  ui.scopeRow.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function select(i, { scroll = true, instant = false } = {}) {
  const n = st.flat.length;
  if (!n) {
    ui.hl.hidden = true;
    ui.input.removeAttribute('aria-activedescendant');
    updateGhost();
    return;
  }
  st.sel = ((i % n) + n) % n;
  ui.list.querySelector('.sl-row[aria-selected="true"]')?.setAttribute('aria-selected', 'false');
  const li = ui.list.querySelector(`#sl-opt-${st.sel}`);
  if (!li) return;
  li.setAttribute('aria-selected', 'true');
  ui.input.setAttribute('aria-activedescendant', li.id);
  ui.hl.hidden = false;
  slideHl(li.offsetTop, li.offsetHeight, instant);
  if (scroll) {
    const top = li.offsetTop, bottom = top + li.offsetHeight, s = ui.scroll;
    if (top < s.scrollTop + 8) s.scrollTop = top - (st.sel === 0 ? 40 : 8);
    else if (bottom > s.scrollTop + s.clientHeight - 8) s.scrollTop = bottom - s.clientHeight + 8;
  }
  preview(st.flat[st.sel]);
  updateGhost();
}

// 选中条：弹簧追着当前行；速度越快拉得越长、略微变窄（像一滴液体），停下收回
const hlFollow = follower(([y], [vy]) => {
  const k = Math.min(0.14, Math.abs(vy) / 5200);
  ui.hl.style.transform = `translate3d(0, ${y.toFixed(2)}px, 0) scale(${(1 - k * 0.12).toFixed(4)}, ${(1 + k).toFixed(4)})`;
});

function slideHl(to, h, instant) {
  if (ui.hl.style.height !== `${h}px`) ui.hl.style.height = `${h}px`;
  hlFollow.set([to], instant);
}

// 行内补全：第一条结果以输入开头时，把剩下的字淡淡地接在后面，按 → 采纳
function updateGhost() {
  const v = ui.input.value;
  const top = st.flat[0];
  let rest = '';
  if (v && top && !top.run && top.group !== '更多' && st.sel === 0 && ui.input.selectionEnd === v.length) {
    const t = String(top.title);
    if (t.length > v.length && t.toLocaleLowerCase('en-US').startsWith(v.toLocaleLowerCase('en-US'))) rest = t.slice(v.length);
  }
  if (rest && ui.input.scrollWidth > ui.input.clientWidth + 1) rest = '';
  st.ghostRest = rest;
  ui.ghost.innerHTML = rest ? `<span class="sl-ghost-q">${esc(v)}</span>${esc(rest)}` : '';
}

// ---------- 预览 ----------
function footprint(geom) {
  const rings = geom?.type === 'Polygon' ? [geom.coordinates[0]] : geom?.type === 'MultiPolygon' ? geom.coordinates.map((p) => p[0]) : [];
  if (!rings.length || !rings[0]?.length) return '';
  const k = Math.cos((rings[0][0][1] * Math.PI) / 180);
  const pts = rings.map((r) => r.map(([lon, lat]) => [lon * k, -lat]));
  const xs = pts.flat().map((p) => p[0]), ys = pts.flat().map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const s = Math.min(150 / (x1 - x0 || 1), 96 / (y1 - y0 || 1));
  const ox = (180 - (x1 - x0) * s) / 2, oy = (120 - (y1 - y0) * s) / 2;
  const d = pts.map((r) => `M${r.map(([x, y]) => `${((x - x0) * s + ox).toFixed(1)} ${((y - y0) * s + oy).toFixed(1)}`).join('L')}Z`).join('');
  return `<svg class="sl-fp" viewBox="0 0 180 120" aria-hidden="true"><path d="${d}" pathLength="1"/></svg>`;
}

const fact = (k, v) => (v || v === 0 ? `<dt>${k}</dt><dd>${esc(String(v))}</dd>` : '');

function pvHTML(it) {
  const raw = it.raw ?? {};
  let kicker = LABEL[it.group] ?? it.group, art = '', facts = '', desc = '', tags = '';
  switch (it.group) {
    case '资料':
      kicker = `资料 · ${raw.course ?? ''}`;
      facts = fact('类型', raw.kind) + fact('年份', raw.year) + fact('页数', raw.pages && `${raw.pages} 页`) + fact('格式', raw.format && String(raw.format).toUpperCase()) + fact('上传', raw.uploader) + fact('版权', raw.rights);
      desc = raw.note ?? '';
      break;
    case '四六级':
      kicker = raw.name ?? '四六级';
      facts = fact('考期', raw.year && `${raw.year} 年 ${raw.month} 月`) + fact('听力', raw.set ? (raw.set.listening ? '有' : '无') : '') + fact('资源', it.sub);
      break;
    case '校园':
      if (raw.feature) {
        kicker = `${CAMPUS[raw.campus] ?? ''} · 楼`;
        art = footprint(raw.feature.geometry);
        facts = fact('校区', CAMPUS[raw.campus]) + fact('用途', USE[raw.feature.properties?.use] || '');
      } else {
        kicker = `${CAMPUS[raw.campus] ?? ''} · 同学标注`;
        desc = raw.place?.properties?.data?.body ?? '';
      }
      break;
    case '开源项目':
      kicker = CATEGORIES[raw.category]?.name ?? '开源项目';
      desc = raw.summary ?? '';
      facts = fact('星标', raw.repo?.stars != null && Number(raw.repo.stars).toLocaleString('zh-CN')) + fact('语言', raw.repo?.language) + fact('分叉', raw.repo?.forks != null && Number(raw.repo.forks).toLocaleString('zh-CN')) + fact('作者', raw.origin === 'external' ? raw.credit : '矿大同学');
      tags = (raw.tags ?? []).slice(0, 5).map((t) => `<span>${esc(t)}</span>`).join('');
      break;
    case '成员':
      kicker = '成员';
      facts = fact('账号', raw.login) + fact('专业', raw.major) + fact('年级', raw.grade && `${raw.grade} 级`);
      desc = raw.bio ?? '';
      break;
    case '校圈':
      kicker = `校圈 · ${raw.owner?.name ?? '同学'}`;
      desc = String(raw.data?.body ?? '').slice(0, 160);
      facts = fact('回复', raw.replies ?? 0) + fact('赞', raw.likes ?? 0);
      break;
    case '口碑': {
      const x = raw.teacher ?? raw.course ?? {};
      kicker = raw.teacher ? `老师 · ${x.faculty || '学院待核'}` : '课程';
      if (x.stats?.count) art = `<div class="sl-score"><b class="num">${x.stats.average.toFixed(1)}</b><span>${x.stats.count} 份评价</span><i style="--v:${clamp(x.stats.average / 5, 0, 1)}"></i></div>`;
      else desc = raw.teacher ? '还没有人评价。上过这位老师的课，来写第一份？' : '还没有人评价。上过这门课的话，来写第一份？';
      break;
    }
    default:
      kicker = it.group === '操作' ? '快捷操作' : it.group;
      desc = it.sub ?? '';
  }
  return `
    <div class="sl-pv-art">${art || iconOf(it)}</div>
    <p class="sl-pv-kicker">${esc(kicker)}</p>
    <h3 class="sl-pv-title">${esc(it.title)}</h3>
    ${desc ? `<p class="sl-pv-desc">${esc(desc)}</p>` : ''}
    ${facts ? `<dl class="sl-pv-facts">${facts}</dl>` : ''}
    ${tags ? `<p class="sl-pv-tags">${tags}</p>` : ''}
    <div class="sl-pv-actions">
      <button type="button" class="sl-btn is-primary" data-pv="open">${it.run ? '执行' : '打开'} <kbd>↵</kbd></button>
      ${it.run ? '' : '<button type="button" class="sl-btn" data-pv="tab">新标签</button><button type="button" class="sl-btn" data-pv="copy">复制链接</button>'}
    </div>`;
}

// 预览换内容：整块淡入上移（CSS 合成动画）；方向键连按时不重复播
function preview(it) {
  if (!it || narrow() || st.pvItem === it) return;
  st.pvItem = it;
  const now = performance.now();
  const quick = now - st.lastPv < 140;
  st.lastPv = now;
  ui.pv.classList.toggle('is-in', !quick && !reduced());
  ui.pv.innerHTML = pvHTML(it);
}

// ---------- 首页：字帘、快捷操作、最近 ----------
function curtainSets() {
  const sets = [];
  const len = (t) => [...String(t ?? '').replace(/\s/g, '')].length;
  const fits = (t, n = 10) => len(t) >= 2 && len(t) <= n;
  const uniq = (arr) => [...new Set(arr)];
  if (index) {
    const by = new Map();
    for (const it of index) if (it.group === '资料' && it.raw?.course && it.raw.course !== '其他课程') by.set(it.raw.course, (by.get(it.raw.course) || 0) + 1);
    const courses = [...by].sort((x, y) => y[1] - x[1]).map(([c]) => c).filter((c) => fits(c));
    if (courses.length) sets.push({ id: 'course', label: '课程', roof: 'eave', title: '课程 ——<br>资料最多的几门课，原卷、答案和笔记', terms: courses.slice(0, 60) });
    const places = uniq(index.filter((it) => it.group === '校园' && it.raw?.feature).map((it) => it.title)).filter((t) => fits(t));
    if (places.length >= 3) sets.push({ id: 'campus', label: '校园', roof: 'arch', title: '校园 ——<br>地图上的楼', terms: places.slice(0, 60) });
    const cet = uniq(index.filter((it) => it.group === '四六级' && it.raw?.year).map((it) => `${it.raw.year} 年 ${it.raw.month} 月 ${it.raw.exam === 'cet4' ? '四级' : '六级'}`));
    if (cet.length >= 3) sets.push({ id: 'cet', label: '四六级', roof: 'flat', title: '四六级 ——<br>每一次考试，按年份排好了', terms: cet.slice(0, 60) });
    const open = uniq([...Object.values(CATEGORIES).map((c) => c.short), ...index.filter((it) => it.group === '开源项目').flatMap((it) => it.raw?.tags ?? [])]).filter((t) => fits(t, 8));
    if (open.length >= 3) sets.push({ id: 'open', label: '开源', roof: 'eave', title: '开源 ——<br>广场上项目的方向和标签', terms: open.slice(0, 60) });
  }
  const recents = read(RECENT).map((x) => x.q).filter((q) => fits(q, 12));
  if (recents.length >= 2) sets.push({ id: 'recent', label: '最近', roof: 'arch', title: '最近 ——<br>你搜过的词，只记在这台设备上', terms: recents });
  if (!sets.length) sets.push({ id: 'boards', label: '板块', roof: 'eave', title: '板块 ——<br>全站的几个去处', terms: PAGES.map(([t]) => t).filter((t) => fits(t)) });
  return sets;
}

// 左边的大标题跟着字帘换：编号、衬线标题逐行从遮罩里升起（CSS）、前后两帘的名字
function renderHero(set, i, n) {
  if (!ui.heroTitle) return;
  const all = st.curtainSets ?? [];
  ui.heroNum.textContent = String(i + 1).padStart(2, '0');
  ui.heroTotal.textContent = `/ ${String(n).padStart(2, '0')}`;
  ui.heroPrev.textContent = all[(i - 1 + n) % n]?.label ?? '';
  ui.heroNext.textContent = all[(i + 1) % n]?.label ?? '';
  ui.heroNav.hidden = n < 2;
  const lines = String(set.title ?? esc(set.label)).split('<br>');
  ui.heroTitle.innerHTML = lines.map((l, k) => `<span class="sl-line"><span style="--k:${k}">${l}</span></span>`).join('');
}

// 字帘挑好了这一帘的默认搜索：灰字换上去（逐字升起，CSS）
function setDefault(term) {
  st.defaultTerm = term;
  ui.input.setAttribute('aria-label', term ? `搜索资料、帖子、楼、老师、项目；空着按回车搜“${term}”` : '搜索资料、帖子、楼、老师、项目');
  ui.phText.textContent = term || '';
  if (!term) return;
  // 整块灰字一起升起（一个合成层），不再逐字各动一个：玻璃胶囊里要重算的区域最小
  ui.ph.classList.remove('is-in');
  if (!reduced() && dlg?.open) requestAnimationFrame(() => ui.ph.classList.add('is-in'));
}

// 几套词有变化才重挂字帘
function refreshCurtain() {
  const next = curtainSets();
  const sig = (sets) => sets.map((x) => `${x.id}:${x.terms.join('|')}`).join('/');
  if (st.curtainSets && sig(next) === sig(st.curtainSets)) return;
  st.curtainSets = next;
  st.curtain?.setSets(next);
}

function renderRecent() {
  const rec = read(RECENT), opened = read(OPENED);
  if (!rec.length && !opened.length) {
    ui.recent.innerHTML = '<div class="sl-sec sl-rise"><span>最近</span></div><p class="sl-tip sl-rise">搜过的词和打开过的结果会记在这台设备上，下次直接点。不会上传。</p>';
    return;
  }
  ui.recent.innerHTML = (rec.length ? `<div class="sl-sec sl-rise"><span>最近搜索</span><button type="button" data-clear="recent">清除</button></div>
      <div class="sl-chips sl-rise">${rec.map((x) => `<span class="sl-chip"><button type="button" data-q="${esc(x.q)}">${esc(x.q)}</button><button type="button" class="sl-chip-x" data-del="${esc(x.q)}" aria-label="删除“${esc(x.q)}”">×</button></span>`).join('')}</div>` : '')
    + (opened.length ? `<div class="sl-sec sl-rise"><span>最近打开</span><button type="button" data-clear="opened">清除</button></div>
      <ul class="sl-opened sl-rise">${opened.slice(0, 4).map((x) => `<li><a href="${esc(x.href)}"><span class="ap-symbol app-icon is-text" aria-hidden="true">${esc(x.icon ?? '')}</span><span class="sl-txt"><span class="sl-ttl">${esc(x.title)}</span><span class="sl-sub">${esc(LABEL[x.group] ?? x.group)}${x.sub ? ` · ${esc(x.sub)}` : ''}</span></span></a></li>`).join('')}</ul>` : '');
}

function setQuery(text) {
  ui.input.value = text;
  ui.input.focus({ preventScroll: true });
  ui.input.setSelectionRange(text.length, text.length);
  onQuery();
}

// ---------- 模式切换（只换 class，过渡都在 CSS 里） ----------
function onQuery() {
  if (st.composing) return;
  st.raw = ui.input.value;
  st.sel = 0;
  ui.bar.classList.toggle('has-q', st.raw.length > 0);
  ui.clear.hidden = !st.raw;
  if (!st.raw.trim()) { if (st.mode !== 'home') toHome(); return; }
  if (st.mode === 'home') toResults();
  queryRemote();
  paint();
}

function toResults() {
  st.mode = 'results';
  ui.panel.dataset.mode = 'results';
  st.keys = new Set();
  hlFollow.reset();
  inkFollow.reset();
  st.pvItem = null;
  clearTimeout(st.modeTimer);
  ui.results.hidden = false;
  ui.scopes.hidden = false;
  st.curtain?.part();
  ui.panel.classList.add('is-swapping');
  st.modeTimer = setTimeout(() => {
    ui.panel.classList.remove('is-swapping');
    if (st.mode !== 'results') return;
    ui.home.hidden = true;
    st.curtain?.pause();
    moveInk();
  }, reduced() ? 0 : 260);
}

function toHome({ animate = true } = {}) {
  st.mode = 'home';
  ui.panel.dataset.mode = 'home';
  st.remote = [];
  st.remoteFor = '';
  st.pending = false;
  st.rev++;
  clearTimeout(st.timer);
  clearTimeout(st.modeTimer);
  st.flat = [];
  st.pvItem = null;
  st.ghostRest = '';
  ui.ghost.innerHTML = '';
  ui.input.removeAttribute('aria-activedescendant');
  ui.home.hidden = false;
  ui.results.hidden = true;
  ui.scopes.hidden = true;
  ui.panel.classList.remove('is-swapping');
  renderRecent();
  st.curtain?.resume();
  if (animate) {
    st.curtain?.drop();
    replay(ui.home);
  }
  status();
}

// 让一块区域里的 .sl-rise 重新播一遍入场
function replay(scope) {
  if (reduced()) return;
  scope.classList.remove('is-enter');
  requestAnimationFrame(() => scope.classList.add('is-enter'));
}

// ---------- 打开结果、执行操作 ----------
function toast(text) {
  clearTimeout(st.toastTimer);
  setStatus(text, true);
  st.toastTimer = setTimeout(() => { st.toastTimer = 0; status(); }, 2200);
}

function runAction(id) {
  if (id === 'theme') {
    document.querySelector('[data-theme-toggle]')?.click();
    toast('外观已切换');
  } else if (id === 'copy') {
    navigator.clipboard?.writeText(location.href).then(() => toast('已复制本页链接'), () => toast('复制失败，浏览器没给权限'));
  } else if (id === 'top') {
    close().then(() => scrollTo({ top: 0, behavior: reduced() ? 'auto' : 'smooth' }));
  }
}

function activate(it, { newTab = false } = {}) {
  if (!it) return;
  const q = parse(st.raw).q;
  if (it.run) { runAction(it.run); return; }
  if (q) remember(q);
  if (it.group !== '更多' && it.group !== '操作') rememberOpen(it);
  const url = new URL(it.href, location.href);
  if (newTab || it.external) {
    window.open(url.href, '_blank', 'noopener');
    return;
  }
  if (url.origin === location.origin && url.pathname === location.pathname && url.search === location.search) {
    close().then(() => { if (url.hash && url.hash !== location.hash) location.hash = url.hash; });
    return;
  }
  ui.list.querySelector(`#sl-opt-${st.sel}`)?.classList.add('is-going');
  location.href = url.href;
}

function seeAll() {
  const r = compute();
  const scope = r.scope !== 'all' ? r.scope : st.flat[st.sel]?.group;
  const more = r.q && GROUPS[scope]?.[1]?.(r.q);
  if (r.q) remember(r.q);
  location.href = more || `search.html?q=${encodeURIComponent(r.q)}`;
}

// ---------- 状态栏：换字时淡一下（CSS） ----------
function setStatus(text, force = false) {
  if (!force && text === st.statusText) return;
  st.statusText = text;
  ui.status.textContent = text;
  ui.status.classList.remove('is-new');
  if (!reduced()) requestAnimationFrame(() => ui.status.classList.add('is-new'));
}

function status() {
  if (st.toastTimer) return;
  const text = !index ? '正在建立索引…' : st.pending ? '正在查校圈、地点和口碑…' : online ? '本地目录 + 社区服务' : online === false ? '离线 · 只搜本地目录' : '本地目录';
  setStatus(text);
}

// ---------- 事件 ----------
function onKey(e) {
  if (st.composing || e.isComposing || e.keyCode === 229) return;
  const k = e.key;
  if (st.mode !== 'results') {
    // 空着按回车（或 → / Tab）：搜灰字里的默认词
    if ((k === 'Enter' || k === 'ArrowRight' || (k === 'Tab' && !e.shiftKey)) && !ui.input.value.trim() && st.defaultTerm) {
      e.preventDefault();
      setQuery(st.defaultTerm);
      return;
    }
    if (k === 'ArrowDown') {
      const first = ui.acts.querySelector('button');
      if (first) { e.preventDefault(); first.focus(); }
    }
    if (k === 'Enter') e.preventDefault();
    return;
  }
  if (k === 'ArrowDown' || k === 'ArrowUp') {
    e.preventDefault();
    select(st.sel + (k === 'ArrowDown' ? 1 : -1));
  } else if (k === 'PageDown' || k === 'PageUp') {
    e.preventDefault();
    const groups = [...new Set(st.flat.map((it) => it.group))];
    const g = groups.indexOf(st.flat[st.sel]?.group) + (k === 'PageDown' ? 1 : -1);
    const target = groups[clamp(g, 0, groups.length - 1)];
    select(st.flat.findIndex((it) => it.group === target));
  } else if (k === 'Tab' && !e.altKey && !e.ctrlKey && !e.metaKey) {
    if (cycleScope(e.shiftKey ? -1 : 1)) e.preventDefault();
  } else if (k === 'ArrowRight' && st.ghostRest && ui.input.selectionEnd === ui.input.value.length) {
    e.preventDefault();
    setQuery(ui.input.value + st.ghostRest);
  } else if (k === 'Enter') {
    e.preventDefault();
    if (e.shiftKey) seeAll();
    else activate(st.flat[st.sel], { newTab: e.metaKey || e.ctrlKey });
  }
}

function bind() {
  const input = ui.input;
  input.addEventListener('input', (e) => { if (!e.isComposing) onQuery(); });
  input.addEventListener('compositionstart', () => { st.composing = true; st.rev++; clearTimeout(st.timer); st.pending = false; ui.bar.classList.add('has-q'); });
  input.addEventListener('compositionend', () => { st.composing = false; onQuery(); });
  input.addEventListener('keydown', onKey);
  input.addEventListener('keyup', (e) => { if (e.key === 'ArrowLeft' || e.key === 'Home') updateGhost(); });
  ui.clear.addEventListener('click', () => setQuery(''));
  ui.cancel.addEventListener('click', () => close());
  // 点灰字后面的 ↵：等于空着按回车
  ui.ph.querySelector('.sl-ph-key').addEventListener('click', () => { if (st.defaultTerm && !input.value) setQuery(st.defaultTerm); });

  ui.list.addEventListener('click', (e) => {
    const more = e.target.closest('.sl-grp a');
    if (more) { remember(parse(st.raw).q); return; }
    const scopeBtn = e.target.closest('[data-scope]');
    if (scopeBtn) { setScope(scopeBtn.dataset.scope); input.focus(); return; }
    const a = e.target.closest('.sl-row a');
    if (!a) return;
    e.preventDefault();
    const i = Number(a.closest('.sl-row').dataset.i);
    st.sel = i;
    activate(st.flat[i], { newTab: e.metaKey || e.ctrlKey || e.shiftKey });
  });
  // 鼠标移动（不是滚动）时跟着选中，和系统聚焦搜索一样
  ui.list.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    const li = e.target.closest('.sl-row');
    if (li && Number(li.dataset.i) !== st.sel) select(Number(li.dataset.i), { scroll: false });
  });
  ui.scopeRow.addEventListener('click', (e) => {
    const b = e.target.closest('[data-scope]');
    if (!b) return;
    setScope(b.dataset.scope);
    input.focus({ preventScroll: true });
  });
  ui.scopeRow.addEventListener('scroll', () => moveInk({ quiet: true }), { passive: true });
  // 玻璃滑杆：拖动时实时生效，松手记住
  const range = dlg.querySelector('.sl-glassctl input');
  range.addEventListener('input', () => applyGlass(Number(range.value)));
  range.addEventListener('change', () => { try { localStorage.setItem(GLASS_KEY, range.value); } catch { /* 隐私模式 */ } toast(Number(range.value) < 34 ? '玻璃：清透' : Number(range.value) > 66 ? '玻璃：磨砂' : '玻璃：适中'); });
  ui.heroNav.addEventListener('click', (e) => {
    const b = e.target.closest('[data-curtain]');
    if (b) st.curtain?.[b.dataset.curtain === '1' ? 'next' : 'prev']();
  });
  ui.acts.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (b) activate(ACTIONS[Number(b.dataset.act)]);
  });
  ui.acts.addEventListener('keydown', (e) => {
    const btns = [...ui.acts.querySelectorAll('button')];
    const i = btns.indexOf(document.activeElement);
    if (i < 0) return;
    const cols = narrow() ? 1 : 4;
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols }[e.key];
    if (!step) return;
    e.preventDefault();
    if (e.key === 'ArrowUp' && i < cols) { input.focus(); return; }
    btns[clamp(i + step, 0, btns.length - 1)].focus();
  });
  ui.recent.addEventListener('click', (e) => {
    const t = e.target.closest('button, a');
    if (!t) return;
    if (t.dataset.q != null) setQuery(t.dataset.q);
    else if (t.dataset.del != null) {
      write(RECENT, read(RECENT).filter((x) => x.q !== t.dataset.del));
      renderRecent();
      input.focus();
    } else if (t.dataset.clear) {
      write(t.dataset.clear === 'recent' ? RECENT : OPENED, []);
      renderRecent();
      if (t.dataset.clear === 'recent') { st.curtainSets = curtainSets(); st.curtain?.setSets(st.curtainSets); }
      input.focus();
    }
  });
  ui.pv.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pv]');
    const it = st.flat[st.sel];
    if (!b || !it) return;
    if (b.dataset.pv === 'open') activate(it);
    else if (b.dataset.pv === 'tab') activate(it, { newTab: true });
    else if (b.dataset.pv === 'copy') {
      navigator.clipboard?.writeText(new URL(it.href, location.href).href).then(() => toast('链接已复制'), () => toast('复制失败，浏览器没给权限'));
    }
  });

  dlg.addEventListener('click', (e) => { if (e.target === dlg || e.target === ui.stage) close(); });
  dlg.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    st.escAt = performance.now();
    if (document.activeElement !== input) input.focus();
    else if (input.value) setQuery('');
    else close();
  }, true);
  // Esc 已经在上面处理过（可能只是清空了输入），别再当成关闭
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); if (performance.now() - st.escAt > 120) close(); });
  // 别处关掉的（返回键等）：事件到的时候确实还关着才收尾，免得迟到的事件把刚打开的状态清掉
  dlg.addEventListener('close', () => { if (!dlg.open) cleanup(); });
  // 背后的页面别跟着滚
  dlg.addEventListener('wheel', (e) => { if (!e.target.closest('.sl-scroll, .sl-home, .sl-pv, .sl-scope-row')) e.preventDefault(); }, { passive: false });
  // 指针带动胶囊边上的高光：只转一层（transform），不重画
  dlg.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse' || reduced() || st.specRaf || dlg.classList.contains('is-morph')) return;
    const { clientX: x, clientY: y } = e;
    st.specRaf = requestAnimationFrame(() => {
      st.specRaf = 0;
      const r = (st.barRect ??= ui.bar.getBoundingClientRect());
      const ang = (Math.atan2(x - (r.left + r.width / 2), -(y - (r.top + r.height / 2))) * 180) / Math.PI;
      const prev = st.angle ?? ang;
      st.angle = prev + ((((ang - prev) % 360) + 540) % 360) - 180;
      ui.rimDial.style.transform = `translate(-50%, -50%) rotate(${st.angle.toFixed(1)}deg)`;
      ui.glare.style.transform = `translate3d(${(x - r.left).toFixed(0)}px, -50%, 0)`;
    });
  });
  addEventListener('pageshow', (e) => { if (e.persisted && dlg.open) { dlg.close(); cleanup(); } });
  addEventListener('resize', () => {
    st.barRect = null;
    if (dlg.open) { moveInk(); if (st.mode === 'results') select(st.sel, { scroll: false, instant: true }); }
  });
  visualViewport?.addEventListener('resize', setVVH);
}

function setVVH() {
  if (dlg) dlg.style.setProperty('--vvh', `${Math.round(visualViewport?.height ?? innerHeight)}px`);
}

// ---------- 展开与收起：全部跑在合成线程（WAAPI 只动 transform / opacity），主线程忙也不掉帧 ----------
// 胶囊的影子拆成“左半圆 + 中段 + 右半圆”：只靠平移和缩放就能从按钮长成胶囊，圆角不变形；
// 面板的影子是一块带波浪边的“液体”，在固定的圆角框里往下淌。真玻璃落定后才淡入，变形期间不算 backdrop。
const EASE_IOS = 'cubic-bezier(0.32, 0.72, 0, 1)';
const EASE_POUR = 'cubic-bezier(0.16, 1, 0.3, 1)';
const WAVE = 44;

// 弹簧：把阻尼弹簧的曲线采样成 CSS linear() 缓动（合成线程照样能跑），带一点过冲再弹回。
// 返回整段时长和“基本到位”（误差 < 1%）的时刻；浏览器不支持 linear() 时退回 iOS 曲线。
function spring(stiffness, damping) {
  if (!CSS.supports('transition-timing-function', 'linear(0, 1)')) return { easing: EASE_IOS, duration: 600, settle: 600 };
  const w0 = Math.sqrt(stiffness), z = damping / (2 * w0), wd = w0 * Math.sqrt(1 - z * z);
  const x = (t) => 1 - Math.exp(-z * w0 * t) * (Math.cos(wd * t) + ((z * w0) / wd) * Math.sin(wd * t));
  let end = 0, near = 0;
  for (let t = 0; t < 4; t += 0.004) {
    const d = Math.abs(1 - x(t));
    if (d > 0.002) end = t;
    if (d > 0.01) near = t;
  }
  const pts = Array.from({ length: 61 }, (_, i) => (i === 60 ? 1 : x((end * i) / 60)).toFixed(4));
  return { easing: `linear(${pts.join(', ')})`, duration: Math.round(end * 1000), settle: Math.round(near * 1000) };
}
const BAR_SPRING = spring(260, 24); // 约 3% 过冲：胶囊长出来时带着一点惯性多冲一下再收回
const FLY_SPRING = spring(300, 17); // 放大镜落位时转一下、弹一下（只用于旋转和缩放）

function visibleRect(el) {
  if (!el?.isConnected) return null;
  const r = el.getBoundingClientRect();
  return r.width && r.height && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth ? r : null;
}

// 起点：点到的搜索框；键盘打开时用顶栏的搜索按钮；都看不见时从胶囊中间长出来
function pickOrigin(el) {
  return [el, document.querySelector('.gn-search'), document.querySelector('[data-search]')].find((x) => visibleRect(x)) ?? null;
}

// 影子摆到真玻璃的位置：三段胶囊 + 面板的圆角框（只在开始时读一次布局）
function layoutShades() {
  const b = ui.bar.getBoundingClientRect(), p = ui.panel.getBoundingClientRect();
  const h = b.height, half = h / 2;
  const put = (el, x, y, w, hh) => Object.assign(el.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${hh}px` });
  put(ui.capL, b.left, b.top, half, h);
  put(ui.mid, b.left + half, b.top, Math.max(1, b.width - h), h);
  put(ui.capR, b.right - half, b.top, half, h);
  put(ui.pool, p.left, p.top, p.width, p.height);
  ui.pour.style.height = `${p.height}px`;
  return { b, p };
}

// 胶囊从起点 o 到终点 b 的三段变换（起点那一帧）；起点比胶囊还窄时，中段缩成 0
function barFrom(b, o) {
  const s = o.height / b.height, dy = o.top - b.top;
  const mid = Math.max(0, o.width - o.height) / Math.max(1, b.width - b.height);
  return {
    capL: `translate3d(${o.left - b.left}px, ${dy}px, 0) scale(${s})`,
    mid: `translate3d(${o.left + o.height / 2 - (b.left + b.height / 2)}px, ${dy}px, 0) scale(${mid}, ${s})`,
    capR: `translate3d(${o.right - o.height / 2 - (b.right - b.height / 2)}px, ${dy}px, 0) scale(${s})`,
  };
}

function originRect(b) {
  const r = visibleRect(st.origin);
  if (r) return r;
  const w = Math.min(128, b.width), h = Math.min(44, b.height);
  const left = b.left + (b.width - w) / 2, top = b.top + (b.height - h) / 2;
  return { left, top, width: w, height: h, right: left + w, bottom: top + h };
}

function stopMotion() {
  for (const a of st.anims) a.cancel();
  st.anims = [];
  clearTimeout(st.settleTimer);
}

const done = (anims, ms) => Promise.race([Promise.all(anims.map((a) => a.finished)), wait(ms)]).catch(() => {});

const play = (el, frames, opts) => {
  const a = el.animate(frames, { fill: 'both', ...opts });
  st.anims.push(a);
  return a;
};

function settle() {
  dlg.classList.remove('is-morph');
  st.barRect = null;
  st.readyDone?.();
  // 玻璃淡入完再把影子收起来
  st.settleTimer = setTimeout(() => {
    if (dlg.classList.contains('is-morph')) return;
    dlg.classList.remove('has-shades');
    stopMotion();
  }, 280);
}

function playOpen() {
  stopMotion();
  st.ready = new Promise((r) => { st.readyDone = r; });
  if (reduced()) {
    settle();
    if (st.mode === 'home') { st.curtain?.resume(); st.curtain?.drop(); }
    return;
  }
  dlg.classList.add('is-morph', 'has-shades');
  ui.home.classList.remove('is-enter');
  const { b, p } = layoutShades();
  const o = originRect(b);
  const from = barFrom(b, o);
  const bar = { duration: BAR_SPRING.duration, easing: BAR_SPRING.easing };
  play(ui.capL, [{ transform: from.capL }, { transform: 'none' }], bar);
  play(ui.mid, [{ transform: from.mid }, { transform: 'none' }], bar);
  play(ui.capR, [{ transform: from.capR }, { transform: 'none' }], bar);
  // 面板：液体从胶囊下面淌下来（波浪边领头），框本身也轻轻落一点
  play(ui.pour, [{ transform: `translate3d(0, ${-(p.height + WAVE)}px, 0)` }, { transform: 'none' }], { duration: 760, delay: 140, easing: EASE_POUR });
  play(ui.wave, [{ transform: 'translate3d(-4%, 0, 0)' }, { transform: 'translate3d(4%, 0, 0)' }], { duration: 760, delay: 140, easing: 'ease-in-out' });
  play(ui.pool, [{ transform: 'translate3d(0, -12px, 0)' }, { transform: 'none' }], { duration: 760, delay: 140, easing: EASE_POUR });
  st.origin?.classList.add('sl-origin');

  // 放大镜：从按钮里的图标飞进输入框，走一点弧线、转正
  const dst = ui.mag.getBoundingClientRect();
  const icon = visibleRect(st.origin?.querySelector('svg')) ?? { left: o.left + o.width / 2 - 9, top: o.top + o.height / 2 - 9, width: 18, height: 18 };
  const fx = icon.left + icon.width / 2 - (dst.left + dst.width / 2), fy = icon.top + icon.height / 2 - (dst.top + dst.height / 2);
  Object.assign(ui.fly.style, { left: `${dst.left}px`, top: `${dst.top}px`, width: `${dst.width}px`, height: `${dst.height}px`, display: 'block' });
  const k = icon.width / dst.width;
  // 位置走不过冲的曲线，旋转和缩放走弹簧（三个独立属性，互不影响）
  play(ui.fly, [{ translate: `${fx}px ${fy}px` }, { translate: '0px 0px' }], { duration: 560, easing: EASE_IOS });
  play(ui.fly, [{ rotate: '-32deg', scale: String(k) }, { rotate: '0deg', scale: '1' }], { duration: FLY_SPRING.duration, easing: FLY_SPRING.easing });
  st.flyTimer = setTimeout(() => { ui.fly.style.display = 'none'; }, Math.max(BAR_SPRING.duration, FLY_SPRING.duration));

  // 胶囊停稳（弹簧走完）：真玻璃淡入、彩光流过、首页内容升起、字帘垂下
  st.settleTimer = setTimeout(() => {
    ui.bar.classList.add('is-glow');
    settle();
    if (st.mode === 'home') {
      replay(ui.home);
      st.curtain?.resume();
      st.curtain?.drop();
    }
  }, BAR_SPRING.duration);
}

export function close() {
  if (!dlg?.open) return Promise.resolve();
  if (st.closing) return st.closing;
  stopMotion();
  clearTimeout(st.flyTimer);
  ui.fly.style.display = 'none';
  st.curtain?.pause();
  // 自己关的就自己收尾：不等 close 事件（页面不在渲染时它会延迟）
  const finish = () => { if (dlg.open) dlg.close(); cleanup(); };
  if (reduced()) {
    dlg.classList.add('is-closing');
    st.closing = done([play(dlg, [{ opacity: 1 }, { opacity: 0 }], { duration: 150 })], 170).then(finish);
    return st.closing;
  }
  // 先读几何（样式还是干净的，不会强制重算），再切到“收起”状态
  const { b, p } = layoutShades();
  dlg.classList.add('is-closing', 'is-morph', 'has-shades');
  ui.bar.classList.remove('is-glow');
  const target = visibleRect(st.origin);
  const to = barFrom(b, originRect(b));
  const bar = { duration: 380, delay: 60, easing: 'cubic-bezier(0.55, 0, 0.45, 1)' };
  play(ui.pour, [{ transform: 'none' }, { transform: `translate3d(0, ${-(p.height + WAVE)}px, 0)` }], { duration: 320, easing: 'cubic-bezier(0.5, 0, 0.75, 0)' });
  play(ui.pool, [{ transform: 'none' }, { transform: 'translate3d(0, -10px, 0)' }], { duration: 320, easing: 'cubic-bezier(0.5, 0, 0.75, 0)' });
  const last = [
    play(ui.capL, [{ transform: 'none' }, { transform: to.capL }], bar),
    play(ui.mid, [{ transform: 'none' }, { transform: to.mid }], bar),
    play(ui.capR, [{ transform: 'none' }, { transform: to.capR }], bar),
  ];
  // 回到看得见的按钮：最后一瞬把按钮交还；没有起点时整个胶囊淡掉
  const fade = { duration: target ? 90 : 160, delay: target ? 350 : 280, easing: 'linear' };
  for (const el of [ui.capL, ui.mid, ui.capR]) play(el, [{ opacity: 1 }, { opacity: 0 }], fade);
  setTimeout(() => st.origin?.classList.remove('sl-origin'), target ? 380 : 300);
  st.closing = done(last, 460).then(finish);
  return st.closing;
}

// 浏览器自己关掉对话框（返回键、往返缓存恢复）时动画可能还在跑：全部停掉复位
function cleanup() {
  stopMotion();
  clearTimeout(st.flyTimer);
  st.closing = null;
  st.readyDone?.();
  dlg.classList.remove('is-morph', 'has-shades', 'is-closing');
  dlg.getAnimations().forEach((a) => a.cancel());
  ui.fly.style.display = 'none';
  ui.bar.classList.remove('is-glow');
  ui.home.classList.remove('is-enter');
  st.origin?.classList.remove('sl-origin');
  st.curtain?.pause();
  inkFollow.reset(); hlFollow.reset();
  cancelAnimationFrame(st.specRaf); st.specRaf = 0;
  st.rev++;
  clearTimeout(st.timer);
  clearTimeout(st.modeTimer);
  ui.panel.classList.remove('is-swapping');
  st.pending = false;
  st.composing = false;
}

// 掉帧就退回磨砂玻璃（只看打开后的前 40 帧；本次会话记住）
function watchFrames() {
  if (!st.glass.length) return;
  const gaps = [];
  let last = performance.now();
  const tick = (t) => {
    gaps.push(t - last);
    last = t;
    if (gaps.length < 40 && dlg.open) { requestAnimationFrame(tick); return; }
    gaps.sort((a, b) => a - b);
    if (gaps.filter(t => t > 25).length > gaps.length * .2) {
      st.glass.forEach((g) => g.off());
      st.glass = [];
      try { sessionStorage.setItem('lk-glass-off', '1'); } catch { /* 无痕模式 */ }
    }
  };
  requestAnimationFrame(tick);
}

function loadIndex() {
  indexJob ??= buildIndex().then((items) => {
    index = items;
    // Build a stable index once; typing only scores prepared fields.
    const idle = window.requestIdleCallback ?? ((cb) => setTimeout(cb, 300));
    idle(() => { indexedSearch = createFuzzyIndex(items); }, { timeout: 2000 });
  }, () => { index = fallbackIndex(); });
  return indexJob;
}

const canLiquid = () => !narrow() && matchMedia('(pointer: fine)').matches && (() => { try { return !sessionStorage.getItem('lk-glass-off'); } catch { return true; } })();

// 提前备好：模块、样式表、整块 DOM、液态玻璃的位移图、字帘——都在页面空闲时做，点下去只剩“开始动”
let warmed = false;
export function prewarm() {
  if (warmed) return;
  warmed = true;
  ensure();
  if (!st.glass.length && canLiquid())
    st.glass = [liquid(ui.bar, { bevel: 30, strength: 20, size: { width: Math.min(880, innerWidth - 32), height: 68 } })].filter(Boolean);
  if (!st.curtain) {
    st.curtainSets = curtainSets();
    st.curtain = mountCurtain(ui.curtainHost, { sets: st.curtainSets, onDefault: setDefault, onSet: renderHero, reduced: reduced(), compact: narrow() });
    st.curtain.pause();
  }
  // 隐身打开一次再关上：第一次的样式匹配、排版、衬线字体加载都在空闲时做完，真正点开时只剩动画
  // inert：隐身打开时不抢页面上的焦点
  if (!dlg.open) {
    dlg.inert = true;
    dlg.classList.add('is-prewarm');
    dlg.show();
    void ui.panel.offsetHeight;
    dlg.close();
    dlg.classList.remove('is-prewarm');
    dlg.inert = false;
  }
  loadIndex().then(() => { if (!dlg.open) refreshCurtain(); });
}

// 悬停在搜索按钮上：备好界面，再把索引建起来
export function warm() {
  prewarm();
  loadIndex();
}

export async function openSpotlight({ initial = '', origin = null, toggle = false } = {}) {
  prewarm();
  if (dlg.open) {
    if (st.closing) return;
    if (toggle) { close(); return; }
    ui.input.focus();
    ui.input.select();
    return;
  }
  st.origin = pickOrigin(origin);
  setVVH();
  st.diffuse = (() => { try { return backdropComplexity(); } catch { return 0; } })();
  applyGlass();
  // 先进“变形中”状态再显示：第一帧就是影子，面板内容不参与这一帧的样式和布局
  if (!reduced()) dlg.classList.add('is-morph', 'has-shades');
  dlg.showModal();
  ui.input.value = initial;
  st.raw = initial;
  // 上次带着字关掉的（点背景、返回键），这次输入框是空的：灰字和清除按钮要跟着复位
  ui.bar.classList.toggle('has-q', !!initial);
  ui.clear.hidden = !initial;
  st.scope = 'all';
  st.tabsSig = '';
  ui.scroll.scrollTop = 0;
  if (initial.trim()) {
    st.mode = 'home';
    onQuery();
  } else {
    toHome({ animate: false });
    st.curtain.pause();
    if (st.defaultTerm) setDefault(st.defaultTerm);
  }
  ui.input.focus({ preventScroll: true });
  playOpen();
  // 其余的活都等胶囊落定再做，不和打开动画抢主线程
  const ready = st.ready;
  ready.then(() => { watchFrames(); status(); });
  if (online === null)
    hubState().then(async (s) => { online = !!s.online; await ready; if (dlg.open) { queryRemote(); paint(); status(); } }, () => { online = false; });
  if (!index)
    loadIndex().then(async () => {
      await ready;
      if (!dlg.open) return;
      refreshCurtain();
      paint();
      status();
    });
}
