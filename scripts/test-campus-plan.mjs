import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { readPlan, writePlan } from '../src/js/campus-store.js';
globalThis.indexedDB = new IDBFactory();
import { normalizePlan, parseWeeks, dateOf, addDays, weekStart, occurrences, occurrenceId, conflicts, calendarICS } from '../src/js/campus-plan.js';
import { importMe, readyMe, loadMe, loadStorage, saveMe, classesOn, todayIndex, toggleVisited, quests } from '../src/js/quests.js';

const course = (id = 'calc', extra = {}) => ({ id, name: '高等数学', courseId: 'MATH101', room: '101', building: { campus: 'xyl', osm: 'way/123', name: '教学楼', center: [116.35, 40.01] }, slots: [{ day: 1, start: '08:00', end: '09:40' }], ...extra });
const event = (id = 'meeting', extra = {}) => ({ id, title: '社团活动', kind: 'activity', date: '2026-09-10', start: '12:00', end: '13:00', ...extra });
const plan = (extra = {}) => normalizePlan({ version: 1, term: { label: '2026 秋', starts: '2026-09-07', weeks: 4 }, courses: [], ...extra });
const legacy = () => ({ version: 1, profile: { faculty: '地球科学与测绘工程学院', major: '地质工程', year: '2026', campus: 'shahe' }, courses: [course('c'.repeat(40))], visited: { xyl: ['way/123', 'node/456'], shahe: ['way/999'] }, updated: '2026-10-06T12:20:00.000Z' });
const dates = (list) => list.map((x) => x.date);
const unfolded = (ics) => ics.replace(/\r\n[ \t]/g, '');
const fields = (ics, name) => unfolded(ics).split('\r\n').filter((line) => line.startsWith(`${name}:`)).map((line) => line.slice(name.length + 1));
const blocks = (ics) => unfolded(ics).split(/^BEGIN:VEVENT\r\n/m).slice(1).map((chunk) => chunk.split(/^END:VEVENT\r\n/m)[0]);

// Independent, minimal RFC TEXT decoder for exported field round trips.
function decodeText(text) { return text.replace(/\\([\\,;nN])/g, (_, ch) => /[nN]/.test(ch) ? '\n' : ch); }

function fakeStorage(initial = null) {
  let value = initial;
  let writes = 0;
  return { getItem(key) { assert.equal(key, 'luokixi.campus.me'); return value; }, setItem(key, next) { assert.equal(key, 'luokixi.campus.me'); writes += 1; value = next; }, get writes() { return writes; }, get value() { return value; } };
}

test('legacy V1 import preserves profile, 40-character IDs, buildings, visited and timestamp', () => {
  const raw = legacy();
  const snapshot = structuredClone(raw);
  const normalized = importMe(raw);
  assert.deepEqual(raw, snapshot, 'normalization must not mutate its input');
  assert.deepEqual(normalized.profile, raw.profile);
  assert.deepEqual(normalized.visited, raw.visited);
  assert.deepEqual(normalized.courses[0].building, raw.courses[0].building);
  assert.equal(normalized.courses[0].id, raw.courses[0].id);
  assert.equal(normalized.courses[0].slots[0].id, 'slot-0');
  for (const key of ['name', 'courseId', 'room']) assert.equal(normalized.courses[0][key], raw.courses[0][key]);
  assert.equal(normalized.updated, raw.updated);
  assert.deepEqual(normalized.term, { label: '', starts: '', weeks: 20 });
  assert.deepEqual(normalized.events, []);
  assert.equal(normalized.courses[0].weeks, undefined);
  assert.deepEqual(normalizePlan(normalized), normalized, 'normalization is idempotent');
  assert.deepEqual(normalizePlan({ visited: { xyl: ['way/1', 'way/1'] } }).visited, { xyl: ['way/1', 'way/1'] }, 'old visited arrays are preserved');
});

