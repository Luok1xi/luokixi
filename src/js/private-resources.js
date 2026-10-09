// Private notes and file blobs stay in this browser; this module has no network API.
const DB_NAME = 'luokixi-private-learning-v1';
const STORE = 'resources';
const MAX_FILE = 25 * 1024 * 1024;
const LEARNING_KEYS = ['school', 'courseId', 'offeringId', 'term', 'faculty', 'materialType', 'version', 'access', 'checkedAt', 'sourceUrl'];
const clean = (value, length = 1000) => typeof value === 'string' ? value.trim().slice(0, length) : '';

export function normalizeSource(input) {
  const value = clean(input, 1000);
  if (!value) return { sourceUrl: '', doi: '' };
  const candidate = value.replace(/^doi:\s*/i, '');
  if (/^10\.\d{4,9}\/\S+$/i.test(candidate)) {
    const doi = candidate.toLowerCase();
    return { doi, sourceUrl: `https://doi.org/${doi}` };
  }
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('请填写完整的 https:// 链接或 DOI。'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || /\s/.test(value)) {
    throw new Error('仅支持不含账号密码的 HTTP、HTTPS 链接或 DOI。');
  }
  parsed.hash = '';
  if (['doi.org', 'dx.doi.org'].includes(parsed.hostname.toLowerCase())) {
    let doi;
    try { doi = decodeURIComponent(parsed.pathname.slice(1)).toLowerCase(); } catch { throw new Error('DOI 格式不正确。'); }
    if (!/^10\.\d{4,9}\/\S+$/.test(doi)) throw new Error('DOI 格式不正确。');
    return { doi, sourceUrl: `https://doi.org/${doi}` };
  }
  return { sourceUrl: parsed.href, doi: '' };
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) return reject(new Error('浏览器未提供本地文件存储，请允许站点存储后重试。'));
    let request;
    try { request = indexedDB.open(DB_NAME, 1); } catch { return reject(new Error('浏览器禁止本地存储；资料尚未保存。')); }
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
    request.onerror = () => reject(new Error('无法打开本地资料库，请检查浏览器的站点存储权限。'));
    request.onblocked = () => reject(new Error('请关闭其他资料收集页面后重试。'));
    request.onsuccess = () => resolve(request.result);
  });
}

async function transaction(mode, action) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    let result;
    const tx = db.transaction(STORE, mode);
    const fail = () => { db.close(); reject(new Error('本地保存失败，可能空间不足或存储权限已关闭；原资料仍保留。')); };
    tx.oncomplete = () => { db.close(); resolve(result); };
    tx.onerror = fail;
    tx.onabort = fail;
    try { action(tx.objectStore(STORE), value => { result = value; }); }
    catch (error) { tx.abort(); db.close(); reject(error); }
  });
}

export async function listPrivateResources() {
  const items = await transaction('readonly', (store, done) => {
    const request = store.getAll(); request.onsuccess = () => done(request.result);
  });
  return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function searchPrivateResources(items, query = '') {
  const words = clean(query, 500).toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return items.filter(item => {
    const haystack = [item.title, item.summary, item.credit, item.sourceUrl, item.doi, item.fileName,
      ...LEARNING_KEYS.map(key => item.learning?.[key])].filter(Boolean).join(' ').toLocaleLowerCase();
    return words.every(word => haystack.includes(word));
  });
}

export async function savePrivateResource(input) {
  const source = normalizeSource(input.sourceUrl || input.doi || '');
  const title = clean(input.title, 160);
  if (!title) throw new Error('请填写资料标题。');
  const fileBlob = input.fileBlob instanceof Blob ? input.fileBlob : null;
  if (fileBlob && (!fileBlob.size || fileBlob.size > MAX_FILE)) throw new Error('请选择非空且不超过 25 MB 的文件。');
  if (!source.sourceUrl && !fileBlob) throw new Error('请提供一个链接、DOI 或本地文件。');
  const learning = Object.fromEntries(LEARNING_KEYS.map(key => [key, clean(input.learning?.[key], key === 'sourceUrl' ? 1000 : 160)]));
  learning.school = 'cumtb'; learning.sourceUrl = source.sourceUrl;
  let fileHash = '';
  if (fileBlob) {
    if (!globalThis.crypto?.subtle) throw new Error('浏览器当前无法核对文件，请在本机或 HTTPS 页面重试。');
    const digest = await crypto.subtle.digest('SHA-256', await fileBlob.arrayBuffer());
    fileHash = [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('');
  }
  const now = new Date().toISOString();
  const item = { id: crypto.randomUUID(), title, summary: clean(input.summary, 1000), credit: clean(input.credit, 300), ...source,
    learning, fileName: fileBlob ? clean(input.fileName || fileBlob.name || '资料文件', 180) : '',
    fileBlob, fileHash, createdAt: now, updatedAt: now };
  return transaction('readwrite', (store, done) => {
    const request = store.getAll();
    request.onsuccess = () => {
      const found = request.result.find(existing =>
        existing.learning?.courseId === learning.courseId && existing.learning?.offeringId === learning.offeringId &&
        existing.learning?.version === learning.version &&
        (fileHash ? existing.fileHash === fileHash : !existing.fileHash && existing.sourceUrl === source.sourceUrl));
      if (found) return done({ item: found, duplicate: true });
      store.add(item); done({ item, duplicate: false });
    };
  });
}

export const deletePrivateResource = id => transaction('readwrite', (store, done) => { store.delete(id); done(true); });

// An explicit export is a portable index, not a backup of private content.
export function exportPrivateResourceIndex(items) {
  return { format: 'luokixi-private-resource-index', version: 1, items: items.map(item => ({
    id: clean(item.id, 64), sourceUrl: clean(item.sourceUrl), doi: clean(item.doi, 200),
    courseId: clean(item.learning?.courseId, 80), offeringId: clean(item.learning?.offeringId, 36),
  })) };
}
