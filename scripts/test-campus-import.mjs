import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { parseCampusImport, parseCampusText, sampleCSV, IMPORT_LIMITS } from '../src/js/campus-import.js';
import { normalizePlan, calendarICS } from '../src/js/campus-plan.js';

const term = { label: '2026 秋季', starts: '2026-09-07', weeks: 20 };
const textFile = (name, text) => new File([text], name, { type: 'text/plain' });
const calendar = (events, extra = '') => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${extra}${events}\r\nEND:VCALENDAR\r\n`;
const icsEvent = (extra = '', begin = 'DTSTART;TZID=Asia/Shanghai:20260907T090000', end = 'DTEND;TZID=Asia/Shanghai:20260907T100000') => `BEGIN:VEVENT\r\nUID:synthetic-course@example.test\r\n${begin}\r\n${end}\r\nSUMMARY:高等数学\r\n${extra}END:VEVENT`;
const csv = '类型,课程名,星期,日期,开始时间,结束时间,周次,单双周,教室,教师,备注\n课程,高等数学,周一,,08:00,09:40,1-16,单周,302,张老师,自填\n课程,高等数学,周三,,10:00,11:40,1-16,单周,302,张老师,自填\n考试,期中考试,,2026-11-02,09:00,11:00,,,302,,带学生证';
const escapeXML = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const column = (number) => { let out = ''; for (let n = number + 1; n; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + (n - 1) % 26) + out; return out; };
function xlsx(rows, { formula = false, date1904 = false, extra = {}, sheets = 1 } = {}) {
  const cell = (value, i, row) => typeof value === 'number' ? `<c r="${column(i)}${row}">${formula && row === 2 && i === 1 ? '<f>NOW()</f>' : ''}<v>${value}</v></c>` : `<c r="${column(i)}${row}" t="inlineStr"><is><t>${escapeXML(value)}</t></is></c>`;
  const files = {
    'xl/workbook.xml': strToU8(`<workbook xmlns:r="synthetic"><workbookPr date1904="${date1904 ? 1 : 0}"/><sheets><sheet name="课表" r:id="rId1"/>${sheets > 1 ? '<sheet name="第二表" r:id="rId2"/>' : ''}</sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>'),
    'xl/worksheets/sheet1.xml': strToU8(`<worksheet><sheetData>${rows.map((values, n) => `<row r="${n + 1}">${values.map((v, i) => cell(v, i, n + 1)).join('')}</row>`).join('')}</sheetData></worksheet>`),
    ...extra,
  };
  return new File([zipSync(files)], 'synthetic.xlsx');
}

