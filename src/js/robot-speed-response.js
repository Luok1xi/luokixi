// 单趟板载记录的离线分析；只统计已有采样，不插值、不平滑、不推断缺失数据。
import { parseCSV } from './robot-live-data.js';

export const SPEED_COLUMNS = ['index', 't', 'setL', 'setR', 'encL', 'encR', 'pwmL', 'pwmR', 'gyro_dps', 'yaw_target_dps', 'phase'];
const finite = value => typeof value === 'number' && Number.isFinite(value);
const metadataKeys = ['dt_ms', 'stride', 'side', 'target', 'fan_pct', 'kpL', 'kiL', 'kpR', 'kiR', 'akp', 'aki', 'build', 'profile', 'n'];

export function normalizeSpeedCapture(input) {
  if (!Array.isArray(input?.rows) || !input.rows.length || input.rows.length > 20000) throw Error('记录必须包含 1～20000 个采样点');
  let previous = -Infinity;
  const rows = input.rows.map((row, i) => {
    if (!finite(row.t) || row.t <= previous) throw Error(`第 ${i + 1} 行时间无效、重复或倒退`);
    previous = row.t;
    return Object.fromEntries(SPEED_COLUMNS.map(key => [key, finite(row[key]) ? row[key] : NaN]));
  });
  if (!rows.some(row => finite(row.encL) || finite(row.encR))) throw Error('记录没有 encL 或 encR 速度反馈');
  const header = {};
  for (const key of metadataKeys) {
    const value = input.header?.[key];
    if (finite(value) || typeof value === 'string' && value.length < 100) header[key] = value;
  }
  const issues = Array.isArray(input.issues) ? input.issues.slice(0, 10).map(x => String(x).slice(0, 160)) : [];
  const interval = Number(header.dt_ms) * Number(header.stride);
  if (interval > 0 && rows.some((row, i) => i && Math.abs(row.t - rows[i - 1].t - interval) > 0.01)) issues.push('采样时间中间有缺口');
  return { type: 'tune-capture', header, rows, issues: [...new Set(issues)], complete: input.complete === true && !issues.length };
}

// 外部 capture.csv 的 time_ms / t_ms 和网站 CSV 的 t 都以毫秒为单位。
export function importSpeedCSV(text) {
  if (text.length > 5 * 1024 * 1024) throw Error('CSV 超过 5 MB，请导入单次测试记录');
  const lines = text.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  let header = {};
  const meta = lines.find(line => line.startsWith('# speed-scope-meta '));
  if (meta) { try { header = JSON.parse(meta.slice(19)).header || {}; } catch { throw Error('CSV 的参数信息损坏'); } }
  const data = lines.filter(line => line.trim() && !line.startsWith('#'));
  const names = data.shift()?.split(',').map(x => x.trim()) || [];
  const time = ['t', 'time_ms', 't_ms'].find(key => names.includes(key));
  if (!time) throw Error('CSV 需要 t、time_ms 或 t_ms（毫秒）列');
  if (new Set(names).size !== names.length) throw Error('CSV 存在重复列名');
  if (!names.includes('encL') && !names.includes('encR')) throw Error('CSV 需要 encL 或 encR 速度反馈列');
  if (data.some(line => line.split(',').length !== names.length)) throw Error('CSV 有缺列，请检查原始文件');
  const normalizedNames = names.map(key => key === time ? 't' : key === 'i' ? 'index' : key);
  if (new Set(normalizedNames).size !== normalizedNames.length) throw Error('CSV 的索引列名重复');
  const rows = parseCSV([normalizedNames.join(','), ...data.map(line => line.split(',').map(cell => cell.trim()).join(','))].join('\n'));
  return normalizeSpeedCapture({ header, rows, complete: false, issues: ['CSV 导入：未核对车端结束标记及本次测试关联'] });
}

export function speedCSV(capture) {
  const metadata = JSON.stringify({ header: capture.header, complete: capture.complete, issues: capture.issues });
  return '# speed-scope-meta ' + metadata + '\n' + SPEED_COLUMNS.join(',') + '\n'
    + capture.rows.map(row => SPEED_COLUMNS.map(key => finite(row[key]) ? row[key] : '').join(',')).join('\n') + '\n';
}

