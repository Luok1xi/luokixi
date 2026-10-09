import { dateMinute, dateKey, startOfDay, weekday, overlap } from './time.mjs';

export const defaultSettings = {
  wake: '07:00', sleep: '23:00', morning: '07:10', evening: '21:30',
  quietStart: '22:30', quietEnd: '07:00', horizon: 14, dailyMinutes: 300,
  focusMax: 90, breakMinutes: 10, reminderLead: 10, maxReminders: 8,
  remindersPaused: false, semesterStart: '2026-09-07',
  meals: [{ start: '07:15', end: '07:40', title: '早餐' }, { start: '12:00', end: '12:40', title: '午餐' }, { start: '18:00', end: '18:40', title: '晚餐' }]
};

export function fixedBlocks(state, now) {
  const cfg = state.settings;
  const first = startOfDay(now), last = first + cfg.horizon * 1440;
  const blocks = [], warnings = [];
  for (let d = first; d < last; d += 1440) {
    const day = dateKey(d), wake = dateMinute(day, cfg.wake), sleep = dateMinute(day, cfg.sleep);
    blocks.push({ id: `sleep-am:${day}`, start: d, end: wake, kind: 'rest', title: '睡眠' }, { id: `sleep-pm:${day}`, start: sleep, end: d + 1440, kind: 'rest', title: '睡眠' });
    for (const [i, meal] of cfg.meals.entries()) blocks.push({ id: `meal:${day}:${i}`, kind: 'meal', title: meal.title, start: dateMinute(day, meal.start), end: dateMinute(day, meal.end) });
    const week = Math.floor((d - dateMinute(cfg.semesterStart)) / (7 * 1440)) + 1;
    for (const course of state.courses.filter(c => c.weekday === weekday(d) && week >= c.weekFrom && week <= c.weekTo && (c.parity === 'all' || week % 2 === (c.parity === 'odd' ? 1 : 0)) && !c.cancelledDates.includes(day))) {
      const start = dateMinute(day, course.start), end = dateMinute(day, course.end);
      blocks.push({ id: `class:${course.id}:${day}`, sourceId: course.id, kind: 'course', title: course.title, location: course.location, start, end, week });
      if (course.travelBefore) blocks.push({ id: `travel-in:${course.id}:${day}`, kind: 'travel', title: `前往${course.location || course.title}`, start: start - course.travelBefore, end: start, assumption: '按课程预留通勤时间；未使用实时定位' });
      if (course.travelAfter) blocks.push({ id: `travel-out:${course.id}:${day}`, kind: 'travel', title: '课后通勤', start: end, end: end + course.travelAfter, assumption: '按课程预留通勤时间' });
    }
  }
  for (const block of state.blocks) if (block.end > first && block.start < last) blocks.push({ ...block, kind: 'fixed' });
  const sorted = blocks.filter(b => b.end > b.start).sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
  for (let i = 0; i < sorted.length; i++) for (let j = i + 1; j < sorted.length && sorted[j].start < sorted[i].end; j++) {
    const a = sorted[i], b = sorted[j];
    if (overlap(a, b)) warnings.push({ type: 'fixed_conflict', date: dateKey(Math.max(a.start,b.start)), message: `${dateKey(Math.max(a.start,b.start))}：${a.title}与${b.title}重叠，需要调整固定安排。` });
  }
  return { blocks: sorted, warnings };
}

function freeGaps(occupied, start, end) {
  let cursor = start; const gaps = [];
  for (const b of occupied.filter(b => b.end > start && b.start < end).sort((a,b) => a.start-b.start)) {
    if (b.start > cursor) gaps.push({ start: cursor, end: Math.min(b.start, end) });
    cursor = Math.max(cursor, b.end);
  }
  if (cursor < end) gaps.push({ start: cursor, end });
  return gaps;
}

