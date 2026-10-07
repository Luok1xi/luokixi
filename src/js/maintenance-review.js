// 通知页与维护面板共用审核内容和表单，避免出现两套审核规则。
import { esc } from './data.js';
const CATEGORIES = {mech:'机器人与机械',embedded:'嵌入式与硬件',software:'软件与效率工具',algo:'算法与刷题',course:'课程与学习资料',research:'科研与数据分析',unclassified:'待分类'};

function guideText(p) {
  const guide = p.guide ?? {};
  const sources = new Map((p.evidence ?? []).map(e => [e.id,e]));
  return guide.state === 'generated' ? `<details class="me-project-review"><summary>中文说明书 · ${guide.sections?.length ?? 0} 章 · ${guide.reviewState === 'reviewed' ? '已核对' : '待核对'}</summary>
    <p>${esc(guide.oneLiner)}</p>${(guide.sections ?? []).map(s => `<section><h4>${esc(s.heading)}</h4><p style="white-space:pre-wrap">${esc(s.text)}</p><p class="muted">依据：${(s.evidenceIds ?? []).map(id => sources.get(id)).filter(Boolean).map(e => `<a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.id)}</a>`).join(' · ')}</p></section>`).join('')}</details>` : `<p class="muted">${esc(guide.message || '中文导读尚未生成。')}</p>`;
}

export function guideReviews(m) {
  return `<h3 class="me-h3">待核对的中文说明书 <span class="muted">${m.pendingGuides?.length ?? 0}</span></h3>
    ${(m.pendingGuides ?? []).map(p => `<section class="card me-project-review"><h4>${esc(p.repository)}</h4>${guideText(p)}
      <form data-guide-review="${esc(p.repository)}" data-source="${esc(p.guide.sourceFingerprint ?? '')}">
        <p><label><input type="checkbox" required> 已逐章核对中文说明与原文依据</label></p>
        <p><label>核对说明<textarea name="note" required maxlength="1500" rows="2" style="width:100%" placeholder="说明核对情况或需要更正的内容"></textarea></label></p>
        <button class="btn btn-primary btn-sm" type="submit">同意公开中文说明</button>
        <button class="btn btn-outline btn-sm" type="button" data-reject-guide>退回导读</button>
      </form></section>`).join('') || '<p class="muted">当前没有待审核的中文导读。</p>'}`;
}

export function projectReviews(m, expandFirst = false) {
  return `<h3 class="me-h3">GitHub 候选项目 <span class="muted num">${m.pendingProjects?.length ?? 0}</span></h3>
      <p class="muted">机器人按方向、许可证、近期维护和说明完整度筛选。Star 只作参考；尚未实测，也不会自动标成严选。核对后才进入开源广场。</p>
      ${(m.pendingProjects ?? []).map((p, i) => `<details class="ap-card me-project-review"${expandFirst && i === 0 ? ' open' : ''}><summary>${esc(p.repository)} · ${esc(p.license ?? '许可待核')}${p.stale ? ' · 待更新' : ''}</summary>
        <p>${esc(p.description ?? '')}</p><p class="muted">${esc(p.discovery?.reason ?? '')}</p>
        <p>自动归档：${(p.classification?.labels ?? []).map(c => esc(c.name)).join(' · ') || '待分类'}</p>
        <button class="btn btn-outline btn-sm" type="button" data-summarize="${esc(p.repository)}">生成详细中文导读</button>
        <button class="btn btn-outline btn-sm" type="button" data-classify="${esc(p.repository)}">重新自动分类</button>
        ${guideText(p)}
        ${p.cover ? `<img src="${esc(p.cover)}" alt="项目 README 配图" loading="lazy" referrerpolicy="no-referrer" style="max-width:100%;max-height:180px;object-fit:contain">` : ''}
        <p><a href="${esc(p.readmeUrl)}" target="_blank" rel="noopener">原项目说明 ↗</a> · <a href="${esc(p.url + '#license')}" target="_blank" rel="noopener">核对仓库许可证 ↗</a> · <a href="${esc(p.releaseUrl)}" target="_blank" rel="noopener">正式发布 ↗</a></p>
        <ul>${(p.downloads ?? []).map(d=>`<li><a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.name)}</a> · ${d.kind === 'source-archive' ? '源码包，需要构建' : '作者发布附件'}</li>`).join('')}</ul>
        <form data-project-review="${esc(p.repository)}">
          <p><label><input type="checkbox" name="sourceRead" required> 已核对用途和原文</label></p>
          <p><label><input type="checkbox" name="licenseChecked" required> 已核对许可证</label></p>
          <p><label><input type="checkbox" name="downloadsChecked" required> 已核对下载入口</label></p>
          <p><label>推荐类别 <select name="shelf"><option value="practical">实用</option><option value="creative">新奇</option><option value="potential">潜力</option></select></label></p>
          <p><label>归档分类 <select name="category">${Object.entries(CATEGORIES).map(([id,name]) => `<option value="${id}"${id === (p.classification?.primary || 'unclassified') ? ' selected' : ''}>${name}</option>`).join('')}</select></label></p>
          ${p.guide?.state === 'generated' ? '<p><label><input type="checkbox" name="approveGuide"> 我已核对上面的中文导读，同时公开</label></p>' : ''}
          <p><label>给同学的推荐理由 <textarea name="reason" required maxlength="1500" rows="3" style="width:100%;box-sizing:border-box">${esc(p.discovery?.reason ?? '')}</textarea></label></p>
          <button class="btn btn-primary btn-sm" type="submit">同意推荐，加入广场</button>
          <button class="btn btn-secondary btn-sm" type="button" data-skip-project="${esc(p.repository)}">不推荐</button>
        </form></details>`).join('') || '<p class="muted">当前没有待审核的项目。</p>'}`;
}

export function newsReviews(m) {
  return `<h3 class="me-h3">待审核的学校新闻 <span class="muted num">${m.pendingNews?.length ?? 0}</span></h3>
      ${m.pendingNews?.length ? `<ul class="ap-list me-news">${m.pendingNews.map((n) => `<li class="me-news-row" data-news="${esc(n.id)}" data-rev="${n.revision}">
          ${n.image ? `<img src="${esc(n.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : '<span class="me-news-noimg">无配图</span>'}
          <div class="me-news-text"><b>${esc(n.title)}</b><span>${esc(n.publishedAt?.slice(0, 10) ?? '')} · <a href="${esc(n.source)}" target="_blank" rel="noopener">原文</a>${n.credit ? ` · ${esc(n.credit)}` : ''}</span><p>${esc(n.summary)}</p></div>
          <div class="me-news-actions"><button class="btn btn-primary btn-sm" type="button" data-news-act="approve">同意发布</button><button class="btn btn-secondary btn-sm" type="button" data-news-act="reject">退回</button></div>
        </li>`).join('')}</ul>` : '<p class="muted">当前没有待审核的新闻。</p>'}`;
}
