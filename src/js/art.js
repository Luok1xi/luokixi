// Reviewed catalogue is bundled: no manifest request on the first-frame path.
import catalogue from '../../public/art/manifest.json' with { type: 'json' };
import '../styles/art-assets.css';

const attr = (s) => String(s ?? '').replace(/[&"<>']/g, c => ({'&':'&amp;','"':'&quot;','<':'&lt;','>':'&gt;',"'":'&#39;'}[c]));
export const safeArtPath = (value) => typeof value === 'string'
  && /^(?:\.\/)?art\/[\w/-]+\.(?:webp|avif|png|jpe?g|svg)$/.test(value)
  && !value.split('/').includes('..');
export function artSlot(name) {
  const a = catalogue.slots?.[name];
  return a?.review === 'approved' && safeArtPath(a.src) ? a : null;
}
export async function artManifest() { return catalogue.slots ?? {}; }

function candidates(a) {
  return (a.variants ?? []).filter(v => safeArtPath(v.src) && Number.isInteger(v.w) && v.w > 0)
    .map(v => `${v.src} ${v.w}w`).join(', ');
}
export function artImageHTML(a, { className = '', sizes = '(max-width: 760px) 90vw, 960px', eager = false, dark = false, decorative = false } = {}) {
  const src = dark ? a.srcDark : a.src;
  if (!safeArtPath(src)) return '';
  const srcset = dark ? '' : candidates(a);
  const focal = /^\d+(?:\.\d+)?% \d+(?:\.\d+)?%$/.test(a.focal ?? '') ? a.focal : '50% 50%';
  const dimensions = Number.isInteger(a.w) && a.w > 0 && Number.isInteger(a.h) && a.h > 0 ? ` width="${a.w}" height="${a.h}"` : '';
  return `<img class="art-img ${attr(className)}" src="${attr(src)}"${srcset ? ` srcset="${attr(srcset)}" sizes="${attr(sizes)}"` : ''} alt="${decorative ? '' : attr(a.alt)}"${dimensions} style="object-position:${focal}" decoding="async" loading="${eager ? 'eager' : 'lazy'}" fetchpriority="${eager ? 'high' : 'low'}">`;
}

const mounting = new WeakMap();
function install(el, a) {
  if (mounting.has(el) || el.classList.contains('has-art')) return mounting.get(el);
  const small = el.classList.contains('mt-rail-icon');
  const hero = el.closest('.hc-slide');
  const eager = Boolean(hero && (hero.classList.contains('is-active') || hero === hero.parentElement?.firstElementChild));
  const options = { eager, decorative:small, sizes: small ? '32px' : hero ? '(max-width: 760px) 77vw, (max-width: 1264px) 68vw, 860px' : '(max-width: 760px) 90vw, 960px' };
  const layer = document.createElement('span');
  layer.className = 'art-layer';
  layer.innerHTML = safeArtPath(a.srcDark)
    ? artImageHTML(a, {...options, className:'is-light'}) + artImageHTML(a, {...options, className:'is-dark', dark:true})
    : artImageHTML(a, options);
  el.prepend(layer);
  const images = [...layer.querySelectorAll('img')];
  const dark = document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme:dark)').matches);
  const first = dark && images.length > 1 ? images[1] : images[0];
  const work = new Promise(resolve => {
    let settled = false, finishing = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      layer.remove(); el.classList.remove('has-art'); queueMicrotask(() => mounting.delete(el));
      el.dataset.artState = 'unavailable'; resolve(false);
    };
    const finish = async () => {
      if (settled || finishing) return;
      finishing = true;
      if (!first.naturalWidth) return fail();
      try { await first.decode(); } catch { if (!first.naturalWidth) return fail(); }
      if (settled) return;
      settled = true;
      if (!el.isConnected) { layer.remove(); queueMicrotask(() => mounting.delete(el)); return resolve(false); }
      el.classList.add('has-art'); el.dataset.artState = 'ready';
      el.dataset.artKind = a.meta?.type ?? 'concept';
      if (el.dataset.artKind === 'concept') {
        el.title = `${a.alt} · AI 概念插画`;
        if (!small) {
          const caption = document.createElement('small'); caption.className = 'art-caption';
          caption.textContent = 'AI 概念插画'; layer.append(caption);
        }
      }
      resolve(true);
    };
    first.addEventListener('load', finish, {once:true});
    first.addEventListener('error', fail, {once:true});
    if (first.complete) finish();
  });
  mounting.set(el, work);
  return work;
}
export function mountArt(scope = document) {
  if (!scope?.querySelectorAll) return Promise.resolve([]);
  const nodes = [...scope.querySelectorAll('[data-art]:not(.has-art)')];
  if (scope.matches?.('[data-art]:not(.has-art)')) nodes.unshift(scope);
  return Promise.all(nodes.map(el => { const a = artSlot(el.dataset.art); return a ? install(el, a) : false; }));
}