test('loadStorage and loadMe upgrade defaults without writing any real or injected storage', () => {
  const storage = fakeStorage(JSON.stringify(legacy()));
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
  try {
    assert.equal(loadStorage(storage).courses.length, 1);
    assert.throws(() => loadMe(), /readyMe/);
    assert.equal(storage.writes, 0);
    const corrupted = fakeStorage('{bad json');
    assert.deepEqual(loadStorage(corrupted), normalizePlan());
    assert.equal(corrupted.value, '{bad json');
    assert.equal(corrupted.writes, 0);
    const invalid = fakeStorage(JSON.stringify({ ...legacy(), term: { starts: '2026-09-08' } }));
    assert.deepEqual(loadStorage(invalid), normalizePlan());
    assert.equal(invalid.writes, 0);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete globalThis.localStorage;
  }
});

test('saveMe and JSON import retain every planner extension while preserving old map progress', async () => {
  const p = plan({ ...legacy(), term: { label: '秋季学期', starts: '2026-09-07', weeks: 4 }, courses: [course('math', { weeks: [1, 3], weekMode: 'odd', teacher: '李老师', color: '#0894ff', hidden: false })], events: [event('weekly', { repeat: 'weekly', until: '2026-09-24', notes: '带笔记本', color: '#ff9004' })], hiddenOccurrences: ['event:weekly:2026-09-17'], settings: { view: 'day', hideWeekend: true, showCourses: false, showEvents: true, compact: true, reminderMinutes: 20 } });
  const storage = fakeStorage();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
  try {
    const initial = await readyMe();
    assert.equal(await saveMe(p, initial.revision), true);
    assert.equal(storage.writes, 0);
    const restored = importMe((await readPlan()).data);
    assert.deepEqual(restored, p);
    assert.equal(restored.courses[0].teacher, '李老师');
    assert.deepEqual(restored.courses[0].weeks, [1, 3]);
    assert.deepEqual(restored.hiddenOccurrences, ['event:weekly:2026-09-17']);
    assert.deepEqual(restored.profile, legacy().profile);
    assert.deepEqual(restored.visited, legacy().visited);
    assert.notEqual(restored.updated, legacy().updated);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete globalThis.localStorage;
  }
});

test('week parsing supports ranges and Chinese notation without quietly correcting invalid input', () => {
  assert.deepEqual(parseWeeks('第1–3周，5、7-8周', 8), [1, 2, 3, 5, 7, 8]);
  assert.deepEqual(parseWeeks('3,1,1-2', 4), [1, 2, 3]);
  assert.equal(parseWeeks('  '), undefined);
  for (const value of ['0', '1-5', '3-1', '1,,2', '1.5', '1e2', '一', '1-', '第周', '第1周2周', '周1']) assert.throws(() => parseWeeks(value, 4), /上课周次/);
  assert.throws(() => parseWeeks('1', 31), /学期周数/);
});

test('Shanghai dates and week starts handle UTC midnight, years and leap days independently of host timezone', () => {
  assert.equal(dateOf(new Date('2026-10-06T15:59:59Z')), '2026-10-06');
  assert.equal(dateOf(new Date('2026-10-06T16:00:00Z')), '2026-10-07');
  assert.equal(todayIndex(new Date('2026-10-06T16:00:00Z')), 3);
  assert.equal(dateOf(new Date('2026-12-31T16:00:00Z')), '2027-01-01');
  assert.equal(weekStart('2026-10-04'), '2026-09-28');
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(addDays('2024-03-01', -1), '2024-02-29');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.throws(() => addDays('2026-02-30', 1), /日期不存在/);
  assert.throws(() => dateOf(new Date('invalid')), /有效 Date/);
  assert.throws(() => addDays('2026-01-01', 0.5), /整数/);
});

