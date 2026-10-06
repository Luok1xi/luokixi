// 每个人自己的校园：学院专业、我的课、到过的楼，以及由这些算出来的任务。
// 课表是个人信息，只存在这个浏览器里，不上传；可以导出备份，换设备时再导入。
// 任务只用两种真实来源：你自己填的课表，和 OpenStreetMap 里真实存在的楼。没有的楼不会出现在任务里。

const KEY = 'luokixi.campus.me';
const blank = () => ({ version: 1, profile: { faculty: '', major: '', year: '', campus: '' }, courses: [], visited: {}, updated: null });

export function loadMe() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY));
    if (v?.version === 1) return { ...blank(), ...v, profile: { ...blank().profile, ...v.profile }, visited: v.visited ?? {} };
  } catch { /* 隐私模式或数据损坏：从空白开始 */ }
  return blank();
}

export function saveMe(me) {
  me.updated = new Date().toISOString();
  try {
    localStorage.setItem(KEY, JSON.stringify(me));
    return true;
  } catch {
    return false;
  }
}

// 备份文件：只认这个格式，导入时逐项检查，不信任文件里的任意字段
export function importMe(raw) {
  if (raw?.version !== 1 || !Array.isArray(raw.courses)) throw new Error('这不是校园地图导出的备份文件。');
  const me = blank();
  const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
  const time = (v) => (/^\d{2}:\d{2}$/.test(v) ? v : '');
  me.profile = { faculty: str(raw.profile?.faculty, 80), major: str(raw.profile?.major, 80), year: str(raw.profile?.year, 10), campus: str(raw.profile?.campus, 20) };
  me.courses = raw.courses.slice(0, 60).map((c) => ({
    id: str(c.id, 40) || newId(),
    name: str(c.name, 80),
    courseId: str(c.courseId, 60),
    room: str(c.room, 60),
    building: c.building && typeof c.building.osm === 'string'
      ? { campus: str(c.building.campus, 20), osm: str(c.building.osm, 40), name: str(c.building.name, 80), center: Array.isArray(c.building.center) ? c.building.center.slice(0, 2).map(Number) : null }
      : null,
    slots: (Array.isArray(c.slots) ? c.slots : []).slice(0, 14)
      .map((s) => ({ day: Math.min(7, Math.max(1, Number(s.day) || 1)), start: time(s.start), end: time(s.end) }))
      .filter((s) => s.start && s.end),
  })).filter((c) => c.name);
  for (const [campus, list] of Object.entries(raw.visited ?? {})) if (Array.isArray(list)) me.visited[str(campus, 20)] = list.filter((x) => typeof x === 'string').slice(0, 500);
  return me;
}

export const newId = () => Math.random().toString(36).slice(2, 10);

export const DAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
export const todayIndex = (d = new Date()) => ((d.getDay() + 6) % 7) + 1; // 周一 = 1
const minutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

// 某一天的课，按开始时间排好，并标出“上完了 / 正在上 / 下一节 / 之后”
export function classesOn(me, day, now = new Date()) {
  const list = me.courses
    .flatMap((course) => course.slots.filter((s) => s.day === day).map((slot) => ({ course, slot })))
    .sort((a, b) => minutes(a.slot.start) - minutes(b.slot.start));
  if (day !== todayIndex(now)) return list.map((x) => ({ ...x, status: 'later' }));
  const t = now.getHours() * 60 + now.getMinutes();
  let nextGiven = false;
  return list.map((x) => {
    const [s, e] = [minutes(x.slot.start), minutes(x.slot.end)];
    let status = 'later';
    if (e <= t) status = 'done';
    else if (s <= t) status = 'now';
    else if (!nextGiven) {
      status = 'next';
      nextGiven = true;
    }
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
