import { attachSearchSuggestions } from '../js/search-suggestions.js';
// 教师与课程口碑（Opus · 2026-10-07 改版）：App Store 的产品页 + 虎扑评分的组织方式。
// - 目录：弹幕墙（可关）→ 评分榜（≥5 人）→ 热议榜（近 90 天）→ 评分墙（每格：分数、人数、最热原话）
// - 详情：照片 + 名字 + “写评价” → 信息条 → 同学印象 → 评分及评论（大号均分 + 分布条）→ 最热 / 最新 → 评论竖排
//         → 官网资料（教师资料机器人每周核对）→ 站外讨论（只收链接和同学的一句话，标明来源，不计分）
// - 评分规则照 docs/PRODUCT_SPEC.md：0 人暂无评分；1–4 人显示真实均分并标“样本较少”；一位老师每个账号只保留一份评价。
import { initShell, observeLive } from '../js/shell.js';
import { canParticipate, hubApi, hubState, loginURL } from '../js/hub.js';
import { esc } from '../js/data.js';
import { pop, rollTo, refreshFx, setSegment } from '../js/fx.js';
import '../styles/circle-news.css';
import '../styles/reputation.css';

initShell();

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const params = new URLSearchParams(location.search);
const view = params.get('view') || 'teachers';
const targetType = ['teacher', 'offering', 'course'].find((k) => params.has(k));
const targetId = targetType && params.get(targetType);
const content = $('#rp-content');
const editor = $('#rp-editor');
let state, current, editing, pendingAction, serial = 0, sort = 'hot', tagList = [], faculty = null;
let courses = null;
let own = [];
const FLAGS = { pending: '待审核', rejected: '已退回', published: '已公开', withdrawn: '已撤回' };
const CAMPUS = { shahe: '沙河', xueyuanlu: '学院路' };
const STAR_WORDS = ['点星评分', '很失望', '不太好', '一般', '不错', '非常推荐'];
const SEARCH_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m20 20-4.8-4.8"/></svg>';
// Lucide（ISC，见 src/js/vendor/LUCIDE-LICENSE.txt）
const FLAME = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>';
const COMMENT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg>';
const PERSON = '<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="23" r="11"/><path d="M12 56c2-12 10-18 20-18s18 6 20 18"/></svg>';

const safe = (value) => { try { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password ? u.href : ''; } catch { return ''; } };
const external = (link, label, cls = 'as-see-all') => (safe(link) ? `<a class="${cls}" href="${esc(safe(link))}" target="_blank" rel="noopener noreferrer">${esc(label)} ↗</a>` : '');
const href = (type, id, anchor = '') => `reputation.html?${type}=${encodeURIComponent(id)}${anchor}`;
const date = (value) => (value ? new Date(value).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '');
const empty = (title, text = '') => `<div class="as-empty"><b>${esc(title)}</b>${text ? `<p>${esc(text)}</p>` : ''}</div>`;
const clip = (s, n) => ([...s].length > n ? `${[...s].slice(0, n).join('')}…` : s);
const initial = (name) => esc([...(name || '?')][0]);
const shortFaculty = (f = '') => f.replace(/学院$/, '').replace(/与/g, '').slice(0, 6) || '—';

function message(text) { $('#rp-message').textContent = text; $('#rp-message').hidden = !text; }
function fail(error) { message(error?.message || '暂时无法加载，请稍后重试。'); }
function allowed() {
  if (!state?.online) { message('社区服务尚未连接，请稍后重试。'); return false; }
  if (!state.user) { location.assign(loginURL()); return false; }
  if (!canParticipate(state.user)) { message('请先到“个人中心”验证邮箱，再参与评价。'); return false; }
  return true;
}
function stars(value, label = true) {
  const pct = value == null ? 0 : Math.max(0, Math.min(100, (value / 5) * 100));
  return `<span class="as-stars"${label ? ` role="img" aria-label="${value == null ? '暂无评分' : `${esc(value)} 分，满分 5 分`}"` : ' aria-hidden="true"'}>★★★★★<span aria-hidden="true" style="width:${pct}%">★★★★★</span></span>`;
}
function photoIcon(person, cls = 'as-icon rp-photo') {
  const src = safe(person.photo?.url);
  return `<span class="${cls}${src ? '' : ' is-text'}">${src ? `<img src="${esc(src)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : initial(person.name)}</span>`;
}
function courseIcon(course, cls = 'as-icon rp-course-icon') {
  return `<span class="${cls}" aria-hidden="true">${initial(course.name)}</span>`;
}
function repairPhotos(scope = document) {
  $$('img[referrerpolicy="no-referrer"]', scope).forEach((img) => img.addEventListener('error', () => {
    const box = img.parentElement;
    img.remove();
    box.classList.add('is-text');
    if (!box.textContent.trim()) box.innerHTML = box.classList.contains('as-product-photo') ? PERSON : '?';
  }, { once: true }));
}
async function loadCourses() {
  if (courses) return courses;
  courses = [];
  let offset = 0;
  do {
    const page = await hubApi.courses({ offset });
    courses.push(...page.items);
    offset = page.nextOffset;
  } while (offset != null && courses.length < 1000);
  return courses;
}

