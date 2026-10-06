import { initShell, observeReveal } from '../js/shell.js';
import { load, esc } from '../js/data.js';
import { initJumpbar } from '../js/localnav.js';
import '../styles/library.css';

initShell();

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const GLYPH = { 'calc-a1': '∫', 'calc-a2': '∬', linalg: 'λ' };
const STAGE_ORDER = ['期末', '课程考卷', '期中', '扫描试卷', '扫描合集'];

const yearKey = (p) => Number(p.year.match(/\d{4}/)?.[0] ?? 0);

function row(p) {
  const tags = [
    p.hasAnswers ? '<span class="tag tag-ok">含答案</span>' : '',
    p.scanned ? '<span class="tag">扫描件</span>' : '',
    `<span class="tag">${p.pages} 页</span>`,
  ].join('');
  return `<li class="paper-row">
    <span class="paper-year">${esc(p.year)}<small>${esc(p.stage)}</small></span>
    <div>
      <p class="paper-title">${esc(p.kind)}</p>
      <div class="paper-tags">${tags}</div>
    </div>
    <a class="btn btn-secondary btn-sm" href="${esc(p.file)}" target="_blank" rel="noopener">打开</a>
  </li>`;
}

function render(data) {
  const fill = {
    courses: data.courses.length,
    papers: data.papers.length,
    answers: data.papers.filter((p) => p.hasAnswers).length,
  };
  $$('[data-school-stat]').forEach((el) => (el.textContent = fill[el.dataset.schoolStat]));

  $('#course-list').innerHTML = data.courses
    .map((c, k) => {
      const papers = data.papers
        .filter((p) => p.course === c.id)
        .sort((a, b) => yearKey(b) - yearKey(a) || STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage));
      const answers = papers.filter((p) => p.hasAnswers).length;
      return `<section class="lib-year" id="${c.id}">
        <div class="wrap lib-year-grid">
          <header class="lib-year-side">
            <div class="course-head" data-reveal style="--hue:${k * -50}deg">
              <span class="course-glyph" aria-hidden="true">${GLYPH[c.id] ?? '∑'}</span>
            </div>
            <h2 class="session-title" data-reveal>${esc(c.name)}</h2>
            <p class="lib-year-meta" data-reveal>${papers.length} 份试卷${answers ? ` · ${answers} 份附答案` : ''}</p>
          </header>
          <div class="paper-list-wrap" data-reveal>
            <ul class="paper-list" role="list">${papers.map(row).join('')}</ul>
          </div>
        </div>
      </section>`;
    })
    .join('');

  const bar = $('#jumpbar');
  bar.insertAdjacentHTML('beforeend', data.courses.map((c) => `<a href="#${c.id}">${esc(c.name)}</a>`).join(''));
  initJumpbar(bar);
}

load('school')
  .then((data) => {
    render(data);
    observeReveal();
    if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
  })
  .catch((err) => {
    console.error('[luokixi] 校内资料加载失败', err);
    $('#course-list').innerHTML = '<p class="wrap notice">资料目录暂时加载不出来，请稍后刷新重试。</p>';
  });
