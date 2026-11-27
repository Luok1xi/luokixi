import test from 'node:test';
import assert from 'node:assert/strict';
import { BLOCK, TEMPLATES, buildMosaic, buildStream, buildWall, disciplineOf, levelAt, levelsIn, packBand, packBlocks, templateOf } from '../src/js/mine-layout.js';

test('每册资料归到一个学科', () => {
  assert.equal(disciplineOf({ discipline: '数学' }), 'math');
  assert.equal(disciplineOf({ discipline: '编译原理', course: '编译原理' }), 'cs');
  assert.equal(disciplineOf({ course: '英语六级' }), 'lang');
  assert.equal(disciplineOf({ course: '信号与系统' }), 'ee');
  assert.equal(disciplineOf({ course: '国际公法' }), 'hum');
});

// 一块里的格子正好铺满 12×9，不重叠、不越界
function covers(slots) {
  const seen = new Set();
  for (const { x, y, w, h } of slots) {
    assert.ok(x >= 0 && y >= 0 && x + w <= BLOCK.cols && y + h <= BLOCK.rows, `越界 ${x},${y}`);
    for (let i = x; i < x + w; i++) for (let j = y; j < y + h; j++) { assert.ok(!seen.has(`${i},${j}`), `重叠 ${i},${j}`); seen.add(`${i},${j}`); }
  }
  assert.equal(seen.size, BLOCK.cols * BLOCK.rows, '没铺满');
}

test('每个模板（含翻转）正好铺满一块；相邻两块模板不同', () => {
  TEMPLATES.forEach(covers);
  for (let b = 0; b < 40; b++) {
    covers(templateOf(b));
    assert.notDeepEqual(templateOf(b), templateOf(b + 1));
  }
});

const book = (id, course, extra = {}) => ({ id, course, ...extra });

test('流：学科卡打头，4 册以上的课才有海报，小课紧接着排，不另起一块', () => {
  const items = [...Array.from({ length: 5 }, (_, i) => book(`a${i}`, '线性代数', { discipline: '数学' })), book('b0', '实变函数', { discipline: '数学' }), book('c0', '英语四级')];
  const { stream, courses } = buildStream(items);
  assert.deepEqual(stream.map((e) => e.key), ['disc:lang', 'c0', 'disc:math', 'poster:线性代数', 'a0', 'a1', 'a2', 'a3', 'a4', 'b0']);
  assert.deepEqual(courses.map((c) => [c.course, c.poster, c.at]), [['英语四级', false, 1], ['线性代数', true, 3], ['实变函数', false, 9]]);
});

test('版块：学科卡进最宽的格子，有画面的进大格子，每个位置只用一次', () => {
  const items = Array.from({ length: 30 }, (_, i) => book(`m${i}`, `课${i % 3}`, { discipline: '数学', pdf: i === 7 }));
  const { blocks, index, disciplines, courses } = buildMosaic(items, { weight: (e) => (e.item?.pdf ? 2 : 1) });
  assert.equal(index.size, 1 + 3 + 30); // 学科卡 + 3 张海报 + 30 册
  for (const { b, cells } of blocks) covers(cells.length === templateOf(b).length ? cells : templateOf(b));
  const disc = index.get('disc:math'), widest = Math.max(...templateOf(0).map((r) => r.w / r.h));
  assert.equal(disc.w / disc.h, widest);
  const area = (k) => index.get(k).w * index.get(k).h;
  const firstBlock = blocks[index.get('m7').b].cells.filter((c) => c.entry.kind === 'item' && !c.entry.item.pdf);
  assert.ok(firstBlock.every((c) => c.w * c.h <= area('m7')));
  assert.equal(disciplines[0].b, 0);
  assert.ok(courses.every((c) => Number.isInteger(c.b)));
});

test('井道层：无限循环，往回滚到负深度接上最后几层，不会是空的', () => {
  assert.deepEqual(levelsIn(5, 4, 10, 17).map((l) => [l.level, l.rep, l.top]), [[2, 0, 8], [3, 0, 12], [4, 0, 16]]);
  assert.deepEqual(levelsIn(5, 4, -6, 0).map((l) => [l.level, l.rep, l.top]), [[3, -1, -8], [4, -1, -4], [0, 0, 0]]);
  assert.equal(levelAt(5, 4, -1), 4);
  assert.equal(levelAt(5, 4, 21), 0);
  assert.deepEqual(levelsIn(0, 4, 0, 9), []);
  const empty = packBlocks([]);
  assert.equal(empty.blocks.length, 0);
});

test('矿脉墙一门课一行：开头 2×2 是海报，资料不重叠、不漏，行按井道的先后', () => {
  const its = (course, n) => Array.from({ length: n }, (_, i) => ({ id: `${course}${i}`, course }));
  const places = packBand(its('a', 9), (x) => (x.id === 'a0' || x.id === 'a3' ? 2 : 1));
  const seen = new Set(['0,0', '1,0', '0,1', '1,1']);
  for (const pl of places) for (let c = pl.col; c < pl.col + pl.span; c++) for (let r = pl.row; r < pl.row + pl.span; r++) {
    assert.ok(r === 0 || r === 1);
    assert.ok(!seen.has(`${c},${r}`), `重叠 ${pl.item.id}`);
    seen.add(`${c},${r}`);
  }
  assert.equal(places.length, 9);
  assert.deepEqual(places.filter((pl) => pl.span === 2).map((pl) => pl.item.id), ['a0', 'a3']);
  const wall = buildWall([...its('b', 2), ...its('a', 3)], { order: new Map([['a', 0], ['b', 1]]) });
  assert.deepEqual(wall.rows.map((r) => r.course), ['a', 'b']);
  assert.deepEqual(wall.index.get('poster:b'), { r: 1, x: 0, y: 0, w: 2, h: 2 });
  assert.equal(wall.index.get('a0').x, 2);
  assert.equal(wall.rows[0].width, 4);
});
