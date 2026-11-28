// 书库卡片的印刷（Canvas 2D → 贴图）。格子有竖的、方的、横的、通栏的，所以每种卡都按格子的宽高比现排（w × h 像素）。
//   资料卡像流媒体的海报格：每门课一个色系（同一门课的资料是一家子颜色，每本再偏一点），斜着的渐变底、一团自己的光、
//     按资料类型画的图样（试卷：巨大的年份空心字；答案：同心圆和一个勾；听力：声波；课件：几张叠着的幻灯片；
//     笔记：手写的线；作业 / 题库：点阵；其余：几道弧）——图样只取它真实的类型、年份、题目，不编内容；
//     有卷面的，卷面斜放在色底上像一张拍出来的纸；有上传封面的，封面铺满。底下一层暗，左下是课名和题目。
//   海报：一门课开头那张，这门课的色系压暗当底，课名大字，卷面扇形摊开；
//   学科卡：每个学科开头那张，站内概念插画（写明 AI 绘制）铺满，学科名压在上面。
// hl：搜索词，题目里命中的字印成金色。
const css = (k, fb) => getComputedStyle(document.documentElement).getPropertyValue(k).trim() || fb;
const FONTS = () => ({ serif: css('--font-serif', 'serif'), sans: css('--font-sans', 'sans-serif'), mono: css('--font-mono', 'monospace') });
const PAPER = '#efeeeb', INK = '#121214', GOLD = '#e9b86a', GOLD_INK = '#a8691c';
const hash = (s) => { let h = 2166136261; for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; };

function canvas(w, h) { const c = new OffscreenCanvas(Math.max(1, Math.round(w)), Math.max(1, Math.round(h))); return [c, c.getContext('2d')]; }

// 中文按字断行，最多 max 行，超出加省略号；返回每行的字（保留每个字在原文里的序号，好标出命中的字）
function wrap(ctx, text, width, max) {
  const out = []; let cur = [];
  const chars = [...String(text || '')].map((ch, i) => ({ ch, i }));
  for (const c of chars) {
    const line = cur.map((x) => x.ch).join('') + c.ch;
    if (ctx.measureText(line).width > width && cur.length) { out.push(cur); cur = [c]; if (out.length === max) break; } else cur.push(c);
  }
  if (out.length < max && cur.length) out.push(cur);
  else if (out.length === max && cur.length && out[max - 1].at(-1)) out[max - 1] = [...out[max - 1].slice(0, -1), { ch: '…', i: -1 }];
  return out;
}
/** 命中的字的序号（不分大小写；搜索词按空格拆开） */
function hits(text, hl) {
  const set = new Set(), t = String(text || '').toLowerCase();
  for (const word of String(hl || '').toLowerCase().split(/\s+/).filter(Boolean)) {
    for (let at = t.indexOf(word); at >= 0; at = t.indexOf(word, at + 1)) for (let k = 0; k < word.length; k++) set.add(at + k);
  }
  return set;
}
function drawLines(ctx, rows, x, y, lh, color, hit, hitColor) {
  rows.forEach((row, r) => {
    let cx = x;
    for (const { ch, i } of row) { ctx.fillStyle = hit.has(i) ? hitColor : color; ctx.fillText(ch, cx, y + r * lh); cx += ctx.measureText(ch).width; }
  });
}
/** 按焦点裁满（fx / fy 0..1，默认偏上：卷面最有看头的是抬头那几行） */
function cover(ctx, img, x, y, w, h, fx = 0.5, fy = 0.12) {
  const r = Math.max(w / img.width, h / img.height), iw = img.width * r, ih = img.height * r;
  ctx.drawImage(img, x + (w - iw) * fx, y + (h - ih) * fy, iw, ih);
}
const yearOf = (x) => String(x.year || '').match(/\d{2,4}(-\d{2,4})?/)?.[0]?.replace(/^20(\d\d)-20(\d\d)$/, '$1–$2') || '';


