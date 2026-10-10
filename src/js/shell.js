// 每个页面共用：导航状态、深浅色切换、滚动入场。
import '@fontsource-variable/inter/wght.css';
import '../styles/tokens.css';
import '../styles/base.css';
import '../styles/components.css';
import '../styles/redesign.css';
import '../styles/navigation.css';
import '../styles/apple.css';
import '../styles/store.css';
import '../styles/motion.css';
import '../styles/ui.css';
import '../styles/liquid.css';
import { initFx, pop } from './fx.js';
import { DUR, EASE, spring, transition } from './motion.js';

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

const store = {
  get(k) {
    try { return localStorage.getItem(k); } catch { return null; }
  },
  set(k, v) {
    try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* 隐私模式 */ }
  },
};

// 六个一级板块（docs/PRODUCT_SPEC.md 1.1）。旧页面都保留，按内容归到对应板块，导航按板块高亮。
const BOARD = {
  home: 'home',
  map: 'campus', reservations: 'campus',
  materials: 'materials', cet4: 'materials', cet6: 'materials', school: 'materials', knowledge: 'materials',
  circle: 'circle', reputation: 'circle', community: 'circle', rules: 'circle',
  projects: 'open', discover: 'open', project: 'open', contribute: 'open',
  studio: 'me', me: 'me', profile: 'me', auth: 'me',
};

// 六个板块在导航里的先后，用来决定换页时往哪边推
const RANK = { home: 0, campus: 1, materials: 2, circle: 3, open: 4, me: 5 };
const pageOf = (url) => (url.pathname.split('/').pop().replace(/\.html$/, '') || 'index').replace(/^index$/, 'home');

// 同一板块里的层级：详情页比列表深一层（像 App Store 点开一张卡片）；同层的分段（校圈的动态 / 教师 / 课程）按左右排
function depthOf(url) {
  const p = pageOf(url), q = url.searchParams;
  if (p === 'project' || p === 'profile') return 1;
  if (p === 'reputation') return ['teacher', 'course', 'offering'].some((k) => q.has(k)) ? 1 : 0;
  return 0;
}
function laneOf(url) {
  if (pageOf(url) !== 'reputation') return 0;
  return url.searchParams.get('view') === 'courses' || url.searchParams.has('course') || url.searchParams.has('offering') ? 2 : 1;
}
function directionOf(fromURL, toURL) {
  const from = RANK[BOARD[pageOf(fromURL)]], to = RANK[BOARD[pageOf(toURL)]];
  if (from == null || to == null) return 'same';
  if (from !== to) return to > from ? 'forward' : 'back';
  const fd = depthOf(fromURL), td = depthOf(toURL);
  if (fd !== td) return td > fd ? 'in' : 'out';
  const fl = laneOf(fromURL), tl = laneOf(toURL);
  return fl === tl ? 'same' : tl > fl ? 'forward' : 'back';
}

// 换页之前记下方向，下一页在第一帧之前读（head.html）。pageswap 只在真的换页时触发，点了又被拦下的链接不会留下脏数据；
// 不支持 pageswap 的浏览器在点击时记一次，带时间戳，过期作废。
function rememberDirection(href) {
  let url;
  try { url = new URL(href, location.href); } catch { return; }
  if (url.origin !== location.origin) return;
  const dir = directionOf(new URL(location.href), url);
  try { sessionStorage.setItem('lk-vt', JSON.stringify({ dir, at: Date.now() })); } catch { /* 隐私模式 */ }
}

// 前进 / 后退：回到上一页时动画方向和来时相反（来时推入，返回就推出）。
// 每次真正换页时，记下“到达这一条历史记录时用的方向”；之后在历史里来回走，就按记录取反或沿用。
const INVERT = { in: 'out', out: 'in', forward: 'back', back: 'forward', same: 'same' };
function arrivals() {
  try { return JSON.parse(sessionStorage.getItem('lk-vt-arrive') || '{}'); } catch { return {}; }
}
function saveArrival(key, dir) {
  const m = arrivals();
  delete m[key];
  m[key] = dir;
  const keys = Object.keys(m);
  if (keys.length > 50) delete m[keys[0]];
  try { sessionStorage.setItem('lk-vt-arrive', JSON.stringify(m)); } catch { /* 隐私模式 */ }
}
function writeDirection(dir) {
  try { sessionStorage.setItem('lk-vt', JSON.stringify({ dir, at: Date.now() })); } catch { /* 隐私模式 */ }
}
function directionFor(activation) {
  const to = new URL(activation.entry.url), from = new URL(location.href);
  const dir = directionOf(from, to);
  if (activation.navigationType === 'traverse' && activation.from) {
    const m = arrivals();
    if (activation.entry.index < activation.from.index) return m[activation.from.key] ? INVERT[m[activation.from.key]] : dir;
    return m[activation.entry.key] ?? dir;
  }
  if (activation.entry.key) saveArrival(activation.entry.key, dir);
  return dir;
}

