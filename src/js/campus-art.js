// 校园探索首屏的示意插画：等轴视角的一块“校园地块”，底下露出一层层地层，其中一层用矿大红。
// 纯装饰，不对应任何真实建筑、道路和地点；图钉只表示“地图上会有这几类地点”。
// 坐标在单位网格里手写，由 iso() 投影成 SVG 坐标，保证所有面的透视一致。
import { PLACE_TYPES } from './places.js';

const S = 26; // 一个网格单位的像素长度
const OX = 320;
const OY = 150;
const C30 = Math.cos(Math.PI / 6);

const iso = (x, y, z = 0) => [OX + (x - y) * S * C30, OY + (x + y) * S * 0.5 - z * S];
const pts = (list) => list.map((p) => p.map((v) => v.toFixed(1)).join(',')).join(' ');
const poly = (fill, list, extra = '') => `<polygon fill="${fill}" points="${pts(list)}"${extra}/>`;
const line = (a, b, stroke, w = 1) =>
  `<line x1="${a[0].toFixed(1)}" y1="${a[1].toFixed(1)}" x2="${b[0].toFixed(1)}" y2="${b[1].toFixed(1)}" stroke="${stroke}" stroke-width="${w}"/>`;

// 地面上的一块平面（道路、操场、草地）
const patch = (x0, y0, x1, y1, fill, z = 0) => poly(fill, [iso(x0, y0, z), iso(x1, y0, z), iso(x1, y1, z), iso(x0, y1, z)]);

// 一栋抽象的楼：顶面最亮，朝左下的面次之，朝右下的面最暗；侧面画出楼层线
function box([x0, y0, x1, y1, h, light = 0]) {
  const top = `hsl(240 4% ${24 + light}%)`;
  const left = `hsl(240 4% ${17 + light * 0.6}%)`;
  const right = `hsl(240 4% ${13 + light * 0.4}%)`;
  let svg = poly(top, [iso(x0, y0, h), iso(x1, y0, h), iso(x1, y1, h), iso(x0, y1, h)]);
  svg += poly(left, [iso(x0, y1), iso(x1, y1), iso(x1, y1, h), iso(x0, y1, h)]);
  svg += poly(right, [iso(x1, y0), iso(x1, y1), iso(x1, y1, h), iso(x1, y0, h)]);
  for (let z = 0.5; z < h - 0.2; z += 0.5) {
    svg += line(iso(x0, y1, z), iso(x1, y1, z), 'rgba(255,255,255,.05)');
    svg += line(iso(x1, y0, z), iso(x1, y1, z), 'rgba(255,255,255,.04)');
  }
  svg += `<polyline fill="none" stroke="rgba(255,255,255,.16)" stroke-width="1" points="${pts([iso(x0, y1, h), iso(x1, y1, h), iso(x1, y0, h)])}"/>`;
  return svg;
}

function tree([x, y]) {
  const [cx, cy] = iso(x, y, 0.55);
  const [gx, gy] = iso(x, y, 0);
  return `<ellipse cx="${gx.toFixed(1)}" cy="${gy.toFixed(1)}" rx="9" ry="4.5" fill="rgba(0,0,0,.35)"/>
    <circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="9" fill="hsl(150 14% 21%)"/>
    <circle cx="${(cx - 2.5).toFixed(1)}" cy="${(cy - 3).toFixed(1)}" r="4.5" fill="hsl(150 14% 28%)"/>`;
}

// 地层：从上往下的厚度和左右两个侧面的颜色。只有一层用矿大红，面积远小于 10%。
const STRATA = [
  [0.3, '#3b342e', '#2e2924'],
  [0.42, '#2c2824', '#221f1c'],
  [0.16, '#c42238', '#94192b'],
  [0.48, '#36312b', '#2a2622'],
  [0.54, '#23201d', '#1a1816'],
];

function strata() {
  let z = 0;
  let svg = '';
  for (const [t, left, right] of STRATA) {
    const z1 = z - t;
    svg += poly(left, [iso(0, 10, z), iso(10, 10, z), iso(10, 10, z1), iso(0, 10, z1)]);
    svg += poly(right, [iso(10, 0, z), iso(10, 10, z), iso(10, 10, z1), iso(10, 0, z1)]);
    z = z1;
  }
  return svg;
}

