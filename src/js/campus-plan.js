// Local campus planner. This module has no storage, network, or account side effects.
// Dates describe the Asia/Shanghai civil calendar; times never depend on the device timezone.

export const PLAN_LIMITS = Object.freeze({ courses: 60, slots: 14, events: 500, hiddenOccurrences: 10000, weeks: 30 });
const DAY_MS = 86400000;
const SHANGHAI_MS = 8 * 60 * 60 * 1000;
const DEFAULT_SETTINGS = Object.freeze({ view: 'week', hideWeekend: false, showCourses: true, showEvents: true, compact: false, reminderMinutes: 0 });
const CONTROL = /[\u0000-\u001f\u007f]/;
const encoder = new TextEncoder();

function fail(field, message) { throw new Error(`${field}：${message}`); }
function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(field, '需要一个对象。');
  return value;
}
function string(value, fallback, field, max, required = false) {
  const out = value === undefined ? fallback : value;
  if (typeof out !== 'string') fail(field, '需要文字。');
  if ([...out].length > max) fail(field, `最多 ${max} 个字符，未截断原内容。`);
  if (required && !out.trim()) fail(field, '不能为空。');
  if (/\u0000/.test(out)) fail(field, '不能含空字符。');
  if (!out.isWellFormed()) fail(field, '文字包含不完整的 Unicode 字符。');
  return out;
}
function id(value, fallback, field) {
  const out = string(value, fallback, field, 40, true);
  if (CONTROL.test(out)) fail(field, '编号不能含控制字符。');
  return out;
}
function integer(value, fallback, field, min, max) {
  const out = value === undefined ? fallback : value;
  if (!Number.isInteger(out) || out < min || out > max) fail(field, `需要 ${min}–${max} 的整数。`);
  return out;
}
function boolean(value, fallback, field) {
  const out = value === undefined ? fallback : value;
  if (typeof out !== 'boolean') fail(field, '需要开关值。');
  return out;
}
function choice(value, fallback, field, values) {
  const out = value === undefined ? fallback : value;
  if (!values.includes(out)) fail(field, `只能是 ${values.join(' / ')}。`);
  return out;
}
function array(value, field, max) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(field, '需要列表。');
  if (value.length > max) fail(field, `最多 ${max} 项，未丢弃多出的内容。`);
  return value;
}
function unique(values, field, key = (v) => v) {
  const seen = new Set();
  for (const value of values) {
    const k = key(value);
    if (seen.has(k)) fail(field, `有重复编号或值：${k}`);
    seen.add(k);
  }
  return values;
}
function color(value, field) {
  const out = string(value, '', field, 7);
  if (out && !/^#[a-fA-F0-9]{6}$/.test(out)) fail(field, '颜色需为 #RRGGBB。');
  return out;
}
function tags(value, field) {
  return unique(array(value, field, 10).map((v) => string(v, undefined, field, 30, true)), field);
}
function webURL(value, field) {
  const out = string(value, '', field, 2000);
  if (!out) return '';
  let parsed;
  try { parsed = new URL(out); } catch { fail(field, '需要完整的 http(s) 链接。'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || CONTROL.test(out) || out.trim() !== out) fail(field, '只支持不带账号密码的 http(s) 链接。');
  return out;
}
function dateNumber(date, field = '日期') {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(field, '使用 YYYY-MM-DD。');
  const value = Date.parse(`${date}T00:00:00Z`);
  if (date.startsWith('0000-') || !Number.isFinite(value) || new Date(value).toISOString().slice(0, 10) !== date) fail(field, '日期不存在。');
  return value;
}
function dateString(value) {
  const out = new Date(value).toISOString().slice(0, 10);
  dateNumber(out);
  return out;
}
function time(value, field) {
  if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) fail(field, '时间需为 00:00–23:59 的 HH:mm。');
  return value;
}
function range(start, end, field) {
  time(start, `${field}开始时间`);
  time(end, `${field}结束时间`);
  if (end <= start) fail(field, '结束时间要晚于开始时间；跨日请拆成两项。');
}
const minutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const weekday = (date) => ((new Date(dateNumber(date)).getUTCDay() + 6) % 7) + 1;

export function dateOf(now = new Date()) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) fail('当前时间', '需要有效 Date。');
  return dateString(now.getTime() + SHANGHAI_MS);
}