// ---------- 目录：弹幕墙、评分榜、热议榜、评分墙 ----------
const wallOn = () => { try { return localStorage.getItem('lk-rp-wall') !== 'off'; } catch { return true; } };
function wallSection() {
  const on = wallOn();
  return `<section class="as-section is-first rp-wall-section" aria-labelledby="rp-wall-title">
    <div class="as-section-head"><div><h2 id="rp-wall-title">高赞原话</h2><p>点一条跳到原评论</p></div>
      <label class="rp-switch"><input type="checkbox" id="rp-wall-toggle"${on ? ' checked' : ''}><span aria-hidden="true"></span>弹幕</label></div>
    <div class="rp-wall" id="rp-wall" data-live${on ? '' : ' hidden'}></div>
  </section>`;
}
async function loadWall() {
  const box = $('#rp-wall');
  if (!box) return;
  box.hidden = !wallOn();
  if (box.hidden || box.dataset.loaded) return;
  box.dataset.loaded = '1';
  try {
    const r = await hubApi.reputationWall();
    if (!r.items.length) { box.innerHTML = '<p class="as-fine">还没有公开评价，墙上空空的。</p>'; return; }
    const bullet = (x, hidden) => `<a class="rp-bullet" href="${esc(x.href)}"${hidden ? ' tabindex="-1" aria-hidden="true"' : ''}><b>${esc(x.subject)}</b><span>${esc(clip(x.body, 40))}</span>${x.likes ? `<i>${FLAME}${x.likes}</i>` : ''}</a>`;
    const lanes = [[], [], []];
    r.items.forEach((x, i) => lanes[i % 3].push(x));
    box.innerHTML = lanes.filter((l) => l.length).map((l, i) => `<div class="rp-lane" style="--dur:${36 + i * 9}s;--delay:${-i * 6}s">
        <div class="rp-lane-track">${l.map((x) => bullet(x, false)).join('')}${l.map((x) => bullet(x, true)).join('')}</div></div>`).join('');
    observeLive(box.parentElement);
  } catch (e) {
    box.innerHTML = `<p class="as-fine">${esc(e.message)}</p>`;
  }
}
function rankingRow(it, kind, extra) {
  const s = it.stats || {};
  const sub = kind === 'teacher' ? [it.faculty, it.title].filter(Boolean).join(' · ') : it.faculty || '课程';
  return `<li><a class="as-chart-row rp-rank-row" href="${esc(href(kind, it.id))}">
      <span class="as-rank">${it.rank}</span>
      <span class="rp-rank-main">${kind === 'teacher' ? photoIcon(it) : courseIcon(it)}<span class="as-chart-text"><b>${esc(it.name)}</b><span>${esc(sub)}</span></span></span>
      <span class="rp-rank-score"><b class="num">${s.average == null ? '—' : s.average.toFixed(1)}</b>${stars(s.average, false)}<small>${esc(extra(it))}</small></span>
    </a></li>`;
}
function rankingSections(r, kind) {
  return `<section class="as-section as-reveal" aria-labelledby="rp-top-title">
      <div class="as-section-head"><div><h2 id="rp-top-title">评分榜</h2><p>${esc(r.topRule)}</p></div></div>
      ${r.top.length ? `<ol class="as-chart is-two">${r.top.map((it) => rankingRow(it, kind, (x) => `${x.stats.count} 人评分`)).join('')}</ol>`
        : empty('还没有对象满 5 人评分', '评分人数够了才上榜，避免一两条评价决定排名。')}
    </section>
    <section class="as-section as-reveal" aria-labelledby="rp-hot-title">
      <div class="as-section-head"><div><h2 id="rp-hot-title">热议榜</h2><p>${esc(r.hotRule)}</p></div></div>
      ${r.hot.length ? `<ol class="as-chart is-two">${r.hot.map((it) => rankingRow(it, kind, (x) => `近期 ${x.recent} 条评价`)).join('')}</ol>`
        : empty('近 90 天还没有新评价', '来写第一条。')}
    </section>`;
}
function cell(it, kind) {
  const s = it.stats || {};
  const sub = kind === 'teacher' ? [it.faculty, it.title].filter(Boolean).join(' · ') : (it.scope === 'general-topic' ? '学习专题' : it.faculty || '课程与资料');
  const h = it.highlight;
  return `<article class="rp-cell fx-press">
    <a class="rp-cell-link" href="${esc(href(kind, it.id))}" aria-label="查看${esc(it.name)}"></a>
    <div class="rp-cell-top">${kind === 'teacher' ? photoIcon(it) : courseIcon(it)}
      <span class="as-lockup-text"><b>${esc(it.name)}</b><span>${esc(sub)}</span></span>
      <span class="rp-cell-score"><b class="num">${s.average == null ? '—' : s.average.toFixed(1)}</b><small>${s.count ? `${s.count} 人${s.smallSample ? ' · 样本少' : ''}` : '暂无评分'}</small></span>
    </div>
    ${h ? `<a class="rp-cell-quote" href="${esc(h.href)}"><span class="as-hot-badge">${h.likes ? `${FLAME}${h.likes}` : '新'}</span>“${esc(h.body)}”</a>`
      : '<p class="rp-cell-quote is-empty">还没有评价，来写第一条</p>'}
  </article>`;
}
function pager(next, offset) {
  const link = (o, label) => { const p = new URLSearchParams(params); p.set('offset', o); if (!o) p.delete('offset'); return `<a class="as-get" href="reputation.html?${p}">${label}</a>`; };
  return `<nav class="rp-pager">${offset ? link(Math.max(0, offset - 24), '上一页') : ''}${next != null ? link(next, '下一页') : ''}</nav>`;
}
async function directory() {
  const kind = view === 'courses' ? 'course' : 'teacher';
  const offset = Number(params.get('offset') || 0);
  const q = params.get('q') || '';
  const front = !q && !offset;
  const [data, ranks] = await Promise.all([
    kind === 'teacher' ? hubApi.teachers({ q, offset }) : hubApi.courses({ q, offset }),
    front ? hubApi.reputationRankings(kind === 'teacher' ? 'teachers' : 'courses').catch(() => null) : null,
  ]);
  content.innerHTML = `
    <form class="as-search rp-search" id="rp-search" role="search">${SEARCH_SVG}
      <label class="sr-only" for="rp-q">搜索</label>
      <input id="rp-q" name="q" type="search" value="${esc(q)}" enterkeyhint="search" placeholder="${kind === 'teacher' ? '搜索老师姓名或学院' : '搜索课程名称或学院'}"></form>
    ${front ? wallSection() : ''}
    ${ranks ? rankingSections(ranks, kind) : ''}
    <section class="as-section${front ? '' : ' is-first'}" aria-labelledby="rp-all-title">
      <div class="as-section-head"><div><h2 id="rp-all-title">${q ? `“${esc(q)}”的结果` : kind === 'teacher' ? '评分墙 · 全部老师' : '评分墙 · 全部课程'}</h2>
        <p>${data.total} ${kind === 'teacher' ? '位老师 · 资料来自学院官网，评分来自同学' : '门课程 · 评分汇总历次开课'}</p></div></div>
      ${data.items.length ? `<div class="rp-grid">${data.items.map((t) => cell(t, kind)).join('')}</div>` : empty('没有匹配的结果', '换个关键词试试；教师资料由机器人每周从学院官网补充。')}
      ${pager(data.nextOffset, offset)}
    </section>`;
  const suggestions = new Map(data.items.map(item => [item.id,item]));
  attachSearchSuggestions($('#rp-q'), {
    getItems: async query => {
      const result = await (kind === 'teacher' ? hubApi.teachers({q:query}) : hubApi.courses({q:query}));
      for (const item of result.items) suggestions.set(item.id,item);
      return [...suggestions.values()];
    },
    getTitle: item => item.name,
    getText: item => item.faculty,
    getMeta: item => item.faculty || (kind === 'teacher' ? '教师' : '课程'),
  });
  $('#rp-search').addEventListener('submit', (event) => {
    event.preventDefault();
    const p = new URLSearchParams(params);
    p.set('q', new FormData(event.target).get('q').trim());
    if (!p.get('q')) p.delete('q');
    p.delete('offset');
    location.assign(`reputation.html?${p}`);
  });
  $('#rp-wall-toggle')?.addEventListener('change', (e) => {
    try { localStorage.setItem('lk-rp-wall', e.target.checked ? 'on' : 'off'); } catch { /* 隐私模式 */ }
    loadWall();
  });
  loadWall();
}

