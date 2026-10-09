import { attachSearchSuggestions } from '../js/search-suggestions.js';
import { loadLearningCatalogue } from '../js/learning-catalog.js';
import {newsMediaLayout,bindNewsImage} from '../js/news-media.js';
import {applyEditorial} from '../js/editorial-data.js';
// 首页“今日矿大”：第一屏是横向大轮播（Apple TV / App Store 首页），下面按 App Store 的货架排热帖、开源、竞赛和口碑。
// 只用真实数据：学校新闻和宣讲会要等来源登记和编辑核对（data/featured.json），没有就不编；
// 社区服务没连上、读取失败、确实没有内容，三种情况分别说明。
// 配图一律由 Codex 交付（实拍或照片级图片，登记在 art/manifest.json），页面不自己画；没交付时只用底色。
import { initShell, observeReveal, reducedMotion } from '../js/shell.js';
import { hubApi, hubState, loginURL } from '../js/hub.js';
import { playOpening } from '../js/opening.js';
import { loadCommunity, fmtNum, timeAgo } from '../js/community.js';
import { CATEGORIES } from '../js/schema.js';
import { daysUntil, esc, load as loadCatalog, catalogStats } from '../js/data.js';
import { glyphSVG } from '../js/cover.js';
import { mountArt } from '../js/art.js';
import { appIcon } from '../js/app-icons.js';
import { openStory } from '../js/story.js';
import { mountCarousel } from '../js/carousel.js';
import { animate as springTo } from '../js/motion.js';
import { loadMaterials, readBag, toggleBag, yearKey } from '../js/materials-catalog.js';
import { readyMe, loadMe, classesOn, todayIndex } from '../js/quests.js';
import '../styles/v3.css';
import '../styles/today.css';
import '../styles/app-store.css';

