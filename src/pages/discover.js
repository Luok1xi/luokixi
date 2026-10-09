// 项目发现流：一次一个项目，上下切换。
// 全部：人工目录 + 已公开投稿 + 维护者精选；分类：精选分页；离线保留人工目录。
import { initShell, reducedMotion } from '../js/shell.js';
import { hubApi, hubState, loginURL } from '../js/hub.js';
import { loadCommunity, fmtNum, timeAgo } from '../js/community.js';
import { allCuratedProjects, mergeDiscoveryCards, mergeProjects, publicProjectEntries } from '../js/project-catalogue.js';
import { coverMediaHTML as coverSVG } from '../js/cover.js';
import { CATEGORIES, ORIGINS } from '../js/schema.js';
import { createNotebook } from '../js/community-notebook.js';
import { esc } from '../js/data.js';
import { mountRack, swapLines, webglAvailable } from '../js/disc-rack.js';
import { DISC_TOPICS, filterDiscovery, projectSearchOptions } from '../js/discover-filters.js';
import { attachSearchSuggestions } from '../js/search-suggestions.js';
import '../styles/discover-search.css';
import '../styles/community.css';
import '../styles/discover.css';
import '../styles/feed-redesign.css';
import '../styles/disc-rack.css';

initShell();

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const feed = $('#dc-feed');
const SHELF = { practical: '实用', creative: '新奇', potential: '潜力' };
const SHELF_GLYPH = { practical: 'software', creative: 'research', potential: 'algo' };
const PLAN_KEY = 'luokixi.discover.plan';
const HIDE_KEY = 'luokixi.discover.hidden';
const safeURL = (u) => (typeof u === 'string' && /^https:\/\//.test(u) ? u : null);
const store = {
  get(k, d) {
    try { return JSON.parse(sessionStorage.getItem(k) ?? localStorage.getItem(k)) ?? d; } catch { return d; }
  },
  set(k, v, session = false) {
    try { (session ? sessionStorage : localStorage).setItem(k, JSON.stringify(v)); } catch { /* 隐私模式 */ }
  },
};

const st = {
  online: false,
  user: null,
  items: [],
  index: 0,
  shelf: 'all',
  query: '',
  catalogue: [],
  loaded: false,
  cursor: null,
  loading: false,
  ranking: '',
  plan: store.get(PLAN_KEY, []),
  hidden: new Set(store.get(HIDE_KEY, [])),
};
let notebook = null;
try { notebook = createNotebook(); } catch { /* 浏览器存储不可用 */ }

// ---------- 提示 ----------

let toastTimer;
function toast(msg, action) {
  const el = $('#dc-toast');
  el.innerHTML = `${esc(msg)}${action?.href ? ` <a href="${esc(action.href)}">${esc(action.label)}</a>` : action?.onClick ? ' <button type="button" class="btn-link" data-toast-act></button>' : ''}`;
  if (action?.onClick) {
    const b = el.querySelector('[data-toast-act]');
    b.textContent = action.label;
    b.addEventListener('click', () => { el.classList.remove('is-on'); el.hidden = true; action.onClick(); }, { once: true });
  }
  el.hidden = false;
  el.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('is-on');
    setTimeout(() => (el.hidden = true), 300);
  }, 3200);
}

// ---------- 数据 ----------

// 静态预览：把目录里的项目整理成和 /api/hub/feed 相同的形状
function fromCatalogue(p) {
  const cat = CATEGORIES[p.category];
  return {
    repository: p.repo?.fullName ?? p.slug, repositoryUrl: p.links.repo || p.links.demo || p.links.site || p.links.hardware, entryId: p.entryId ?? null, publicRevision: p.publicRevision, title: p.title,
    idea: p.summary, ideaLanguage: 'zh', guideState: 'static', sections: [{heading:'这个项目能做什么',text:p.summary,evidenceIds:[]},{heading:'如何开始',text:'先查看原仓库的 README，核对硬件、系统版本和依赖要求，再按官方步骤安装。本站尚未完成独立运行验证。',evidenceIds:[]}], unknowns: ['运行环境、安装步骤与下载版本请以原仓库为准；人工目录卡不等于已核对的 AI 完整导读。'],
    whyRecommended: `${cat?.name ?? ''} · ${p.originLabel || ORIGINS[p.origin] || ''}${p.credit ? ` · ${p.credit}` : ''}`,
    shelf: null, downloads: [], readmeUrl: p.links.repo ? `${p.links.repo}#readme` : null, videoUrl: p.links.video || null,
    license: p.repo ? p.repo.license ?? '许可待核' : null, credit: p.credit, githubStars: p.repo?.stars ?? null,
    siteStars: p.siteStars ?? null, starred: Boolean(p.starred), media: { type: 'project-card', notice: '项目卡片 · 不是实机演示视频' },
    evidence: [], verifiedAt: p.repo?.checkedAt ?? null, tested: false, category: p.category, tags: p.tags || [], language: p.repo?.language || '', slug: p.slug, cover: p.cover, coverCredit: p.coverCredit,
  };
}

let cataloguePending;
let fetchGeneration = 0;
function publicCatalogue() {
  cataloguePending ??= (async () => {
    const [data, entries] = await Promise.all([
      loadCommunity().catch(err => { toast('静态目录暂时读不到，仍显示可用项目。'); return { projects: [] }; }),
      st.online ? publicProjectEntries(hubApi, err => toast('部分本站项目暂时读不到，仍显示可用目录。')) : [],
    ]);
    return mergeProjects(data.projects, entries).map(fromCatalogue);
  })();
  return cataloguePending;
}

async function fetchMore() {
  if (st.loading || st.loaded) return;
  st.loading = true;
  const generation = ++fetchGeneration;
  try {
    const [catalogue, selected] = await Promise.all([
      publicCatalogue(),
      st.online ? allCuratedProjects(hubApi, () => toast('部分精选暂时读不到，仍显示已公开目录。')) : { items: [], ignoredRepositories: [] },
    ]);
    if (generation !== fetchGeneration) return;
    st.catalogue = mergeDiscoveryCards(catalogue, selected.items, selected.ignoredRepositories);
    st.loaded = true;
    st.cursor = null;
    await applyDiscoveryFilter();
    const project = new URLSearchParams(location.search).get('project');
    if (project && rack && st.items.some(it => [it.repository,it.slug,it.title].includes(project))) openDetail();
  } catch (err) {
    if (generation !== fetchGeneration) return;
    toast(err.message ?? '加载失败，请稍后再试。');
    if (!st.items.length) renderEmpty(err.message);
  } finally {
    if (generation === fetchGeneration) st.loading = false;
  }
}

function saveDiscoveryURL() {
  const url = new URL(location.href);
  for (const [key,value] of [['shelf',st.shelf === 'all' ? '' : st.shelf],['q',st.query]]) value ? url.searchParams.set(key,value) : url.searchParams.delete(key);
  url.searchParams.delete('project');
  history.replaceState(null, '', url);
}