// 返回上一页时回到离开时的位置。浏览器自己的恢复在“内容是异步渲染出来的”页面上会落空（列表还没出来就恢复了），
// 所以从历史里回来时改为手动：内容高度够了再滚过去；用户已经动过页面就不再动它。
const readyHooks = [];
export function pageReady() { readyHooks.splice(0).forEach((f) => f()); }

function initScrollMemory() {
  const KEY = 'lk-scroll';
  const read = () => { try { return JSON.parse(sessionStorage.getItem(KEY) || '{}'); } catch { return {}; } };
  const id = () => (globalThis.navigation?.currentEntry?.key ? `k:${navigation.currentEntry.key}` : `u:${location.href}`);
  addEventListener('pagehide', () => {
    const m = read();
    delete m[id()];
    m[id()] = Math.round(scrollY);
    const keys = Object.keys(m);
    if (keys.length > 40) delete m[keys[0]];
    try { sessionStorage.setItem(KEY, JSON.stringify(m)); } catch { /* 隐私模式 */ }
  });
  const nav = performance.getEntriesByType?.('navigation')?.[0];
  if (nav?.type !== 'back_forward') return;
  const y = read()[id()];
  if (!y) return;
  history.scrollRestoration = 'manual';
  let done = false, ro;
  const stop = () => { done = true; ro?.disconnect(); };
  ['wheel', 'touchstart', 'keydown'].forEach((t) => addEventListener(t, stop, { once: true, passive: true }));
  const attempt = () => {
    if (done) return;
    if (document.documentElement.scrollHeight >= y + innerHeight * 0.6) {
      scrollTo({ top: y, behavior: 'instant' });
      stop();
    }
  };
  readyHooks.push(attempt);
  attempt();
  if ('ResizeObserver' in window && document.body) {
    ro = new ResizeObserver(attempt);
    ro.observe(document.body);
    setTimeout(stop, 4000);
  }
  addEventListener('load', attempt, { once: true });
}

