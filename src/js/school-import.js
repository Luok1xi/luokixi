import { parseCampusText } from './campus-import.js';
import { normalizePlan, parseWeeks } from './campus-plan.js';

export const schoolOrigin = origin => {
  try { const u = new URL(origin); return /^https?:$/.test(u.protocol) && /(^|\.)cumtb\.edu\.cn$/.test(u.hostname) && !u.username && !u.password; } catch { return false; }
};
const days = /^(?:星期|周|礼拜)([一二三四五六日天])$/;
const dayNumber = value => { const m = days.exec(value.replace(/\s/g, '')); return m ? '一二三四五六日'.indexOf(m[1].replace('天', '日')) + 1 : 0; };
const clean = value => String(value ?? '').replace(/\r/g, '').replace(/\u00a0/g, ' ').trim();
const timeRange = value => /(\d{1,2}[:：]\d{2})\s*[-—–~～至]\s*(\d{1,2}[:：]\d{2})/.exec(value);
const time = value => value.replace('：', ':').padStart(5, '0');

export function fixedSchoolResult(result, sourceURL = '') {
  return { ...result, school: true, courses: result.courses.map(c => ({ ...c, origin: 'school', sourceURL })), events: result.events.map(e => ({ ...e, fixed: true, sourceURL: sourceURL || e.sourceURL })) };
}

// Visible cells only. Unknown grids are rejected with their coordinates instead
// of silently dropping classes or inventing period times / semester dates.
export function parseSchoolTable(payload, options = {}) {
  if (payload?.format !== 'luokixi-school-table' || !schoolOrigin(payload.origin)) throw new Error('需要从矿大官网的课表页面提取。');
  if (!Array.isArray(payload.tables) || payload.tables.length > 15 || JSON.stringify(payload).length > 500000) throw new Error('课表结构过大，请只打开个人课表后重试。');
  const failures = [];
  for (const rows of payload.tables) {
    try {
      if (!Array.isArray(rows) || rows.length > 150) throw new Error('课表行数不正确。');
      const texts = rows.map(row => {
        if (!Array.isArray(row) || row.length > 40) throw new Error('课表列数不正确。');
        return row.map(cell => clean(typeof cell === 'string' ? cell : cell.text));
      });
      const header = texts.findIndex(row => row.filter(dayNumber).length >= 5);
      if (header < 0) {
        const rowHeader = texts.findIndex(row => row.some(c => /^(课程名称|课程名|课程)$/.test(c)) && row.some(c => /星期|开始时间/.test(c)));
        if (rowHeader < 0) throw new Error('未识别到星期或课程表头。');
        const quote = s => `"${s.replaceAll('"', '""')}"`;
        return fixedSchoolResult(parseCampusText(texts.slice(rowHeader).map(row => row.map(quote).join(',')).join('\n'), options), payload.origin + (payload.path || ''));
      }
      // Expand row/column spans, retaining the original cell anchor only.
      const grid = [], anchors = [];
      for (let y = 0; y < rows.length; y++) {
        grid[y] ||= []; let x = 0;
        for (const raw of rows[y]) {
          while (grid[y][x]) x++;
          const cell = typeof raw === 'string' ? { text: raw } : raw;
          const rs = Number(cell.rowSpan || 1), cs = Number(cell.colSpan || 1);
          if (!Number.isInteger(rs) || !Number.isInteger(cs) || rs < 1 || cs < 1 || rs > 24 || cs > 8 || x + cs > 40) throw new Error('合并单元格不受支持。');
          const item = { text: clean(cell.text), x, y, rs, cs }; anchors.push(item);
          for (let r = y; r < y + rs; r++) { grid[r] ||= []; for (let c = x; c < x + cs; c++) grid[r][c] = item; }
          x += cs;
        }
      }
      const dayCols = new Map((grid[header] || []).map((c, x) => [x, dayNumber(c?.text || '')]).filter(([, day]) => day));
      const courses = [], problems = [];
      for (const cell of anchors.filter(c => c.y > header && dayCols.has(c.x) && c.text && !/^(无|空|休息|午休|晚休|—|-)$/.test(c.text))) {
        const label = `周${'一二三四五六日'[dayCols.get(cell.x) - 1]}第 ${cell.y - header} 行`;
        const blocks = cell.text.split(/\n\s*(?:-{3,}|={3,})\s*\n|\n(?=课程名(?:称)?\s*[:：])/).filter(Boolean);
        for (const block of blocks) {
          const lines = block.split('\n').map(clean).filter(Boolean);
          const name = clean(lines.find(s => /^(?:课程名称|课程名)\s*[:：]/.test(s))?.replace(/^(?:课程名称|课程名)\s*[:：]\s*/, '') || lines[0]);
          const teacher = clean(lines.find(s => /^(?:教师|老师|任课教师)\s*[:：]/.test(s))?.replace(/^[^:：]+[:：]\s*/, '') || '');
          const room = clean(lines.find(s => /^(?:教室|地点|上课地点)\s*[:：]/.test(s))?.replace(/^[^:：]+[:：]\s*/, '') || '');
          const weekText = /(?:第)?(\d+(?:\s*[-—~,，、]\s*\d+)*)\s*周(?:\s*[（(]([单双])(?:周)?[）)])?/.exec(block);
          let period = timeRange(block);
          if (!period) {
            const leading = (grid[cell.y] || []).filter((_, x) => !dayCols.has(x)).map(c => c?.text || '').join(' ');
            period = timeRange(leading);
            if(cell.rs>1){
              const trailing=(grid[cell.y+cell.rs-1]||[]).filter((_,x)=>!dayCols.has(x)).map(c=>c?.text||'').join(' ');
              const last=timeRange(trailing)||timeRange(options.periods?.[cell.y+cell.rs-1-header]||'');
              if(period&&last)period=[period[0],period[1],last[2]];
              else if(period&&!last)throw new Error(label+'：合并单元格缺少结束节次时间');
            }
            if (!period && options.periods?.[cell.y - header]) period = timeRange(options.periods[cell.y - header]);
          }
          if (!period || !weekText || !name || name.length > 80) { problems.push(`${label}“${name.slice(0, 35)}”：需要明确的起止时间、周次和课程名`); continue; }
          const weeks = parseWeeks(weekText[1], options.term?.weeks || 30);
          courses.push({ id: `school-${stable(`${dayCols.get(cell.x)}|${name}|${period[1]}|${period[2]}|${weekText[0]}|${room}`)}`, name, teacher, room, slots: [{ id: 's1', day: dayCols.get(cell.x), start: time(period[1]), end: time(period[2]) }], weeks, weekMode: weekText[2] === '单' ? 'odd' : weekText[2] === '双' ? 'even' : 'all', notes: block, origin: 'school', sourceURL: payload.origin + (payload.path || '') });
        }
      }
      if (problems.length) throw new Error(problems.join('；'));
      if (!courses.length) throw new Error('没有识别到课程。');
      const normalized = normalizePlan({ courses, term: options.term });
      return { school: true, courses: normalized.courses, events: [], warnings: ['请核对所有课名、周次、时间、教室。课程表未标明的教师和地点保留为空。'] };
    } catch (error) { failures.push(error.message); }
  }
  throw new Error(failures[0] || '未找到课表表格。请在学校官网打开个人课表。');
}
function stable(s) { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.codePointAt(0), 16777619); return (h >>> 0).toString(36); }

