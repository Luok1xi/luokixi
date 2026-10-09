import { chinesePresentation } from '../js/content-language.js';
import { journalExpression } from '../js/journal-expression.js';
// 内容详情：社区里的项目、资料、论文、复现、讨论……每一条都在这里展开。
// 数据来自 /api/hub/entries/{id}（也接受 ?slug=）；地点（kind=place）转到校园地图。
// 几条不能破的规矩：
// - 本站收藏和 GitHub ★ 分开显示，绝不相加；站内投稿者（owner）和原作者（credit）分开写。
// - 待审核的版本只给作者和维护者看，而且要明确标出来，不能混进公开页面。
// - AI 导读没核对时标“尚未核对”，原文 README 的入口放在最显眼的位置。
import { initShell } from '../js/shell.js';
import { canParticipate, hubApi, hubState, loginURL, HubError } from '../js/hub.js';
import { avatarHTML, catTag, fmtNum, timeAgo } from '../js/community.js';
import { CATEGORIES } from '../js/schema.js';
import { renderMarkdown } from '../js/markdown.js';
import { esc } from '../js/data.js';
import { depthSlides, mountDepthSlider } from '../js/depth-slider.js';
import '../styles/community.css';
import '../styles/project.css';

initShell();

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const main = $('#main');
const params = new URLSearchParams(location.search);
const safeURL = (u) => (typeof u === 'string' && /^https?:\/\//.test(u) ? u : null);

const KIND = {
  project: '项目', resource: '资料', paper: '论文', reproduction: '复现报告', topic: '讨论',
  contest: '竞赛', news: '资讯', announcement: '公告', collection: '合集', place: '地点',
};
const STATE = {
  draft: ['草稿', ''], pending: ['待审核', 'tag-warn'], published: ['已公开', 'tag-ok'],
  rejected: ['已退回', 'tag-danger'], withdrawn: ['已撤回', ''],
};
const LINKS = {
  repo: '源代码', demo: '在线演示', video: '演示视频', site: '项目主页', hardware: '硬件 / 电路',
  release: '发布页', paper: '论文', dataset: '数据集', source: '原始来源', registration: '报名入口',
};
const TASK = {
  open: ['可认领', 'tag-accent'], claimed: ['进行中', 'tag-warn'], submitted: ['待核对', 'tag-warn'],
  accepted: ['已完成', 'tag-ok'], 'changes-requested': ['需要修改', 'tag-danger'],
};
const EXTRACTION = {
  text: '可以检索全文', 'needs-ocr': '扫描件，还没有识别文字', encrypted: '加密文件，读不出内容',
  'attachment-only': '只提供下载', pending: '正在处理',
};
// 不同类型额外的说明字段：[字段, 标题]
const SECTIONS = {
  project: [['setup', '怎么上手'], ['needs', '需要准备'], ['hardware', '硬件清单']],
  reproduction: [['environment', '环境'], ['steps', '步骤'], ['results', '结果'], ['failures', '没成功的地方']],
  contest: [['audience', '面向谁']],
};

const st = { online: false, user: null, entry: null, view: 'public', history: null, gh: undefined, ghError: '' };

// ---------- 提示 ----------

let toastTimer;
function toast(msg, action) {
  const el = $('#pd-toast');
  el.innerHTML = `${esc(msg)}${action ? ` <a href="${esc(action.href)}">${esc(action.label)}</a>` : ''}`;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('is-on'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('is-on');
    setTimeout(() => (el.hidden = true), 300);
  }, 3600);
}

function blocked(action) {
  if (!st.user) return toast(`登录之后才能${action}。`, { href: loginURL(), label: '去登录' }), true;
  if (!canParticipate(st.user)) return toast(`验证邮箱之后才能${action}。`, { href: 'me.html#account', label: '去验证' }), true;
  return false;
}

// ---------- 小工具 ----------

const e = () => st.entry;
const isOwner = () => Boolean(st.user && e()?.owner && e().owner.id === st.user.id);
const isMod = () => Boolean(st.user?.moderator);
const editorial = () => e()?.draft !== undefined;
const hasPublic = () => e()?.revision > 0 && Boolean(e()?.data?.title);
const viewData = () => (st.view === 'draft' && editorial() ? e().draft : e().data) ?? {};
const ghRepo = (u) => {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(u ?? '');
  return m ? `${m[1]}/${m[2]}` : null;
};
const fmtBytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const md = (text) => `<div class="md">${renderMarkdown(text)}</div>`;
const person = (m, size = 28) => (m ? `${avatarHTML({ login: m.username, name: m.name, avatar: m.avatar }, size)}<span>${esc(m.name)}</span>` : '');

// ---------- 渲染 ----------

function stateTag() {
  if (!editorial()) return '';
  const [label, cls] = STATE[e().state] ?? [e().state, ''];
  return `<span class="tag ${cls}">${label}</span>`;
}

