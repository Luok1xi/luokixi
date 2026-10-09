// 社区数据读取与展示用的小工具
import { esc } from './data.js';
import { CATEGORIES, ORIGINS } from './schema.js';
import { coverHTML } from './cover.js';
import { hubApi } from '../../campus/hub-client.js';
import {applyEditorial} from './editorial-data.js';

let pending;
export function loadCommunity() {
  pending ??= Promise.all([fetch('data/community.json', { cache: 'no-cache' }).then((r) => {
    if (!r.ok) throw new Error(`community.json ${r.status}`);
    return r.json();
  }), hubApi.available ? hubApi.projectMedia({ signal: AbortSignal.timeout(1200) }).catch(() => null) : null]).then(([data, media]) => ({
    ...data, projects: data.projects.map(p => {
      const image = media?.items?.[p.repo?.fullName];
      return !p.cover && image?.image ? { ...p, cover:image.image, coverCredit:image.credit, coverSource:image.sourceUrl, coverStale:image.stale } : p;
    }),
  })).then(d=>applyEditorial('community',d));
  return pending;
}

let sitePending;
export function loadSite() {
  sitePending ??= fetch('data/site.json', { cache: 'no-cache' }).then((r) => r.json()).then(d=>applyEditorial('site',d));
  return sitePending;
}

// GitHub 上提交内容的链接。仓库还没发布（owner 为空）时返回 null。
export function repoURL(site, path = '') {
  const r = site?.repo;
  if (!r?.owner) return null;
  return `https://github.com/${r.owner}/${r.name}${path}`;
}

export const fmtNum = (n) => {
  if (n == null) return '—';
  if (n >= 10000) return `${(n / 10000).toFixed(n >= 100000 ? 0 : 1)} 万`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
};

export function timeAgo(iso) {
  if (!iso) return '';
  const d = (Date.now() - Date.parse(iso)) / 86400e3;
  if (d < 1) return '今天';
  if (d < 30) return `${Math.floor(d)} 天前`;
  if (d < 365) return `${Math.floor(d / 30)} 个月前`;
  return `${Math.floor(d / 365)} 年前`;
}

const hueOf = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

// 头像：GitHub 头像加载失败（例如网络不通）时自动露出底下的首字
export function avatarHTML({ login, name, avatar }, size = 40) {
  const label = esc(name || login || '?');
  const initial = esc([...(name || login || '?')][0].toUpperCase());
  const img = avatar ? `<img src="${esc(avatar)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-avatar>` : '';
  return `<span class="avatar" style="--size:${size}px;--h:${hueOf(login || name)}" title="${label}">${initial}${img}</span>`;
}

document.addEventListener(
  'error',
  (e) => {
    if (e.target instanceof HTMLImageElement && e.target.hasAttribute('data-avatar')) e.target.remove();
  },
  true,
);

// GitHub linguist 配色（只列常见语言）
export const LANG_COLORS = {
  C: '#555555', 'C++': '#f34b7d', 'C#': '#178600', Python: '#3572A5', JavaScript: '#f1e05a', TypeScript: '#3178c6',
  HTML: '#e34c26', CSS: '#663399', Java: '#b07219', Kotlin: '#A97BFF', Rust: '#dea584', Go: '#00ADD8',
  MATLAB: '#e16737', 'Jupyter Notebook': '#DA5B0B', Vue: '#41b883', Shell: '#89e051', Verilog: '#b2b7f8',
  VHDL: '#adb2cb', Lua: '#000080', Swift: '#F05138', Dart: '#00B4AB', Assembly: '#6E4C13', 'Objective-C': '#438eff',
};

// Codeforces 段位配色
export function cfColor(rating) {
  if (rating == null) return 'var(--fg-2)';
  if (rating >= 2400) return '#ff1a1a';
  if (rating >= 2100) return '#ff8c00';
  if (rating >= 1900) return '#aa00aa';
  if (rating >= 1600) return '#3b5bdb';
  if (rating >= 1400) return '#03a89e';
  if (rating >= 1200) return '#008000';
  return '#808080';
}

export const CF_RANK_CN = {
  newbie: '新手', pupil: '学徒', specialist: '专家', expert: '高手', 'candidate master': '候选大师',
  master: '大师', 'international master': '国际大师', grandmaster: '宗师', 'international grandmaster': '国际宗师',
  'legendary grandmaster': '传奇宗师', tourist: 'tourist',
};