export function addDays(date, offset) {
  if (!Number.isInteger(offset)) fail('日期偏移', '需要整数天数。');
  return dateString(dateNumber(date) + offset * DAY_MS);
}

export function weekStart(date) { return addDays(date, 1 - weekday(date)); }

// Accept 1,3,5-8, Chinese punctuation and the customary 第1-8周 spelling.
// Empty input means every teaching week, represented by an absent course.weeks field.
export function parseWeeks(text, max = PLAN_LIMITS.weeks) {
  integer(max, undefined, '学期周数', 1, PLAN_LIMITS.weeks);
  if (typeof text !== 'string') fail('上课周次', '需要文字。');
  if (!text.trim()) return undefined;
  const value = text.trim().replace(/[，、；;]/g, ',').replace(/[–—~～至]/g, '-').replace(/\s+/g, '');
  const parts = value.split(',');
  if (parts.some((part) => !/^(?:第)?\d+(?:-\d+)?(?:周)?$/.test(part))) fail('上课周次', '例如 1-8,10,12-16。');
  const weeks = new Set();
  for (const part of parts) {
    const [from, to = from] = part.replace(/^第|周$/g, '').split('-').map(Number);
    if (!Number.isInteger(from) || from < 1 || to < from || to > max) fail('上课周次', `需要递增且位于 1–${max} 周。`);
    for (let week = from; week <= to; week += 1) weeks.add(week);
  }
  return [...weeks].sort((a, b) => a - b);
}

function building(value, field) {
  if (value === undefined || value === null) return null;
  const b = object(value, field);
  let center = null;
  if (b.center !== undefined && b.center !== null) {
    if (!Array.isArray(b.center) || b.center.length !== 2 || b.center.some((n) => typeof n !== 'number' || !Number.isFinite(n)) || Math.abs(b.center[0]) > 180 || Math.abs(b.center[1]) > 90) fail(`${field}坐标`, '需要合法的 [经度, 纬度]。');
    center = [...b.center];
  }
  return { campus: string(b.campus, '', `${field}校区`, 20), osm: id(b.osm, undefined, `${field}OSM编号`), name: string(b.name, '', `${field}名称`, 80), center };
}
function hiddenId(value, field) {
  const out = string(value, undefined, field, 1100, true);
  const match = /^(?:course:([^:]+):([^:]+)|event:([^:]+)):(\d{4}-\d{2}-\d{2})$/.exec(out);
  if (!match) fail(field, '单次日程编号格式不正确。');
  dateNumber(match[4], field);
  for (const encoded of match.slice(1, 4).filter((v) => v !== undefined)) {
    let decoded;
    try { decoded = decodeURIComponent(encoded); } catch { fail(field, '单次日程编号编码不正确。'); }
    id(decoded, undefined, field);
    if (encodeURIComponent(decoded) !== encoded) fail(field, '单次日程编号编码不一致。');
  }
  return out;
}