function headHTML(d) {
  const cat = CATEGORIES[d.category];
  const repo = safeURL(d.links?.repo);
  const watching = e().watch ?? [];
  const canAct = hasPublic() && st.view === 'public';
  return `<header class="pd-head">
    <nav class="pd-crumbs" aria-label="位置"><a href="projects.html">开源广场</a>${cat ? `<span aria-hidden="true">/</span><span>${esc(cat.name)}</span>` : ''}</nav>
    <div class="pd-tags"><span class="tag">${KIND[e().kind] ?? esc(e().kind)}</span>${catTag(d.category)}${stateTag()}${e().canonical ? '<span class="tag">与已有内容重复</span>' : ''}</div>
    <h1 class="pd-title">${esc(d.title ?? '未命名')}</h1>
    ${d.summary ? `<p class="pd-summary">${esc(d.summary)}</p>` : ''}
    <div class="pd-byline">
      ${e().owner ? `<span class="pd-by"><span class="muted">站内投稿</span>${person(e().owner, 24)}</span>` : '<span class="pd-by"><span class="muted">来自已有公开目录，还没有成员认领</span></span>'}
      ${d.credit ? `<span class="pd-by"><span class="muted">原作者</span><span>${esc(d.credit)}</span></span>` : ''}
      <span class="pd-by"><span class="muted">许可</span>${d.license && !/待核/.test(d.license) ? `<span>${esc(d.license)}</span>` : '<span class="lic-unknown">许可待核</span>'}</span>
      <span class="pd-by"><span class="muted">收录时间</span><span>${esc((d.provenance?.uploadedAt || e().created) ? new Date(d.provenance?.uploadedAt || e().created).toLocaleString('zh-CN') : '历史记录未注明')}</span></span>
      ${d.provenance?.reviewedBy ? `<span class="pd-by"><span class="muted">审核者</span>${esc(d.provenance.reviewedBy)}</span>` : ''}
      <span class="pd-by"><span class="muted">更新</span><span>${timeAgo(e().updated)}</span></span>
    </div>
    <div class="pd-actions">
      <a class="btn btn-outline" href="viewer.html?kind=entry&id=${esc(e().id)}">站内阅读 / 导出</a>
      ${repo ? `<a class="btn btn-primary" href="${esc(repo)}" target="_blank" rel="noopener">${ghRepo(repo) ? '在 GitHub 上查看' : '查看源代码'}</a>` : ''}
      ${canAct ? `<button class="pd-act${e().starred ? ' is-on' : ''}" type="button" data-act="star" aria-pressed="${Boolean(e().starred)}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.5 4.2 12.9a4.9 4.9 0 0 1 6.9-6.9l.9.9.9-.9a4.9 4.9 0 0 1 6.9 6.9z"/></svg>
        <span>本站收藏</span><span class="num">${fmtNum(e().siteStars ?? 0)}</span></button>
      <details class="pd-watch">
        <summary class="pd-act${watching.length ? ' is-on' : ''}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2H4.5z"/><path d="M10 21h4"/></svg><span>${watching.length ? '已关注' : '关注'}</span></summary>
        <form class="pd-watch-menu glass" data-form="watch">
          <p>有这些动静时提醒我：</p>
          <label><input type="checkbox" name="release"${watching.includes('release') ? ' checked' : ''}> 发布新版本</label>
          <label><input type="checkbox" name="discussion"${watching.includes('discussion') ? ' checked' : ''}> 讨论有新回复</label>
          <label><input type="checkbox" name="revision"${watching.includes('revision') ? ' checked' : ''}> 内容被修改</label>
          <button class="btn btn-primary btn-sm" type="submit">保存</button>
        </form>
      </details>` : ''}
    </div>
  </header>`;
}

function ownerBarHTML() {
  if (!editorial()) return '';
  const x = e();
  const [label, cls] = STATE[x.state] ?? [x.state, ''];
  const unsubmitted = x.state === 'draft' || x.state === 'rejected';
  const hint = {
    draft: '还没有提交审核，别人看不到这一版。',
    pending: '已经提交，正在等维护者核对。',
    rejected: '维护者退回了这一版，改好以后可以重新提交。',
    published: '这一版已经公开。',
    withdrawn: '已经撤回，别人看不到了。',
  }[x.state] ?? '';
  const both = hasPublic() && x.editRevision !== x.revision;
  return `<section class="pd-owner card" aria-label="${isOwner() ? '作者操作' : '维护者操作'}">
    <div class="pd-owner-top">
      <span class="tag ${cls}">${label}</span>
      <p><b>${isOwner() ? '这是你的投稿。' : '你是维护者。'}</b>${hint}</p>
    </div>
    ${x.reviewNote ? `<p class="pd-note"><b>审核意见</b>${esc(x.reviewNote)}</p>` : ''}
    ${both ? `<div class="segmented" role="group" aria-label="切换版本">
        <button type="button" data-view="public" aria-pressed="${st.view === 'public'}">公开版本 · 第 ${x.revision} 版</button>
        <button type="button" data-view="draft" aria-pressed="${st.view === 'draft'}">${unsubmitted ? '未提交的修改' : '待审核的修改'} · 第 ${x.editRevision} 版</button>
      </div>` : ''}
    ${st.view === 'draft' && x.state !== 'published' ? '<p class="pd-hint">你现在看到的是还没公开的版本。</p>' : ''}
    <div class="pd-owner-acts">
      ${isOwner() && unsubmitted ? '<button class="btn btn-primary btn-sm" type="button" data-act="submit">提交审核</button>' : ''}
      ${x.state !== 'withdrawn' ? `<details class="pd-inline"><summary>撤回</summary>
        <form data-form="withdraw"><label class="sr-only" for="pd-withdraw">撤回原因</label>
          <input id="pd-withdraw" name="reason" maxlength="1000" required placeholder="写一句原因，会通知关注的人">
          <button class="btn btn-outline btn-sm" type="submit">确认撤回</button></form></details>` : ''}
    </div>
    ${isMod() && x.state === 'pending' && x.kind !== 'place' ? `<form class="pd-review" data-form="review">
        <p><b>审核这一版</b>（第 ${x.editRevision} 版）</p>
        <label class="sr-only" for="pd-review-note">审核意见</label>
        <textarea id="pd-review-note" name="note" rows="2" maxlength="3000" required placeholder="通过时写核对了什么（来源、许可、链接）；退回时写清楚要改哪里"></textarea>
        <div class="pd-owner-acts"><button class="btn btn-outline btn-sm" type="submit" name="decision" value="reject">退回修改</button>
        <button class="btn btn-primary btn-sm" type="submit" name="decision" value="approve">通过并公开</button></div>
      </form>` : ''}
  </section>`;
}

