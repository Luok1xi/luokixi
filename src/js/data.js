// 数据读取与统计。数据格式见 docs/DATA.md。
import { withLocalResources } from '../../campus/catalogue-overlay.js';
import {applyEditorial} from './editorial-data.js';
const cache = new Map();

export function load(name) {
  if (!cache.has(name)) {
    cache.set(
      name,
      fetch(`data/${name}.json`, { cache: 'no-cache' }).then((r) => {
        if (!r.ok) throw new Error(`data/${name}.json ${r.status}`);
        return r.json();
      }).then(withLocalResources).then(d=>applyEditorial(name,d)),
    );
  }
  return cache.get(name);
}

export const MONTH_LABEL = (m) => `${m} 月`;

export function catalogStats(cat) {
  const sets = cat.sessions.flatMap((s) => s.sets);
  const years = [...new Set(cat.sessions.map((s) => s.year))].sort((a, b) => b - a);
  const hasRes = (t) => Object.values(t.resources || {}).some(Boolean);
  return {
    sessions: cat.sessions.length,
    sets: sets.length,
    listening: sets.filter((t) => t.listening).length,
    ready: sets.filter(hasRes).length,
    years,
    from: years[years.length - 1],
    to: years[0],
  };
}

export function groupByYear(cat) {
  const map = new Map();
  for (const s of cat.sessions) {
    if (!map.has(s.year)) map.set(s.year, []);
    map.get(s.year).push(s);
  }
  return [...map.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([year, sessions]) => ({ year, sessions: sessions.sort((a, b) => b.month - a.month) }));
}

export function daysUntil(isoDate, now = new Date()) {
  const [y, m, d] = isoDate.split('-').map(Number);
  // 以北京时间 0 点为考试日起点
  const target = Date.UTC(y, m - 1, d) - 8 * 3600e3;
  return Math.ceil((target - now.getTime()) / 86400e3);
}

export const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
