// 校圈（Opus · 2026-10-07 改版）：App Store 的版式 + 虎扑的组织方式。
// 从上到下：搜索 → 校园头条（Today 大卡片）→ 校圈热榜（近 7 天，编号 + 变化）→ 逛吧（货架）→ 教师评分（货架）→ 帖子流（竖排）。
// 帖子详情从被点的卡片“长”出来；楼层编号，获赞最多的回复先放上面（亮回复）。
// 接口：circle/feed、circle/hot、circle/posts/<id>/thread、circle/replies/<id>/like、reputation/rankings（campus/hub/circle.py、reputation.py）。
import { initShell } from '../js/shell.js';
import { canParticipate, hubApi, hubState, loginURL } from '../js/hub.js';
import { esc } from '../js/data.js';
import { pop, rollTo, openFrom, closeTo, setSegment, refreshFx, disposeTilts } from '../js/fx.js';
import { attachSearchSuggestions } from '../js/search-suggestions.js';
import { depthSlides, mountDepthSlider } from '../js/depth-slider.js';
import '../styles/circle-news.css';

initShell();

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const scrollToEl = (el) => el?.scrollIntoView({ behavior: reduced() ? 'instant' : 'smooth', block: 'start' });
const face = user => user?.avatar === '/art/beikuang/avatar.png' ? `<img src="${esc(user.avatar)}" alt="" loading="lazy" decoding="async" style="width:100%;height:100%;object-fit:cover;transform:scale(2);transform-origin:50% 35%">` : initial(user?.name);
const CAMPUS = { all: '全校', shahe: '沙河', xueyuanlu: '学院路' };
const S = { boards: [], items: [], lane: 'recommended', board: '', cursor: null, serial: 0, thread: null, threadSerial: 0, replyTarget: null, user: null, proposals: [], news: [], searchPosts: new Map() };

// 图标：Lucide（ISC 许可，见 src/js/vendor/LUCIDE-LICENSE.txt）
const ICON = {
  flame: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>',
  comment: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg>',
  star: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
};