// ---------- 详情：产品页 ----------
function ratingsBlock(s) {
  const dist = s.distribution || {};
  return `<div class="as-ratings">
      <div class="as-score${s.average == null ? ' is-empty' : ''}"><b class="num" data-score>${s.average == null ? '暂无' : s.average.toFixed(1)}</b><span>满分 5 分</span></div>
      <div class="as-bars">${[5, 4, 3, 2, 1].map((n) => `<div class="as-bar"><span class="as-bar-stars" aria-hidden="true">${'★'.repeat(n)}</span>
        <span class="as-bar-track" role="img" aria-label="${n} 星 ${dist[n] || 0} 人"><i style="--p:${s.count ? (dist[n] || 0) / s.count : 0}"></i></span></div>`).join('')}</div>
      <div class="as-ratings-foot"><span>${s.count} 份评价</span><span>${esc(s.label || '')}</span></div>
    </div>`;
}
function infoStrip(c, isTeacher) {
  const s = c.stats;
  const prof = c.profile || {};
  const cells = [
    `<div><small>评分</small><b class="num">${s.average == null ? '—' : s.average.toFixed(1)}</b>${stars(s.average)}</div>`,
    `<div><small>评价</small><b class="num">${s.count}</b><span>${s.smallSample ? '样本较少' : '份'}</span></div>`,
  ];
  if (isTeacher) {
    if (c.faculty) cells.push(`<div><small>学院</small><b>${esc(shortFaculty(c.faculty))}</b><span>${esc(prof.department || c.faculty)}</span></div>`);
    if (c.title) cells.push(`<div><small>职称</small><b>${esc(c.title)}</b><span>官网所列</span></div>`);
    cells.push(`<div><small>主讲</small><b class="num">${(c.teaching || []).length}</b><span>门课程</span></div>`);
  } else {
    cells.push(`<div><small>开课</small><b class="num">${(c.offerings || []).length}</b><span>次记录</span></div>`);
    if (c.faculty) cells.push(`<div><small>学院</small><b>${esc(shortFaculty(c.faculty))}</b><span>${esc(c.faculty)}</span></div>`);
  }
  cells.push(`<div><small>热评</small><b class="num">${c.highlight?.likes ?? 0}</b><span>最高亮</span></div>`);
  return `<div class="as-info">${cells.join('')}</div>`;
}
function officialSection(c) {
  const prof = c.profile || {};
  const teaching = c.teaching || [];
  return `<section class="as-section as-reveal" aria-labelledby="rp-official-title">
      <div class="as-section-head"><div><h2 id="rp-official-title">官网资料</h2>
        <p>${prof.bot ? `教师资料机器人每周读一次学院官网${prof.crawledAt ? ` · 最近核对 ${esc(date(prof.crawledAt))}` : ''}` : `维护者核对${c.checkedAt ? ` · ${esc(date(c.checkedAt))}` : ''}`}</p></div>
        ${external(prof.profileUrl || c.sourceUrl, '官网原页')}</div>
      <dl class="rp-facts">
        ${prof.research ? `<div><dt>研究方向</dt><dd>${esc(prof.research)}</dd></div>` : ''}
        ${prof.department ? `<div><dt>所在系所</dt><dd>${esc(prof.department)}</dd></div>` : ''}
        <div><dt>主讲课程</dt><dd>${teaching.length ? `<span class="as-tags">${teaching.map((t) => `<span class="as-tag">${esc(t.name)}</span>`).join('')}</span>` : '<span class="as-fine">官网没有列出</span>'}</dd></div>
      </dl>
      <p class="as-fine">以上为学院官网所列，不代表本学期一定开课。资料有误，或老师本人希望撤下照片？<button class="as-see-all rp-inline" type="button" data-action="request">申请更正</button></p>
    </section>`;
}
function resourcesHTML(course) {
  const COST = { free: '免费', paid: '收费', mixed: '部分收费', unknown: '收费以原站为准' };
  return `<section class="as-section as-reveal" aria-labelledby="rp-res-title">
      <div class="as-section-head"><div><h2 id="rp-res-title">学习引导与资源</h2><p>站内帮你选；讲解、练习、辅导在原平台进行</p></div><a class="as-see-all" href="materials.html?q=${encodeURIComponent(course.name || '')}">找资料</a></div>
      <p class="rp-prose">${esc(course.prerequisites || '先修建议尚待同学补充。')}</p>
      ${(course.resources || []).length ? `<div class="as-lockups">${course.resources.map((r) => `<a class="as-lockup" href="${esc(safe(r.url))}" target="_blank" rel="noopener noreferrer">
          <span class="as-icon rp-course-icon" aria-hidden="true">${initial(r.title)}</span>
          <span class="as-lockup-text"><b>${esc(r.title)}</b><span>${esc(`${r.type} · ${r.audience}`)}</span><small>${esc(COST[r.cost] || '')} · 核对于 ${esc(r.checkedAt)}</small></span>
          <span class="as-get is-small">打开</span></a>`).join('')}</div>` : '<p class="as-fine">外部资源尚待核对。</p>'}
    </section>`;
}
function offeringsSection(c) {
  if (targetType === 'offering') {
    return `<section class="as-section as-reveal"><div class="as-section-head"><h2>这次开课的老师</h2></div>
      <div class="as-lockups">${c.teachers.map((t) => `<a class="as-lockup" href="${esc(href('teacher', t.id))}"><span class="as-icon rp-photo">${initial(t.name)}</span>
        <span class="as-lockup-text"><b>${esc(t.name)}</b><span>教师整体口碑单独计分</span></span><span class="as-get is-small">查看</span></a>`).join('')}</div></section>`;
  }
  const list = c.offerings || [];
  return `<section class="as-section as-reveal"><div class="as-section-head"><div><h2>具体开课记录</h2><p>按学期、校区分开评价</p></div></div>
    ${list.length ? `<div class="as-lockups">${list.map((o) => `<a class="as-lockup" href="${esc(href('offering', o.id))}">${courseIcon(o)}
        <span class="as-lockup-text"><b>${esc(`${o.name} · ${o.term}`)}</b><span>${esc(CAMPUS[o.campus] || '')}${o.teachers?.length ? ` · ${esc(o.teachers.map((t) => t.name).join('、'))}` : ''}</span><small>${o.stats.count} 份评价</small></span>
        <span class="as-get is-small">评价</span></a>`).join('')}</div>`
      : '<p class="as-fine">学期、校区与授课安排核对后再开放对应的开课评价。</p>'}</section>`;
}
function searchOut(name) {
  const q = encodeURIComponent(`${name} 中国矿业大学（北京）`);
  return `<p class="rp-out">在站外搜：
      <a href="https://tieba.baidu.com/f/search/res?ie=utf-8&qw=${q}" target="_blank" rel="noopener noreferrer">百度贴吧 ↗</a>
      <a href="https://bbs.hupu.com/search?q=${q}" target="_blank" rel="noopener noreferrer">虎扑 ↗</a>
      <a href="https://www.zhihu.com/search?type=content&q=${q}" target="_blank" rel="noopener noreferrer">知乎 ↗</a></p>`;
}
function mentionsSection(name) {
  return `<section class="as-section as-reveal" id="mentions" aria-labelledby="rp-mention-head">
      <div class="as-section-head"><div><h2 id="rp-mention-head">站外讨论</h2><p>同学提交的原帖链接和一句话概括 · 本站不转载原帖，不计入评分</p></div>
        <button class="as-see-all" type="button" data-action="mention">提交链接</button></div>
      <div id="rp-mentions" class="rp-mentions"><p class="as-fine">正在读取…</p></div>
      ${searchOut(name)}
    </section>`;
}
async function loadMentions() {
  const box = $('#rp-mentions');
  if (!box) return;
  try {
    const r = await hubApi.mentions({ [targetType]: targetId });
    box.innerHTML = r.items.length ? r.items.map((m) => `<article class="rp-mention">
        <span class="rp-site is-${esc(m.site)}">${esc(m.siteLabel)}</span>
        <div><a href="${esc(safe(m.url))}" target="_blank" rel="noopener noreferrer nofollow ugc">${esc(m.title)} ↗</a>
          <p>同学概括：${esc(m.summary)}</p>
          <small>来源：${esc(m.siteLabel)}网友的讨论 · 本站未核实原帖内容 · ${esc(date(m.created))} 提交</small></div>
      </article>`).join('') : '<p class="as-fine">还没有同学提交站外讨论。看到相关的帖子，可以把链接贴过来。</p>';
  } catch (e) {
    box.innerHTML = `<p class="as-fine">${esc(e.message)}</p>`;
  }
}
async function detail() {
  current = await (targetType === 'teacher' ? hubApi.teacher(targetId) : targetType === 'course' ? hubApi.course(targetId) : hubApi.offering(targetId));
  const isTeacher = targetType === 'teacher';
  const c = current;
  const name = targetType === 'offering' ? `${c.name} · ${c.term}` : c.name;
  document.title = `${name} · 口碑 · Luokixi`;
  const sub = isTeacher ? [c.title, c.faculty, c.profile?.department].filter(Boolean).join(' · ')
    : [c.faculty, CAMPUS[c.campus]].filter(Boolean).join(' · ') || (c.scope === 'general-topic' ? '学习专题' : '课程');
  const back = isTeacher ? ['reputation.html', '教师口碑'] : ['reputation.html?view=courses', '课程评价'];
  content.innerHTML = `
    <a class="rp-back" href="${back[0]}"><span aria-hidden="true">‹</span>${back[1]}</a>
    <section class="as-product">
      ${isTeacher ? photoIcon(c, 'as-product-photo') : `<span class="as-product-photo is-text" aria-hidden="true">${initial(c.name)}</span>`}
      <div><h1>${esc(name)}</h1><p>${esc(sub)}</p>
        <div class="as-product-actions">
          ${targetType !== 'course' ? '<button class="as-get is-primary" type="button" data-action="write">写评价</button>' : ''}
          <a class="as-get" href="#reviews">看评论</a>
        </div>
        ${isTeacher && c.photo ? `<p class="as-product-note">照片：${esc(c.photo.credit || '学院官网')} · ${external(c.photo.sourceUrl, '出处', 'rp-inline-link')}</p>` : ''}
      </div>
    </section>
    ${infoStrip(c, isTeacher)}
    ${c.stats.tags?.length ? `<section class="as-section as-reveal"><div class="as-section-head"><div><h2>同学印象</h2><p>写评价时选的标签，不计入星级</p></div></div>
      <div class="as-tags">${c.stats.tags.map((t) => `<span class="as-tag">${esc(t.tag)}<b>${t.count}</b></span>`).join('')}</div></section>` : ''}
    <section class="as-section" id="ratings" aria-labelledby="rp-ratings-title">
      <div class="as-section-head"><div><h2 id="rp-ratings-title">评分及评论</h2><p>${esc(c.ratingLabel || '课程体验')}</p></div>
        ${targetType !== 'course' ? '<button class="as-see-all" type="button" data-action="write">写评价</button>' : ''}</div>
      ${ratingsBlock(c.stats)}
    </section>
    <section class="as-section" id="reviews" aria-label="全部评论">
      <div class="rp-review-tools">
        <div class="as-seg rp-sort" role="group" aria-label="评论排序"><i class="as-seg-thumb" aria-hidden="true"></i>
          <button type="button" data-sort="hot" aria-pressed="true">最热</button><button type="button" data-sort="newest" aria-pressed="false">最新</button></div>
        <form class="rp-filters" id="rp-filters">
          ${isTeacher ? '<label><span class="sr-only">课程</span><select name="course"><option value="">全部课程</option></select></label>' : ''}
          <label><span class="sr-only">学期</span><input name="term" placeholder="学期" maxlength="80"></label>
        </form>
      </div>
      <div id="rp-reviews" class="as-reviews"></div>
    </section>
    ${isTeacher ? officialSection(c) : resourcesHTML(c.course || c)}
    ${offeringsSection(c)}
    ${targetType !== 'offering' ? mentionsSection(c.name) : ''}`;
  repairPhotos(content);
  refreshFx(content);
  if (isTeacher) {
    loadCourses().then((list) => {
      const sel = $('#rp-filters select[name=course]');
      if (sel) sel.innerHTML = `<option value="">全部课程</option>${list.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('')}`;
    }).catch(() => {});
  }
  $('#rp-filters').addEventListener('change', () => loadReviews(0).catch(fail));
  $('#rp-filters').addEventListener('submit', (e) => { e.preventDefault(); loadReviews(0).catch(fail); });
  await loadReviews(0);
  loadMentions();
}

