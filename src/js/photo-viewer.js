import 'photoswipe/style.css';
import '../styles/photo-viewer.css';

let activeSession;
let modulePromise;
const dimensions = new Map();
const MAX_DIMENSION_CACHE = 160;

function imageURL(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value, document.baseURI);
    return ['http:', 'https:', 'blob:'].includes(url.protocol)
      || (url.protocol === 'data:' && /^data:image\//i.test(value)) ? url.href : '';
  } catch { return ''; }
}

function size(width, height) {
  width = Number(width); height = Number(height);
  return width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height)
    ? { width, height } : null;
}

function remember(src, measured) {
  if (!measured) return;
  dimensions.delete(src);
  dimensions.set(src, measured);
  if (dimensions.size > MAX_DIMENSION_CACHE) dimensions.delete(dimensions.keys().next().value);
}

function itemsFrom(images, origin) {
  const thumbnails = [...(origin?.parentElement?.querySelectorAll('img') || [])];
  if (origin?.tagName === 'IMG') thumbnails.push(origin);
  return (Array.isArray(images) ? images : []).flatMap((input, sourceIndex) => {
    const data = typeof input === 'string' ? { src: input } : input;
    if (!data || typeof data !== 'object') return [];
    const src = imageURL(data.src || data.url || data.originalUrl);
    if (!src) return [];
    const element = thumbnails.find(img => imageURL(img.src) === src || imageURL(img.currentSrc) === src);
    const measured = size(data.width ?? data.w, data.height ?? data.h)
      || size(element?.naturalWidth, element?.naturalHeight) || dimensions.get(src);
    remember(src, measured);
    return [{ src, ...measured, sourceIndex, dimensionKnown: !!measured,
      msrc: imageURL(data.thumbnail || data.thumb || element?.currentSrc || element?.src),
      alt: typeof data.alt === 'string' ? data.alt : (element?.alt || `帖子图片 ${sourceIndex + 1}`),
      element }];
  });
}

// Probe only the opening image. PhotoSwipe lazily loads nearby slides; their real
// dimensions are corrected on loadComplete without downloading the whole album.
function probeDimensions(item, signal) {
  if (item.dimensionKnown || signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const image = new Image();
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      image.onload = image.onerror = null;
      const measured = size(image.naturalWidth, image.naturalHeight);
      if (!signal.aborted && measured) {
        Object.assign(item, measured, { dimensionKnown: true });
        remember(item.src, measured);
      }
      resolve();
    };
    const cancel = () => { finish(); image.src = ''; };
    const timer = setTimeout(finish, 1500);
    signal.addEventListener('abort', cancel, { once: true });
    image.decoding = 'async';
    image.onload = image.onerror = finish;
    image.src = item.src;
    if (image.complete) finish();
  });
}

function restoreFocus(origin) {
  if (!origin?.isConnected || origin.closest('dialog:not([open])')) return;
  origin.focus?.({ preventScroll: true });
}

function registerUI(pswp) {
  pswp.on('uiRegister', () => {
    pswp.ui.registerElement({ name: 'original', order: 8, tagName: 'a', isButton: true,
      html: '原图', ariaLabel: '在新窗口查看原图',
      onInit: (el, viewer) => {
        el.target = '_blank'; el.rel = 'noopener noreferrer';
        const update = () => { el.href = viewer.currSlide?.data.src || '#'; };
        viewer.on('change', update);
        update();
      } });
    pswp.ui.registerElement({ name: 'description', appendTo: 'root', order: 1,
      onInit: (el, viewer) => {
        el.setAttribute('aria-live', 'polite');
        const update = () => { el.textContent = viewer.currSlide?.data.alt || ''; };
        viewer.on('change', update);
        update();
      } });
  });
}

function showFallback(session) {
  if (session.closed || session.closing) return;
  const { host, items, index } = session;
  host.replaceChildren(); host.removeAttribute('aria-busy');
  const view = document.createElement('div'); view.className = 'pv-fallback';
  const text = document.createElement('p'); text.textContent = '图片查看器暂时无法加载，可以直接查看原图。';
  const img = document.createElement('img'); img.src = items[index].src; img.alt = items[index].alt;
  const original = document.createElement('a'); original.href = items[index].src;
  original.target = '_blank'; original.rel = 'noopener noreferrer'; original.textContent = '查看原图';
  const close = document.createElement('button'); close.type = 'button'; close.textContent = '关闭';
  close.addEventListener('click', session.close, { signal: session.controller.signal });
  view.append(text, img, original, close); host.append(view); close.focus();
}