async function applyDiscoveryFilter() {
  if (!st.loaded) return;
  const selected = new URLSearchParams(location.search).get('project') || st.items[st.index]?.repository;
  closeDetail(true);
  setIndex(false);
  st.items = filterDiscovery(st.catalogue, { shelf: st.shelf, query: st.query, hidden: [...st.hidden] });
  const index = st.items.findIndex(it => [it.repository,it.slug,it.title].includes(selected));
  st.index = Math.max(0,index);
  st.ranking = `${DISC_TOPICS[st.shelf]} · ${st.items.length} 个项目${st.query ? ` · “${st.query}”` : ''}`;
  feed.innerHTML = '';
  feed.scrollTop = 0;
  if (!st.items.length) renderEmpty();
  else if (rackMode) await rackAdd(st.items, 0);
  else { const desired = st.index; renderSlides(st.items,0); slideEl(desired)?.scrollIntoView({block:'start',behavior:'instant'}); activate(desired); }
  $('#dc-search-count').textContent = `${st.items.length} 个项目`;
  status();
}

// ---------- 渲染 ----------

const hueOf = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 11);

function visualFor(it) {
  const category = it.category ?? SHELF_GLYPH[it.shelf] ?? 'software';
  return coverSVG({ slug: it.repository, category, title: it.title, cover: it.cover });
}

function guideBadge(it) {
  if (it.guideState === 'reviewed') return '<span class="tag tag-ok">中文导读 · 已核对</span>';
  if (it.guideState === 'static') return '<span class="tag">人工简介</span>';
  return '<span class="tag tag-warn">AI 导读尚未核对</span>';
}

function slideHTML(it, i) {
  const h = CATEGORIES[it.category]?.hue ?? hueOf(it.repository);
  const meta = [
    ['许可', it.license ? esc(it.license) : '<span class="lic-unknown">许可待核</span>'],
    ['GitHub ★', it.githubStars != null ? fmtNum(it.githubStars) : '—'],
    ['本站收藏', it.entryId && st.online ? fmtNum(it.siteStars ?? 0) : '<span class="muted">未收录统计</span>'],
    ['收录时间', it.uploadedAt ? new Date(it.uploadedAt).toLocaleString('zh-CN') : '历史记录未注明'],
    ['上传者', esc(it.uploadedBy || it.credit || '历史记录未注明')],
    ['审核者', esc(it.reviewedBy || '历史记录未注明')],
    ['核对于', it.verifiedAt ? timeAgo(it.verifiedAt) : '—'],
  ];
  const saved = isSaved(it);
  return `<section class="slide" data-content-key="${esc(it.entryId?'entry/'+it.entryId:'github/'+it.repository)}" data-i="${i}" style="--h:${h}" aria-label="${esc(it.title)}">
    <div class="slide-glow" aria-hidden="true"></div>
    <div class="project-danmaku" aria-hidden="true"></div>
    <div class="slide-stage">
      <figure class="slide-visual">
        <div class="cover">${visualFor(it)}</div>
        <figcaption class="media-note">${esc(it.coverCredit || it.media?.notice || '项目卡片')}</figcaption>
      </figure>
      <div class="slide-info">
        <div class="slide-tags">${it.shelf ? `<span class="tag tag-glow">${SHELF[it.shelf]}</span>` : ''}${guideBadge(it)}${it.tested ? '<span class="tag tag-ok">已实测</span>' : ''}</div>
        <h2 class="slide-title">${esc(it.title)}</h2>
        <p class="slide-repo num">${esc(it.repository)}${it.credit ? ` · ${esc(it.credit)}` : ''}</p>
        <p class="slide-idea"${it.ideaLanguage === 'original' ? ' lang="en"' : ''}>${esc(it.idea || '原项目没有写简介。')}</p>
        ${it.whyRecommended ? `<p class="slide-why"><b>为什么推荐</b>${esc(it.whyRecommended)}</p>` : ''}
        <dl class="slide-meta">${meta.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>
        <div class="btn-group slide-cta">
          ${it.sections.length || it.unknowns.length || it.downloads.length ? '<button class="btn btn-primary" type="button" data-act="guide">读中文导读</button>' : ''}
          ${safeURL(it.videoUrl) ? `<a class="btn btn-outline" href="${esc(it.videoUrl)}" target="_blank" rel="noopener">观看演示 ↗</a>` : ''}
          ${safeURL(it.repositoryUrl) ? `<a class="btn ${it.sections.length ? 'btn-outline' : 'btn-primary'}" href="${esc(it.repositoryUrl)}" target="_blank" rel="noopener" data-act="open">查看原作</a>` : ''}
        </div>
      </div>
      <div class="slide-rail" role="group" aria-label="操作">
        <button type="button" class="rail-btn rail-download" data-act="download">
          <svg viewBox="0 0 24 24"><path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14"/></svg><span>下载</span>
        </button>
        <button type="button" class="rail-btn" data-act="comments"><span class="rail-symbol">☷</span><span>讨论</span></button>
        <button type="button" class="rail-btn" data-act="danmaku" aria-pressed="false"><span class="rail-symbol">≋</span><span>弹幕</span></button>
        <button type="button" class="rail-btn${saved ? ' is-on' : ''}" data-act="save" aria-pressed="${saved}">
          <svg viewBox="0 0 24 24"><path d="M12 20.5 4.2 12.9a4.9 4.9 0 0 1 6.9-6.9l.9.9.9-.9a4.9 4.9 0 0 1 6.9 6.9z"/></svg>
          <span>${st.online ? '收藏' : '本机收藏'}</span>
        </button>
        <button type="button" class="rail-btn" data-act="hide">
          <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="m6 6 12 12"/></svg><span>不感兴趣</span>
        </button>
        <button type="button" class="rail-btn${st.plan.includes(it.repository) ? ' is-on' : ''}" data-act="plan">
          <svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="4"/><path d="M12 8v8M8 12h8"/></svg><span>搭建</span>
        </button>
      </div>
    </div>
  </section>`;
}

let io;
function renderSlides(batch, start) {
  feed.insertAdjacentHTML('beforeend', batch.map((it, k) => slideHTML(it, start + k)).join(''));
  io ??= new IntersectionObserver(
    (entries) => entries.forEach((e) => e.isIntersecting && activate(Number(e.target.dataset.i))),
    { root: feed, threshold: 0.6 },
  );
  $$('.slide:not([data-observed])', feed).forEach((s) => {
    s.dataset.observed = '1';
    io.observe(s);
  });
  if (start === 0) activate(0);
}

function renderEmpty(reason) {
  if (rackMode) { rack?.setItems([]); dg.hidden = true; $('.dc').classList.remove('dg-on'); }
  feed.innerHTML = `<section class="slide slide-empty"><div class="empty-card">
    <p class="empty-title">${reason ? '暂时加载不出来。' : st.query ? '没有匹配的项目。' : '这一类还没有项目。'}</p>
    <p>${esc(reason ?? (st.query ? '试试简称或技术关键词，也可以清空搜索后继续浏览。' : '可以看看别的分类，或推荐你喜欢的开源项目。'))}</p>
    <a class="btn btn-primary" href="contribute.html#project">推荐项目</a></div></section>`;
}