const BUILDINGS = [
  [0.5, 0.6, 2.7, 5.1, 1.6, 2],
  [4.4, 0.6, 6.6, 2.8, 3.2, 4],
  [4.4, 3.4, 6.4, 5.1, 1.2, 0],
  [4.4, 6.8, 7.2, 8.6, 2.0, 2],
  [7.8, 6.8, 9.4, 9.4, 1.0, 0],
];
const TREES = [[7.5, 1.2], [8.9, 1.25], [7.4, 4.45], [8.95, 4.5], [9.2, 2.9]];

// 浮在地块上方的图钉：[x, y, 所在表面高度, 分类]
const PINS = [
  [1.6, 2.85, 1.6, 'study'],
  [8.1, 2.9, 0, 'discovery'],
  [1.65, 8.15, 0, 'sports'],
  [8.6, 8.1, 1.0, 'food'],
  [5.8, 7.7, 2.0, 'event'],
];

function pin([x, y, z, type], i) {
  const [sx, sy] = iso(x, y, z);
  const [tx, ty] = iso(x, y, z + 0.9);
  const h = PLACE_TYPES[type].hue;
  const fill = `hsl(${h} 85% ${type === 'discovery' ? 58 : 56}%)`;
  const ring = type === 'discovery' ? `<circle class="d-ring" cx="0" cy="-18" r="15" fill="none" stroke="${fill}" stroke-width="1.5"/>` : '';
  return `<ellipse class="d-shadow" style="--d:${(i * 0.55).toFixed(2)}s" cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" rx="8" ry="4" fill="rgba(0,0,0,.5)"/>
    <g transform="translate(${tx.toFixed(1)} ${ty.toFixed(1)})"><g class="d-bob" style="--d:${(i * 0.55).toFixed(2)}s">
      ${ring}<path d="M0 0C-2 -6-10-10-10-18A10 10 0 1 1 10-18C10-10 2-6 0 0Z" fill="${fill}"/>
      <circle cx="0" cy="-18" r="3.6" fill="#fff"/>
    </g></g>`;
}

export function dioramaSVG() {
  const ground = [iso(0, 0), iso(10, 0), iso(10, 10), iso(0, 10)];
  // 由远及近绘制，近处的东西盖住远处的
  const objects = [
    ...BUILDINGS.map((b) => [(b[0] + b[2]) / 2 + (b[1] + b[3]) / 2, box(b)]),
    ...TREES.map((t) => [t[0] + t[1], tree(t)]),
  ].sort((a, b) => a[0] - b[0]);
  return `<svg viewBox="40 20 560 450">
    <defs>
      <linearGradient id="d-edge" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="rgba(255,255,255,0)"/><stop offset=".5" stop-color="rgba(255,255,255,.22)"/><stop offset="1" stop-color="rgba(255,255,255,0)"/></linearGradient>
    </defs>
    ${strata()}
    ${poly('#1c1c1f', ground)}
    ${patch(3.2, 0, 3.8, 10, '#29292e')}
    ${patch(0, 5.7, 10, 6.3, '#29292e')}
    ${patch(7, 0.6, 9.6, 5.1, 'hsl(150 12% 13%)')}
    ${patch(0.5, 6.8, 2.8, 9.5, 'hsl(160 10% 14%)')}
    ${poly('none', [iso(0.8, 7.1), iso(2.5, 7.1), iso(2.5, 9.2), iso(0.8, 9.2)], ' stroke="rgba(255,255,255,.14)" stroke-width="1"')}
    ${line(iso(0.8, 8.15), iso(2.5, 8.15), 'rgba(255,255,255,.1)')}
    <polyline fill="none" stroke="url(#d-edge)" stroke-width="1.2" points="${pts([iso(0, 10), iso(10, 10), iso(10, 0)])}"/>
    ${objects.map((o) => o[1]).join('')}
    ${PINS.map(pin).join('')}
  </svg>`;
}
