// 全站搜索（⌘K / Ctrl+K / “/”）：真题套卷、校内试卷、开源项目、成员、页面。
// 第一次打开时才加载数据；纯前端匹配，不发任何外部请求。
import { load, esc } from './data.js';
import { loadCommunity } from './community.js';
import { CATEGORIES } from './schema.js';

const PAGES = [
  ['首页', './', '回到 Luokixi 首页', 'home 主页'],
  ['四级真题', 'cet4.html', '2019 – 2026 年 CET-4', 'cet4 cet-4 四级 英语'],
  ['六级真题', 'cet6.html', '2019 – 2026 年 CET-6', 'cet6 cet-6 六级 英语'],
  ['矿大资料', 'school.html', '高数、线代历年试卷', '校内 期中 期末 school'],
  ['知识库', 'knowledge.html', '全校课程资料检索', 'knowledge 检索 搜索'],
  ['开源广场', 'projects.html', '机电、嵌入式、软件、算法项目', 'projects 开源 项目 github'],
  ['社区', 'community.html', '贡献热力图与刷题榜', 'community 洛谷 力扣 codeforces 刷题 贡献'],
  ['参与贡献', 'contribute.html', '发布项目、投稿资料、加入名录', 'contribute 投稿 上传 提交 pr'],
];

let index = null;
async function buildIndex() {
  const [c4, c6, school, comm] = await Promise.allSettled([load('cet4'), load('cet6'), load('school'), loadCommunity()]);
  const items = PAGES.map(([title, href, sub, kw]) => ({ group: '页面', title, href, sub, kw, icon: '↗', h: 220 }));
  for (const r of [c4, c6]) {
    if (r.status !== 'fulfilled') continue;
    const cat = r.value;
    for (const s of cat.sessions)
      for (const t of s.sets)
        items.push({
          group: '真题', title: `${s.year} 年 ${s.month} 月 ${cat.short} ${t.label}`,
          sub: [t.listening ? '含听力' : '', Object.values(t.resources ?? {}).some(Boolean) ? '可下载' : '资源接入中'].filter(Boolean).join(' · '),
          href: `${cat.exam}.html#${t.id}`, kw: `${cat.exam} ${cat.name} ${s.year}${String(s.month).padStart(2, '0')}`,
          icon: cat.exam === 'cet4' ? '4' : '6', h: cat.exam === 'cet4' ? 210 : 265,
        });
  }
  if (school.status === 'fulfilled') {
    const sc = school.value;
    for (const p of sc.papers) {
      const course = sc.courses.find((c) => c.id === p.course);
      items.push({
        group: '矿大资料', title: `${course?.name ?? ''} · ${p.year} · ${p.kind}`,
        sub: `${p.stage}${p.hasAnswers ? ' · 含答案' : ''}${p.scanned ? ' · 扫描件' : ''}`,
        href: `school.html#${p.course}`, kw: `${p.stage} 试卷`, icon: '∫', h: 290,
      });
    }
  }
  if (comm.status === 'fulfilled') {
    for (const p of comm.value.projects)
      items.push({
        group: '开源项目', title: p.title, sub: `${CATEGORIES[p.category]?.name ?? ''} · ${p.origin === 'external' ? esc(p.credit) : '矿大同学'}`,
        href: p.links.repo || p.links.site, external: true, kw: `${p.summary} ${(p.tags ?? []).join(' ')} ${p.repo?.language ?? ''}`,
        icon: '◆', h: CATEGORIES[p.category]?.hue ?? 220,
      });
    for (const u of comm.value.people)
      items.push({
        group: '成员', title: u.name, sub: [u.login, u.major, u.grade && `${u.grade} 级`].filter(Boolean).join(' · '),
        href: `profile.html?u=${encodeURIComponent(u.login)}`, kw: `${u.login} ${u.bio ?? ''}`, icon: [...u.name][0], h: 160,
      });
  }
  for (const it of items) it.hay = `${it.title} ${it.sub} ${it.kw ?? ''}`.toLowerCase();
  return items;
}