// ---------- 每一册一张自己的海报（只取它真实的类型、年份、题目，不编内容）----------
// 颜色：从一组配色里按这一册的 id 挑（不按课：同一门课的资料也各是各的颜色，整面墙像唱片店的墙，颜色不统一）；
// 形式：按 id 挑一种构图——巨大的字、发光的球、几何块、条纹、排满的标题、点阵；有卷面的放一张斜着的纸。
// 每组配色：[底 1, 底 2, 强调色, 字色]
const SCHEMES = [
  ['#0b0b10', '#1d1b2e', '#ff5f4a', '#f4f1ea'], ['#f2e8d5', '#e6d4b4', '#d6402b', '#1a1714'], ['#0f2a3a', '#14485c', '#7fe3d0', '#eaf7f4'],
  ['#ffd23f', '#ffb400', '#161616', '#141414'], ['#2b0f3a', '#5a1f73', '#ff9de2', '#fbe9f7'], ['#e9eef2', '#cdd7df', '#2457ff', '#0e1a2b'],
  ['#1b3b2a', '#2f6b48', '#e8d36a', '#f3f1e4'], ['#ff6b3d', '#f0381f', '#2a0f0a', '#fff4ec'], ['#101418', '#222a33', '#5fd1ff', '#e9f6ff'],
  ['#f7c6c7', '#f19ea5', '#3a1d5d', '#2a1240'], ['#3d2b1f', '#6b4a32', '#ffb36b', '#fff1e3'], ['#0d1f4d', '#1c3f9e', '#ffd166', '#f2f5ff'],
  ['#d9f99d', '#a3e635', '#14532d', '#0b2615'], ['#111111', '#2b2b2b', '#f5f5f5', '#f5f5f5'], ['#7c2d12', '#b4441c', '#fde68a', '#fff7ed'],
  ['#e0f2fe', '#a5d8f7', '#0f4c81', '#082f49'], ['#4c1d95', '#7c3aed', '#a7f3d0', '#f5f3ff'], ['#fef3c7', '#fcd98a', '#be185d', '#3b0a1f'],
  ['#052e2b', '#0f766e', '#fca5a5', '#ecfeff'], ['#1f2937', '#374151', '#f59e0b', '#f9fafb'], ['#fff1f2', '#ffd5db', '#111827', '#111827'],
  ['#14213d', '#1d3557', '#e63946', '#f1faee'], ['#264653', '#2a9d8f', '#e9c46a', '#fbfaf6'], ['#3a0ca3', '#4361ee', '#4cc9f0', '#f0f4ff'],
];
const light = (hex) => { const n = parseInt(hex.slice(1), 16); return ((n >> 16) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114) > 150; };
/** 一册资料（或一门课）的配色：bg1、bg2 底，accent 强调，ink 字，dark 底是不是深色 */
export function paletteOf(x) {
  const [bg1, bg2, accent, ink] = SCHEMES[Math.floor(hash(`${x.id || x.course}|scheme`) * SCHEMES.length)];
  return { bg1, bg2, accent, ink, dark: !light(bg1) };
}
const KINDS = [['exam', /试卷|期中|期末|真题|考试|测验|exam/i], ['answer', /答案|解析|key|solution/i], ['audio', /听力|音频|mp3|wav|audio/i],
  ['slides', /课件|ppt|slide|chapter|讲义/i], ['notes', /笔记|note|总结|复习|提纲|纲要|summary|review/i], ['drill', /作业|习题|题库|练习|homework|task|lab|实验/i]];
const kindOf = (x) => KINDS.find(([, re]) => re.test(`${x.kind || ''} ${x.title || ''} ${x.format || ''}`))?.[0] || 'doc';
const seeded = (seed) => { let r = Math.floor(hash(seed) * 233280); return () => { r = (r * 9301 + 49297) % 233280; return r / 233280; }; };
const FORMS = ['glyph', 'orb', 'blocks', 'stripes', 'type', 'dots'];
// 题目里第一个有分量的字（跳过年份、学期这类前缀），给“巨大的字”构图用
const keyChar = (x) => [...String(x.title || x.course || '资')].find((ch) => /[一-龥A-Za-z]/.test(ch)) || '资';

