import { createPhotoQueue } from './photo-queue.js';
import { esc } from './data.js';
import '../styles/photo-composer.css';

export function mountPhotoComposer(form) {
  const input = form.elements.photos, grid = form.querySelector('[data-photo-grid]');
  const count = form.querySelector('[data-photo-count]'), status = form.querySelector('#post-status');
  const previews = new Map(), ac = new AbortController(), { signal } = ac;
  let dragDepth = 0, dragged = null;
  const queue = createPhotoQueue({ onError: message => { status.textContent = message; }, onChange(files, busy) {
    const active = new Set(files.map(f => f.id));
    for (const [id, url] of previews) if (!active.has(id)) { URL.revokeObjectURL(url); previews.delete(id); }
    files.forEach(f => { if (!previews.has(f.id)) previews.set(f.id, URL.createObjectURL(f.data)); });
    input.disabled = busy;
    count.textContent = `${files.length} / 9`;
    grid.innerHTML = files.map((f, i) => `<figure class="cs-photo-tile" draggable="${!busy}" data-photo-id="${esc(f.id)}">
      <img src="${esc(previews.get(f.id))}" alt="${esc(f.name)}" draggable="false">
      <figcaption>${i + 1}</figcaption>
      <button type="button" data-photo-remove="${esc(f.id)}" aria-label="移除第 ${i + 1} 张图片" ${busy ? 'disabled' : ''}>×</button>
      <div class="cs-photo-order"><button type="button" data-photo-move="${esc(f.id)}" data-direction="-1" aria-label="第 ${i + 1} 张前移" ${busy || i === 0 ? 'disabled' : ''}>←</button><button type="button" data-photo-move="${esc(f.id)}" data-direction="1" aria-label="第 ${i + 1} 张后移" ${busy || i === files.length - 1 ? 'disabled' : ''}>→</button></div>
    </figure>`).join('');
  } });
  input.addEventListener('change', () => { queue.add(input.files); input.value = ''; }, { signal });
  form.addEventListener('paste', event => {
    const files = [...(event.clipboardData?.files || [])];
    if (files.length) { event.preventDefault(); queue.add(files); }
  }, { signal });
  const hasFiles = event => [...(event.dataTransfer?.types || [])].includes('Files');
  form.addEventListener('dragenter', event => {
    if (hasFiles(event)) { event.preventDefault(); dragDepth++; form.classList.add('has-photo-drag'); }
  }, { signal });
  form.addEventListener('dragover', event => { if (hasFiles(event)) event.preventDefault(); }, { signal });
  form.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; form.classList.remove('has-photo-drag'); } }, { signal });
  form.addEventListener('drop', event => {
    if (!hasFiles(event)) return;
    event.preventDefault(); dragDepth = 0; form.classList.remove('has-photo-drag'); queue.add(event.dataTransfer.files);
  }, { signal });
  grid.addEventListener('click', event => {
    const remove = event.target.closest('[data-photo-remove]'), move = event.target.closest('[data-photo-move]');
    if (remove) queue.remove(remove.dataset.photoRemove);
    if (move) queue.move(move.dataset.photoMove, queue.files().findIndex(f => f.id === move.dataset.photoMove) + Number(move.dataset.direction));
  }, { signal });
  grid.addEventListener('dragstart', event => {
    dragged = event.target.closest('[data-photo-id]')?.dataset.photoId || null;
    if (dragged) { event.dataTransfer.setData('text/plain', dragged); event.dataTransfer.effectAllowed = 'move'; }
  }, { signal });
  grid.addEventListener('dragover', event => { if (dragged) event.preventDefault(); }, { signal });
  grid.addEventListener('drop', event => {
    if (!dragged) return;
    event.preventDefault(); event.stopPropagation();
    const target = event.target.closest('[data-photo-id]')?.dataset.photoId;
    if (target) queue.move(dragged, queue.files().findIndex(f => f.id === target));
    dragged = null;
  }, { signal });
  grid.addEventListener('dragend', () => { dragged = null; }, { signal });
  form.addEventListener('reset', () => queue.clear(), { signal });
  queue.clear();
  return { ...queue, destroy() { ac.abort(); queue.destroy(); previews.forEach(URL.revokeObjectURL); previews.clear(); } };
}
