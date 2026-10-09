// 每个人自己的校园：学院专业、我的课、到过的楼，以及由这些算出来的任务。
// 课表是个人信息，只存在这个浏览器里，不上传；可以导出备份，换设备时再导入。
// 任务只用两种真实来源：你自己填的课表，和 OpenStreetMap 里真实存在的楼。没有的楼不会出现在任务里。

import { normalizePlan, dateOf, addDays, weekStart, occurrences, occurrenceId } from './campus-plan.js';
import { readPlan, writePlan, subscribePlan } from './campus-store.js';

const KEY = 'luokixi.campus.me';
const blank = () => normalizePlan();

// Reading upgrades defaults in memory only; it never writes the user's storage.
export function loadStorage(storage) {
  try {
    const source = storage === undefined ? globalThis.localStorage : storage;
    const raw = JSON.parse(source?.getItem(KEY) ?? 'null');
    if (raw?.version === 1) return normalizePlan(raw);
  } catch { /* 隐私模式或数据损坏：原存储保留，界面从空白开始 */ }
  return blank();
}

let memory;
let unsubscribeMemory;
const memoryVersions = new WeakMap();
function remember(state) {
  memory = { ...state, data: normalizePlan(state.data) };
  memoryVersions.set(memory.data, memory.revision);
  return memory;
}

export async function readyMe() {
  if (!unsubscribeMemory) unsubscribeMemory = subscribePlan(remember);
  return remember(await readPlan());
}

export function loadMe() {
  if (!memory) throw new Error('校园数据尚未读取，请先等待 readyMe()。');
  return memory.data;
}

// A retained object keeps the revision it was read at, even when another tab has
// refreshed the memory cache. Patches read the latest plan, then use the same CAS.
function corruptEdit() {
  const error = new Error('旧校园数据校验未通过，请先保留原备份，再通过导入或清空恢复；普通编辑未保存。');
  error.code = 'corrupt';
  return error;
}
export async function saveMe(meOrPatch, revision) {
  let data;
  let expectedRevision;
  if (typeof meOrPatch === 'function') {
    const latest = await readPlan();
    if (latest.corrupt) throw corruptEdit();
    expectedRevision = revision ?? latest.revision;
    const patched = meOrPatch(latest.data);
    if (patched && typeof patched.then === 'function') throw new Error('校园改动函数需要同步返回计划。');
    data = normalizePlan(patched ?? latest.data);
  } else {
    if (!memory) throw new Error('校园数据尚未读取，请先等待 readyMe()。');
    if (memory.corrupt && revision === undefined) throw corruptEdit();
    expectedRevision = revision ?? memoryVersions.get(meOrPatch);
    if (expectedRevision === undefined) {
      const error = new Error('替换完整计划需要先读取版本号，再按该版本确认保存。');
      error.code = 'revision_required';
      throw error;
    }
    data = normalizePlan(meOrPatch);
  }
  data.updated = new Date().toISOString();
  const saved = await writePlan(data, expectedRevision);
  remember(saved);
  if (typeof meOrPatch !== 'function') {
    Object.assign(meOrPatch, saved.data);
    memoryVersions.set(meOrPatch, saved.revision);
  }
  return true;
}
export function importMe(raw) {
  if (raw?.version !== 1 || !Array.isArray(raw.courses)) throw new Error('这不是校园地图导出的备份文件。');
  return normalizePlan(raw);
}