function search(items, q) {
  const tokens = q.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return items.filter((i) => i.group === '页面');
  const scored = [];
  for (const it of items) {
    if (!tokens.every((t) => it.hay.includes(t))) continue;
    const title = it.title.toLowerCase();
    let score = 0;
    for (const t of tokens) score += title.startsWith(t) ? 30 : title.includes(t) ? 15 : 4;
    score -= it.title.length / 40;
    scored.push([score, it]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  // 每组最多 6 条，保持分组顺序
  const per = new Map();
  for (const [, it] of scored) {
    const arr = per.get(it.group) ?? [];
    if (arr.length < 6) arr.push(it);
    per.set(it.group, arr);
  }
  return [...per.values()].flat();
}

let dlg;
function ensureDialog() {
  if (dlg) return dlg;
  dlg = document.createElement('dialog');
  dlg.className = 'dlg glass spot';
  dlg.setAttribute('aria-label', '全站搜索');
  dlg.innerHTML = `
    <div class="spot-field">
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m20 20-4.8-4.8"/></svg>
      <input type="search" placeholder="搜索真题、试卷、项目、同学…" aria-label="搜索" autocomplete="off" spellcheck="false" role="combobox" aria-expanded="true" aria-controls="spot-list">
      <span class="kbd">esc</span>
    </div>
    <ul class="spot-list" id="spot-list" role="listbox"></ul>
    <div class="spot-foot"><span><span class="kbd">↑</span> <span class="kbd">↓</span> 选择</span><span><span class="kbd">↵</span> 打开</span><span>试试“2025 四级”或“机械臂”</span></div>`;
  document.body.append(dlg);
  const input = dlg.querySelector('input');
  const list = dlg.querySelector('ul');
  let results = [];
  let sel = 0;

  const paint = () => {
    if (!index) {
      list.innerHTML = '<li class="spot-empty">正在建立索引…</li>';
      return;
    }
    results = search(index, input.value);
    sel = Math.min(sel, Math.max(0, results.length - 1));
    if (!results.length) {
      list.innerHTML = `<li class="spot-empty">没有找到“${esc(input.value)}”。可以换个关键词，或者去<a href="knowledge.html">知识库</a>做全文检索。</li>`;
      return;
    }
    let group = '';
    list.innerHTML = results
      .map((it, i) => {
        const head = it.group !== group ? `<li class="spot-group" role="presentation">${(group = it.group)}</li>` : '';
        return `${head}<li class="spot-item" role="option" id="spot-${i}" aria-selected="${i === sel}">
          <a href="${esc(it.href)}"${it.external ? ' target="_blank" rel="noopener"' : ''} tabindex="-1">
            <span class="spot-icon" style="--h:${it.h}">${esc(it.icon)}</span>
            <span class="spot-text"><span class="spot-title">${esc(it.title)}</span><span class="spot-sub">${esc(it.sub ?? '')}</span></span>
          </a></li>`;
      })
      .join('');
    input.setAttribute('aria-activedescendant', `spot-${sel}`);
  };

  const move = (d) => {
    if (!results.length) return;
    sel = (sel + d + results.length) % results.length;
    list.querySelectorAll('.spot-item').forEach((li, i) => li.setAttribute('aria-selected', String(i === sel)));
    list.querySelector(`#spot-${sel}`)?.scrollIntoView({ block: 'nearest' });
    input.setAttribute('aria-activedescendant', `spot-${sel}`);
  };

  input.addEventListener('input', () => {
    sel = 0;
    paint();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    if (e.key === 'Enter') {
      e.preventDefault();
      list.querySelector(`#spot-${sel} a`)?.click();
      dlg.close();
    }
  });
  list.addEventListener('click', (e) => e.target.closest('a') && dlg.close());
  dlg.addEventListener('click', (e) => e.target === dlg && dlg.close()); // 点背景关闭
  dlg.paint = paint;
  return dlg;
}

export function openSearch() {
  const d = ensureDialog();
  if (d.open) return;
  d.showModal();
  const input = d.querySelector('input');
  input.select();
  d.paint();
  if (!index)
    buildIndex().then((items) => {
      index = items;
      d.paint();
    });
}