function timeAgo(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = (Date.now() - t) / 1000;
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} 天前`;
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric' }).format(t);
}
const fmtDay = (iso) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? '' : new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric' }).format(t);
};
const safeHref = (u) => {
  try { const x = new URL(u); return ['https:', 'http:'].includes(x.protocol) && !x.username && !x.password ? x.href : ''; } catch { return ''; }
};
const boardName = (id) => S.boards.find((b) => b.id === id)?.name || '校园话题';
const initial = (name) => esc([...(name || '同')][0]);
const stars = (v) => {
  const pct = v == null ? 0 : Math.max(0, Math.min(100, (v / 5) * 100));
  return `<span class="as-stars" aria-hidden="true">★★★★★<span style="width:${pct}%">★★★★★</span></span>`;
};

function needLogin(message = '登录后才能这样做。') {
  status(`${message} <a href="${esc(loginURL())}">登录 / 注册 ›</a>`, true);
}
function status(html, isHTML = false) {
  const box = $('#circle-status');
  if (isHTML) box.innerHTML = html; else box.textContent = html;
}

// ---------- 吧 ----------
function boardIcon(b) {
  return `<span class="as-icon cs-board-icon" aria-hidden="true">${initial(b.name.replace(/吧$/, ''))}</span>`;
}
function renderBoards() {
  const add = `<button class="as-lockup cs-board-new" type="button" data-propose>
      <span class="as-icon is-add" aria-hidden="true">${ICON.plus}</span>
      <span class="as-lockup-text"><b>开一个新吧</b><span>找不到想聊的？申请开吧，审核后开通</span></span>
      <span class="as-get is-small">申请</span></button>`;
  $('#circle-boards').innerHTML = add + S.boards.map((b) => `
    <div class="as-lockup" data-board-id="${esc(b.id)}" role="button" tabindex="0" aria-pressed="${S.board === b.id}">
      ${boardIcon(b)}
      <span class="as-lockup-text"><b>${esc(b.name)}</b><span>${esc(b.description || '')}</span><small>${b.posts || 0} 篇帖子${b.followed ? ' · 已关注' : ''}</small></span>
      <span class="as-get is-small">进入</span>
    </div>`).join('');
  $('#post-board').innerHTML = S.boards.map((b) => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('');
}
function renderBoardInfo() {
  const b = S.boards.find((x) => x.id === S.board);
  const box = $('#board-info');
  $('#circle-feed-title').textContent = b ? b.name : '大家正在聊';
  $('#circle-feed-sub').textContent = b ? `${b.posts || 0} 篇帖子` : '来自矿大同学的帖子';
  box.hidden = !b;
  if (!b) return;
  box.innerHTML = `${boardIcon(b)}
    <div class="cs-board-info-text"><p>${esc(b.description || '')}</p><small>吧规：${esc(b.rules || '分享真实经历，尊重彼此；投稿审核后公开。')}</small></div>
    <div class="cs-board-info-actions">
      <button class="as-get ${b.followed ? 'is-on' : 'is-primary'} is-small" type="button" data-follow-board>${b.followed ? '已关注' : '关注'}</button>
      <button class="as-see-all" type="button" data-board-id="">看全部吧</button>
    </div>`;
}
async function selectBoard(id) {
  S.board = id;
  renderBoards();
  renderBoardInfo();
  await load();
  scrollToEl($('#cs-feed-section'));
}

function authorFollowHTML(p) {
  return p.canFollowAuthor && p.owner?.username ? `<button class="as-get is-small ${p.authorFollowed ? 'is-on' : ''}" type="button" data-follow-creator="${esc(p.owner.username)}" aria-pressed="${Boolean(p.authorFollowed)}">${p.authorFollowed ? '已关注作者' : '关注作者'}</button>` : '';
}

// ---------- 帖子流（竖排） ----------
function postCard(p) {
  const d = p.data || {};
  const c = d.circle || {};
  const photos = (p.photos || []).slice(0, 3);
  return `<article class="cs-post fx-press" data-post="${esc(p.id)}" data-content-key="entry/${esc(p.id)}">
    <header class="cs-post-head">
      <span class="cs-avatar" aria-hidden="true">${face(p.owner)}</span>
      <span class="cs-post-who"><b>${esc(p.owner?.name || '同学')}</b><span>${esc(boardName(c.board))} · ${esc(CAMPUS[c.campus] || '全校')}</span></span>
      ${authorFollowHTML(p)}
      <time class="cs-post-time" datetime="${esc(c.publishedAt || p.created || '')}">${esc(timeAgo(c.publishedAt || p.created || ''))}</time>
    </header>
    <h3 class="cs-post-title">${esc(d.title || '')}</h3>
    ${d.body || d.summary ? `<p class="cs-post-body">${esc(d.body || d.summary)}</p>` : ''}
    ${photos.length ? `<div class="cs-post-photos is-${photos.length}${photos.length > 1 ? ' ds-track' : ''}">${depthSlides(photos, p.photoCredit || '帖子配图')}</div>` : ''}
    ${p.recommendationReasons?.length ? `<p class="cs-feed-reason">${p.recommendationReasons.map(esc).join(' · ')}</p>` : ''}
    ${p.selection ? `<p class="cs-post-pick"><span class="as-hot-badge">精选</span>${esc(p.selection.reason)}</p>` : ''}
    <footer class="as-review-foot cs-post-foot">
      <button type="button" data-like="${esc(p.id)}" aria-pressed="${Boolean(p.liked)}" aria-label="亮了">${ICON.flame}<span class="num">${p.likes || 0}</span></button>
      <button type="button" data-open="${esc(p.id)}" aria-label="评论">${ICON.comment}<span class="num">${p.replies || 0}</span></button>
      <button type="button" data-star="${esc(p.id)}" aria-pressed="${Boolean(p.starred)}">${ICON.star}<span>${p.starred ? '已收藏' : '收藏'}</span></button>
    </footer>
  </article>`;
}
let feedSliders = [], threadSlider = () => {};
function renderFeed() {
  feedSliders.forEach(dispose => dispose());
  $('#circle-feed').innerHTML = S.items.map(postCard).join('') || `<div class="as-empty">
      <b>${S.lane === 'following' ? '关注的人和吧还没有新帖子' : '第一条好讨论，从你开始'}</b>
      <p>${S.lane === 'following' ? '在帖子上关注作者，或去“逛吧”订阅感兴趣的吧；两者的新帖子都会出现在这里。' : '这里还没有公开帖子。分享一个真实经历，或发起一次合作。'}</p>
      <button class="as-get is-primary" type="button" data-compose>发帖</button></div>`;
  refreshFx($('#circle-feed'));
  feedSliders = [...$('#circle-feed').querySelectorAll('.ds-track')].map(track => mountDepthSlider(track, { enter: false }));
}
async function load(more = false) {
  const serial = ++S.serial;
  $('#circle-feed').setAttribute('aria-busy', 'true');
  if (!more) status('');
  try {
    const r = await hubApi.circleFeed({ lane: S.lane, board: S.board, campus: $('#circle-campus').value, q: $('#circle-q').value.trim(), cursor: more ? S.cursor : null });
    if (serial !== S.serial) return;
    S.cursor = r.nextCursor;
    for (const item of r.items) S.searchPosts.set(item.id, item);
    while (S.searchPosts.size > 200) S.searchPosts.delete(S.searchPosts.keys().next().value);
    S.items = more ? [...new Map([...S.items, ...r.items].map((item) => [item.id, item])).values()] : r.items;
    renderFeed();
    $('#circle-more').hidden = !S.cursor;
    if (S.lane === 'recommended' && S.items.length) status('按你主动选择的兴趣、关注和编辑精选排序；想按时间看就切到“最新”。');
  } catch (e) {
    if (serial !== S.serial) return;
    if (e.status === 401) needLogin('“关注”需要登录。');
    else status(`${esc(e.message)} <button class="as-see-all" type="button" data-retry>重试</button>`, true);
  } finally {
    if (serial === S.serial) $('#circle-feed').setAttribute('aria-busy', 'false');
  }
}

// ---------- 热榜（虎扑热榜：编号、热度、和昨天比的变化） ----------
function trend(change) {
  if (!change || change.kind === 'new') return '<span class="is-new">新</span>';
  if (change.kind === 'up') return `<span class="is-up">▲${change.by}</span>`;
  if (change.kind === 'down') return `<span class="is-down">▼${change.by}</span>`;
  return '<span class="is-flat">—</span>';
}
async function loadHot() {
  const box = $('#cs-hot');
  try {
    const r = await hubApi.circleHot({ campus: $('#circle-campus').value });
    $('#cs-hot-window').textContent = `${r.window} · 回复与点赞`;
    $('#cs-hot-rule').dataset.rule = r.definition;
    box.innerHTML = r.items.length ? r.items.map((it) => `<li>
        <button class="as-chart-row" type="button" data-post="${esc(it.id)}">
          <span class="as-rank">${it.rank}</span>
          <span class="as-chart-text"><b>${esc(it.title)}</b><span>${esc(it.boardName.endsWith('吧') ? it.boardName : `${it.boardName}吧`)} · ${it.replies} 回复 · ${it.likes} 亮</span></span>
          <span class="as-trend"><b class="num">${it.heat}</b>${trend(it.change)}</span>
        </button></li>`).join('')
      : '<li class="as-empty cs-span"><b>近 7 天还没有热帖</b><p>热榜按回复和点赞计算。发一篇、回一帖，它就会动起来。</p></li>';
  } catch (e) {
    box.innerHTML = `<li class="as-empty cs-span"><b>热榜暂时读不到</b><p>${esc(e.message)}</p></li>`;
  }
}

// ---------- 教师评分货架（虎扑评分墙：分数、人数、一句最热原话） ----------
async function loadRatings() {
  const box = $('#cs-rate');
  try {
    const r = await hubApi.reputationRankings('teachers');
    const seen = new Set();
    const items = [...r.hot, ...r.top].filter((t) => !seen.has(t.id) && seen.add(t.id)).slice(0, 10);
    box.innerHTML = items.length ? items.map((t) => {
      const s = t.stats || {};
      const photo = t.photo?.url && safeHref(t.photo.url);
      return `<a class="as-card cs-rate-card" href="reputation.html?teacher=${encodeURIComponent(t.id)}">
        <span class="cs-rate-top">
          <span class="as-icon cs-rate-photo">${photo ? `<img src="${esc(photo)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : initial(t.name)}</span>
          <span class="as-lockup-text"><b>${esc(t.name)}</b><span>${esc([t.faculty, t.title].filter(Boolean).join(' · '))}</span></span>
        </span>
        <span class="cs-rate-score"><b class="num">${s.average == null ? '—' : s.average.toFixed(1)}</b>${stars(s.average)}<small>${s.count} 人评价${s.smallSample ? ' · 样本较少' : ''}</small></span>
        ${t.highlight ? `<blockquote>“${esc(t.highlight.body)}”</blockquote>` : '<blockquote class="is-empty">还没有原话，来写第一条</blockquote>'}
      </a>`;
    }).join('') : `<a class="as-card cs-rate-card is-empty" href="reputation.html"><span class="as-lockup-text"><b>还没有足够的评分</b><span>评分要 5 人以上才上榜。去给教过你的老师写一条吧。</span></span><span class="as-get">去评价</span></a>`;
    box.querySelectorAll('img').forEach((img) => img.addEventListener('error', () => { img.parentElement.textContent = '师'; }, { once: true }));
    refreshFx(box);
  } catch {
    box.innerHTML = `<a class="as-card cs-rate-card is-empty" href="reputation.html"><span class="as-lockup-text"><b>教师口碑</b><span>评分服务暂时读不到，点开看看教师目录。</span></span></a>`;
  }
}