// Strict schema validation: loading a legacy plan adds defaults without writing storage.
// Lists and strings are never silently truncated; invalid imports must be reviewable errors.
export function normalizePlan(raw = {}) {
  object(raw, '校园备份');
  if (raw.version !== undefined && raw.version !== 1) fail('校园备份', '只支持 version: 1。');
  const p = raw.profile === undefined ? {} : object(raw.profile, '个人资料');
  const t = raw.term === undefined ? {} : object(raw.term, '学期');
  const starts = string(t.starts, '', '学期开始日期', 10);
  if (starts) {
    dateNumber(starts, '学期开始日期');
    if (weekday(starts) !== 1) fail('学期开始日期', `应为周一；此日期所在周的周一是 ${weekStart(starts)}。`);
  }
  const term = { label: string(t.label, '', '学期名称', 120), starts, weeks: integer(t.weeks, 20, '学期周数', 1, PLAN_LIMITS.weeks) };
  const courses = unique(array(raw.courses, '课程', PLAN_LIMITS.courses).map((value, i) => {
    const field = `课程 ${i + 1}`;
    const c = object(value, field);
    const slots = unique(array(c.slots, `${field}时段`, PLAN_LIMITS.slots).map((value, j) => {
      const s = object(value, `${field}时段 ${j + 1}`);
      range(s.start, s.end, `${field}时段 ${j + 1}`);
      return { id: id(s.id, `slot-${j}`, `${field}时段编号`), day: integer(s.day, undefined, `${field}星期`, 1, 7), start: s.start, end: s.end };
    }), `${field}时段`, (s) => s.id);
    const out = { id: id(c.id, `course-${i}`, `${field}编号`), name: string(c.name, undefined, `${field}名称`, 80, true), courseId: string(c.courseId, '', `${field}课程号`, 60), room: string(c.room, '', `${field}教室`, 60), building: building(c.building, `${field}教学楼`), slots, weekMode: choice(c.weekMode, 'all', `${field}单双周`, ['all', 'odd', 'even']), teacher: string(c.teacher, '', `${field}教师`, 100), color: color(c.color, `${field}颜色`), hidden: boolean(c.hidden, false, `${field}隐藏`) };
    out.origin = choice(c.origin, 'manual', `${field}来源`, ['manual', 'school']);
    out.sourceURL = webURL(c.sourceURL, `${field}学校来源`);
    out.floor = string(c.floor, '', `${field}楼层`, 30);
    out.notes = string(c.notes, '', `${field}备注`, 4000);
    out.tags = tags(c.tags, `${field}标签`);
    out.priority = choice(c.priority, 'normal', `${field}优先级`, ['low', 'normal', 'high']);
    if (c.reminderMinutes !== undefined) out.reminderMinutes = integer(c.reminderMinutes, 0, `${field}提醒分钟数`, 0, 120);
    if (c.cancelled !== undefined) out.cancelled = boolean(c.cancelled, false, `${field}取消`);
    if (c.weeks !== undefined) {
      const weeks = array(c.weeks, `${field}周次`, PLAN_LIMITS.weeks);
      if (!weeks.length) fail(`${field}周次`, '留空表示全学期，请移除 weeks 字段；指定周次不能是空列表。');
      out.weeks = unique(weeks.map((w) => integer(w, undefined, `${field}周次`, 1, term.weeks)), `${field}周次`).sort((a, b) => a - b);
    }
    return out;
  }), '课程', (c) => c.id);
  const events = unique(array(raw.events, '个人日程', PLAN_LIMITS.events).map((value, i) => {
    const field = `日程 ${i + 1}`;
    const e = object(value, field);
    dateNumber(e.date, `${field}日期`);
    range(e.start, e.end, field);
    const repeat = choice(e.repeat, 'none', `${field}重复`, ['none', 'weekly']);
    const until = string(e.until, '', `${field}重复截止日期`, 10);
    if (until) dateNumber(until, `${field}重复截止日期`);
    if ((repeat === 'weekly' && !until) || (until && until < e.date)) fail(`${field}重复截止日期`, '每周日程需要不早于首次日期的截止日期。');
    if (until && (dateNumber(until) - dateNumber(e.date)) / DAY_MS > 730) fail(`${field}重复截止日期`, '重复范围最多两年（730 天）。');
    const out = { id: id(e.id, `event-${i}`, `${field}编号`), title: string(e.title, undefined, `${field}标题`, 160, true), kind: choice(e.kind, 'personal', `${field}类型`, ['personal', 'exam', 'activity', 'deadline', 'club', 'competition', 'meeting']), date: e.date, start: e.start, end: e.end, location: string(e.location, '', `${field}地点`, 160), notes: string(e.notes, '', `${field}备注`, 4000), repeat, until, color: color(e.color, `${field}颜色`), hidden: boolean(e.hidden, false, `${field}隐藏`) };
    out.unscheduled = boolean(e.unscheduled, false, `${field}待安排`);
    out.fixed = boolean(e.fixed, false, `${field}固定`);
    out.remindAtStart = boolean(e.remindAtStart, false, `${field}准点提醒`);
    out.floor = string(e.floor, '', `${field}楼层`, 30);
    out.courseId = string(e.courseId, '', `${field}关联课程号`, 60);
    out.building = building(e.building, `${field}地点楼宇`);
    out.participants = string(e.participants, '', `${field}参与人`, 400);
    out.tags = tags(e.tags, `${field}标签`);
    out.priority = choice(e.priority, 'normal', `${field}优先级`, ['low', 'normal', 'high']);
    if (e.reminderMinutes !== undefined) out.reminderMinutes = integer(e.reminderMinutes, 0, `${field}提醒分钟数`, 0, 120);
    for (const key of ['sourceURL', 'registrationURL', 'projectURL']) out[key] = webURL(e[key], `${field} ${key}`);
    if (e.cancelled !== undefined) out.cancelled = boolean(e.cancelled, false, `${field}取消`);
    return out;
  }), '个人日程', (e) => e.id);
  const visited = raw.visited === undefined ? {} : object(raw.visited, '到访记录');
  if (Object.keys(visited).length > 100) fail('到访记录', '最多 100 个校区。');
  const normalizedVisited = Object.fromEntries(Object.entries(visited).map(([campus, values]) => [string(campus, undefined, '到访校区', 20, true), array(values, '到访地点', 500).map((v) => string(v, undefined, '到访地点编号', 200, true))]));
  const favorites = unique(array(raw.favorites, '收藏地点', 200).map((b) => {
    if (b === null || b === undefined) fail('收藏地点', '收藏需要真实楼宇信息。');
    return building(b, '收藏地点');
  }), '收藏地点', (b) => `${b.campus}:${b.osm}`);
  const routePrefs = raw.routePrefs === undefined ? {} : object(raw.routePrefs, '路线偏好');
  if (Object.keys(routePrefs).length > 100) fail('路线偏好', '最多 100 个校区。');
  const normalizedRoutePrefs = Object.fromEntries(Object.entries(routePrefs).map(([campus, value]) => {
    const prefs = object(value, '路线偏好');
    return [string(campus, undefined, '路线校区', 20, true), { start: string(prefs.start, '', '常用路线起点', 200), via: unique(array(prefs.via, '常用路线途经点', 10).map((v) => string(v, undefined, '常用路线途经点', 200, true)), '常用路线途经点') }];
  }));
  const settings = raw.settings === undefined ? {} : object(raw.settings, '显示设置');
  const normalizedSettings = { view: choice(settings.view, DEFAULT_SETTINGS.view, '显示方式', ['week', 'day', 'timeline', 'cards', 'map']) };
  for (const key of ['hideWeekend', 'showCourses', 'showEvents', 'compact']) normalizedSettings[key] = boolean(settings[key], DEFAULT_SETTINGS[key], `显示设置 ${key}`);
  normalizedSettings.remindersEnabled = boolean(settings.remindersEnabled, false, '提醒开关');
  normalizedSettings.reminderMinutes = integer(settings.reminderMinutes, 0, '日历提醒分钟数', 0, 120);
  let updated = raw.updated === undefined ? null : raw.updated;
  if (updated !== null && (typeof updated !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(updated) || !Number.isFinite(Date.parse(updated)))) fail('保存时间', '需要有效 ISO 时间或 null。');
  if (updated !== null) dateNumber(updated.slice(0, 10), '保存时间');
  return { version: 1, profile: { faculty: string(p.faculty, '', '学院', 80), major: string(p.major, '', '专业', 80), year: string(p.year, '', '年级', 10), campus: string(p.campus, '', '校区', 20) }, courses, visited: normalizedVisited, favorites, routePrefs: normalizedRoutePrefs, updated, term, events, hiddenOccurrences: unique(array(raw.hiddenOccurrences, '已隐藏日程', PLAN_LIMITS.hiddenOccurrences).map((v) => hiddenId(v, '已隐藏日程编号')), '已隐藏日程'), settings: normalizedSettings };
}

