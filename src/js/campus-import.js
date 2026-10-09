// Pure local import preview. No storage, network, calendar account, or AI calls.
import { Unzip, UnzipInflate } from 'fflate';
import { normalizePlan, parseWeeks, addDays, weekStart } from './campus-plan.js';

export const IMPORT_LIMITS = Object.freeze({ fileBytes: 5 * 1024 * 1024, expandedBytes: 16 * 1024 * 1024, entryBytes: 4 * 1024 * 1024, zipEntries: 128, rows: 2000, columns: 64, cells: 20000 });
const encoder = new TextEncoder();
const credentials = /pass(?:word|wd)?$|^pwd$|secret|token|cookie|sessionid|credential|密码|口令/i;
const days = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const aliases = {
  kind: ['类型', '日程类型', 'kind', 'type'], title: ['课程', '课程名', '课程名称', '日程', '日程名', '日程名称', '标题', '名称', 'title', 'name', 'course'],
  id: ['编号', 'id'], courseId: ['课程号', '课程编号', 'courseid'], weekday: ['星期', '星期几', '周几', 'weekday', 'day'],
  date: ['日期', '上课日期', '考试日期', 'date'], start: ['开始', '开始时间', '上课时间', 'start', 'starts', 'starttime'],
  end: ['结束', '结束时间', '下课时间', 'end', 'ends', 'endtime'], weeks: ['周次', '上课周次', '教学周', 'weeks'], weekMode: ['单双周', '周模式', 'weekmode'],
  room: ['教室', 'room'], location: ['地点', '位置', '教学楼', 'location'], teacher: ['教师', '老师', '任课教师', 'teacher'],
  notes: ['备注', '说明', 'notes', 'description'], repeat: ['重复', '重复方式', 'repeat'], until: ['重复截止', '重复截止日期', '截止日期', 'until'],
  color: ['颜色', 'color'], floor: ['楼层', 'floor'], participants: ['参与人', '参与者', 'participants'],
  sourceURL: ['来源链接', 'sourceurl'], registrationURL: ['报名链接', 'registrationurl'], projectURL: ['项目链接', 'projecturl'],
};
const normalizeHeader = (v) => String(v).trim().replace(/[\s_\-（）()]/g, '').toLowerCase();
const headerFields = new Map(Object.entries(aliases).flatMap(([field, list]) => list.map((name) => [normalizeHeader(name), field])));
function fail(message) { throw new Error(message); }
function warningsPush(warnings, message) { if (!warnings.includes(message)) warnings.push(message); }
function hash(text) { let value = 2166136261; for (const ch of text) { value ^= ch.codePointAt(0); value = Math.imul(value, 16777619); } return (value >>> 0).toString(36); }
function scan(value, depth = 0) {
  if (depth > 12) fail('文件的数据层级过深。');
  if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
    if (credentials.test(key)) fail('导入文件不能包含密码、Cookie、登录令牌或会话字段。');
    scan(child, depth + 1);
  }
}
function termOf(options) { return normalizePlan({ term: options.term }).term; }
function preview(courses, events, warnings, options) {
  const plan = normalizePlan({ term: termOf(options), courses, events });
  if (plan.courses.some((c) => c.slots.length) && !plan.term.starts) warningsPush(warnings, '课程已经解析；请设置学期第 1 周的周一，才能展开实际日期或导出日历。');
  return { courses: plan.courses, events: plan.events, warnings };
}
function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) fail('日期需为真实的 YYYY-MM-DD。');
  const stamp = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0, 10) !== value) fail(`日期不存在：${value}。`);
  return value;
}
function weekdayOf(date) { return ((new Date(`${validDate(date)}T00:00:00Z`).getUTCDay() + 6) % 7) + 1; }
function timeValue(value, options) {
  if (typeof value === 'number' && options.excel) {
    const minute = value * 1440;
    if (value < 0 || value >= 1 || Math.abs(minute - Math.round(minute)) > 0.00001) fail('Excel 时间必须精确到分钟；请改为 HH:mm。');
    return `${String(Math.floor(Math.round(minute) / 60)).padStart(2, '0')}:${String(Math.round(minute) % 60).padStart(2, '0')}`;
  }
  const text = String(value ?? '').trim().replace('：', ':');
  const match = /^(\d{1,2}):([0-5]\d)(?::00)?$/.exec(text);
  if (!match || Number(match[1]) > 23) fail('缺少或无法确认具体时间；请填写 HH:mm，不能凭节次猜上课时间。');
  return `${match[1].padStart(2, '0')}:${match[2]}`;
}
function dateValue(value, options) {
  if (typeof value === 'number' && options.excel) {
    if (!Number.isInteger(value) || value < 0 || value > 2958465 || (!options.date1904 && value === 60)) fail('Excel 日期无效或含时间，请改为 YYYY-MM-DD。');
    return validDate(addDays(options.date1904 ? '1904-01-01' : '1899-12-31', value - (!options.date1904 && value > 60 ? 1 : 0)));
  }
  const text = String(value ?? '').trim();
  const match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(text);
  return validDate(match ? `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}` : text);
}
function weekdayValue(value) {
  const text = String(value ?? '').trim();
  if (/^[1-7]$/.test(text)) return Number(text);
  const zh = /^(?:周|星期|礼拜)?([一二三四五六日天])$/.exec(text);
  if (zh) return '一二三四五六日'.indexOf(zh[1] === '天' ? '日' : zh[1]) + 1;
  const en = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].findIndex((day) => day === text.toLowerCase() || day.slice(0, 3) === text.toLowerCase());
  if (en >= 0) return en + 1;
  fail('星期需为周一至周日，或数字 1–7。');
}

