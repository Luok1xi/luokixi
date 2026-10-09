import { normalizePlan, occurrences, addDays } from './campus-plan.js';

export const minutesOf = time => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
export function timeOf(value) {
  if (!Number.isInteger(value) || value < 0 || value >= 1440) throw new Error('安排需要在当天内结束。');
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}
export const isFixed = item => item?.source === 'course' || item?.source === 'reservation' || item?.event?.fixed === true || item?.event?.tags?.includes('预约记录');

// A single write transaction in the caller persists this checked candidate.
// A repeated task moves only this occurrence; the remaining series stays intact.
export function placeTask(raw, item, date, startMinute, duration, { unschedule = false, beforeId = null, newId = () => crypto.randomUUID() } = {}) {
  const plan = normalizePlan(raw);
  if (!item || isFixed(item)) throw new Error('学校课程的时间已锁定，请重新导入学校最新课表。');
  const source = plan.events.find(e => e.id === item.sourceId);
  if (!source || source.fixed) throw new Error('安排已变动，请刷新后重试。');
  addDays(date, 0);
  if (!Number.isInteger(duration) || duration < 15 || duration > 960) throw new Error('时长应为 15 分钟至 16 小时。');
  const start = timeOf(startMinute), end = timeOf(startMinute + duration);
  if (!unschedule) {
    const occupied = occurrences(plan, date, date).filter(x => x.id !== item.id && !(source.unscheduled && x.sourceId === source.id));
    const collision = occupied.find(x => start < x.end && end > x.start);
    if (collision) throw new Error(`与“${collision.title}”的 ${collision.start}–${collision.end} 重叠，请选择空闲时间。`);
  }
  let moved=source;
  if (source.repeat === 'weekly' && !source.unscheduled) {
    plan.hiddenOccurrences = [...new Set([...plan.hiddenOccurrences, item.id])];
    moved={ ...source, id: newId(), date, start, end, repeat: 'none', until: '', unscheduled: unschedule };plan.events.push(moved);
  } else Object.assign(source, { date, start, end, unscheduled: unschedule });
  if(unschedule&&beforeId&&beforeId!==moved.id){const index=plan.events.findIndex(e=>e.id===beforeId);if(index>=0){plan.events=plan.events.filter(e=>e.id!==moved.id);plan.events.splice(plan.events.findIndex(e=>e.id===beforeId),0,moved);}}
  return normalizePlan(plan);
}

export function reminderDue(item, settings, now) {
  const source = item.course || item.event || {};
  const atStart = source.remindAtStart === true;
  const lead = atStart ? 0 : (source.reminderMinutes ?? settings.reminderMinutes);
  if (!atStart && !lead) return false;
  const start = Date.parse(`${item.date}T${item.start}:00+08:00`);
  const due = start - lead * 60000;
  return now >= due && now < due + 60000;
}

// Reimport replaces only the explicitly selected school schedule. Personal edits survive.
export function mergeSchoolSchedule(raw, incoming) {
  const next=normalizePlan(raw), old=next.courses.filter(c=>c.origin==='school');
  const ids=new Set([...old.map(c=>'course:'+encodeURIComponent(c.id)+':'),...next.events.filter(e=>e.fixed).map(e=>'event:'+encodeURIComponent(e.id)+':')]);
  const courses=(incoming.courses||[]).map(c=>{
    const previous=old.find(x=>x.id===c.id)||old.find(x=>x.name===c.name&&x.teacher===c.teacher&&x.slots[0]?.day===c.slots[0]?.day);
    return {...c,...(previous?{id:previous.id,building:previous.building,notes:previous.notes,reminderMinutes:previous.reminderMinutes,color:previous.color,tags:previous.tags}:{}),origin:'school'};
  });
  next.courses=[...next.courses.filter(c=>c.origin!=='school'),...courses];
  next.events=[...next.events.filter(e=>!e.fixed),...(incoming.events||[]).map(e=>({...e,fixed:true}))];
  next.hiddenOccurrences=next.hiddenOccurrences.filter(id=>![...ids].some(prefix=>id.startsWith(prefix)));
  return normalizePlan(next);
}

