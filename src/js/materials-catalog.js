// 资料目录和资料袋：资料页和首页共用同一份目录、同一个资料袋。
// 目录来源顺序沿用 Codex v0.3：本机资料服务（/api/catalogue）→ 公共目录（data/school.json，只收真实存在的文件）
// → 已审核的公开投稿（Hub catalogue，草稿永远不会出现）。资料袋只存在本浏览器。
import { hubApi, hubState } from './hub.js';
import { localFileURL } from './material-bag.js';

export const BAG_KEY = 'luokixi.materials.bag.v1';
export const BAG_LIMIT = 30;

export function readBag() {
  try {
    const raw = JSON.parse(localStorage.getItem(BAG_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw.filter((x) => {
      try { return x && typeof x.title === 'string' && localFileURL(x.url); } catch { return false; }
    }).slice(0, BAG_LIMIT);
  } catch {
    return [];
  }
}

export function writeBag(bag) {
  try {
    localStorage.setItem(BAG_KEY, JSON.stringify(bag));
    return true;
  } catch {
    return false;
  }
}

// 放入或取出一份资料，返回 { bag, added, full }
export function toggleBag(item) {
  let bag = readBag();
  if (bag.some((x) => x.url === item.url)) {
    bag = bag.filter((x) => x.url !== item.url);
    writeBag(bag);
    return { bag, added: false, full: false };
  }
  if (bag.length >= BAG_LIMIT) return { bag, added: false, full: true };
  bag.push(item);
  writeBag(bag);
  return { bag, added: true, full: false };
}

// 年份字符串里的第一个四位数，用来按新旧排序
export const yearKey = (x) => Number(String(x.year ?? '').match(/\d{4}/)?.[0] ?? 0);

const fetchJSON = async (url) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw Error(`目录读取失败 (${r.status})`);
  return r.json();
};

// Preserve approved metadata needed for exact collections; never copy private file paths/body.
export function normalizeLocalMaterial(x) {
  const fields = ['id', 'title', 'course', 'year', 'kind', 'format', 'pages', 'rights', 'scope', 'origin', 'status', 'sha256', 'group_key', 'extract_status', 'created', 'version', 'role', 'attachmentRole', 'collection', 'match_page', 'score'];
  const item = Object.fromEntries(fields.filter((key) => x[key] !== undefined).map((key) => [key, x[key]]));
  return { ...item, courseId: x.course_id || x.courseId || '', offeringId: x.offering_id || x.offeringId || '', term: x.term || '', access: x.access || '', checkedAt: x.checked_at || x.checkedAt || '', url: `/api/file/${encodeURIComponent(x.id)}`, source: x.source_url || x.source || '', note: x.snippet || '' };
}

let cached = null;

// 返回 { items, isLocal, notes }；notes 是要如实告诉用户的情况（哪一路没读到、本机资料的边界）
export function loadMaterials() {
  cached ??= (async () => {
    const notes = [];
    let items = [];
    let isLocal = false;
    let collectionManifest = null;
    try {
      if (['127.0.0.1', 'localhost'].includes(location.hostname)) {
        const first = await fetchJSON('/api/catalogue');
        const [pages, organized] = await Promise.all([
          Promise.all(Array.from({ length: Math.max(0, Math.ceil(first.total / 30) - 1) }, (_, i) => fetchJSON(`/api/catalogue?offset=${(i + 1) * 30}`))),
          fetchJSON('/api/library/collections').catch(() => null),
        ]);
        items = [...first.items, ...pages.flatMap((x) => x.items)].map(normalizeLocalMaterial);
        // This optional endpoint supplies only explicitly verified book/chapter membership.
        // Exact CET grouping also works with older local servers that lack this endpoint.
        if (organized?.schemaVersion === 1 && Array.isArray(organized.collections)) {
          collectionManifest = { schemaVersion: 1, collections: organized.collections.filter((book) => book.grouping === 'verified-manifest' && book.collectionId && Array.isArray(book.files)).map((book) => ({
            id: book.collectionId, title: book.title, course: book.course, courseId: book.courseId || '', verified: true,
            source: '/api/library/collections', members: book.files.map((file) => ({ id: file.id, sha256: file.sha256 || '', role: file.role || '', chapter: file.chapter || '', order: file.order ?? 0 })),
          })) };
        }
        const shelf=await fetchJSON('/api/library/feed').catch(()=>null);
        if(shelf){items=items.map(x=>({...x,...(shelf.provenance?.[x.id]||{})}));items.push(...(shelf.items||[]));}
        isLocal = true;
      }
    } catch {
      notes.push('本机资料服务暂时无法连接，先显示公共目录。');
    }
    if (!isLocal) {
      const d = await fetchJSON('data/school.json');
      const available = await Promise.all(d.papers.filter((x) => x.file).map(async (x) => {
        try {
          const r = await fetch(new URL(x.file, location.href), { method: 'HEAD', signal: AbortSignal.timeout(3000) });
          return r.ok && !/text\/html/.test(r.headers.get('content-type') || '') ? x : null;
        } catch { return null; }
      }));
      items = available.filter(Boolean).map((x) => ({ id: x.id, title: `${d.courses.find((c) => c.id === x.course)?.name || x.course} · ${x.year} · ${x.kind}`, course: d.courses.find((c) => c.id === x.course)?.name || x.course, year: x.year, kind: '试卷', format: 'pdf', pages: x.pages, url: new URL(x.file, location.href).pathname, rights: '请保留原作者与原文件标注', note: x.hasAnswers ? '含答案或评分标准' : '原卷' }));
    }
    const state = await hubState();
    if (state.online) {
      try {
        const first = await hubApi.catalogue({ kind: 'resource' });
        const pages = await Promise.all(Array.from({ length: Math.min(9, Math.max(0, Math.ceil(first.total / 30) - 1)) }, (_, i) => hubApi.catalogue({ kind: 'resource', offset: (i + 1) * 30 })));
        for (const entry of [...first.items, ...pages.flatMap((p) => p.items)]) {
          const d = entry.data;
          for (const a of entry.attachments || []) items.push({ id: a.id, title: `${d.title} · ${a.name}`, course: d.course || '其他课程', courseId: d.learning?.courseId || '', offeringId: d.learning?.offeringId || '', term: d.learning?.term || '', version: d.learning?.version || '', access: d.learning?.access || 'unknown', checkedAt: d.learning?.checkedAt || '', year: d.year, kind: d.tags?.includes('笔记') ? '笔记' : '资料', format: a.name.split('.').pop().toLowerCase(), pages: a.pages, url: a.url, rights: d.license, source: d.links?.source || '', note: d.summary, uploader: entry.owner?.name, stars: entry.siteStars, fresh: entry.updated });
          if (!(entry.attachments || []).length && d.links?.source) items.push({ id: entry.id, title: d.title, course: d.course || '其他课程', courseId: d.learning?.courseId || '', offeringId: d.learning?.offeringId || '', term: d.learning?.term || '', version: d.learning?.version || '', access: d.learning?.access || 'unknown', checkedAt: d.learning?.checkedAt || '', year: d.year, kind: '收录说明', format: 'md', url: `/api/hub/reader/entry/${encodeURIComponent(entry.id)}/download`, rights: d.license, source: d.links.source, note: `${d.summary || ''} · 当前可下载站内收录说明，来源原件尚未入库。`, uploader: entry.owner?.name, stars: entry.siteStars, external: false, fresh: entry.updated });
        }
        if (first.total > 300) notes.push('已载入最近 300 条公开投稿；更多内容请使用全文检索。');
      } catch {
        notes.push('公开投稿暂时读取失败，以下为已载入的文件。');
      }
    }
    if (isLocal && items.some((x) => x.url.startsWith('/api/file/'))) notes.push('当前包含本机资料，仅在这台电脑可用；不代表已获公开转载授权。');
    return { items, isLocal, notes, collectionManifest };
  })();
  return cached;
}
