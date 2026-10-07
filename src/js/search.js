// 全站搜索（⌘K / Ctrl+K / “/”，以及各处的搜索框）：一个面板搜六个板块，结果按板块分组。
// - 本地索引（第一次打开时建立）：资料目录、四六级套卷、两个校区的楼、开源项目、成员、常用页面
// - 社区服务在线时，边打字边查：校圈帖子、同学标注的地点、教师和课程（都是服务端已经公开的内容）
// - 每组最后有“在板块里看全部”，把关键词带过去；实在找不到，就去知识库全文检索
// 只做匹配和跳转，不改任何数据；不向站外发请求。
import { load, esc } from './data.js';
import { loadCommunity } from './community.js';
import { CATEGORIES } from './schema.js';
import { loadMaterials } from './materials-catalog.js';
import { hubApi, hubState } from './hub.js';

const PAGES = [
  ['首页', './', '今日矿大：新闻、热帖、最新资料', 'home 主页 今日'],
  ['校园地图', 'map.html', '学院路、沙河 · 楼、课表、活动', 'map 地图 校园 课表 自习'],
  ['资料', 'materials.html', '试卷、答案、笔记 · 资料袋打包下载', 'materials 资料 试卷 期末 期中'],
  ['校圈', 'circle.html', '新闻、热议、各个吧', 'circle 校圈 论坛 贴吧 发帖'],
  ['口碑', 'reputation.html', '教师和课程的评价', 'reputation 口碑 评价 选课 老师'],
  ['开源广场', 'discover.html', '一屏一个项目', 'discover 开源 项目 github'],
  ['座位预约助手', 'reservations.html', '图书馆座位提醒与日历', 'reservations 预约 座位 图书馆'],
  ['个人中心', 'me.html', '投稿、收藏、通知、资料设置', 'me 我的 个人 账户'],
  ['知识库', 'knowledge.html', '课程资料全文检索', 'knowledge 检索 全文'],
];

// 板块：分组名 → [图标底色, “看全部”链接（拿关键词拼）]
const GROUPS = {
  页面: [220, null],
  资料: [28, (q) => `materials.html?q=${encodeURIComponent(q)}`],
  四六级: [212, null],
  校园: [150, (q) => `map.html?q=${encodeURIComponent(q)}`],
  校圈: [330, (q) => `circle.html?q=${encodeURIComponent(q)}`],
  口碑: [36, (q) => `reputation.html?q=${encodeURIComponent(q)}`],
  开源项目: [262, null],
  成员: [160, null],
};
const ORDER = Object.keys(GROUPS);
const CAMPUS = { xueyuanlu: '学院路', shahe: '沙河' };

let index = null;
async function buildIndex() {
  const [c4, c6, mats, comm, xy, sh] = await Promise.allSettled([
    load('cet4'), load('cet6'), loadMaterials(), loadCommunity(),
    fetch('data/campus-map/xueyuanlu.json').then((r) => r.json()),
    fetch('data/campus-map/shahe.json').then((r) => r.json()),
  ]);
  const items = PAGES.map(([title, href, sub, kw]) => ({ group: '页面', title, href, sub, kw, icon: '↗' }));
  if (mats.status === 'fulfilled')
    for (const x of mats.value.items)
      items.push({
        group: '资料', title: x.title, sub: [x.course, x.kind, x.year, x.pages && `${x.pages} 页`].filter(Boolean).join(' · '),
        href: `materials.html?q=${encodeURIComponent(x.title)}`, kw: `${x.course} ${x.kind} ${x.year ?? ''}`, icon: (x.format || '文').slice(0, 3).toUpperCase(),
      });
  for (const r of [c4, c6]) {
    if (r.status !== 'fulfilled') continue;
    const cat = r.value;
    for (const s of cat.sessions)
      for (const t of s.sets)
        items.push({
          group: '四六级', title: `${s.year} 年 ${s.month} 月 ${cat.short} ${t.label}`,
          sub: [t.listening ? '含听力' : '', Object.values(t.resources ?? {}).some(Boolean) ? '可下载' : '目录已排好'].filter(Boolean).join(' · '),
          href: `${cat.exam}.html#${t.id}`, kw: `${cat.exam} ${cat.name} ${s.year}${String(s.month).padStart(2, '0')}`, icon: cat.exam === 'cet4' ? '4' : '6',
        });
  }
  for (const [campus, r] of [['xueyuanlu', xy], ['shahe', sh]]) {
    if (r.status !== 'fulfilled') continue;
    for (const f of r.value.features ?? []) {
      if (f.properties.kind !== 'building' || !f.properties.name) continue;
      items.push({
        group: '校园', title: f.properties.name, sub: `${CAMPUS[campus]} · 楼`,
        href: `map.html?campus=${campus}&b=${encodeURIComponent(f.properties.osm)}`, kw: `${CAMPUS[campus]} ${f.properties.use ?? ''}`, icon: '楼',
      });
    }
  }
  if (comm.status === 'fulfilled') {
    for (const p of comm.value.projects)
      items.push({
        group: '开源项目', title: p.title, sub: `${CATEGORIES[p.category]?.name ?? ''} · ${p.origin === 'external' ? p.credit : '矿大同学'}`,
        href: p.links.repo || p.links.site, external: true, kw: `${p.summary} ${(p.tags ?? []).join(' ')} ${p.repo?.language ?? ''}`, icon: '◆',
      });
    for (const u of comm.value.people)
      items.push({
        group: '成员', title: u.name, sub: [u.login, u.major, u.grade && `${u.grade} 级`].filter(Boolean).join(' · '),
        href: `profile.html?u=${encodeURIComponent(u.login)}`, kw: `${u.login} ${u.bio ?? ''}`, icon: [...u.name][0],
      });
  }
  for (const it of items) it.hay = `${it.title} ${it.sub} ${it.kw ?? ''}`.toLowerCase();
  return items;
}