function guideHTML(d) {
  const repo = ghRepo(d.links?.repo);
  if (!repo) return '';
  const gh = st.gh;
  if (gh === undefined) return '<section class="pd-sec" id="guide"><h2>导读</h2><p class="muted">正在读取 GitHub 上的信息…</p></section>';
  if (gh === 'missing')
    return `<section class="pd-sec" id="guide"><h2>导读</h2>
      <p>社区还没有读取过这个仓库。读取以后，这里会显示 README、官方发布包和源码下载，和维护者核对过的中文导读。</p>
      <button class="btn btn-outline btn-sm" type="button" data-act="inspect">读取这个仓库</button>
    </section>`;
  if (!gh) return `<section class="pd-sec" id="guide"><h2>导读</h2><p class="muted">GitHub 信息暂时读不到：${esc(st.ghError)}</p></section>`;
  const guide = gh.guide ?? {};
  const ev = new Map((gh.evidence ?? []).map((x) => [x.id, x]));
  const cite = (ids) =>
    (ids ?? [])
      .map((id) => ev.get(id))
      .filter((x) => x && safeURL(x.url))
      .map((x) => `<a href="${esc(x.url)}" target="_blank" rel="noopener" title="${esc((x.text ?? '').slice(0, 200))}">${x.startLine ? `README 第 ${x.startLine}–${x.endLine} 行` : '仓库信息'}</a>`)
      .join('、') || '—';
  const generated = guide.state === 'generated';
  const reviewed = generated && guide.reviewState === 'reviewed';
  const release = (gh.downloads ?? []).filter((x) => x.kind === 'official-release');
  const source = (gh.downloads ?? []).filter((x) => x.kind !== 'official-release');
  const dl = (x) =>
    safeURL(x.url)
      ? `<a class="dl" href="${esc(x.url)}" target="_blank" rel="noopener"><b>${esc(x.name)}</b><span>${[x.version, x.bytes ? fmtBytes(x.bytes) : ''].filter(Boolean).map(esc).join(' · ')}</span></a>`
      : '';
  return `<section class="pd-sec" id="guide">
    <div class="pd-sec-head"><h2>导读</h2>
      ${generated ? `<span class="tag ${reviewed ? 'tag-ok' : 'tag-warn'}">${reviewed ? '中文导读 · 已按记录核对' : 'AI 导读 · 尚未核对'}</span>` : ''}</div>
    ${safeURL(gh.readmeUrl) ? `<p class="pd-guide-cta"><a class="btn btn-outline btn-sm" href="${esc(gh.readmeUrl)}" target="_blank" rel="noopener">阅读原文 README</a>${reviewed ? '' : '<span class="muted">以原文为准</span>'}</p>` : ''}
    ${generated
      ? `${guide.oneLiner ? `<p class="pd-oneliner">${esc(guide.oneLiner)}</p>` : ''}
        <nav class="pd-guide-cta" aria-label="中文说明书目录">${(guide.sections ?? []).map((s,i)=>`<a href="#guide-chapter-${i}">${esc(s.heading)}</a>`).join(' · ')}</nav>
        ${(guide.sections ?? []).map((s,i) => `<div class="guide-sec" id="guide-chapter-${i}"><h3>${esc(s.heading)}</h3><p style="white-space:pre-wrap">${esc(s.text)}</p><p class="guide-cite">依据：${cite(s.evidenceIds)}</p></div>`).join('')}
        ${guide.unknowns?.length ? `<div class="guide-sec guide-unknown"><h3>原项目没有说明</h3><ul>${guide.unknowns.map((u) => `<li>${esc(u)}</li>`).join('')}</ul></div>` : ''}`
      : `<p class="muted">${esc(guide.message ?? '还没有生成中文导读。')}</p>`}
    ${release.length ? `<div class="guide-sec"><h3>官方发布包${gh.releaseVersion ? ` · ${esc(gh.releaseVersion)}` : ''}</h3><div class="dl-list">${release.map(dl).join('')}</div></div>` : ''}
    ${source.length ? `<div class="guide-sec"><h3>源代码</h3><p class="muted">源代码不是安装包，需要按原项目的说明构建。</p><div class="dl-list">${source.map(dl).join('')}</div></div>` : ''}
    ${gh.selection?.tested ? `<div class="guide-sec"><h3>实测记录</h3><p>${esc(gh.selection.testEvidence ?? '')}</p></div>` : ''}
    ${gh.readme ? `<details class="pd-readme"><summary>README 原文（来自 GitHub，未翻译）</summary><div class="md" lang="${/[一-鿿]/.test(gh.readme.slice(0, 400)) ? 'zh-CN' : 'en'}">${renderMarkdown(gh.readme)}</div></details>` : ''}
    <p class="pd-hint">${gh.stale ? '这次更新没有成功，显示的是上一次读取的内容。' : ''}读取于 ${timeAgo(gh.lastSuccess ?? gh.verifiedAt)}。</p>
  </section>`;
}