// ---------- 校园头条：编辑精选（featured.json）+ 维护机器人抓到、维护者审过的学校新闻 ----------
async function loadNews() {
  const now = Date.now();
  const out = [];
  try {
    const r = await fetch('data/featured.json', { signal: AbortSignal.timeout(5000) });
    if (r.ok) {
      const d = await r.json();
      for (const n of d.items || []) {
        if (n.kind === 'news' && (!n.startsAt || Date.parse(n.startsAt) <= now) && (!n.expiresAt || Date.parse(n.expiresAt) > now)) {
          out.push({ title: n.title, dek: n.dek || n.reason || '', url: safeHref(n.href || n.source?.url), source: n.source?.name || '编辑核对', date: n.publishedAt || n.eventAt || '', media: n.media });
        }
      }
    }
  } catch { /* 精选文件缺失时只用学校新闻 */ }
  try {
    const r = await hubApi.catalogue({ kind: 'news' });
    for (const e of r.items || []) {
      const d = e.data || {};
      out.push({ title: d.title, dek: d.summary || '', url: safeHref(d.links?.source), source: d.sourceNote || '学校新闻', date: d.publishedAt || e.updated, media: d.media });
    }
  } catch { /* 社区服务未连接 */ }
  const seen = new Set();
  try {
    const r = await hubApi.circleFeed({ board: 'frontier', lane: 'latest' });
    out.push(...r.items.map(p => ({ title: p.data.title, dek: p.data.summary, url: `circle.html?post=${p.id}`, source: p.data.credit, date: p.data.circle?.publishedAt || p.created, media: { src: p.photos?.[0] } })));
  } catch { /* The school feed remains available. */ }
  S.news = out.filter((n) => n.title && n.url && !seen.has(n.url) && seen.add(n.url))
    .sort((x, y) => (Date.parse(y.date) || 0) - (Date.parse(x.date) || 0)).slice(0, 5);
  const box = $('#circle-news');
  disposeTilts(box);
  if (!S.news.length) {
    box.innerHTML = `<article class="as-card as-today is-plain">
      <div class="as-today-top"><p class="as-eyebrow">校园头条</p><h2>今天还没有核对过的学校新闻</h2></div>
      <div class="as-today-bottom"><p>维护机器人会定时读矿大新闻网，维护者核对后出现在这里。</p></div></article>`;
    return;
  }
  const [lead, ...rest] = S.news;
  const img = lead.media?.src && safeHref(lead.media.src);
  box.innerHTML = `<article class="as-card as-today${img ? '' : ' is-plain'}" data-tilt>
      ${img ? `<img src="${esc(img)}" alt="${esc(lead.media.alt || lead.title)}" loading="eager" decoding="async" referrerpolicy="no-referrer">` : ''}
      <div class="as-today-top"><p class="as-eyebrow">校园头条 · ${esc(lead.source)}</p><h2>${esc(lead.title)}</h2></div>
      <div class="as-today-bottom">
        ${lead.dek ? `<p>${esc(lead.dek)}</p>` : ''}
        <div class="as-today-actions"><a class="as-get is-primary" href="${esc(lead.url)}" target="_blank" rel="noopener">阅读原文</a><button class="as-get" type="button" data-discuss="0">讨论这条</button></div>
        <small>${lead.date ? esc(fmtDay(lead.date)) : ''}${lead.media?.credit ? ` · 图片：${esc(lead.media.credit)}` : ''}</small>
      </div>
    </article>
    ${rest.length ? `<ol class="as-chart cs-news-more">${rest.map((n, i) => `<li><div class="as-chart-row">
        <span class="as-rank cs-news-dot" aria-hidden="true"></span>
        <a class="as-chart-text" href="${esc(n.url)}" target="_blank" rel="noopener"><b>${esc(n.title)}</b><span>${esc(n.source)}${n.date ? ` · ${esc(fmtDay(n.date))}` : ''}</span></a>
        <button class="as-get is-small" type="button" data-discuss="${i + 1}">讨论</button></div></li>`).join('')}</ol>` : ''}`;
  const pic = box.querySelector('.as-today > img');
  pic?.addEventListener('error', () => { pic.closest('.as-today').classList.add('is-plain'); pic.remove(); }, { once: true });
  refreshFx(box);
}

