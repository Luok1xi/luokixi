import { initShell, observeReveal, observeLive } from '../js/shell.js';
import { loadCommunity, projectCard, fmtNum } from '../js/community.js';
import { coverMediaHTML as coverSVG } from '../js/cover.js';
import { CATEGORIES, ORIGINS } from '../js/schema.js';
import { hubState, hubApi } from '../js/hub.js';
import { mergeProjects, publicProjectEntries } from '../js/project-catalogue.js';
import { esc } from '../js/data.js';
import { mountRepository } from '../js/repository-browser.js';
import '../styles/community.css';

initShell();

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const state = { cat: 'all', origin: 'all', sort: 'stars' };
let data;

// 顶部海报墙：三排封面向相反方向缓慢漂移（只动 transform，离屏暂停）
function posterWall(projects) {
  if (!projects.length) return;
  const rows = [0, 1, 2].map((r) => {
    const list = Array.from({ length: 8 }, (_, i) => projects[(i * 3 + r * 2) % projects.length]);
    const posters = list
      .map((p) => `<div class="poster">${coverSVG(p)}<span class="poster-title">${esc(p.title)}</span></div>`)
      .join('');
    // 复制一份接在后面，滚到一半时无缝衔接
    return `<div class="poster-row" style="--dir:${r % 2 ? 1 : -1};--dur:${70 + r * 12}s"><div class="poster-track">${posters}${posters}</div></div>`;
  });
  $('#poster-plane').innerHTML = rows.join('');
}

function stats(projects) {
  const mine = projects.filter((p) => p.origin === 'cumtb').length;
  const stars = projects.reduce((a, p) => a + (p.repo?.stars ?? 0), 0);
  $('#pj-stats').innerHTML = [
    [projects.length, '个项目'],
    [mine, '个来自矿大'],
    [Object.keys(CATEGORIES).length, '个方向'],
    [fmtNum(stars), '累计 Star'],
  ]
    .map(([n, l]) => `<div><dt>${l}</dt><dd class="num">${n}</dd></div>`)
    .join('');
}

function filters(projects) {
  const count = (k) => projects.filter((p) => k === 'all' || p.category === k).length;
  $('#cat-filter').innerHTML = [['all', '全部'], ...Object.entries(CATEGORIES).map(([k, c]) => [k, c.short ?? c.name])]
    .filter(([k]) => k === 'all' || count(k))
    .map(([k, name]) => `<button type="button" data-cat="${k}" aria-pressed="${k === state.cat}">${name}<span class="seg-count">${count(k)}</span></button>`)
    .join('');
}

const sorters = {
  stars: (a, b) => (b.repo?.stars ?? -1) - (a.repo?.stars ?? -1),
  updated: (a, b) => Date.parse(b.repo?.pushedAt ?? 0) - Date.parse(a.repo?.pushedAt ?? 0),
  name: (a, b) => a.title.localeCompare(b.title, 'zh-CN'),
};

function grid() {
  const list = data.projects
    .filter((p) => state.cat === 'all' || p.category === state.cat)
    .filter((p) => state.origin === 'all' || p.origin === state.origin)
    // 本校项目永远排在外部推荐前面
    .sort(sorters[state.sort]);
  const el = $('#pj-grid');
  el.innerHTML = list.map((p) => {
    const card = projectCard(p.entryId ? { ...p, links: { ...p.links, repo: p.pageUrl } } : p, data.people);
    return p.entryId ? card.replace(' target="_blank" rel="noopener"', '').replace(`>${ORIGINS[p.origin]}</span>`, `>${esc(p.originLabel || ORIGINS[p.origin])}</span>`) : card;
  }).join('');
  $('#pj-empty').hidden = list.length > 0 && !(state.origin === 'all' && !data.projects.some((p) => p.origin === 'cumtb'));
  observeReveal(el);
}

function switchTo(fn) {
  const el = $('#pj-grid');
  el.classList.add('is-switching');
  setTimeout(() => {
    fn();
    grid();
    el.classList.remove('is-switching');
  }, 160);
}

function wire() {
  $('#cat-filter').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cat]');
    if (!b || b.dataset.cat === state.cat) return;
    $$('[data-cat]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    switchTo(() => (state.cat = b.dataset.cat));
  });
  $('#origin-filter').addEventListener('click', (e) => {
    const b = e.target.closest('[data-origin]');
    if (!b || b.dataset.origin === state.origin) return;
    $$('[data-origin]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    switchTo(() => (state.origin = b.dataset.origin));
  });
  $('#sort').addEventListener('change', (e) => switchTo(() => (state.sort = e.target.value)));
}

Promise.all([loadCommunity(), hubState()])
  .then(async ([d, s]) => {
    if (s.online) {
      try { d = { ...d, projects: mergeProjects(d.projects, await publicProjectEntries(hubApi, err => console.warn('[luokixi] 部分已公开项目暂时无法读取', err))) }; }
      catch (err) { console.warn('[luokixi] 已公开项目暂时无法读取，保留静态目录', err); }
    }
    data = d;
    posterWall(d.projects);
    stats(d.projects);
    filters(d.projects);
    grid();
    wire();
  })
  .catch((err) => {
    console.error('[luokixi] 项目加载失败', err);
    $('#pj-grid').innerHTML = '<p class="notice">项目列表暂时加载不出来，请稍后刷新。</p>';
  })
  .finally(() => {
    observeReveal();
    observeLive();
  });

mountRepository(document.querySelector('#repository-browser'));
