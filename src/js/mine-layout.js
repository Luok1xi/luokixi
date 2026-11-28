// 书库的排法（只算数据，不碰 three；测试见 scripts/test-mine-layout.mjs）。
//   学 Folia 海报墙的思路（只学思路，代码和模板都是自己的）：画面由一块块 12×9 格的“版块”拼成，每块用几种模板之一，
//   模板里有竖的、方的、横的、通栏的格子，正好铺满不留空；相邻版块换模板、按序号翻转，所以整面墙不像网格。
//   所有资料排成一条不断的“流”：学科开头一张学科卡，课程（4 册以上）开头一张课程海报，然后是这门课的资料；
//   流一块一块往版块里填，不再“一门课从新的一圈开始”——小课不会留下一圈空墙（上一版往回滚到环尾时几乎是空的）。
//   版块里谁放大格子：学科卡挑最宽的，海报和有真实画面的资料挑最大的，其余按顺序放。
//   井道：每 4 块是一层（北东南西四面），一层一层往下，走到底接着从头来；矿脉墙：同一串版块按行铺开。
//   两种排法用的是同一串版块，所以每本书在两边的位置一一对应，切换时直接飞过去。
export const DISCIPLINES = [
  { id: 'lang', name: '外语', test: /外语|英语|雅思|托福|日语|四级|六级|cet|ielts|toefl/i },
  { id: 'math', name: '数学', test: /数学|数值|函数|方程|代数|几何|拓扑|数论|概率|统计|随机|微积分|高数|图论|集合论|运筹|最优化|离散/ },
  { id: 'cs', name: '计算机', test: /计算机|编译|数据|数字逻辑|机器学习|程序|python|socket|算法|软件|操作系统|网络|人机|web|acm|密码|人工智能|计算概论|大计基|week_/i },
  { id: 'ee', name: '电子电气', test: /电子|电气|电路|电磁|微波|信号|通信|交换|控制|微处理|自动|辨识|集成|编码/ },
  { id: 'sci', name: '自然科学', test: /物理|化学|材料|生物|相对论|量子|力学|光学|地震|大气|环境|地质|板块|混沌|天文/ },
  { id: 'hum', name: '人文社科', test: null },
];
const DIRECT = { 数学: 'math', 计算机: 'cs', 电子与电气: 'ee', 物理: 'sci', 化学与材料: 'sci', 外语: 'lang', 人文与通识: 'hum' };
const KEYWORD_ORDER = ['lang', 'math', 'ee', 'sci', 'cs'].map((id) => DISCIPLINES.find((d) => d.id === id));

/** 这册资料归到哪个学科：目录的学科字段优先，没有就按课名关键词（可能归错，界面上写明“自动归类”） */
export function disciplineOf(x) {
  if (DIRECT[x.discipline]) return DIRECT[x.discipline];
  const text = `${x.discipline || ''} ${x.course || ''}`;
  return KEYWORD_ORDER.find((d) => d.test.test(text))?.id || 'hum';
}

// ---------- 版块模板（12 列 × 9 行，自己设计；测试保证每块正好铺满） ----------
export const BLOCK = { cols: 12, rows: 9 };
const s = (x, y, w, h) => ({ x, y, w, h });
export const TEMPLATES = [
  // 左边一张大竖图，右边竖横交错，底下一排方的
  [s(0, 0, 4, 6), s(4, 0, 2, 3), s(6, 0, 2, 3), s(8, 0, 4, 3), s(4, 3, 4, 3), s(8, 3, 2, 3), s(10, 3, 2, 3),
    s(0, 6, 2, 3), s(2, 6, 2, 3), s(4, 6, 3, 3), s(7, 6, 3, 3), s(10, 6, 2, 3)],
  // 顶上一条通栏，右边一张大竖图
  [s(0, 0, 6, 3), s(6, 0, 2, 3), s(8, 0, 4, 6), s(0, 3, 2, 3), s(2, 3, 2, 3), s(4, 3, 4, 3),
    s(0, 6, 3, 3), s(3, 6, 2, 3), s(5, 6, 2, 3), s(7, 6, 2, 3), s(9, 6, 3, 3)],
  // 三张竖的接一条通栏，中间偏右一张大竖图
  [s(0, 0, 2, 3), s(2, 0, 2, 3), s(4, 0, 2, 3), s(6, 0, 6, 3), s(0, 3, 3, 3), s(3, 3, 3, 3), s(6, 3, 4, 6),
    s(10, 3, 2, 3), s(0, 6, 4, 3), s(4, 6, 2, 3), s(10, 6, 2, 3)],
  // 左下大竖图，四周方的和横的
  [s(0, 0, 3, 3), s(3, 0, 2, 3), s(5, 0, 4, 3), s(9, 0, 3, 3), s(0, 3, 4, 6), s(4, 3, 2, 3), s(6, 3, 2, 3),
    s(8, 3, 4, 3), s(4, 6, 4, 3), s(8, 6, 2, 3), s(10, 6, 2, 3)],
  // 两条通栏夹着一张大竖图
  [s(0, 0, 3, 3), s(3, 0, 3, 3), s(6, 0, 6, 3), s(0, 3, 2, 3), s(2, 3, 4, 6), s(6, 3, 2, 3), s(8, 3, 2, 3),
    s(10, 3, 2, 3), s(0, 6, 2, 3), s(6, 6, 6, 3)],
];
const flipX = (t) => t.map((r) => ({ ...r, x: BLOCK.cols - r.x - r.w }));
const flipY = (t) => t.map((r) => ({ ...r, y: BLOCK.rows - r.y - r.h }));
const ORIENTED = TEMPLATES.flatMap((t) => [t, flipX(t), flipY(t), flipX(flipY(t))]);
const mix = (n) => { let v = Math.imul(n + 1, 0x9e3779b1); v = Math.imul(v ^ (v >>> 15), 0x2c1b3c6d); return (v ^ (v >>> 12)) >>> 0; };
/** 第 b 块用哪个模板：相邻两块一定不同（序号线性走），翻转按散列，整面墙看不出周期 */
export function templateOf(b) {
  const t = ((b * 2) % TEMPLATES.length + TEMPLATES.length) % TEMPLATES.length;
  return ORIENTED[t * 4 + (mix(b) % 4)];
}

