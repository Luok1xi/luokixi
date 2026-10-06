import { initShell, observeReveal } from '../js/shell.js';
import { loadCommunity, avatarHTML, cfColor, CF_RANK_CN, projectCard, seriesSum, fmtNum } from '../js/community.js';
import { renderGrid } from '../js/heatmap.js';
import { esc } from '../js/data.js';
import '../styles/community.css';

initShell();

const $ = (s, r = document) => r.querySelector(s);
const login = new URLSearchParams(location.search).get('u') ?? '';
const main = $('#main');

const LINK_LABEL = { blog: '博客', bilibili: '哔哩哔哩', site: '个人网站', zhihu: '知乎' };

function notFound() {
  main.innerHTML = `<div class="empty-card pf-missing">
    <p class="empty-title">没有找到 ${login ? `“${esc(login)}”` : '这位成员'}。</p>
    <p>名录只收录本人自愿登记的同学。如果这是你，可以现在加入。</p>
    <div class="btn-group"><a class="btn btn-primary" href="contribute.html#people">加入名录</a><a class="btn btn-outline" href="community.html">回到社区</a></div>
  </div>`;
}

function ojCards(p) {
  const out = [];
  const lg = p.oj.luogu;
  if (lg && !lg.error)
    out.push(`<article class="card oj-card" data-reveal>
      <header><span class="oj-logo" style="--h:200">洛</span><a href="https://www.luogu.com.cn/user/${lg.uid}" target="_blank" rel="noopener">洛谷 · ${esc(lg.name)}</a></header>
      <p class="oj-big num">${lg.passed ?? '—'}<small>${lg.passed == null ? '练习情况未公开' : '道通过'}</small></p>
      <div class="oj-tags">${lg.ccfLevel ? `<span class="tag tag-accent">CCF ${lg.ccfLevel} 级</span>` : ''}${(lg.prizes ?? [])
        .map((z) => `<span class="tag">${z.year} ${esc(z.contest)} ${esc(z.prize)}</span>`)
        .join('')}</div>
      ${lg.stale ? '<p class="oj-stale">本次同步失败，显示的是上一次的数据</p>' : ''}
    </article>`);
  const lc = p.oj.leetcode;
  if (lc && !lc.error) {
    const s = lc.solved;
    const bar = (label, n, c) => `<div class="lc-row"><span>${label}</span><span class="lc-track"><i style="--w:${s.total ? n / s.total : 0};--c:${c}"></i></span><span class="num">${n}</span></div>`;
    out.push(`<article class="card oj-card" data-reveal>
      <header><span class="oj-logo" style="--h:36">扣</span><a href="https://leetcode.cn/u/${encodeURIComponent(lc.slug)}/" target="_blank" rel="noopener">力扣 · ${esc(lc.name)}</a></header>
      <p class="oj-big num">${s.total}<small>道题</small></p>
      ${bar('简单', s.easy, '#00af9b')}${bar('中等', s.medium, '#ffb800')}${bar('困难', s.hard, '#ff2d55')}
      ${lc.stale ? '<p class="oj-stale">本次同步失败，显示的是上一次的数据</p>' : ''}
    </article>`);
  }
  const cf = p.oj.codeforces;
  if (cf && !cf.error)
    out.push(`<article class="card oj-card" data-reveal>
      <header><span class="oj-logo" style="--h:0">CF</span><a href="https://codeforces.com/profile/${encodeURIComponent(cf.handle)}" target="_blank" rel="noopener">Codeforces · ${esc(cf.handle)}</a></header>
      <p class="oj-big num" style="color:${cfColor(cf.rating)}">${cf.rating ?? '—'}<small>${cf.rank ? esc(CF_RANK_CN[cf.rank] ?? cf.rank) : '暂无分数'}</small></p>
      <p class="muted">历史最高 <span class="num" style="color:${cfColor(cf.maxRating)}">${cf.maxRating ?? '—'}</span> · 解出 <span class="num">${cf.solved}</span> 题</p>
      ${cf.stale ? '<p class="oj-stale">本次同步失败，显示的是上一次的数据</p>' : ''}
    </article>`);
  return out.join('');
}