// ---------- 评论卡片 ----------
function reviewHTML(r, { privateView = false, hot = false } = {}) {
  const meta = [r.author?.name, r.courseName, r.term].filter(Boolean).map(esc).join(' · ');
  return `<article class="as-review${hot ? ' is-hot' : ''}" id="review-${esc(r.id)}">
    <div class="as-review-head"><b>${stars(r.rating)}</b><time>${esc(date(r.publishedAt || r.created))}</time></div>
    <div class="as-review-meta">${meta}${hot ? '<span class="as-hot-badge">热评</span>' : ''}${privateView ? `<span class="as-tag">${esc(FLAGS[r.state] || r.state)} · 版本 ${r.revision}</span>` : ''}</div>
    <p class="as-review-body is-clamped">${esc(r.body)}</p>
    <button class="as-more" type="button" data-more hidden>更多</button>
    ${r.tags?.length ? `<div class="as-tags rp-review-tags">${r.tags.map((t) => `<span class="as-tag">${esc(t)}</span>`).join('')}</div>` : ''}
    ${privateView && r.note ? `<p class="rp-note">审核说明：${esc(r.note)}</p>` : ''}
    <footer class="as-review-foot">${privateView
      ? `<button type="button" data-action="edit" data-id="${esc(r.id)}">修改</button>
         ${r.state !== 'withdrawn' ? `<button type="button" data-action="withdraw" data-id="${esc(r.id)}">撤回</button>` : ''}
         ${['rejected', 'withdrawn'].includes(r.state) ? `<button type="button" data-action="appeal" data-id="${esc(r.id)}">申诉</button>` : ''}
         <a class="as-see-all" href="${esc(href(r.subjectType, r.subjectId))}">查看对象</a>`
      : `${r.own ? `<span class="rp-own">${FLAME}<span class="num">${r.likes}</span> 亮</span><a class="as-see-all" href="reputation.html?view=mine">管理我的评价</a>`
          : `<button type="button" data-action="like" data-id="${esc(r.id)}" aria-pressed="${r.liked}">${FLAME}<span class="num">${r.likes}</span><span>亮</span></button>`}
         <button type="button" data-action="thread" data-id="${esc(r.id)}">${COMMENT}<span>回复</span></button>
         <button type="button" data-action="report" data-id="${esc(r.id)}">举报</button>`}
    </footer>
    <div class="as-replies" data-thread="${esc(r.id)}" hidden></div>
  </article>`;
}
function wireMore(scope) {
  requestAnimationFrame(() => $$('.as-review-body.is-clamped', scope).forEach((p) => {
    if (p.scrollHeight > p.clientHeight + 2) p.nextElementSibling.hidden = false;
  }));
}
async function loadReviews(offset) {
  const local = ++serial;
  const filters = Object.fromEntries(new FormData($('#rp-filters')));
  filters[targetType] = targetId;
  filters.offset = offset;
  filters.sort = sort;
  const data = await hubApi.reviews(filters);
  if (local !== serial) return;
  const anchorId = location.hash.startsWith('#review-') ? location.hash.slice(8) : '';
  if (!offset && anchorId && !data.items.some((r) => r.id === anchorId)) {
    try {
      const pinned = await hubApi.courseReview(anchorId);
      if ((pinned.subjectType === targetType && pinned.subjectId === targetId) || (targetType === 'course' && pinned.courseId === targetId)) data.items.unshift(pinned);
    } catch { message('引用的评价已撤回，或暂时不可查看。'); }
  }
  const box = $('#rp-reviews');
  box.innerHTML = data.items.length
    ? data.items.map((r, i) => reviewHTML(r, { hot: sort === 'hot' && !offset && i < 3 && r.likes > 0 })).join('')
      + `<nav class="rp-pager">${offset ? `<button class="as-get" type="button" data-page="${Math.max(0, offset - 24)}">上一页</button>` : ''}${data.nextOffset != null ? `<button class="as-get" type="button" data-page="${data.nextOffset}">下一页</button>` : ''}</nav>`
    : empty('还没有符合条件的公开评论', targetType === 'course' ? '课程评分来自各次开课的评价。' : '写下第一条吧。');
  wireMore(box);
  jumpToHash();
}
function jumpToHash() {
  if (location.hash) requestAnimationFrame(() => document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView({ block: 'start' }));
}

