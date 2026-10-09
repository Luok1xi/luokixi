import { fuzzySearch } from './fuzzy-search.js';
import '../styles/search-suggestions.css';

let serial = 0;

/** A local, non-persistent combobox. Sources choose what is safe to search. */
export function attachSearchSuggestions(input, options = {}) {
  if (!input) return { refresh() {}, close() {}, destroy() {} };
  const owner = input.closest('dialog') || document.body;
  const list = document.createElement('div');
  list.id = `search-suggestions-${++serial}`;
  list.className = 'search-suggestions';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', '搜索提示');
  list.hidden = true;
  owner.append(list);
  const status = document.createElement('span');
  status.className = 'search-suggestion-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  owner.append(status);

  const attributes = ['role', 'autocomplete', 'aria-autocomplete', 'aria-expanded', 'aria-controls', 'aria-activedescendant'];
  const original = new Map(attributes.map((name) => [name, input.getAttribute(name)]));
  input.setAttribute('role', 'combobox');
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', list.id);

  let items = [], active = -1, revision = 0, composing = false, destroyed = false, scheduled = 0;
  const getTitle = options.getTitle || ((item) => typeof item === 'string' ? item : item.title || item.name || item.label || '');
  const getMeta = options.getMeta || ((item) => typeof item === 'string' ? '' : item.sub || item.category || item.kind || '');

  function position() {
    if (list.hidden || destroyed) return;
    const rect = input.getBoundingClientRect();
    const viewport = window.visualViewport;
    const width = viewport?.width || innerWidth, height = viewport?.height || innerHeight;
    if (rect.bottom < 0 || rect.top > height) { close(); return; }
    const availableBelow = height - rect.bottom - 12;
    const above = availableBelow < 160 && rect.top > availableBelow;
    list.style.left = `${Math.max(8, Math.min(rect.left, width - Math.min(Math.max(rect.width, 240), width - 16) - 8))}px`;
    list.style.width = `${Math.min(Math.max(rect.width, 240), width - 16)}px`;
    list.style.maxHeight = `${Math.max(80, Math.min(320, above ? rect.top - 16 : availableBelow))}px`;
    list.style.top = above ? 'auto' : `${rect.bottom + 6}px`;
    list.style.bottom = above ? `${height - rect.top + 6}px` : 'auto';
  }

  function close() {
    revision++;
    list.hidden = true;
    active = -1;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }

  function highlight(index) {
    active = index;
    for (const [i, row] of [...list.children].entries()) row.setAttribute('aria-selected', String(i === active));
    if (active >= 0) {
      input.setAttribute('aria-activedescendant', `${list.id}-${active}`);
      list.children[active]?.scrollIntoView({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
  }

  async function refresh() {
    const ticket = ++revision;
    if (destroyed || composing || document.activeElement !== input) return;
    const query = input.value.trim();
    if (query.length < (options.minLength ?? 1)) { close(); return; }
    let source;
    try { source = await options.getItems?.(query) || []; }
    catch { if (ticket === revision) close(); return; }
    if (destroyed || composing || ticket !== revision || input.value.trim() !== query || document.activeElement !== input) return;
    items = fuzzySearch(source, query, { ...options, getTitle, limit: options.limit ?? 7 });
    active = -1;
    list.replaceChildren();
    input.removeAttribute('aria-activedescendant');
    if (!items.length) { close(); status.textContent = ''; return; }
    const fragment = document.createDocumentFragment();
    items.forEach((item, index) => {
      const row = document.createElement('div');
      row.className = 'search-suggestion';
      row.id = `${list.id}-${index}`;
      row.dataset.index = String(index);
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', 'false');
      const title = document.createElement('span');
      title.className = 'search-suggestion-title';
      title.textContent = String(getTitle(item));
      row.append(title);
      const metadata = getMeta(item);
      if (metadata) {
        const meta = document.createElement('small');
        meta.className = 'search-suggestion-meta';
        meta.textContent = String(metadata);
        row.append(meta);
      }
      fragment.append(row);
    });
    list.append(fragment);
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    status.textContent = `${items.length} 条搜索提示，使用上下方向键选择。`;
    position();
  }

  function select(index) {
    const item = items[index];
    if (!item) return;
    const query = String(options.getQuery?.(item) ?? getTitle(item));
    input.value = query;
    close();
    // Existing input listeners update their local filter, but this widget stays closed.
    input.dispatchEvent(new Event('input', { bubbles: true }));
    close();
    if (options.onSelect) options.onSelect(item, { query, input });
    else input.form?.requestSubmit();
  }

  const onInput = (event) => { if (!composing && !event.isComposing) refresh(); };
  const onCompositionStart = () => { composing = true; close(); };
  const onCompositionEnd = () => { composing = false; refresh(); };
  const onKeydown = (event) => {
    if (composing || event.isComposing || event.keyCode === 229) return;
    if (list.hidden) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); event.stopImmediatePropagation();
      highlight((active + (event.key === 'ArrowDown' ? 1 : active < 0 ? 0 : -1) + items.length) % items.length);
    } else if (event.key === 'Enter' && active >= 0) {
      event.preventDefault(); event.stopImmediatePropagation(); select(active);
    } else if (event.key === 'Escape') {
      event.preventDefault(); event.stopImmediatePropagation(); close();
    } else if (event.key === 'Tab') close();
  };
  const onPointerDown = (event) => {
    const row = event.target.closest('[data-index]');
    if (!row || event.button !== 0) return;
    event.preventDefault(); select(Number(row.dataset.index));
  };
  const onBlur = () => close();
  const onOutside = (event) => { if (event.target !== input && !list.contains(event.target)) close(); };
  const onPosition = () => { if (!list.hidden && !scheduled) scheduled = requestAnimationFrame(() => { scheduled = 0; position(); }); };
  const onSubmit = () => close();
  input.addEventListener('input', onInput);
  input.addEventListener('focus', refresh);
  input.addEventListener('blur', onBlur);
  input.addEventListener('compositionstart', onCompositionStart);
  input.addEventListener('compositionend', onCompositionEnd);
  input.addEventListener('keydown', onKeydown, true);
  input.form?.addEventListener('submit', onSubmit);
  list.addEventListener('pointerdown', onPointerDown);
  document.addEventListener('pointerdown', onOutside);
  window.addEventListener('resize', onPosition, { passive: true });
  window.addEventListener('scroll', onPosition, { passive: true, capture: true });
  window.visualViewport?.addEventListener('resize', onPosition, { passive: true });

  return { refresh, close, destroy() {
    destroyed = true; close(); cancelAnimationFrame(scheduled);
    input.removeEventListener('input', onInput); input.removeEventListener('focus', refresh); input.removeEventListener('blur', onBlur);
    input.removeEventListener('compositionstart', onCompositionStart); input.removeEventListener('compositionend', onCompositionEnd);
    input.removeEventListener('keydown', onKeydown, true); input.form?.removeEventListener('submit', onSubmit);
    list.removeEventListener('pointerdown', onPointerDown); document.removeEventListener('pointerdown', onOutside);
    window.removeEventListener('resize', onPosition); window.removeEventListener('scroll', onPosition, true);
    window.visualViewport?.removeEventListener('resize', onPosition);
    list.remove(); status.remove();
    for (const [name, value] of original) if (value === null) input.removeAttribute(name); else input.setAttribute(name, value);
  } };
}