let trendSerial = 0;
async function loadTrends() {
  const serial = ++trendSerial;
  const box = $('#circle-hot');
  try {
    const r = await hubApi.request(`circle/trends?campus=${encodeURIComponent($('#circle-campus').value)}`);
    if (serial !== trendSerial) return;
    box.innerHTML = r.items.length ? `<span class="cs-trends-label">大家在聊</span>${r.items.map((t) => `<button class="as-tag" type="button" data-hot="${esc(t.term)}">${esc(t.term)}<b>${t.posts}</b></button>`).join('')}` : '';
    box.title = r.definition;
  } catch {
    if (serial === trendSerial) box.innerHTML = '';
  }
}

// ---------- 发帖 ----------
async function compose() {
  const s = await hubState();
  if (!s.user) { location.href = loginURL(); return; }
  const dlg = $('#circle-editor');
  dlg.showModal();
  $('#post-board').value = S.board || S.boards[0]?.id || '';
  $('#circle-form').elements.campus.value = $('#circle-campus').value;
  $('#circle-form').elements.title.focus();
}
async function discuss(i) {
  const n = S.news[Number(i)];
  if (!n) return;
  await compose();
  const f = $('#circle-form');
  if (!$('#circle-editor').open) return;
  f.elements.title.value = `【讨论】${n.title}`.slice(0, 160);
  if (!f.elements.body.value) f.elements.body.value = `原文：${n.url}\n\n`;
  if (S.boards.some((b) => b.id === 'daily')) $('#post-board').value = 'daily';
  f.elements.body.focus();
}
$('#circle-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  const btn = f.querySelector('[type=submit]');
  const v = Object.fromEntries(new FormData(f));
  const photos = [...f.elements.photos.files];
  if (photos.length > 9) { $('#post-status').textContent = '最多上传 9 张照片。'; return; }
  btn.disabled = true;
  try {
    const uploads = [];
    for (const file of photos) {
      $('#post-status').textContent = `正在上传 ${file.name}`;
      uploads.push((await hubApi.upload(file)).id);
    }
    const r = await hubApi.createCirclePost({
      title: v.title, body: v.body, tags: v.tags.split(/[，,、\s]+/).filter(Boolean).slice(0, 10), uploads,
      rightsConfirmed: f.elements.rights.checked, circle: { format: 'thread', board: v.board, campus: v.campus, visibility: 'public' },
    });
    await hubApi.submit(r.id, r.editRevision);
    $('#post-status').innerHTML = '已提交审核，通过后出现在帖子流里。<a href="me.html#entries">查看投稿进度 ›</a>';
    f.reset();
  } catch (err) {
    $('#post-status').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

// ---------- 帖子详情：楼层 + 亮回复 ----------
function replyHTML(r, lit = false) {
  return `<article class="cs-floor${lit ? ' is-lit' : ''}" id="${lit ? 'lit' : 'floor'}-${esc(r.id)}">
    <header><b>${esc(r.author?.name || '同学')}</b>${r.isOwner ? '<span class="cs-op">楼主</span>' : ''}${r.accepted ? '<span class="as-tag cs-accepted">已采纳</span>' : ''}<span>${r.floor ? `${r.floor} 楼` : '待审核'} · ${esc(timeAgo(r.created))}</span></header>
    <p>${esc(r.body)}</p>
    ${r.state === 'published' ? `<footer class="as-review-foot"><button type="button" data-reply-like="${esc(r.id)}" aria-pressed="${r.liked}" ${r.own ? 'disabled title="不能点亮自己的回复"' : ''}>${ICON.flame}<span class="num">${r.likes}</span><span>亮</span></button>${r.canAccept && !r.accepted ? `<button type="button" data-accept-reply="${esc(r.id)}">采纳回答</button>` : ''}</footer>` : '<footer class="as-fine">待审核 · 只有你和维护者能看到</footer>'}
  </article>`;
}
function threadHTML(t) {
  const p = t.post;
  const d = p.data || {};
  const c = d.circle || {};
  const byId = new Map(t.replies.map((r) => [r.id, r]));
  const lit = t.lit.map((id) => byId.get(id)).filter(Boolean);
  return `<article class="cs-op-post">
      <p class="as-review-meta"><span class="as-tag">${esc(boardName(c.board))}</span>${esc(CAMPUS[c.campus] || '全校')} · ${esc(timeAgo(c.publishedAt || p.created || ''))}</p>
      <h2>${esc(d.title || '')}</h2>
      <p class="cs-op-who"><span class="cs-avatar" aria-hidden="true">${face(p.owner)}</span><b>${esc(p.owner?.name || '同学')}</b><span class="cs-op">楼主</span>${authorFollowHTML(p)}</p>
      <div class="cs-op-body">${esc(d.body || '')}</div>
      ${d.languageVersions?.original?`<details><summary>中外文对照 · 来源原文摘要</summary><h3>${esc(d.languageVersions.original.title||'')}</h3><div class="cs-op-body">${esc(d.languageVersions.original.body||'')}</div></details>`:''}
      ${d.maintenanceFacts?`<details><summary>查看执行记录和未解决事项</summary><ul>${d.maintenanceFacts.unresolved.map(r=>`<li>${esc(r.robot)}：${r.state==='failed'?'失败':'部分完成'} · ${esc(r.error||'')}</li>`).join('')||'<li>此次记录没有失败项；不代表全站没有问题。</li>'}</ul></details>`:''}
      ${(p.photos || []).length ? `<div class="cs-op-photos${p.photos.length > 1 ? ' ds-track' : ''}">${depthSlides(p.photos, '同学上传的照片')}</div>` : ''}
      ${c.external?.url ? `<p><a class="as-see-all" href="${esc(safeHref(c.external.url))}" target="_blank" rel="noopener">阅读原文 ›</a></p>` : ''}
      ${p.selection ? `<p class="cs-post-pick"><span class="as-hot-badge">精选</span>${esc(p.selection.reason)}</p>` : ''}
      <footer class="as-review-foot">
        <a class="as-see-all" href="viewer.html?kind=entry&id=${esc(p.id)}">阅读 / 导出帖子</a>
        ${(p.photos||[]).map((url,i)=>`<a class="as-see-all" href="${esc(url)}">查看配图 ${i+1}</a>`).join('')}
        <button type="button" data-like="${esc(p.id)}" aria-pressed="${Boolean(p.liked)}">${ICON.flame}<span class="num">${p.likes || 0}</span><span>亮</span></button>
        <button type="button" data-star="${esc(p.id)}" aria-pressed="${Boolean(p.starred)}">${ICON.star}<span>${p.starred ? '已收藏' : '收藏'}</span></button>
      </footer>
    </article>
    ${lit.length ? `<section class="cs-lit" aria-label="亮了的回复"><h3>这些回复亮了</h3>${lit.map((r) => replyHTML(r, true)).join('')}</section>` : ''}
    <section class="cs-floors" aria-label="全部回复"><h3>全部回复 · ${t.replies.filter((r) => r.state === 'published').length}</h3>
      ${t.replies.map((r) => replyHTML(r)).join('') || '<p class="as-fine">还没有回复，来坐沙发。</p>'}</section>`;
}
async function openThread(id, from, reply = S.thread === id ? S.replyTarget : null) {
  const dlg = $('#circle-thread');
  const serial = ++S.threadSerial;
  try {
    const t = reply ? await hubApi.request(`circle/posts/${encodeURIComponent(id)}/thread?reply=${encodeURIComponent(reply)}`) : await hubApi.circleThread(id);
    if (serial !== S.threadSerial) return;
    S.replyTarget = reply;
    S.thread = id;
    $('#thread-board').textContent = boardName(t.post.data?.circle?.board);
    threadSlider();
    $('#thread-body').innerHTML = threadHTML(t);
    threadSlider = mountDepthSlider($('#thread-body .ds-track'));
    $('#reply-status').textContent = '';
    if (!dlg.open) {
      if (from) openFrom(dlg, from); else dlg.showModal();
      dlg.scrollTop = 0;
    }
    if (reply) {
      const floor = document.getElementById(`floor-${reply}`);
      if (floor) {
        requestAnimationFrame(() => { scrollToEl(floor); floor.classList.add('is-target'); floor.setAttribute('tabindex', '-1'); floor.focus({ preventScroll: true }); });
      } else $('#reply-status').textContent = '对应回复已撤回或暂不可查看，下面仍可阅读原帖。';
    }
  } catch (e) {
    if (serial !== S.threadSerial) return;
    status(e.status === 404 ? '原帖已撤回、不可查看或被你隐藏。' : e.message);
  }
}
$('#thread-reply').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  const btn = f.querySelector('button');
  const s = await hubState();
  if (!s.user) { location.href = loginURL(); return; }
  btn.disabled = true;
  try {
    const result = await hubApi.reply(S.thread, f.elements.body.value);
    f.reset();
    await openThread(S.thread);
    $('#reply-status').textContent = result.state === 'published' ? '回复已发布。' : '回复已提交，审核后公开（只有你和维护者能先看到）。';
  } catch (err) {
    $('#reply-status').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

// ---------- 申请开吧（同学）与开通 / 驳回（维护者） ----------
async function proposeBoard() {
  const s = await hubState();
  if (!s.user) { location.href = loginURL(); return; }
  if (!canParticipate(s.user)) { status('验证邮箱之后才能申请开吧。<a href="me.html#account">去验证 ›</a>', true); return; }
  $('#board-status').textContent = '';
  $('#board-dialog').showModal();
  $('#board-form').elements.name.focus();
}
$('#board-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  const btn = f.querySelector('[type=submit]');
  btn.disabled = true;
  try {
    const r = await hubApi.proposeBoard({ name: f.elements.name.value.trim(), description: f.elements.description.value.trim(), rules: f.elements.rules.value.trim() });
    $('#board-status').textContent = r.message || '已提交，维护者审核后开通。';
    f.reset();
  } catch (err) {
    $('#board-status').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});
async function loadProposals() {
  if (!S.user?.moderator) return;
  try {
    const r = await hubApi.boardProposals();
    S.proposals = r.items || [];
    $('#board-review').hidden = !S.proposals.length;
    $('#board-review-n').textContent = S.proposals.length;
  } catch { /* 维护者接口暂时读不到时不显示入口 */ }
}
function renderProposals() {
  $('#board-review-list').innerHTML = S.proposals.map((p) => `<article class="cs-proposal" data-proposal="${esc(p.id)}">
      <h3>${esc(p.name)}吧</h3><p>${esc(p.description)}</p>${p.rules ? `<p class="as-fine">吧规：${esc(p.rules)}</p>` : ''}
      <p class="as-fine" data-note>申请人：${esc(p.proposer?.name || '同学')}${p.created ? ` · ${esc(fmtDay(p.created))}` : ''}</p>
      <div class="cs-proposal-actions"><button class="as-get is-primary is-small" type="button" data-approve="${esc(p.id)}">开通</button>
        <input data-reason placeholder="驳回理由（必填）" maxlength="300"><button class="as-get is-small" type="button" data-reject="${esc(p.id)}">驳回</button></div>
    </article>`).join('') || '<p class="as-fine">没有待开通的吧。</p>';
}
$('#board-review-list').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-approve],[data-reject]');
  if (!b) return;
  const card = b.closest('[data-proposal]');
  const p = S.proposals.find((x) => x.id === card.dataset.proposal);
  b.disabled = true;
  try {
    if (b.hasAttribute('data-approve')) {
      await hubApi.saveBoard({ id: p.id, name: `${p.name}吧`, description: p.description, rules: p.rules, active: true });
    } else {
      const reason = card.querySelector('[data-reason]').value.trim();
      if (!reason) { card.querySelector('[data-reason]').focus(); b.disabled = false; return; }
      await hubApi.rejectBoard(p.id, reason);
    }
    await loadProposals();
    renderProposals();
    await loadBoards();
  } catch (err) {
    card.querySelector('[data-note]').textContent = err.message;
    b.disabled = false;
  }
});

