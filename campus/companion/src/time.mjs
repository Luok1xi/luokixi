// All persisted instants are epoch minutes; calendar semantics are explicitly China time.
export const MINUTE = 60000;
export const nowMinute = () => Math.floor(Date.now() / MINUTE);
export const dateKey = t => new Date((t + 480) * MINUTE).toISOString().slice(0, 10);
export const clockText = t => new Date((t + 480) * MINUTE).toISOString().slice(11, 16);
export const stamp = t => `${dateKey(t)} ${clockText(t)}`;
export function dateMinute(date, clock = '00:00') {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(clock)) throw new Error('日期或时间格式不正确。');
  const n = Date.parse(`${date}T${clock}:00+08:00`) / MINUTE;
  if (!Number.isFinite(n) || dateKey(n) !== date) throw new Error('日期不存在。');
  return n;
}
export const startOfDay = t => dateMinute(dateKey(t));
export const weekday = t => new Date((t + 480) * MINUTE).getUTCDay() || 7;
export const overlap = (a, b) => a.start < b.end && b.start < a.end;
export function integer(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label}须为 ${min}—${max} 范围内的整数。`);
  return value;
}
export function text(value, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`请输入 1—${max} 个字符。`);
  return value.trim();
}
