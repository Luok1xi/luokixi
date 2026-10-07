import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { initShell, observeReveal, observeLive, reducedMotion } from '../js/shell.js';
import { load, catalogStats, daysUntil, esc } from '../js/data.js';
import { playIntro } from '../js/intro.js';
import { initGallery } from '../js/gallery.js';
import { loadCommunity, communitySeries } from '../js/community.js';
import { renderGrid } from '../js/heatmap.js';
import { coverMediaHTML as coverSVG } from '../js/cover.js';
import '../styles/home.css';
import '../styles/community.css';

gsap.registerPlugin(ScrollTrigger);
// 手机地址栏伸缩会改变视口高度，不为此重新计算，避免滚动中跳动
ScrollTrigger.config({ ignoreMobileResize: true });
initShell();
if (import.meta.env.DEV) window.__lk = { gsap, ScrollTrigger };

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const sources = { cet4: load('cet4'), cet6: load('cet6'), school: load('school'), site: load('site') };
const community = loadCommunity();
const fontsReady = document.fonts?.ready ?? Promise.resolve();
const introStart = playIntro([...Object.values(sources), community, fontsReady]);

// 首屏元素先就位到入场前的状态，等开场动画让路后再进
const heroParts = {
  lines: $$('.hero-title .line > span'),
  rest: [$('.hero-eyebrow'), $('.hero-lead'), $('.hero-cta')],
  stage: $('.stack-stage'),
};
if (!reducedMotion()) {
  gsap.set(heroParts.lines, { yPercent: 110 });
  gsap.set(heroParts.rest, { opacity: 0, y: 24 });
  gsap.set(heroParts.stage, { opacity: 0, y: 80 });
}

// ---------- 渲染 ----------

function yearIndex(cet4, cet6) {
  const map = new Map();
  for (const [key, cat] of [['cet4', cet4], ['cet6', cet6]]) {
    for (const s of cat.sessions) {
      const y = map.get(s.year) ?? { year: s.year, months: new Set(), cet4: 0, cet6: 0 };
      y.months.add(s.month);
      y[key] += s.sets.length;
      map.set(s.year, y);
    }
  }
  return [...map.values()].sort((a, b) => b.year - a.year);
}

// 固定种子的伪随机，让每次渲染出的试卷纸长得一样
const rand = (seed) => () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

function renderStack(years) {
  const stack = $('#stack');
  const list = [...years].reverse(); // 最旧的在最下面
  stack.style.setProperty('--mid', String((list.length - 1) / 2));
  // 外层 .stack 负责俯仰（rotateX），内层 .stack-spin 负责平面旋转（rotateZ）：
  // 先转后仰才是等轴“爆炸图”，单个元素上 GSAP 的变换顺序做不到
  stack.innerHTML = `<div class="stack-spin">${list
    .map((y, i) => {
      const r = rand(y.year);
      const lines = Array.from({ length: 4 }, () => `<i style="--w:${Math.round(62 + r() * 38)}%"></i>`).join('');
      const opts = Array.from({ length: 4 }, () => {
        const on = Math.floor(r() * 4);
        return `<div>${[0, 1, 2, 3].map((k) => `<i${k === on ? ' class="on"' : ''}></i>`).join('')}</div>`;
      }).join('');
      const months = [...y.months].sort((a, b) => a - b).map((m) => `${m} 月`).join(' · ');
      return `<article class="sheet" style="--i:${i}">
        <div class="sheet-head"><span>CET · 4 / 6</span><span>No.${String(i + 1).padStart(2, '0')}</span></div>
        <div class="sheet-year">${y.year}</div>
        <div class="sheet-meta">${months} · ${y.cet4 + y.cet6} 套</div>
        <div class="sheet-rule"></div>
        <div class="sheet-part">Part I&nbsp; Writing</div>
        <div class="sheet-lines">${lines}</div>
        <div class="sheet-part">Part II&nbsp; Listening Comprehension</div>
        <div class="sheet-opts">${opts}</div>
      </article>`;
    })
    .join('')}</div>`;
}

function renderStats(cet4, cet6, school, years) {
  const s4 = catalogStats(cet4);
  const s6 = catalogStats(cet6);
  const latest = [...cet4.sessions, ...cet6.sessions].sort((a, b) => b.year - a.year || b.month - a.month)[0];
  const values = {
    latest: `${latest.year} 年 ${latest.month} 月`,
    range: `${years.at(-1).year} – ${years[0].year}`,
    years: years.length,
    sessions: s4.sessions + s6.sessions,
    sets: s4.sets + s6.sets,
    from: years.at(-1).year,
    to: years[0].year,
  };
  $$('[data-stat]').forEach((el) => {
    const v = values[el.dataset.stat];
    if (v != null) el.textContent = v;
  });
  const counts = {
    'cet4.sets': s4.sets,
    'cet6.sets': s6.sets,
    listening: s4.listening + s6.listening,
    school: school.papers.length,
  };
  $$('[data-count]').forEach((el) => (el.dataset.target = counts[el.dataset.count] ?? 0));
}