function tableRows(text, delimiter) {
  const rows = []; let row = [], cell = '', quoted = false, closed = false;
  const endCell = () => { row.push(cell); cell = ''; closed = false; if (row.length > IMPORT_LIMITS.columns) fail('表格列数超过 64 列。'); };
  const endRow = () => { endCell(); if (row.some((v) => String(v).trim())) rows.push(row); row = []; if (rows.length > IMPORT_LIMITS.rows + 1) fail('表格超过 2000 行，请分批整理。'); };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i += 1; } else { quoted = false; closed = true; } } else cell += ch; continue; }
    if (ch === '"') { if (cell || closed) fail('CSV 引号格式错误。'); quoted = true; }
    else if (ch === delimiter) endCell();
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i += 1; endRow(); }
    else { if (closed && !/[ \t]/.test(ch)) fail('CSV 引号结束后出现额外文字。'); if (!closed) cell += ch; }
  }
  if (quoted) fail('CSV 有未闭合的引号。');
  if (row.length || cell || closed) endRow();
  return rows;
}
function detectDelimiter(text, option) {
  if (option !== undefined) { if (![',', '\t', ';', '|'].includes(option)) fail('分隔符不受支持。'); return option; }
  const first = text.split(/\r?\n/, 1)[0];
  const counts = new Map([[',', 0], ['\t', 0], [';', 0], ['|', 0]]); let quoted = false;
  for (let i = 0; i < first.length; i += 1) { const ch = first[i]; if (ch === '"') { if (quoted && first[i + 1] === '"') i += 1; else quoted = !quoted; } else if (!quoted && counts.has(ch)) counts.set(ch, counts.get(ch) + 1); }
  return [...counts].sort((a, b) => b[1] - a[1])[0][0];
}
function tablePreview(rows, options, warnings = []) {
  if (rows.length < 2) fail('表格需要表头和至少一行课程或日程。');
  const headers = rows[0].map((v) => String(v).trim());
  if (headers.some((v) => credentials.test(v))) fail('表格不能包含密码、Cookie 或登录令牌列。');
  const columns = new Map();
  for (let i = 0; i < headers.length; i += 1) { const field = headerFields.get(normalizeHeader(headers[i])); if (field && !columns.has(field)) columns.set(field, i); }
  if (options.columnMap !== undefined) {
    if (!options.columnMap || typeof options.columnMap !== 'object' || Array.isArray(options.columnMap)) fail('表头映射应为字段到列名或列号的对象。');
    for (const [field, source] of Object.entries(options.columnMap)) {
      if (!Object.hasOwn(aliases, field)) fail(`未知导入字段：${field}。`);
      const index = Number.isInteger(source) ? source : headers.indexOf(String(source));
      if (index < 0 || index >= headers.length) fail(`找不到 ${field} 对应的表格列。`);
      columns.set(field, index);
    }
  }
  for (const required of ['title', 'start', 'end']) if (!columns.has(required)) fail(`表头缺少${{ title: '课程名或标题', start: '具体开始时间', end: '具体结束时间' }[required]}；请补齐或指定 columnMap。`);
  const unused = headers.filter((_, i) => ![...columns.values()].includes(i)).filter(Boolean);
  if (unused.length) warningsPush(warnings, `未映射的列不会导入：${unused.slice(0, 12).join('、')}。`);
  const term = termOf(options), courses = [], events = [], groups = new Map();
  const kindNames = { '课程': 'course', '课': 'course', course: 'course', '个人': 'personal', '日程': 'personal', personal: 'personal', '考试': 'exam', exam: 'exam', '活动': 'activity', activity: 'activity', '待办': 'deadline', '截止': 'deadline', deadline: 'deadline', '社团': 'club', club: 'club', '竞赛': 'competition', competition: 'competition', '会议': 'meeting', meeting: 'meeting' };
  for (let n = 1; n < rows.length; n += 1) {
    const row = rows[n]; if (!row.some((v) => String(v).trim())) continue;
    if (row.length > headers.length) fail(`第 ${n + 1} 行的列数多于表头。`);
    const record = Object.fromEntries([...columns].map(([field, i]) => [field, row[i] ?? '']));
    const get = (field) => String(record[field] ?? '').trim();
    try {
      const title = get('title'), start = timeValue(record.start, options), end = timeValue(record.end, options);
      if (!title) fail('缺少名称。');
      if (end <= start) fail('结束时间必须晚于开始时间；跨日安排请拆为两项。');
      const kindText = get('kind').toLowerCase();
      const kind = kindText ? kindNames[kindText] : get('date') ? 'personal' : get('weekday') ? 'course' : null;
      if (!kind) fail('需要课程的星期，或日程的具体日期；未知类型请手动选择。');
      if (/^[=+@]/.test(title)) warningsPush(warnings, '公式样式的 CSV 文字只作为普通文本预览，不会执行。');
      if (kind === 'course') {
        const day = weekdayValue(record.weekday);
        const weeks = get('weeks') ? parseWeeks(get('weeks'), term.weeks) : undefined;
        const mode = ({ '': 'all', all: 'all', '全': 'all', '全周': 'all', '每周': 'all', odd: 'odd', '单': 'odd', '单周': 'odd', even: 'even', '双': 'even', '双周': 'even' })[get('weekMode').toLowerCase()];
        if (!mode) fail('单双周需为全周、单周或双周。');
        const base = { name: title, courseId: get('courseId'), room: get('room') || get('location'), building: null, teacher: get('teacher'), notes: get('notes'), color: get('color'), floor: get('floor'), weekMode: mode, ...(weeks ? { weeks } : {}) };
        const key = JSON.stringify([get('id'), base]); let course = groups.get(key);
        if (!course) { course = { ...base, id: get('id') || `import-c-${hash(key)}`, slots: [] }; courses.push(course); groups.set(key, course); }
        if (course.slots.some((s) => s.day === day && s.start === start && s.end === end)) warningsPush(warnings, `第 ${n + 1} 行的相同课程时段已在本文件出现，预览只保留一次。`);
        else course.slots.push({ id: `slot-${course.slots.length}`, day, start, end });
      } else {
        const date = dateValue(record.date, options);
        const repeatText = get('repeat').toLowerCase();
        const repeat = ({ '': 'none', none: 'none', '不重复': 'none', weekly: 'weekly', '每周': 'weekly' })[repeatText];
        if (!repeat) fail('重复方式仅支持不重复或每周。');
        let until = get('until') ? dateValue(record.until, options) : '';
        if (repeat === 'weekly' && !until) { if (!term.starts) fail('每周重复日程需要截止日期。'); until = addDays(term.starts, term.weeks * 7 - 1); warningsPush(warnings, '没有重复截止日期的每周日程，预览明确使用当前学期最后一天作为截止；请在保存前核对。'); }
        events.push({ id: get('id') || `import-e-${hash(JSON.stringify(record))}-${n}`, title, kind, date, start, end, location: get('location') || get('room'), notes: get('notes'), repeat, until, color: get('color'), floor: get('floor'), participants: get('participants'), courseId: get('courseId'), sourceURL: get('sourceURL'), registrationURL: get('registrationURL'), projectURL: get('projectURL') });
      }
    } catch (error) { fail(`第 ${n + 1} 行：${error.message}`); }
  }
  return preview(courses, events, warnings, options);
}