function status() {
  $('#dc-status').textContent = st.ranking;
  $('#dc-count').textContent = st.items.length ? `${st.index + 1} / ${st.cursor ? `${st.items.length}+` : st.items.length}` : '';
  // 进度条轨道 120px，指示块 20px，可移动 100px
  $('#dc-progress').style.transform = `translateY(${st.items.length ? (st.index / Math.max(1, st.items.length - 1)) * 100 : 0}px)`;
  const n = st.plan.length;
  $('#dc-plan-btn').hidden = !n;
  $('#dc-plan-n').textContent = n;
}

function activate(i) {
  if (!st.items[i]) return;
  st.index = i;
  $$('.slide.is-active', feed).forEach((s) => s.classList.remove('is-active'));
  feed.querySelector(`.slide[data-i="${i}"]`)?.classList.add('is-active');
  status();
  if (i >= st.items.length - 3) fetchMore();
}

const slideEl = (i) => feed.querySelector(`.slide[data-i="${i}"]`);
function go(delta) {
  const slides = $$('.slide', feed);
  const pos = slides.indexOf(slideEl(st.index));
  const target = slides[Math.max(0, Math.min(slides.length - 1, pos + delta))];
  target?.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
}

// ---------- 操作 ----------

function isSaved(it) {
  if (st.online && it.entryId) return Boolean(it.starred);
  try { return notebook?.read().savedProjects.includes(it.repositoryUrl) ?? false; } catch { return false; }
}

async function save(it, btn) {
  if (!st.online || !it.entryId) {
    if (!notebook || !safeURL(it.repositoryUrl)) return toast('这个项目暂时不能收藏到本机。');
    try {
      notebook.toggleProject(it.repositoryUrl);
      const on = isSaved(it);
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-pressed', String(on));
      toast(on ? '已收藏到本机。换了浏览器就看不到了，记得导出备份。' : '已取消本机收藏。');
    } catch (e) {
      toast(e.message);
    }
    return;
  }
  if (!st.user) return toast('登录后才能收藏。', { href: loginURL(), label: '去登录' });
  if (!it.entryId) return toast('这个项目尚未收录进本站，暂时不能加到本站收藏。');
  try {
    // 显式设置收藏状态（服务端保证重试不重复计数），以返回值为准
    const r = await hubApi.star(it.entryId, !it.starred);
    it.starred = Boolean(r?.starred);
    if (r?.siteStars != null) it.siteStars = r.siteStars;
    btn.classList.toggle('is-on', it.starred);
    btn.setAttribute('aria-pressed', String(it.starred));
    toast(it.starred ? '已收藏。' : '已取消收藏。');
  } catch (e) {
    toast(e.message);
  }
}

async function hide(it, slide) {
  if (st.online && st.user && it.shelf) {
    try {
      await hubApi.feedback(it.repository, 'not-interested');
    } catch (e) {
      return toast(e.message);
    }
  } else {
    st.hidden.add(it.repository);
    store.set(HIDE_KEY, [...st.hidden]);
  }
  slide.classList.add('is-leaving');
  setTimeout(() => {
    // 留一个可撤销的占位，不直接删节点（删掉会让滚动位置跳动）
    slide.classList.remove('is-leaving');
    slide.classList.add('is-hidden');
    slide.querySelector('.slide-stage').insertAdjacentHTML(
      'afterend',
      `<div class="slide-hidden"><p>${st.online && st.user && it.shelf ? '以后不再推荐这个项目。' : '已在本机隐藏这个项目。'}</p><button class="btn btn-outline btn-sm" type="button" data-act="unhide">撤销</button></div>`,
    );
    go(1);
  }, reducedMotion() ? 0 : 320);
}

async function unhide(it, slide) {
  if (st.online && st.user && it.shelf) {
    try {
      await hubApi.feedback(it.repository, 'clear');
    } catch (e) {
      return toast(e.message);
    }
  } else {
    st.hidden.delete(it.repository);
    store.set(HIDE_KEY, [...st.hidden]);
  }
  slide.classList.remove('is-hidden');
  slide.querySelector('.slide-hidden')?.remove();
}

function togglePlan(it, btn) {
  const has = st.plan.includes(it.repository);
  if (!has && st.plan.length >= 5) return toast('搭建清单最多放 5 个项目。');
  st.plan = has ? st.plan.filter((r) => r !== it.repository) : [...st.plan, it.repository];
  store.set(PLAN_KEY, st.plan, true);
  btn.classList.toggle('is-on', !has);
  status();
  toast(has ? '已从搭建清单移除。' : '已加入搭建清单。');
}

feed.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const slide = btn.closest('.slide');
  const it = st.items[Number(slide.dataset.i)];
  const act = btn.dataset.act;
  if (act === 'save') save(it, btn);
  if (act === 'hide') hide(it, slide);
  if (act === 'unhide') unhide(it, slide);
  if (act === 'plan') togglePlan(it, btn);
  if (act === 'guide') openGuide(it);
  if (act === 'comments') openDiscussion(it);
  if (act === 'danmaku') toggleDanmaku(it, slide, btn);
  if (act === 'download') openDownload(it);
});

// ---------- 本站下载：像 MC 百科那样直接在本站下载（只限允许再分发的开源许可证） ----------

const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
async function openDownload(it) {
  const dlg = document.getElementById('dc-download');
  const body = document.getElementById('dc-download-body');
  const repo = it.repository;
  const origin = `<a class="btn btn-outline" href="https://github.com/${esc(repo)}/releases" target="_blank" rel="noopener">去 GitHub 原站下载 ↗</a>`;
  body.innerHTML = `<p class="eyebrow">下载</p><h2 class="sheet-title" id="dc-download-title">${esc(it.title)}</h2><p class="muted">正在读取本站镜像…</p>`;
  dlg.showModal();
  if (!st.online) {
    body.innerHTML = `<p class="eyebrow">下载</p><h2 class="sheet-title" id="dc-download-title">${esc(it.title)}</h2><p class="muted">本站镜像需要社区服务；现在是只读的静态页面。</p><div class="btn-group">${origin}</div>`;
    return;
  }
  let m;
  try { m = await hubApi.mirror(repo); } catch (err) { m = { error: err.message }; }
  const files = m.items ?? [];
  body.innerHTML = `<p class="eyebrow">下载 · ${esc(m.license || it.license || '许可待核')}</p><h2 class="sheet-title" id="dc-download-title">${esc(it.title)}</h2>
    ${files.length ? `<ul class="dc-dl" role="list">${files.map((f) => `<li><div><b>${esc(f.name)}</b><span>${esc(f.tag)} · ${fmtSize(f.size)}${f.downloads ? ` · 本站下载 ${fmtNum(f.downloads)} 次` : ''}</span><code title="${esc(f.sha256)}">SHA-256 ${esc(f.sha256.slice(0, 16))}…</code>${f.executable ? '<small>可执行程序：运行前核对 SHA-256，确认和作者正式发布一致。</small>' : ''}</div><a class="btn btn-primary btn-sm" href="${esc(f.url)}" download>本站下载</a></li>`).join('')}</ul>
      <p class="muted">从作者在 GitHub 的正式发布原样镜像，没有任何修改；使用遵循原许可证。</p>`
      : m.status === 'license-blocked' ? `<p class="muted">${esc(m.reason)}</p>`
      : m.error ? `<p class="muted">本站镜像暂时读不到：${esc(m.error)}</p>`
      : '<p class="muted">本站还没有镜像这个项目的发布包；维护机器人每周检查一次，也可以先去原站下载。</p>'}
    <div class="btn-group">${origin}</div>`;
}

