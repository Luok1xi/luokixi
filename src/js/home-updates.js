import { hubApi } from './hub.js';
import { esc } from './data.js';
import { depthSlides } from './depth-slider.js';
import { journalExpression } from './journal-expression.js';
import '../styles/home-updates.css';

// Public, persisted entries only. A failed request never becomes a fabricated empty log.
export async function mountHomeUpdates() {
  const panel = document.querySelector('#td-panel');
  if (!panel) return;
  const section = document.createElement('section');
  section.className = 'home-updates wrap';
  section.setAttribute('aria-label', '前沿消息与维护日志');
  panel.before(section);
  const results = await Promise.allSettled([
    hubApi.circleFeed({ board: 'frontier', lane: 'latest' }),
    hubApi.catalogue({ kind: 'announcement' }),
  ]);
  const news = results[0].status === 'fulfilled' ? results[0].value.items.slice(0, 3) : [];
  const logs = results[1].status === 'fulfilled' ? results[1].value.items.filter(e => e.data?.maintenanceFacts).slice(0, 2) : [];
  section.innerHTML = `<div class="home-updates-heading"><h2>今天，正在发生</h2><a href="circle.html?board=frontier">AI 与科研前沿 ›</a></div>
    <div class="home-frontier">${news.map(p => `<a href="circle.html?post=${encodeURIComponent(p.id)}" class="home-frontier-item">
      ${p.photos?.[0] ? depthSlides([p.photos[0]], p.photoCredit || '科研概念配图') : ''}
      <small>${esc(p.data.credit)} · ${esc(new Date(p.data.provenance?.sourcePublishedAt || p.created).toLocaleDateString('zh-CN'))}</small>
      <h3>${esc(p.data.title)}</h3><p>${esc(p.data.summary)}</p><span>站内中文摘要 · ${p.replies || 0} 条讨论</span></a>`).join('') || `<p class="home-updates-empty">${results[0].status === 'rejected' ? '前沿消息暂时无法连接，稍后再看。' : '前沿新闻机器人正在检查来源；通过检查的中文摘要会出现在这里。'}</p>`}</div>
    <div class="home-log-heading"><h2>她们的维护手记</h2><a href="studio.html">工作室与执行记录 ›</a></div>
    <div class="home-logs">${logs.map(e => `<details><summary><b>${esc(e.data.title)}</b><time>${esc(new Date(e.created || e.updated).toLocaleString('zh-CN'))}</time></summary>
      ${journalExpression(e.data)}<div class="home-log-body">${esc(e.data.body)}</div><a href="project.html?id=${encodeURIComponent(e.id)}">查看日志与讨论 ›</a></details>`).join('') || `<p class="home-updates-empty">${results[1].status === 'rejected' ? '维护记录暂时无法读取。' : '尚未生成公开维护日志，实际执行记录可以在工作室查看。'}</p>`}</div>`;
}