async function hydrate(session) {
  const selected = session.items[session.index];
  modulePromise ||= import('photoswipe').catch(error => { modulePromise = null; throw error; });
  const [{ default: PhotoSwipe }] = await Promise.all([
    modulePromise, probeDimensions(selected, session.controller.signal),
  ]);
  if (session.closing || session.closed) return;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const dataSource = session.items.map(item => ({ ...item,
    width: item.width || 1600, height: item.height || 1200 }));
  const pswp = session.pswp = new PhotoSwipe({
    dataSource, index: session.index, appendToEl: session.host,
    mainClass: 'luokixi-photo-viewer', loop: false, preload: [1, 1],
    bgOpacity: .94, spacing: .08,
    showHideAnimationType: reduced ? 'none' : 'zoom',
    showAnimationDuration: reduced ? 0 : 240,
    hideAnimationDuration: reduced ? 0 : 200,
    zoomAnimationDuration: reduced ? 0 : 220,
    returnFocus: false, trapFocus: true,
    closeTitle: '关闭图片', zoomTitle: '放大或缩小',
    arrowPrevTitle: '上一张', arrowNextTitle: '下一张',
    errorMsg: '图片暂时无法加载，可点击右上角查看原图。',
    padding: { top: 64, bottom: 56, left: 12, right: 12 },
  });
  // The depth rail deliberately crops/translates its pictures. Use its frame,
  // rather than an overflowing image, as the opening/closing animation origin.
  pswp.addFilter('thumbEl', (thumb, item) => item.element?.closest('.ds-frame') || thumb);
  dataSource.forEach(item => { item.thumbCropped = !!item.element?.closest('.ds-frame'); });
  registerUI(pswp);
  pswp.on('afterInit', () => {
    session.host.removeAttribute('aria-busy');
    session.host.querySelector('.pv-loading')?.remove();
    pswp.element.setAttribute('aria-label', '查看帖子图片');
    pswp.element.setAttribute('aria-modal', 'true');
  });
  pswp.on('change', () => { session.host.dataset.index = String(pswp.currIndex); });
  pswp.on('bindEvents', () => { session.host.dataset.ready = 'true'; });
  pswp.on('loadComplete', ({ content, isError }) => {
    if (isError || content.data.dimensionKnown || session.closing) return;
    const measured = size(content.element?.naturalWidth, content.element?.naturalHeight);
    if (!measured) return;
    Object.assign(content.data, measured, { dimensionKnown: true });
    remember(content.data.src, measured);
    // Refresh once through PhotoSwipe's public API. Cached image data supplies
    // correct portrait/landscape bounds to pinch zoom and adjacent slides.
    queueMicrotask(() => { if (!session.closed && !session.closing) pswp.refreshSlideContent(content.index); });
  });
  pswp.on('openingAnimationEnd', () => {
    if (session.closing) pswp.close();
    else pswp.element?.focus({preventScroll:true});
  });
  pswp.on('destroy', session.cleanup);
  if (!pswp.init()) session.cleanup();
  else pswp.element?.focus({preventScroll:true});
}

/** URL arrays and {src|url,width,height,alt,thumbnail} metadata are supported.
 * Returns an optional close handle; existing callers may continue to ignore it.
 */
export function openPhotoViewer(images, index = 0, origin) {
  const items = itemsFrom(images, origin);
  if (!items.length) return;
  const requestedIndex = Math.max(0, Number.isFinite(Number(index)) ? Math.trunc(Number(index)) : 0);
  const selectedIndex = items.findIndex(item => item.sourceIndex === requestedIndex);
  activeSession?.close();
  const host = document.createElement('dialog');
  host.className = 'photo-viewer-modal';
  host.setAttribute('aria-label', '查看帖子图片'); host.setAttribute('aria-busy', 'true');
  const loading = document.createElement('div'); loading.className = 'pv-loading';
  const status = document.createElement('p'); status.setAttribute('role', 'status'); status.textContent = '正在打开图片…';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = '关闭';
  loading.append(status, cancel); host.append(loading);
  const session = { host, items, index: selectedIndex >= 0 ? selectedIndex : Math.min(requestedIndex, items.length - 1),
    controller: new AbortController(), pswp: null, closing: false, closed: false };
  session.cleanup = () => {
    if (session.closed) return;
    session.closed = true; session.controller.abort();
    if (host.open) host.close();
    host.remove();
    if (activeSession === session) {
      activeSession = null;
      document.documentElement.classList.remove('has-photo-viewer');
      restoreFocus(origin);
    }
  };
  session.close = () => {
    if (session.closed || session.closing) return;
    session.closing = true; session.controller.abort();
    if (session.pswp) session.pswp.close();
    else session.cleanup();
  };
  cancel.addEventListener('click', session.close, { signal: session.controller.signal });
  host.addEventListener('cancel', event => { event.preventDefault(); event.stopPropagation(); session.close(); });
  host.addEventListener('close', session.close);
  window.addEventListener('pagehide', session.cleanup, { once: true, signal: session.controller.signal });
  activeSession = session;
  document.documentElement.classList.add('has-photo-viewer');
  document.body.append(host); host.showModal();
  // A native modal keeps this viewer above the already-modal circle thread.
  // PhotoSwipe owns gestures/keyboard; the host owns the browser's top layer.
  void hydrate(session).catch(() => showFallback(session));
  return { close: session.close };
}
