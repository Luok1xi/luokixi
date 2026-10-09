import { scoreSearchItem, normalizeSearchText } from './fuzzy-search.js';
// Browser-only catalogue adapter. Local file metadata never enters a public index.
export const LEARNING_GROUPS = Object.freeze({ courses: '课程', resources: '课程资料', papers: '论文', tools: '数据与工具', questions: '问答', experiences: '同学经验', opportunities: '学术机会' });
export const LEARNING_ACCESS = Object.freeze({ public: '公开可读', open: '公开可读', campus: '需校园访问', request: '需向提供者申请', carsi: '通过学校认证访问', paid: '付费获取', 'link-only': '站外获取', 'external-link': '站外获取', 'local-only': '仅本机可用', private: '仅当前浏览器', 'campus-only': '需校园访问', 'login-required': '需登录', unknown: '获取方式待核实', 'awaiting-contributions': '等待补充' });

const text = (value) => String(value ?? '').trim();
const rows = (value, key = 'items') => Array.isArray(value) ? value : value?.[key] || [];

export function safeLearningUrl(value) {
  const source = text(value);
  if (!source || /[\u0000-\u001f\u007f\\]/.test(source)) return '';
  try {
    const url = new URL(source, 'https://catalogue.invalid/');
    return ['https:', 'http:'].includes(url.protocol) ? source : '';
  } catch { return ''; }
}

export function buildLearningHelpUrl(q = '', courseId = '', filters = {}) {
  const params = new URLSearchParams({ ask: '1' });
  if (courseId) params.set('id', courseId);
  if (text(q)) params.set('q', text(q));
  for (const key of ['term', 'faculty', 'access', 'type']) if (filters[key]) params.set(key, filters[key]);
  return `course.html?${params}`;
}

