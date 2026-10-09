// 全站搜索的数据层：一个索引搜六个板块，结果按板块分组。界面在 spotlight.js（⌘K / Ctrl+K / “/”，以及各处的搜索框）。
// - 本地索引（第一次打开时建立）：资料目录、四六级套卷、两个校区的楼、开源项目、成员、常用页面
// - 社区服务在线时，边打字边查：校圈帖子、同学标注的地点、教师和课程（都是服务端已经公开的内容）
// - 每组最后有“在板块里看全部”，把关键词带过去；实在找不到，就去学习搜索
// 每条结果带着原始记录 raw，预览面板直接用；只做匹配和跳转，不改任何数据；不向站外发请求。
import { load } from './data.js';
import { loadCommunity } from './community.js';
import { CATEGORIES } from './schema.js';
import { loadMaterials } from './materials-catalog.js';
import { hubApi } from './hub.js';
import { fuzzySearch, searchTokens } from './fuzzy-search.js';

export const PAGES = [
  ['课程资料与经验', 'search.html', '课程、资料、问答与同学经验', '学习 课程 线代 高数 搜索'],
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
export const GROUPS = {
  页面: [220, null],
  资料: [28, (q) => `search.html?type=resources&q=${encodeURIComponent(q)}`],
  四六级: [212, null],
  校园: [150, (q) => `map.html?q=${encodeURIComponent(q)}`],
  校圈: [330, (q) => `circle.html?q=${encodeURIComponent(q)}`],
  口碑: [36, (q) => `reputation.html?q=${encodeURIComponent(q)}`],
  开源项目: [262, (q) => `discover.html?q=${encodeURIComponent(q)}`],
  成员: [160, null],
};
export const ORDER = Object.keys(GROUPS);
export const CAMPUS = { xueyuanlu: '学院路', shahe: '沙河' };

const pageItems = () => PAGES.map(([title, href, sub, kw]) => ({ group: '页面', title, href, sub, kw, icon: '↗' }));

export async function buildIndex() {
  const [c4, c6, mats, comm, xy, sh] = await Promise.allSettled([
    load('cet4'), load('cet6'), loadMaterials(), loadCommunity(),
    fetch('data/campus-map/xueyuanlu.json').then((r) => r.json()),
    fetch('data/campus-map/shahe.json').then((r) => r.json()),
  ]);
  const items = pageItems();
  if (mats.status === 'fulfilled')
    for (const x of mats.value.items)
      items.push({
        group: '资料', title: x.title, sub: [x.course, x.kind, x.year, x.pages && `${x.pages} 页`].filter(Boolean).join(' · '),
        href: `materials.html?q=${encodeURIComponent(x.title)}`, kw: `${x.course} ${x.kind} ${x.year ?? ''}`, icon: (x.format || '文').slice(0, 3).toUpperCase(), raw: x,
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
          raw: { exam: cat.exam, name: cat.name, year: s.year, month: s.month, set: t },
        });
  }
  for (const [campus, r] of [['xueyuanlu', xy], ['shahe', sh]]) {
    if (r.status !== 'fulfilled') continue;
    for (const f of r.value.features ?? []) {
      if (f.properties.kind !== 'building' || !f.properties.name) continue;
      items.push({
        group: '校园', title: f.properties.name, sub: `${CAMPUS[campus]} · 楼`,
        href: `map.html?campus=${campus}&b=${encodeURIComponent(f.properties.osm)}`, kw: `${CAMPUS[campus]} ${f.properties.use ?? ''}`, icon: '楼',
        raw: { campus, feature: f },
      });
    }
  }
  if (comm.status === 'fulfilled') {
    for (const p of comm.value.projects)
      items.push({
        group: '开源项目', title: p.title, sub: `${CATEGORIES[p.category]?.name ?? ''} · ${p.origin === 'external' ? p.credit : '矿大同学'}`,
        href: `discover.html?project=${encodeURIComponent(p.repo?.fullName || p.slug || p.title)}`, kw: `${p.summary} ${(p.tags ?? []).join(' ')} ${p.repo?.language ?? ''}`, icon: '◆', raw: p,
      });
    for (const u of comm.value.people)
      items.push({
        group: '成员', title: u.name, sub: [u.login, u.major, u.grade && `${u.grade} 级`].filter(Boolean).join(' · '),
        href: `profile.html?u=${encodeURIComponent(u.login)}`, kw: `${u.login} ${u.bio ?? ''}`, icon: [...u.name][0], raw: u,
      });
  }
  for (const it of items) it.hay = `${it.title} ${it.sub} ${it.kw ?? ''}`.toLowerCase();
  return items;
}

// 索引建不起来时，至少能搜常用页面
export const fallbackIndex = pageItems;

export function localSearch(items, q, limit = 160) {
  if (!q.trim()) return items.filter((item) => item.group === '页面');
  return fuzzySearch(items, q, { limit });
}

// 社区服务里的内容：边打字边查，同一个关键词只查一次
const remoteCache = new Map();
export async function remoteSearch(q) {
  q = searchTokens(q).join(' ');
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
        out.push({ group: '校圈', title: p.data?.title || (p.data?.body ?? '').slice(0, 40) || '一条动态', sub: `${p.owner?.name ?? '同学'} · 回复 ${p.replies ?? 0} · 赞 ${p.likes ?? 0}`, href: `circle.html?post=${encodeURIComponent(p.id)}`, icon: '帖', raw: p });
    if (places.status === 'fulfilled')
      for (const f of (places.value.features ?? []).slice(0, 6))
        out.push({ group: '校园', title: f.properties?.data?.title ?? '一个地点', sub: `${CAMPUS[f.properties?.campus] ?? ''} · 同学标注`, href: `map.html?place=${encodeURIComponent(f.id)}`, icon: '点', raw: { campus: f.properties?.campus, place: f } });
    if (teachers.status === 'fulfilled')
      for (const t of (teachers.value.items ?? []).slice(0, 4))
        out.push({ group: '口碑', title: t.name, sub: `${t.faculty || '学院待核'} · ${t.stats?.count ? `${t.stats.average.toFixed(1)} 分 · ${t.stats.count} 份评价` : '暂无评分'}`, href: `reputation.html?teacher=${encodeURIComponent(t.id)}`, icon: '师', raw: { teacher: t } });
    if (courses.status === 'fulfilled')
      for (const c of (courses.value.items ?? []).slice(0, 4))
        out.push({ group: '口碑', title: c.name, sub: `课程 · ${c.stats?.count ? `${c.stats.average.toFixed(1)} 分 · ${c.stats.count} 份评价` : '暂无评分'}`, href: `reputation.html?view=courses&course=${encodeURIComponent(c.id)}`, icon: '课', raw: { course: c } });
    return out;
  })().catch(() => []);
  if (remoteCache.size >= 48) remoteCache.delete(remoteCache.keys().next().value);
  remoteCache.set(q, job);
  return job;
}

// 合并、分组、每组最多 per 条；保持板块顺序
export function arrange(list, per = 5) {
  const groups = new Map(ORDER.map((g) => [g, []]));
  for (const it of list) {
    const arr = groups.get(it.group);
    if (arr && arr.length < per && !arr.some((x) => x.href === it.href)) arr.push(it);
  }
  return [...groups.entries()].filter(([, arr]) => arr.length);
}