// ---------- 导读面板 ----------

function openGuide(it) {
  const ev = new Map((it.evidence ?? []).map((x) => [x.id, x]));
  const release = it.downloads.filter((d) => d.kind === 'official-release');
  const source = it.downloads.filter((d) => d.kind !== 'official-release');
  const dl = (d) =>
    safeURL(d.url)
      ? `<a class="dl" href="${esc(d.url)}" target="_blank" rel="noopener"><b>${esc(d.name)}</b><span>${[d.version, d.bytes ? `${(d.bytes / 1048576).toFixed(1)} MB` : ''].filter(Boolean).map(esc).join(' · ')}</span></a>`
      : '';
  $('#dc-guide-body').innerHTML = `
    <p class="eyebrow">${it.guideState === 'reviewed' ? '中文导读 · 已按记录核对' : it.guideState === 'static' ? '项目目录 · 人工整理' : 'AI 导读 · 尚未核对，请以原文为准'}</p>
    <h2 id="dc-guide-title" class="sheet-title">${esc(it.title)}</h2>
    <p class="sheet-lead">${esc(it.idea)}</p>
    ${it.sections
      .map(
        (s) => `<section class="guide-sec"><h3>${esc(s.heading)}</h3><p>${esc(s.text)}</p>
        <p class="guide-cite">依据：${s.evidenceIds
          .map((id) => ev.get(id))
          .filter((x) => x && safeURL(x.url))
          .map((x) => `<a href="${esc(x.url)}" target="_blank" rel="noopener" title="${esc(x.text ?? '')}">${esc(x.id)}</a>`)
          .join('、') || '—'}</p></section>`,
      )
      .join('')}
    ${it.unknowns.length ? `<section class="guide-sec guide-unknown"><h3>原项目未说明</h3><ul>${it.unknowns.map((u) => `<li>${esc(u)}</li>`).join('')}</ul></section>` : ''}
    ${release.length ? `<section class="guide-sec"><h3>官方发布包</h3><div class="dl-list">${release.map(dl).join('')}</div></section>` : ''}
    ${source.length ? `<section class="guide-sec"><h3>源代码</h3><p class="muted">源代码不是安装包，需要按原项目说明构建。</p><div class="dl-list">${source.map(dl).join('')}</div></section>` : ''}
    ${it.tested ? `<section class="guide-sec"><h3>实测记录</h3><p>${esc(it.testEvidence)}</p></section>` : ''}
    <div class="btn-group sheet-cta">${safeURL(it.readmeUrl) ? `<a class="btn btn-primary" href="${esc(it.readmeUrl)}" target="_blank" rel="noopener">阅读原文 README</a>` : ''}${safeURL(it.videoUrl) ? `<a class="btn btn-outline" href="${esc(it.videoUrl)}" target="_blank" rel="noopener">观看演示 ↗</a>` : ''}
          ${safeURL(it.repositoryUrl) ? `<a class="btn btn-outline" href="${esc(it.repositoryUrl)}" target="_blank" rel="noopener">打开仓库</a>` : ''}</div>`;
  $('#dc-guide').showModal();
}

// ---------- 搭建清单 ----------

function openPlan() {
  const items = st.plan.map((r) => st.items.find((x) => x.repository === r) ?? { repository: r, title: r, guideState: 'unknown' });
  const blockers = [];
  if (!st.online) blockers.push('需要连接社区服务。');
  else if (!st.user) blockers.push('需要先登录。');
  const unreviewed = items.filter((x) => x.guideState !== 'reviewed');
  if (st.online && unreviewed.length) blockers.push(`${unreviewed.map((x) => x.title).join('、')} 的中文导读还没核对，暂时不能生成清单。`);
  $('#dc-plan-body').innerHTML = `
    <p class="eyebrow">搭建清单</p>
    <h2 id="dc-plan-title" class="sheet-title">你想做出什么？</h2>
    <ol class="plan-list">${items.map((x) => `<li><span>${esc(x.title)}</span><button type="button" class="btn-link" data-drop="${esc(x.repository)}">移除</button></li>`).join('')}</ol>
    <label class="plan-goal">目标<textarea id="plan-goal" rows="3" maxlength="500" placeholder="例如：用 STM32 做一台能自己平衡的小车，预算 300 元以内"></textarea></label>
    ${blockers.length ? `<p class="notice"><span class="notice-dot" aria-hidden="true"></span><span>${blockers.map(esc).join('<br>')}</span></p>` : ''}
    <div class="btn-group sheet-cta">
      <button class="btn btn-primary" type="button" id="plan-go"${blockers.length ? ' aria-disabled="true"' : ''}>生成搭建清单</button>
      ${st.online && !st.user ? `<a class="btn btn-outline" href="${esc(loginURL())}">去登录</a>` : ''}
    </div>
    <div id="plan-result" aria-live="polite"></div>`;
  $('#dc-plan').showModal();
}

$('#dc-plan-body').addEventListener('click', async (e) => {
  const drop = e.target.closest('[data-drop]');
  if (drop) {
    st.plan = st.plan.filter((r) => r !== drop.dataset.drop);
    store.set(PLAN_KEY, st.plan, true);
    $$(`.slide [data-act="plan"]`, feed).forEach((b) => {
      const it = st.items[Number(b.closest('.slide').dataset.i)];
      b.classList.toggle('is-on', st.plan.includes(it.repository));
    });
    status();
    return st.plan.length ? openPlan() : $('#dc-plan').close();
  }
  const go = e.target.closest('#plan-go');
  if (!go || go.hasAttribute('aria-disabled') || go.disabled) return;
  const goal = $('#plan-goal').value.trim();
  if (!goal) return $('#plan-goal').focus();
  go.disabled = true;
  go.textContent = '正在生成…';
  try {
    const w = await hubApi.workflow(goal, st.plan);
    const steps = w?.data?.steps ?? [];
    $('#plan-result').innerHTML = `<p class="notice"><span class="notice-dot" aria-hidden="true"></span><span>${esc(w?.data?.notice ?? '')}</span></p>
      <ol class="plan-steps">${steps.map((s) => `<li><b>${esc(s.title)}</b><p>${esc(s.instructions ?? '')}</p></li>`).join('')}</ol>`;
    go.textContent = '已生成，保存在“我的”里';
  } catch (err) {
    go.disabled = false;
    go.textContent = '生成搭建清单';
    $('#plan-result').innerHTML = `<p class="ct-errors">${esc(err.message ?? '生成失败')}</p>`;
  }
});

$('#dc-plan-btn').addEventListener('click', openPlan);
$$('dialog').forEach((d) => d.addEventListener('click', (e) => (e.target === d || e.target.closest('[data-close]')) && d.close()));

// ---------- 分类与键盘 ----------