function renderMiniTimeline(cet4) {
  const latest = [...cet4.sessions].sort((a, b) => b.year - a.year || b.month - a.month).slice(0, 4);
  $('#mini-timeline').innerHTML = latest
    .map(
      (s) => `<li><span class="when">${s.year}.${String(s.month).padStart(2, '0')}</span>
        <span class="sets">${s.sets
          .map((t) => `<span class="tag${t.listening ? ' tag-accent' : ''}">${esc(t.label)}${t.listening ? ' · 听力' : ''}</span>`)
          .join('')}</span></li>`,
    )
    .join('');
}

const COURSE_GLYPH = { 'calc-a1': '∫', 'calc-a2': '∬', linalg: 'λ' };

function renderSchool(school) {
  const chips = [...school.courses.map((c) => c.name), '期中', '期末', '参考答案', '评分标准'];
  $('#chip-cloud').innerHTML = chips.map((c, k) => `<span style="--k:${(k % 3) + 1}">${esc(c)}</span>`).join('');

  $('#course-row').innerHTML = school.courses
    .map((c, k) => {
      const papers = school.papers.filter((p) => p.course === c.id);
      const years = papers.map((p) => p.year.match(/\d{4}/)?.[0]).filter(Boolean).map(Number);
      const span = years.length ? `${Math.min(...years)} – ${Math.max(...years) + 1} 学年` : '';
      const withAns = papers.filter((p) => p.hasAnswers).length;
      return `<a class="card card-hover course-card" href="school.html#${c.id}" data-reveal style="--hue:${k * -50}deg">
        <span class="course-glyph" aria-hidden="true">${COURSE_GLYPH[c.id] ?? '∑'}</span>
        <h3>${esc(c.name)}</h3>
        <p>${papers.length} 份试卷${withAns ? ` · ${withAns} 份附答案` : ''}${span ? ` · ${span}` : ''}</p>
      </a>`;
    })
    .join('');
}

function renderYears(years) {
  $('#years-track').innerHTML = years
    .map(
      (y, k) => `<div class="card year-card" data-reveal data-label="${y.year} 年" style="--h:${(210 + k * 24) % 360}">
        <span class="year-num num">${y.year}</span>
        <div class="year-months">${[...y.months].sort((a, b) => a - b).map((m) => `<span class="tag">${m} 月</span>`).join('')}</div>
        <div class="year-rows">
          ${y.cet4 ? `<a href="cet4.html#y${y.year}"><span>四级</span><span>${y.cet4} 套 ›</span></a>` : ''}
          ${y.cet6 ? `<a href="cet6.html#y${y.year}"><span>六级</span><span>${y.cet6} 套 ›</span></a>` : ''}
        </div>
      </div>`,
    )
    .join('');
}

function renderCountdown(site) {
  const ex = site.nextExam;
  if (!ex?.date) return;
  const days = daysUntil(ex.date);
  const [, m, d] = ex.date.split('-').map(Number);
  $('#cd-label').textContent = days > 0 ? `距离 ${ex.label}` : days === 0 ? `${ex.label}，就是今天` : '下一次考试时间待公布';
  const daysEl = $('#cd-days');
  daysEl.dataset.target = Math.max(days, 0);
  daysEl.textContent = days > 0 ? '0' : '—';
  if (days <= 0) $('.cd-unit').hidden = true;
  $('#cd-sessions').innerHTML = (ex.sessions ?? [])
    .map((s) => `<li><b>${esc(s.exam)}</b><span>${m} 月 ${d} 日 ${esc(s.time)}</span></li>`)
    .join('');
  $('#cd-note').innerHTML = `日期来源：${esc(ex.source)}。<a href="${esc(ex.sourceUrl)}" target="_blank" rel="noopener">查看官网</a>`;
}

function prepWave() {
  const r = rand(7);
  $$('.wave i').forEach((bar, k) => {
    bar.style.setProperty('--amp', (0.35 + r() * 0.65).toFixed(2));
    bar.style.animationDelay = `${(-r() * 1.6).toFixed(2)}s`;
    bar.style.backgroundPosition = `${(k / 23) * 100}% 0`;
  });
}

// 按标点切成分句（标点跟着前一句）
function splitStatement() {
  const el = $('[data-split]');
  const text = el.textContent.trim().replace(/\s+/g, '');
  el.setAttribute('aria-label', text);
  const clauses = text.match(/[^，。、！？；]+[，。、！？；]?/g) ?? [text];
  el.innerHTML = clauses.map((c) => `<span class="clause" aria-hidden="true">${esc(c)}</span>`).join('');
}

// ---------- 动效 ----------

function countUp(el) {
  const target = Number(el.dataset.target || 0);
  if (reducedMotion()) return void (el.textContent = target);
  const o = { v: 0 };
  gsap.to(o, {
    v: target,
    duration: 1.6,
    ease: 'power3.out',
    onUpdate: () => (el.textContent = Math.round(o.v)),
  });
}

