import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { initShell, observeReveal, observeLive, reducedMotion } from '../js/shell.js';
import { loadCommunity, communitySeries, seriesSum, avatarHTML, cfColor, CF_RANK_CN, fmtNum } from '../js/community.js';
import { mountCity, renderGrid } from '../js/heatmap.js';
import { coverMediaHTML as coverSVG } from '../js/cover.js';
import { esc } from '../js/data.js';
import '../styles/community.css';

gsap.registerPlugin(ScrollTrigger);
initShell();

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const solvedOf = (p) => ({
  luogu: p.oj.luogu?.passed ?? 0,
  leetcode: p.oj.leetcode?.solved?.total ?? 0,
  codeforces: p.oj.codeforces?.solved ?? 0,
});
const totalSolved = (p) => Object.values(solvedOf(p)).reduce((a, b) => a + b, 0);

function longestStreak(counts) {
  let best = 0;
  let run = 0;
  for (const n of counts) {
    run = n > 0 ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return best;
}

function heroStats(data, series) {
  const solved = data.people.reduce((a, p) => a + totalSolved(p), 0);
  const site = seriesSum(data.site.series);
  const practice = data.people.reduce((a, p) => a + seriesSum(p.series?.oj), 0);
  // 口径说明：这里是“学习与共建活跃”，不是 GitHub 贡献图，也不是 Codex 工作台里的“收录事件”
  $('#city-legend').textContent = `过去一年：本站提交 ${fmtNum(site)} 次 · 成员刷题 ${fmtNum(practice)} 次`;
  $('#cm-stats').innerHTML = [
    [fmtNum(seriesSum(series.counts)), '次学习与共建 · 过去一年'],
    [data.people.length, '位成员'],
    [fmtNum(solved), '道题 · 累计解出'],
    [longestStreak(series.counts), '天 · 最长连续'],
  ]
    .map(([n, l]) => `<div><dt>${l}</dt><dd class="num">${n}</dd></div>`)
    .join('');
}

// ---------- 刷题榜 ----------

const SORTS = {
  total: (p) => totalSolved(p),
  luogu: (p) => p.oj.luogu?.passed ?? -1,
  leetcode: (p) => p.oj.leetcode?.solved?.total ?? -1,
  codeforces: (p) => p.oj.codeforces?.rating ?? -1,
};

function lcBar(s) {
  if (!s) return '';
  const t = Math.max(1, s.total);
  return `<span class="lc-bar" title="简单 ${s.easy} · 中等 ${s.medium} · 困难 ${s.hard}">
    <i style="--w:${s.easy / t};--c:#00af9b"></i><i style="--w:${s.medium / t};--c:#ffb800"></i><i style="--w:${s.hard / t};--c:#ff2d55"></i></span>`;
}

function row(p, rank) {
  const lg = p.oj.luogu;
  const lc = p.oj.leetcode;
  const cf = p.oj.codeforces;
  const cell = (label, value, extra = '', missing = '未登记') =>
    `<div class="b-cell"><span class="b-label">${label}</span><span class="b-value num">${value ?? `<span class="muted">${missing}</span>`}</span>${extra}</div>`;
  return `<li class="card card-hover board-row" data-reveal>
    <a href="profile.html?u=${encodeURIComponent(p.login)}" class="board-link" aria-label="${esc(p.name)} 的主页"></a>
    <span class="b-rank num${rank <= 3 ? ` top${rank}` : ''}">${rank}</span>
    ${avatarHTML(p, 48)}
    <div class="b-who"><span class="b-name">${esc(p.name)}</span><span class="b-meta">${[p.major, p.grade && `${p.grade} 级`].filter(Boolean).map(esc).join(' · ') || `@${esc(p.login)}`}</span></div>
    ${cell('洛谷', lg ? (lg.passed ?? '未公开') : null, lg?.ccfLevel ? `<span class="tag">CCF ${lg.ccfLevel} 级</span>` : '')}
    ${cell('力扣', lc?.solved?.total ?? null, lcBar(lc?.solved))}
    ${cell('Codeforces', cf?.rating != null ? `<span style="color:${cfColor(cf.rating)}">${cf.rating}</span>` : cf ? '无分数' : null, cf?.rank ? `<span class="b-sub">${esc(CF_RANK_CN[cf.rank] ?? cf.rank)}</span>` : '')}
  </li>`;
}

// 名录为空时：展示布局示意（明确标注为示例），不编造任何真实数据
function boardEmpty() {
  const ghost = [1, 2, 3]
    .map(
      (i) => `<li class="card board-row is-ghost" aria-hidden="true">
        <span class="b-rank num">${i}</span><span class="avatar" style="--size:48px"></span>
        <div class="b-who"><span class="ghost-bar" style="width:${90 - i * 12}px"></span><span class="ghost-bar thin" style="width:${130 - i * 10}px"></span></div>
        ${'<div class="b-cell"><span class="ghost-bar thin" style="width:40px"></span><span class="ghost-bar" style="width:56px"></span></div>'.repeat(3)}
      </li>`,
    )
    .join('');
  return `${ghost}<li class="board-empty"><p class="empty-title">名录还是空的。</p><p>上面只是布局示意。登记账号后，你会是这张榜的第一位。</p><a class="btn btn-primary" href="contribute.html#people">加入名录</a></li>`;
}

function board(data, key = 'total') {
  const el = $('#board-list');
  if (!data.people.length) {
    el.innerHTML = boardEmpty();
    el.classList.add('is-empty');
    return;
  }
  const list = [...data.people].sort((a, b) => SORTS[key](b) - SORTS[key](a));
  el.innerHTML = list.map((p, i) => row(p, i + 1)).join('');
  observeReveal(el);
}

function wireBoard(data) {
  $('#board-sort').addEventListener('click', (e) => {
    const b = e.target.closest('[data-sort]');
    if (!b) return;
    $$('[data-sort]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    board(data, b.dataset.sort);
  });
}

// ---------- 贡献者 ----------

function contributors(data) {
  const list = data.site.contributors;
  const el = $('#contrib-wall');
  if (!list.length) {
    el.innerHTML = `<div class="empty-card"><p class="empty-title">第一位贡献者的位置，还空着。</p><p>改一个错别字、补一份试卷、提交一个项目，都算贡献。</p><a class="btn btn-primary" href="contribute.html">开始贡献</a></div>`;
    return;
  }
  el.innerHTML = list
    .map((c) => {
      const inner = `${avatarHTML(c, 64)}<span class="cw-name">${esc(c.name)}</span><span class="cw-n num">${c.commits} 次提交</span>`;
      return c.member
        ? `<a class="cw" href="profile.html?u=${encodeURIComponent(c.login)}" data-reveal>${inner}</a>`
        : `<div class="cw" data-reveal>${inner}</div>`;
    })
    .join('');
  observeReveal(el);
}

// ---------- 推广卡片 ----------

function promos(data, series) {
  renderGrid($('#promo-heat'), { ...series, label: '社区贡献' });
  const picks = data.projects.slice(0, 3);
  $('#promo-fan').innerHTML = picks.map((p, i) => `<div class="fan-card" style="--i:${i}">${coverSVG(p)}</div>`).join('');
}

// ---------- 城市随滚动由俯视转为平视 ----------

function tilt() {
  if (reducedMotion()) return;
  gsap.fromTo(
    '#city',
    { rotationX: 38, scale: 0.92, transformPerspective: 1400 },
    {
      rotationX: 0,
      scale: 1,
      ease: 'none',
      scrollTrigger: { trigger: '#city-stage', start: 'top 85%', end: 'center 45%', scrub: 0.5 },
    },
  );
}

loadCommunity()
  .then((data) => {
    const series = communitySeries(data);
    mountCity($('#city'), { ...series }, { unit: '次学习与共建', onEmpty: () => ($('#city-empty').hidden = false) });
    heroStats(data, series);
    board(data);
    wireBoard(data);
    contributors(data);
    promos(data, series);
    tilt();
  })
  .catch((err) => {
    console.error('[luokixi] 社区数据加载失败', err);
    $('#board-list').innerHTML = '<li class="notice">社区数据暂时加载不出来，请稍后刷新。</li>';
  })
  .finally(() => {
    observeReveal();
    observeLive();
  });