function render(data, p) {
  document.title = `${p.name} · Luokixi`;
  const code = p.series.code;
  const oj = p.series.oj;
  const all = code.map((n, i) => n + (oj[i] ?? 0));
  const links = [
    `<a href="https://github.com/${encodeURIComponent(p.login)}" target="_blank" rel="noopener">GitHub</a>`,
    ...Object.entries(p.links ?? {}).map(([k, u]) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(LINK_LABEL[k] ?? k)}</a>`),
  ].join('');
  const mine = data.projects.filter((x) => (x.authors ?? []).includes(p.login));
  const tiles = [
    [seriesSum(all), '次活动 · 过去一年'],
    [p.totals.code, p.githubCalendar ? '次 GitHub 贡献' : '次本站提交'],
    [p.oj.luogu?.passed ?? '—', '洛谷通过'],
    [p.oj.leetcode?.solved?.total ?? '—', '力扣解题'],
  ];
  main.innerHTML = `
    <aside class="pf-side" data-reveal>
      ${avatarHTML(p, 220)}
      <h1 class="pf-name">${esc(p.name)}</h1>
      <p class="pf-login">@${esc(p.login)}</p>
      ${p.bio ? `<p class="pf-bio">${esc(p.bio)}</p>` : ''}
      <ul class="pf-facts" role="list">
        <li>中国矿业大学（北京）</li>
        ${p.major ? `<li>${esc(p.major)}</li>` : ''}
        ${p.grade ? `<li>${p.grade} 级</li>` : ''}
      </ul>
      <nav class="pf-links" aria-label="外部主页">${links}</nav>
    </aside>
    <div class="pf-main">
      <dl class="stat-row pf-tiles" data-reveal>${tiles.map(([n, l]) => `<div><dt>${l}</dt><dd class="num">${typeof n === 'number' ? fmtNum(n) : n}</dd></div>`).join('')}</dl>
      <section class="card pf-heat" data-reveal>
        <header class="pf-heat-head">
          <h2>过去一年</h2>
          <div class="segmented" role="group" aria-label="热力图数据">
            <button type="button" data-s="all" aria-pressed="true">全部</button>
            <button type="button" data-s="code" aria-pressed="false">写代码</button>
            <button type="button" data-s="oj" aria-pressed="false">刷题</button>
          </div>
        </header>
        <div id="pf-grid"></div>
      </section>
      <div class="oj-grid">${ojCards(p) || '<p class="muted">还没有登记刷题平台账号。</p>'}</div>
      <section class="pf-projects">
        <h2 class="pf-h2">项目</h2>
        ${mine.length ? `<div class="pj-grid">${mine.map((x) => projectCard(x, data.people)).join('')}</div>` : '<p class="muted">还没有发布项目。<a href="contribute.html#project">发布一个</a></p>'}
      </section>
    </div>`;
  const series = { all, code, oj };
  const draw = (k) => renderGrid($('#pf-grid'), { start: data.range.start, counts: series[k], label: `${p.name} 的活动` });
  draw('all');
  main.querySelector('.pf-heat-head').addEventListener('click', (e) => {
    const b = e.target.closest('[data-s]');
    if (!b) return;
    main.querySelectorAll('[data-s]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    draw(b.dataset.s);
  });
  observeReveal(main);
}

loadCommunity()
  .then((data) => {
    const p = data.people.find((x) => x.login.toLowerCase() === login.toLowerCase());
    if (!p) return notFound();
    render(data, p);
  })
  .catch((err) => {
    console.error('[luokixi] 成员数据加载失败', err);
    main.innerHTML = '<p class="notice">成员数据暂时加载不出来，请稍后刷新。</p>';
  });