$('#dc-shelf').addEventListener('click', (e) => {
  const b = e.target.closest('[data-shelf]');
  if (!b || b.dataset.shelf === st.shelf || detailOpen || detailClosing) return;
  st.shelf = b.dataset.shelf;
  $$('[data-shelf]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  saveDiscoveryURL();
  applyDiscoveryFilter();
});

let searchTimer;
function searchProjects() {
  clearTimeout(searchTimer);
  st.query = $('#dc-query').value.trim();
  saveDiscoveryURL();
  applyDiscoveryFilter();
}
$('#dc-search-toggle').addEventListener('click', () => {
  const form = $('#dc-search');
  form.hidden = !form.hidden;
  $('#dc-search-toggle').setAttribute('aria-expanded', String(!form.hidden));
  if (!form.hidden) $('#dc-query').focus();
});
$('#dc-search').addEventListener('submit', e => { e.preventDefault(); searchProjects(); });
$('#dc-query').addEventListener('input', e => { clearTimeout(searchTimer); if (!e.isComposing) searchTimer = setTimeout(searchProjects, 180); });
$('#dc-query').addEventListener('compositionend', () => { clearTimeout(searchTimer); searchTimer = setTimeout(searchProjects, 180); });
$('#dc-search-clear').addEventListener('click', () => { $('#dc-query').value = ''; searchProjects(); $('#dc-query').focus(); });
attachSearchSuggestions($('#dc-query'), {
  ...projectSearchOptions, limit: 7,
  getItems: () => filterDiscovery(st.catalogue, { shelf: st.shelf, hidden: [...st.hidden] }),
  getMeta: it => it.repository,
  getQuery: it => it.title,
  onSelect: () => searchProjects(),
});

addEventListener('keydown', (e) => {
  if (document.querySelector('dialog[open]') || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return;
  const k = e.key.toLowerCase();
  if (rackMode && rack) return rackKeys(e, k);
  const slide = slideEl(st.index);
  const it = st.items[st.index];
  if (['arrowdown', 'j', 'pagedown', ' '].includes(k)) { e.preventDefault(); go(1); }
  else if (['arrowup', 'k', 'pageup'].includes(k)) { e.preventDefault(); go(-1); }
  else if (!it || !slide) return;
  else if (k === 'l') save(it, slide.querySelector('[data-act="save"]'));
  else if (k === 'x') hide(it, slide);
  else if (k === 'b') togglePlan(it, slide.querySelector('[data-act="plan"]'));
  else if (k === 'g' || k === 'enter') slide.querySelector('[data-act="guide"]') ? openGuide(it) : null;
  else if (k === 'o' && safeURL(it.repositoryUrl)) open(it.repositoryUrl, '_blank', 'noopener');
});

// ---------- 光碟架：有 WebGL 时代替竖滑流（?view=feed 可以回到竖滑流） ----------
// 左边简介、下方数据（GitHub ★ / 站内收藏 / 评论 / 浏览），点光碟展开详细介绍和评论。
// 浏览量和评论数只来自社区服务；静态页面上显示“—”，不编数字。

const rackMode = new URLSearchParams(location.search).get('view') !== 'feed' && webglAvailable();
const dg = $('#dg');
const VIEWED_KEY = 'luokixi.discover.viewed';
let rack = null;
let rackLoading = null;
let detailOpen = false;
let detailClosing = false;
let detailGeneration = 0;
let indexGeneration = 0;
const swaps = {};
const field = (k) => dg.querySelector(`[data-f="${k}"]`);

// 盘面上的项目名：长名字拆成两行
function discLabel(title) {
  const t = String(title || '').trim();
  if ([...t].length <= 8) return [t];
  const parts = t.split(/\s+/);
  if (parts.length > 1) {
    const mid = Math.ceil(parts.length / 2);
    return [parts.slice(0, mid).join(' '), parts.slice(mid).join(' ')];
  }
  const chars = [...t], half = Math.ceil(chars.length / 2);
  return [chars.slice(0, half).join(''), chars.slice(half).join('')];
}

function discOf(it) {
  const cat = CATEGORIES[it.category];
  return {
    key: it.repository,
    hue: cat?.hue ?? hueOf(it.repository),
    label: discLabel(it.title),
    repo: it.repository,
    ring: `${it.title}  ·  ${cat?.name ?? '开源项目'}  ·  ${it.license || '许可待核'}  ·  ★ ${it.githubStars != null ? fmtNum(it.githubStars) : '—'}  ·  LUOKIXI 开源广场`,
    cover: safeURL(it.cover),
  };
}

function guideLabel(it) {
  if (it.guideState === 'reviewed') return '中文导读 · 已核对';
  if (it.guideState === 'static') return '人工简介';
  return 'AI 导读尚未核对';
}

const counted = (it, k) => (st.online && it.entryId && it[k] != null ? fmtNum(it[k]) : '—');

function rackStats(it) {
  const local = !st.online || !it.entryId;
  const saved = isSaved(it);
  field('gh').textContent = it.githubStars != null ? fmtNum(it.githubStars) : '—';
  field('saveLabel').textContent = local ? '本机收藏' : '站内收藏';
  field('site').textContent = local ? (saved ? '已收藏' : '收藏') : fmtNum(it.siteStars ?? 0);
  field('replies').textContent = counted(it, 'replyCount');
  field('views').textContent = counted(it, 'views');
  const off = st.online ? '这个项目还没收录进本站' : '需要连接社区服务';
  field('replies').title = field('replies').textContent === '—' ? off : '';
  field('views').title = field('views').textContent === '—' ? off : '';
  $$('[data-act="save"]', dg).forEach((b) => { b.setAttribute('aria-pressed', String(saved)); b.classList.toggle('is-on', saved); });
  $$('[data-act="plan"]', dg).forEach((b) => b.classList.toggle('is-on', st.plan.includes(it.repository)));
  const dv = $('#dg-d-views'), dr = $('#dg-d-replies'), ds = $('#dg-d-site');
  if (dv) dv.textContent = counted(it, 'views');
  if (dr) dr.textContent = counted(it, 'replyCount');
  if (ds) ds.textContent = local ? (saved ? '已收藏到本机' : '—') : fmtNum(it.siteStars ?? 0);
}

function rackInfo(i, animate = true) {
  const it = st.items[i];
  if (!it) return;
  st.index = i;
  const tags = [it.shelf ? SHELF[it.shelf] : null, CATEGORIES[it.category]?.name, guideLabel(it), it.tested ? '已实测' : null].filter(Boolean).join(' · ');
  const values = [tags, it.title, `${it.repository}${it.credit ? ` · ${it.credit}` : ''}`, it.idea || '原项目没有写简介。'];
  const els = ['tags', 'title', 'repo', 'intro'].map(field);
  if (animate) swaps.info = swapLines(els, values, swaps.info);
  else { swaps.info?.kill(); swaps.info = null; els.forEach((el, k) => (el.textContent = values[k])); }
  rackStats(it);
  $('#dg-count').textContent = `${i + 1} / ${st.cursor ? `${st.items.length}+` : st.items.length}`;
  $$('#dg-index button').forEach((b, k) => b.setAttribute('aria-current', String(k === i)));
  dg.querySelector('.dg-live').textContent = `${it.title}，第 ${i + 1} 个项目`;
  status();
  if (i >= st.items.length - 3) fetchMore();
}

function rackIndex() {
  $('#dg-index').innerHTML = st.items
    .map((it, i) => `<li><button type="button" data-goto="${i}" aria-current="${i === st.index}"><span>${esc(it.title)}</span><small>${esc(CATEGORIES[it.category]?.name ?? '')}</small></button></li>`)
    .join('');
}

async function rackAdd(batch, start) {
  if (!batch.length) return;
  const mounting = !rack, mountedItems = st.items;
  if (!rack) {
    rackLoading ??= mountRack(dg, batch.map(discOf), { onActive: i => { if (rack) rackInfo(i); }, onOpen: () => openDetail() })
      .then(r => { rack = r; return r; })
      .catch(() => { leaveRack(); renderSlides(st.items, 0); return null; });
    if (!await rackLoading) { rackLoading = null; return; }
  }
  // A query may have changed while WebGL was loading. Always render current state.
  const desired = st.index;
  if (!mounting || mountedItems !== st.items || desired !== 0) {
    rack.setItems(st.items.map(discOf));
    rack.go(desired, { duration: 0 });
  }
  dg.hidden = !st.items.length;
  $('.dc').classList.toggle('dg-on', !!st.items.length);
  rackInfo(desired, false);
  rackIndex();
}

function leaveRack() {
  if (!rackMode) return;
  rack?.destroy();
  rack = null;
  rackLoading = null;
  dg.hidden = true;
  $('.dc').classList.remove('dg-on', 'dg-detail-open');
}

// ---------- 片单 ----------

function setIndex(open) {
  const ticket = ++indexGeneration;
  const panel = $('#dg-index'), scrim = dg.querySelector('.dg-scrim'), btn = dg.querySelector('.dg-index-btn');
  panel.getAnimations().forEach(a => a.cancel());
  scrim.getAnimations().forEach(a => a.cancel());
  btn.setAttribute('aria-expanded', String(open));
  if (reducedMotion()) { panel.hidden = !open; scrim.hidden = !open; return; }
  if (open) { panel.hidden = false; scrim.hidden = false; }
  gsapLite(scrim, open ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 1 }, { opacity: 0 }], open ? 400 : 250).then(() => { if (!open && ticket === indexGeneration) scrim.hidden = true; });
  gsapLite(panel, open ? [{ opacity: 0, transform: 'translateY(-8px) scale(.98)' }, { opacity: 1, transform: 'none' }] : [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-8px) scale(.98)' }], open ? 450 : 220)
    .then(() => { if (!open && ticket === indexGeneration) panel.hidden = true; });
  if (open) panel.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
}
// 小弹层用浏览器自带的 Web Animations，曲线和光碟架同一条
function gsapLite(el, frames, duration) {
  const a = el.animate(frames, { duration, easing: 'cubic-bezier(0.32, 0.72, 0, 1)', fill: 'forwards' });
  return a.finished.catch(() => {});
}

// ---------- 详细介绍 ----------

function detailHTML(it) {
  const cat = CATEGORIES[it.category];
  const ev = new Map((it.evidence ?? []).map((x) => [x.id, x]));
  const local = !st.online || !it.entryId;
  const rows = [
    ['分类', esc(cat?.name ?? '—')],
    ['许可证', it.license ? esc(it.license) : '许可待核'],
    ['GitHub ★', it.githubStars != null ? fmtNum(it.githubStars) : '—'],
    [local ? '本机收藏' : '站内收藏', `<span id="dg-d-site"></span>`],
    ['浏览', `<span id="dg-d-views"></span>`],
    ['评论', `<span id="dg-d-replies"></span>`],
    ['收录时间', it.uploadedAt ? new Date(it.uploadedAt).toLocaleString('zh-CN') : '历史记录未注明'],
    ['上传者', esc(it.uploadedBy || it.credit || '历史记录未注明')],
    ['审核者', esc(it.reviewedBy || '历史记录未注明')],
    ['核对于', it.verifiedAt ? timeAgo(it.verifiedAt) : '—'],
  ];
  const release = (it.downloads ?? []).filter((d) => d.kind === 'official-release');
  const source = (it.downloads ?? []).filter((d) => d.kind !== 'official-release');
  const dl = (d) => (safeURL(d.url) ? `<li><a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.name)}</a>${d.version ? ` · ${esc(d.version)}` : ''}</li>` : '');
  return `
    <div class="dg-d-block"><p class="dg-d-kicker">${esc([it.shelf ? SHELF[it.shelf] : null, guideLabel(it)].filter(Boolean).join(' · '))}</p></div>
    <div class="dg-d-block" data-content-key="${esc(it.entryId?'entry/'+it.entryId:'github/'+it.repository)}"><h2 class="dg-d-title" id="dg-d-title">${esc(it.title)}</h2></div>
    <div class="dg-d-block"><p class="dg-d-repo num">${esc(it.repository)}${it.credit ? ` · ${esc(it.credit)}` : ''}</p></div>
    <dl class="dg-d-table"><div class="dg-rule"></div>${rows.map(([k, v]) => `<div class="dg-d-block"><dt>${k}</dt><dd class="num">${v}</dd></div><div class="dg-rule"></div>`).join('')}</dl>
    <div class="dg-d-actions dg-d-block">
      <button class="btn btn-primary dg-star" type="button" data-act="save" aria-pressed="false"><span class="ico" aria-hidden="true">★</span>${local ? '收藏到本机' : '站内收藏'}</button>
      <button class="btn btn-outline" type="button" data-act="download">下载</button>
      ${safeURL(it.repositoryUrl) ? `<a class="btn btn-outline" href="${esc(it.repositoryUrl)}" target="_blank" rel="noopener">查看原作 ↗</a>` : ''}
      ${safeURL(it.readmeUrl) ? `<a class="btn btn-outline" href="${esc(it.readmeUrl)}" target="_blank" rel="noopener">阅读 README ↗</a>` : ''}
      ${safeURL(it.videoUrl) ? `<a class="btn btn-outline" href="${esc(it.videoUrl)}" target="_blank" rel="noopener">观看演示 ↗</a>` : ''}
      <button class="btn btn-outline" type="button" data-act="plan">加入搭建清单</button>
    </div>
    ${it.idea ? `<section class="dg-d-sec dg-d-block"><h3>简介</h3><p${it.ideaLanguage === 'original' ? ' lang="en"' : ''}>${esc(it.idea)}</p></section>` : ''}
    ${it.whyRecommended ? `<section class="dg-d-sec dg-d-block"><h3>为什么推荐</h3><p>${esc(it.whyRecommended)}</p></section>` : ''}
    ${(it.sections ?? []).map((sec) => `<section class="dg-d-sec dg-d-block"><h3>${esc(sec.heading)}</h3><p>${esc(sec.text)}</p>${sec.evidenceIds?.length ? `<p class="cite">依据：${sec.evidenceIds.map((id) => ev.get(id)).filter((x) => x && safeURL(x.url)).map((x) => `<a href="${esc(x.url)}" target="_blank" rel="noopener" title="${esc(x.text ?? '')}">${esc(x.id)}</a>`).join('、') || '—'}</p>` : ''}</section>`).join('')}
    ${(it.unknowns ?? []).length ? `<section class="dg-d-sec dg-d-block"><h3>原项目未说明</h3><ul>${it.unknowns.map((u) => `<li>${esc(u)}</li>`).join('')}</ul></section>` : ''}
    ${release.length ? `<section class="dg-d-sec dg-d-block"><h3>官方发布包</h3><ul>${release.map(dl).join('')}</ul></section>` : ''}
    ${source.length ? `<section class="dg-d-sec dg-d-block"><h3>源代码</h3><p class="cite">源代码不是安装包，需要按原项目说明构建。</p><ul>${source.map(dl).join('')}</ul></section>` : ''}
    ${it.tested ? `<section class="dg-d-sec dg-d-block"><h3>实测记录</h3><p>${esc(it.testEvidence ?? '')}</p></section>` : ''}
    <section class="dg-comments dg-d-block" id="dg-comments" aria-labelledby="dg-c-title">
      <h3 id="dg-c-title">评论 <span id="dg-c-count"></span></h3>
      <div id="dg-c-body"><p class="dg-c-empty">正在读取…</p></div>
    </section>`;
}

function openDetail({ focus } = {}) {
  const it = st.items[st.index];
  if (!it || !rack || detailOpen) return;
  detailOpen = true;
  detailClosing = false;
  const ticket = ++detailGeneration;
  setIndex(false);
  const detail = $('#dg-detail'), body = $('#dg-d-body');
  detail.getAnimations().forEach(a => a.cancel());
  detail.style.opacity = '';
  $('.dc-top').inert = true;
  $('#dc-plan-btn').inert = true;
  body.innerHTML = detailHTML(it);
  body.scrollTop = 0;
  rackStats(it);
  detail.hidden = false;
  $('.dc').classList.add('dg-detail-open');
  rack.setOpen(true);
  const out = dg.querySelectorAll('.dg-info, .dg-stats, .dg-rail, .dg-nav');
  out.forEach(el => { el.getAnimations().forEach(a => a.cancel()); el.style.opacity = ''; });
  if (!reducedMotion()) {
    out.forEach((el) => el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, easing: 'ease-in', fill: 'forwards' }));
    // 细线逐条画出，内容一块一块浮上来（只动 transform 和 opacity）
    body.querySelectorAll('.dg-rule').forEach((el, k) => el.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }],
      { duration: 900, delay: 380 + k * 60, easing: 'cubic-bezier(0.32, 0.72, 0, 1)', fill: 'backwards' }));
    body.querySelectorAll('.dg-d-block').forEach((el, k) => el.animate([{ opacity: 0, transform: 'translateY(18px)' }, { opacity: 1, transform: 'none' }],
      { duration: 600, delay: 300 + Math.min(k, 14) * 35, easing: 'cubic-bezier(0.32, 0.72, 0, 1)', fill: 'backwards' }));
    dg.querySelector('.dg-back').animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, delay: 400, fill: 'backwards' });
  } else out.forEach((el) => (el.style.opacity = '0'));
  out.forEach((el) => el.setAttribute('inert', ''));
  dg.querySelector('.dg-back').focus({ preventScroll: true });
  recordView(it);
  loadComments(it).then(() => {
    if (detailOpen && ticket === detailGeneration && focus === 'comments') $('#dg-comments')?.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
  });
}