// ---------- 我的评价 ----------
async function mine() {
  if (!state.user) { content.innerHTML = `${empty('登录后管理自己的评价')}<p class="rp-center"><a class="as-get is-primary" href="${esc(loginURL())}">登录 / 注册</a></p>`; return; }
  const [data, mentions] = await Promise.all([hubApi.myReviews(), hubApi.myMentions().catch(() => ({ items: [] }))]);
  own = data.items;
  content.innerHTML = `<a class="rp-back" href="reputation.html"><span aria-hidden="true">‹</span>教师口碑</a>
    <section class="as-section is-first"><div class="as-section-head"><div><h2>我的评价</h2><p>待审、退回与撤回的内容只有你和维护者能看到。修改发布后，旧版本的点赞会清零。</p></div></div>
      <div class="as-reviews">${own.length ? own.map((r) => reviewHTML(r, { privateView: true })).join('') : empty('你还没有写过评价')}</div></section>
    ${mentions.items.length ? `<section class="as-section"><div class="as-section-head"><h2>我提交的站外讨论</h2></div>
      <div class="rp-mentions">${mentions.items.map((m) => `<article class="rp-mention"><span class="rp-site is-${esc(m.site)}">${esc(m.siteLabel)}</span>
        <div><a href="${esc(safe(m.url))}" target="_blank" rel="noopener noreferrer">${esc(m.title)} ↗</a><p>${esc(m.summary)}</p>
        <small>${esc(FLAGS[m.state] || m.state)}${m.note ? ` · ${esc(m.note)}` : ''}</small>
        ${m.state !== 'withdrawn' ? `<button class="as-see-all rp-inline" type="button" data-action="mention-withdraw" data-id="${esc(m.id)}">撤回</button>` : ''}</div></article>`).join('')}</div></section>` : ''}
    ${data.cases.length ? `<section class="as-section"><div class="as-section-head"><h2>我的反馈与申诉</h2></div>
      ${data.cases.map((c) => `<article class="as-review"><p class="as-review-body">${esc(c.body)}</p><p class="as-fine">${esc(c.resolution || '等待维护者处理')}</p></article>`).join('')}</section>` : ''}`;
  wireMore(content);
}

