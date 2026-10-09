import test from 'node:test';
import assert from 'node:assert/strict';
import { fuzzySearch, scoreSearchItem, normalizeSearchText } from '../src/js/fuzzy-search.js';

test('Chinese shorthand and fullwidth English phrases find canonical course names', () => {
  const rows = [{ title: '线性代数期末卷', year: 2023 }, { title: '高等数学' }];
  for (const query of ['线代', 'linear algebra', 'ＬＩＮＥＡＲ　ＡＬＧＥＢＲＡ', '线代 2023']) assert.equal(fuzzySearch(rows, query)[0], rows[0]);
});
test('category aliases work without matching inside unrelated words', () => {
  const rows = [{ title: '计算机科学' }, { title: 'CSS 动画' }, { title: '嵌入式开发' }, { title: '日常工具' }];
  assert.deepEqual(fuzzySearch(rows, 'cs'), [rows[0]]);
  assert.equal(fuzzySearch(rows, 'mcu')[0], rows[2]);
  assert.equal(fuzzySearch(rows, 'daily')[0], rows[3]);
  assert.equal(fuzzySearch([{ title: 'embedded workshop' }], 'embeddde').length, 1);
});
test('exact titles outrank aliases, prefixes and one-letter Latin mistakes', () => {
  const rows = [{ title: 'Python 学习' }, { title: 'Python' }, { title: 'Pythin' }, { title: '其他', tags: ['python'] }];
  assert.equal(fuzzySearch(rows, 'Python')[0], rows[1]);
  assert.equal(fuzzySearch(rows, 'Pythin')[0], rows[2]);
  assert.equal(fuzzySearch(rows, 'pyhton')[0], rows[1]);
  assert.equal(fuzzySearch(rows, 'pythn')[0], rows[1]);
  assert.equal(fuzzySearch(rows, 'py')[0], rows[1]);
});
test('bounded subsequences tolerate omitted Chinese characters but reject unrelated input', () => {
  assert.ok(scoreSearchItem({ title: '大学物理' }, '大物理') > 0);
  assert.equal(scoreSearchItem({ title: '大学物理实验' }, '大验'), -1);
  assert.equal(scoreSearchItem({ title: 'Python' }, 'pyxxxx'), -1);
});
test('versions, years, course IDs and duplicate titles remain separate', () => {
  const rows = [{ id: 'cet6_2023_12_1', title: '英语六级 2023 第一套' }, { id: 'cet6_2024_12_1', title: '英语六级 2024 第一套' }];
  assert.deepEqual(fuzzySearch(rows, '六级 2023'), [rows[0]]);
  assert.deepEqual(fuzzySearch(rows, 'cet6_2023_12_1'), [rows[0]]);
  assert.equal(fuzzySearch([{ title: 'MATH101' }], 'MATH102').length, 0);
  assert.equal(fuzzySearch([{ title: '同名资料' }, { title: '同名资料' }], '同名').length, 2);
});
test('C++ and C# stay distinct, all tokens are required and results never mutate sources', () => {
  const rows = Object.freeze([Object.freeze({ title: 'C++ 入门' }), Object.freeze({ title: 'C# 入门' })]);
  assert.equal(fuzzySearch(rows, 'C++')[0], rows[0]);
  assert.equal(fuzzySearch(rows, 'C#')[0], rows[1]);
  assert.equal(fuzzySearch(rows, 'C++ 高级').length, 0);
  assert.equal(normalizeSearchText('Ｃ＋＋（入门）'), 'c++ 入门');
});
test('caller getters preserve originals and empty queries preserve source order', () => {
  const rows = [{ label: '乙', words: '图书馆' }, { label: '甲', words: '教学楼' }];
  assert.deepEqual(fuzzySearch(rows, '', { limit: 1 }), [rows[0]]);
  assert.equal(fuzzySearch(rows, 'library', { getTitle: (x) => x.label, getText: (x) => x.words })[0], rows[0]);
});