function closeDetail(instant = false) {
  if (!detailOpen && !detailClosing) return;
  detailOpen = false;
  detailClosing = true;
  const ticket = ++detailGeneration;
  const detail = $('#dg-detail');
  detail.getAnimations().forEach(a => a.cancel());
  const out = dg.querySelectorAll('.dg-info, .dg-stats, .dg-rail, .dg-nav');
  const done = () => {
    if (ticket !== detailGeneration) return;
    detailClosing = false;
    detail.hidden = true;
    $('.dc').classList.remove('dg-detail-open');
    $('.dc-top').inert = false;
    $('#dc-plan-btn').inert = false;
    out.forEach(el => { el.removeAttribute('inert'); el.getAnimations().forEach(a => a.cancel()); el.style.opacity = ''; });
    rack?.focus();
  };
  rack?.setOpen(false);
  if (instant || reducedMotion()) { done(); return; }
  detail.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 250, easing: 'ease-in' }).finished.then(() => {
    if (ticket !== detailGeneration) return;
    done();
    out.forEach(el => el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 450, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' }));
  }).catch(() => {});
}

// 浏览量：每个项目在这个浏览器会话里只报一次；服务端再按人按天去重
function recordView(it) {
  if (!st.online || !it.entryId) return;
  const seen = new Set(store.get(VIEWED_KEY, []));
  if (seen.has(it.entryId)) return;
  seen.add(it.entryId);
  store.set(VIEWED_KEY, [...seen], true);
  hubApi.view(it.entryId).then((r) => {
    if (r?.views == null) return;
    it.views = r.views;
    if (st.items[st.index] === it) rackStats(it);
  }).catch(() => {});
}