// Placement is pure: preview and commit use the same result. Private lessons never
// leave the device, and only a source's own editable schedule can yield.
export function previewPlacement(items, source, date, startMinute, duration) {
  const reject = (message, blocked = []) => ({ ok: false, message, blocked, moves: [], yielded: [] });
  if (!source || source.canManage === false || isFixed(source)) return reject('这项安排的时间已锁定。', source ? [source] : []);
  if (!Number.isInteger(startMinute) || !Number.isInteger(duration) || duration < 15 || duration > 960 || startMinute < 0 || startMinute + duration > 1439) return reject('请放在当天可用的时段内。');
  const siblings = items.filter(item => item.id !== source.id && item.date === date);
  const movable = item => !isFixed(item) && item.canManage !== false && (source.source === 'club'
    ? item.source === 'club' && source.clubId === item.clubId
    : item.source === 'event' && source.source === 'event');
  const start = startMinute, end = start + duration;
  const overlap = (a, b) => a.start < b.end && a.end > b.start;
  const interval = item => ({ start: minutesOf(item.start), end: minutesOf(item.end) });
  const pinned = siblings.filter(item => !movable(item));
  const blocked = pinned.filter(item => overlap({ start, end }, interval(item)));
  if (blocked.length) return reject(blocked.some(isFixed) ? '固定课程或预约不让位，换个时间。' : '与另一项共享活动冲突，换个时间。', blocked);
  const moves = [{ item: source, date, start: timeOf(start), end: timeOf(end) }];
  const changedIntervals = [{ start, end }];
  const occupied = [{ start, end }, ...pinned.map(interval)];
  // Preserve original ordering. Cascades skip locked intervals; they never move
  // a lesson, reservation, another club, or an event owned by someone else.
  for (const item of siblings.filter(movable).sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id))) {
    const original = interval(item), length = original.end - original.start;
    if (!changedIntervals.some(changed => overlap(original, changed))) { occupied.push(original); continue; }
    let candidate = { ...original }, guard = 0;
    while (true) {
      const hit = occupied.filter(busy => overlap(candidate, busy)).sort((a,b) => a.end - b.end)[0];
      if (!hit) break;
      candidate = { start: Math.ceil(hit.end / 15) * 15, end: Math.ceil(hit.end / 15) * 15 + length };
      if (candidate.end > 1439 || ++guard > siblings.length + 2) return reject('后面的时间不够，无法让开。', [item]);
    }
    occupied.push(candidate);
    if (candidate.start !== original.start) { moves.push({ item, date, start: timeOf(candidate.start), end: timeOf(candidate.end) }); changedIntervals.push(candidate); }
  }
  return { ok: true, moves, yielded: moves.slice(1), blocked: [], message: moves.length > 1 ? `${moves.length - 1} 项活动会顺延` : '松手安排' };
}

export function applyLocalPlacement(raw, placement, { newId = () => crypto.randomUUID() } = {}) {
  if (!placement?.ok) throw new Error(placement?.message || '此时间不能安排。');
  const next = normalizePlan(raw);
  for (const move of placement.moves) {
    if (move.item.source !== 'event' || isFixed(move.item)) throw new Error('不能改动这项固定安排。');
    const source = next.events.find(event => event.id === move.item.sourceId);
    if (!source || source.fixed) throw new Error('安排已更新，请刷新后重试。');
    if (source.repeat === 'weekly' && !source.unscheduled) {
      next.hiddenOccurrences = [...new Set([...next.hiddenOccurrences, move.item.id])];
      next.events.push({ ...source, id: newId(), date: move.date, start: move.start, end: move.end, unscheduled: false, repeat: 'none', until: '' });
    } else Object.assign(source, { date: move.date, start: move.start, end: move.end, unscheduled: false });
  }
  // Guard against stale previews or a caller trying to bypass the collision check.
  for (const move of placement.moves) {
    const rows = occurrences(next, move.date, move.date);
    const moved = rows.find(row => row.sourceId === move.item.sourceId && row.start === move.start && row.end === move.end);
    if (moved && rows.some(row => row.id !== moved.id && row.start < moved.end && row.end > moved.start)) throw new Error('时间已被占用，请重新安排。');
  }
  return normalizePlan(next);
}