// ---------- 流：学科卡、课程海报、资料 ----------
const courseOf = (x) => x.course || '未归类';
const yearsOf = (list) => {
  const ys = list.map((x) => Number(String(x.year ?? '').match(/\d{4}/)?.[0])).filter((y) => y > 1990);
  return ys.length ? (Math.min(...ys) === Math.max(...ys) ? `${ys[0]}` : `${Math.min(...ys)}–${Math.max(...ys)}`) : '';
};
const byCourse = (items) => {
  const m = new Map();
  for (const x of items) { const c = courseOf(x); if (!m.has(c)) m.set(c, []); m.get(c).push(x); }
  return m;
};

/**
 * 排成一条流。返回 { stream, courses, disciplines, order }：
 *   stream：[{ kind: 'disc' | 'poster' | 'item', key, item?, course?, disc? }]；
 *   courses：[{ course, items, years, discipline, layer, at }]（at 是它在流里的位置）；order：课名 → 第几门。
 * posterMin：几册以上的课才有海报；within(a, b)：一门课里的先后。
 */
export function buildStream(items, { posterMin = 4, within = null } = {}) {
  const groups = new Map(DISCIPLINES.map((d) => [d.id, []]));
  for (const x of items) groups.get(disciplineOf(x)).push(x);
  const stream = [], courses = [], disciplines = [], order = new Map();
  for (const d of DISCIPLINES) {
    const list = groups.get(d.id);
    if (!list.length) continue;
    const rec = { ...d, at: stream.length, courses: [], count: list.length };
    disciplines.push(rec);
    stream.push({ kind: 'disc', key: `disc:${d.id}`, disc: rec });
    for (const [course, raw] of [...byCourse(list)].sort((a, b) => b[1].length - a[1].length)) {
      const its = within ? [...raw].sort(within) : raw;
      const c = { course, items: its, years: yearsOf(its), discipline: rec, layer: courses.length + 1, at: stream.length, poster: its.length >= posterMin };
      order.set(course, courses.length);
      courses.push(c); rec.courses.push(c);
      if (c.poster) stream.push({ kind: 'poster', key: `poster:${course}`, course: c });
      for (const x of its) stream.push({ kind: 'item', key: x.id, item: x, course: c });
    }
  }
  return { stream, courses, disciplines, order };
}

/**
 * 把流一块一块填进版块。weight(entry)：数越大越该进大格子（有真实画面的资料给 2）。
 * 返回 { blocks: [{ b, cells: [{ entry, x, y, w, h }] }], index: key → { b, x, y, w, h } }，x / y / w / h 以格为单位。
 */
export function packBlocks(stream, { weight = () => 1 } = {}) {
  const blocks = [], index = new Map();
  for (let at = 0, b = 0; at < stream.length; b++) {
    const slots = templateOf(b), take = stream.slice(at, at + slots.length);
    at += take.length;
    const free = [...slots].sort((p, q) => q.w * q.h - p.w * p.h || p.y - q.y || p.x - q.x);
    const cells = [];
    // 学科卡挑最宽的格子，其余按“分量”从大到小挑最大的（同分量保持流里的先后）
    const ranked = take.map((entry, n) => ({ entry, n, wt: entry.kind === 'disc' ? 9 : entry.kind === 'poster' ? 5 : weight(entry) }))
      .sort((p, q) => q.wt - p.wt || p.n - q.n);
    for (const { entry } of ranked) {
      let k = 0;
      if (entry.kind === 'disc') free.forEach((r, i) => { if (r.w / r.h > free[k].w / free[k].h + 1e-6) k = i; });
      const r = free.splice(k, 1)[0];
      cells.push({ entry, ...r });
      index.set(entry.key, { b, x: r.x, y: r.y, w: r.w, h: r.h });
    }
    blocks.push({ b, cells });
  }
  return { blocks, index };
}