initShell();
import { mountHomeUpdates } from '../js/home-updates.js';
void mountHomeUpdates();

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const panel = $('#td-panel');
const heroEl = $('#td-hero');
const safeURL = (u) => (typeof u === 'string' && /^https?:\/\//.test(u) ? u : null);
const json = (path) => fetch(path, { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).then(d=>applyEditorial(path.split('/').pop().replace('.json',''),d)).catch(() => null);
const ok = (d) => d && !d.error;

const st = { tab: 'picks', online: false, user: null };
attachSearchSuggestions($('#td-learning-q'), {
  getItems: async () => (await loadLearningCatalogue()).items.filter(item => !item.localOnly && item.access !== 'private'),
  getKeywords: item => [item.code,item.id,item.courseName].filter(Boolean).join(' '),
  getMeta: item => item.courseName || '课程与资料',
});

// ---------- 数据：只请求一次，各处共用 ----------

const once = new Map();
const get = (key, fn) => {
  if (!once.has(key)) once.set(key, fn().catch((e) => ({ error: e.message ?? '读取失败' })));
  return once.get(key);
};

const loaders = {
  site: () => json('data/site.json'),
  featured: async () => {
    const d = await json('data/featured.json');
    const now = Date.now();
    // 编辑设定的展示期限之外的不显示；过期内容留给检索，不再当精选
    const picked = (d?.items ?? []).filter((x) => x?.title && (!x.startsAt || Date.parse(x.startsAt) <= now) && (!x.expiresAt || Date.parse(x.expiresAt) > now));
    // 维护机器人从矿大新闻网抓到、维护者审核通过的新闻：最近 14 天内的最多 3 条，排在编辑精选后面
    const state = await hubState();
    if (!state.online) return picked;
    try {
      const r = await hubApi.catalogue({ kind: 'news' });
      const seen = new Set(picked.map((x) => x.href || x.source?.url));
      const recent = (r.items ?? [])
        .map((e) => ({ e, d: e.data ?? {} }))
        .filter(({ d }) => d.title && d.links?.source && !seen.has(d.links.source) && now - (Date.parse(d.publishedAt) || 0) < 14 * 86400e3)
        .sort((a, b) => (Date.parse(b.d.publishedAt) || 0) - (Date.parse(a.d.publishedAt) || 0))
        .slice(0, 3)
        .map(({ e, d }) => ({
          id: `hub-${e.id}`, kind: 'news', title: d.title, dek: d.summary, href: d.links.source,
          source: { name: d.sourceNote || '矿大新闻网', type: 'official', url: d.links.source },
          publishedAt: d.publishedAt, eventAt: d.publishedAt?.slice(0, 10), checkedAt: e.updated,
          media: d.media?.src ? { ...d.media, alt: d.media.alt || d.title } : null,
        }));
      return [...picked, ...recent];
    } catch {
      return picked;
    }
  },
  competitions: () => json('data/competitions.json'),
  projects: () => loadCommunity().then((d) => d.projects),
  circle: () => hubApi.circleFeed({ lane: 'recommended' }),
  following: () => hubApi.circleFeed({ lane: 'following' }),
  notices: () => hubApi.notifications(),
  teachers: () => hubApi.teachers(),
  reviews: () => hubApi.reviews({ limit: 12 }),
  cet4: () => loadCatalog('cet4'),
  cet6: () => loadCatalog('cet6'),
  school: () => loadCatalog('school'),
};
const load = (key) => get(key, loaders[key]);

// ---------- 小工具 ----------

const PADDLE = (dir, label, d) => `<button class="td-paddle" type="button" data-dir="${dir}" aria-label="${label}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg></button>`;
const withPaddles = (shelf) => `<div class="td-shelf-wrap">${PADDLE(-1, '上一组', 'm14.5 5.5-6.5 6.5 6.5 6.5')}${shelf}${PADDLE(1, '下一组', 'm9.5 5.5 6.5 6.5-6.5 6.5')}</div>`;
const CHEVRON = '<svg class="as-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9.5 5.5 6.5 6.5-6.5 6.5"/></svg>';
// App Store 的分区标题：粗体标题带箭头，右边“查看全部”
function sec(title, link) {
  const head = link?.href ? `<a class="as-title" href="${esc(link.href)}"><h2>${title}</h2>${CHEVRON}</a>` : `<h2>${title}</h2>`;
  const all = link?.go ? `<button type="button" class="btn-link as-all" data-go="${link.go}">查看全部</button>` : link?.href ? `<a class="as-all" href="${esc(link.href)}">查看全部</a>` : '';
  return `<div class="v3-sec">${head}${all}</div>`;
}
const quiet = (text, action = '') => `<div class="td-quiet"><p>${text}</p>${action}</div>`;
const offline = (what) => quiet(`${what}保存在社区服务里。现在打开的是只读的静态页面，所以这里看不到，<b>不代表没有内容</b>。`);
const failed = (what, err) => quiet(`${what}暂时读不到：${esc(err)}。`);
const fmtDate = (iso) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric' }).format(new Date(iso));

const postTitle = (p) => p.data?.title || (p.data?.body ?? '').split('\n')[0].slice(0, 60) || '一条动态';
const postHref = (p) => `circle.html?post=${encodeURIComponent(p.id)}`;
const initial = (s) => esc([...(s || '?')][0].toUpperCase());

function stars(avg) {
  const fill = avg == null ? 0 : Math.max(0, Math.min(100, (avg / 5) * 100));
  return `<span class="td-stars" aria-hidden="true">★★★★★<i style="width:${fill}%">★★★★★</i></span>`;
}

// 评分口径（Owner 确认）：0 份暂无评分；1–4 份显示真实均分 + 份数 + 样本较少；均分保留一位小数
function scoreHTML(s) {
  if (!s?.count) return '<span class="v3-tile-score is-low">暂无评分</span>';
  return `<span class="v3-tile-score num">${s.average.toFixed(1)}</span>`;
}
const scoreSub = (s, unit = '份评价') => (s?.count ? `${s.count} ${unit}${s.smallSample ? ' · 样本较少' : ''}` : '还没有评价');

function catIcon(category) {
  const c = CATEGORIES[category];
  return `<span class="v3-icon as-icon" style="--h:${c?.hue ?? 215}">${glyphSVG(category)}</span>`;
}

// 项目图标：用 GitHub 上作者自己的头像（真实图片），加载失败时退回分类图标
function projectIcon(p) {
  const owner = p.repo?.fullName?.split('/')[0];
  if (!owner || !/^[\w.-]+$/.test(owner)) return catIcon(p.category);
  return `<span class="v3-icon as-icon as-photo" style="--h:${CATEGORIES[p.category]?.hue ?? 215}">${glyphSVG(p.category)}<img src="https://github.com/${esc(owner)}.png?size=128" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()"></span>`;
}

// ---------- 第一屏：横向大轮播 ----------
// 每张是一篇“故事”：点卡片（或“了解更多”）原地展开；主按钮直接去对应页面。
// data-art 是给 Codex 配图留的插槽（实拍 / 照片级），没交付时只显示底色。

const BG = {
  news: 'radial-gradient(120% 90% at 80% 10%, #8a1d33 0%, transparent 55%), linear-gradient(160deg, #3a0d17, #120708)',
  exam: 'radial-gradient(120% 90% at 85% 15%, #2f5fd0 0%, transparent 55%), linear-gradient(165deg, #12285a, #070c1c)',
  campus: 'radial-gradient(110% 90% at 15% 10%, #1f7a5a 0%, transparent 55%), linear-gradient(170deg, #0c2a22, #06110e)',
  open: 'radial-gradient(110% 90% at 85% 10%, #7a3bd6 0%, transparent 55%), linear-gradient(165deg, #22103d, #0b0714)',
  circle: 'radial-gradient(110% 90% at 15% 15%, #e2742a 0%, transparent 55%), linear-gradient(165deg, #3a1a0a, #120905)',
  chances: 'radial-gradient(110% 90% at 85% 15%, #0a84ff 0%, transparent 55%), linear-gradient(165deg, #0b2a4a, #050b14)',
};
const KIND = { news: '学校新闻', talk: '宣讲会', opportunity: '机会', creator: '校园创作者', notice: '本站公告' };
const STORIES = new Map();

const stat = (label, value) => `<div><dt>${esc(label)}</dt><dd>${value}</dd></div>`;
const linkBtn = (href, text, primary = false) => `<a class="btn ${primary ? 'btn-primary' : 'btn-secondary'}" href="${esc(href)}"${/^https?:/.test(href) ? ' target="_blank" rel="noopener"' : ''}>${esc(text)}</a>`;

function slide({ id, eyebrow, title, dek, bg, art, media, primary, story }) {
  if (story) STORIES.set(id, story);
  const picture=newsMediaLayout(media||{});
  const ext = /^https?:/.test(primary.href) ? ' target="_blank" rel="noopener"' : '';
  const contentKey=id.startsWith('f-hub-')?'entry/'+id.slice(6):id.startsWith('f-')?'featured/'+id.slice(2):'';
  return `<article class="hc-slide" aria-roledescription="slide" data-id="${esc(id)}"${contentKey?` data-content-key="${esc(contentKey)}"`:''}>
    <div class="hc-card" ${story ? `data-story="${esc(id)}"` : ''} style="--hc-bg:${bg}">
      <div class="hc-media"${art ? ` data-art="${esc(art)}"` : ''}${media?` data-fit="${picture.fit}" data-position="${picture.position}"`:''}>${media ? `<img class="art-img" src="${esc(media.src)}" alt="${esc(media.alt ?? '')}"${picture.width&&picture.height?` width="${picture.width}" height="${picture.height}"`:''} style="object-position:${picture.position}" loading="${media.priority ? 'eager' : 'lazy'}" fetchpriority="${media.priority ? 'high' : 'auto'}" decoding="async" referrerpolicy="no-referrer">` : ''}</div>
      <div class="hc-copy">
        <p class="hc-eyebrow">${esc(eyebrow)}</p>
        <h2 class="hc-title">${title}</h2>
        ${dek ? `<p class="hc-dek">${esc(dek)}</p>` : ''}
        <div class="hc-actions">
          <a class="glass-pill is-solid" href="${esc(primary.href)}"${ext}>${esc(primary.label)}</a>
          ${story ? '<button class="glass-pill" type="button" data-open-story>了解更多</button>' : ''}
        </div>
      </div>
    </div>
  </article>`;
}

async function heroSlides() {
  const [featured, site, projects, cet4, cet6, comps, circle] = await Promise.all(['featured', 'site', 'projects', 'cet4', 'cet6', 'competitions', st.online ? 'circle' : null].map((k) => (k ? load(k) : null)));
  STORIES.clear();
  const out = [];

  // 1. 编辑精选（学校新闻、宣讲会……），永远排最前
  (Array.isArray(featured) ? featured : []).forEach((f, i) => {
    const href = f.href || safeURL(f.source?.url);
    if (!href) return;
    out.push(slide({
      id: `f-${f.id ?? i}`,
      eyebrow: `${KIND[f.kind] ?? '编辑精选'}${f.source?.name ? ` · ${f.source.name}` : ''}`,
      title: esc(f.title),
      dek: f.dek ?? f.reason ?? '',
      bg: BG.news,
      media: f.media?.src ? f.media : null,
      primary: { href, label: /^https?:/.test(href) ? '阅读原文' : '查看' },
      story: () => ({
        label: f.title,
        body: `${f.dek ? `<p class="story-lede">${esc(f.dek)}</p>` : ''}
          ${f.reason ? `<p class="story-h">为什么推荐</p><p>${esc(f.reason)}</p>` : ''}
          <ul class="story-rows">${f.eventAt ? `<li><b>时间</b><span>${esc(fmtDate(f.eventAt))}</span></li>` : ''}${f.source?.name ? `<li><b>来源</b><span>${esc(f.source.name)}</span></li>` : ''}${f.checkedAt ? `<li><b>编辑核对</b><span>${esc(fmtDate(f.checkedAt))}${f.editor ? ` · ${esc(f.editor)}` : ''}</span></li>` : ''}</ul>
          <div class="story-actions">${linkBtn(href, /^https?:/.test(href) ? '阅读原文' : '查看详情', true)}</div>
          ${f.media?.credit ? `<p class="story-note">图片：${esc(f.media.credit)}</p>` : ''}`,
      }),
    }));
  });

  // 2. 四六级倒计时
  const exam = site?.nextExam;
  const days = exam?.date ? daysUntil(exam.date) : -1;
  if (days >= 0) {
    const s4 = ok(cet4) ? catalogStats(cet4) : null;
    const s6 = ok(cet6) ? catalogStats(cet6) : null;
    out.push(slide({
      id: 'exam',
      eyebrow: '四六级 · 本站推荐',
      title: days === 0 ? '今天就是<br>四六级笔试' : `距${esc(exam.label.replace(/^\d{4} 年 /, ''))}<br>还有 <span class="hc-big">${days}</span> 天`,
      dek: (exam.sessions ?? []).map((x) => `${x.exam} ${x.time}`).join(' · '),
      bg: BG.exam,
      art: 'hero-exam',
      primary: { href: 'materials.html', label: '选资料' },
      story: () => ({
        label: '四六级倒计时',
        body: `<p class="story-lede">${esc(exam.label)}在 ${esc(fmtDate(exam.date))}，还有 ${days} 天。</p>
          <dl class="story-stats">${stat('四级套卷', s4?.sets ?? '—')}${stat('六级套卷', s6?.sets ?? '—')}${stat('含听力', (s4?.listening ?? 0) + (s6?.listening ?? 0))}${stat('已上线文件', (s4?.ready ?? 0) + (s6?.ready ?? 0))}</dl>
          <p class="story-h">考试安排</p>
          <ul class="story-rows">${(exam.sessions ?? []).map((x) => `<li><b>${esc(x.exam)}</b><span>${esc(x.time)}</span></li>`).join('')}</ul>
          <div class="story-actions">${linkBtn('cet4.html', '四级真题', true)}${linkBtn('cet6.html', '六级真题')}${safeURL(exam.sourceUrl) ? linkBtn(exam.sourceUrl, '考试院官网') : ''}</div>
          <p class="story-note">${esc(exam.source ?? '')}。套卷数按资料目录统计；目录已排好、文件还没上线的套卷不算“已上线文件”。</p>`,
      }),
    }));
  }

  // 3. 校园地图
  out.push(slide({
    id: 'campus',
    eyebrow: '校园 · 本站推荐',
    title: '校园的每一处，<br>都有新的可能。',
    dek: '填上你的课，看今天去哪栋楼；演出、限时事件、好去处都标在上面。',
    bg: BG.campus,
    art: 'hero-campus',
    primary: { href: 'map.html', label: '打开地图' },
    story: () => ({
      label: '校园地图',
      body: `<p class="story-lede">楼宇轮廓全部来自 OpenStreetMap，没有补画；地点由同学投稿，核对之后才上图。</p>
        <ul class="story-rows">
          <li><b>我的课</b><span>填上课表，看今天每节课在哪栋楼</span></li>
          <li><b>去哪学习</b><span>按空闲时间找自习的地方</span></li>
          <li><b>标一个地点</b><span>演出、限时事件、好去处，审核后出现在地图上</span></li>
        </ul>
        <div class="story-actions">${linkBtn('map.html', '打开校园地图', true)}${linkBtn('map.html?add=place#explore', '标一个地点')}</div>
        <p class="story-note">楼宇轮廓 © OpenStreetMap 贡献者（ODbL）。课表只存在你的浏览器里。</p>`,
    }),
  }));

  // 4. 校圈热帖（社区服务在线时）
  const top = ok(circle) ? circle.items?.[0] : null;
  if (top)
    out.push(slide({
      id: 'circle',
      eyebrow: `校圈热帖${top.owner?.name ? ` · ${top.owner.name}` : ''}`,
      title: esc(postTitle(top)),
      dek: top.data?.summary ?? '',
      bg: BG.circle,
      art: 'hero-circle',
      primary: { href: postHref(top), label: '去讨论' },
    }));

  // 5. 开源推荐
  const pick = Array.isArray(projects) ? [...projects].sort((a, b) => (b.repo?.stars ?? 0) - (a.repo?.stars ?? 0))[0] : null;
  if (pick) {
    const cat = CATEGORIES[pick.category];
    out.push(slide({
      id: 'open',
      eyebrow: `开源广场 · ${cat?.short ?? '推荐'}`,
      title: esc(pick.title),
      dek: pick.summary,
      bg: BG.open,
      art: `hero-open-${pick.category}`,
      primary: { href: 'discover.html', label: '去开源广场' },
      story: () => ({
        label: pick.title,
        body: `<p class="story-lede">${esc(pick.summary)}</p>
          <dl class="story-stats">${pick.repo?.stars != null ? stat('GitHub ★', fmtNum(pick.repo.stars)) : ''}${pick.repo?.forks != null ? stat('Fork', fmtNum(pick.repo.forks)) : ''}${pick.repo?.language ? stat('主要语言', esc(pick.repo.language)) : ''}${stat('分类', esc(cat?.short ?? '其他'))}</dl>
          <div class="story-actions">${linkBtn(st.online ? `project.html?slug=${encodeURIComponent(pick.slug)}` : 'discover.html', '在开源广场查看', true)}${safeURL(pick.links?.repo) ? linkBtn(pick.links.repo, '打开仓库') : ''}</div>
          <p class="story-note">${pick.origin === 'external' ? `外部推荐，原作者 ${esc(pick.credit ?? '')}；` : ''}许可：${esc(pick.repo?.license ?? '仓库未声明，使用前请向作者确认')}。Star 数只作参考，不决定推荐。</p>`,
      }),
    }));
  }

  // 6. 竞赛
  const n = comps?.competitions?.length ?? 0;
  if (n)
    out.push(slide({
      id: 'chances',
      eyebrow: '竞赛与机会',
      title: `<span class="hc-big">${n}</span> 项比赛，<br>都在学校的名录里`,
      dek: `${comps.competitions.slice(0, 3).map((c) => c.name).join('、')}……`,
      bg: BG.chances,
      art: 'hero-chances',
      primary: { href: '#chances', label: '查看全部' },
    }));
  return out;
}

const ARROW = (dir) => `<button class="hc-arrow" type="button" data-dir="${dir}" aria-label="${dir > 0 ? '下一张' : '上一张'}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${dir > 0 ? 'm9.5 5.5 6.5 6.5-6.5 6.5' : 'm14.5 5.5-6.5 6.5 6.5 6.5'}"/></svg></button>`;

async function mountHero() {
  const slides = await heroSlides();
  heroEl.innerHTML = `<div class="hc-viewport">${slides.join('')}</div>
    <div class="hc-controls">${ARROW(-1)}
      <div class="hc-dots" role="tablist" aria-label="选择一张">${slides.map((_, i) => `<button class="hc-dot" type="button" role="tab" aria-label="第 ${i + 1} 张"><i></i></button>`).join('')}</div>
      <button class="hc-play" type="button" aria-label="暂停自动播放"><svg class="is-pause" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6v12M15 6v12"/></svg><svg class="is-play" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10-6.5z"/></svg></button>
      ${ARROW(1)}</div>`;
  $$('.hc-slide', heroEl).forEach((s, i) => s.setAttribute('aria-label', `第 ${i + 1} 张，共 ${slides.length} 张`));
  // Official images stay on their original host. If unavailable, retain a readable news card.
  $$('.hc-media img', heroEl).forEach(img => {
    bindNewsImage(img,{fit:img.parentElement.dataset.fit,position:img.parentElement.dataset.position});
    img.addEventListener('error', () => img.remove(), { once: true });
  });
  const c = mountCarousel(heroEl);
  mountArt(heroEl);
  return c;
}

heroEl.addEventListener('click', (e) => {
  if (e.target.closest('a[href="#chances"]')) {
    e.preventDefault();
    show('chances');
    tabs.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
    return;
  }
  if (e.target.closest('a')) return;
  const card = e.target.closest('.hc-slide.is-active [data-story]');
  if (!card) return;
  const story = STORIES.get(card.dataset.story)?.();
  if (!story) return;
  const hero = card.cloneNode(true);
  hero.querySelector('.hc-actions')?.remove();
  openStory(card, { label: story.label, body: story.body, hero: hero.innerHTML });
});

// ---------- 货架：App Store 的三行网格（Top Charts / 应用列表） ----------

const grid = (items, cls = '') => `<div class="as-grid ${cls}">${items.join('')}</div>`;

function lockup({ href, icon, title, sub, pill = '查看', rank, ext = false }) {
  return `<a class="as-lockup" href="${esc(href)}"${ext ? ' target="_blank" rel="noopener"' : ''}>
    ${rank ? `<span class="as-rank num">${rank}</span>` : ''}${icon}
    <span class="as-text"><b>${esc(title)}</b><span>${esc(sub)}</span></span>
    <span class="v3-pill">${esc(pill)}</span>
  </a>`;
}

async function hotShelf(limit = 9) {
  if (!st.online) return offline('校圈的帖子');
  const r = await load('circle');
  if (r?.error) return failed('校圈', r.error);
  const list = (r?.items ?? []).slice(0, limit);
  if (!list.length) return quiet('校圈还没有帖子。第一条动态、第一个话题，可以由你来发。');
  return grid(list.map((p, i) => lockup({
    href: postHref(p),
    rank: i + 1,
    icon: `<span class="as-icon as-avatar" style="--h:${(i * 47 + 20) % 360}">${initial(p.owner?.name)}</span>`,
    title: postTitle(p),
    sub: `${p.owner?.name ? `${p.owner.name} · ` : ''}回复 ${fmtNum(p.replies ?? 0)} · 赞 ${fmtNum(p.likes ?? 0)}`,
  })), 'is-ranked');
}

async function hotList(limit = 20) {
  if (!st.online) return offline('校圈的帖子');
  const r = await load('circle');
  if (r?.error) return failed('校圈', r.error);
  const list = (r?.items ?? []).slice(0, limit);
  if (!list.length) return quiet('校圈还没有帖子。第一条动态、第一个话题，可以由你来发。');
  return `<ol class="v3-hot">${list
    .map((p) => `<li><a class="v3-hot-title" href="${esc(postHref(p))}">${esc(postTitle(p))}</a>
      <span class="v3-hot-heat">回复 ${fmtNum(p.replies ?? 0)} · 赞 ${fmtNum(p.likes ?? 0)}</span></li>`)
    .join('')}</ol>
    <p class="v3-note">按校圈的推荐规则排列（算法 ${esc(r.algorithmVersion ?? '')}），参考你主动选择的兴趣和维护者的核对，不是累计点赞榜。</p>`;
}

async function competitionShelf(limit) {
  const d = await load('competitions');
  const list = (d?.competitions ?? []).slice(0, limit ?? Infinity);
  if (!list.length) return quiet('竞赛名录没有加载出来。');
  return `${grid(list.map((c) => lockup({
    href: safeURL(c.officialUrl) ?? '#',
    ext: Boolean(safeURL(c.officialUrl)),
    icon: catIcon(c.category),
    title: c.name,
    sub: `${CATEGORIES[c.category]?.name ?? ''} · ${c.deadline ? `截止 ${c.deadline}` : '报名时间以官方通知为准'}`,
    pill: '官网',
  })))}
    <p class="v3-note">名录来自${esc(d.competitions[0]?.sourceTitle ?? '学校公开的学科竞赛名录')}，核对于 ${esc(d.checkedAt ?? '')}。它说明这些比赛和学校有关，不代表现在正在报名。</p>`;
}

async function projectShelf(limit = 9) {
  const list = await load('projects');
  if (!Array.isArray(list) || !list.length) return quiet('开源广场的目录没有加载出来。');
  return grid([...list]
    .sort((a, b) => (b.repo?.stars ?? 0) - (a.repo?.stars ?? 0))
    .slice(0, limit)
    .map((p) => {
      const href = st.online ? `project.html?slug=${encodeURIComponent(p.slug)}` : safeURL(p.links?.repo) ?? 'projects.html';
      return lockup({
        href,
        ext: /^https?:/.test(href),
        icon: projectIcon(p),
        title: p.title,
        sub: `${CATEGORIES[p.category]?.short ?? ''}${p.repo?.stars != null ? ` · ★ ${fmtNum(p.repo.stars)}` : ''} · ${p.origin === 'external' ? '外部推荐' : '矿大同学'}`,
      });
    }));
}

// App Store 的“评分及评论”卡片：标题、星级、日期、作者、正文
async function reviewShelf() {
  if (!st.online) return offline('课程和教师的口碑');
  const [r, t] = await Promise.all([load('reviews'), load('teachers')]);
  const reviews = ok(r) ? (r.items ?? []).filter((x) => x.body) : [];
  if (reviews.length)
    return withPaddles(`<div class="v3-shelf as-reviews">${reviews.slice(0, 10).map((x) => `<a class="as-review" href="reputation.html">
      <b class="as-review-title">${esc(x.title || x.subject?.name || '一条评价')}</b>
      <span class="as-review-meta">${x.rating ? stars(x.rating) : ''}<span>${x.created ? esc(timeAgo(x.created)) : ''}</span></span>
      <p>${esc(x.body)}</p>
    </a>`).join('')}</div>`);
  // 还没有文字评价时，退回教师评分墙
  if (!ok(t)) return failed('口碑', t?.error ?? '未知错误');
  const list = (t.items ?? []).slice(0, 6);
  if (!list.length) return quiet('还没有收录教师和课程资料。');
  return `<div class="v3-wall">${list
    .map((x) => `<a class="v3-tile" href="reputation.html?teacher=${encodeURIComponent(x.id)}">
      <div class="v3-tile-top"><span class="v3-tile-name">${esc(x.name)}</span>${scoreHTML(x.stats)}</div>
      <span class="v3-tile-sub">${esc(x.faculty || '学院待核')} · ${scoreSub(x.stats)}</span>
      ${x.stats?.count ? stars(x.stats.average) : ''}
      <p class="v3-tile-quote">${x.highlight ? `“${esc(x.highlight.body)}”<b>${x.highlight.likes ? `赞 ${x.highlight.likes}` : '最新'}</b>` : '还没有同学写评价。'}</p>
    </a>`)
    .join('')}</div>`;
}

const UI = {
  pin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0C18.5 15.4 12 21 12 21z"/><circle cx="12" cy="10" r="2.4"/></svg>',
  study: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9.5 12 5l9 4.5-9 4.5z"/><path d="M7 11.5V16c1.4 1.2 3.1 1.8 5 1.8s3.6-.6 5-1.8v-4.5"/></svg>',
  star: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 4 2.5 5.1 5.6.8-4 3.9.9 5.6-5-2.6-5 2.6.9-5.6-4-3.9 5.6-.8z"/></svg>',
  flag: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 21V4M6 4h10l-2 3.5L16 11H6"/></svg>',
};
const CAMPUS_LINKS = [
  ['map.html', '校园地图', '学院路 · 沙河', 212, 'pin'],
  ['map.html?type=study', '去哪学习', '按你的空闲时间', 150, 'study'],
  ['reputation.html', '选课口碑', '星级与原话', 28, 'star'],
  ['map.html?add=place#explore', '标一个地点', '演出、限时事件、好去处', 330, 'flag'],
];
const campusTiles = () => `<div class="v3-boards">${CAMPUS_LINKS.map(([href, name, sub, h, icon]) => `<a class="v3-board" href="${href}"><span class="v3-icon" style="--h:${h}">${UI[icon]}</span><span><b>${name}</b><span>${sub}</span></span></a>`).join('')}</div>`;

// ---------- 推荐：一列能直接用的内容（功能优先，不放宣传语） ----------
// 快捷操作 → 今天（课表、考试、资料袋）→ 校圈热帖 → 最新资料（直接放进资料袋）→ 开源推荐 → 最新评价 → 竞赛名录

const CHEV = '<svg class="ap-chev" viewBox="0 0 9 14" aria-hidden="true"><path d="m1.5 1.5 6 5.5-6 5.5"/></svg>';
const SYM = {
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m20 20-4.8-4.8"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  study: '<path d="M3 9.5 12 5l9 4.5-9 4.5z"/><path d="M7 11.5V16c1.4 1.2 3.1 1.8 5 1.8s3.6-.6 5-1.8v-4.5"/>',
  seat: '<path d="M7 4v8h10V4M5 12h14v3H5zM7 15v5M17 15v5"/>',
  upload: '<path d="M12 16V5M7.5 9.5 12 5l4.5 4.5M5 19h14"/>',
  post: '<path d="M4 5h16v11H9l-5 4z"/>',
  pin: '<path d="M12 21s-6-5.6-6-11a6 6 0 0 1 12 0c0 5.4-6 11-6 11z"/><circle cx="12" cy="10" r="2.2"/>',
  exam: '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4M10 12h5M10 16h5"/>',
  bag: '<path d="M5.5 8h13l-1 12.5h-11z"/><path d="M9 8V6.5a3 3 0 0 1 6 0V8"/>',
  trophy: '<path d="M8 4h8v5a4 4 0 0 1-8 0zM8 6H5v1.5A3 3 0 0 0 8 10.5M16 6h3v1.5a3 3 0 0 1-3 3M12 13v4M8.5 20h7M10 17h4"/>',
};
const sym = (k) => appIcon(k);
const modHead = (title, action = '') => `<div class="td-mod-head"><h2>${title}</h2>${action}</div>`;
const modNote = (text) => `<p class="ap-sub td-mod-note">${text}</p>`;

const QUICK = [
  ['planner.html', '今天的课', 'clock', 211],
  ['map.html?type=study', '去哪自习', 'study', 150],
  ['reservations.html', '座位预约', 'seat', 262],
  ['materials.html?upload=1', '上传资料', 'upload', 28],
  ['circle.html?compose=1', '发帖', 'post', 330],
  ['map.html?add=place#explore', '标地点', 'pin', 4],
];

function quickHTML() {
  return `<section class="td-mod td-quick" aria-label="快捷操作">
    <button class="td-search" type="button" data-search><svg viewBox="0 0 24 24" aria-hidden="true">${SYM.search}</svg><span>搜索资料、帖子、楼、项目</span><kbd class="kbd" data-kbd-mod>Ctrl K</kbd></button>
    <div class="td-quick-row">${QUICK.map(([href, name, icon, h]) => `<a class="td-quick-item" href="${href}">${sym(icon, h)}<span>${name}</span></a>`).join('')}</div>
  </section>`;
}

function bagRowText(n) {
  return n ? [`资料袋里有 ${n} 份`, '去打包下载'] : ['资料袋是空的', '在下面的“最新资料”里点“放入资料袋”'];
}

function todayRows(site) {
  const rows = [];
  let me;
  try { me = loadMe(); } catch { return '<p class="cp-fine">本地课表暂不可读。<a href="planner.html">打开校园中心检查存储权限</a></p>'; }
  const list = me.courses.length ? classesOn(me, todayIndex()) : [];
  const now = list.find((x) => x.status === 'now');
  const focus = now ?? list.find((x) => x.status === 'next');
  if (!me.courses.length) rows.push(`<a class="ap-row" href="planner.html">${sym('clock', 211)}<span class="ap-row-text"><b>还没有填课表</b><span>填上以后，这里显示下一节课在哪栋楼。课表只存在这个浏览器里。</span></span>${CHEV}</a>`);
  else if (focus) rows.push(`<a class="ap-row" href="planner.html">${sym('clock', 211)}<span class="ap-row-text"><b>${now ? '正在上' : '下一节'} · ${esc(focus.course.name)}</b><span>${esc(focus.slot.start)}–${esc(focus.slot.end)} · ${esc([focus.course.building?.name, focus.course.room].filter(Boolean).join(' · ') || '还没选教学楼')}</span></span>${CHEV}</a>`);
  else rows.push(`<a class="ap-row" href="planner.html">${sym('clock', 211)}<span class="ap-row-text"><b>${list.length ? '今天的课都上完了' : '今天没有课'}</b><span>一共 ${me.courses.length} 门课，点开看本周安排</span></span>${CHEV}</a>`);
  const exam = site?.nextExam;
  const days = exam?.date ? daysUntil(exam.date) : -1;
  if (days >= 0) rows.push(`<a class="ap-row" href="cet4.html">${sym('exam', 24)}<span class="ap-row-text"><b>${esc(exam.label)}</b><span>${(exam.sessions ?? []).map((x) => `${esc(x.exam)} ${esc(x.time)}`).join(' · ')} · 以考试院公告为准</span></span><span class="td-days"><b class="num">${days}</b>天</span></a>`);
  const [title, sub] = bagRowText(readBag().length);
  rows.push(`<a class="ap-row" href="materials.html?bag=1" data-bag-row>${sym('bag', 192)}<span class="ap-row-text"><b>${title}</b><span>${sub}</span></span>${CHEV}</a>`);
  return rows.join('');
}

async function todayHTML() {
  try { await readyMe(); } catch { /* Campus dashboard shows the storage error; homepage remains usable. */ }
  const site = await load('site');
  return `<section class="td-mod" aria-label="今天">${modHead('今天')}<div class="ap-list">${todayRows(site)}</div></section>`;
}

async function hotModule(limit = 5) {
  const action = '<a class="ap-more" href="circle.html?compose=1">发帖</a>';
  if (!st.online) return `<section class="td-mod">${modHead('校圈热帖', action)}${modNote('帖子保存在社区服务里；现在是只读的静态页面，看不到不代表没有。')}</section>`;
  const r = await load('circle');
  if (r?.error) return `<section class="td-mod">${modHead('校圈热帖', action)}${modNote(`暂时读不到：${esc(r.error)}`)}</section>`;
  const list = (r?.items ?? []).slice(0, limit);
  return `<section class="td-mod" aria-label="校圈热帖">${modHead('校圈热帖', '<a class="ap-more" href="circle.html">全部</a>')}
    ${list.length ? `<ol class="ap-list">${list.map((p, i) => `<li><a class="ap-row" href="${esc(postHref(p))}"><span class="ap-rank">${i + 1}</span>
      <span class="ap-row-text"><b>${esc(postTitle(p))}</b><span>${p.owner?.name ? `${esc(p.owner.name)} · ` : ''}回复 ${fmtNum(p.replies ?? 0)} · 赞 ${fmtNum(p.likes ?? 0)}</span></span>${CHEV}</a></li>`).join('')}</ol>`
      : '<div class="ap-empty"><b>还没有公开的帖子。</b><p>第一条动态、第一个话题，可以由你来发。</p><a class="btn btn-primary btn-sm" href="circle.html?compose=1">发帖</a></div>'}
  </section>`;
}

const fmtBadge = (x) => `<span class="td-fmt" data-format="${esc(x.format)}">${esc(String(x.format || '').toUpperCase() || 'FILE')}</span>`;
let homeMaterials = [];

function materialRow(x) {
  const on = readBag().some((b) => b.url === x.url);
  return `<li class="ap-row td-mat">${fmtBadge(x)}
    <span class="ap-row-text"><b>${esc(x.title)}</b><span>${esc(x.course)} · ${esc(x.kind)}${x.year ? ` · ${esc(x.year)}` : ''}${x.pages ? ` · ${x.pages} 页` : ''}</span></span>
    <span class="td-mat-actions"><a class="ap-more" href="${esc(x.url)}" target="_blank" rel="noopener">${x.external ? '原站' : '预览'}</a>
      ${x.external ? '' : `<button class="btn ${on ? 'btn-secondary' : 'btn-primary'} btn-sm" type="button" data-bag="${esc(x.id)}" aria-pressed="${on}">${on ? '✓ 已放入' : '放入资料袋'}</button>`}</span></li>`;
}

async function materialsModule(limit = 6) {
  const head = modHead('最新资料', '<a class="ap-more" href="materials.html">全部资料</a>');
  try {
    const { items } = await loadMaterials();
    homeMaterials = [...items].sort((a, b) => yearKey(b) - yearKey(a)).slice(0, limit);
    if (!homeMaterials.length) return `<section class="td-mod">${head}<div class="ap-empty"><b>资料库还是空的。</b><p>分享这门课的第一份资料。</p><a class="btn btn-primary btn-sm" href="materials.html?upload=1">上传资料</a></div></section>`;
    return `<section class="td-mod" aria-label="最新资料">${head}<ul class="ap-list">${homeMaterials.map(materialRow).join('')}</ul></section>`;
  } catch (e) {
    return `<section class="td-mod">${head}${modNote(`资料目录暂时读不到：${esc(e.message ?? '未知错误')}`)}</section>`;
  }
}

async function projectsModule(limit = 4) {
  const list = await load('projects');
  const head = modHead('开源推荐', '<a class="ap-more" href="discover.html">去开源广场</a>');
  if (!Array.isArray(list) || !list.length) return `<section class="td-mod">${head}${modNote('开源广场的目录没有加载出来。')}</section>`;
  return `<section class="td-mod" aria-label="开源推荐">${head}<div class="ap-list">${[...list]
    .sort((a, b) => (b.repo?.stars ?? 0) - (a.repo?.stars ?? 0))
    .slice(0, limit)
    .map((p) => {
      const href = st.online ? `project.html?slug=${encodeURIComponent(p.slug)}` : safeURL(p.links?.repo) ?? 'projects.html';
      return `<a class="ap-row td-proj" href="${esc(href)}"${/^https?:/.test(href) ? ' target="_blank" rel="noopener"' : ''}>${projectIcon(p)}
        <span class="ap-row-text"><b>${esc(p.title)}</b><span>${esc(p.summary)}</span></span>
        <span class="td-proj-meta num">${p.repo?.stars != null ? `★ ${fmtNum(p.repo.stars)}` : ''}</span></a>`;
    }).join('')}</div></section>`;
}

async function reviewsModule(limit = 3) {
  const head = modHead('最新评价', '<a class="ap-more" href="reputation.html">全部评价</a>');
  if (!st.online) return `<section class="td-mod">${head}${modNote('课程和教师的评价保存在社区服务里；现在是只读的静态页面。')}</section>`;
  const r = await load('reviews');
  const list = ok(r) ? (r.items ?? []).filter((x) => x.body).slice(0, limit) : [];
  if (!list.length) return `<section class="td-mod">${head}<div class="ap-empty"><b>${r?.error ? '评价暂时读不到。' : '还没有公开的文字评价。'}</b><p>${r?.error ? esc(r.error) : '上过的课、遇到的老师，写一句真话。'}</p><a class="btn btn-primary btn-sm" href="reputation.html">写评价</a></div></section>`;
  return `<section class="td-mod" aria-label="最新评价">${head}<div class="td-reviews">${list.map((x) => `<a class="ap-review" href="reputation.html">
    <span class="ap-review-head"><b>${esc(x.title || x.subject?.name || '一条评价')}</b><span>${x.created ? esc(timeAgo(x.created)) : ''}</span></span>
    ${x.rating ? `<span class="ap-review-stars" aria-label="${x.rating} 星">${'★'.repeat(Math.round(x.rating))}${'☆'.repeat(5 - Math.round(x.rating))}</span>` : ''}
    <p>${esc(x.body)}</p></a>`).join('')}</div></section>`;
}

async function contestsModule(limit = 5) {
  const d = await load('competitions');
  const list = (d?.competitions ?? []).slice(0, limit);
  const head = modHead('竞赛名录', '<button class="ap-more" type="button" data-go="chances">全部</button>');
  if (!list.length) return `<section class="td-mod">${head}${modNote('竞赛名录没有加载出来。')}</section>`;
  return `<section class="td-mod" aria-label="竞赛名录">${head}<div class="ap-list">${list.map((c) => {
    const url = safeURL(c.officialUrl);
    return `<a class="ap-row" href="${esc(url ?? '#chances')}"${url ? ' target="_blank" rel="noopener"' : ''}>${sym('trophy', CATEGORIES[c.category]?.hue ?? 215)}
      <span class="ap-row-text"><b>${esc(c.name)}</b><span>${esc(CATEGORIES[c.category]?.name ?? '')} · ${c.deadline ? `截止 ${esc(c.deadline)}` : '报名时间以官方通知为准'}</span></span>${CHEV}</a>`;
  }).join('')}</div>${modNote(`名录来自${esc(d.competitions[0]?.sourceTitle ?? '学校公开的学科竞赛名录')}，核对于 ${esc(d.checkedAt ?? '')}；不代表现在正在报名。`)}</section>`;
}

async function picksModules() {
  const parts = await Promise.all([todayHTML(), hotModule(), materialsModule(), projectsModule(), reviewsModule(), contestsModule()]);
  return `<div class="ap-wrap ap-wrap-text td-mods">${quickHTML()}${parts.join('')}</div>`;
}

// ---------- 各标签页 ----------

const TABS = {
  async picks() {
    return picksModules();
  },

  async following() {
    if (!st.online) return `${sec('关注')}${offline('你关注的话题、作者和项目')}`;
    if (!st.user)
      return `${sec('关注')}${quiet('登录以后，这里是你关注的话题、作者和项目的更新。没有关注任何东西时，“推荐”里照样有精选。', `<a class="btn btn-primary btn-sm" href="${esc(loginURL())}">登录</a>`)}`;
    const [feed, notes] = await Promise.all([load('following'), load('notices')]);
    const posts = feed?.error ? failed('关注的动态', feed.error)
      : (feed?.items ?? []).length
        ? feed.items.slice(0, 20).map((p) => `<a class="v3-post" href="${esc(postHref(p))}"><span class="v3-post-title">${esc(postTitle(p))}</span>
            <span class="v3-post-meta">${p.owner ? `<span>${esc(p.owner.name)}</span>` : ''}<span>回复 ${p.replies ?? 0}</span><span class="v3-lit">赞 ${p.likes ?? 0}</span><span>${timeAgo(p.updated)}</span></span></a>`).join('')
        : quiet('你还没有关注话题、吧或作者，或者他们最近没有新内容。');
    const updates = notes?.error ? failed('消息', notes.error)
      : (notes?.items ?? []).length
        ? `<ul class="td-updates" role="list">${notes.items.slice(0, 10).map((n) => `<li class="${n.read ? '' : 'is-unread'}"><p>${esc(n.text)}</p><span>${timeAgo(n.created)}</span></li>`).join('')}</ul>`
        : quiet('还没有消息。关注的项目发版、讨论被回复、投稿审核有结果时，会出现在这里。');
    return `${sec('关注的动态')}${posts}${sec('我的消息', { href: 'me.html#notices' })}${updates}`;
  },

  async hot() {
    return `${sec('校圈热榜')}${await hotList(20)}`;
  },

  async chances() {
    const site = await load('site');
    const exam = site?.nextExam;
    const days = exam?.date ? daysUntil(exam.date) : -1;
    const examRow = days >= 0
      ? `${sec('考试')}${grid([lockup({
          href: safeURL(exam.sourceUrl) ?? 'cet4.html',
          ext: Boolean(safeURL(exam.sourceUrl)),
          icon: `<span class="v3-icon as-icon" style="--h:24">${UI.study}</span>`,
          title: exam.label,
          sub: `${exam.date} · 还有 ${days} 天 · ${(exam.sessions ?? []).map((s) => `${s.exam} ${s.time}`).join('，')}`,
          pill: '官网',
        })], 'is-single')}<p class="v3-note">${esc(exam.source ?? '')}</p>`
      : '';
    return `${examRow}${sec('竞赛')}${await competitionShelf()}`;
  },
};

// ---------- 标签切换 ----------

const tabs = $('#td-tabs');
const bar = $('.v3-tabs-bar', tabs);
const moveBar = (b) => {
  bar.style.width = `${b.offsetWidth}px`;
  bar.style.transform = `translateX(${b.offsetLeft}px)`;
};

// 货架翻页按钮：一次翻一屏，到头时隐藏
function wireShelves(scope) {
  $$('.td-shelf-wrap', scope).forEach((wrap) => {
    const shelf = wrap.querySelector('.v3-shelf, .as-grid');
    const [prev, next] = $$('.td-paddle', wrap);
    if (!shelf || !prev) return;
    const sync = () => {
      prev.disabled = shelf.scrollLeft < 4;
      next.disabled = shelf.scrollLeft + shelf.clientWidth > shelf.scrollWidth - 4;
    };
    [prev, next].forEach((b) =>
      b.addEventListener('click', () => shelf.scrollBy({ left: Number(b.dataset.dir) * shelf.clientWidth * 0.9, behavior: reducedMotion() ? 'auto' : 'smooth' })),
    );
    shelf.addEventListener('scroll', sync, { passive: true });
    sync();
  });
}

const ORDER = ['picks', 'following', 'hot', 'chances'];
let serial = 0;
let entered = Promise.resolve();
async function show(tab) {
  const from = ORDER.indexOf(st.tab);
  st.tab = TABS[tab] ? tab : 'picks';
  const btn = $(`[data-tab="${st.tab}"]`, tabs);
  $$('[role="tab"]', tabs).forEach((b) => b.setAttribute('aria-selected', String(b === btn)));
  panel.setAttribute('aria-labelledby', btn.id);
  moveBar(btn);
  const mine = ++serial;
  panel.classList.add('is-busy');
  const html = await TABS[st.tab]().catch((e) => quiet(`没有加载出来：${esc(e.message ?? '未知错误')}`));
  if (mine !== serial) return;
  // 推荐是通栏大块；其他标签页是窄栏阅读
  panel.innerHTML = st.tab === 'picks' ? html : `<div class="ap-wrap ap-wrap-text td-plain">${html.replaceAll('<section ', '<section data-reveal ')}</div>`;
  panel.classList.remove('is-busy');
  mountArt(panel);
  $$('[data-kbd-mod]', panel).forEach((k) => (k.textContent = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K'));
  // 虎扑式左右切换：往右的标签从右边滑进来，往左的从左边
  const dir = Math.sign(ORDER.indexOf(st.tab) - from);
  if (dir) springTo(panel, [{ transform: `translateX(${dir * 36}px)`, opacity: 0 }, { transform: 'none', opacity: 1 }], { spring: 'snappy', fill: 'none' });
  wireShelves(panel);
  // 开场还没结束时先不播入场，等开场把页面“交”出来再一起升起
  entered.then(() => observeReveal(panel));
  history.replaceState(null, '', `${location.pathname}${location.search}${st.tab === 'picks' ? '' : '#'+st.tab}`);
}

tabs.addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]');
  if (b && b.dataset.tab !== st.tab) show(b.dataset.tab);
});
tabs.addEventListener('keydown', (e) => {
  if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
  const list = $$('[role="tab"]', tabs);
  const next = list[(list.indexOf(document.activeElement) + (e.key === 'ArrowRight' ? 1 : list.length - 1)) % list.length];
  next.focus();
  show(next.dataset.tab);
});
panel.addEventListener('click', (e) => {
  // 首页“最新资料”：和资料页共用一个资料袋
  const bagBtn = e.target.closest('[data-bag]');
  if (bagBtn) {
    const item = homeMaterials.find((x) => x.id === bagBtn.dataset.bag);
    if (!item) return;
    const r = toggleBag(item);
    if (r.full) bagBtn.textContent = '资料袋满了（30 份）';
    else bagBtn.closest('li').outerHTML = materialRow(item);
    const row = panel.querySelector('[data-bag-row]');
    if (row) {
      const [title, sub] = bagRowText(readBag().length);
      row.querySelector('b').textContent = title;
      row.querySelector('.ap-row-text span').textContent = sub;
    }
    return;
  }
  const go = e.target.closest('[data-go]');
  if (!go) return;
  show(go.dataset.go);
  tabs.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
});
addEventListener('resize', () => moveBar($('[aria-selected="true"]', tabs)));

// ---------- 启动 ----------

const d = new Date();
$('#td-date').textContent = `${d.getMonth() + 1}月${d.getDate()}日 星期${'日一二三四五六'[d.getDay()]}`;
const booting = hubState();
// Render editorial/news content without waiting for account and community services.
const heroReady = mountHero();
// 开场的进度条跟着首页真正要用的数据走
entered = playOpening([booting, load('site'), load('projects'), load('competitions'), load('featured'), load('cet4')]);
heroReady.then(c => { c.pause('opening', true); entered.then(() => c.pause('opening', false)); });
booting.then(async (s) => {
  st.online = s.online;
  st.user = s.user;
  show(location.hash.slice(1));
  // Hero mounts independently of session latency (see below).
});