test('courses honor teaching weeks, odd/even filters and inclusive semester bounds', () => {
  const p = plan({ courses: [course('all'), course('odd', { weekMode: 'odd' }), course('even', { weekMode: 'even' }), course('selected', { weeks: [4, 1] }), course('intersection', { weeks: [1, 2, 3], weekMode: 'even' }), course('sunday', { slots: [{ id: 'sunday', day: 7, start: '17:00', end: '18:00' }] })] });
  const all = occurrences(p, '2026-09-01', '2026-10-10');
  const bySource = (id) => dates(all.filter((x) => x.sourceId === id));
  assert.deepEqual(bySource('all'), ['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28']);
  assert.deepEqual(bySource('odd'), ['2026-09-07', '2026-09-21']);
  assert.deepEqual(bySource('even'), ['2026-09-14', '2026-09-28']);
  assert.deepEqual(bySource('selected'), ['2026-09-07', '2026-09-28']);
  assert.deepEqual(bySource('intersection'), ['2026-09-14']);
  assert.deepEqual(bySource('sunday'), ['2026-09-13', '2026-09-20', '2026-09-27', '2026-10-04']);
  assert.equal(all.every((x) => x.date >= '2026-09-07' && x.date <= '2026-10-04'), true);
  assert.equal(occurrences(p, '2026-10-04', '2026-10-04').length, 1);
  assert.equal(occurrences(p, '2026-10-05', '2026-10-12').length, 0);
  assert.equal(all.find((x) => x.sourceId === 'all').location, '教学楼 · 101');
});

test('events repeat on their anchored weekday until the inclusive limit, without inventing a term', () => {
  const p = normalizePlan({ events: [event('weekly', { repeat: 'weekly', until: '2026-09-24' }), event('once', { date: '2026-09-17' })], courses: [course()] });
  assert.deepEqual(dates(occurrences(p, '2026-09-01', '2026-09-30').filter((x) => x.sourceId === 'weekly')), ['2026-09-10', '2026-09-17', '2026-09-24']);
  assert.deepEqual(dates(occurrences(p, '2026-09-11', '2026-09-24').filter((x) => x.sourceId === 'weekly')), ['2026-09-17', '2026-09-24']);
  assert.equal(occurrences(p, '2026-09-01', '2026-09-30').some((x) => x.source === 'course'), false);
  assert.equal(occurrences(p, '2026-09-25', '2026-09-30').length, 0);
  assert.throws(() => occurrences(p, '2026-09-30', '2026-09-01'), /截止日期/);
});

test('single-occurrence hide and restore retains stable IDs while leaving the other dates intact', () => {
  const p = plan({ courses: [course('math')], events: [event('weekly', { repeat: 'weekly', until: '2026-09-24' })] });
  const original = occurrences(p, '2026-09-01', '2026-10-04');
  const ids = [occurrenceId('course', 'math', '2026-09-14', 'slot-0'), occurrenceId('event', 'weekly', '2026-09-17')];
  p.hiddenOccurrences = ids;
  const visible = occurrences(p, '2026-09-01', '2026-10-04');
  assert.equal(visible.length, original.length - 2);
  assert.equal(visible.some((x) => ids.includes(x.id)), false);
  assert.deepEqual(occurrences(p, '2026-09-01', '2026-10-04', { includeHidden: true }).filter((x) => x.hidden).map((x) => x.id).sort(), [...ids].sort());
  p.hiddenOccurrences = [];
  assert.deepEqual(occurrences(p, '2026-09-01', '2026-10-04').map((x) => x.id), original.map((x) => x.id));
  p.courses[0].hidden = true;
  assert.equal(occurrences(p, '2026-09-01', '2026-10-04').some((x) => x.source === 'course'), false);
  assert.equal(occurrences(p, '2026-09-01', '2026-10-04', { includeHidden: true }).filter((x) => x.source === 'course').length, 4);
  p.courses[0].hidden = false;
  p.courses[0].cancelled = true;
  assert.equal(occurrences(p, '2026-09-01', '2026-10-04', { includeHidden: true }).some((x) => x.source === 'course'), false);
});

