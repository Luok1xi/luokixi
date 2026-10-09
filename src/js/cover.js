// 生成式封面：项目没有配图时，按分类生成一张深色“产品图”。
// 同一个 slug 每次生成的构图都一样（固定种子）。图形只用 SVG，静态绘制一次，不做逐帧动画。
import { CATEGORIES } from './schema.js';
import { artSlot, artImageHTML } from './art.js';

const hash = (s) => [...s].reduce((h, c) => (Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0), 2166136261);
const rng = (seed) => () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);

// 线稿图标，坐标系 0–100，中心 (50,50)
const GLYPHS = {
  gear: () => {
    const teeth = Array.from({ length: 10 }, (_, i) => {
      const a = (i / 10) * Math.PI * 2;
      const x = 50 + Math.cos(a) * 36;
      const y = 50 + Math.sin(a) * 36;
      return `<rect x="${x - 5}" y="${y - 7}" width="10" height="14" rx="2" transform="rotate(${(a * 180) / Math.PI + 90} ${x} ${y})"/>`;
    }).join('');
    return `${teeth}<circle cx="50" cy="50" r="30"/><circle cx="50" cy="50" r="11"/><path d="M50 20v8M50 72v8M20 50h8M72 50h8"/>`;
  },
  chip: () => {
    const pins = [24, 37, 50, 63, 76]
      .map((p) => `<path d="M${p} 8v12M${p} 80v12M8 ${p}h12M80 ${p}h12"/>`)
      .join('');
    return `<rect x="20" y="20" width="60" height="60" rx="8"/><rect x="34" y="34" width="32" height="32" rx="4"/>${pins}<circle cx="27" cy="27" r="2"/>`;
  },
  code: () =>
    `<rect x="8" y="16" width="84" height="68" rx="10"/><path d="M8 30h84"/><circle cx="18" cy="23" r="2"/><circle cx="26" cy="23" r="2"/><circle cx="34" cy="23" r="2"/>
     <path d="M36 46 24 57l12 11M64 46l12 11-12 11M55 42 45 74"/>`,
  graph: () => {
    const n = [[50, 14], [22, 40], [78, 40], [12, 76], [40, 70], [62, 74], [88, 80]];
    const e = [[0, 1], [0, 2], [1, 3], [1, 4], [2, 5], [2, 6], [4, 5]];
    return `${e.map(([a, b]) => `<path d="M${n[a][0]} ${n[a][1]}L${n[b][0]} ${n[b][1]}"/>`).join('')}${n
      .map(([x, y], i) => `<circle cx="${x}" cy="${y}" r="${i === 0 ? 8 : 6}" class="${i === 0 ? 'hot' : ''}"/>`)
      .join('')}`;
  },
  book: () =>
    `<path d="M50 24c-10-8-26-10-40-8v62c14-2 30 0 40 8 10-8 26-10 40-8V16c-14-2-30 0-40 8z"/><path d="M50 24v62"/>
     <path d="M20 32h20M20 42h20M20 52h16M60 32h20M60 42h20M60 52h16"/>`,
  atom: () =>
    `<ellipse cx="50" cy="50" rx="42" ry="15"/><ellipse cx="50" cy="50" rx="42" ry="15" transform="rotate(60 50 50)"/>
     <ellipse cx="50" cy="50" rx="42" ry="15" transform="rotate(-60 50 50)"/><circle cx="50" cy="50" r="6" class="hot"/>`,
};

