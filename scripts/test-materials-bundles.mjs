import test from 'node:test';
import assert from 'node:assert/strict';
import { groupMaterialBundles, parseExamGroup } from '../src/js/materials-bundles.js';
import { normalizeLocalMaterial } from '../src/js/materials-catalog.js';
const item = (id, kind = '试卷', group_key = 'cet6_2024_06_1', extra = {}) => ({ id, title: id, course: '英语六级', year: '2024', kind, format: kind === '听力音频' ? 'mp3' : 'pdf', url: `/api/file/${id}`, group_key, ...extra });

test('same suite becomes one book with all role files and deterministic order', () => {
  const input = [item('audio', '听力音频'), item('answer', '答案解析'), item('paper')];
  const [suite] = groupMaterialBundles(input);
  assert.equal(suite.isSuite, true); assert.equal(suite.complete, true); assert.equal(suite.fileCount, 3);
  assert.deepEqual(suite.files.map((x) => x.id), ['paper', 'answer', 'audio']);
  assert.deepEqual(suite.missingRoles, []);
  assert.deepEqual(groupMaterialBundles([...input].reverse())[0].files, suite.files);
  assert.equal(input[0].title, 'audio');
});
test('different exam date, level, set, course, edition and offering never merge', () => {
  const rows = [item('base'), item('month', '试卷', 'cet6_2024_12_1'), item('year', '试卷', 'cet6_2023_06_1', { year: '2023' }), item('set', '试卷', 'cet6_2024_06_2'), item('four', '试卷', 'cet4_2024_06_1', { course: '英语四级' }), item('edition', '试卷', undefined, { version: 'scan' }), item('course', '答案解析', undefined, { course: '大学物理' }), item('offering', '试卷', undefined, { offeringId: 'other' })];
  assert.equal(groupMaterialBundles(rows).length, rows.length);
});
test('explicit delayed sessions and 2-3 collections preserve exact identity', () => {
  assert.ok(parseExamGroup('cet6_2023_03_1')); assert.ok(parseExamGroup('cet4_2020_07_1'));
  for (const key of ['cet6_2024_13_1', 'cet6_2024_06_3-2', 'cet6_2024_06_1_ans', 'cet6_2024_06_1.mp3', 'cet6_2024_06_unknown']) assert.equal(parseExamGroup(key), null);
  const rows = [item('range', '试卷', 'cet6_2024_06_2-3'), item('range-answer', '答案解析', 'cet6_2024_06_2-3'), item('second', '试卷', 'cet6_2024_06_2')];
  const groups = groupMaterialBundles(rows); assert.equal(groups.length, 2); assert.equal(groups[0].fileCount, 2);
  assert.deepEqual(groups[0].missingRoles, ['audio']);
});
test('missing pieces remain visible and unknown names do not infer a relationship', () => {
  const groups = groupMaterialBundles([item('paper'), item('similar-paper', '试卷', '', { title: '英语六级2024年6月第1套' }), item('unknown-answer', '答案解析', 'unknown')]);
  assert.equal(groups.length, 3); assert.deepEqual(groups[0].missingRoles, ['answer', 'audio']);
  assert.equal(groups[1].isSuite, false); assert.equal(groups[2].isSuite, false);
});
test('combined PDFs and repeated URLs do not duplicate the original file', () => {
  const original = item('combined', '试卷与答案');
  const [suite] = groupMaterialBundles([original, { ...original, id: 'alias' }]);
  assert.equal(suite.fileCount, 1); assert.equal(suite.roles.paper.length, 1); assert.equal(suite.roles.answer.length, 1);
  assert.deepEqual(suite.missingRoles, ['audio']);
});
test('scan alternatives are preserved and unpublished metadata stays excluded', () => {
  const [suite] = groupMaterialBundles([item('text'), item('scan', '试卷', undefined, { extract_status: 'scan' }), item('pending', '答案解析', undefined, { status: 'pending' })]);
  assert.equal(suite.fileCount, 2); assert.equal(suite.roles.paper.length, 2); assert.equal(suite.roles.answer.length, 0);
});
test('only verified manifest IDs and correct byte hashes group chapters', () => {
  const rows = [item('ch1', '讲义', '', { course: '通识课', sha256: 'a' }), item('ch2', '讲义', '', { course: '通识课', sha256: 'b' })];
  const entry = { id: 'book-v1', title: '已有教材', source: 'owner-confirmed', verified: true, members: [{ id: 'ch2', sha256: 'b', order: 2, chapter: '第二章' }, { id: 'ch1', sha256: 'a', order: 1, chapter: '第一章' }] };
  const manifest = { schemaVersion: 1, collections: [entry] };
  const [book] = groupMaterialBundles(rows, { manifest });
  assert.equal(book.isSuite, false); assert.equal(book.isCollection, true); assert.equal(book.fileCount, 2); assert.equal(book.files[0].chapter, '第一章');
  assert.equal(groupMaterialBundles(rows, { manifest: { ...manifest, collections: [{ ...entry, verified: false }] } }).length, 2);
  assert.equal(groupMaterialBundles(rows, { manifest: { ...manifest, collections: [{ ...entry, members: [{ id: 'ch1', sha256: 'bad' }, { id: 'ch2' }] }] } }).length, 2);
  assert.equal(groupMaterialBundles(rows, { manifest: { ...manifest, collections: [entry, { ...entry, id: 'another-book' }] } }).length, 2);
});
test('local normalization preserves grouping evidence without copying private paths/text', () => {
  const normalized = normalizeLocalMaterial({ ...item('paper'), sha256: 'abc', extract_status: 'scan', file_path: 'C:/private/paper.pdf', body: 'private text', course_id: 'verified-course' });
  assert.equal(normalized.group_key, 'cet6_2024_06_1'); assert.equal(normalized.courseId, 'verified-course'); assert.equal(normalized.sha256, 'abc');
  assert.equal(normalized.file_path, undefined); assert.equal(normalized.body, undefined);
});