async function loadComments(it) {
  const body = $('#dg-c-body'), count = $('#dg-c-count'), ticket = detailGeneration;
  const current = () => detailOpen && ticket === detailGeneration && st.items[st.index] === it && body?.isConnected;
  if (!body) return;
  if (!st.online) {
    body.innerHTML = '<p class="dg-c-empty">评论保存在社区服务里；现在是只读的静态页面，暂时看不到也不能发表。</p>';
    return;
  }
  if (!it.entryId) {
    body.innerHTML = `<p class="dg-c-empty">这个项目来自开源目录，还没有收录进本站，暂时不能评论。${safeURL(it.repositoryUrl) ? ` <a href="${esc(it.repositoryUrl)}" target="_blank" rel="noopener">去原项目交流 ↗</a>` : ''}</p>`;
    return;
  }
  let rows = [];
  try {
    const r = await hubApi.entry(it.entryId);
    if (!current()) return;
    rows = r.replies ?? [];
    if (r.views != null) it.views = r.views;
    if (r.replyCount != null) it.replyCount = r.replyCount;
    rackStats(it);
  } catch (e) {
    if (!current()) return;
    body.innerHTML = `<p class="dg-c-empty">评论暂时读不到：${esc(e.message ?? '')}</p>`;
    return;
  }
  if (!current()) return;
  count.textContent = it.replyCount != null ? fmtNum(it.replyCount) : '';
  const list = rows.length
    ? `<ol class="dg-c-list">${rows.map((r) => `<li><b>${esc(r.author?.name || '同学')}</b>${r.state !== 'published' ? '<span class="state">审核中，只有你看得到</span>' : ''}<p>${esc(r.body)}</p></li>`).join('')}</ol>`
    : '<p class="dg-c-empty">还没有公开评论。用过的话，说说你做了什么、卡在了哪里。</p>';
  const form = st.user
    ? `<form class="dg-c-form" id="dg-c-form"><label class="sr-only" for="dg-c-text">写评论</label><textarea id="dg-c-text" maxlength="2000" required placeholder="说说你用它做了什么、卡在哪了"></textarea><div class="row"><small>评论经审核后公开。</small><button class="btn btn-primary btn-sm" type="submit">发表</button></div></form>`
    : `<p class="dg-c-note"><a href="${esc(loginURL())}">登录</a>后可以发表评论。</p>`;
  body.innerHTML = list + form;
}

