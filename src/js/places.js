// 校园地点：分类、图标和时间格式。
// 分类键与 campus/hub/places.py 的 TYPES 一一对应；显示名以服务端 /map/places 返回的 placeTypes 为准，这里只是没有连接服务时的兜底。
// 排列顺序按“逛校园”的习惯：先学习和吃饭，最后是同学的新发现。

export const PLACE_TYPES = {
  study: {
    name: '学习空间', hue: 212,
    glyph: '<path d="M3 5.6c3-1.1 6-.9 9 1.1 3-2 6-2.2 9-1.1v13.2c-3-1.1-6-.9-9 1.1-3-2-6-2.2-9-1.1z"/><path d="M12 6.7v13.2"/>',
  },
  food: {
    name: '饮食', hue: 26,
    glyph: '<path d="M3.5 11.5h17a8.5 8.5 0 0 1-17 0z"/><path d="M9 3.8c-.9 1 .9 2.1 0 3.2M13.5 3.8c-.9 1 .9 2.1 0 3.2"/>',
  },
  sports: {
    name: '运动', hue: 142,
    glyph: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.6 2.4 2.6 14.6 0 17M12 3.5c-2.6 2.4-2.6 14.6 0 17"/>',
  },
  scenery: {
    name: '风景', hue: 176,
    glyph: '<path d="m2.8 19 6.4-9.2 4.2 5.4 3-3.6 4.8 7.4z"/><circle cx="16.6" cy="6.4" r="2"/>',
  },
  facility: {
    name: '校园设施', hue: 252,
    glyph: '<path d="M4.5 20V8.8L12 4.5l7.5 4.3V20"/><path d="M9.5 20v-5h5v5M3 20h18"/>',
  },
  event: {
    name: '活动', hue: 334,
    glyph: '<path d="M5.5 21V3.8"/><path d="M5.5 4.2h11.8l-2.4 4.1 2.4 4.1H5.5"/>',
  },
  discovery: {
    name: '同学发现', hue: 46,
    glyph: '<path d="M11 3.5c.7 4.4 2.9 6.6 7.3 7.3-4.4.7-6.6 2.9-7.3 7.3-.7-4.4-2.9-6.6-7.3-7.3 4.4-.7 6.6-2.9 7.3-7.3z"/><path d="M18.6 15.2c.3 1.7 1.1 2.5 2.8 2.8-1.7.3-2.5 1.1-2.8 2.8-.3-1.7-1.1-2.5-2.8-2.8 1.7-.3 2.5-1.1 2.8-2.8z"/>',
  },
};

export const glyphSVG = (type) => `<svg class="glyph" viewBox="0 0 24 24" aria-hidden="true">${PLACE_TYPES[type]?.glyph ?? ''}</svg>`;

// ---------- 时间 ----------
// 校园在北京，统一按北京时间显示，换了时区的浏览器看到的也是同一个钟点。

const BJ = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const parts = (t) => Object.fromEntries(BJ.formatToParts(t).map((p) => [p.type, p.value]));
const dayKey = (p) => `${p.year}-${p.month}-${p.day}`;

export function fmtTime(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const p = parts(t);
  const clock = `${p.hour}:${p.minute}`;
  const rel = { [dayKey(parts(Date.now()))]: '今天', [dayKey(parts(Date.now() - 86400e3))]: '昨天', [dayKey(parts(Date.now() + 86400e3))]: '明天' };
  return `${rel[dayKey(p)] ?? `${p.month}月${p.day}日`} ${clock}`;
}

export function timeLeft(iso) {
  const ms = Date.parse(iso) - Date.now();
  if (Number.isNaN(ms)) return '';
  if (ms <= 0) return '已过期';
  const h = ms / 3600e3;
  if (h < 1) return `还剩 ${Math.max(1, Math.round(ms / 60e3))} 分钟`;
  if (h < 48) return `还剩 ${Math.round(h)} 小时`;
  return `还剩 ${Math.round(h / 24)} 天`;
}

// <input type="datetime-local"> 用的是浏览器本地时间、不带时区；服务端要求带时区的完整时间
const pad = (n) => String(n).padStart(2, '0');
export const toLocalInput = (d) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

export function withOffset(localValue) {
  const d = new Date(localValue);
  if (Number.isNaN(d.getTime())) return '';
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${toLocalInput(d)}:00${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}