// ---------- 点赞（亮了）、收藏、关注 ----------
async function toggleLike(btn) {
  const id = btn.dataset.like;
  const on = btn.getAttribute('aria-pressed') !== 'true';
  const s = await hubState();
  if (!s.user) { needLogin('登录后才能点亮。'); return; }
  btn.disabled = true;
  try {
    const r = await hubApi.likeCirclePost(id, on);
    const item = S.items.find((x) => x.id === id);
    if (item) Object.assign(item, { likes: r.likes, liked: r.liked });
    $$(`[data-like="${CSS.escape(id)}"]`).forEach((b) => {
      b.setAttribute('aria-pressed', String(r.liked));
      rollTo(b.querySelector('.num'), r.likes, on ? 1 : -1);
    });
    if (on) pop(btn.querySelector('svg'));
  } catch (e) {
    status(e.message);
  } finally {
    btn.disabled = false;
  }
}
async function toggleReplyLike(btn) {
  const on = btn.getAttribute('aria-pressed') !== 'true';
  const s = await hubState();
  if (!s.user) { $('#reply-status').innerHTML = `登录后才能点亮回复。<a href="${esc(loginURL())}">登录 ›</a>`; return; }
  btn.disabled = true;
  try {
    const r = await hubApi.likeCircleReply(btn.dataset.replyLike, on);
    $$(`[data-reply-like="${CSS.escape(r.id)}"]`).forEach((b) => {
      b.setAttribute('aria-pressed', String(r.liked));
      rollTo(b.querySelector('.num'), r.likes, on ? 1 : -1);
    });
    if (on) pop(btn.querySelector('svg'));
  } catch (e) {
    $('#reply-status').textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}
async function toggleStar(btn) {
  const id = btn.dataset.star;
  const s = await hubState();
  if (!s.user) { needLogin('登录后才能收藏。'); return; }
  const on = btn.getAttribute('aria-pressed') !== 'true';
  btn.disabled = true;
  try {
    await hubApi.star(id, on);
    const item = S.items.find((x) => x.id === id);
    if (item) item.starred = on;
    $$(`[data-star="${CSS.escape(id)}"]`).forEach((b) => {
      b.setAttribute('aria-pressed', String(on));
      b.querySelector('span').textContent = on ? '已收藏' : '收藏';
    });
    if (on) pop(btn.querySelector('svg'));
  } catch (e) {
    status(e.message);
  } finally {
    btn.disabled = false;
  }
}

// ---------- 事件 ----------
document.addEventListener('click', async (e) => {
  const t = e.target;
  const close = t.closest('[data-close]');
  if (close) {
    const dlg = close.closest('dialog');
    if (dlg.id === 'circle-thread') closeTo(dlg); else dlg.close();
    return;
  }
  const like = t.closest('[data-like]');
  if (like) { e.stopPropagation(); await toggleLike(like); return; }
  const star = t.closest('[data-star]');
  if (star) { e.stopPropagation(); await toggleStar(star); return; }
  const accept = t.closest('[data-accept-reply]');
  if (accept) {
    accept.disabled = true;
    try { await hubApi.accept(accept.dataset.acceptReply); await openThread(S.thread); $('#reply-status').textContent = '已采纳这条回答，原采纳记录会同步调整。'; }
    catch (err) { $('#reply-status').textContent = err.message; }
    finally { accept.disabled = false; }
    return;
  }
  const creator = t.closest('[data-follow-creator]');
  if (creator) {
    e.stopPropagation();
    creator.disabled = true;
    try {
      const enabled = creator.getAttribute('aria-pressed') !== 'true';
      await hubApi.followCreator(creator.dataset.followCreator, enabled);
      S.items.forEach((p) => { if (p.owner?.username === creator.dataset.followCreator) p.authorFollowed = enabled; });
      if (S.lane === 'following') await load(); else renderFeed();
      if (S.thread && $('#circle-thread').open) await openThread(S.thread);
      status(enabled ? '已关注作者，新帖子会进入关注动态。' : '已取消关注作者。');
    } catch (err) { status(err.message); } finally { creator.disabled = false; }
    return;
  }
  const rlike = t.closest('[data-reply-like]');
  if (rlike) { await toggleReplyLike(rlike); return; }
  if (t.closest('[data-propose]')) { await proposeBoard(); return; }
  const boardBtn = t.closest('[data-board-id]');
  if (boardBtn) { await selectBoard(boardBtn.dataset.boardId); return; }
  if (t.closest('[data-follow-board]')) {
    const b = S.boards.find((x) => x.id === S.board);
    const s = await hubState();
    if (!s.user) { needLogin('登录后才能关注吧。'); return; }
    try {
      await hubApi.followBoard(b.id, !b.followed, true);
      b.followed = !b.followed;
      renderBoards();
      renderBoardInfo();
      if (S.lane === 'following') await load();
      if (b.followed) pop($('[data-follow-board]'));
    } catch (err) { status(err.message); }
    return;
  }
  const hotTerm = t.closest('[data-hot]');
  if (hotTerm) {
    $('#circle-q').value = hotTerm.dataset.hot;
    S.board = '';
    renderBoards();
    renderBoardInfo();
    await load();
    scrollToEl($('#cs-feed-section'));
    return;
  }
  const lane = t.closest('[data-lane]');
  if (lane) {
    S.lane = lane.dataset.lane;
    setSegment($('#circle-lanes'), [...$$('#circle-lanes > button')].indexOf(lane));
    await load();
    return;
  }
  const post = t.closest('[data-post], [data-open]');
  if (post && !t.closest('a')) {
    const card = post.closest('.cs-post, .as-chart-row') || post;
    await openThread(post.dataset.post || post.dataset.open, card);
    return;
  }
  if (t.closest('[data-compose]')) { await compose(); return; }
  if (t.closest('[data-retry]')) { await load(); return; }
  const disc = t.closest('[data-discuss]');
  if (disc) { await discuss(disc.dataset.discuss); return; }
  if (t.closest('#cs-hot-rule')) { status($('#cs-hot-rule').dataset.rule || '近 7 天发布的公开帖，按回复和点赞计算。'); return; }
});
document.addEventListener('keydown', (e) => {
  const board = e.target.closest?.('[data-board-id][role=button]');
  if (board && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); selectBoard(board.dataset.boardId); }
});
$('#circle-compose').addEventListener('click', compose);
$('#circle-more').addEventListener('click', () => load(true));
$('#circle-campus').addEventListener('change', () => { load(); loadTrends(); loadHot(); });
let typing;
$('#circle-search').addEventListener('submit', (e) => { e.preventDefault(); clearTimeout(typing); load(); scrollToEl($('#cs-feed-section')); });
const scheduleSearch = (e) => {
  clearTimeout(typing);
  if (!e.isComposing) typing = setTimeout(() => load(), 220);
};
$('#circle-q').addEventListener('input', scheduleSearch);
$('#circle-q').addEventListener('compositionstart', () => clearTimeout(typing));
$('#circle-q').addEventListener('compositionend', scheduleSearch);
attachSearchSuggestions($('#circle-q'), {
  getItems: () => [
    ...S.boards.map((board) => ({ id: `board:${board.id}`, board: board.id, title: board.name, text: board.description, meta: '主题吧' })),
    ...[...S.searchPosts.values()].map((post) => ({ id: post.id, title: post.data?.title || '', text: [post.data?.summary, post.data?.body, ...(post.data?.tags || [])].filter(Boolean).join(' '), meta: boardName(post.data?.circle?.board) })),
  ],
  getTitle: (item) => item.title,
  getText: (item) => item.text,
  getMeta: (item) => item.meta,
  onSelect: (item) => {
    clearTimeout(typing);
    if (item.board) { $('#circle-q').value = ''; selectBoard(item.board); }
    else { load(); scrollToEl($('#cs-feed-section')); }
  },
});
$('#board-propose').addEventListener('click', proposeBoard);
$('#board-review').addEventListener('click', () => { renderProposals(); $('#board-review-dialog').showModal(); });

