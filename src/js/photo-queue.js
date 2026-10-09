import Uppy from '@uppy/core';

// One queue survives consecutive selections and failed submissions.
export function createPhotoQueue({ onChange = () => {}, onError = () => {} } = {}) {
  const uppy = new Uppy({ autoProceed: false, restrictions: {
    maxNumberOfFiles: 9, maxFileSize: 25 * 1024 * 1024,
    allowedFileTypes: ['.jpg', '.jpeg', '.png', '.webp'],
  }, locale: { strings: {
    youCanOnlyUploadX: { 0: '每篇帖子最多添加 %{smart_count} 张图片。', 1: '每篇帖子最多添加 %{smart_count} 张图片。' },
    exceedsSize: '%{file} 超过 %{size}，请缩小后添加。',
    youCanOnlyUploadFileTypes: '请添加 JPG、PNG 或 WebP 图片。',
    noDuplicates: '这张图片已经添加过了。',
  } } });
  let order = [], busy = false;
  const files = () => order.map(id => uppy.getFile(id)).filter(Boolean);
  const changed = () => onChange(files(), busy);
  uppy.on('file-added', f => { order.push(f.id); changed(); });
  uppy.on('file-removed', f => { order = order.filter(id => id !== f.id); changed(); });
  return {
    files,
    add(input) {
      if (busy) return;
      for (const file of input) {
        try { uppy.addFile({ name: file.name, type: file.type, data: file, source: 'circle-composer' }); }
        catch (error) { onError(error.message); }
      }
    },
    remove(id) { if (!busy) uppy.removeFile(id); },
    move(id, target) {
      const at = order.indexOf(id);
      if (busy || at < 0) return;
      order.splice(at, 1); order.splice(Math.max(0, Math.min(order.length, target)), 0, id); changed();
    },
    async uploadAll(upload, progress = () => {}) {
      if (busy) throw new Error('图片正在上传，请稍候。');
      busy = true; changed();
      try {
        const ids = [], selected = files();
        for (const [index, f] of selected.entries()) {
          progress(index + 1, selected.length, f.name);
          let id = f.meta.uploadId;
          if (!id) {
            id = (await upload(f.data)).id;
            if (!id) throw new Error('图片上传没有返回编号，已保留待发图片。');
            uppy.setFileMeta(f.id, { uploadId: id });
          }
          ids.push(id);
        }
        return ids;
      } finally { busy = false; changed(); }
    },
    clear() { if (!busy) { uppy.clear(); order = []; changed(); } },
    destroy() { uppy.destroy(); },
  };
}