test('CSV groups actual course slots and retains dates, odd weeks, teacher and room', () => {
  const result = parseCampusText(csv, { term });
  assert.equal(result.courses.length, 1); assert.equal(result.events.length, 1);
  assert.deepEqual(result.courses[0].slots.map((s) => [s.day, s.start, s.end]), [[1, '08:00', '09:40'], [3, '10:00', '11:40']]);
  assert.equal(result.courses[0].weekMode, 'odd'); assert.equal(result.courses[0].weeks.length, 16);
  assert.equal(result.courses[0].building, null); assert.equal(result.courses[0].room, '302');
  assert.equal(result.events[0].kind, 'exam'); assert.equal(result.events[0].date, '2026-11-02');
  assert.deepEqual(parseCampusText(csv, { term }), result, 'same input yields stable import identifiers');
});
test('explicit IDs preserve independent same-name courses and duplicate slots have warnings', () => {
  const rows = '编号,课程名,星期,开始,结束\na,同名,1,08:00,09:00\nb,同名,1,08:00,09:00';
  assert.equal(parseCampusText(rows, { term }).courses.length, 2);
  const repeated = '课程名,星期,开始,结束\n同名,1,08:00,09:00\n同名,1,08:00,09:00';
  const result = parseCampusText(repeated, { term }); assert.equal(result.courses[0].slots.length, 1); assert.ok(result.warnings.some((w) => w.includes('只保留一次')));
});
test('quoted commas, multiline notes, BOM, TSV and custom header mapping work', () => {
  const content = '\uFEFF标题,日期,开始,结束,备注\n"会议,复盘",2026-09-08,9:00,10:00,"第一行\n第二行"';
  const result = parseCampusText(content, { term }); assert.equal(result.events[0].title, '会议,复盘'); assert.equal(result.events[0].notes, '第一行\n第二行');
  const tsv = '学科\t周几\t从几点\t到几点\n数学\t周一\t08:00\t09:00';
  const mapped = parseCampusText(tsv, { term, columnMap: { title: '学科', start: '从几点', end: '到几点' } });
  assert.equal(mapped.courses[0].name, '数学');
});
test('missing clock times cannot be invented from periods and invalid rows reject whole preview', () => {
  assert.throws(() => parseCampusText('课程名,星期,节次\n数学,周一,1-2', { term }), /具体开始时间/);
  assert.throws(() => parseCampusText('课程名,星期,开始,结束\n数学,周一,第1节,第2节', { term }), /不能凭节次猜/);
  assert.throws(() => parseCampusText(csv + '\n考试,错误日期,,2026-02-30,09:00,10:00,,,,,', { term }), /第 5 行.*日期不存在/);
  assert.throws(() => parseCampusText('标题,日期,开始,结束\n会议,2026-09-08,10:00,09:00', { term }), /结束时间/);
});
test('CSV credential columns, malformed quoting and unsupported type are rejected', () => {
  assert.throws(() => parseCampusText('课程名,开始,结束,密码\n数学,08:00,09:00,x', { term }), /密码/);
  assert.throws(() => parseCampusText('标题,日期,开始,结束\n"未闭合,2026-09-08,09:00,10:00', { term }), /未闭合/);
  assert.throws(() => parseCampusText('类型,标题,日期,开始,结束\n不认识,会议,2026-09-08,09:00,10:00', { term }), /未知类型/);
});
test('JSON imports validate complete source without modifying input, storage or credentials', () => {
  const plan = normalizePlan({ term, events: [{ id: 'existing', title: '会议', date: '2026-09-08', start: '09:00', end: '10:00' }], profile: { major: '机械' } });
  const original = structuredClone(plan), result = parseCampusText(JSON.stringify(plan), { term });
  assert.deepEqual(plan, original); assert.deepEqual(result.events, plan.events); assert.ok(result.warnings.some((w) => w.includes('个人资料')));
  assert.throws(() => parseCampusText(JSON.stringify({ courses: [], unknown: { accessToken: 'synthetic' } }), { term }), /登录令牌/);
  assert.throws(() => parseCampusText('{bad json}', { term }), /JSON 格式错误/);
});
test('file whitelist, size and encoding limits reject before saving', async () => {
  await assert.rejects(parseCampusImport(textFile('school.xls', 'not xlsx'), { term }), /旧 XLS/);
  await assert.rejects(parseCampusImport({ size: IMPORT_LIMITS.fileBytes + 1, arrayBuffer() { throw new Error('must not read'); } }, { term }), /5 MB/);
  await assert.rejects(parseCampusImport(new File([new Uint8Array([0xff, 0xfe])], 'bad.csv'), { term }), /UTF-8/);
  const result = await parseCampusImport(textFile('sample.csv', sampleCSV()), { term }); assert.equal(result.courses.length, 1); assert.equal(result.events.length, 1);
});
test('course and event limits reject rather than truncate', () => {
  const events = Array.from({ length: 501 }, (_, i) => ({ id: String(i), title: '会议', date: '2026-09-08', start: '09:00', end: '10:00' }));
  assert.throws(() => parseCampusText(JSON.stringify({ events }), { term }), /最多 500/);
  const rows = Array.from({ length: 61 }, (_, i) => `科目${i},1,08:00,09:00`).join('\n');
  assert.throws(() => parseCampusText('课程名,星期,开始,结束\n' + rows, { term }), /最多 60/);
});
test('UTC ICS becomes Shanghai civil time, TEXT and folded UTF-8 text survive', () => {
  const result = parseCampusText(calendar(icsEvent('DESCRIPTION:第一行\\n第二行\\,分号\\;反斜杠\\\\\r\nLOCATION:教学\r\n 楼302\r\n', 'DTSTART:20260907T010000Z', 'DTEND:20260907T020000Z')), { term });
  assert.equal(result.events[0].start, '09:00'); assert.equal(result.events[0].location, '教学楼302'); assert.equal(result.events[0].notes, '第一行\n第二行,分号;反斜杠\\');
});
test('floating ICS warns explicitly and incompatible zones, seconds and all-day values fail', () => {
  const result = parseCampusText(calendar(icsEvent('', 'DTSTART:20260907T090000', 'DTEND:20260907T100000')), { term });
  assert.ok(result.warnings.some((w) => w.includes('浮动时间'))); assert.equal(result.events[0].start, '09:00');
  for (const start of ['DTSTART;TZID=America/New_York:20260907T090000', 'DTSTART:20260907T090001', 'DTSTART;VALUE=DATE:20260907']) assert.throws(() => parseCampusText(calendar(icsEvent('', start)), { term }));
});
test('weekly COUNT plus EXDATE materializes exact dates and exclusions count before removal', () => {
  const result = parseCampusText(calendar(icsEvent('RRULE:FREQ=WEEKLY;COUNT=4\r\nEXDATE;TZID=Asia/Shanghai:20260914T090000\r\n')), { term });
  assert.deepEqual(result.events.map((e) => e.date), ['2026-09-07', '2026-09-21', '2026-09-28']);
  assert.ok(result.events.every((e) => e.repeat === 'none')); assert.ok(result.warnings.some((w) => w.includes('EXDATE')));
});
test('TZID start with standard UTC UNTIL and multiple BYDAY dates are precise', () => {
  const result = parseCampusText(calendar(icsEvent('RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20260916T010000Z\r\n')), { term });
  assert.deepEqual(result.events.map((e) => e.date), ['2026-09-07', '2026-09-09', '2026-09-14', '2026-09-16']);
});
test('unbounded weekly rule uses selected semester only with explicit warning', () => {
  assert.throws(() => parseCampusText(calendar(icsEvent('RRULE:FREQ=WEEKLY\r\n'))), /先设置学期/);
  const result = parseCampusText(calendar(icsEvent('RRULE:FREQ=WEEKLY\r\n')), { term: { ...term, weeks: 2 } });
  assert.deepEqual(result.events.map((e) => e.date), ['2026-09-07', '2026-09-14']); assert.ok(result.warnings.some((w) => w.includes('当前学期最后一天')));
});
test('unsupported rules, recurrence overrides and calendar cancellation reject explicitly', () => {
  for (const line of ['RRULE:FREQ=DAILY;COUNT=3', 'RRULE:FREQ=WEEKLY;BYSETPOS=1;COUNT=3', 'RRULE:FREQ=WEEKLY;COUNT=2;UNTIL=20261001T090000', 'RRULE:FREQ=WEEKLY;COUNT=1e2', 'RECURRENCE-ID:20260907T090000', 'RDATE:20260908T090000', 'STATUS:CANCELLED']) assert.throws(() => parseCampusText(calendar(icsEvent(line + '\r\n')), { term }));
});
test('ICS limits cannot silently truncate a large recurring series', () => {
  assert.throws(() => parseCampusText(calendar(icsEvent('RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU;UNTIL=20280906T010000Z\r\n')), { term }), /超过 500/);
  assert.throws(() => parseCampusText(calendar(icsEvent('RRULE:FREQ=WEEKLY;INTERVAL=52;COUNT=4\r\n')), { term }), /两年范围/);
  assert.throws(() => parseCampusText(calendar(icsEvent('RRULE:FREQ=WEEKLY;UNTIL=20280907T010000Z\r\n')), { term }), /跨度超过两年/);
});
test('application-exported calendar imports without local timezone or storage side effects', () => {
  const plan = normalizePlan({ term, settings: { reminderMinutes: 15 }, events: [{ id: 'test', title: '中文😀会议', date: '2026-09-08', start: '00:10', end: '01:00', notes: '测试\\内容\n第二行' }] });
  const result = parseCampusText(calendarICS(plan), { term });
  assert.equal(result.events[0].date, '2026-09-08'); assert.equal(result.events[0].start, '00:10'); assert.equal(result.events[0].title, '中文😀会议');
});
test('XLSX inline cells, numeric clock fractions and 1900/1904 dates work', async () => {
  const rows = [['类型', '课程名', '日期', '开始', '结束'], ['考试', '数学', 46273, 9 / 24, 11 / 24]];
  const result = await parseCampusImport(xlsx(rows), { term }); assert.equal(result.events[0].start, '09:00'); assert.equal(result.events[0].end, '11:00');
  const other = await parseCampusImport(xlsx([rows[0], ['考试', '数学', 0, 9 / 24, 11 / 24]], { date1904: true }), { term });
  assert.equal(other.events[0].date, '1904-01-01');
});
test('XLSX shared strings and escaped markup stay literal text', async () => {
  const sheet = '<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c></row><row><c r="A2" t="s"><v>4</v></c><c r="B2" t="inlineStr"><is><t>2026-09-08</t></is></c><c r="C2" t="inlineStr"><is><t>09:00</t></is></c><c r="D2" t="inlineStr"><is><t>10:00</t></is></c></row></sheetData></worksheet>';
  const shared = '<sst><si><t>标题</t></si><si><t>日期</t></si><si><t>开始</t></si><si><t>结束</t></si><si><r><t>&lt;script&gt;</t></r><r><t>literal&lt;/script&gt;</t></r></si></sst>';
  const result = await parseCampusImport(xlsx([], { extra: { 'xl/worksheets/sheet1.xml': strToU8(sheet), 'xl/sharedStrings.xml': strToU8(shared) } }), { term });
  assert.equal(result.events[0].title, '<script>literal</script>');
});
test('XLSX formulas, external relationships, macro paths and DTD are rejected without execution', async () => {
  const rows = [['标题', '日期', '开始', '结束'], ['考试', 46273, 9 / 24, 11 / 24]];
  await assert.rejects(parseCampusImport(xlsx(rows, { formula: true }), { term }), /公式/);
  await assert.rejects(parseCampusImport(xlsx(rows, { extra: { 'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="https://example.test/sheet.xml" TargetMode="External"/></Relationships>') } }), { term }), /外部/);
  await assert.rejects(parseCampusImport(xlsx(rows, { extra: { 'xl/worksheets/_rels/sheet1.xml.rels': strToU8('<Relationships><Relationship Id="link" Target="https://example.test/" TargetMode="External"/></Relationships>') } }), { term }), /外部/);
  await assert.rejects(parseCampusImport(xlsx(rows, { extra: { 'xl/vbaProject.bin': strToU8('synthetic') } }), { term }), /宏/);
  await assert.rejects(parseCampusImport(xlsx(rows, { extra: { 'xl/worksheets/sheet1.xml': strToU8('<!DOCTYPE worksheet [<!ENTITY x SYSTEM "https://example.test/">]><worksheet/>') } }), { term }), /DTD/);
});
test('malformed XLSX entities and a wrong worksheet root reject the whole preview', async () => {
  const rows = [['标题', '日期', '开始', '结束'], ['考试', '2026-09-08', '09:00', '10:00']];
  for (const xml of ['<worksheet><sheetData><row><c r="A1" t="inlineStr"><is><t>bad & name</t></is></c></row></sheetData></worksheet>', '<worksheet><sheetData><row><c r="A1" t="inlineStr"><is><t>&#1;</t></is></c></row></sheetData></worksheet>', '<unexpected/>']) {
    await assert.rejects(parseCampusImport(xlsx(rows, { extra: { 'xl/worksheets/sheet1.xml': strToU8(xml) } }), { term }), /实体|结构/);
  }
});
test('XLSX multiple sheets require explicit choice, corrupt zip and bombs fail', async () => {
  const rows = [['标题', '日期', '开始', '结束'], ['考试', '2026-09-08', '09:00', '10:00']];
  await assert.rejects(parseCampusImport(xlsx(rows, { sheets: 2 }), { term }), /工作表/);
  assert.equal((await parseCampusImport(xlsx(rows, { sheets: 2 }), { term, sheetName: '课表' })).events.length, 1);
  await assert.rejects(parseCampusImport(new File(['not ZIP'], 'bad.xlsx'), { term }), /ZIP/);
  await assert.rejects(parseCampusImport(xlsx(rows, { extra: { 'bomb.xml': strToU8('a'.repeat(200000)) } }), { term }), /展开比例/);
});
test('preview never calls storage, remote fetch or AI, even for formula-style CSV text', () => {
  const originals = { fetch: globalThis.fetch, localStorage: globalThis.localStorage };
  globalThis.fetch = () => { throw new Error('remote access prohibited'); };
  globalThis.localStorage = { setItem() { throw new Error('storage write prohibited'); }, getItem() { throw new Error('storage read prohibited'); } };
  try { const result = parseCampusText('标题,日期,开始,结束\n=SUM(A1),2026-09-08,09:00,10:00', { term }); assert.equal(result.events[0].title, '=SUM(A1)'); assert.ok(result.warnings.some((w) => w.includes('不会执行'))); }
  finally { globalThis.fetch = originals.fetch; if (originals.localStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = originals.localStorage; }
});