// ---------- 维护者：审核、站外讨论、教师资料机器人、补充资料 ----------
function facultyPanel(f) {
  const ago = (iso) => (iso ? date(iso) : '还没运行');
  return `<section class="as-section" id="faculty"><div class="as-section-head"><div><h2>教师资料机器人</h2><p>${esc(f.policy)}</p></div>
      <button class="as-get is-primary is-small" type="button" data-action="faculty-run">立即运行</button></div>
    <p class="as-fine">机器人建的教师 ${f.botTeachers} 位${f.missing ? ` · 官网名单里暂时找不到 ${f.missing} 位（不会自动下线）` : ''} · 待确认照片 ${f.pendingPhotoCount} 张</p>
    <div class="as-lockups rp-sources">${f.sources.length ? f.sources.map((s) => `<div class="as-lockup">
        <span class="as-icon rp-course-icon" aria-hidden="true">${initial(s.college)}</span>
        <span class="as-lockup-text"><b>${esc(s.college)}</b><span>${s.last ? `找到 ${s.last.found} 位 · 新建 ${s.last.created} · 核对个人页 ${s.last.profilesChecked}` : '等待第一次运行'}${s.error ? ` · ${esc(s.error)}` : ''}</span>
          <small>${s.enabled ? `每 ${s.intervalHours} 小时自动运行` : '已停用'} · 上次成功 ${esc(ago(s.lastSuccess))}</small></span>
        <button class="as-get is-small" type="button" data-action="faculty-run-one" data-id="${esc(s.college)}">运行</button></div>`).join('')
      : `<div class="as-empty"><b>还没有启用</b><p>启用后每个学院每周自动读一次官网师资页。</p><button class="as-get is-primary" type="button" data-action="faculty-setup">启用机器人</button></div>`}</div>
    ${f.pendingPhotos.length ? `<h3 class="rp-h3">待确认照片</h3><p class="as-fine">只确认是本人、来自官网个人页的照片。确认后才在口碑页显示；拒绝过的地址机器人不会再提。</p>
      <div class="rp-photo-grid">${f.pendingPhotos.map((p) => `<figure class="rp-photo-card">
          <span class="as-product-photo"><img src="${esc(safe(p.url))}" alt="${esc(p.name)}的官网照片" loading="lazy" referrerpolicy="no-referrer"></span>
          <figcaption><b>${esc(p.name)}</b><span>${esc([p.college, p.title].filter(Boolean).join(' · '))}</span>${external(p.sourceUrl, '官网个人页', 'rp-inline-link')}</figcaption>
          <div class="rp-photo-actions"><button class="as-get is-primary is-small" type="button" data-action="photo-approve" data-id="${esc(p.teacher)}">确认</button>
            <button class="as-get is-small" type="button" data-action="photo-reject" data-id="${esc(p.teacher)}">不用</button></div>
        </figure>`).join('')}</div>
      <p class="rp-bulk">${[...new Set(f.pendingPhotos.map((p) => p.college))].map((c) => `<button class="as-get is-small" type="button" data-action="photo-college" data-id="${esc(c)}">确认${esc(c)}全部</button>`).join('')}</p>` : ''}
    ${f.requests.length ? `<h3 class="rp-h3">更正与撤下申请</h3>${f.requests.map((r) => `<article class="as-review"><div class="as-review-meta">${esc(r.detail.name || '')} · ${esc({ correction: '更正资料', photo: '撤下照片', removal: '其他请求' }[r.detail.kind] || '')} · ${esc(date(r.created))}</div>
        <p class="as-review-body">${esc(r.detail.body || '')}</p><footer class="as-review-foot"><a class="as-see-all" href="${esc(href('teacher', r.teacher))}">打开教师页</a></footer></article>`).join('')}` : ''}
  </section>`;
}
async function moderation() {
  if (!state.user?.moderator) { content.innerHTML = empty('这个入口只给维护者用'); return; }
  const [data, mentions, f, teachers, list] = await Promise.all([
    hubApi.reviewModeration(), hubApi.pendingMentions().catch(() => ({ items: [] })), hubApi.facultyStatus().catch(() => null),
    hubApi.teachers().then((r) => r.items).catch(() => []), loadCourses().catch(() => []),
  ]);
  own = data.reviews;
  faculty = f;
  const options = list.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  content.innerHTML = `<a class="rp-back" href="reputation.html"><span aria-hidden="true">‹</span>教师口碑</a>
    <section class="as-section is-first"><div class="as-section-head"><div><h2>评价审核 · ${data.reviews.length}</h2><p>通过后公开；退回要写原因，作者会收到通知</p></div></div>
      <div class="as-reviews">${data.reviews.map((r) => `<article class="as-review">
        <div class="as-review-head"><b>${stars(r.rating)}</b><span>${esc(r.courseName || '教师整体口碑')}</span></div>
        <p class="as-review-body">${esc(r.body)}</p>${r.tags?.length ? `<div class="as-tags">${r.tags.map((t) => `<span class="as-tag">${esc(t)}</span>`).join('')}</div>` : ''}
        <footer class="as-review-foot"><a class="as-see-all" href="${esc(href(r.subjectType, r.subjectId))}">评价对象</a>
          <button type="button" data-action="approve" data-id="${esc(r.id)}" data-version="${r.revision}">通过</button>
          <button type="button" data-action="reject" data-id="${esc(r.id)}" data-version="${r.revision}">退回</button></footer></article>`).join('') || '<p class="as-fine">没有待审核的评价。</p>'}</div></section>
    <section class="as-section"><div class="as-section-head"><h2>回复审核 · ${data.replies.length}</h2></div>
      <div class="as-reviews">${data.replies.map((r) => `<article class="as-review"><p class="as-review-body">${esc(r.body)}</p>
        <footer class="as-review-foot"><button type="button" data-action="reply-approve" data-id="${esc(r.id)}">通过</button><button type="button" data-action="reply-reject" data-id="${esc(r.id)}">退回</button></footer></article>`).join('') || '<p class="as-fine">没有待审核的回复。</p>'}</div></section>
    <section class="as-section"><div class="as-section-head"><div><h2>站外讨论 · ${mentions.items.length}</h2><p>打开原帖确认确实在讨论这位老师或这门课，概括没有歪曲原意，不含隐私和人身攻击</p></div></div>
      <div class="rp-mentions">${mentions.items.map((m) => `<article class="rp-mention"><span class="rp-site is-${esc(m.site)}">${esc(m.siteLabel)}</span>
        <div><b>${esc(m.subjectName)}</b> · <a href="${esc(safe(m.url))}" target="_blank" rel="noopener noreferrer nofollow">${esc(m.title)} ↗</a><p>${esc(m.summary)}</p>
        <footer class="as-review-foot"><button type="button" data-action="mention-approve" data-id="${esc(m.id)}">通过</button><button type="button" data-action="mention-reject" data-id="${esc(m.id)}">不通过</button></footer></div></article>`).join('') || '<p class="as-fine">没有待核对的链接。</p>'}</div></section>
    <section class="as-section"><div class="as-section-head"><h2>举报与申诉 · ${data.cases.length}</h2></div>
      <div class="as-reviews">${data.cases.map((c) => `<article class="as-review"><div class="as-review-meta">${c.kind === 'appeal' ? '申诉' : '举报'} · ${esc(date(c.created))}</div><p class="as-review-body">${esc(c.body)}</p>
        <footer class="as-review-foot"><button type="button" data-action="resolve" data-id="${esc(c.id)}">记录处理结果</button><button type="button" data-action="withdraw" data-id="${esc(c.reviewId)}">撤回相关评价</button></footer></article>`).join('') || '<p class="as-fine">没有待处理的举报或申诉。</p>'}</div></section>
    ${f ? facultyPanel(f) : ''}
    <details class="as-section rp-admin"><summary>手工补充教师与开课资料</summary>
      <form id="rp-teacher-form" class="cs-form"><h3>教师资料</h3>
        <label>选择已有教师或新增<select name="id"><option value="">新增教师</option>${teachers.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')}</select></label>
        <div class="cs-form-row"><label>姓名<input name="name" required maxlength="80"></label><label>学院<input name="faculty" maxlength="120"></label></div>
        <label>职称<input name="title" maxlength="80"></label><label>资料来源<input type="url" name="sourceUrl" required></label>
        <label>可使用的照片地址（选填）<input type="url" name="photoUrl"></label><label>照片来源页面<input type="url" name="photoSource"></label>
        <label>照片署名<input name="photoCredit" maxlength="160"></label>
        <label class="cs-check"><input type="checkbox" name="photoRights">已核对照片是本人、来自官网，可用于展示</label>
        <label class="cs-check"><input type="checkbox" name="checked" required>已核对教师资料来源</label>
        <button class="as-get is-primary cs-submit" type="submit">保存教师</button></form>
      <form id="rp-offering-form" class="cs-form"><h3>具体开课记录</h3>
        <label>课程<select name="courseId">${list.filter((c) => c.scope === 'campus-catalogue').map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select></label>
        <label>授课教师<select name="teacher" required><option value="">请选择</option>${teachers.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')}</select></label>
        <div class="cs-form-row"><label>学期<input name="term" required maxlength="80"></label><label>校区<select name="campus"><option value="shahe">沙河</option><option value="xueyuanlu">学院路</option></select></label></div>
        <label>本次开课的来源<input type="url" name="sourceUrl" required></label>
        <label class="cs-check"><input type="checkbox" name="checked" required>已核对学期、校区与授课安排</label>
        <button class="as-get is-primary cs-submit" type="submit">保存开课记录</button></form>
      <form id="rp-resource-form" class="cs-form"><h3>补充外部学习入口</h3>
        <label>课程 / 专题<select name="courseId">${options}</select></label>
        <label>资源名称<input name="title" required maxlength="120"></label><label>外部地址<input name="url" type="url" required></label>
        <label>类型<input name="type" required placeholder="例如课程讲解、练习平台"></label><label>适用基础<input name="audience" required maxlength="200"></label>
        <div class="cs-form-row"><label>收费情况<select name="cost"><option value="unknown">以原站为准</option><option value="free">免费</option><option value="paid">收费</option><option value="mixed">部分收费</option></select></label>
          <label>核对日期<input name="checkedAt" type="date" required></label></div>
        <button class="as-get is-primary cs-submit" type="submit">保存学习入口</button></form>
    </details>`;
  repairPhotos(content);
  $('#rp-teacher-form select[name=id]').addEventListener('change', async (event) => {
    const t = event.target.value ? await hubApi.teacher(event.target.value) : {};
    const form = $('#rp-teacher-form');
    ['name', 'faculty', 'title', 'sourceUrl'].forEach((k) => { form.elements[k].value = t[k] || ''; });
    form.elements.photoUrl.value = t.photo?.url || '';
    form.elements.photoSource.value = t.photo?.sourceUrl || '';
    form.elements.photoCredit.value = t.photo?.credit || '';
    form.elements.photoRights.checked = false;
    form.elements.checked.checked = false;
    form.dataset.teaching = JSON.stringify(t.teaching || []);
  });
  for (const [id, kind] of [['rp-teacher-form', 'teachers'], ['rp-offering-form', 'offerings'], ['rp-resource-form', 'courses']]) {
    $(`#${id}`).addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.target;
      const f2 = Object.fromEntries(new FormData(form));
      const btn = $('button[type=submit]', form);
      btn.disabled = true;
      try {
        let data;
        if (kind === 'teachers') {
          data = { id: f2.id || undefined, name: f2.name, faculty: f2.faculty, title: f2.title, sourceUrl: f2.sourceUrl,
            sourceChecked: f2.checked === 'on', teaching: JSON.parse(form.dataset.teaching || '[]'),
            photo: f2.photoUrl ? { url: f2.photoUrl, sourceUrl: f2.photoSource, credit: f2.photoCredit, rightsConfirmed: f2.photoRights === 'on' } : {} };
        } else if (kind === 'offerings') {
          data = { courseId: f2.courseId, teachers: [f2.teacher], term: f2.term, campus: f2.campus, sourceUrl: f2.sourceUrl, sourceChecked: f2.checked === 'on' };
        } else {
          const c = await hubApi.course(f2.courseId);
          data = { ...c, sourceChecked: true, resources: [...c.resources.filter((r) => r.url !== f2.url), { title: f2.title, url: f2.url, type: f2.type, audience: f2.audience, cost: f2.cost, checkedAt: f2.checkedAt }] };
        }
        await hubApi.saveReputationCatalogue(kind, data);
        message('资料已保存。');
        courses = null;
        await moderation();
      } catch (error) { fail(error); } finally { btn.disabled = false; }
    });
  }
}