// ---------- 启动 ----------
async function loadBoards() {
  const r = await hubApi.circleBoards();
  S.boards = r.items.map((b) => ({ ...b, name: b.name.endsWith('吧') ? b.name : `${b.name}吧` }));
  renderBoards();
  renderBoardInfo();
}
async function init() {
  const s = await hubState();
  S.user = s.user;
  if (S.user) {
    const a = $('[data-circle-avatar]');
    a.classList.add('is-user');
    a.innerHTML = face(S.user);
  }
  if (!s.online) throw new Error('offline');
  const params = new URLSearchParams(location.search);
  if (params.get('q')) $('#circle-q').value = params.get('q');
  await loadBoards();
  if(S.boards.some(b=>b.id===params.get('board')))S.board=params.get('board');
  await load();
  if (params.has('compose')) compose();
  if (params.get('post')) await openThread(params.get('post'), null, params.get('reply'));
  loadProposals();
}

loadNews();
loadTrends();
loadHot();
loadRatings();
init().catch(() => {
  status('');
  $('#circle-feed').innerHTML = `<div class="as-empty"><b>社区服务暂未连接</b><p>帖子和吧需要在线账号与审核服务。已发布的项目仍可在开源广场浏览。</p><a class="as-get" href="discover.html">去开源广场</a></div>`;
});