export function occurrenceId(source, sourceId, date, slotId) {
  dateNumber(date);
  id(sourceId, undefined, '来源编号');
  if (source === 'course') return `course:${encodeURIComponent(sourceId)}:${encodeURIComponent(id(slotId, undefined, '时段编号'))}:${date}`;
  if (source === 'event') return `event:${encodeURIComponent(sourceId)}:${date}`;
  fail('日程来源', '只能是 course / event。');
}

function courseInWeek(course, week) {
  return week > 0 && (!course.weeks || course.weeks.includes(week)) && (course.weekMode === 'all' || (course.weekMode === 'odd' ? week % 2 === 1 : week % 2 === 0));
}

// Return all sources; display switches are presentation choices, not cancellations.
export function occurrences(rawPlan, fromDate, toDate, { includeHidden = false } = {}) {
  const plan = normalizePlan(rawPlan);
  const from = dateNumber(fromDate, '起始日期');
  const to = dateNumber(toDate, '截止日期');
  if (to < from) fail('查询日期', '截止日期不能早于起始日期。');
  const hidden = new Set(plan.hiddenOccurrences);
  const out = [];
  const append = (item, source) => {
    item.hidden = !!(source.hidden || hidden.has(item.id));
    if (!source.cancelled && (includeHidden || !item.hidden)) out.push(item);
  };
  if (plan.term.starts) {
    const termStart = dateNumber(plan.term.starts);
    for (let week = 1; week <= plan.term.weeks; week += 1) {
      for (const course of plan.courses) if (courseInWeek(course, week)) for (const slot of course.slots) {
        const cursor = termStart + ((week - 1) * 7 + slot.day - 1) * DAY_MS;
        if (cursor < from || cursor > to) continue;
        const date = dateString(cursor);
        append({ id: occurrenceId('course', course.id, date, slot.id), sourceId: course.id, source: 'course', date, start: slot.start, end: slot.end, title: course.name, kind: 'course', location: [course.building?.name, course.room].filter(Boolean).join(' · '), color: course.color, teacher: course.teacher, floor: course.floor, notes: course.notes, tags: course.tags, priority: course.priority, reminderMinutes: course.reminderMinutes, building: course.building, course, slot, week }, course);
      }
    }
  }
  for (const event of plan.events) {
    if (event.unscheduled) continue;
    const first = dateNumber(event.date);
    const last = event.repeat === 'weekly' ? Math.min(to, dateNumber(event.until)) : first;
    const step = 7 * DAY_MS;
    const start = event.repeat === 'weekly' ? first + Math.max(0, Math.ceil((from - first) / step)) * step : first;
    for (let cursor = start; cursor <= last && cursor <= to; cursor += step) {
      if (cursor < from) continue;
      const date = dateString(cursor);
      append({ id: occurrenceId('event', event.id, date), sourceId: event.id, source: 'event', date, start: event.start, end: event.end, title: event.title, kind: event.kind, location: event.location || event.building?.name || "", color: event.color, notes: event.notes, floor: event.floor, building: event.building, courseId: event.courseId, participants: event.participants, tags: event.tags, priority: event.priority, reminderMinutes: event.reminderMinutes, sourceURL: event.sourceURL, registrationURL: event.registrationURL, projectURL: event.projectURL, event }, event);
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start) || a.end.localeCompare(b.end) || a.id.localeCompare(b.id));
}
// Intervals are [start, end): a class ending when another starts is not a conflict.
export function conflicts(list) {
  if (!Array.isArray(list)) fail('冲突检查', '需要日程列表。');
  const active = list.filter((item) => !item.hidden && !item.cancelled).map((item) => {
    dateNumber(item.date, '冲突检查日期');
    range(item.start, item.end, '冲突检查');
    return item;
  }).sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
  const out = [];
  for (let i = 0; i < active.length; i += 1) {
    const a = active[i];
    for (let j = i + 1; j < active.length; j += 1) {
      const b = active[j];
      if (b.date !== a.date || b.start >= a.end) break;
      if (a.id !== b.id && a.start < b.end) out.push({ a, b, ids: [a.id, b.id], date: a.date, start: a.start > b.start ? a.start : b.start, end: a.end < b.end ? a.end : b.end });
    }
  }
  return out;
}

