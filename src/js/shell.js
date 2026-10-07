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
import { initFx } from './fx.js';

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
    if (e.viewTransition && e.activation?.entry?.url) rememberDirection(e.activation.entry.url);
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

  // “＋发布”：桌面在按钮下方弹出，手机从底部升起；只列出现在真的能用的发布流程
  const menu = document.getElementById('gn-pub');
  const triggers = [...document.querySelectorAll('[data-publish]')];
  let opener = null;
  const setOpen = (open, from = null) => {
    if (!menu) return;
    menu.hidden = !open;
    opener = open ? from : null;
    menu.classList.toggle('is-sheet', Boolean(from?.classList.contains('fab')));
    triggers.forEach((t) => t.setAttribute('aria-expanded', String(open && t === from)));
    if (open) menu.querySelector('a[role="menuitem"]')?.focus();
  };
  triggers.forEach((t) => t.addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(menu.hidden || opener !== t, t);
  }));
  document.addEventListener('click', (e) => {
    if (menu && !menu.hidden && !menu.contains(e.target)) setOpen(false);
  });
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && menu && !menu.hidden) {
      const back = opener;
      setOpen(false);
      back?.focus();
    }
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
    btn.addEventListener('click', () => {
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
    });
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
  initPageTransitions();
  initNav();
  initTheme();
  initSearch();
  initFx();
  document.querySelectorAll('[data-year]').forEach((el) => (el.textContent = new Date().getFullYear()));
}
