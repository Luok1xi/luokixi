// 每个页面共用：导航状态、深浅色切换、滚动入场。
import '@fontsource-variable/inter/wght.css';
import '../styles/tokens.css';
import '../styles/base.css';
import '../styles/components.css';

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

const store = {
  get(k) {
    try { return localStorage.getItem(k); } catch { return null; }
  },
  set(k, v) {
    try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* 隐私模式 */ }
  },
};

function initNav() {
  const gn = document.getElementById('gn');
  if (!gn) return;

  const page = document.body.dataset.page;
  gn.querySelectorAll('[data-nav]').forEach((a) => {
    if (a.dataset.nav.split(' ').includes(page)) a.setAttribute('aria-current', 'page');
  });

  const onScroll = () => gn.classList.toggle('is-scrolled', scrollY > 4);
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  const burger = gn.querySelector('.gn-burger');
  const setOpen = (open) => {
    gn.classList.toggle('is-open', open);
    burger.setAttribute('aria-expanded', String(open));
    burger.setAttribute('aria-label', open ? '关闭菜单' : '打开菜单');
    document.documentElement.style.overflow = open ? 'hidden' : '';
  };
  burger?.addEventListener('click', () => setOpen(!gn.classList.contains('is-open')));
  gn.querySelectorAll('.gn-links a').forEach((a) => a.addEventListener('click', () => setOpen(false)));
  addEventListener('keydown', (e) => e.key === 'Escape' && setOpen(false));
  matchMedia('(min-width: 1025px)').addEventListener('change', () => setOpen(false));
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
  document.querySelectorAll('[data-search]').forEach((b) => b.addEventListener('click', open));
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
  initNav();
  initTheme();
  initSearch();
  document.querySelectorAll('[data-year]').forEach((el) => (el.textContent = new Date().getFullYear()));
}