function ground(ctx, w, h, pal, rnd) {
  const g = ctx.createLinearGradient(0, 0, w * (0.4 + rnd() * 0.6), h);
  g.addColorStop(0, pal.bg1); g.addColorStop(1, pal.bg2);
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
}
function figure(ctx, form, x, w, h, k, pal, rnd, f) {
  const m = Math.min(w, h), A = pal.accent;
  ctx.save();
  if (form === 'glyph') {
    // 一个巨大的字，被画框切掉一部分
    const ch = kindOf(x) === 'exam' ? (String(x.year || '').match(/\d{4}/)?.[0]?.slice(-2) || keyChar(x)) : keyChar(x);
    ctx.font = `700 ${m * (ch.length > 1 ? 0.95 : 1.1)}px ${f.serif}`; ctx.fillStyle = A; ctx.textBaseline = 'alphabetic';
    ctx.globalAlpha = 0.92; ctx.fillText(ch, w * (0.2 - rnd() * 0.35), h * (0.62 + rnd() * 0.2));
  } else if (form === 'orb') {
    // 一颗发光的球（像唱片封面），外面一道细环
    const cx = w * (0.3 + rnd() * 0.4), cy = h * (0.25 + rnd() * 0.25), r = m * (0.24 + rnd() * 0.14);
    const g = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 0.05, cx, cy, r * 1.6);
    g.addColorStop(0, '#ffffff'); g.addColorStop(0.22, A); g.addColorStop(0.62, A + '55'); g.addColorStop(1, A + '00');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = A; ctx.globalAlpha = 0.6; ctx.lineWidth = 1.2 * k; ctx.beginPath(); ctx.arc(cx, cy, r * 1.35, 0, Math.PI * 2); ctx.stroke();
  } else if (form === 'blocks') {
    // 几块纯色几何：半圆、圆、长条（包豪斯）
    ctx.fillStyle = A;
    const cx = w * (0.25 + rnd() * 0.5), cy = h * (0.3 + rnd() * 0.15), r = m * (0.22 + rnd() * 0.12);
    ctx.beginPath(); ctx.arc(cx, cy, r, Math.PI * (rnd() < 0.5 ? 0 : 1), Math.PI * (rnd() < 0.5 ? 1 : 2)); ctx.fill();
    ctx.globalAlpha = 0.85; ctx.fillStyle = pal.ink; ctx.fillRect(w * (0.08 + rnd() * 0.3), cy + r * 0.35, w * (0.3 + rnd() * 0.4), 6 * k);
    ctx.globalAlpha = 0.75; ctx.fillStyle = A; ctx.beginPath(); ctx.arc(w * (0.15 + rnd() * 0.7), h * (0.08 + rnd() * 0.12), m * 0.06, 0, Math.PI * 2); ctx.fill();
  } else if (form === 'stripes') {
    // 条纹（听力的是声波高低）
    const audio = kindOf(x) === 'audio', n = 9 + Math.floor(rnd() * 8), bw = w / n;
    ctx.fillStyle = A;
    for (let i = 0; i < n; i++) {
      if (audio) { const a = 0.2 + Math.abs(Math.sin(i * 0.7 + rnd() * 2)) * 0.8, bh = a * h * 0.34; ctx.fillRect(i * bw + bw * 0.2, h * 0.32 - bh / 2, bw * 0.6, bh); }
      else { ctx.globalAlpha = 0.25 + rnd() * 0.7; ctx.fillRect(0, h * 0.06 + i * h * 0.055, w * (0.3 + rnd() * 0.7), h * 0.022 * (1 + rnd() * 1.5)); }
    }
  } else if (form === 'type') {
    // 题目本身排满上半张（大字海报）
    ctx.font = `700 ${m * 0.2}px ${f.serif}`; ctx.fillStyle = A; ctx.textBaseline = 'top';
    const rows = wrap(ctx, x.title, w - 16 * k, 3);
    rows.forEach((row, r) => ctx.fillText(row.map((c) => c.ch).join(''), 8 * k, 30 * k + r * m * 0.21));
  } else {
    // 点阵，其中几个亮
    const gap = 15 * k;
    ctx.fillStyle = A;
    for (let y = gap * 2; y < h * 0.55; y += gap) for (let xx = gap; xx < w - gap / 2; xx += gap) {
      const on = rnd() < 0.14; ctx.globalAlpha = on ? 1 : 0.32; ctx.beginPath(); ctx.arc(xx, y, (on ? 3 : 1.4) * k, 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.restore();
}
function grainOn(ctx, w, h, seed, dark) {
  const rnd = seeded(`${seed}|g`);
  for (let i = 0; i < (w * h) / 200; i++) { ctx.fillStyle = dark ? `rgba(255,255,255,${0.02 + rnd() * 0.05})` : `rgba(0,0,0,${0.025 + rnd() * 0.05})`; ctx.fillRect(rnd() * w, rnd() * h, 1, 1); }
}

/**
 * 一册资料的卡。img：它的画面（卷面第一页，或上传的封面 asCover）；focal：封面焦点 [fx, fy]；hl：搜索词。
 * w × h 是像素，k 是字号倍率（按格子短边算，竖格、横格、大格字号都合适）。
 */
export function paintItem(x, img, w, h, { focal = null, hl = '', asCover = false } = {}) {
  const f = FONTS(), [c, ctx] = canvas(w, h), k = Math.min(w, h) / 200, hit = hits(x.title, hl), pal = paletteOf(x), rnd = seeded(x.id), wide = w / h > 1.35;
  let ink = pal.ink, sub = pal.dark ? 'rgba(255,255,255,0.72)' : 'rgba(0,0,0,0.62)', shadeIt = false;
  if (img && asCover) {
    // 上传的封面：铺满，底下压一层暗好放字
    ctx.fillStyle = pal.bg2; ctx.fillRect(0, 0, w, h);
    cover(ctx, img, 0, 0, w, h, focal?.[0] ?? 0.5, focal?.[1] ?? 0.3);
    ink = '#ffffff'; sub = 'rgba(255,255,255,0.75)'; shadeIt = true;
  } else {
    ground(ctx, w, h, pal, rnd);
    if (img) {
      // 卷面：斜放在色底上，像一张拍出来的纸
      const ph = wide ? h * 0.82 : h * 0.62, pw = Math.min(ph / 1.414, w * (wide ? 0.42 : 0.74)), rot = (rnd() - 0.5) * 0.14;
      ctx.save(); ctx.translate(wide ? w * 0.7 : w * (0.45 + rnd() * 0.12), wide ? h * 0.5 : h * 0.37); ctx.rotate(rot);
      ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 22 * k; ctx.shadowOffsetY = 10 * k;
      ctx.fillStyle = '#f4f2ec'; ctx.fillRect(-pw / 2, -ph / 2, pw, ph); ctx.shadowColor = 'transparent';
      ctx.beginPath(); ctx.rect(-pw / 2, -ph / 2, pw, ph); ctx.clip(); cover(ctx, img, -pw / 2, -ph / 2, pw, ph, 0.5, 0);
      ctx.restore();
    } else figure(ctx, FORMS[Math.floor(hash(`${x.id}|form`) * FORMS.length)], x, w, h, k, pal, rnd, f);
    grainOn(ctx, w, h, x.id, pal.dark);
  }
  if (shadeIt) {
    const g = ctx.createLinearGradient(0, h * 0.4, 0, h);
    g.addColorStop(0, 'rgba(6,6,9,0)'); g.addColorStop(1, 'rgba(6,6,9,0.88)');
    ctx.fillStyle = g; ctx.fillRect(0, h * 0.4, w, h * 0.6);
  }
  // 左上：类型；右上：年份（等宽小字）
  ctx.textBaseline = 'alphabetic';
  ctx.font = `600 ${10.5 * k}px ${f.mono}`; ctx.fillStyle = sub;
  ctx.fillText(String(x.kind || '资料'), 11 * k, 22 * k);
  const year = yearOf(x);
  if (year) { ctx.textAlign = 'right'; ctx.fillText(year, w - 11 * k, 22 * k); ctx.textAlign = 'left'; }
  // 左下：课名、题目（衬线粗体，命中的字金色）
  ctx.font = `700 ${16.5 * k}px ${f.serif}`;
  const lines = wide ? 2 : h / w > 1.6 ? 4 : 3, rows = wrap(ctx, x.title, (wide ? w * 0.56 : w) - 24 * k, lines), lh = 20.5 * k, top = h - 14 * k - (rows.length - 1) * lh;
  ctx.font = `500 ${9.5 * k}px ${f.mono}`; ctx.fillStyle = sub;
  ctx.fillText([x.course, String(x.format || '').toUpperCase()].filter(Boolean).join(' · ').slice(0, Math.floor(w / (6.2 * k))), 12 * k, top - 21 * k);
  ctx.font = `700 ${16.5 * k}px ${f.serif}`;
  drawLines(ctx, rows, 12 * k, top, lh, ink, hit, pal.dark || shadeIt ? GOLD : GOLD_INK);
  return c;
}

/** 课程海报：墨色底，课名大字，pages（这门课已经画好的几张卷面）在下半张扇形摊开 */
export function paintPoster(course, w, h, pages = []) {
  const f = FONTS(), [c, ctx] = canvas(w, h), k = Math.min(w, h) / 200, wide = w / h > 1.25, pal = paletteOf({ course: course.course });
  // 底：墨色，左上一团这门课自己的强调色光
  ctx.fillStyle = INK; ctx.fillRect(0, 0, w, h);
  const l0 = ctx.createRadialGradient(w * 0.15, h * 0.1, 0, w * 0.15, h * 0.1, Math.max(w, h) * 0.9);
  l0.addColorStop(0, pal.accent + '66'); l0.addColorStop(1, pal.accent + '00');
  ctx.fillStyle = l0; ctx.fillRect(0, 0, w, h);
  if (pages.length) {
    const n = Math.min(5, pages.length), pw = Math.min(w * (wide ? 0.3 : 0.5), h * 0.5), ph = pw * 1.414;
    const cx = wide ? w * 0.72 : w * 0.5, cy = wide ? h * 0.62 : h * 0.86;
    pages.slice(0, n).forEach((img, i) => {
      const depth = n - 1 - i, rot = (i - (n - 1) / 2) * 0.13 + (hash(course.course + i) - 0.5) * 0.06;
      ctx.save(); ctx.translate(cx + (i - (n - 1) / 2) * pw * 0.16, cy + Math.abs(i - (n - 1) / 2) * 6 * k); ctx.rotate(rot);
      ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 22 * k; ctx.shadowOffsetY = 10 * k;
      ctx.fillStyle = PAPER; ctx.fillRect(-pw / 2, -ph * 0.62, pw, ph); ctx.shadowColor = 'transparent';
      cover(ctx, img, -pw / 2, -ph * 0.62, pw, ph, 0.5, 0);
      ctx.fillStyle = `rgba(18,18,20,${0.08 + depth * 0.1})`; ctx.fillRect(-pw / 2, -ph * 0.62, pw, ph);
      ctx.restore();
    });
    const g = wide ? ctx.createLinearGradient(0, 0, w * 0.62, 0) : ctx.createLinearGradient(0, 0, 0, h * 0.62);
    g.addColorStop(0, 'rgba(8,8,10,0.9)'); g.addColorStop(0.72, 'rgba(8,8,10,0.7)'); g.addColorStop(1, 'rgba(8,8,10,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, wide ? w * 0.62 : w, wide ? h : h * 0.62);
  } else {
    // 没有卷面：课名本身排成一面浅浅的字墙
    ctx.font = `600 ${22 * k}px ${f.serif}`; ctx.fillStyle = 'rgba(255,255,255,0.08)';
    for (let y = 120 * k, r = 0; y < h + 22 * k; y += 30 * k, r++) ctx.fillText(`${course.course}　`.repeat(10), -((r * 37) % 90) * k, y);
  }
  ctx.textBaseline = 'alphabetic';
  ctx.font = `500 ${11 * k}px ${f.mono}`; ctx.fillStyle = 'rgba(241,240,236,0.6)';
  ctx.fillText(`第 ${String(course.layer).padStart(3, '0')} 门 · ${course.discipline?.name || ''}`, 16 * k, 28 * k);
  const name = course.course, size = (name.length > 8 ? 30 : name.length > 5 ? 38 : 48) * k;
  ctx.font = `600 ${size}px ${f.serif}`;
  const rows = wrap(ctx, name, (wide ? w * 0.56 : w) - 32 * k, 3);
  drawLines(ctx, rows, 14 * k, 34 * k + size, size * 1.12, '#f6f5f1', new Set(), '');
  const y = 34 * k + size + (rows.length - 1) * size * 1.12 + 22 * k;
  ctx.fillStyle = 'rgba(241,240,236,0.7)'; ctx.fillRect(16 * k, y, Math.min(w * 0.32, 90 * k), 2 * k);
  ctx.font = `500 ${12 * k}px ${f.mono}`; ctx.fillStyle = 'rgba(241,240,236,0.82)';
  ctx.fillText(`${course.items.length} 册${course.years ? ` · ${course.years}` : ''}`, 16 * k, y + 24 * k);
  ctx.strokeStyle = 'rgba(255,255,255,0.14)'; ctx.lineWidth = 1; ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
  return c;
}

/** 学科卡：站内概念插画铺满（img 可以还没到），学科名大字，写明插画是 AI 绘制 */
export function paintDiscipline(disc, w, h, img = null) {
  const f = FONTS(), [c, ctx] = canvas(w, h), k = Math.min(w, h) / 200;
  ctx.fillStyle = INK; ctx.fillRect(0, 0, w, h);
  if (img) {
    cover(ctx, img, 0, 0, w, h, 0.5, 0.5);
    const g = ctx.createLinearGradient(0, 0, w * 0.7, 0);
    g.addColorStop(0, 'rgba(10,10,12,0.88)'); g.addColorStop(1, 'rgba(10,10,12,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  }
  ctx.textBaseline = 'alphabetic';
  ctx.font = `500 ${11 * k}px ${f.mono}`; ctx.fillStyle = 'rgba(241,240,236,0.66)';
  ctx.fillText('学科 · 自动归类', 18 * k, 30 * k);
  ctx.font = `600 ${64 * k}px ${f.serif}`; ctx.fillStyle = '#f6f5f1';
  ctx.fillText(disc.name, 16 * k, h * 0.5 + 24 * k);
  ctx.font = `500 ${12.5 * k}px ${f.mono}`; ctx.fillStyle = 'rgba(241,240,236,0.82)';
  ctx.fillText(`${disc.courses.length} 门课 · ${disc.count} 册`, 18 * k, h * 0.5 + 54 * k);
  ctx.font = `500 ${9.5 * k}px ${f.mono}`; ctx.fillStyle = 'rgba(241,240,236,0.5)';
  ctx.fillText('配图：站内概念插画（AI 绘制）', 18 * k, h - 16 * k);
  ctx.strokeStyle = 'rgba(255,255,255,0.16)'; ctx.lineWidth = 1; ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
  return c;
}