function icsDate(raw, params, warnings) {
  if (params.VALUE && params.VALUE !== 'DATE-TIME') fail('全天日程没有具体开始和结束时间，请手动补齐后导入。');
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(raw);
  if (!match) fail(`日历时间格式不受支持：${raw}。`);
  const date = validDate(`${match[1]}-${match[2]}-${match[3]}`), time = timeValue(`${match[4]}:${match[5]}`, {});
  if (match[6] && match[6] !== '00') fail('日历时间含非零秒；计划按分钟保存，请先调整文件。');
  const tz = params.TZID?.replace(/^"|"$/g, '');
  if (tz && !['Asia/Shanghai', 'AsiaShanghai', 'UTC', 'Etc/UTC'].includes(tz)) fail(`暂不支持时区 ${tz}；请先导出为 UTC 或 Asia/Shanghai。`);
  if (match[7] && tz && !['UTC', 'Etc/UTC'].includes(tz)) fail('UTC 时间与 TZID 冲突。');
  const utc = !!match[7] || ['UTC', 'Etc/UTC'].includes(tz);
  if (!utc && !tz) warningsPush(warnings, 'ICS 有未标时区的浮动时间；预览明确按北京时间 Asia/Shanghai 解释，请核对。');
  const localStamp = Date.parse(`${date}T${time}:00Z`) + (utc ? 8 * 3600000 : 0);
  const local = new Date(localStamp).toISOString();
  return { date: local.slice(0, 10), time: local.slice(11, 16), stamp: localStamp, utc };
}
function decodeICSText(value) { return value.replace(/\\([\\;,nN])/g, (_, ch) => /[nN]/.test(ch) ? '\n' : ch); }
function icsPreview(text, options) {
  const warnings = [], components = [], stack = []; let current = null, version = false, calendarCount = 0;
  const lines = text.replace(/\r\n[ \t]|\n[ \t]/g, '').split(/\r\n|\n|\r/);
  if (lines.length > 30000) fail('日历行数超过上限。');
  for (const line of lines) {
    if (!line) continue;
    const colon = line.indexOf(':'); if (colon < 1) fail('ICS 内容行缺少冒号。');
    const parts = line.slice(0, colon).split(';'), name = parts.shift().toUpperCase(), value = line.slice(colon + 1), params = {};
    if (credentials.test(name)) fail('日历不能包含登录凭据字段。');
    for (const param of parts) { const eq = param.indexOf('='); if (eq < 1) fail('ICS 参数格式错误。'); const key = param.slice(0, eq).toUpperCase(); if (Object.hasOwn(params, key)) fail('ICS 参数重复。'); params[key] = param.slice(eq + 1); }
    if (name === 'BEGIN') {
      if (value === 'VCALENDAR') { if (stack.length || ++calendarCount > 1) fail('只支持一个完整 VCALENDAR。'); }
      else if (!stack.length) fail('ICS 缺少 VCALENDAR。');
      if (stack.length > 10) fail('ICS 嵌套过深。');
      stack.push(value);
      if (value === 'VEVENT') { if (current || stack.length !== 2) fail('VEVENT 结构错误。'); current = new Map(); }
      continue;
    }
    if (name === 'END') {
      if (stack.pop() !== value) fail('ICS 组件未正确结束。');
      if (value === 'VEVENT') { components.push(current); current = null; if (components.length > 500) fail('日历超过 500 个事件。'); }
      continue;
    }
    if (!stack.length) fail('ICS 有组件之外的内容。');
    if (stack.length === 1 && name === 'VERSION') { if (value !== '2.0') fail('只支持 iCalendar 2.0。'); version = true; }
    if (stack.length === 1 && name === 'METHOD' && !['PUBLISH', 'REQUEST'].includes(value.toUpperCase())) fail('不支持取消或响应类日历，请核对后导出普通事件。');
    if (current && stack.at(-1) === 'VEVENT') { const items = current.get(name) || []; items.push({ value, params }); current.set(name, items); }
    else if (current) warningsPush(warnings, '日历中的提醒或其他嵌套附件未导入；请在计划设置中重新选择提醒。');
  }
  if (stack.length || current || calendarCount !== 1 || !version || !components.length) fail('ICS 缺少完整日历或可导入事件。');
  const events = [], seenUID = new Set(), term = termOf(options);
  for (let i = 0; i < components.length; i += 1) {
    const item = components[i];
    const one = (name, required = false) => { const values = item.get(name) || []; if (values.length > 1) fail(`日历事件 ${i + 1} 的 ${name} 重复。`); if (required && !values.length) fail(`日历事件 ${i + 1} 缺少 ${name}。`); return values[0]; };
    for (const unsupported of ['RDATE', 'EXRULE', 'RECURRENCE-ID']) if (item.has(unsupported)) fail(`暂不支持 ${unsupported}；请展开为单次事件后导入。`);
    const uid = one('UID')?.value; if (uid && seenUID.has(uid)) fail('日历有相同 UID 的多个版本，请先导出当前有效版本。'); if (uid) seenUID.add(uid);
    const beginRaw = one('DTSTART', true), begin = icsDate(beginRaw.value, beginRaw.params, warnings), endRaw = one('DTEND'); let end;
    if (endRaw) end = icsDate(endRaw.value, endRaw.params, warnings);
    else {
      const duration = one('DURATION', true), match = /^PT(?:(\d+)H)?(?:(\d+)M)?$/.exec(duration.value);
      if (!match || (!match[1] && !match[2])) fail('日历 DURATION 仅支持明确的小时和分钟。');
      const durationMinutes = Number(match[1] || 0) * 60 + Number(match[2] || 0);
      if (durationMinutes < 1 || durationMinutes >= 1440) fail('日历时长必须在同一天内，请拆分跨日事件。');
      const local = new Date(begin.stamp + durationMinutes * 60000).toISOString();
      end = { date: local.slice(0, 10), time: local.slice(11, 16), stamp: Date.parse(local) };
    }
    if (begin.date !== end.date || end.time <= begin.time) fail('日历事件跨午夜或没有有效时长，请拆为同一天的两项。');
    const summary = decodeICSText(one('SUMMARY', true).value), notes = decodeICSText(one('DESCRIPTION')?.value || ''), location = decodeICSText(one('LOCATION')?.value || '');
    const status = one('STATUS')?.value.toUpperCase();
    if (status === 'CANCELLED') fail('文件含已取消的事件，请先核对后导出当前有效安排。');
    if (status === 'TENTATIVE') warningsPush(warnings, '文件含暂定事件；预览保留内容，请在保存前确认。');
    if (item.has('ATTACH') || item.has('ATTENDEE') || item.has('ORGANIZER')) warningsPush(warnings, 'ICS 附件、人员邮箱和组织者账户信息不会导入。');
    const excluded = new Set();
    for (const entry of item.get('EXDATE') || []) for (const value of entry.value.split(',')) { const ex = icsDate(value, entry.params, warnings); if (ex.time !== begin.time) fail('EXDATE 与重复事件的时间不同，请核对例外安排。'); excluded.add(ex.date); }
    const rule = one('RRULE'); let actual = [begin.date];
    if (rule) {
      const values = {};
      for (const part of rule.value.split(';')) { const [key, value, extra] = part.split('='); if (!key || !value || extra !== undefined || Object.hasOwn(values, key)) fail('RRULE 格式错误。'); values[key] = value; }
      if (values.FREQ !== 'WEEKLY' || Object.keys(values).some((k) => !['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'WKST'].includes(k))) fail('ICS 仅支持每周 RRULE；其他频率或复杂筛选规则需展开后导入。');
      if (values.WKST && values.WKST !== 'MO') fail('ICS 每周规则仅支持周一为周起点。');
      if (values.COUNT && values.UNTIL) fail('RRULE COUNT 与 UNTIL 不能同时设置。');
      if ([values.INTERVAL, values.COUNT].filter((v) => v !== undefined).some((v) => !/^\d+$/.test(v))) fail('RRULE 间隔和次数应为正整数。');
      const interval = values.INTERVAL ? Number(values.INTERVAL) : 1, count = values.COUNT ? Number(values.COUNT) : Infinity;
      if (!Number.isInteger(interval) || interval < 1 || interval > 52 || (values.COUNT && (!Number.isInteger(count) || count < 1 || count > 500))) fail('RRULE 重复间隔或次数超出安全上限。');
      const byday = values.BYDAY ? values.BYDAY.split(',') : [days[weekdayOf(begin.date) - 1]];
      if (byday.some((day) => !days.includes(day)) || new Set(byday).size !== byday.length || !byday.includes(days[weekdayOf(begin.date) - 1])) fail('RRULE BYDAY 无效或与 DTSTART 不一致。');
      let untilStamp;
      if (values.UNTIL) untilStamp = icsDate(values.UNTIL, values.UNTIL.endsWith('Z') ? {} : beginRaw.params, warnings).stamp;
      else if (values.COUNT) untilStamp = Date.parse(`${addDays(begin.date, 730)}T23:59:00Z`);
      else { if (!term.starts) fail('无截止日期的重复日历需要先设置学期，或补充 RRULE UNTIL/COUNT。'); untilStamp = Date.parse(`${addDays(term.starts, term.weeks * 7 - 1)}T23:59:00Z`); warningsPush(warnings, '无截止日期的 ICS 每周规则已明确限定到当前学期最后一天，请核对。'); }
      if (untilStamp < begin.stamp || Math.floor(untilStamp / 86400000) - Math.floor(begin.stamp / 86400000) > 730) fail('ICS 重复日期无效或跨度超过两年。');
      actual = []; const anchor = weekStart(begin.date);
      for (let offset = 0; offset <= 730 && actual.length < count; offset += 1) {
        const date = addDays(begin.date, offset), stamp = Date.parse(`${date}T${begin.time}:00Z`);
        if (stamp > untilStamp) break;
        const week = Math.floor((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${anchor}T00:00:00Z`)) / (7 * 86400000));
        if (week % interval === 0 && byday.includes(days[weekdayOf(date) - 1])) actual.push(date);
      }
      if (values.COUNT && actual.length !== count) fail('ICS 重复次数无法在两年范围内完整展开，请缩小范围。');
      warningsPush(warnings, '每周 RRULE 已展开为具体日期的单次日程，并应用 EXDATE；导入不会创建无限重复。');
    } else if (excluded.size) warningsPush(warnings, '单次日程中的 EXDATE 已按明确的日期应用，请核对。');
    const known = new Set(['UID', 'DTSTART', 'DTEND', 'DURATION', 'SUMMARY', 'DESCRIPTION', 'LOCATION', 'STATUS', 'RRULE', 'EXDATE', 'DTSTAMP', 'CREATED', 'LAST-MODIFIED', 'SEQUENCE', 'TRANSP', 'CLASS', 'CATEGORIES', 'URL']);
    if ([...item.keys()].some((k) => !known.has(k))) warningsPush(warnings, 'ICS 中部分扩展属性不会导入；预览仅包含名称、时间、地点和备注。');
    for (const date of actual.filter((date) => !excluded.has(date))) {
      events.push({ id: `import-ics-${hash(uid || JSON.stringify([...item]))}-${i}-${date}`, title: summary, kind: /^\[?考试\]?/.test(summary) ? 'exam' : 'personal', date, start: begin.time, end: end.time, location, notes, repeat: 'none', until: '' });
      if (events.length > 500) fail('展开后的日历超过 500 个事件，请缩小日期范围。');
    }
  }
  return preview([], events, warnings, options);
}

function decodeXML(text) {
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/i.test(text)) fail('XML 包含未转义或无效实体。');
  return text.replace(/&([^;\s]+);/g, (_, entity) => {
    const names = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }; if (Object.hasOwn(names, entity)) return names[entity];
    const number = /^#\d+$/.test(entity) ? Number(entity.slice(1)) : /^#x[0-9a-f]+$/i.test(entity) ? parseInt(entity.slice(2), 16) : NaN;
    if (!Number.isInteger(number) || number < 1 || number > 0x10ffff || (number < 32 && ![9, 10, 13].includes(number)) || (number >= 0xd800 && number <= 0xdfff) || [0xfffe, 0xffff].includes(number)) fail('XML 包含无效或外部实体。');
    return String.fromCodePoint(number);
  });
}
function parseXML(text) {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) fail('Excel XML 含 DTD 或外部实体，不能导入。');
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/.test(text)) fail('Excel XML 含无效控制字符。');
  const root = { name: '', attrs: {}, children: [], text: '' }, stack = [root]; let position = 0, count = 0;
  const tokens = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<(?:(?:[^<>"']+)|"[^"]*"|'[^']*')*>|[^<]+/g;
  for (const match of text.matchAll(tokens)) {
    if (match.index !== position) fail('Excel XML 结构损坏。'); position += match[0].length; const token = match[0];
    if (token.startsWith('<!--') || token.startsWith('<?')) continue;
    if (token.startsWith('<![CDATA[')) { stack.at(-1).text += token.slice(9, -3); continue; }
    if (!token.startsWith('<')) { stack.at(-1).text += decodeXML(token); continue; }
    if (token.startsWith('</')) { const end = /^<\/([\w:.-]+)\s*>$/.exec(token); if (!end || stack.length < 2 || stack.pop().fullName !== end[1]) fail('Excel XML 标签不匹配。'); continue; }
    const begin = /^<([A-Za-z_][\w:.-]*)([\s\S]*?)(\/?)>$/.exec(token); if (!begin) fail('Excel XML 标签无效。');
    const attrs = {}, rest = begin[2]; let consumed = 0;
    const attributes = /\s+([A-Za-z_][\w:.-]*)\s*=\s*("[^"]*"|'[^']*')/g;
    for (const attribute of rest.matchAll(attributes)) { if (rest.slice(consumed, attribute.index).trim()) fail('Excel XML 属性无效。'); consumed = attribute.index + attribute[0].length; if (Object.hasOwn(attrs, attribute[1])) fail('Excel XML 属性重复。'); attrs[attribute[1]] = decodeXML(attribute[2].slice(1, -1)); }
    if (rest.slice(consumed).trim()) fail('Excel XML 属性无效。');
    const node = { fullName: begin[1], name: begin[1].split(':').at(-1), attrs, children: [], text: '' };
    stack.at(-1).children.push(node); if (++count > 100000) fail('Excel XML 节点过多。');
    if (!begin[3]) { stack.push(node); if (stack.length > 40) fail('Excel XML 嵌套过深。'); }
  }
  if (position !== text.length || stack.length !== 1 || root.children.length !== 1 || root.text.trim()) fail('Excel XML 不完整。');
  return root.children[0];
}
function nodes(root, name) { const out = []; const visit = (node) => { if (node.name === name) out.push(node); for (const child of node.children) visit(child); }; visit(root); return out; }
function xmlText(node) { return node.text + node.children.map(xmlText).join(''); }
function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i -= 1) if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === bytes.length) { end = i; break; }
  if (end < 0 || view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) fail('Excel ZIP 结构损坏或为分卷压缩。');
  const count = view.getUint16(end + 10, true), size = view.getUint32(end + 12, true), offset = view.getUint32(end + 16, true);
  if (!count || count > IMPORT_LIMITS.zipEntries || count !== view.getUint16(end + 8, true) || offset + size > end) fail('Excel ZIP 文件数过多或目录无效。');
  const entries = new Map(); let position = offset, expanded = 0;
  for (let i = 0; i < count; i += 1) {
    if (position + 46 > end || view.getUint32(position, true) !== 0x02014b50) fail('Excel ZIP 目录损坏。');
    const flags = view.getUint16(position + 8, true), method = view.getUint16(position + 10, true), compressed = view.getUint32(position + 20, true), original = view.getUint32(position + 24, true);
    const nameLength = view.getUint16(position + 28, true), extra = view.getUint16(position + 30, true), comment = view.getUint16(position + 32, true), localOffset = view.getUint32(position + 42, true);
    if (position + 46 + nameLength + extra + comment > end) fail('Excel ZIP 文件名越界。');
    const name = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(position + 46, position + 46 + nameLength));
    if (flags & 1 || ![0, 8].includes(method) || original === 0xffffffff || compressed === 0xffffffff || original > IMPORT_LIMITS.entryBytes || original > Math.max(65536, compressed * 200)) fail('Excel ZIP 加密、压缩方式或展开比例超过安全范围。');
    if (!name || name.startsWith('/') || /[\\\x00:]/.test(name) || name.split('/').includes('..') || entries.has(name) || /vbaProject|externalLinks/i.test(name)) fail('Excel 含重复路径、宏或外部链接，不能导入。');
    if (localOffset + 30 > offset || view.getUint32(localOffset, true) !== 0x04034b50) fail('Excel ZIP 文件头损坏。');
    expanded += original; if (expanded > IMPORT_LIMITS.expandedBytes) fail('Excel 展开数据超过 16 MB。');
    entries.set(name, { original }); position += 46 + nameLength + extra + comment;
  }
  if (position !== offset + size) fail('Excel ZIP 目录长度不一致。');
  const files = new Map(), seenLocal = new Set(); let actual = 0, error = null;
  const unzip = new Unzip((file) => {
    const meta = entries.get(file.name); if (!meta || seenLocal.has(file.name)) { error = new Error('Excel 压缩路径重复或与目录不一致。'); file.terminate(); return; }
    seenLocal.add(file.name);
    if (!/\.xml(?:\.rels)?$|\.rels$/i.test(file.name)) return;
    const chunks = []; let length = 0;
    file.ondata = (err, chunk, final) => {
      if (error) return; if (err) { error = err; return; }
      actual += chunk.length; length += chunk.length;
      if (actual > IMPORT_LIMITS.expandedBytes || length > IMPORT_LIMITS.entryBytes || length > meta.original) { error = new Error('Excel 实际展开数据超过安全上限。'); file.terminate(); return; }
      chunks.push(chunk);
      if (final) { if (length !== meta.original) { error = new Error('Excel 展开长度与目录不一致。'); return; } const joined = new Uint8Array(length); let n = 0; for (const part of chunks) { joined.set(part, n); n += part.length; } files.set(file.name, new TextDecoder('utf-8', { fatal: true }).decode(joined)); }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  for (let i = 0; i < bytes.length; i += 1024) { unzip.push(bytes.subarray(i, i + 1024), i + 1024 >= bytes.length); if (error) throw error; }
  return files;
}
function xlsxPreview(bytes, options) {
  const files = readZip(bytes), workbook = files.get('xl/workbook.xml'), rels = files.get('xl/_rels/workbook.xml.rels');
  if (!workbook || !rels) fail('Excel 缺少工作簿或关系文件。');
  const wb = parseXML(workbook), relationshipTree = parseXML(rels);
  if (wb.name !== 'workbook' || relationshipTree.name !== 'Relationships') fail('Excel 工作簿结构无效。');
  const relationships = nodes(relationshipTree, 'Relationship');
  for (const [path, xml] of files) if (/\.rels$/i.test(path)) {
    const tree = path === 'xl/_rels/workbook.xml.rels' ? relationshipTree : parseXML(xml);
    if (tree.name !== 'Relationships') fail('Excel 关系文件结构无效。');
    if (nodes(tree, 'Relationship').some((r) => String(r.attrs.TargetMode).toLowerCase() === 'external' || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(r.attrs.Target || ''))) fail('Excel 含外部链接，请移除后导入。');
  }
  const targets = new Map(relationships.map((r) => [r.attrs.Id, r.attrs.Target]));
  let sheets = nodes(wb, 'sheet');
  if (options.sheetName) sheets = sheets.filter((s) => s.attrs.name === options.sheetName);
  if (sheets.length !== 1) fail('Excel 需要一个明确的工作表；多工作表请另存所需表格，或指定 sheetName。');
  let target = targets.get(sheets[0].attrs['r:id']);
  if (!target || target.includes('..') || target.includes('\\')) fail('Excel 工作表路径无效。');
  target = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
  if (!files.has(target)) fail('找不到 Excel 工作表数据。');
  const strings = files.has('xl/sharedStrings.xml') ? parseXML(files.get('xl/sharedStrings.xml')) : null;
  if (strings && strings.name !== 'sst') fail('Excel 共享文字结构无效。');
  const shared = strings ? nodes(strings, 'si').map((si) => nodes(si, 't').map(xmlText).join('')) : [];
  if (shared.length > IMPORT_LIMITS.cells) fail('Excel 共享文字数量超过上限。');
  const sheet = parseXML(files.get(target)), rows = []; let cells = 0;
  if (sheet.name !== 'worksheet') fail('Excel 工作表结构无效。');
  for (const row of nodes(sheet, 'row')) {
    const values = [], occupied = new Set();
    for (const cell of row.children.filter((c) => c.name === 'c')) {
      if (++cells > IMPORT_LIMITS.cells) fail('Excel 单元格超过 20000 个。');
      if (nodes(cell, 'f').length) fail('Excel 含公式单元格；请复制并粘贴为值后导入，本站不会执行公式。');
      const match = /^([A-Z]{1,3})[1-9]\d*$/.exec(cell.attrs.r || ''); if (!match) fail('Excel 单元格坐标无效。');
      let col = 0; for (const ch of match[1]) col = col * 26 + ch.charCodeAt(0) - 64; col -= 1;
      if (col >= IMPORT_LIMITS.columns || occupied.has(col)) fail('Excel 列数过多或坐标重复。'); occupied.add(col);
      const type = cell.attrs.t || 'n', value = nodes(cell, 'v')[0]?.text ?? '';
      if (type === 's') { const index = Number(value); if (!Number.isInteger(index) || index < 0 || index >= shared.length) fail('Excel 共享文字引用无效。'); values[col] = shared[index]; }
      else if (type === 'inlineStr') values[col] = nodes(cell, 'is').flatMap((si) => nodes(si, 't').map(xmlText)).join('');
      else if (['str', 'd'].includes(type)) values[col] = value;
      else if (type === 'n' && value !== '') { const number = Number(value); if (!Number.isFinite(number)) fail('Excel 数字无效。'); values[col] = number; }
      else if (value === '') values[col] = '';
      else fail('Excel 含布尔值或错误单元格，请改为明确的文字。');
    }
    if (values.some((v) => String(v ?? '').trim())) rows.push(Array.from({ length: values.length }, (_, i) => values[i] ?? ''));
    if (rows.length > IMPORT_LIMITS.rows + 1) fail('Excel 超过 2000 行。');
  }
  const date1904 = ['1', 'true'].includes(nodes(wb, 'workbookPr')[0]?.attrs.date1904);
  return tablePreview(rows, { ...options, excel: true, date1904 }, ['Excel 只读取单元格值；格式、图片、附件和宏不会导入。']);
}

export function parseCampusText(text, options = {}) {
  if (typeof text !== 'string' || encoder.encode(text).length > IMPORT_LIMITS.fileBytes) fail('请提供不超过 5 MB 的课表或日程文字。');
  text = text.replace(/^\uFEFF/, ''); if (!text.trim()) fail('导入内容为空。');
  const format = options.format || (/^\s*BEGIN:VCALENDAR/.test(text) ? 'ics' : /^[\s]*[\[{]/.test(text) ? 'json' : 'table');
  if (format === 'ics') return icsPreview(text.trim(), options);
  if (format === 'json') {
    let raw; try { raw = JSON.parse(text); } catch { fail('JSON 格式错误，原计划未改变。'); }
    scan(raw);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || (!Array.isArray(raw.courses) && !Array.isArray(raw.events))) fail('JSON 需要课程 courses 或日程 events 列表。');
    const warnings = [];
    if (raw.term?.starts && options.term?.starts && raw.term.starts !== options.term.starts) warningsPush(warnings, 'JSON 原学期与当前学期不同；导入预览使用当前学期展开课程，保存前请核对。');
    if (raw.profile || raw.visited || raw.settings || raw.hiddenOccurrences || raw.favorites || raw.routePrefs) warningsPush(warnings, '此导入只合并课程和日程；个人资料、到访记录、隐藏安排和显示设置不会覆盖。');
    // Validate the complete imported schema before selecting the requested sections.
    normalizePlan(raw);
    return preview(raw.courses || [], raw.events || [], warnings, { ...options, term: options.term || raw.term });
  }
  if (!['table', 'csv', 'tsv', 'text'].includes(format)) fail('文字导入格式不受支持。');
  return tablePreview(tableRows(text, format === 'tsv' ? '\t' : detectDelimiter(text, options.delimiter)), options);
}

export async function parseCampusImport(file, options = {}) {
  if (!file || typeof file.arrayBuffer !== 'function' || !Number.isFinite(file.size) || file.size > IMPORT_LIMITS.fileBytes) fail('请选择不超过 5 MB 的本地文件。');
  const bytes = new Uint8Array(await file.arrayBuffer()); if (bytes.length > IMPORT_LIMITS.fileBytes) fail('文件超过 5 MB。');
  const extension = String(file.name || '').split('.').at(-1).toLowerCase();
  if (extension === 'xlsx') return xlsxPreview(bytes, options);
  if (!['csv', 'tsv', 'txt', 'ics', 'json'].includes(extension)) fail('支持 CSV、TSV、文本、ICS、JSON 或 XLSX；旧 XLS 请先另存为 XLSX。');
  let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('文件不是有效 UTF-8；请另存为 UTF-8 编码后重试。'); }
  return parseCampusText(text, { ...options, ...(extension === 'ics' || extension === 'json' ? { format: extension } : extension === 'tsv' ? { format: 'tsv' } : {}) });
}

export function sampleCSV() {
  return '\uFEFF类型,课程名,星期,日期,开始时间,结束时间,周次,单双周,教室,教师,备注\r\n课程,示例课程,周一,,08:00,09:40,1-16,全周,请填写教室,请填写教师,请按学校课表修改\r\n考试,示例考试,,2026-12-01,09:00,11:00,,,请填写地点,,仅为格式示例\r\n';
}
