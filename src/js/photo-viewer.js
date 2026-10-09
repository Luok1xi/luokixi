import { esc } from './data.js';

export function openPhotoViewer(images, index = 0, origin) {
  const urls = images.filter(Boolean);
  if (!urls.length) return;
  const dialog = document.createElement('dialog');
  dialog.className = 'cs-image-viewer';
  dialog.setAttribute('aria-label', '查看帖子图片');
  const paint = () => {
    dialog.innerHTML = `<img src="${esc(urls[index])}" alt="帖子图片 ${index + 1}"><nav><button type="button" data-prev aria-label="上一张" ${index === 0 ? 'disabled' : ''}>←</button><span>${index + 1} / ${urls.length}</span><button type="button" data-next aria-label="下一张" ${index === urls.length - 1 ? 'disabled' : ''}>→</button><a href="${esc(urls[index])}" target="_blank" rel="noopener">原图</a><button type="button" data-dismiss aria-label="关闭图片">关闭</button></nav>`;
  };
  const go = delta => { index = Math.max(0, Math.min(urls.length - 1, index + delta)); paint(); };
  dialog.addEventListener('click', event => {
    if (event.target === dialog || event.target.closest('[data-dismiss]')) dialog.close();
    else if (event.target.closest('[data-prev]')) go(-1);
    else if (event.target.closest('[data-next]')) go(1);
  });
  dialog.addEventListener('keydown', event => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); go(event.key === 'ArrowLeft' ? -1 : 1); }
  });
  dialog.addEventListener('close', () => { dialog.remove(); origin?.focus({preventScroll:true}); }, {once:true});
  paint(); document.body.append(dialog); dialog.showModal();
}