dg.addEventListener('submit', async (e) => {
  if (e.target.id !== 'dg-c-form') return;
  e.preventDefault();
  const it = st.items[st.index], text = $('#dg-c-text'), btn = e.target.querySelector('[type=submit]');
  if (!it?.entryId || !text.value.trim()) return;
  btn.disabled = true;
  try {
    const r = await hubApi.reply(it.entryId, text.value.trim());
    toast(r?.state === 'published' ? '评论已发表。' : '已提交，审核通过后公开。');
    await loadComments(it);
  } catch (err) {
    toast(err.message ?? '发表失败，请稍后再试。');
    btn.disabled = false;
  }
});

// 不感兴趣：这张盘沉下去，后面的补上来；可以撤销
async function rackHide(it) {
  if (st.online && st.user) {
    try { await hubApi.feedback(it.repository, 'not-interested'); } catch (e) { return toast(e.message); }
  } else {
    st.hidden.add(it.repository);
    store.set(HIDE_KEY, [...st.hidden]);
  }
  st.hidden.add(it.repository);
  const i = st.items.indexOf(it);
  if (i >= 0) {
    closeDetail(true);
    st.items.splice(i, 1);
    rack?.remove(i);
    rackIndex();
  }
  toast(st.online && st.user ? '以后不再推荐这个项目。' : '已在本机隐藏这个项目。', {
    label: '撤销',
    onClick: async () => {
      if (st.online && st.user) { try { await hubApi.feedback(it.repository, 'clear'); } catch (e) { return toast(e.message); } }
      else { st.hidden.delete(it.repository); store.set(HIDE_KEY, [...st.hidden]); }
      st.hidden.delete(it.repository);
      // Re-evaluate the current category/query; an old async undo must not
      // insert a project into an unrelated shelf.
      await applyDiscoveryFilter();
    },
  });
  if (!st.items.length) renderEmpty();
}

dg.addEventListener('click', (e) => {
  const go = e.target.closest('[data-goto]');
  if (go) { setIndex(false); rack?.go(Number(go.dataset.goto), { duration: 1.2 }); rack?.focus(); return; }
  if (e.target.closest('.dg-index-btn')) return setIndex($('#dg-index').hidden);
  if (e.target.closest('.dg-scrim')) return setIndex(false);
  const btn = e.target.closest('[data-act]');
  const it = st.items[st.index];
  if (!btn || !it) return;
  const act = btn.dataset.act;
  if (act === 'close') { e.preventDefault(); e.stopPropagation(); }
  if (act === 'open') openDetail();
  if (act === 'close') closeDetail();
  if (act === 'comments') detailOpen ? $('#dg-comments')?.scrollIntoView({ behavior: 'smooth' }) : openDetail({ focus: 'comments' });
  if (act === 'download') openDownload(it);
  if (act === 'plan') { togglePlan(it, btn); rackStats(it); }
  if (act === 'hide') rackHide(it);
  if (act === 'save') {
    save(it, btn).then(() => {
      rackStats(it);
      // 收藏图标像 SF Symbols 那样弹一下
      if (!reducedMotion()) btn.querySelector('b, .ico')?.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.25)' }, { transform: 'scale(1)' }], { duration: 380, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' });
    });
  }
});

function rackKeys(e, k) {
  if (detailOpen || detailClosing) {
    if (k === 'escape') { e.preventDefault(); closeDetail(); }
    return;
  }
  if (!$('#dg-index').hidden && k === 'escape') return setIndex(false);
  const it = st.items[st.index];
  if (document.activeElement !== dg.querySelector('.dg-stage')) {
    if (['arrowright', 'arrowdown', 'j'].includes(k)) { e.preventDefault(); rack.go(st.index + 1); }
    else if (['arrowleft', 'arrowup', 'k'].includes(k)) { e.preventDefault(); rack.go(st.index - 1); }
  }
  if (!it) return;
  if (k === 'l') dg.querySelector('.dg-stats [data-act="save"]').click();
  else if (k === 'x') rackHide(it);
  else if (k === 'b') dg.querySelector('.dg-rail [data-act="plan"]').click();
  else if (k === 'g' || (k === 'enter' && document.activeElement === document.body)) openDetail();
  else if (k === 'o' && safeURL(it.repositoryUrl)) open(it.repositoryUrl, '_blank', 'noopener');
}

// ---------- 启动 ----------

hubState().then((s) => {
  st.online = s.online;
  st.user = s.user;
  const params = new URLSearchParams(location.search);
  st.shelf = Object.hasOwn(DISC_TOPICS, params.get('shelf')) ? params.get('shelf') : 'all';
  st.query = (params.get('q') || '').slice(0,160);
  $('#dc-query').value = st.query;
  if (st.query) { $('#dc-search').hidden = false; $('#dc-search-toggle').setAttribute('aria-expanded','true'); }
  $$('[data-shelf]').forEach(b => b.setAttribute('aria-pressed',String(b.dataset.shelf === st.shelf)));
  fetchMore();
});

// Real public discussion is the only source for danmaku; empty stays empty.
const discussionCache=new Map();
async function discussion(it){
 if(!it.entryId)return [];
 if(!discussionCache.has(it.entryId))discussionCache.set(it.entryId,hubApi.entry(it.entryId).then(r=>(r.replies||[]).filter(x=>x.state==='published')).catch(e=>{discussionCache.delete(it.entryId);throw e;}));
 return discussionCache.get(it.entryId);
}
async function openDiscussion(it){
 try{const rows=await discussion(it);$('#dc-guide-body').innerHTML=`<p class="eyebrow">项目讨论</p><h2 id="dc-guide-title" class="sheet-title">${esc(it.title)}</h2>${rows.length?rows.map(r=>`<article class="feed-comment"><b>${esc(r.author?.name||'同学')}</b><p>${esc(r.body)}</p></article>`).join(''):`<p class="sheet-lead">${it.entryId?'还没有公开评论，欢迎留下第一条使用体验。':'这个项目来自开源目录，还没有本站讨论。可以到原仓库交流，或推荐收录。'}</p>`}<div class="btn-group">${it.entryId?`<a class="btn btn-primary" href="project.html?id=${encodeURIComponent(it.entryId)}">参与项目讨论</a>`:`<a class="btn btn-primary" href="${esc(it.repositoryUrl)}" target="_blank" rel="noopener">前往原项目 ↗</a>`}</div>`;$('#dc-guide').showModal();}catch(e){toast(e.message);}
}
async function toggleDanmaku(it,slide,button){
 const wall=slide.querySelector('.project-danmaku');
 if(button.getAttribute('aria-pressed')==='true'){button.setAttribute('aria-pressed','false');wall.replaceChildren();return;}
 button.disabled=true;
 try{const rows=await discussion(it);if(!rows.length)return toast('这个项目还没有公开评论，暂时没有弹幕。');if(reducedMotion())return openDiscussion(it);
 wall.innerHTML=rows.slice(0,9).map((r,i)=>`<span style="--lane:${i%3};--delay:${Math.floor(i/3)*4}s">${esc(r.body.slice(0,80))}</span>`).join('');button.setAttribute('aria-pressed','true');
 }catch(e){toast(e.message);}finally{button.disabled=false;}
}
