// App Store “Today” 式的卡片展开：点一张大卡，卡片原地长成一篇全屏故事；关闭时缩回原来的位置。
// 用同页 View Transitions 做共享元素转场（卡片 ↔ 故事头图共用 view-transition-name），弹簧缓动见 motion.js。
// 手机上在顶部往下拖可以把故事“按”回去（跟手缩小，松手超过阈值就关闭）。返回键也能关闭。
// 不支持转场或要求减少动态效果时，直接打开和关闭，内容完全一样。
import { transition, animate } from './motion.js';
import '../styles/story.css';

let current = null;

const CLOSE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"/></svg>';

// card：被点的卡片元素；hero：头图里的内容（通常就是卡片自己的内容）；body：正文 HTML
export async function openStory(card, { label, hero, body, tone = 'dark' }) {
  if (current) return;
  const dlg = document.createElement('dialog');
  dlg.className = `story is-${tone}`;
  dlg.setAttribute('aria-label', label);
  dlg.innerHTML = `<div class="story-scrim" data-story-close></div>
    <article class="story-panel">
      <header class="story-hero" style="--today-bg:${card.style.getPropertyValue('--hc-bg') || card.style.getPropertyValue('--today-bg')}">${hero ?? card.innerHTML}</header>
      <button class="story-close" type="button" data-story-close aria-label="关闭">${CLOSE_ICON}</button>
      <div class="story-body">${body}</div>
    </article>`;
  current = { dlg, card, closing: false };

  card.style.viewTransitionName = 'story-hero';
  await transition(() => {
    card.style.viewTransitionName = '';
    card.classList.add('is-story-source');
    document.body.append(dlg);
    dlg.showModal();
    document.documentElement.classList.add('has-story');
  }, 'story');
  if (!document.startViewTransition) {
    animate(dlg.querySelector('.story-scrim'), [{ opacity: 0 }, { opacity: 1 }], { spring: 'smooth' });
    animate(dlg.querySelector('.story-panel'), [{ opacity: 0, transform: 'translateY(40px) scale(0.94)' }, { opacity: 1, transform: 'none' }], { spring: 'snappy' });
  }

  history.pushState({ story: true }, '');
  dlg.addEventListener('click', (e) => {
    if (e.target.closest('[data-story-close]')) requestClose();
  });
  dlg.addEventListener('cancel', (e) => {
    e.preventDefault();
    requestClose();
  });
  wireDrag(dlg);
  dlg.querySelector('.story-close').focus({ preventScroll: true });
  return dlg;
}

// 关闭都走历史记录：按钮、Esc、拖拽、返回键最后都进 closeStory，历史栈保持干净
function requestClose() {
  if (history.state?.story) history.back();
  else closeStory();
}

addEventListener('popstate', () => {
  if (current) closeStory();
});

export async function closeStory() {
  if (!current || current.closing) return;
  current.closing = true;
  const { dlg, card } = current;
  const hero = dlg.querySelector('.story-hero');
  // 头图已经滚出屏幕时不做“缩回”，直接淡出，免得从屏幕外面飞回来
  const morph = hero.getBoundingClientRect().bottom > 0 && card.isConnected;
  if (!morph) hero.style.viewTransitionName = 'none';
  await transition(() => {
    dlg.close();
    dlg.remove();
    document.documentElement.classList.remove('has-story');
    card.classList.remove('is-story-source');
    if (morph) card.style.viewTransitionName = 'story-hero';
  }, 'story-out');
  card.style.viewTransitionName = '';
  card.focus({ preventScroll: true });
  current = null;
}

// 手机：故事滚到顶部时往下拖，整篇跟着手指缩小；拖过 110px 松手就关闭，否则弹回去
function wireDrag(dlg) {
  const panel = dlg.querySelector('.story-panel');
  let y0 = null;
  let dy = 0;
  dlg.addEventListener('touchstart', (e) => {
    y0 = dlg.scrollTop <= 0 ? e.touches[0].clientY : null;
    dy = 0;
  }, { passive: true });
  dlg.addEventListener('touchmove', (e) => {
    if (y0 == null) return;
    dy = e.touches[0].clientY - y0;
    if (dy <= 0) { panel.style.transform = ''; return; }
    e.preventDefault();
    const s = 1 - Math.min(dy, 320) / 1100;
    panel.style.transform = `translateY(${(dy * 0.35).toFixed(1)}px) scale(${s.toFixed(4)})`;
    panel.classList.add('is-dragging');
  }, { passive: false });
  dlg.addEventListener('touchend', () => {
    if (y0 == null || dy <= 0) return;
    y0 = null;
    panel.classList.remove('is-dragging');
    if (dy > 110) {
      requestClose();
      return;
    }
    const from = panel.style.transform;
    panel.style.transform = '';
    animate(panel, [{ transform: from }, { transform: 'none' }], { spring: 'bouncy', fill: 'none' });
  });
}
