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
import { openStory } from '../js/story.js';
import { mountCarousel } from '../js/carousel.js';
import { animate as springTo } from '../js/motion.js';
import '../styles/v3.css';
import '../styles/today.css';
import '../styles/app-store.css';

initShell();

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const panel = $('#td-panel');
const heroEl = $('#td-hero');
const safeURL = (u) => (typeof u === 'string' && /^https?:\/\//.test(u) ? u : null);
const json = (path) => fetch(path, { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
const ok = (d) => d && !d.error;

const st = { tab: 'picks', online: false, user: null };

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
    return (d?.items ?? []).filter((x) => x?.title && (!x.startsAt || Date.parse(x.startsAt) <= now) && (!x.expiresAt || Date.parse(x.expiresAt) > now));
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
  const ext = /^https?:/.test(primary.href) ? ' target="_blank" rel="noopener"' : '';
  return `<article class="hc-slide" aria-roledescription="slide" data-id="${esc(id)}">
    <div class="hc-card" ${story ? `data-story="${esc(id)}"` : ''} style="--hc-bg:${bg}">
      <div class="hc-media"${art ? ` data-art="${esc(art)}"` : ''}>${media ? `<img class="art-img" src="${esc(media.src)}" alt="${esc(media.alt ?? '')}" loading="lazy">` : ''}</div>
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

// ---------- 各标签页 ----------

const TABS = {
  async picks() {
    const [hot, comps, reviews, projects] = await Promise.all([hotShelf(), competitionShelf(9), reviewShelf(), projectShelf()]);
    return `<a class="editorial-feature" href="discover.html"><div><span>让想法发生</span><h2>从一个小项目，<br>开始你的创造。</h2><p>发现工具、认识创作者，把好奇心变成作品。</p><b>逛逛开源广场 ↗</b></div><img src="art/community-engineering.webp" loading="lazy" alt="原创工程创作主题插画"></a><section aria-label="校圈热帖">${sec('校圈热帖', { go: 'hot' })}${hot}</section>
      <section aria-label="开源推荐">${sec('开源推荐', { href: 'discover.html' })}${projects}</section>
      <section aria-label="竞赛与机会">${sec('竞赛与机会', { go: 'chances' })}${comps}</section>
      <section aria-label="评分及评论">${sec('评分及评论', { href: 'reputation.html' })}${reviews}</section>
      <section aria-label="校园">${sec('校园', { href: 'map.html' })}${campusTiles()}</section>`;
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
  panel.innerHTML = html.replaceAll('<section ', '<section data-reveal ');
  panel.classList.remove('is-busy');
  // 虎扑式左右切换：往右的标签从右边滑进来，往左的从左边
  const dir = Math.sign(ORDER.indexOf(st.tab) - from);
  if (dir) springTo(panel, [{ transform: `translateX(${dir * 36}px)`, opacity: 0 }, { transform: 'none', opacity: 1 }], { spring: 'snappy', fill: 'none' });
  wireShelves(panel);
  // 开场还没结束时先不播入场，等开场把页面“交”出来再一起升起
  entered.then(() => observeReveal(panel));
  history.replaceState(null, '', st.tab === 'picks' ? location.pathname : `${location.pathname}#${st.tab}`);
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
heroReady.then(c => entered.then(first => { if (first) c.enter(); }));
booting.then(async (s) => {
  st.online = s.online;
  st.user = s.user;
  show(location.hash.slice(1));
  // Hero mounts independently of session latency (see below).
});
