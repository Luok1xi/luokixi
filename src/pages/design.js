// 第三版组件样张的交互：标签下划线、精选大卡展开成文章（View Transitions）、评分条进入视口后伸长。
import { initShell, reducedMotion } from '../js/shell.js';
import { esc } from '../js/data.js';
import '../styles/v3.css';

initShell();

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// 日期小字
const d = new Date();
$('#dz-date').textContent = `${d.getMonth() + 1}月${d.getDate()}日 星期${'日一二三四五六'[d.getDay()]}`;

// 标签：下划线滑到当前项
function wireTabs(tabs) {
  const bar = $('.v3-tabs-bar', tabs);
  const move = (b) => {
    bar.style.width = `${b.offsetWidth}px`;
    bar.style.transform = `translateX(${b.offsetLeft}px)`;
  };
  $$('button', tabs).forEach((b) =>
    b.addEventListener('click', () => {
      $$('button', tabs).forEach((x) => x.setAttribute('aria-selected', String(x === b)));
      move(b);
    }),
  );
  requestAnimationFrame(() => move($('[aria-selected="true"]', tabs)));
  addEventListener('resize', () => move($('[aria-selected="true"]', tabs)));
}
$$('.v3-tabs').forEach(wireTabs);

// 精选大卡 → 文章：用 View Transitions 从卡片位置放大；不支持时直接切换
const ARTICLES = {
  a1: '（示例正文）这里会放编辑写好的专题全文：先说结论，再给出三位作者的入门路线，每一步都链接到资料、项目和讨论的原始页面。',
  a2: '（示例正文）每个竞赛一行：面向谁、报名截止、比赛时间、官方链接和核对日期。截止前 7 天自动从首页下线。',
  a3: '（示例正文）创作者专题需要作者本人同意，并且只展示作者愿意公开的内容。',
};

function openArticle(card) {
  const title = $('.v3-today-title', card).innerHTML;
  const eyebrow = $('.v3-today-eyebrow', card).textContent;
  const bg = card.style.getPropertyValue('--today-bg');
  const render = () => {
    const el = document.createElement('div');
    el.className = 'v3-article';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.style.setProperty('--today-bg', bg);
    el.innerHTML = `<button class="v3-article-close" type="button" aria-label="关闭">×</button>
      <header class="v3-article-hero" style="view-transition-name: today-hero"><p class="v3-today-eyebrow">${esc(eyebrow)}</p><h2 class="v3-today-title">${title}</h2></header>
      <div class="v3-article-body"><p>${esc(ARTICLES[card.dataset.article] ?? '')}</p></div>`;
    card.style.viewTransitionName = '';
    document.body.append(el);
    document.documentElement.style.overflow = 'hidden';
    $('.v3-article-close', el).focus();
    const close = () => {
      const done = () => {
        el.remove();
        document.documentElement.style.overflow = '';
        card.focus();
      };
      if (document.startViewTransition && !reducedMotion()) {
        $('.v3-article-hero', el).style.viewTransitionName = 'today-hero';
        document.startViewTransition(() => {
          done();
          card.style.viewTransitionName = 'today-hero';
        }).finished.finally(() => (card.style.viewTransitionName = ''));
      } else done();
    };
    $('.v3-article-close', el).addEventListener('click', close);
    el.addEventListener('keydown', (e) => e.key === 'Escape' && close());
  };
  if (document.startViewTransition && !reducedMotion()) {
    card.style.viewTransitionName = 'today-hero';
    document.startViewTransition(render);
  } else render();
}

$$('.v3-today').forEach((card) => {
  card.addEventListener('click', () => openArticle(card));
  card.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), openArticle(card)));
});

// 评分分布条：进入视口后从 0 伸到实际比例（transform: scaleX）
const hist = $('#dz-rating');
const bars = $$('.v3-hist-track i', hist);
const targets = bars.map((b) => b.style.getPropertyValue('--p'));
if (!reducedMotion()) {
  bars.forEach((b) => b.style.setProperty('--p', '0'));
  new IntersectionObserver(([e], io) => {
    if (!e.isIntersecting) return;
    bars.forEach((b, i) => b.style.setProperty('--p', targets[i]));
    io.disconnect();
  }, { threshold: 0.4 }).observe(hist);
}