test('explicit slot IDs survive reordering and encoded legacy IDs remain safe and unique', () => {
  const p = plan({ courses: [course('数学:甲', { slots: [{ id: '早课:一', day: 1, start: '08:00', end: '09:00' }, { id: '晚课:二', day: 1, start: '18:00', end: '19:00' }] })], events: [event('数学:甲', { date: '2026-09-07', start: '08:00', end: '09:00' })] });
  const before = occurrences(p, '2026-09-07', '2026-09-07').map((x) => x.id);
  p.courses[0].slots.reverse();
  assert.deepEqual(occurrences(p, '2026-09-07', '2026-09-07').map((x) => x.id), before);
  assert.equal(new Set(before).size, 3);
  assert.equal(before.some((x) => x.startsWith('course:%E6%95%B0')), true);
  const longId = '课'.repeat(40);
  assert.doesNotThrow(() => normalizePlan({ hiddenOccurrences: [occurrenceId('course', longId, '2026-09-07', longId)] }));
});

test('conflicts report actual overlaps and ignore touching boundaries, hidden items and other dates', () => {
  const items = [event('a', { date: '2026-09-10', start: '08:00', end: '09:00' }), event('b', { date: '2026-09-10', start: '09:00', end: '10:00' }), event('c', { date: '2026-09-10', start: '08:30', end: '09:30' }), event('d', { date: '2026-09-11', start: '08:00', end: '09:00' }), event('hidden', { date: '2026-09-10', start: '08:10', end: '08:20', hidden: true })].map((e) => ({ ...e, title: e.title }));
  const found = conflicts(items);
  assert.equal(found.length, 2);
  assert.deepEqual(found.map((x) => new Set(x.ids)), [new Set(['a', 'c']), new Set(['c', 'b'])]);
  assert.deepEqual(found.map(({ start, end }) => [start, end]), [['08:30', '09:00'], ['09:00', '09:30']]);
  assert.deepEqual(conflicts([]), []);
});

test('classesOn keeps old status behavior, original references, Shanghai hours and actual week filters', () => {
  const p = plan({ courses: [course('done', { slots: [{ day: 1, start: '08:00', end: '09:00' }] }), course('active', { slots: [{ day: 1, start: '09:00', end: '10:00' }] }), course('future', { slots: [{ day: 1, start: '11:00', end: '12:00' }] }), course('odd', { weekMode: 'odd', slots: [{ day: 1, start: '13:00', end: '14:00' }] }), course('selected', { weeks: [1] })] });
  const now = new Date('2026-09-14T01:30:00Z'); // Shanghai Monday, week 2, 09:30.
  const list = classesOn(p, 1, now);
  assert.deepEqual(list.map((x) => [x.course.id, x.status]), [['done', 'done'], ['active', 'now'], ['future', 'later']]);
  assert.equal(list[0].course, p.courses[0]);
  assert.equal(list[0].slot, p.courses[0].slots[0]);
  assert.equal(classesOn(p, 1, new Date('2026-09-14T02:30:00Z')).find((x) => x.course.id === 'future').status, 'next');
  assert.equal(classesOn(p, 1, new Date('2026-09-15T01:30:00Z')).every((x) => x.status === 'later'), true);
  p.hiddenOccurrences.push(occurrenceId('course', 'future', '2026-09-14', 'slot-0'));
  assert.equal(classesOn(p, 1, now).some((x) => x.course.id === 'future'), false);
  assert.deepEqual(classesOn(p, 1, new Date('2026-10-05T01:30:00Z')), []);
  const old = legacy();
  assert.equal(classesOn(old, 1, new Date('2026-10-05T00:30:00Z'))[0].status, 'now', 'unset semesters preserve old repeating map view');
});