function wireCounters() {
  const els = $$('[data-target]');
  const io = new IntersectionObserver(
    (entries) =>
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        countUp(e.target);
        io.unobserve(e.target);
      }),
    { threshold: 0.6 },
  );
  els.forEach((el) => io.observe(el));
}

function heroEntrance() {
  if (reducedMotion()) return;
  gsap
    .timeline({ defaults: { ease: 'power4.out' } })
    .to(heroParts.lines, { yPercent: 0, duration: 1.2, stagger: 0.12 }, 0)
    .to(heroParts.rest, { opacity: 1, y: 0, duration: 1, stagger: 0.1 }, 0.25)
    .to(heroParts.stage, { opacity: 1, y: 0, duration: 1.4 }, 0.35);
}

function wireScroll() {
  const mm = gsap.matchMedia();
  mm.add(
    {
      mobile: '(max-width: 760px)',
      motion: '(prefers-reduced-motion: no-preference)',
    },
    ({ conditions: { mobile, motion } }) => {
      if (!motion) {
        document.body.classList.add('no-scrub');
        return;
      }

      // ① 试卷堆叠：从底部探出 → 转成等轴视角 → 一层层展开
      const stack = $('#stack');
      const pin = $('.hero-pin');
      const copy = $('.hero-copy');
      const startScale = mobile ? 0.82 : 0.9;
      // 让试卷顶边落在按钮下方 40px，只露出上半截
      const startY = () =>
        Math.max(pin.offsetHeight * 0.3, copy.offsetTop + copy.offsetHeight + 40 - pin.offsetHeight / 2 + (stack.offsetHeight * startScale) / 2);
      // 每层试卷的 z 直接由 GSAP 写入 transform（合成层），新的一层先抬起
      const sheets = gsap.utils.toArray('.sheet', stack);
      const mid = (sheets.length - 1) / 2;
      const gap = mobile ? 22 : 36;
      gsap.set(sheets, { z: (i) => (i - mid) * 2, force3D: true });

      gsap
        .timeline({
          defaults: { ease: 'none' },
          scrollTrigger: {
            trigger: '.hero-pin',
            start: 'top top',
            end: '+=170%',
            pin: true,
            scrub: 0.6,
            anticipatePin: 1,
            invalidateOnRefresh: true,
          },
        })
        .to('.scroll-hint', { opacity: 0, duration: 0.06 }, 0)
        .to('.hero-copy', { y: -80, opacity: 0, scale: 0.95, duration: 0.3, ease: 'power1.in' }, 0)
        .fromTo(
          stack,
          { y: startY, rotationX: 18, scale: startScale },
          { y: mobile ? 10 : 0, rotationX: 56, scale: mobile ? 0.86 : 1, duration: 0.5, ease: 'power2.inOut' },
          0.02,
        )
        .fromTo('.stack-spin', { rotationZ: 0 }, { rotationZ: -36, duration: 0.5, ease: 'power2.inOut' }, 0.02)
        .to(sheets, { z: (i) => (i - mid) * gap, duration: 0.42, ease: 'power2.out', stagger: { each: 0.014, from: 'end' } }, 0.3)
        .to('.hero-glow', { scale: 1.25, opacity: 0.5, duration: 0.8 }, 0)
        .fromTo('.hero-caption', { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: 0.18, ease: 'power2.out' }, 0.74)
        .to({}, { duration: 0.12 });

      // ② 宣言：随滚动按分句点亮（只改 opacity）
      gsap.to('.statement-text .clause', {
        opacity: 1,
        stagger: 0.5,
        ease: 'none',
        scrollTrigger: { trigger: '.statement-text', start: 'top 78%', end: 'bottom 50%', scrub: 0.3 },
      });
    },
  );
}

// ---------- 启动 ----------

Promise.all([sources.cet4, sources.cet6, sources.school, sources.site])
  .then(([cet4, cet6, school, site]) => {
    const years = yearIndex(cet4, cet6);
    renderStack(years);
    renderStats(cet4, cet6, school, years);
    renderMiniTimeline(cet4);
    renderSchool(school);
    renderYears(years);
    renderCountdown(site);
  })
  .catch((err) => console.error('[luokixi] 数据加载失败', err))
  .finally(() => {
    prepWave();
    splitStatement();
    wireScroll();
    observeReveal();
    observeLive();
    wireCounters();
    initGallery($('[data-gallery]'));
    introStart.then(heroEntrance);
    fontsReady.then(() => ScrollTrigger.refresh());
  });

// 双联宣传格：开源项目封面扇形 + 社区热力图
community
  .then((data) => {
    document.getElementById('home-fan').innerHTML = data.projects
      .slice(0, 3)
      .map((p, i) => `<div class="fan-card" style="--i:${i}">${coverSVG(p)}</div>`)
      .join('');
    renderGrid(document.getElementById('home-heat'), { ...communitySeries(data), label: '社区贡献' });
  })
  .catch((err) => console.error('[luokixi] 社区数据加载失败', err));