function bodyHTML(d) {
  const extras = (SECTIONS[e().kind] ?? [])
    .filter(([k]) => d[k])
    .map(([k, title]) => `<section class="pd-sec"><h2>${title}</h2>${md(d[k])}</section>`)
    .join('');
  const meta = [
    d.codeVersion && ['代码版本', d.codeVersion], d.dataVersion && ['数据版本', d.dataVersion],
    d.deadline && ['截止', d.deadline], d.ruleVersion && ['规则版本', d.ruleVersion], d.doi && ['DOI', d.doi],
  ].filter(Boolean);
  return `<section class="pd-sec" id="about"><h2>说明</h2>
      ${journalExpression(d)}
      ${d.sourceLanguage ? `<details><summary>中外文对照 · 原始介绍</summary>${Object.values(d.sourceLanguage).map(t=>md(t)).join('')}</details>` : ''}
      ${d.body ? md(d.body) : `<p class="muted">作者还没有写详细说明。${ghRepo(d.links?.repo) ? '可以先看上面的导读或者原项目的 README。' : ''}</p>`}
      ${d.maintenanceFacts?`<details><summary>执行记录 · 未解决事项</summary><ul>${d.maintenanceFacts.unresolved.map(r=>`<li>${esc(r.robot)}：${r.state==='failed'?'失败':'部分完成'} · ${esc(r.error||'')}</li>`).join('')||'<li>此次记录没有失败项；不代表全站没有问题。</li>'}</ul></details>`:''}
      ${meta.length ? `<dl class="pd-dl">${meta.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>` : ''}
    </section>${extras}`;
}

let disposePhotos = () => {};
let disposeFilm = () => {};
let renderVersion = 0;
function photosHTML(d) {
  if (st.view !== 'public') return '';
  const urls = (e().attachments || []).filter(a => /\.(png|jpe?g|webp)$/i.test(a.name || ''))
    .map(a => a.url).filter(u => /^\/api\/hub\/uploads\/[a-f0-9-]+\/file$/.test(u));
  if (!urls.length && safeURL(d.media?.src)) urls.push(d.media.src);
  if (!urls.length && /^\/art\/[a-zA-Z0-9_./-]+\.(webp|png|jpe?g)$/.test(d.autoMedia?.url || '')) urls.push(d.autoMedia.url);
  if (!urls.length) return '';
  const credit = d.media?.credit || d.autoMedia?.credit || '投稿配图';
  return `<figure class="pd-photos"><div class="${urls.length > 1 ? 'ds-track' : ''}">${depthSlides(urls, d.title || credit)}</div><figcaption>${esc(credit)}</figcaption></figure>`;
}
window.addEventListener('pagehide', () => disposePhotos());

function attachmentsHTML() {
  const list = st.view === 'public' ? e().attachments ?? [] : [];
  if (!list.length) return '';
  return `<section class="pd-sec" id="files"><h2>附件</h2><ul class="pd-files" role="list">${list
    .map((a) => `<li><a href="viewer.html?kind=upload&id=${esc(a.id)}"><b>${esc(a.name)}</b><span>${fmtBytes(a.bytes)}${a.pages ? ` · ${a.pages} 页` : ''} · 站内查看</span></a><a href="${esc(a.url)}" download>下载原件</a>
      <span class="tag${a.extraction === 'needs-ocr' || a.extraction === 'encrypted' ? ' tag-warn' : ''}">${EXTRACTION[a.extraction] ?? esc(a.extraction)}</span></li>`)
    .join('')}</ul></section>`;
}

function replyHTML(r) {
  const mine = st.user && r.author?.id === st.user.id;
  const canAccept = st.user && !mine && r.state === 'published' && !r.accepted && (isOwner() || isMod());
  return `<li class="pd-reply${r.accepted ? ' is-accepted' : ''}" id="reply-${esc(r.id)}" tabindex="-1" data-reply="${esc(r.id)}">
    <div class="pd-reply-head">${person(r.author, 28)}<span class="muted">@${esc(r.author?.username ?? '')} · ${timeAgo(r.created)}</span>
      ${r.accepted ? '<span class="tag tag-ok">已采纳</span>' : ''}
      ${r.state === 'pending' ? `<span class="tag tag-warn">${mine ? '等待审核，只有你和维护者看得到' : '待审核'}</span>` : ''}
      ${r.state === 'rejected' ? '<span class="tag tag-danger">未通过</span>' : ''}</div>
    ${md(r.body)}
    ${canAccept || (isMod() && r.state === 'pending')
      ? `<div class="pd-reply-acts">
        ${canAccept ? '<button class="btn-link" type="button" data-act="accept">采纳这个回答</button>' : ''}
        ${isMod() && r.state === 'pending' ? '<button class="btn btn-primary btn-sm" type="button" data-act="reply-ok">通过</button><button class="btn btn-outline btn-sm" type="button" data-act="reply-no">不通过</button>' : ''}
      </div>`
      : ''}
  </li>`;
}

function discussionHTML() {
  if (!hasPublic()) return '';
  const list = e().replies ?? [];
  const shown = list.filter((r) => r.state === 'published').length;
  let form;
  if (!st.user) form = `<p class="pd-hint"><a href="${esc(loginURL())}">登录</a>之后可以参与讨论。</p>`;
  else if (!canParticipate(st.user)) form = '<p class="pd-hint">验证邮箱之后可以参与讨论。<a href="me.html#account">去验证</a></p>';
  else
    form = `<form class="pd-reply-form" data-form="reply">
      <label class="sr-only" for="pd-reply-body">回复内容</label>
      <textarea id="pd-reply-body" name="body" rows="4" maxlength="20000" required placeholder="提问、复现结果、改进建议都可以。支持简单的 Markdown，@用户名 可以提醒对方。"></textarea>
      <div class="pd-reply-foot"><span class="pd-hint">新成员的回复要经过维护者审核才会公开。</span><button class="btn btn-primary btn-sm" type="submit">发表回复</button></div>
    </form>`;
  return `<section class="pd-sec" id="discussion"><h2>讨论 <span class="muted num">${shown}</span></h2>
    ${list.length ? `<ol class="pd-replies" role="list">${list.map(replyHTML).join('')}</ol>` : '<p class="muted">还没有人讨论。有问题、复现结果或者改进建议，都可以写在这里。</p>'}
    ${form}
  </section>`;
}

function taskHTML(t) {
  const [label, cls] = TASK[t.state] ?? [t.state, ''];
  const mine = st.user && t.assignee?.id === st.user.id;
  const canReview = (isOwner() || isMod()) && t.state === 'submitted';
  const canClaim = st.user && t.state === 'open' && !isOwner();
  const canSubmit = mine && ['claimed', 'changes-requested'].includes(t.state);
  return `<li class="pd-task" data-task="${esc(t.id)}">
    <div class="pd-task-top"><b>${esc(t.title)}</b><span class="tag ${cls}">${label}</span>${t.beginner ? '<span class="tag tag-accent">适合新手</span>' : ''}</div>
    ${t.description ? `<p>${esc(t.description)}</p>` : ''}
    ${t.assignee ? `<p class="pd-hint">认领：${esc(t.assignee.name)}${safeURL(t.evidence) ? ` · <a href="${esc(t.evidence)}" target="_blank" rel="noopener">提交的成果</a>` : ''}</p>` : ''}
    ${t.note ? `<p class="pd-note"><b>核对意见</b>${esc(t.note)}</p>` : ''}
    ${canClaim ? '<button class="btn btn-outline btn-sm" type="button" data-act="claim">认领</button>' : ''}
    ${canSubmit ? `<form class="pd-inline-form" data-form="task-submit"><label class="sr-only" for="ev-${esc(t.id)}">成果链接</label><input id="ev-${esc(t.id)}" name="evidence" type="url" required placeholder="成果链接，比如 Pull Request"><button class="btn btn-primary btn-sm" type="submit">提交</button></form>` : ''}
    ${canReview ? `<form class="pd-inline-form" data-form="task-review"><label class="sr-only" for="tn-${esc(t.id)}">核对意见</label><input id="tn-${esc(t.id)}" name="note" required maxlength="2000" placeholder="核对意见"><button class="btn btn-outline btn-sm" type="submit" name="approve" value="0">需要修改</button><button class="btn btn-primary btn-sm" type="submit" name="approve" value="1">通过</button></form>` : ''}
  </li>`;
}

// 本站下载：维护机器人从 GitHub 正式发布镜像过来的文件（只限允许再分发的开源许可证）
function downloadHTML() {
  const repo = ghRepo(viewData().links?.repo);
  if (!repo) return '';
  const m = st.mirror;
  const original = `<a class="pd-dl-origin" href="https://github.com/${esc(repo)}/releases" target="_blank" rel="noopener">去 GitHub 原站下载 ↗</a>`;
  const refresh = isMod() ? '<button class="btn btn-outline btn-sm" type="button" data-act="mirror-refresh">镜像最新版</button>' : '';
  let body;
  if (!m) body = '<p class="muted">正在读取本站镜像…</p>';
  else if (m.error) body = `<p class="muted">本站镜像暂时读不到：${esc(m.error)}</p>`;
  else if (m.items?.some(f=>f.available))
    body = `<ul class="pd-dl" role="list">${m.items.filter(f=>f.available).map((f) => `<li>
        <div><b>${esc(f.name)}</b><span>${esc(f.tag)} · ${fmtBytes(f.size)} · ${esc(f.license)}${f.downloads ? ` · 本站下载 ${fmtNum(f.downloads)} 次` : ''}</span>
          <details><summary>版本与文件校验</summary><code style="overflow-wrap:anywhere;white-space:normal">SHA-256 ${esc(f.sha256)}</code><p>${f.integrity==='upstream-sha256-matched'?'已与 GitHub 官方 SHA-256 核对一致':'本站计算的 SHA-256；上游未提供可比对校验值'}</p><p>${f.kind==='source-archive'?'源码包，需要按项目说明构建':`系统：${esc(f.platform==='unknown'?'原文件名未说明':f.platform)} · 架构：${esc(f.architecture==='unknown'?'未确认':f.architecture)}`}</p>${f.licenseUrl?`<a href="${esc(f.licenseUrl)}" download>下载许可证与署名</a>`:''}</details></div>
        <a class="btn btn-outline btn-sm" href="viewer.html?kind=mirror&id=${esc(f.id)}">查看文件</a><a class="btn btn-primary btn-sm" href="${esc(f.url)}" data-accelerate data-filename="${esc(f.name)}" download="${esc(f.name)}">加速下载</a></li>`).join('')}</ul>
      <p class="pd-hint">文件从原仓库原样保存，保留版本、来源与许可证。本站下载不依赖访问 GitHub；安装依赖、模型或联网服务可能仍需连接外部平台。</p>`;
  else if (m.status === 'license-blocked') body = `<p class="muted">${esc(m.reason || '这个仓库没有声明允许再分发的开源许可证，本站不能转存。')}</p>`;
  else body = '<p class="muted">本站还没有镜像这个项目的发布包。</p>';
  return `<section class="pd-card card pd-download"><h2>下载</h2>${body}<div class="pd-dl-foot">${original}${refresh}</div></section>`;
}

function sideHTML(d) {
  const links = Object.entries(d.links ?? {}).filter(([, u]) => safeURL(u));
  const info = [
    CATEGORIES[d.category] && ['分类', CATEGORIES[d.category].name],
    d.course && ['课程', d.course], (d.courses ?? []).length && ['相关课程', d.courses.join('、')],
    d.year && ['年份', d.year], d.difficulty && ['难度', d.difficulty],
    d.sourceNote && ['来源说明', d.sourceNote], d.aiDisclosure && ['AI 使用说明', d.aiDisclosure],
  ].filter(Boolean);
  const ext = d.externalStats;
  const gh = st.gh && typeof st.gh === 'object' ? st.gh : null;
  const stars = gh?.stars ?? ext?.stars;
  const tasks = e().tasks ?? [];
  const versions = st.history?.items ?? [];
  return `<aside class="pd-side">
    ${downloadHTML()}
    ${links.length ? `<section class="pd-card card"><h2>链接</h2><ul class="pd-links" role="list">${links
      .map(([k, u]) => `<li><a href="${esc(u)}" target="_blank" rel="noopener"><span>${LINKS[k] ?? esc(k)}</span><span class="pd-host">${esc(new URL(u).hostname.replace(/^www\./, ''))}</span></a></li>`)
      .join('')}</ul></section>` : ''}
    ${info.length || d.tags?.length ? `<section class="pd-card card"><h2>信息</h2>
      ${info.length ? `<dl class="pd-dl">${info.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>` : ''}
      ${d.tags?.length ? `<p class="pd-taglist">${d.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</p>` : ''}
    </section>` : ''}
    ${stars != null || hasPublic() ? `<section class="pd-card card"><h2>数据</h2>
      <dl class="pd-stats">
        ${hasPublic() ? `<div><dt>本站收藏</dt><dd class="num">${fmtNum(e().siteStars ?? 0)}</dd></div>` : ''}
        ${stars != null ? `<div><dt>GitHub ★</dt><dd class="num">${fmtNum(stars)}</dd></div>` : ''}
        ${ext?.forks != null ? `<div><dt>Fork</dt><dd class="num">${fmtNum(ext.forks)}</dd></div>` : ''}
        ${(gh?.language ?? ext?.language) ? `<div><dt>主要语言</dt><dd>${esc(gh?.language ?? ext.language)}</dd></div>` : ''}
      </dl>
      ${stars != null ? `<p class="pd-hint">GitHub ★ 来自 GitHub${ext?.checkedAt || gh?.lastSuccess ? `，核对于 ${timeAgo(gh?.lastSuccess ?? ext.checkedAt)}` : ''}，和本站收藏分开计算。</p>` : ''}
    </section>` : ''}
    ${hasPublic() && (tasks.length || isOwner() || isMod()) ? `<section class="pd-card card" id="tasks"><h2>可以帮忙的事</h2>
      ${tasks.length ? `<ul class="pd-tasks" role="list">${tasks.map(taskHTML).join('')}</ul>` : '<p class="muted">还没有任务。</p>'}
      ${isOwner() || isMod() ? `<details class="pd-inline"><summary>添加任务</summary><form class="pd-stack" data-form="task-add">
        <input name="title" maxlength="160" required placeholder="任务标题，比如：补充接线图">
        <textarea name="description" rows="3" maxlength="5000" required placeholder="要做什么、做到什么程度算完成"></textarea>
        <label class="pd-check"><input type="checkbox" name="beginner" checked> 适合新手</label>
        <button class="btn btn-primary btn-sm" type="submit">添加</button></form></details>` : ''}
    </section>` : ''}
    ${versions.length ? `<section class="pd-card card"><h2>版本记录</h2><ol class="pd-versions" role="list">${versions
      .map((v) => `<li><span class="num">第 ${v.revision} 版</span><span class="tag ${(STATE[v.state] ?? ['', ''])[1]}">${(STATE[v.state] ?? [v.state])[0]}</span>${v.note ? `<p>${esc(v.note)}</p>` : ''}</li>`)
      .join('')}</ol>
      ${hasPublic() && (isOwner() || isMod()) && e().kind === 'project' ? `<details class="pd-inline"><summary>发布新版本</summary><form class="pd-stack" data-form="release">
        <input name="version" maxlength="100" required placeholder="版本号，比如 v1.2">
        <input name="url" type="url" required placeholder="发布页或下载链接">
        <textarea name="note" rows="2" maxlength="1000" required placeholder="这一版改了什么"></textarea>
        <button class="btn btn-primary btn-sm" type="submit">发布并通知关注的人</button></form></details>` : ''}
    </section>` : ''}
    ${hasPublic() ? `<details class="pd-report"><summary>报告问题</summary><form class="pd-stack" data-form="report">
      <textarea name="reason" rows="3" maxlength="2000" required placeholder="例如：链接失效、侵权、内容和描述不符"></textarea>
      <button class="btn btn-outline btn-sm" type="submit">提交给维护者</button></form></details>` : ''}
  </aside>`;
}

let replyLocated = false;
function render() {
  disposePhotos(); disposeFilm();
  const version = ++renderVersion;
  const d = st.view === 'draft' ? viewData() : chinesePresentation(viewData(), st.gh?.guide);
  const focusedReply = document.activeElement?.closest('.pd-reply')?.id;
  document.title = `${d.title ?? '内容'} · Luokixi`;
  main.innerHTML = `<div class="wrap" data-content-key="entry/${esc(e().id)}">
    ${headHTML(d)}
    <div class="pd-grid">
      <div class="pd-main">
        ${ownerBarHTML()}
        ${photosHTML(d)}
        ${guideHTML(d)}
        ${st.gh?.guide?.reviewState==='reviewed'?'<section class="pd-sec pd-film"><h2>用短片了解项目</h2><button type="button" data-film-open>打开中文讲解</button><div data-project-film></div></section>':''}
        ${bodyHTML(d)}
        ${attachmentsHTML()}
        ${discussionHTML()}
      </div>
      ${sideHTML(d)}
    </div>
  </div>`;
  disposePhotos = mountDepthSlider(main.querySelector('.pd-photos .ds-track'));
  main.querySelector('[data-film-open]')?.addEventListener('click', async event => { const {mountProjectFilm}=await import('../js/project-film.js'); if(version!==renderVersion)return; event.target.hidden=true; disposeFilm=mountProjectFilm(main.querySelector('[data-project-film]'),{title:d.title,guide:st.gh.guide,source:d.links.repo}); });
  if (focusedReply) document.getElementById(focusedReply)?.focus({ preventScroll: true });
  if (!replyLocated && /^#reply-[a-f0-9-]{36}$/i.test(location.hash)) {
    const anchor = location.hash;
    requestAnimationFrame(() => {
      if (replyLocated || location.hash !== anchor) return;
      const target = document.getElementById(anchor.slice(1));
      if (target) {
        replyLocated = true;
        target.focus({ preventScroll: true });
        target.scrollIntoView({ block: 'center', behavior: 'instant' });
      }
    });
  }
}

function renderMessage(title, text, action = '') {
  main.innerHTML = `<div class="wrap pd-msg"><div class="empty-card"><p class="empty-title">${title}</p><p>${text}</p>${action}</div></div>`;
}

// ---------- 交互 ----------

async function reload() {
  st.entry = await hubApi.entry(e().id);
  if (st.view === 'draft' && !editorial()) st.view = 'public';
  render();
}

async function act(btn) {
  const a = btn.dataset.act;
  if (a === 'mirror-refresh') {
    const repo = ghRepo(viewData().links?.repo);
    await hubApi.refreshMirror(repo);
    return toast('已排队：后台机器人会检查许可证并镜像最新的正式版，稍后刷新这一页。');
  }
  const x = e();
  if (a === 'star') {
    if (blocked('收藏')) return;
    const r = await hubApi.star(x.id, !x.starred);
    Object.assign(x, { starred: Boolean(r.starred), siteStars: r.siteStars ?? x.siteStars });
    toast(x.starred ? '已收藏，在“我的 · 收藏”里能找到。' : '已取消收藏。');
    return render();
  }
  if (a === 'submit') {
    await hubApi.submit(x.id, x.editRevision);
    toast('已提交，等维护者核对。');
    return reload();
  }
  if (a === 'inspect') {
    if (blocked('读取仓库')) return;
    btn.textContent = '正在读取…';
    const job = await hubApi.inspectGithub(ghRepo(viewData().links.repo));
    for (let i = 0; i < 30; i += 1) {
      await new Promise((r) => setTimeout(r, 1500));
      const j = await hubApi.job(job.id);
      if (j.state === 'done') return loadGithub();
      if (j.state === 'failed') throw new HubError(j.error || '读取没有成功。');
    }
    throw new HubError('读取时间太长了，稍后刷新页面看看。');
  }
  const replyEl = btn.closest('[data-reply]');
  if (replyEl) {
    const id = replyEl.dataset.reply;
    if (a === 'accept') await hubApi.accept(id);
    if (a === 'reply-ok') await hubApi.reviewReply(id, true);
    if (a === 'reply-no') {
      const reason = prompt('不通过的原因（会记录在审核日志里）：');
      if (!reason?.trim()) return;
      await hubApi.reviewReply(id, false, reason.trim());
    }
    toast({ accept: '已采纳。', 'reply-ok': '已通过，回复公开了。', 'reply-no': '已标记为不通过。' }[a]);
    return reload();
  }
  const taskEl = btn.closest('[data-task]');
  if (taskEl && a === 'claim') {
    if (blocked('认领任务')) return;
    await hubApi.claimTask(taskEl.dataset.task);
    toast('认领成功。做完以后，把成果链接提交在这里。');
    return reload();
  }
}

main.addEventListener('click', async (ev) => {
  const v = ev.target.closest('[data-view]');
  if (v) {
    st.view = v.dataset.view;
    render();
    return;
  }
  const btn = ev.target.closest('button[data-act]');
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  try {
    await act(btn);
  } catch (err) {
    toast(err.message ?? '操作没有成功。');
  } finally {
    btn.disabled = false;
  }
});

main.addEventListener('submit', async (ev) => {
  const f = ev.target;
  const kind = f.dataset.form;
  if (!kind) return;
  ev.preventDefault();
  const x = e();
  const val = (k) => f.elements[k]?.value.trim() ?? '';
  const buttons = $$('button', f);
  buttons.forEach((b) => (b.disabled = true));
  try {
    if (kind === 'watch') {
      if (blocked('关注')) return;
      const events = ['release', 'discussion', 'revision'].filter((k) => f.elements[k].checked);
      const r = await hubApi.watch(x.id, events);
      x.watch = r.watch ?? events;
      toast(events.length ? '已更新关注，提醒会出现在“我的 · 通知”里。' : '已取消关注。');
      return render();
    }
    if (kind === 'reply') {
      const r = await hubApi.reply(x.id, val('body'));
      toast(r.state === 'published' ? '已发表。' : '已收到，审核通过后公开。');
      return reload();
    }
    if (kind === 'review') {
      const decision = ev.submitter?.value === 'approve' ? 'approve' : 'reject';
      await hubApi.review(x.id, x.editRevision, decision, val('note'));
      toast(decision === 'approve' ? '已通过，内容公开了。' : '已退回，作者会收到你的意见。');
      st.view = 'public';
      return reload();
    }
    if (kind === 'withdraw') {
      await hubApi.withdraw(x.id, val('reason'));
      toast('已撤回。');
      return reload().catch(() => renderMessage('已经撤回。', '这条内容不再公开。', '<a class="btn btn-primary" href="me.html#entries">回到我的投稿</a>'));
    }
    if (kind === 'task-add') {
      await hubApi.addTask(x.id, { title: val('title'), description: val('description'), beginner: f.elements.beginner.checked });
      toast('任务已添加。');
      return reload();
    }
    if (kind === 'task-submit') {
      await hubApi.submitTask(f.closest('[data-task]').dataset.task, val('evidence'));
      toast('已提交，等作者核对。');
      return reload();
    }
    if (kind === 'task-review') {
      await hubApi.reviewTask(f.closest('[data-task]').dataset.task, ev.submitter?.value === '1', val('note'));
      toast('已记录核对结果。');
      return reload();
    }
    if (kind === 'release') {
      const r = await hubApi.release(x.id, { version: val('version'), url: val('url'), note: val('note') });
      toast(r.created ? '已发布，关注版本的同学会收到通知。' : '这个版本之前已经发布过了。');
      f.closest('details').open = false;
      return;
    }
    if (kind === 'report') {
      if (blocked('报告问题')) return;
      await hubApi.report(x.id, val('reason'));
      f.reset();
      f.closest('details').open = false;
      toast('已经交给维护者，谢谢。');
    }
  } catch (err) {
    toast(err.message ?? '操作没有成功。');
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
});

// 点关注菜单以外的地方时收起
document.addEventListener('click', (ev) => {
  const open = $('.pd-watch[open]');
  if (open && !open.contains(ev.target)) open.open = false;
});

// ---------- 启动 ----------

async function loadHistory() {
  try {
    st.history = await hubApi.history(e().id);
    render();
  } catch { /* 版本记录读不到不影响正文 */ }
}

async function loadMirror() {
  const repo = ghRepo(viewData().links?.repo);
  if (!repo) return;
  try {
    st.mirror = await hubApi.mirror(repo);
  } catch (err) {
    st.mirror = { error: err.message ?? '读取失败' };
  }
  render();
}

async function loadGithub() {
  const repo = ghRepo(viewData().links?.repo);
  if (!repo) return;
  try {
    st.gh = await hubApi.githubProject(repo);
  } catch (err) {
    st.gh = err.status === 404 ? 'missing' : null;
    st.ghError = err.message ?? '';
  }
  render();
}

(async () => {
  const s = await hubState();
  st.online = s.online;
  st.user = s.user;
  if (!st.online)
    return renderMessage(
      '社区服务没有连接。',
      '内容详情、讨论和收藏都保存在社区服务里。现在打开的是只读的静态页面，可以先去开源广场看看公开目录。',
      '<a class="btn btn-primary" href="projects.html">去开源广场</a>',
    );
  try {
    let id = params.get('id');
    if (!id && params.get('slug')) id = (await hubApi.catalogue({ slug: params.get('slug') })).items?.[0]?.id;
    if (!id) throw new HubError('内容不存在。', 404);
    const entry = await hubApi.entry(id);
    // 地点在校园地图里看，那里有坐标、照片和现场反馈
    if (entry.kind === 'place') return location.replace(`map.html?place=${encodeURIComponent(entry.id)}`);
    st.entry = entry;
    st.view = hasPublic() ? 'public' : 'draft';
    render();
    loadHistory();
    loadGithub();
    loadMirror();
  } catch (err) {
    if (err.status === 404)
      renderMessage('找不到这条内容。', '它可能不存在、已经撤回，或者还在审核中（审核中的内容只有作者和维护者能看到）。', '<a class="btn btn-primary" href="projects.html">去开源广场</a>');
    else renderMessage('没有加载出来。', esc(err.message ?? '请稍后再试。'), '<button class="btn btn-primary" type="button" onclick="location.reload()">重试</button>');
  }
})();