function initPageTransitions() {
  let navTimer, navGuard;
  const progress = document.createElement('div'); progress.className = 'navigation-progress'; progress.hidden = true;
  progress.setAttribute('role','status'); progress.innerHTML = '<span class="sr-only">正在打开页面…</span><i></i>'; document.body.append(progress);
  const reset = () => { clearTimeout(navTimer); clearTimeout(navGuard); document.documentElement.classList.remove('is-navigating'); progress.hidden = true; };
  addEventListener('pageshow', reset); addEventListener('pagehide', reset);
  addEventListener('pageswap', (e) => {
    // A rapid navigation or a destination without opt-in can cancel the old page's transition.
    e.viewTransition?.ready.catch(() => {});
    e.viewTransition?.finished.catch(() => {});
    if (!e.viewTransition || !e.activation?.entry?.url) return;
    try { writeDirection(directionFor(e.activation)); } catch { rememberDirection(e.activation.entry.url); }
  });
  document.addEventListener('click', (e) => {
    const a = e.target.closest?.('a[href]');
    if (!a || a.target || a.hasAttribute('download') || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const url = new URL(a.href, location.href);
    if (url.origin !== location.origin || (url.pathname !== '/' && !url.pathname.endsWith('.html'))) return;
    const samePage = pageOf(url) === pageOf(new URL(location.href)) && url.search === location.search;
    if (samePage) {
      if (!url.hash && !location.hash) { e.preventDefault(); window.scrollTo({top:0,behavior:reducedMotion()?'instant':'smooth'}); }
      return;
    }
    rememberDirection(a.href);
    clearTimeout(navTimer);
    navTimer = setTimeout(() => { document.documentElement.classList.add('is-navigating'); progress.hidden = false; }, 140);
    clearTimeout(navGuard); navGuard = setTimeout(reset, 10000);
  });
}

function initNav() {
  const gn = document.getElementById('gn');
  if (!gn) return;

  const board = BOARD[document.body.dataset.page];
  document.querySelectorAll('[data-board]').forEach((a) => {
    if (a.dataset.board === board) a.setAttribute('aria-current', 'page');
  });

  const onScroll = () => gn.classList.toggle('is-scrolled', scrollY > 4);
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // 底部标签栏：换到另一个板块时，新板块的图标弹一下（SF Symbols 的 bounce）
  const arrive = document.documentElement.dataset.vtArrive;
  if (arrive === 'forward' || arrive === 'back') setTimeout(() => pop(document.querySelector('.tabbar a[aria-current="page"] svg')), 180);

  initPublish();
  initAccount();
}

// “＋发布”：桌面在按钮下方弹出，手机从底部升起（下面垫一层半透明的底）；只列出现在真的能用的发布流程。
// 菜单挂到 body 上：顶栏有 backdrop-filter，会把里面 fixed 定位的东西困在 48px 高的顶栏里（手机上面板会跑到屏幕外）。
function initPublish() {
  const menu = document.getElementById('gn-pub');
  const triggers = [...document.querySelectorAll('[data-publish]')];
  if (!menu || !triggers.length) return;
  if (menu.parentElement !== document.body) document.body.append(menu);
  const items = () => [...menu.querySelectorAll('a[role="menuitem"]')];
  let opener = null, scrim = null, closing = null;
  const isOpen = () => !menu.hidden && !closing;

  const open = (from) => {
    closing?.cancel?.();
    closing = null;
    menu.getAnimations().forEach((a) => a.cancel());
    const sheet = Boolean(from?.classList.contains('fab'));
    opener = from;
    menu.classList.toggle('is-sheet', sheet);
    triggers.forEach((t) => t.setAttribute('aria-expanded', String(t === from)));
    menu.hidden = false;
    if (sheet) {
      if (!scrim) {
        scrim = document.createElement('div');
        scrim.className = 'gn-pub-scrim';
        scrim.addEventListener('click', () => close());
        document.body.append(scrim);
      }
      scrim.hidden = false;
    }
    if (!reducedMotion()) {
      if (sheet) {
        menu.animate([{ transform: 'translateY(110%)' }, { transform: 'none' }], { duration: DUR.medium, easing: EASE.ios });
        scrim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: DUR.standard, easing: 'ease-out' });
      } else {
        menu.style.transformOrigin = 'top right';
        const s = spring('snappy');
        menu.animate([{ opacity: 0, transform: 'translateY(-6px) scale(.96)' }, { opacity: 1, transform: 'none' }], { duration: s.duration, easing: s.easing });
      }
      items().forEach((a, i) => a.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }],
        { duration: 300, delay: 50 + i * 24, easing: EASE.out, fill: 'backwards' }));
    }
    items()[0]?.focus({ preventScroll: true });
  };

  const close = (refocus = false) => {
    if (menu.hidden || closing) return;
    const back = opener;
    opener = null;
    triggers.forEach((t) => t.setAttribute('aria-expanded', 'false'));
    const sheet = menu.classList.contains('is-sheet');
    const finish = () => {
      closing = null;
      menu.hidden = true;
      menu.getAnimations().forEach((a) => a.cancel());
      if (scrim) { scrim.hidden = true; scrim.getAnimations().forEach((a) => a.cancel()); }
    };
    if (reducedMotion()) finish();
    else {
      const out = menu.animate(sheet
        ? [{ transform: 'none' }, { transform: 'translateY(110%)' }]
        : [{ opacity: 1 }, { opacity: 0, transform: 'translateY(-4px) scale(.98)' }],
      { duration: sheet ? DUR.exitMedium : DUR.exit, easing: EASE.in, fill: 'forwards' });
      if (sheet && scrim) scrim.animate([{ opacity: 1 }, { opacity: 0 }], { duration: DUR.exitMedium, easing: 'ease-in', fill: 'forwards' });
      closing = out;
      Promise.race([out.finished, new Promise((r) => setTimeout(r, 400))]).then(() => { if (closing === out) finish(); }, () => {});
    }
    if (refocus) back?.focus();
  };

  triggers.forEach((t) => t.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isOpen() && opener === t) close(); else open(t);
  }));
  document.addEventListener('click', (e) => {
    if (isOpen() && !menu.contains(e.target) && !triggers.some((t) => t.contains(e.target))) close();
  });
  addEventListener('keydown', (e) => {
    if (!isOpen()) return;
    if (e.key === 'Escape') { close(true); return; }
    const list = items(), i = list.indexOf(document.activeElement);
    if (e.key === 'Tab') { close(); return; }
    const to = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: list.length - 1 }[e.key];
    if (to == null || !list.length) return;
    e.preventDefault();
    list[(to + list.length) % list.length].focus();
  });
  initAccount();
}