export function normalizeLearningCatalogue({ courses = [], materials = [], resources = [], privateResources = [] } = {}) {
  const courseRows = rows(courses, 'courses');
  const byId = new Map(courseRows.map((course) => [text(course.id), course]));
  const owners = new Map();
  for (const course of courseRows) for (const resourceId of course.resourceIds || []) {
    const id = text(resourceId);
    owners.set(id, [...(owners.get(id) || []), course]);
  }
  const items = courseRows.map((course) => ({
    id: text(course.id), kind: 'course', group: 'courses', title: course.name, summary: course.sourceNote || '',
    href: `course.html?id=${encodeURIComponent(course.id)}`, sourceUrl: safeLearningUrl(course.sourceUrl),
    school: course.school || (course.scope === 'learning-topic' ? '' : 'cumtb'), courseId: text(course.id), courseName: course.name,
    offeringId: '', term: '', faculty: course.faculty || '', materialType: course.scope === 'learning-topic' ? '学习专题' : '课程索引', scope: course.scope || '', version: '',
    access: 'public', checkedAt: course.checkedAt || courses.checkedAt || '',
    missingMetadata: [!course.faculty && '学院', !course.verifiedCourseCode && '官方课程代码'].filter(Boolean),
    origin: 'catalogue', localOnly: false, code: course.verifiedCourseCode || '',
  }));
  for (const material of rows(materials)) {
    const resourceId = text(material.id);
    const explicit = byId.get(text(material.courseId));
    const matches = owners.get(resourceId) || [];
    // Ambiguous IDs remain unlinked. A display name is never a relationship key.
    const course = explicit || (matches.length === 1 ? matches[0] : null);
    const url = safeLearningUrl(material.url);
    const localOnly = material.localOnly === true || material.access === 'local-only' || /^\/?api\/file\//.test(url);
    const access = localOnly ? 'local-only' : ({ 'external-link': 'link-only', 'campus-only': 'campus', 'login-required': 'request' }[material.access] || material.access) || (material.external || /^https?:\/\//.test(url) ? 'link-only' : url ? 'public' : 'unknown');
    items.push({
      id: resourceId, resourceId, kind: 'resource', group: 'resources', title: material.title || resourceId,
      summary: material.note || material.summary || '', href: `materials.html?q=${encodeURIComponent(material.title || resourceId)}`,
      fileUrl: url, sourceUrl: safeLearningUrl(material.source || material.sourceUrl), school: material.school || 'cumtb',
      courseId: course?.id || '', courseName: course?.name || '', reportedCourseName: material.course || '',
      offeringId: material.offeringId || '', term: material.term || '', faculty: material.faculty || course?.faculty || '',
      materialType: material.kind || '资料', version: material.version || '', year: text(material.year),
      access, checkedAt: material.checkedAt || '', origin: localOnly ? 'browser-local' : 'catalogue', localOnly,
      missingMetadata: [!course && '适用课程', !material.term && '适用学期', !material.version && '教材版本', !material.checkedAt && '核对时间'].filter(Boolean),
    });
  }
  for (const resource of rows(resources)) items.push({ ...resource, href: safeLearningUrl(resource.href), sourceUrl: safeLearningUrl(resource.sourceUrl) });
  // Only allowlisted metadata is copied. File blobs stay inside the private store.
  for (const saved of rows(privateResources)) {
    const metadata = saved.learning || {};
    const course = byId.get(text(metadata.courseId));
    items.push({ id: `private:${saved.id}`, resourceId: saved.id, kind: 'resource', group: 'resources', title: saved.title,
      summary: saved.summary || '', href: `collect.html?saved=${encodeURIComponent(saved.id)}#private`, sourceUrl: safeLearningUrl(saved.sourceUrl || metadata.sourceUrl),
      school: metadata.school || 'cumtb', courseId: course?.id || '', courseName: course?.name || '', offeringId: metadata.offeringId || '',
      term: metadata.term || '', faculty: metadata.faculty || '', materialType: metadata.materialType || '资料', version: metadata.version || '',
      access: 'private', checkedAt: metadata.checkedAt || '', origin: 'browser-private', localOnly: true,
      missingMetadata: [!course && '适用课程', !metadata.term && '适用学期', !metadata.version && '版本'].filter(Boolean),
    });
  }
  const unique = new Map(items.map((item) => [`${item.group}:${item.id}`, item]));
  return { items: [...unique.values()], courses: courseRows, notes: [...(materials.notes || [])], isLocal: !!materials.isLocal };
}

const normalizeQuery = normalizeSearchText;
const learningSearchOptions = {
  getTitle: (item) => item.title,
  getKeywords: (item) => [item.id, item.resourceId, item.code, item.courseName, item.reportedCourseName, item.year, item.materialType, item.term, item.faculty].filter(Boolean).join(' '),
  getText: (item) => item.summary,
};

export function learningFacets(items) {
  const facet = (key, labelKey) => {
    const count = new Map();
    for (const item of items) if (item[key]) {
      const value = text(item[key]);
      const entry = count.get(value) || { value, label: text(item[labelKey] || (key === 'access' ? LEARNING_ACCESS[value] : value) || value), count: 0 };
      entry.count += 1; count.set(value, entry);
    }
    return [...count.values()].sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'));
  };
  return { courses: facet('courseId', 'courseName'), terms: facet('term'), faculty: facet('faculty'), access: facet('access') };
}

export function searchLearningCatalogue(items, filters = {}) {
  const exact = normalizeQuery(filters.q);
  const ranked = [];
  for (const item of items) {
    if (filters.type && filters.type !== 'all' && item.group !== filters.type) continue;
    if (filters.school && item.school !== filters.school && !(filters.school === 'cumtb' && !item.school)) continue;
    if (filters.course && item.courseId !== filters.course) continue;
    if (filters.term && item.term !== filters.term) continue;
    if (filters.faculty && item.faculty !== filters.faculty) continue;
    if (filters.access && item.access !== filters.access) continue;
    const fuzzyScore = scoreSearchItem(item, filters.q, learningSearchOptions);
    if (fuzzyScore < 0) continue;
    const isExact = !!exact && [item.id, item.resourceId, item.code].some((value) => value && normalizeQuery(value) === exact);
    const score = (isExact ? 2000 : 0) + fuzzyScore;
    ranked.push({ item: { ...item, match: exact ? { kind: isExact ? 'exact' : 'keyword', score: isExact ? score : Math.min(999, score), snippet: item.summary || item.title } : null }, score });
  }
  ranked.sort((a, b) => b.score - a.score || String(a.item.title).localeCompare(String(b.item.title), 'zh-CN'));
  const found = ranked.map(({ item }) => item);
  const offset = Math.max(0, Number(filters.offset) || 0);
  const limit = Math.max(1, Number(filters.limit) || 10000);
  const page = found.slice(offset, offset + limit);
  const groups = Object.entries(LEARNING_GROUPS).map(([key, label]) => ({ key, label, total: found.filter((item) => item.group === key).length, items: page.filter((item) => item.group === key) })).filter((group) => group.total);
  return { items: page, groups, total: found.length, facets: learningFacets(items), limit, offset, nextOffset: offset + limit < found.length ? offset + limit : null };
}

export function normalizeLocalFullTextResults(response, catalogue, filters = {}) {
  const known = new Map(catalogue.items.filter((item) => item.localOnly && item.origin === 'browser-local').map((item) => [text(item.resourceId || item.id), item]));
  const raw = rows(response).slice(0, 30);
  const normalized = normalizeLearningCatalogue({ courses: catalogue.courses, materials: raw.map((hit) => ({ id: hit.id, title: hit.title, courseId: hit.course_id, course: hit.course, year: hit.year, kind: hit.kind, url: `/api/file/${encodeURIComponent(hit.id)}`, note: hit.snippet, source: hit.source_url })) });
  const items = normalized.items.filter((item) => item.group === 'resources').map((item) => {
    const hit = raw.find((row) => text(row.id) === item.resourceId);
    const existing = known.get(item.resourceId);
    const bodyHit = !!hit.snippet && hit.snippet !== hit.extract_status && hit.extract_status !== 'scan';
    const snippet = bodyHit ? hit.snippet : hit.extract_status === 'scan' ? '扫描资料可查看原卷；尚未提取可检索的正文。' : '目录匹配；该结果未返回正文命中片段。';
    return { ...item, ...existing, href: `knowledge.html?q=${encodeURIComponent(filters.q || '')}`, snippet, summary: snippet,
      matchPage: bodyHit ? Number(hit.match_page) || 1 : null, match: { kind: bodyHit ? 'body' : 'keyword', reason: bodyHit ? '本机正文匹配' : '本机目录匹配', snippet } };
  });
  // The local service already evaluated q over complete pages. Apply only exact
  // scope filters here, not q again against the single displayed snippet.
  const selected = searchLearningCatalogue(items, { ...filters, q: '', limit: 30, offset: 0 });
  const byId = new Map(items.map((item) => [item.id, item]));
  return { items: selected.items.map((item) => byId.get(item.id)), total: Number(response.total) || 0, scanned: raw.length, truncated: Number(response.total) > 30 };
}

let cataloguePromise;
export function loadLearningCatalogue({ refresh = false } = {}) {
  if (refresh) cataloguePromise = null;
  cataloguePromise ??= (async () => {
    const results = await Promise.allSettled([
      fetch('data/courses.json', { signal: AbortSignal.timeout(7000) }).then((response) => { if (!response.ok) throw new Error('课程目录读取失败'); return response.json(); }),
      import('./materials-catalog.js').then(({ loadMaterials }) => loadMaterials()),
      import('./private-resources.js').then(({ listPrivateResources }) => listPrivateResources()),
    ]);
    const [courses, materials, privateResources] = results;
    if (courses.status === 'rejected' && materials.status === 'rejected' && !(privateResources.status === 'fulfilled' && privateResources.value.length)) throw new Error('课程与资料目录暂时无法读取。');
    const result = normalizeLearningCatalogue({ courses: courses.status === 'fulfilled' ? courses.value : [], materials: materials.status === 'fulfilled' ? materials.value : [], privateResources: privateResources.status === 'fulfilled' ? privateResources.value : [] });
    if (courses.status === 'rejected') result.notes.push('课程目录读取失败，课程筛选暂时不完整。');
    if (materials.status === 'rejected') result.notes.push('资料目录读取失败，当前只显示可读取的课程。');
    if (privateResources.status === 'rejected') result.notes.push('当前浏览器的个人收藏未能读取。');
    return result;
  })();
  return cataloguePromise;
}