const tokensOf = (q) => q.toLowerCase().trim().replaceAll('线代', '线性代数').replaceAll('高数', '高等数学').replaceAll('大物', '大学物理').split(/\s+/).filter(Boolean);

function localSearch(items, q) {
  const tokens = tokensOf(q);
  if (!tokens.length) return items.filter((i) => i.group === '页面');
  const scored = [];
  for (const it of items) {
    if (it.group === '页面' && tokens.length > 1) continue;
    if (!tokens.every((t) => it.hay.includes(t))) continue;
    const title = it.title.toLowerCase();
    let score = 0;
    for (const t of tokens) score += title.startsWith(t) ? 30 : title.includes(t) ? 15 : 4;
    score -= it.title.length / 40;
    scored.push([score, it]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  return scored.map(([, it]) => it);
}

// 社区服务里的内容：边打字边查，同一个关键词只查一次
const remoteCache = new Map();
async function remoteSearch(q) {
  if (remoteCache.has(q)) return remoteCache.get(q);
  const job = (async () => {
    const out = [];
    const [posts, places, teachers, courses] = await Promise.allSettled([
      hubApi.circleFeed({ lane: 'latest', q }),
      hubApi.places({ q }),
      hubApi.teachers({ q }),
      hubApi.courses({ q }),
    ]);
    if (posts.status === 'fulfilled')
      for (const p of (posts.value.items ?? []).slice(0, 6))
        out.push({ group: '校圈', title: p.data?.title || (p.data?.body ?? '').slice(0, 40) || '一条动态', sub: `${p.owner?.name ?? '同学'} · 回复 ${p.replies ?? 0} · 赞 ${p.likes ?? 0}`, href: `circle.html?post=${encodeURIComponent(p.id)}`, icon: '帖' });
    if (places.status === 'fulfilled')
      for (const f of (places.value.features ?? []).slice(0, 6))
        out.push({ group: '校园', title: f.properties?.data?.title ?? '一个地点', sub: `${CAMPUS[f.properties?.campus] ?? ''} · 同学标注`, href: `map.html?place=${encodeURIComponent(f.id)}`, icon: '点' });
    if (teachers.status === 'fulfilled')
      for (const t of (teachers.value.items ?? []).slice(0, 4))
        out.push({ group: '口碑', title: t.name, sub: `${t.faculty || '学院待核'} · ${t.stats?.count ? `${t.stats.average.toFixed(1)} 分 · ${t.stats.count} 份评价` : '暂无评分'}`, href: `reputation.html?teacher=${encodeURIComponent(t.id)}`, icon: '师' });
    if (courses.status === 'fulfilled')
      for (const c of (courses.value.items ?? []).slice(0, 4))
        out.push({ group: '口碑', title: c.name, sub: `课程 · ${c.stats?.count ? `${c.stats.average.toFixed(1)} 分 · ${c.stats.count} 份评价` : '暂无评分'}`, href: `reputation.html?view=courses&course=${encodeURIComponent(c.id)}`, icon: '课' });
    return out;
  })().catch(() => []);
  remoteCache.set(q, job);
  return job;
}

// 合并、分组、每组最多 5 条；保持板块顺序
function arrange(list) {
  const per = new Map(ORDER.map((g) => [g, []]));
  for (const it of list) {
    const arr = per.get(it.group);
    if (arr && arr.length < 5 && !arr.some((x) => x.href === it.href)) arr.push(it);
  }
  return [...per.entries()].filter(([, arr]) => arr.length);
}

let dlg;
let online = null;
function ensureDialog() {
  if (dlg) return dlg;
  dlg = document.createElement('dialog');
  dlg.className = 'dlg glass spot';
  dlg.setAttribute('aria-label', '全站搜索');
  dlg.innerHTML = `
    <span class="spot-glow" aria-hidden="true"><i></i></span>
    <div class="spot-field">
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m20 20-4.8-4.8"/></svg>
      <input type="search" placeholder="搜索资料、帖子、楼、老师、项目…" aria-label="搜索" autocomplete="off" spellcheck="false" role="combobox" aria-expanded="true" aria-controls="spot-list">
      <span class="kbd">esc</span>
    </div>
    <ul class="spot-list" id="spot-list" role="listbox"></ul>
    <div class="spot-foot"><span><span class="kbd">↑</span> <span class="kbd">↓</span> 选择</span><span><span class="kbd">↵</span> 打开</span><span class="spot-hint">试试“线代 2023”“图书馆”“机械臂”</span></div>`;
  document.body.append(dlg);
  const input = dlg.querySelector('input');
  const list = dlg.querySelector('ul');
  let flat = [];
  let sel = 0;
  let remote = [];
  let remoteFor = '';
  let pending = false;
  let timer;

  const paint = () => {
    const q = input.value.trim();
    if (!index) {
      list.innerHTML = '<li class="spot-empty">正在建立索引…</li>';
      return;
    }
    const groups = arrange([...localSearch(index, q), ...(remoteFor === q ? remote : [])]);
    flat = groups.flatMap(([, arr]) => arr);
    sel = Math.min(sel, Math.max(0, flat.length - 1));
    if (!flat.length && !pending) {
      list.innerHTML = `<li class="spot-empty">没有找到“${esc(q)}”。<a href="knowledge.html?q=${encodeURIComponent(q)}">去知识库做全文检索 ›</a></li>`;
      return;
    }
    let i = 0;
    list.innerHTML = groups.map(([group, arr]) => {
      const [h, more] = GROUPS[group];
      const head = `<li class="spot-group" role="presentation"><span>${group}</span>${q && more ? `<a href="${esc(more(q))}" tabindex="-1">在${group}里看全部 ›</a>` : ''}</li>`;
      return head + arr.map((it) => {
        const id = i++;
        return `<li class="spot-item" role="option" id="spot-${id}" aria-selected="${id === sel}">
          <a href="${esc(it.href)}"${it.external ? ' target="_blank" rel="noopener"' : ''} tabindex="-1">
            <span class="spot-icon" style="--h:${h}">${esc(it.icon)}</span>
            <span class="spot-text"><span class="spot-title">${esc(it.title)}</span><span class="spot-sub">${esc(it.sub ?? '')}</span></span>
          </a></li>`;
      }).join('');
    }).join('')
      + (pending ? '<li class="spot-empty spot-pending">正在搜索校圈、地点和口碑…</li>' : '')
      + (q ? `<li class="spot-group" role="presentation"><span>全文检索</span></li><li class="spot-item spot-more"><a href="knowledge.html?q=${encodeURIComponent(q)}" tabindex="-1"><span class="spot-icon" style="--h:200">全</span><span class="spot-text"><span class="spot-title">在知识库里全文搜“${esc(q)}”</span><span class="spot-sub">试卷和讲义的正文，包括题目里的一句话</span></span></a></li>` : '');
    input.setAttribute('aria-activedescendant', `spot-${sel}`);
  };

  const queryRemote = () => {
    const q = input.value.trim();
    clearTimeout(timer);
    if (!q || !online) {
      pending = false;
      return;
    }
    pending = true;
    timer = setTimeout(async () => {
      const r = await remoteSearch(q);
      if (input.value.trim() !== q) return;
      remote = r;
      remoteFor = q;
      pending = false;
      paint();
    }, 220);
  };

  const move = (d) => {
    if (!flat.length) return;
    sel = (sel + d + flat.length) % flat.length;
    list.querySelectorAll('.spot-item[id]').forEach((li) => li.setAttribute('aria-selected', String(li.id === `spot-${sel}`)));
    list.querySelector(`#spot-${sel}`)?.scrollIntoView({ block: 'nearest' });
    input.setAttribute('aria-activedescendant', `spot-${sel}`);
  };

  input.addEventListener('input', () => {
    sel = 0;
    queryRemote();
    paint();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    if (e.key === 'Enter') {
      e.preventDefault();
      (list.querySelector(`#spot-${sel} a`) ?? list.querySelector('.spot-more a'))?.click();
      dlg.close();
    }
  });
  list.addEventListener('click', (e) => e.target.closest('a') && dlg.close());
  dlg.addEventListener('click', (e) => e.target === dlg && dlg.close()); // 点背景关闭
  dlg.paint = paint;
  return dlg;
}

export function openSearch(initial = '') {
  const d = ensureDialog();
  if (d.open) return;
  d.showModal();
  const input = d.querySelector('input');
  if (initial) input.value = initial;
  input.select();
  d.paint();
  if (online === null) hubState().then((s) => { online = s.online; });
  if (!index)
    buildIndex().then((items) => {
      index = items;
      d.paint();
    });
}
