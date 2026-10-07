import { esc } from './data.js';

export function supervisorReviews(m) {
  const s = m.supervisor ?? {};
  return `<h3 class="me-h3">北矿娘 · 总监督</h3><p class="muted">我会检查归档依据和整理结果，拿不准的事请你决定。公告先写草稿，经你确认后才公开。</p>
    <button class="btn btn-outline btn-sm" type="button" data-draft-announcement>请北矿娘写更新公告</button>
    ${(s.cases ?? []).map(c => `<section class="card me-project-review"><h4>${esc(c.repository)}</h4><p>${esc(c.message)}</p>
      <ul>${(c.checks ?? []).map(t=>`<li>${esc(t)}</li>`).join('')}</ul><h4>想请你决定</h4><ol>${(c.questions ?? []).map(t=>`<li>${esc(t)}</li>`).join('')}</ol>
      <form data-supervisor-case="${esc(c.id)}"><label>你的意见<textarea name="answer" required maxlength="4000" rows="3" style="width:100%"></textarea></label>
        <button type="submit" class="btn btn-primary btn-sm">回复北矿娘</button><button type="button" class="btn btn-outline btn-sm" data-supervisor-discuss>交给北矿娘和 Codex 讨论</button></form></section>`).join('') || '<p class="muted">当前没有等待你答复的请示。</p>'}
    ${(s.announcements ?? []).map(n => `<section class="card me-project-review"><h4>${esc(n.title)}</h4><p class="tag">北矿娘 · 公告草稿 · 未公开</p><p style="white-space:pre-wrap">${esc(n.body)}</p>
      <details><summary>公告事实依据</summary>${(n.evidence ?? []).map(e=>`<p>${esc(e.text)} <a href="${esc(e.url)}" target="_blank" rel="noopener">查看依据</a></p>`).join('')}</details>
      ${(n.questions ?? []).length ? `<h4>发布前需要确认</h4><ul>${n.questions.map(q=>`<li>${esc(q)}</li>`).join('')}</ul>` : ''}
      <form data-supervisor-news="${esc(n.id)}" data-revision="${n.revision}"><p><label><input name="resolved" type="checkbox" required> 已核对事实并解决上述疑问</label></p>
        <label>核对意见 / 疑问答复<textarea name="note" rows="2" required maxlength="3000" style="width:100%"></textarea></label>
        <button class="btn btn-primary btn-sm" type="submit">同意发布公告</button><button class="btn btn-outline btn-sm" type="button" data-reject-announcement>退回公告</button></form></section>`).join('')}`;
}