// Deterministic EDF heuristic, not a claim of global mathematical optimality.
// Only actual user-reported progress reduces remaining work. Passage of time never does.
function compute(state, now, preserve = false) {
  const cfg = state.settings, horizonEnd = startOfDay(now) + cfg.horizon * 1440;
  const fixed = fixedBlocks(state, now), occupied = [...fixed.blocks];
  const allocations = [], unscheduled = [], used = new Map();
  for (const log of state.workLogs) if (log.at >= startOfDay(now)) used.set(dateKey(log.at), (used.get(dateKey(log.at)) || 0) + log.minutes);
  const tasks = state.tasks.filter(t => t.status === 'open' && t.remaining > 0).sort((a,b) => a.deadline-b.deadline || b.priority-a.priority || a.createdAt-b.createdAt || a.id.localeCompare(b.id));
  const lockedByTask=new Map();
  for(const task of tasks){const old=(state.plan?.allocations||[]).find(b=>b.taskId===task.id&&b.start<now&&b.end>now);if(!old)continue;const duration=Math.min(task.remaining,old.end-now,Math.max(0,task.deadline-now));if(!duration)continue;const locked={...old,end:now+duration,ongoing:true};
    if(occupied.some(b=>overlap(b,{start:now,end:locked.end}))){fixed.warnings.push({type:'ongoing_conflict',date:dateKey(now),message:`「${task.title}」的当前时段与新的固定安排冲突，剩余时间已重新计算。`});continue;}
    lockedByTask.set(task.id,duration);allocations.push(locked);occupied.push({start:now-cfg.breakMinutes,end:locked.end+cfg.breakMinutes});used.set(dateKey(now),(used.get(dateKey(now))||0)+duration);
  }
  for (const task of tasks) {
    let remaining = task.remaining-(lockedByTask.get(task.id)||0);
    const eligible = Math.max(now, task.notBefore || now, state.restUntil || 0);
    // A block already in progress remains in place. Only its future minutes reserve remaining work.
    // Explicit completion/cancellation removes it; explicit remaining-time edits may shorten it.
    const add = (start, duration) => {
      const b={id:`task:${task.id}:${start}:${start+duration}`,taskId:task.id,title:task.title,kind:'task',start,end:start+duration,location:task.location,deadline:task.deadline};
      allocations.push(b);occupied.push({start:b.start-cfg.breakMinutes,end:b.end+cfg.breakMinutes,kind:'task_buffer'});
      used.set(dateKey(start),(used.get(dateKey(start))||0)+duration);remaining-=duration;
    };
    if(preserve) for(const old of (state.plan?.allocations||[]).filter(b=>b.taskId===task.id&&b.start>=eligible&&b.end<=Math.min(task.deadline,horizonEnd))) {
      const duration=old.end-old.start, minimum=Math.min(task.minBlock,task.remaining);
      if(duration>remaining||(!task.splittable&&duration!==remaining)||duration>cfg.focusMax&&task.splittable||remaining>duration&&remaining-duration<minimum)continue;
      if((used.get(dateKey(old.start))||0)+duration>(state.dailyCaps[dateKey(old.start)]??cfg.dailyMinutes))continue;
      if(!occupied.some(b=>overlap(b,old)))add(old.start,duration);
    }
    for (let d = startOfDay(now); d < horizonEnd && remaining > 0; d += 1440) {
      const cap = Math.max(0, (state.dailyCaps[dateKey(d)] ?? cfg.dailyMinutes) - (used.get(dateKey(d)) || 0));
      let availableCap = cap;
      const end = Math.min(d + 1440, task.deadline, horizonEnd);
      if (Math.max(d,eligible) >= end || !cap) continue;
      const gaps = freeGaps(occupied, Math.max(d, eligible), end);
      for (const gap of gaps) {
        let cursor = gap.start;
        while (remaining > 0 && availableCap > 0) {
          const limit = Math.min(gap.end - cursor, availableCap, task.splittable ? cfg.focusMax : remaining);
          let duration = Math.min(remaining, limit);
          const minimum = Math.min(task.minBlock, task.remaining);
          if (!task.splittable && duration < remaining) break;
          // Avoid creating a final fragment smaller than the configured minimum.
          if (task.splittable && remaining > duration && remaining-duration < minimum) duration = remaining-minimum;
          if (duration < minimum || duration <= 0) break;
          add(cursor,duration);availableCap-=duration;cursor+=duration+cfg.breakMinutes;
        }
      }
    }
    if (remaining) unscheduled.push({ taskId: task.id, title: task.title, minutes: remaining, reason: task.deadline <= now ? '已过截止时间，需要重新约定' : task.deadline > horizonEnd ? `未来 ${cfg.horizon} 天暂未排完；更远日期尚未计算` : '当前约束下暂未排入；请减少任务量、调整截止时间或固定安排', deadline: task.deadline });
  }
  const previous = state.plan?.allocations || [];
  const changes = [];
  for (const id of new Set([...previous, ...allocations].map(b=>b.taskId))) {
    const before = previous.filter(b=>b.taskId===id && b.end>now), after = allocations.filter(b=>b.taskId===id);
    if (JSON.stringify(before.map(b=>[b.start,b.end])) !== JSON.stringify(after.map(b=>[b.start,b.end]))) changes.push({ taskId:id, title: state.tasks.find(t=>t.id===id)?.title || before[0]?.title || '', before, after });
  }
  return { generatedAt:now, horizonEnd, fixed:fixed.blocks, allocations:allocations.sort((a,b)=>a.start-b.start), unscheduled, warnings:fixed.warnings, changes };
}

export function plan(state,now){
  const earliest=compute(state,now,false);
  if(!state.plan?.allocations?.length)return earliest;
  const stable=compute(state,now,true);
  // Keep old slots only if no task loses deadline coverage compared with the baseline.
  const shortfall=new Map(earliest.unscheduled.map(t=>[t.taskId,t.minutes]));
  return stable.unscheduled.some(t=>t.minutes>(shortfall.get(t.taskId)||0))?earliest:stable;
}