// 右上角的消息铃铛和头像。社区服务没连上（例如纯静态部署）时不发请求，只显示“登录”。
async function initAccount() {
  const me = document.querySelector('[data-me]');
  if (!me) return;
  const back = encodeURIComponent(location.pathname.split('/').pop() + location.search);
  me.href = `auth.html?next=${back}`;
  const { hubState, hubApi } = await import('./hub.js');
  const s = await hubState();
  if (!s.online || !s.user) return;
  const name = s.user.name || s.user.username;
  me.href = 'me.html';
  me.classList.add('is-user');
  me.setAttribute('aria-label', `个人中心：${name}`);
  me.textContent = [...name][0].toUpperCase();
  const bell = document.querySelector('[data-bell]');
  if (!bell) return;
  bell.hidden = false;
  try {
    // 维护者：北矿娘主动发来的消息也算进铃铛；有她的新消息时，点铃铛直接去她的窗口
    const [n, bk] = await Promise.all([hubApi.notifications(), s.user.moderator ? hubApi.beikuangUnread().catch(() => ({ unread: 0 })) : { unread: 0 }]);
    const total = n.unread + bk.unread;
    const count = bell.querySelector('[data-bell-count]');
    count.hidden = !total;
    count.textContent = total > 99 ? '99+' : total;
    if (bk.unread) bell.href = 'me.html#beikuang';
    bell.setAttribute('aria-label', bk.unread ? `北矿娘有 ${bk.unread} 条新消息` : n.unread ? `消息，${n.unread} 条未读` : '消息');
  } catch { /* 读不到消息时只显示铃铛 */ }
}

function initTheme() {
  const root = document.documentElement;
  const sysDark = matchMedia('(prefers-color-scheme: dark)');
  const isDark = () => root.dataset.theme === 'dark' || (!root.dataset.theme && sysDark.matches);

  document.querySelectorAll('[data-theme-toggle]').forEach((btn) => {
    const label = () => btn.setAttribute('aria-label', isDark() ? '切换到浅色外观' : '切换到深色外观');
    label();
    let turns = 0;
    btn.addEventListener('click', () => {
      const svg = btn.querySelector('svg');
      if (svg) { turns += 1; svg.style.rotate = `${turns * 180}deg`; }
      transition(() => apply(), 'theme');
    });
    const apply = () => {
      const next = isDark() ? 'light' : 'dark';
      // 选回与系统一致的一侧时，清除手动设置，继续跟随系统
      if ((next === 'dark') === sysDark.matches) {
        delete root.dataset.theme;
        store.set('lk-theme', null);
      } else {
        root.dataset.theme = next;
        store.set('lk-theme', next);
      }
      label();
      dispatchEvent(new CustomEvent('lk:theme'));
    };
    sysDark.addEventListener('change', label);
  });
}

// 进入视口时淡入上移。data-reveal 的兄弟元素会自动错开。
export function observeReveal(scope = document) {
  const els = [...scope.querySelectorAll('[data-reveal]:not(.is-in)')];
  if (!els.length) return;
  if (reducedMotion() || !('IntersectionObserver' in window)) {
    els.forEach((el) => el.classList.add('is-in'));
    return;
  }
  els.forEach((el) => {
    if (el.style.getPropertyValue('--reveal-i')) return;
    const sibs = [...el.parentElement.children].filter((c) => c.hasAttribute('data-reveal'));
    el.style.setProperty('--reveal-i', String(Math.min(sibs.indexOf(el), 6)));
  });
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        e.target.classList.add('is-in');
        io.unobserve(e.target);
      });
    },
    { rootMargin: '0px 0px -8% 0px', threshold: 0.12 },
  );
  els.forEach((el) => io.observe(el));
}

// data-live：只在可见时加 .is-live。循环动画（声波、流光）挂在 .is-live 上，离屏即暂停，不白耗 GPU。
export function observeLive(scope = document) {
  const els = [...scope.querySelectorAll('[data-live]')];
  if (!els.length || reducedMotion() || !('IntersectionObserver' in window)) return;
  const io = new IntersectionObserver((entries) =>
    entries.forEach((e) => e.target.classList.toggle('is-live', e.isIntersecting)),
  );
  els.forEach((el) => io.observe(el));
}

// 全站搜索：按需加载，不拖慢首屏
function initSearch() {
  const open = () => import('./search.js').then((m) => m.openSearch());
  // 用事件委托：页面后来渲染出来的搜索框（比如首页的快捷搜索）也能打开全站搜索
  document.addEventListener('click', (e) => {
    if (e.target.closest?.('[data-search]')) open();
  });
  addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
    if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) {
      e.preventDefault();
      open();
    }
  });
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  document.querySelectorAll('[data-kbd-mod]').forEach((k) => (k.textContent = mac ? '⌘K' : 'Ctrl K'));
}

export function initShell() {
  initScrollMemory();
  initPageTransitions();
  initNav();
  initTheme();
  initSearch();
  initFx();
  document.querySelectorAll('[data-year]').forEach((el) => (el.textContent = new Date().getFullYear()));
}