/** 课程 / 学科第一次出现在哪一块（跳转用） */
function locate(list, index) {
  for (const rec of list) {
    const key = rec.courses ? `disc:${rec.id}` : rec.poster ? `poster:${rec.course}` : rec.items[0]?.id;
    rec.b = index.get(key)?.b ?? 0;
  }
}

/** 井道和矿脉墙共用：一串版块 + 课程、学科的位置 */
export function buildMosaic(items, options = {}) {
  const flow = buildStream(items, options), packed = packBlocks(flow.stream, options);
  locate(flow.courses, packed.index); locate(flow.disciplines, packed.index);
  return { ...flow, ...packed };
}

/** 井道：第 b 块在第几层、哪一面；第 level 层在 [d0, d1] 之间的展开（无限循环） */
export const shaftOf = (b) => ({ level: Math.floor(b / 4), face: b % 4 });
export function levelsIn(levelCount, levelH, d0, d1) {
  const out = [];
  if (levelCount <= 0) return out;
  for (let k = Math.floor(d0 / levelH); k * levelH <= d1; k++) {
    const rep = Math.floor(k / levelCount), level = k - rep * levelCount;
    out.push({ level, rep, top: k * levelH });
  }
  return out;
}
/** 深度 depth 处是第几块（取这一层北面那块） */
export const levelAt = (levelCount, levelH, depth) => (((Math.floor(depth / levelH) % levelCount) + levelCount) % levelCount);

// ---------- 矿脉墙：一门课一行（用来有规律地找；井道才是漫无目的地逛） ----------
/**
 * 把一门课的资料拼进一条两格高的带子：每张 { item, col, row, span }，span 是 1 或 2（2 就占 2×2）。
 * 开头留一块 2×2 给这门课的海报；小的总是补最左边的空，大的找最左边整块空着的 2×2，找不到就当小的放。
 */
export function packBand(list, spanOf = () => 1) {
  const places = [], occ = [];
  let cursor = 0;
  const free = (c, r) => !occ[c]?.[r];
  const take = (c, r, n) => { for (let i = c; i < c + n; i++) for (let j = r; j < r + n; j++) (occ[i] ||= [false, false])[j] = true; };
  const advance = () => { while (!free(cursor, 0) && !free(cursor, 1)) cursor++; };
  take(0, 0, 2); advance();
  const small = () => { for (let c = cursor; ; c++) { if (free(c, 0)) return [c, 0]; if (free(c, 1)) return [c, 1]; } };
  const big = () => { for (let c = cursor; c <= occ.length; c++) if (free(c, 0) && free(c, 1) && free(c + 1, 0) && free(c + 1, 1)) return [c, 0]; return null; };
  for (const item of list) {
    const b = spanOf(item) === 2 ? big() : null, at = b || small(), span = b ? 2 : 1;
    places.push({ item, col: at[0], row: at[1], span });
    take(at[0], at[1], span); advance();
  }
  return places;
}

/**
 * 矿脉墙：一门课一行，按 order（井道里的先后）排。courses：井道的课程记录（海报要用），没有就现做一个。
 * 返回 { rows: [{ r, course, rec, places, width, poster }], index: key → { r, x, y, w, h } }（以格为单位，海报的 key 是 poster:课名）
 */
export function buildWall(items, { order = new Map(), courses = [], spanOf, within = null } = {}) {
  const index = new Map();
  const rows = [...byCourse(items)].sort((a, b) => (order.get(a[0]) ?? Infinity) - (order.get(b[0]) ?? Infinity)).map(([course, raw], r) => {
    const list = within ? [...raw].sort(within) : raw;
    const rec = courses[order.get(course)] || { course, items: list, years: yearsOf(list), layer: r + 1, discipline: DISCIPLINES.find((d) => d.id === disciplineOf(list[0])) };
    const poster = { kind: 'poster', key: `poster:${course}`, course: rec };
    const places = packBand(list, spanOf).map((pl) => ({ ...pl, entry: { kind: 'item', key: pl.item.id, item: pl.item, course: rec } }));
    index.set(poster.key, { r, x: 0, y: 0, w: 2, h: 2 });
    for (const pl of places) index.set(pl.item.id, { r, x: pl.col, y: pl.row, w: pl.span, h: pl.span });
    return { r, course, rec, poster, places, width: Math.max(2, ...places.map((pl) => pl.col + pl.span)) };
  });
  return { rows, index };
}