export const newId = () => Math.random().toString(36).slice(2, 10);
export const DAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
export const todayIndex = (d = new Date()) => ((new Date(`${dateOf(d)}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
const minutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

// The old map interface keeps its course/slot/status shape. With a semester, a
// weekday refers to the actual date in this Shanghai week, including week filters.
export function classesOn(me, day, now = new Date()) {
  if (!Number.isInteger(day) || day < 1 || day > 7) return [];
  const checked = normalizePlan(me);
  const today = dateOf(now);
  const target = addDays(weekStart(today), day - 1);
  const eligible = checked.term.starts ? new Set(occurrences(checked, target, target).filter((x) => x.source === 'course').map((x) => x.id)) : null;
  const hidden = new Set(checked.hiddenOccurrences);
  const list = (me.courses ?? []).flatMap((course, i) => {
    const c = checked.courses[i];
    if (c.hidden || c.cancelled) return [];
    return (course.slots ?? []).flatMap((slot, j) => {
      const s = c.slots[j];
      const occurrence = occurrenceId('course', c.id, target, s.id);
      return s.day === day && (eligible ? eligible.has(occurrence) : !hidden.has(occurrence)) ? [{ course, slot }] : [];
    });
  }).sort((a, b) => minutes(a.slot.start) - minutes(b.slot.start));
  if (target !== today) return list.map((x) => ({ ...x, status: 'later' }));
  const shanghai = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const t = shanghai.getUTCHours() * 60 + shanghai.getUTCMinutes();
  let nextGiven = false;
  return list.map((x) => {
    const [s, e] = [minutes(x.slot.start), minutes(x.slot.end)];
    let status = 'later';
    if (e <= t) status = 'done';
    else if (s <= t) status = 'now';
    else if (!nextGiven) { status = 'next'; nextGiven = true; }
    if (status === 'now') nextGiven = true;
    return { ...x, status };
  });
}
export const visitedSet = (me, campus) => new Set(me.visited[campus] ?? []);

export function toggleVisited(me, campus, osm) {
  const set = visitedSet(me, campus);
  if (set.has(osm)) set.delete(osm);
  else set.add(osm);
  me.visited[campus] = [...set];
  return set.has(osm);
}

// ---------- 探索任务 ----------
// 每一步的目标是一类楼（按 OSM 名称和用途分类）；到过其中任意一栋，这一步就算完成。
// 校园里找不到这类楼时，这一步不出现，不编造。

const EXPLORE = [
  { id: 'library', title: '找到图书馆', hint: '借书、自习、查资料，都从这里开始。', match: (f) => f.properties.use === 'library' },
  { id: 'teaching', title: '提前认识一栋教学楼', hint: '第一节课之前先走一遍，上课就不会找错门。', match: (f) => f.properties.use === 'teaching' },
  { id: 'canteen', title: '吃一顿食堂', hint: '开学第一周，把几个窗口都试一遍。', match: (f) => f.properties.use === 'canteen' },
  { id: 'sports', title: '去运动的地方看看', hint: '体育课、晨跑和社团训练常在这一带。', match: (f) => f.properties.use === 'sports' },
  { id: 'hall', title: '找到开会和演出的地方', hint: '讲座、晚会、社团演出常在这类会堂里。', match: (f) => f.properties.use === 'hall' },
  { id: 'history', title: '了解学校的历史', hint: '开放时间以馆方通知为准。', match: (f) => /校史/.test(f.properties.name) },
  { id: 'lab', title: '路过一栋实验楼', hint: '高年级的实验课和科研都在这样的楼里。', match: (f) => f.properties.use === 'lab' },
];

export function quests(me, campus, campusName, buildings) {
  const visited = visitedSet(me, campus);
  const named = buildings.filter((b) => b.properties.name);
  const step = (id, title, hint, targets) => ({ id, title, hint, targets: targets.map((t) => t.properties.osm), done: targets.some((t) => visited.has(t.properties.osm)) });
  const out = [];

  // 1. 我的课：把每门课的教学楼都提前走一遍（只来自你自己的课表）
  const mine = me.courses.filter((c) => c.building?.campus === campus);
  if (mine.length) {
    const seen = new Map();
    for (const c of mine) if (!seen.has(c.building.osm)) seen.set(c.building.osm, c);
    out.push({
      id: 'my-courses',
      personal: true,
      title: '上课前踩点',
      lead: '按你的课表生成：每门课的上课地点，提前走一遍。',
      steps: [...seen.values()].map((c) => {
        const b = buildings.find((x) => x.properties.osm === c.building.osm);
        return step(`course-${c.building.osm}`, c.building.name || '未命名的楼', `${c.name}${c.room ? ` · ${c.room}` : ''}`, b ? [b] : []);
      }),
    });
  }

  // 2. 认识校园：常用的几类地方
  const explore = EXPLORE.map((s) => step(s.id, s.title, s.hint, named.filter(s.match))).filter((s) => s.targets.length);
  if (explore.length) out.push({ id: 'explore', title: `认识${campusName}`, lead: '新同学最先要找到的几个地方。', steps: explore });

  // 3. 收集：所有有名字的楼
  if (named.length)
    out.push({
      id: 'collect',
      title: `走遍${campusName}`,
      lead: `地图上有名字的楼一共 ${named.length} 栋，到过一栋点亮一栋。`,
      collect: true,
      steps: named.map((b) => step(`b-${b.properties.osm}`, b.properties.name, '', [b])),
    });
  return out.map((q) => ({ ...q, total: q.steps.length, done: q.steps.filter((s) => s.done).length }));
}

// 课程名候选：Codex 整理的 courses.json（只用名称，开课学院等未核实的字段不显示）
export async function courseSuggestions() {
  try {
    const r = await fetch('data/courses.json', { cache: 'no-cache' });
    if (!r.ok) return [];
    return (await r.json()).courses.map((c) => ({ id: c.id, name: c.name, campus: c.scope === 'campus-catalogue' }));
  } catch {
    return [];
  }
}