// 恒定目标的单次 0 → 目标 → 0 阶跃；动态轮速分配不能用单个阶跃指标评价。
export function speedResponse(capture, side = 'L') {
  const rows = capture.rows, targetKey = `set${side}`, feedbackKey = `enc${side}`;
  if (capture.header?.profile === 'live-hold') {
    return { available: false, reason: '持续调速只保留停车前最近一段，显示实际目标与反馈，不计算单次阶跃指标' };
  }
  if (capture.header?.profile === 'low-high-low') {
    const base = rows.find(row => row.phase === 0)?.[targetKey];
    const high = rows.find(row => row.phase === 1)?.[targetKey];
    return { available: false, reason: !finite(high) ? '未记录到升档段，只显示已有波形'
      : high === base ? '恒速诊断，没有高低阶跃，只显示波形'
      : '低速到高速阶跃，保留原始波形供对照' };
  }
  const begin = rows.findIndex(row => finite(row[targetKey]) && Math.abs(row[targetKey]) > 0);
  const unavailable = reason => ({ available: false, reason });
  if (begin < 0) return unavailable('这一侧没有非零目标');
  const target = rows[begin][targetKey], sign = Math.sign(target), amplitude = Math.abs(target);
  let end = rows.findIndex((row, i) => i > begin && row[targetKey] === 0);
  if (end < 0) end = rows.length;
  const active = rows.slice(begin, end), startMs = rows[begin].t, endMs = rows[end]?.t ?? rows.at(-1).t;
  if (active.some(row => !finite(row[targetKey]) || Math.abs(row[targetKey] - target) > 0.001)) return unavailable('目标不是恒定阶跃，只显示波形');
  if (rows.slice(end).some(row => finite(row[targetKey]) && row[targetKey] !== 0)) return unavailable('包含多次阶跃，请分别导入单趟记录');
  if (active.some(row => !finite(row[feedbackKey]))) return unavailable('阶跃期间反馈有缺值，不计算响应指标');
  const deltas = rows.slice(1).map((row, i) => row.t - rows[i].t), dt = Number(capture.header.dt_ms) * Number(capture.header.stride) || Math.min(...deltas);
  if (!(dt > 0) || dt > 20 || active.some((row, i) => i && row.t - active[i - 1].t > dt * 1.5)) return unavailable('采样过稀或阶跃期间缺行，不计算响应指标');
  const values = active.map(row => row[feedbackKey] * sign);
  const at10 = active.findIndex(row => row[feedbackKey] * sign >= amplitude * 0.1);
  const at90 = active.findIndex((row, i) => i >= Math.max(0, at10) && row[feedbackKey] * sign >= amplitude * 0.9);
  const platformStartMs = startMs + 300;
  const platform = active.filter(row => row.t >= platformStartMs).map(row => row[feedbackKey]);
  const high = Math.max(...values), hasPreStep = begin > 0 && rows[begin - 1][targetKey] === 0;
  const tail = rows.slice(end), settled = tail.filter(row => finite(row[feedbackKey]));
  let returnMs = null;
  if (end < rows.length && settled.length === tail.length && !tail.some((row, i) => i && row.t - tail[i - 1].t > dt * 1.5)) {
    const lastOutside = settled.findLastIndex(row => Math.abs(row[feedbackKey]) > amplitude * 0.1);
    const firstInside = settled[lastOutside + 1];
    if (firstInside && rows.at(-1).t - firstInside.t >= 100) returnMs = firstInside.t - endMs;
  }
  return {
    available: true, target, startMs, endMs, platformStartMs, dt,
    completePulse: hasPreStep && end < rows.length,
    riseMs: hasPreStep && at10 >= 0 && at90 >= 0 ? active[at90].t - active[at10].t : null,
    overshootPct: hasPreStep ? Math.max(0, (high - amplitude) / amplitude * 100) : null,
    mean: platform.length >= 2 ? platform.reduce((sum, v) => sum + v, 0) / platform.length : null,
    peakToPeak: platform.length >= 2 ? Math.max(...platform) - Math.min(...platform) : null,
    platformN: platform.length, returnMs,
  };
}

export function scopeRange(capture, side, section = 'all') {
  const all = [capture.rows[0].t, capture.rows.at(-1).t];
  if (section === 'all') return all[0] < all[1] ? all : [all[0], all[0] + 2];
  const r = speedResponse(capture, side);
  if (!r.available) return all[0] < all[1] ? all : [all[0], all[0] + 2];
  const ranges = { rise: [r.startMs - 50, r.startMs + 300], plateau: [r.platformStartMs, r.endMs], fall: [r.endMs - 50, r.endMs + 400] };
  const range = ranges[section] || all;
  const lo = Math.max(all[0], range[0]), hi = Math.min(all[1], range[1]);
  return hi > lo ? [lo, hi] : all;
}

// 光标与读数锁到同一个实际采样点；缺值保留，不借邻居的值替代。
export function nearestSpeedSample(capture, time) {
  const rows = capture.rows;
  let lo = 0, hi = rows.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (rows[mid].t < time) lo = mid + 1; else hi = mid; }
  let index = Math.min(rows.length - 1, lo);
  if (index > 0 && time - rows[index - 1].t <= rows[index].t - time) index--;
  return { row: rows[index], index };
}

export function captureFingerprint(capture) {
  let hash = 2166136261;
  const text = speedCSV(capture);
  for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return (hash >>> 0).toString(16);
}