// ---------- 写评价 ----------
async function openEditor(review) {
  if (!allowed()) return;
  editing = review || null;
  const form = $('#rp-review-form');
  form.reset();
  const kind = review?.subjectType || targetType;
  $('#rp-context-fields').hidden = kind === 'offering';
  $('#rp-editor-title').textContent = review ? '修改评价' : '写评价';
  $('#rp-subject-label').textContent = kind === 'teacher'
    ? `${current?.name ? `${current.name} · ` : ''}教师整体教学体验，与课程评分分开计算。一位老师你只保留一份评价，可以随时修改。`
    : '这次开课的课程体验。';
  if (!tagList.length) tagList = (await hubApi.reputationTags().catch(() => ({ items: [] }))).items;
  $('#rp-tags').innerHTML = tagList.map((t) => `<label class="as-tag"><input type="checkbox" name="tags" value="${esc(t)}">${esc(t)}</label>`).join('');
  const list = await loadCourses().catch(() => []);
  form.elements.courseId.innerHTML = `<option value="">暂不填写</option>${list.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}`;
  if (review) {
    form.elements.rating.value = review.rating;
    form.elements.body.value = review.body;
    form.elements.courseId.value = review.courseId;
    form.elements.term.value = review.term;
    form.elements.anonymous.checked = review.anonymous;
    $$('input[name=tags]', form).forEach((i) => { i.checked = (review.tags || []).includes(i.value); });
  }
  limitTags();
  showStarWord();
  $('#rp-editor-error').textContent = '';
  editor.showModal();
}
function showStarWord() {
  const v = Number(new FormData($('#rp-review-form')).get('rating') || 0);
  $('#rp-star-word').textContent = STAR_WORDS[v];
  $$('.rp-star-input label').forEach((l, i) => l.classList.toggle('is-on', i < v));
}
function limitTags() {
  const boxes = $$('#rp-tags input');
  const n = boxes.filter((b) => b.checked).length;
  boxes.forEach((b) => { b.disabled = !b.checked && n >= 3; b.parentElement.classList.toggle('is-disabled', b.disabled); });
}
$('#rp-review-form').addEventListener('change', (e) => {
  if (e.target.name === 'rating') {
    showStarWord();
    const label = e.target.closest('label');
    $$('.rp-star-input label.is-on span').forEach((s, i) => s.animate?.([{ transform: 'scale(.6)' }, { transform: 'scale(1.25)', offset: 0.6 }, { transform: 'scale(1)' }],
      { duration: 420, delay: i * 40, easing: 'cubic-bezier(.34,1.56,.64,1)' }));
    pop(label.querySelector('span'));
  }
  if (e.target.name === 'tags') limitTags();
});
$('#rp-review-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  const f = new FormData(form);
  const btn = $('button[type=submit]', form);
  const data = { rating: Number(f.get('rating')), body: f.get('body'), courseId: f.get('courseId') || '', term: f.get('term') || '',
    anonymous: f.has('anonymous'), tags: f.getAll('tags') };
  btn.disabled = true;
  try {
    if (editing) await hubApi.saveReview(editing.id, editing.revision, data);
    else await hubApi.submitReview({ subjectType: targetType, subjectId: targetId, data });
    editor.close();
    message('评价已提交审核。可以在“我的评价”里查看结果。');
    if (view === 'mine') await mine();
  } catch (error) { $('#rp-editor-error').textContent = error.message; } finally { btn.disabled = false; }
});

// ---------- 站外讨论、更正申请、通用说明框 ----------
$('#rp-mention-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  const btn = $('button[type=submit]', form);
  btn.disabled = true;
  try {
    await hubApi.submitMention({ subjectType: targetType === 'course' ? 'course' : 'teacher', subjectId: targetId,
      url: form.elements.url.value.trim(), title: form.elements.title.value.trim(), summary: form.elements.summary.value.trim() });
    form.reset();
    $('#rp-mention-dialog').close();
    message('已提交，维护者打开原帖核对后才会显示。');
  } catch (error) { $('#rp-mention-error').textContent = error.message; } finally { btn.disabled = false; }
});
$('#rp-request-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  const btn = $('button[type=submit]', form);
  btn.disabled = true;
  try {
    const r = await hubApi.teacherRequest(targetId, form.elements.kind.value, form.elements.body.value.trim());
    form.reset();
    $('#rp-request-dialog').close();
    message(r.message);
  } catch (error) { $('#rp-request-error').textContent = error.message; } finally { btn.disabled = false; }
});
$$('dialog [data-close]').forEach((btn) => btn.addEventListener('click', () => btn.closest('dialog').close()));
function actionDialog(title, label, callback) {
  pendingAction = callback;
  $('#rp-action-form').reset();
  $('#rp-action-title').textContent = title;
  $('#rp-action-label').textContent = label;
  $('#rp-action-error').textContent = '';
  $('#rp-action-dialog').showModal();
}
$('#rp-action-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const btn = $('button[type=submit]', event.target);
  btn.disabled = true;
  try {
    await pendingAction(new FormData(event.target).get('reason'));
    $('#rp-action-dialog').close();
    message('已保存。');
    await render();
  } catch (error) { $('#rp-action-error').textContent = error.message; } finally { btn.disabled = false; }
});