test('old visit toggles and exploration tasks continue to work after planner normalization', () => {
  const p = importMe(legacy());
  const b = { properties: { osm: 'way/123', name: '教学楼', use: 'teaching' } };
  assert.equal(quests(p, 'xyl', '学院路', [b]).find((q) => q.id === 'my-courses').done, 1);
  assert.equal(toggleVisited(p, 'xyl', 'way/123'), false);
  assert.equal(quests(p, 'xyl', '学院路', [b]).find((q) => q.id === 'my-courses').done, 0);
  assert.equal(toggleVisited(p, 'xyl', 'way/123'), true);
});

test('ICS clips courses to the term, retains personal events outside it and excludes hidden or cancelled instances', () => {
  const p = plan({ courses: [course('odd', { weekMode: 'odd' }), course('even', { weekMode: 'even' }), course('hidden', { hidden: true }), course('cancelled', { cancelled: true }), course('selected', { weeks: [4] })], events: [event('before', { date: '2026-09-06' }), event('after', { date: '2026-10-05' }), event('weekly', { date: '2026-09-03', repeat: 'weekly', until: '2026-10-08' }), event('cancelled-event', { date: '2026-09-10', cancelled: true })], hiddenOccurrences: [occurrenceId('course', 'odd', '2026-09-21', 'slot-0'), occurrenceId('event', 'weekly', '2026-09-17')], settings: { showCourses: false, showEvents: false, hideWeekend: true } });
  const ics = calendarICS(p);
  assert.equal(blocks(ics).length, 11); // 4 courses plus all 7 visible personal events, including outside the term.
  assert.equal(fields(ics, 'SUMMARY').filter((v) => v === '高等数学').length, 4);
  assert.equal(fields(ics, 'SUMMARY').filter((v) => v === '社团活动').length, 7);
  for (const block of blocks(ics)) {
    const utc = /^DTSTART:(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/m.exec(block);
    assert.ok(utc);
    const utcIso = `${utc[1]}-${utc[2]}-${utc[3]}T${utc[4]}:${utc[5]}:${utc[6]}Z`;
    const shanghaiDate = dateOf(new Date(utcIso));
    if (block.includes('SUMMARY:高等数学')) assert.ok(shanghaiDate >= '2026-09-07' && shanghaiDate <= '2026-10-04');
  }
  assert.equal(fields(ics, 'DTSTART').includes('20260907T000000Z'), true);
  assert.equal(fields(ics, 'DTEND').includes('20260907T014000Z'), true);
  assert.equal(fields(ics, 'UID').length, new Set(fields(ics, 'UID')).size);
  assert.equal(calendarICS(p), ics, 'unchanged data has stable export identities and timestamps');
});

test('ICS handles early Shanghai time as the previous UTC date and exports events without a fictitious term', () => {
  const p = normalizePlan({ events: [event('early', { date: '2026-10-07', start: '00:01', end: '00:10' })] });
  const ics = calendarICS(p);
  assert.deepEqual(fields(ics, 'DTSTART'), ['20261006T160100Z']);
  assert.deepEqual(fields(ics, 'DTEND'), ['20261006T161000Z']);
  assert.equal(blocks(ics).length, 1);
  assert.throws(() => calendarICS(normalizePlan({ courses: [course()] })), /先设置学期开始日期/);
  assert.doesNotThrow(() => calendarICS(normalizePlan({ courses: [course('hidden', { hidden: true })], events: [event()] })));
  assert.equal(blocks(calendarICS(normalizePlan())).length, 0);
});

test('ICS folds Chinese by UTF-8 bytes, preserves complete characters, escapes TEXT and prevents property injection', () => {
  const title = `${'中文🌏'.repeat(30)};逗号,反斜杠\\\r\nBEGIN:VEVENT`;
  const notes = '首行\r\nDTSTART:20990101T000000Z\n末行;注释,路径\\';
  const p = normalizePlan({ events: [event('safe', { title, notes, location: '教学楼;A,1\\门' })], settings: { reminderMinutes: 15 } });
  const ics = calendarICS(p);
  assert.equal(/(?<!\r)\n|\r(?!\n)/.test(ics), false, 'only CRLF line endings');
  for (const line of ics.split('\r\n').filter(Boolean)) assert.ok(Buffer.byteLength(line, 'utf8') <= 75, `overlong physical line: ${line}`);
  assert.equal(ics.includes('\ufffd'), false, 'UTF-8 characters never split');
  assert.equal(decodeText(fields(ics, 'SUMMARY')[0]), title.replace(/\r\n/g, '\n'));
  const descriptions = fields(ics, 'DESCRIPTION');
  assert.equal(decodeText(descriptions[0]), notes.replace(/\r\n/g, '\n'));
  assert.equal(blocks(ics).length, 1, 'text cannot inject a VEVENT');
  assert.equal(fields(ics, 'DTSTART').length, 1, 'notes cannot inject a DTSTART');
  assert.deepEqual(fields(ics, 'TRIGGER'), ['-PT15M']);
  assert.equal(fields(calendarICS(p, { reminderMinutes: 0 }), 'TRIGGER').length, 0);
  assert.throws(() => calendarICS(p, { reminderMinutes: 121 }), /提醒分钟数/);
});

test('normalization rejects invalid imports rather than truncating or silently correcting them', () => {
  const invalid = [
    [{ version: 2 }, /version/],
    [{ term: { starts: '2026-09-08' } }, /周一.*2026-09-07/],
    [{ term: { starts: '2026-02-30' } }, /日期不存在/],
    [{ term: { weeks: 31 } }, /学期周数/],
    [{ courses: [course('same'), course('same')] }, /重复/],
    [{ courses: Array.from({ length: 61 }, (_, i) => course(`c${i}`)) }, /最多 60/],
    [{ courses: [course('bad-time', { slots: [{ day: 1, start: '25:00', end: '26:00' }] })] }, /时间需为/],
    [{ courses: [course('bad-minute', { slots: [{ day: 1, start: '08:60', end: '09:00' }] })] }, /时间需为/],
    [{ courses: [course('bad-range', { slots: [{ day: 1, start: '10:00', end: '09:00' }] })] }, /结束时间/],
    [{ courses: [course('zero-range', { slots: [{ day: 1, start: '09:00', end: '09:00' }] })] }, /结束时间/],
    [{ courses: [course('bad-day', { slots: [{ day: 8, start: '08:00', end: '09:00' }] })] }, /星期/],
    [{ courses: [course('duplicate-slot', { slots: [{ id: 'same', day: 1, start: '08:00', end: '09:00' }, { id: 'same', day: 2, start: '08:00', end: '09:00' }] })] }, /重复/],
    [{ courses: [course('bad-weeks', { weeks: [] })] }, /空列表/],
    [{ courses: [course('duplicate-weeks', { weeks: [1, 1] })] }, /重复/],
    [{ term: { weeks: 4 }, courses: [course('outside-weeks', { weeks: [5] })] }, /周次/],
    [{ courses: [course('too-long-name', { name: '中'.repeat(81) })] }, /最多 80/],
    [{ courses: [course('x'.repeat(41))] }, /最多 40/],
    [{ courses: [course('bad-coordinate', { building: { osm: 'way/1', center: [180.1, 35] } })] }, /坐标/],
    [{ events: [event('same'), event('same')] }, /重复/],
    [{ events: Array.from({ length: 501 }, (_, i) => event(`e${i}`)) }, /最多 500/],
    [{ events: [event('weekly', { repeat: 'weekly' })] }, /截止日期/],
    [{ events: [event('weekly', { repeat: 'weekly', until: '2026-09-09' })] }, /截止日期/],
    [{ events: [event('weekly', { repeat: 'weekly', until: '2029-09-09' })] }, /两年/],
    [{ events: [event('bad-color', { color: 'red' })] }, /颜色/],
    [{ events: [event('bad-kind', { kind: 'official' })] }, /类型/],
    [{ hiddenOccurrences: ['not-an-occurrence'] }, /编号格式/],
    [{ hiddenOccurrences: ['event:a:2026-09-10', 'event:a:2026-09-10'] }, /重复/],
    [{ hiddenOccurrences: ['event:%ZZ:2026-09-10'] }, /编码/],
    [{ hiddenOccurrences: ['event:a:2026-02-30'] }, /日期不存在/],
    [{ visited: { xyl: Array(501).fill('way/1') } }, /最多 500/],
    [{ settings: { reminderMinutes: -1 } }, /提醒分钟数/],
    [{ settings: { showCourses: 'false' } }, /开关值/],
    [{ updated: 'invalid' }, /保存时间/],
    [{ updated: '2026-02-30T12:00:00Z' }, /日期不存在/],
    [{ term: { starts: '0000-01-03' } }, /日期不存在/],
    [{ courses: [course(String.fromCharCode(0xD800))] }, /Unicode/],
  ];
  for (const [raw, error] of invalid) assert.throws(() => normalizePlan(raw), error, JSON.stringify(raw).slice(0, 120));
  assert.throws(() => importMe({ courses: [] }), /不是校园地图/);
});

test('campus center extensions survive normalization, JSON, occurrences and ICS', () => {
  const b = { campus: 'shahe', osm: 'way/1', name: '图书馆', center: [116.2, 40.1] };
  const p = plan({ courses: [course('rich', { notes: '课程笔记\n第二行', tags: ['数学', '课程'], priority: 'high', floor: '一楼', reminderMinutes: 0 })], events: [event('deadline', { kind: 'deadline', courseId: 'MATH101', building: b, participants: '同组同学', tags: ['作业,一期', '截止'], priority: 'high', floor: '三楼', reminderMinutes: 30, sourceURL: 'https://example.com/source', registrationURL: 'https://example.com/register', projectURL: 'https://example.com/project' }), event('inherit', { date: '2026-09-11', kind: 'meeting' })], favorites: [b], routePrefs: { shahe: { start: 'way/1', via: ['place:gate', 'way/2'] } }, settings: { view: 'timeline', reminderMinutes: 15 } });
  assert.deepEqual(normalizePlan(JSON.parse(JSON.stringify(p))), p);
  assert.equal(p.events[1].reminderMinutes, undefined, 'missing item reminders retain global inheritance');
  const expanded = occurrences(p, '2026-09-07', '2026-09-14');
  const deadline = expanded.find((x) => x.sourceId === 'deadline');
  assert.deepEqual(deadline.building, b);
  assert.equal(deadline.floor, '三楼');
  assert.equal(deadline.participants, '同组同学');
  assert.equal(expanded.find((x) => x.sourceId === 'rich').notes, '课程笔记\n第二行');
  const ics = calendarICS(p);
  assert.equal(fields(ics, 'DESCRIPTION').some((v) => decodeText(v).includes('课程笔记\n第二行')), true);
  assert.equal(fields(ics, 'CATEGORIES').some((v) => v === '作业\\,一期,截止'), true);
  assert.deepEqual(fields(ics, 'TRIGGER').sort(), ['-PT15M', '-PT30M']);
  assert.equal(fields(ics, 'PRIORITY').includes('1'), true);
  assert.deepEqual(fields(ics, 'URL'), ['https://example.com/source']);
  for (const view of ['week', 'day', 'timeline', 'cards', 'map']) assert.equal(normalizePlan({ settings: { view } }).settings.view, view);
  for (const kind of ['personal', 'exam', 'activity', 'deadline', 'club', 'competition', 'meeting']) assert.equal(normalizePlan({ events: [event('kind', { kind })] }).events[0].kind, kind);
});

test('extended fields reject overlong, duplicate, malformed or unsafe imports', () => {
  const invalid = [
    [{ courses: [course('tags', { tags: Array(11).fill('tag') })] }, /最多 10/],
    [{ courses: [course('duplicate-tags', { tags: ['数学', '数学'] })] }, /重复/],
    [{ courses: [course('long-tag', { tags: ['字'.repeat(31)] })] }, /最多 30/],
    [{ courses: [course('long-notes', { notes: '字'.repeat(4001) })] }, /最多 4000/],
    [{ courses: [course('bad-priority', { priority: 'critical' })] }, /优先级/],
    [{ courses: [course('bad-reminder', { reminderMinutes: 121 })] }, /提醒分钟数/],
    [{ courses: [course('bad-floor', { floor: '楼'.repeat(31) })] }, /最多 30/],
    [{ events: [event('url', { sourceURL: 'javascript:alert(1)' })] }, /http/],
    [{ events: [event('url', { sourceURL: 'data:text/html,test' })] }, /http/],
    [{ events: [event('url', { registrationURL: 'https://user:password@example.com' })] }, /账号密码/],
    [{ events: [event('url', { projectURL: 'https://example.com\nBEGIN:VEVENT' })] }, /http/],
    [{ events: [event('participants', { participants: '人'.repeat(401) })] }, /最多 400/],
    [{ favorites: Array.from({ length: 201 }, (_, i) => ({ osm: `way/${i}` })) }, /最多 200/],
    [{ favorites: [{ osm: 'way/1' }, { osm: 'way/1' }] }, /重复/],
    [{ favorites: [null] }, /楼宇/],
    [{ routePrefs: { shahe: { via: Array(11).fill('way/1') } } }, /最多 10/],
    [{ routePrefs: { shahe: { via: ['way/1', 'way/1'] } } }, /重复/],
  ];
  for (const [raw, error] of invalid) assert.throws(() => normalizePlan(raw), error);
});

test('legacy saveMe refuses stale cached objects and complete imports without a read revision', async () => {
  await readyMe();
  const retained = loadMe();
  const before = await readPlan();
  const newer = normalizePlan(before.data);
  newer.profile.major = '另一个页面更新';
  await writePlan(newer, before.revision);
  retained.profile.major = '旧编辑覆盖';
  await assert.rejects(saveMe(retained), (error) => error.code === 'conflict');
  assert.equal((await readPlan()).data.profile.major, '另一个页面更新');
  await saveMe((latest) => { latest.profile.year = '2027'; });
  const afterPatch = await readPlan();
  assert.equal(afterPatch.data.profile.major, '另一个页面更新');
  assert.equal(afterPatch.data.profile.year, '2027');
  await assert.rejects(saveMe(importMe(legacy())), (error) => error.code === 'revision_required');
  await saveMe(importMe(legacy()), afterPatch.revision);
  assert.equal((await readPlan()).data.profile.major, legacy().profile.major);
});

test('corrupt cached plans reject ordinary map edits until an explicit full replacement is confirmed', async () => {
  const before = await readPlan();
  const broken = { version: 1, courses: [{ id: 'bad', name: '损坏课表', slots: [{ day: 1, start: '08:99', end: '09:00' }] }] };
  const db = await new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open('luokixi-campus-plan', 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise((resolve, reject) => {
    const tx = db.transaction('plans', 'readwrite');
    tx.objectStore('plans').put({ revision: before.revision + 1, data: broken }, 'current');
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error);
  });
  db.close();
  const corrupt = await readyMe();
  assert.equal(corrupt.corrupt, true);
  assert.deepEqual(corrupt.raw, broken);
  await assert.rejects(saveMe(loadMe()), (error) => error.code === 'corrupt');
  await assert.rejects(saveMe((latest) => { latest.profile.major = '普通编辑'; }), (error) => error.code === 'corrupt');
  assert.deepEqual((await readPlan()).raw, broken);
  await saveMe(importMe(legacy()), corrupt.revision);
  assert.equal((await readPlan()).corrupt, undefined);
});