function icsText(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}
function fold(line) {
  const out = [];
  let part = '';
  let count = 0;
  for (const ch of line) {
    const size = encoder.encode(ch).length;
    if (count + size > 75) { out.push(part); part = ' '; count = 1; }
    part += ch;
    count += size;
  }
  out.push(part);
  return out.join('\r\n');
}
function utcStamp(date, hhmm) {
  return new Date(dateNumber(date) + minutes(hhmm) * 60000 - SHANGHAI_MS).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}
function savedStamp(updated) {
  return updated ? new Date(updated).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '') : '19700101T000000Z';
}

// Materialize each actual occurrence instead of exporting unbounded RRULEs.
// UTF-8 byte folding, TEXT escaping, stable UIDs and UTC times follow RFC 5545.
export function calendarICS(rawPlan, { reminderMinutes } = {}) {
  const plan = normalizePlan(rawPlan);
  const reminder = integer(reminderMinutes, plan.settings.reminderMinutes, '日历提醒分钟数', 0, 120);
  if (!plan.term.starts && plan.courses.some((c) => !c.hidden && !c.cancelled && c.slots.length)) fail('导出日历', '请先设置学期开始日期，再导出课程日历。');
  const starts = [plan.term.starts, ...plan.events.map((e) => e.date)].filter(Boolean);
  const ends = [plan.term.starts ? addDays(plan.term.starts, plan.term.weeks * 7 - 1) : '', ...plan.events.map((e) => e.repeat === 'weekly' ? e.until : e.date)].filter(Boolean);
  const from = starts.sort()[0];
  const to = ends.sort().at(-1);
  const list = from ? occurrences(plan, from, to) : [];
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Luokixi//Campus Planner//ZH', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${icsText(plan.term.label || '校园日程')}`, 'X-WR-TIMEZONE:Asia/Shanghai'];
  for (const item of list) {
    const description = [item.source === 'course' && item.teacher ? `教师：${item.teacher}` : '', item.notes || ''].filter(Boolean).join('\n');
    lines.push('BEGIN:VEVENT', `UID:${encodeURIComponent(item.id)}@planner.luokixi.local`, `DTSTAMP:${savedStamp(plan.updated)}`, `DTSTART:${utcStamp(item.date, item.start)}`, `DTEND:${utcStamp(item.date, item.end)}`, `SUMMARY:${icsText(item.title)}`);
    if (item.location) lines.push(`LOCATION:${icsText(item.location)}`);
    if (description) lines.push(`DESCRIPTION:${icsText(description)}`);
    lines.push('STATUS:CONFIRMED');
    const eventReminder = reminderMinutes === undefined ? (item.reminderMinutes ?? reminder) : reminder;
    if (item.tags.length) lines.push(`CATEGORIES:${item.tags.map(icsText).join(',')}`);
    if (item.sourceURL) lines.push(`URL:${item.sourceURL}`);
    if (item.priority !== 'normal') lines.push(`PRIORITY:${item.priority === 'high' ? 1 : 9}`);
    if (item.event?.remindAtStart) lines.push('BEGIN:VALARM', 'TRIGGER:PT0S', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(item.title)}`, 'END:VALARM');
    else if (eventReminder > 0) lines.push('BEGIN:VALARM', `TRIGGER:-PT${eventReminder}M`, 'ACTION:DISPLAY', `DESCRIPTION:${icsText(item.title)}`, 'END:VALARM');
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}
