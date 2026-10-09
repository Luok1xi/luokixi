import assert from 'node:assert/strict';
import test from 'node:test';
const { normalizeLearningCatalogue, searchLearningCatalogue, normalizeLocalFullTextResults, buildLearningHelpUrl, safeLearningUrl } = await import('../src/js/learning-catalog.js');

const courses = [
  { id: 'linalg', name: '线性代数', resourceIds: ['exam-10'], checkedAt: '2026-10-06' },
  { id: 'calc-a1', name: '高等数学 A1', resourceIds: ['exam-01'], verifiedCourseCode: 'MATH101' },
];
const materials = [
  { id: 'exam-10', title: '线性代数期末卷', course: '线代', year: '2023', url: '/api/file/exam-10' },
  { id: 'unlinked', title: '线性代数笔记', course: '线性代数', url: '/notes.pdf' },
  { id: 'exam-01', title: '高数复习', term: '2025-2026-1', url: '/api/file/exam-01' },
];
const catalogue = normalizeLearningCatalogue({ courses, materials });

test('verified resource IDs link material to course, display names cannot create relationships', () => {
  const linked = catalogue.items.find((item) => item.id === 'exam-10');
  assert.equal(linked.courseId, 'linalg');
  assert.equal(linked.access, 'local-only');
  assert.equal(linked.term, '');
  assert.equal(catalogue.items.find((item) => item.id === 'unlinked').courseId, '');
  const results = searchLearningCatalogue(catalogue.items, { course: 'linalg', type: 'resources' });
  assert.deepEqual(results.items.map((item) => item.id), ['exam-10']);
});

test('ambiguous resource IDs do not silently pick the first course', () => {
  const result = normalizeLearningCatalogue({ courses: [...courses, { id: 'other', name: '另一门课程', resourceIds: ['exam-10'] }], materials });
  assert.equal(result.items.find((item) => item.id === 'exam-10').courseId, '');
});

test('Chinese shorthand and English course phrases find canonical names', () => {
  for (const q of ['线代', 'linear algebra', 'ＬＩＮＥＡＲ　ＡＬＧＥＢＲＡ']) {
    const result = searchLearningCatalogue(catalogue.items, { q, type: 'courses' });
    assert.deepEqual(result.items.map((item) => item.id), ['linalg']);
  }
  const probability = normalizeLearningCatalogue({ courses: [{ id: 'probability', name: '概率论与数理统计' }] });
  assert.equal(searchLearningCatalogue(probability.items, { q: '概率论' }).total, 1);
});

test('exact identifiers outrank a descriptive title that includes the identifier', () => {
  const items = [...catalogue.items, { id: 'guide', group: 'courses', title: 'MATH101 课程经验', school: 'cumtb' }];
  const result = searchLearningCatalogue(items, { q: 'MATH101' });
  assert.equal(result.items[0].id, 'calc-a1');
  assert.equal(result.items[0].match.kind, 'exact');
});

test('term/access/type/school filters keep scope exact and do not infer term from year', () => {
  assert.equal(searchLearningCatalogue(catalogue.items, { term: '2023' }).total, 0);
  const result = searchLearningCatalogue(catalogue.items, { type: 'resources', school: 'cumtb', term: '2025-2026-1', access: 'local-only' });
  assert.deepEqual(result.items.map((item) => item.id), ['exam-01']);
  assert.equal(searchLearningCatalogue(catalogue.items, { school: 'cumt' }).total, 0);
});

test('private search adapter allows metadata only and preserves browser-only access', () => {
  const result = normalizeLearningCatalogue({ courses, privateResources: [{ id: 'mine', title: '私有笔记', summary: '矩阵特征值', fileBlob: new Blob(['not public']), secret: 'should not copy', learning: { courseId: 'linalg', term: '2026-1', access: 'public' } }] });
  const saved = result.items.find((item) => item.id === 'private:mine');
  assert.equal(saved.access, 'private');
  assert.equal(saved.origin, 'browser-private');
  assert.equal(saved.courseId, 'linalg');
  assert.equal('fileBlob' in saved, false);
  assert.equal('secret' in saved, false);
  assert.equal(searchLearningCatalogue(result.items, { q: '特征值', access: 'private' }).total, 1);
});

