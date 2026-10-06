// Keep controls on the live DOM: FLIP transforms, never View Transition snapshots.
import { animate } from './motion.js';
import '../styles/story.css';
let current = null, serial = 0;
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const CLOSE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"/></svg>';
function track(state, animation, done) {
  if (!animation) { done?.(); return Promise.resolve(); }
  state.animations.add(animation);
  return animation.finished.then(() => { state.animations.delete(animation); done?.(); }, () => { state.animations.delete(animation); });
}
function freeze(state) {
  const values = [state.panel, state.scrim, state.body].map(el => { const s = getComputedStyle(el); return { el, transform: s.transform, opacity: s.opacity }; });
  for (const { el, transform, opacity } of values) { el.style.transform = transform; el.style.opacity = opacity; }
  for (const animation of state.animations) animation.cancel();
  state.animations.clear();
}
function mappedTransform(source, destination) {
  if (!source.width || !source.height || !destination.width || !destination.height) return 'none';
  return `translate(${source.left - destination.left}px, ${source.top - destination.top}px) scale(${source.width / destination.width}, ${source.height / destination.height})`;
}
function settleOpen(state) {
  for (const [el, property, end] of [[state.panel, 'transform', 'none'], [state.body, 'opacity', '1'], [state.scrim, 'opacity', '1']]) {
    const from = getComputedStyle(el)[property];
    const animation = animate(el, [{ [property]: from }, { [property]: end }], { spring: 'snappy' });
    track(state, animation, () => { if (state.closing || current !== state) return; el.style[property] = end; animation?.cancel(); });
  }
}
export async function openStory(card, { label, hero, body, tone = 'dark' }) {
  if (current?.closing) await current.closed;
  if (current) return current.dlg;
  const source = card.getBoundingClientRect(), dlg = document.createElement('dialog');
  dlg.className = `story is-${tone}`; dlg.setAttribute('aria-label', label);
  dlg.innerHTML = `<div class="story-scrim" data-story-close></div><article class="story-panel"><header class="story-hero" style="--today-bg:${card.style.getPropertyValue('--hc-bg') || card.style.getPropertyValue('--today-bg')}">${hero ?? card.innerHTML}</header><div class="story-body">${body}</div></article><button class="story-close" type="button" data-story-close aria-label="关闭">${CLOSE_ICON}</button>`;
  const state = { id: `story-${++serial}`, dlg, card, opener: document.activeElement, closing: false, animations: new Set(), panel: dlg.querySelector('.story-panel'), hero: dlg.querySelector('.story-hero'), body: dlg.querySelector('.story-body'), scrim: dlg.querySelector('.story-scrim') };
  state.closed = new Promise(resolve => { state.resolveClosed = resolve; }); current = state;
  dlg.addEventListener('click', e => { if (e.target.closest('[data-story-close]')) requestClose(); });
  dlg.addEventListener('cancel', e => { e.preventDefault(); requestClose(); }); wireDrag(state);
  document.body.append(dlg); dlg.showModal();
  // showModal may focus a body link and scroll the new dialog before our control focus.
  dlg.querySelector('.story-close').focus({ preventScroll: true }); dlg.scrollTop = 0;
  document.documentElement.classList.add('has-story'); card.classList.add('is-story-source');
  history.pushState({ ...(history.state ?? {}), story: true, storyKey: state.id }, '');
  document.dispatchEvent(new CustomEvent('luokixi:story', { detail: { open: true } }));
  if (!reducedMotion()) { state.panel.style.transform = mappedTransform(source, state.hero.getBoundingClientRect()); state.body.style.opacity = '0'; state.scrim.style.opacity = '0'; settleOpen(state); }
  dlg.querySelector('.story-close').focus({ preventScroll: true }); return dlg;
}
function requestClose() {
  const state = current;
  if (!state) return Promise.resolve(); if (state.closing) return state.closed;
  // Start closing now; asynchronous popstate must not delay a user's click.
  if (history.state?.storyKey === state.id) { state.historyBack = new Promise(resolve => { state.resolveHistory = resolve; }); beginClose(state); history.back(); }
  else beginClose(state);
  return state.closed;
}
addEventListener('popstate', () => { const state = current; if (!state) return; state.resolveHistory?.(); if (!state.closing && history.state?.storyKey !== state.id) beginClose(state); });
export function closeStory() { return requestClose(); }
async function beginClose(state) {
  if (state.closing) return state.closed;
  state.closing = true; freeze(state); state.panel.classList.remove('is-dragging');
  const from = state.panel.style.transform, shownHero = state.hero.getBoundingClientRect();
  const morph = shownHero.bottom > 0 && shownHero.top < innerHeight && state.card.isConnected;
  state.panel.style.transform = 'none'; const destination = state.hero.getBoundingClientRect(); state.panel.style.transform = from;
  const to = morph ? mappedTransform(state.card.getBoundingClientRect(), destination) : from, closing = [];
  if (!reducedMotion()) {
    const options = { duration: 220, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'both' };
    closing.push(track(state, state.panel.animate([{ transform: from, opacity: state.panel.style.opacity }, { transform: to, opacity: 0 }], options)));
    for (const el of [state.scrim, state.body, state.dlg.querySelector('.story-close')]) closing.push(track(state, el.animate([{ opacity: getComputedStyle(el).opacity }, { opacity: 0 }], options)));
  }
  await Promise.all(closing);
  for (const animation of state.animations) animation.cancel(); state.animations.clear();
  state.dlg.close(); state.dlg.remove(); state.card.classList.remove('is-story-source'); document.documentElement.classList.remove('has-story');
  const focusTarget = state.opener?.isConnected && state.opener !== document.body ? state.opener : state.card.querySelector('[data-open-story],a,button');
  if (focusTarget?.isConnected) focusTarget.focus({ preventScroll: true });
  document.dispatchEvent(new CustomEvent('luokixi:story', { detail: { open: false } }));
  // Do not let a previous back navigation remove a newly opened story.
  await state.historyBack;
  if (current === state) current = null; state.resolveClosed();
}
function wireDrag(state) {
  const { dlg, panel } = state; let start = null, distance = 0, dragging = false, base = 'none', scrimOpacity = 1;
  dlg.addEventListener('touchstart', e => {
    if (state.closing || e.touches.length !== 1 || e.target.closest('button,a,input,textarea,select')) return;
    start = dlg.scrollTop <= 0 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null; distance = 0; dragging = false;
  }, { passive: true });
  dlg.addEventListener('touchmove', e => {
    if (!start || state.closing || e.touches.length !== 1) return;
    const dy = e.touches[0].clientY - start.y;
    if (!dragging) {
      if (dy < -6 || Math.abs(e.touches[0].clientX - start.x) > Math.abs(dy)) { start = null; return; }
      if (dy < 6) return;
      freeze(state); base = panel.style.transform === 'none' ? '' : panel.style.transform; scrimOpacity = Number(state.scrim.style.opacity); dragging = true; panel.classList.add('is-dragging');
    }
    e.preventDefault(); distance = Math.max(0, dy);
    panel.style.transform = `translateY(${distance * .35}px) scale(${1 - Math.min(distance, 320) / 1100}) ${base}`;
    state.scrim.style.opacity = String(scrimOpacity * Math.max(.2, 1 - distance / 800));
  }, { passive: false });
  function end(cancelled) { start = null; if (!dragging || state.closing) return; dragging = false; panel.classList.remove('is-dragging'); if (!cancelled && distance > 110) requestClose(); else settleOpen(state); }
  dlg.addEventListener('touchend', () => end(false)); dlg.addEventListener('touchcancel', () => end(true));
}