// ---------- 点击 ----------
content.addEventListener('click', async (event) => {
  const more = event.target.closest('[data-more]');
  if (more) { more.previousElementSibling.classList.remove('is-clamped'); more.hidden = true; return; }
  const sortBtn = event.target.closest('[data-sort]');
  if (sortBtn) {
    sort = sortBtn.dataset.sort;
    setSegment(sortBtn.parentElement, $$('[data-sort]', sortBtn.parentElement).indexOf(sortBtn));
    await loadReviews(0).catch(fail);
    return;
  }
  const btn = event.target.closest('[data-action], [data-page]');
  if (!btn) return;
  try {
    if (btn.dataset.page != null) { await loadReviews(Number(btn.dataset.page)); $('#reviews')?.scrollIntoView({ block: 'start' }); return; }
    const { action, id, version } = btn.dataset;
    if (action === 'thread') {
      const box = $(`[data-thread="${CSS.escape(id)}"]`);
      if (!box.hidden) { box.hidden = true; return; }
      const r = await hubApi.courseReview(id);
      box.innerHTML = r.replies.map((x) => `<div class="as-reply"><b>${esc(x.author.name)}</b><span>${esc(x.body)}</span><small>${esc(date(x.created))}</small></div>`).join('')
        + (!r.replies.length ? '<p class="as-fine">还没有公开回复。</p>' : '')
        + `<button class="as-see-all rp-inline" type="button" data-action="reply" data-id="${esc(id)}">匿名回复</button>`;
      box.hidden = false;
      return;
    }
    if (action === 'mention' || action === 'request' || action === 'write') {
      if (!allowed()) return;
      if (action === 'write') return openEditor();
      const dlg = $(action === 'mention' ? '#rp-mention-dialog' : '#rp-request-dialog');
      dlg.querySelector('[role=alert]').textContent = '';
      dlg.showModal();
      return;
    }
    if (!allowed()) return;
    if (action === 'edit') return openEditor(own.find((r) => r.id === id));
    if (action === 'like') {
      const on = btn.getAttribute('aria-pressed') !== 'true';
      btn.disabled = true;
      const r = await hubApi.likeReview(id, on);
      btn.setAttribute('aria-pressed', String(r.liked));
      rollTo(btn.querySelector('.num'), r.likes, on ? 1 : -1);
      if (on) pop(btn.querySelector('svg'));
      btn.disabled = false;
      return;
    }
    if (action === 'faculty-run' || action === 'faculty-run-one' || action === 'faculty-setup') {
      btn.disabled = true;
      if (action === 'faculty-setup') await hubApi.setupFaculty(true);
      const r = action === 'faculty-setup' ? { jobs: [] } : await hubApi.runFaculty(action === 'faculty-run-one' ? id : '');
      message(action === 'faculty-setup' ? '机器人已启用，每个学院每周自动运行一次。' : `已排队 ${r.jobs.length} 个学院，后台按顺序读取（每页间隔 1.5 秒），稍后刷新查看结果。`);
      await moderation();
      return;
    }
    if (action === 'photo-approve' || action === 'photo-reject' || action === 'photo-college') {
      btn.disabled = true;
      if (action === 'photo-college') await hubApi.approveCollegePhotos(id);
      else await hubApi.decideTeacherPhoto(id, action === 'photo-approve' ? 'approve' : 'reject');
      const card = btn.closest('.rp-photo-card');
      if (card) {
        // 收起卡片；页面在后台时动画不跑，400ms 后无论如何移除
        card.animate?.([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.9)' }], { duration: 220, easing: 'ease-in', fill: 'forwards' });
        setTimeout(() => card.remove(), 400);
      }
      if (action === 'photo-college') await moderation();
      return;
    }
    if (action === 'mention-approve' || action === 'mention-reject') {
      btn.disabled = true;
      await hubApi.moderateMention(id, action === 'mention-approve' ? 'approve' : 'reject');
      btn.closest('.rp-mention')?.remove();
      return;
    }
    if (action === 'mention-withdraw') {
      btn.disabled = true;
      await hubApi.withdrawMention(id);
      await mine();
      return;
    }
    const operations = {
      withdraw: ['撤回评价', '撤回原因', (reason) => hubApi.withdrawReview(id, reason)],
      report: ['举报', '举报说明（写清哪里违反了评分制度）', (reason) => hubApi.reportReview(id, reason)],
      appeal: ['申诉', '申诉说明', (reason) => hubApi.appealReview(id, reason)],
      reply: ['匿名回复', '回复内容', (reason) => hubApi.replyToReview(id, reason)],
      approve: ['通过审核', '通过说明', (reason) => hubApi.moderateReview(id, Number(version), 'approve', reason)],
      reject: ['退回评价', '退回原因', (reason) => hubApi.moderateReview(id, Number(version), 'reject', reason)],
      'reply-approve': ['通过回复', '通过说明', (reason) => hubApi.moderateReviewReply(id, 'approve', reason)],
      'reply-reject': ['退回回复', '退回原因', (reason) => hubApi.moderateReviewReply(id, 'reject', reason)],
      resolve: ['处理结果', '处理结果', (reason) => hubApi.resolveReviewCase(id, reason)],
    };
    if (operations[action]) actionDialog(...operations[action]);
  } catch (error) { btn.disabled = false; fail(error); }
});

async function render() {
  if (targetType) await detail();
  else if (view === 'mine') await mine();
  else if (view === 'moderation') await moderation();
  else await directory();
  repairPhotos(content);
  refreshFx(content);
}
async function start() {
  state = await hubState();
  $('#rp-mod-link').hidden = !state.user?.moderator;
  const tab = targetType ? '' : view;
  if (tab === 'mine' || tab === 'moderation') $(`[data-tab="${tab}"]`)?.setAttribute('aria-current', 'page');
  if (state.user) {
    const a = $('[data-circle-avatar]');
    a.classList.add('is-user');
    a.textContent = [...(state.user.name || state.user.username)][0].toUpperCase();
  }
  if (!state.online) {
    content.innerHTML = `${empty('口碑服务暂时未连接', '评分与评论需要社区服务。已有资料和外部学习入口仍可浏览。')}
      <p class="rp-center"><a class="as-get" href="materials.html">看资料</a> <a class="as-get" href="discover.html">逛开源广场</a></p>`;
    return;
  }
  await render();
}
addEventListener('hashchange', jumpToHash);
start().catch((error) => { content.innerHTML = empty('加载暂时失败', '刷新页面后再试。'); fail(error); });