const ICON_STAR = '<svg viewBox="0 0 16 16"><path d="M8 .9l2.2 4.5 4.9.7-3.6 3.5.9 4.9L8 12.2l-4.4 2.3.9-4.9L.9 6.1l4.9-.7z"/></svg>';
const ICON_FORK = '<svg viewBox="0 0 16 16"><path d="M5 3.3a1.8 1.8 0 1 1-1.5 0v.7c0 .9.7 1.6 1.6 1.6h4.8c.9 0 1.6-.7 1.6-1.6v-.7a1.8 1.8 0 1 1 1.5 0v.7c0 1.7-1.4 3.1-3.1 3.1H8.8v2.6a1.8 1.8 0 1 1-1.5 0V7.1H5.1C3.4 7.1 2 5.7 2 4v-.7zM4.2 1.6a.6.6 0 1 0 0 1.2.6.6 0 0 0 0-1.2zm7.5 0a.6.6 0 1 0 0 1.2.6.6 0 0 0 0-1.2zM8 12.2a.6.6 0 1 0 0 1.2.6.6 0 0 0 0-1.2z"/></svg>';

export function catTag(category) {
  const c = CATEGORIES[category];
  return c ? `<span class="tag cat-tag" style="--h:${c.hue}" title="${c.name}">${c.short ?? c.name}</span>` : '';
}

export function projectCard(p, people = []) {
  const href = p.links.repo || p.links.site || p.links.hardware || p.links.video;
  const r = p.repo;
  const authors = (p.authors ?? []).map((login) => people.find((x) => x.login === login) ?? { login, avatar: `https://avatars.githubusercontent.com/${login}?s=64` });
  const by = p.origin === 'external'
    ? `<span>${esc(p.credit)}</span>`
    : `<span class="avatar-stack">${authors.map((a) => avatarHTML(a, 22)).join('')}</span>`;
  const meta = [
    r?.language ? `<span><i class="lang-dot" style="--c:${LANG_COLORS[r.language] ?? 'var(--fg-3)'}"></i>${esc(r.language)}</span>` : '',
    r?.stars != null ? `<span title="Star">${ICON_STAR}${fmtNum(r.stars)}</span>` : '',
    r?.forks != null ? `<span title="Fork">${ICON_FORK}${fmtNum(r.forks)}</span>` : '',
    // 仓库没声明许可证时不能默认“可自由复用”
    r ? (r.license ? `<span>${esc(r.license)}</span>` : '<span class="lic-unknown" title="仓库没有声明许可证，复用前请联系作者">许可待核</span>') : '',
    r?.pushedAt ? `<span>更新于 ${timeAgo(r.pushedAt)}</span>` : '',
    r?.stale ? `<span class="stale" title="本次同步失败，显示的是${r.checkedAt ? ` ${r.checkedAt.slice(0, 10)} ` : '上一次'}核对的数据">待更新</span>` : '',
  ].join('');
  return `<a class="card card-hover proj-card" href="${esc(href)}" target="_blank" rel="noopener" data-reveal data-cat="${p.category}" data-origin="${p.origin}">
    ${coverHTML(p)}
    <div class="proj-body">
      <div class="proj-top">${catTag(p.category)}<span class="tag${p.origin === 'cumtb' ? ' tag-cumtb' : ''}">${ORIGINS[p.origin]}</span></div>
      <h3 class="proj-title">${esc(p.title)}</h3>
      <p class="proj-summary">${esc(p.summary)}</p>
      <div class="proj-meta">${by}${meta}</div>
    </div>
  </a>`;
}

// 社区总日历 = 本站提交 + 每位成员的刷题记录（成员的 GitHub 日历只在个人主页显示，避免和本站提交重复计数）
export function communitySeries(data) {
  const counts = [...(data.site?.series ?? [])];
  for (const p of data.people ?? []) (p.series?.oj ?? []).forEach((n, i) => (counts[i] = (counts[i] ?? 0) + n));
  return { start: data.range.start, counts };
}

export const seriesSum = (arr) => (arr ?? []).reduce((a, b) => a + b, 0);