export function coverSVG(project) {
  const cat = CATEGORIES[project.category] ?? CATEGORIES.software;
  const r = rng(hash(project.slug ?? project.title ?? 'x'));
  const h = cat.hue + Math.round((r() - 0.5) * 24);
  const id = `c${hash(project.slug ?? 'x').toString(36)}`;
  const gx = 250 + r() * 70;
  const gy = 110 + r() * 40;
  const rot = Math.round((r() - 0.5) * 30);
  const sparks = Array.from({ length: 14 }, () => {
    const x = (r() * 400).toFixed(1);
    const y = (r() * 250).toFixed(1);
    return `<circle cx="${x}" cy="${y}" r="${(r() * 1.4 + 0.4).toFixed(2)}" opacity="${(r() * 0.5 + 0.15).toFixed(2)}"/>`;
  }).join('');
  return `<svg viewBox="0 0 400 250" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" preserveAspectRatio="xMidYMid slice">
  <defs>
    <linearGradient id="${id}b" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="hsl(${h} 45% 13%)"/><stop offset="1" stop-color="hsl(${h + 40} 40% 5%)"/>
    </linearGradient>
    <radialGradient id="${id}g" cx="${gx / 400}" cy="${gy / 250}" r="0.55">
      <stop offset="0" stop-color="hsl(${h} 95% 62%)" stop-opacity=".75"/>
      <stop offset=".45" stop-color="hsl(${h + 50} 90% 55%)" stop-opacity=".22"/>
      <stop offset="1" stop-color="hsl(${h + 50} 90% 55%)" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="${id}s" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="hsl(${h} 90% 82%)"/>
    </linearGradient>
    <pattern id="${id}p" width="20" height="20" patternUnits="userSpaceOnUse">
      <path d="M20 0H0V20" fill="none" stroke="#fff" stroke-opacity=".05"/>
    </pattern>
  </defs>
  <rect width="400" height="250" fill="url(#${id}b)"/>
  <rect width="400" height="250" fill="url(#${id}p)"/>
  <rect width="400" height="250" fill="url(#${id}g)"/>
  <g fill="#fff">${sparks}</g>
  <g class="cover-glyph" transform="translate(${gx - 75} ${gy - 75}) rotate(${rot} 75 75) scale(1.5)"
     fill="none" stroke="url(#${id}s)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    ${GLYPHS[cat.glyph]().replace(/class="hot"/g, `fill="hsl(${h} 95% 65%)" stroke="none"`)}
  </g>
</svg>`;
}

export function coverHTML(project) {
  return `<div class="cover">${coverMediaHTML(project)}</div>`;
}

const escapeAttr = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const safeCover = (s) => typeof s === 'string' && (/^https:\/\/[^\s"<>]+$/.test(s) || /^(?:\/?art|files)\/[\w/-]+\.(?:webp|png|jpg|avif)$/.test(s) || /^\/api\/hub\/(?:source-media|illustration)\/[a-f0-9]{64}$/.test(s));
// Capture also covers lazy images added by subsequent feed pages. A broken
// remote or generated cover leaves the original vector visibly in place.
if (typeof document !== 'undefined') {
  document.addEventListener('load', (e) => {
    if (e.target?.matches?.('img.art-cover-image')) e.target.parentElement.classList.add('cover-loaded');
  }, true);
  document.addEventListener('error', (e) => {
    if (!e.target?.matches?.('img.art-cover-image')) return;
    const frame = e.target.parentElement;
    frame.classList.remove('cover-loaded');
    const label = frame.querySelector('.art-caption');
    if (label) label.textContent = '分类示意 · 暂无可用封面';
    e.target.remove();
  }, true);
}
function frameCover(project, image, concept) {
  return `<span class="art-cover${concept ? ' is-concept' : ''}"${project.coverCredit ? ` title="${escapeAttr(project.coverCredit)}"` : ''}><span class="art-cover-fallback" aria-hidden="true">${coverSVG(project)}</span>${image}<small class="art-caption">${concept ? '分类概念图 · 非项目实拍' : '分类示意 · 封面加载中'}</small></span>`;
}
export function coverMediaHTML(project) {
  if (safeCover(project.cover)) return frameCover(project, `<img class="art-img art-cover-image" src="${escapeAttr(project.cover)}" alt="${escapeAttr(project.title)} 项目封面" loading="lazy" decoding="async" referrerpolicy="no-referrer">`, false);
  const a = artSlot(`project-${project.category ?? 'software'}`);
  if (!a) return coverSVG(project);
  return frameCover(project, artImageHTML(a, {className:'art-cover-image', sizes:'(max-width:760px) 90vw, 600px'}), true);
}

// 分类线稿放进 App Store 式的方形图标里（.v3-icon），颜色跟随文字
export function glyphSVG(category) {
  const cat = CATEGORIES[category] ?? CATEGORIES.software;
  return `<svg viewBox="0 0 100 100" aria-hidden="true" style="stroke-width:6.5">${GLYPHS[cat.glyph]().replace(/class="hot"/g, 'fill="currentColor" stroke="none"')}</svg>`;
}