// Runs only after the owner clicks a bookmark on their logged-in school page.
// No HTTP requests, cookies, passwords, storage reads or hidden input values.
function extractVisibleTimetable(targetURL) {
  if (!/(^|\.)cumtb\.edu\.cn$/.test(location.hostname)) { alert('请在矿大官网的个人课表页面使用。'); return; }
  const docs = [document];
  document.querySelectorAll('iframe').forEach(frame => { try { if (frame.contentDocument) docs.push(frame.contentDocument); } catch {} });
  const candidates = docs.flatMap(doc => [...doc.querySelectorAll('table')]).filter(t => t.getBoundingClientRect().width > 0 && /星期[一二三四五]|周[一二三四五]|课程名称/.test(t.innerText));
  const tables = candidates.filter(t => ![...t.querySelectorAll('table')].some(inner => candidates.includes(inner))).slice(0, 15).map(t => [...t.rows].filter(r => r.getBoundingClientRect().height > 0).map(r => [...r.cells].map(c => ({ text: c.innerText.trim(), rowSpan: c.rowSpan, colSpan: c.colSpan }))));
  if (!tables.length) { alert('未找到可见课表。请切到个人课表的列表或周表页面后再点。'); return; }
  const payload = { format: 'luokixi-school-table', origin: location.origin, path: location.pathname, tables };
  if (JSON.stringify(payload).length > 500000) { alert('课表内容太多，请只打开个人课表。'); return; }
  const receiverOrigin = new URL(targetURL).origin;
  const popup = window.open(targetURL, 'luokixi-school-import');
  let done = false;
  const listener = e => { if (e.source === popup && e.origin === receiverOrigin && e.data?.type === 'luokixi:school-ready') { popup.postMessage({ type: 'luokixi:school-table', payload }, receiverOrigin); done = true; window.removeEventListener('message', listener); } };
  window.addEventListener('message', listener);
  setTimeout(() => { window.removeEventListener('message', listener); if (!done) { const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = '矿大课表.school.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 20000); alert('浏览器未允许窗口互通，课表已保存为文件。在 Luokixi 中选择此文件即可继续。'); } }, 12000);
}
export function schoolBookmarklet(origin) {
  return 'javascript:' + encodeURIComponent(`(${extractVisibleTimetable.toString()})(${JSON.stringify(new URL('planner.html?school-import=1', origin + '/').href)})`);
}
