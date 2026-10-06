import { initShell, observeReveal } from '../js/shell.js';
import { load, catalogStats, groupByYear, esc } from '../js/data.js';
import { initJumpbar } from '../js/localnav.js';
import { mountPlayer } from '../js/player.js';
import '../styles/library.css';

initShell();

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const exam = document.body.dataset.exam;

const ICON = {
  paper: '<svg viewBox="0 0 24 24"><path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4M10 12h5M10 16h5"/></svg>',
  answer: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="m8.5 12.2 2.4 2.4 4.8-5"/></svg>',
  audio: '<svg viewBox="0 0 24 24"><path d="M5 15v-3a7 7 0 0 1 14 0v3"/><rect x="4" y="14" width="4" height="6" rx="1.5"/><rect x="16" y="14" width="4" height="6" rx="1.5"/></svg>',
};
const RES = [
  ['paper', '试卷'],
  ['answer', '答案'],
  ['audio', '听力'],
];

$$('[data-seg]').forEach((a) => a.dataset.seg === exam && a.setAttribute('aria-current', 'page'));

function resButton(set, key, label) {
  const url = set.resources?.[key];
  if (!url) return `<span class="res is-pending" aria-disabled="true" title="${label}即将上线">${ICON[key]}${label}</span>`;
  if (key === 'audio')
    return `<button class="res" type="button" data-audio="${esc(url)}" aria-expanded="false">${ICON[key]}${label}</button>`;
  return `<a class="res" href="${esc(url)}" target="_blank" rel="noopener">${ICON[key]}${label}</a>`;
}

function setCard(set, session, short) {
  const ready = RES.some(([k]) => set.resources?.[k]);
  const foot = set.practice
    ? `<a class="btn btn-primary btn-sm" href="${esc(set.practice)}">在线练习</a>`
    : `<span class="set-status${ready ? ' is-ready' : ''}">${ready ? '可下载' : '资源接入中'}</span>`;
  return `<article class="card card-hover set-card" id="${esc(set.id)}" data-reveal data-listening="${set.listening}">
    <header class="set-head">
      <h4 class="set-name">${esc(set.label)}</h4>
      ${set.listening ? '<span class="tag tag-accent">含听力</span>' : ''}
    </header>
    <p class="set-sub">${session.year} 年 ${session.month} 月 · ${esc(short)}</p>
    <div class="set-res">${RES.map(([k, l]) => resButton(set, k, l)).join('')}</div>
    <div class="set-audio"></div>
    <footer class="set-foot">${foot}${set.note ? `<span class="set-note">${esc(set.note)}</span>` : ''}</footer>
  </article>`;
}

function render(cat) {
  const stats = catalogStats(cat);
  const fill = {
    name: cat.name,
    eyebrow: `CET-${exam === 'cet4' ? 4 : 6} 真题库`,
    title: `${cat.short}真题。`,
    subtitle: `${stats.from} – ${stats.to}，按考次排好。`,
  };
  $$('[data-lib]').forEach((el) => (el.textContent = fill[el.dataset.lib] ?? el.textContent));
  $$('[data-lib-stat]').forEach((el) => (el.textContent = stats[el.dataset.libStat]));
  $('#lib-notice').hidden = stats.ready === stats.sets;

  const years = groupByYear(cat);
  const list = $('#years-list');
  list.classList.add('lib-list');
  list.innerHTML = years
    .map(({ year, sessions }, k) => {
      const n = sessions.reduce((a, s) => a + s.sets.length, 0);
      return `<section class="lib-year" id="y${year}" data-year="${year}" style="--h:${(215 + k * 24) % 360}">
        <div class="wrap lib-year-grid">
          <header class="lib-year-side">
            <h2 class="lib-year-num num" data-reveal>${year}</h2>
            <p class="lib-year-meta" data-reveal>${sessions.length} 个考次 · ${n} 套</p>
          </header>
          <div class="lib-year-body">
            ${sessions
              .map((s) => {
                const listening = s.sets.filter((t) => t.listening).length;
                return `<div class="session" data-session>
                  <h3 class="session-title" data-reveal>${s.month} 月<small>${s.sets.length} 套${listening ? ` · ${listening} 套含听力` : ''}</small></h3>
                  <div class="set-grid">${s.sets.map((t) => setCard(t, s, cat.short)).join('')}</div>
                </div>`;
              })
              .join('')}
          </div>
        </div>
      </section>`;
    })
    .join('');

  const bar = $('#jumpbar');
  bar.insertAdjacentHTML('beforeend', years.map(({ year }) => `<a href="#y${year}">${year}</a>`).join(''));
  initJumpbar(bar);
}

// 听力：点开后在卡片里展开迷你播放器
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-audio]');
  if (!btn) return;
  const box = btn.closest('.set-card').querySelector('.set-audio');
  const open = btn.getAttribute('aria-expanded') !== 'true';
  btn.setAttribute('aria-expanded', String(open));
  if (open && !box.childElementCount) mountPlayer(box, btn.dataset.audio, '听力');
  box.hidden = !open;
});

// 筛选：只看含听力
function wireFilter() {
  const btns = $$('[data-filter]');
  const list = $('#years-list');
  btns.forEach((b) =>
    b.addEventListener('click', () => {
      if (b.getAttribute('aria-pressed') === 'true') return;
      btns.forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      const only = b.dataset.filter === 'listening';
      list.classList.add('is-switching');
      setTimeout(() => {
        $$('.set-card', list).forEach((c) => (c.hidden = only && c.dataset.listening !== 'true'));
        $$('[data-session]', list).forEach((s) => (s.hidden = !$$('.set-card:not([hidden])', s).length));
        $$('.lib-year', list).forEach((y) => {
          y.hidden = !$$('[data-session]:not([hidden])', y).length;
          const link = $(`#jumpbar a[href="#${y.id}"]`);
          if (link) link.hidden = y.hidden;
        });
        list.classList.remove('is-switching');
      }, 180);
    }),
  );
}

load(exam)
  .then((cat) => {
    render(cat);
    wireFilter();
    observeReveal();
    // 内容是异步渲染的，浏览器自带的锚点跳转已经错过，补一次
    if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
  })
  .catch((err) => {
    console.error('[luokixi] 目录加载失败', err);
    $('#years-list').innerHTML = '<p class="wrap notice">目录暂时加载不出来，请稍后刷新重试。</p>';
  });