test('pagination reports counts without losing grouped semantics', () => {
  const first = searchLearningCatalogue(catalogue.items, { limit: 2 });
  const next = searchLearningCatalogue(catalogue.items, { limit: 2, offset: first.nextOffset });
  assert.equal(first.total, 5);
  assert.equal(first.items.length, 2);
  assert.equal(new Set([...first.items, ...next.items].map((item) => item.id)).size, 4);
});

test('unsafe sources are removed and help URLs preserve question/course/filter context', () => {
  assert.equal(safeLearningUrl('javascript:alert(1)'), '');
  assert.equal(safeLearningUrl('data:text/html,unsafe'), '');
  assert.equal(safeLearningUrl('https://example.edu/course'), 'https://example.edu/course');
  const help = new URL(buildLearningHelpUrl('线代 & 特征值', 'linalg', { term: '2025-2026-1', access: 'local-only', type: 'resources' }), 'https://example.org/');
  assert.equal(help.searchParams.get('q'), '线代 & 特征值');
  assert.equal(help.searchParams.get('id'), 'linalg');
  assert.equal(help.searchParams.get('term'), '2025-2026-1');
  assert.equal(help.searchParams.get('ask'), '1');
});

test('local fulltext preserves proven body match and filters only verified scope', () => {
  const result = normalizeLocalFullTextResults({ total: 2, items: [
    { id: 'exam-10', title: '线性代数卷', course: '线代', snippet: '本页只展示矩阵，第二个关键词在另一页', match_page: 7, extract_status: 'text' },
    { id: 'unmapped', title: '线性代数其他文件', course: '线性代数', snippet: '正文片段', match_page: 4, extract_status: 'text' },
  ] }, catalogue, { q: '矩阵 第二页特征值', course: 'linalg', type: 'resources', access: 'local-only' });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].courseId, 'linalg');
  assert.equal(result.items[0].matchPage, 7);
  assert.equal(result.items[0].match.kind, 'body');
  assert.equal(new URL(result.items[0].href, 'https://example.org').searchParams.get('q'), '矩阵 第二页特征值');
  assert.equal(normalizeLocalFullTextResults({items:[{id:'exam-10',snippet:'正文',extract_status:'text'}]},catalogue,{term:'2026-1'}).items.length,0);
});

test('local metadata-only hits do not invent a matching page and cap first page at 30', () => {
  const response = { total: 45, items: Array.from({ length: 40 }, (_, index) => ({ id: `file-${index}`, title: '资料', extract_status: 'text', snippet: 'text', match_page: 1 })) };
  const result = normalizeLocalFullTextResults(response, catalogue, {});
  assert.equal(result.items.length, 30);
  assert.equal(result.truncated, true);
  assert.equal(result.items[0].matchPage, null);
  assert.equal(result.items[0].match.kind, 'keyword');
});

test('fuzzy course/resource matching preserves exact filters and distinct versions', () => {
  const rows = [
    { id: 'python-1', group: 'resources', title: 'Python 笔记', version: '1', courseId: 'cs', access: 'private', school: 'cumtb' },
    { id: 'python-2', group: 'resources', title: 'Python 笔记', version: '2', courseId: 'cs', access: 'private', school: 'cumtb' },
    { id: 'python-public', group: 'resources', title: 'Python 公共笔记', courseId: 'cs', access: 'public', school: 'cumtb' },
  ];
  const result = searchLearningCatalogue(rows, { q: 'pyhton', access: 'private', course: 'cs' });
  assert.deepEqual(result.items.map(item => item.id), ['python-1', 'python-2']);
  assert.deepEqual(result.items.map(item => item.version), ['1', '2']);
  assert.equal(searchLearningCatalogue(rows, { q: 'pyhton', course: 'other' }).total, 0);
});
test('exact course identifier still beats another item with an identical title', () => {
  const result = searchLearningCatalogue([
    { id: 'notes', title: 'MATH101', group: 'resources' },
    { id: 'course', code: 'MATH101', title: '高等数学', group: 'courses' },
  ], { q: 'MATH101' });
  assert.equal(result.items[0].id, 'course');
  assert.equal(result.items[0].match.kind, 'exact');
});
