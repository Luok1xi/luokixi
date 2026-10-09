// 我的：账户 / 我的投稿 / 收藏 / 搭建清单 / 通知 / 资料设置 / 本机足迹
// 线上数据来自 /api/hub/me 与 /notifications；本机足迹来自 Codex 的 community-notebook（不需要登录）。
import { initShell } from '../js/shell.js';
import { hubApi, hubState, loginURL } from '../js/hub.js';
import { createNotebook } from '../js/community-notebook.js';
import { avatarHTML, timeAgo } from '../js/community.js';
import { esc } from '../js/data.js';
import '../styles/account.css';
import {mountContribution} from '../js/contribution-view.js';
import { projectReviews, newsReviews, guideReviews } from '../js/maintenance-review.js';
import { supervisorReviews } from '../js/supervisor-review.js';
import { mountBeikuang, stopBeikuang } from '../js/beikuang-chat.js';
import { mountCodexChat, stopCodexChat } from '../js/codex-chat.js';
import { mountOperations } from '../js/operations-panel.js';

initShell();

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const main = $('#me-main');

const KIND = {
  project: '项目', resource: '资料', paper: '论文', reproduction: '复现', topic: '讨论',
  contest: '竞赛', news: '资讯', announcement: '公告', collection: '合集', place: '地点',
};
// 投稿状态：草稿 → 待审核 → 已公开 / 已退回；撤回单列
const STATE = {
  draft: ['草稿', ''], pending: ['待审核', 'tag-warn'], approved: ['已公开', 'tag-ok'], published: ['已公开', 'tag-ok'],
  rejected: ['已退回', 'tag-danger'], withdrawn: ['已撤回', ''],
};
const PLATFORMS = [
  ['github', 'GitHub', 'https://github.com/你的用户名'],
  ['luogu', '洛谷', 'https://www.luogu.com.cn/user/你的UID'],
  ['leetcode', '力扣', 'https://leetcode.cn/u/你的ID/'],
  ['codeforces', 'Codeforces', 'https://codeforces.com/profile/你的用户名'],
];

const st = { online: false, user: null, me: null, notes: null, contrib: null, reviewNotice: null, reviewBusy: false };

// 试行等级：只按“被采纳的公共贡献”次数算（不含 Star、外部刷题和匿名评价），规则写在页面上
const LEVELS = [[0, 'Lv1 新同学'], [1, 'Lv2 参与者'], [5, 'Lv3 贡献者'], [15, 'Lv4 共建者'], [40, 'Lv5 引路人']];
const levelOf = (n) => {
  let i = 0;
  LEVELS.forEach(([min], k) => { if (n >= min) i = k; });
  const next = LEVELS[i + 1];
  return { name: LEVELS[i][1], next: next ? next[1] : null, need: next ? next[0] - n : 0, progress: next ? (n - LEVELS[i][0]) / (next[0] - LEVELS[i][0]) : 1 };
};

// 奖项：服务端还没有奖项和核验字段，先记在这台电脑上，明确“未核验”
const AWARD_KEY = 'luokixi.me.awards.v1';
const AWARD_LEVELS = ['校级', '省级 / 赛区', '国家级', '国际'];
const readAwards = () => {
  try { const v = JSON.parse(localStorage.getItem(AWARD_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
};
const writeAwards = (list) => {
  try { localStorage.setItem(AWARD_KEY, JSON.stringify(list)); return true; } catch { return false; }
};
let notebook = null;
try { notebook = createNotebook(); } catch { /* 浏览器存储不可用 */ }

const empty = (title, text, action = '') => `<div class="empty-card"><p class="empty-title">${title}</p><p>${text}</p>${action}</div>`;
const needLogin = () =>
  st.online
    ? empty('登录后才能看到这一部分。', '投稿、收藏、搭建清单和通知都保存在你的账号里。', `<a class="btn btn-primary" href="${esc(loginURL())}">登录</a>`)
    : empty('社区服务未连接。', '现在只能使用“本机足迹”。连接社区服务后，可以登录查看投稿和收藏。');

const titleOf = (e) => (e.draft?.title || e.data?.title || '未命名');
const noticeHref = (value) => {
  if (typeof value !== 'string') return null;
  try { const target = new URL(value, location.href); return target.origin === location.origin && /\/(?:circle|project|reputation|me)\.html$/.test(target.pathname) ? target.pathname + target.search + target.hash : null; } catch { return null; }
};

// ---------- 各分区 ----------

let disposeContribution;
const TASK_NAMES = { github: 'GitHub 项目采集', news: '学校新闻', notices: '图书馆 / 体育部公告', links: '官方链接巡检', media: '项目配图（README）', mirror: '本站下载镜像', organize:'分类机器人', summaries:'详细中文导读机器人', supervisor:'北矿娘 · 总监督', beikuang:'北矿娘 · 巡检审核' };
const REVIEW_TITLES = {'review-github':'审核候选项目','review-news':'审核学校新闻','review-guides':'审核中文说明书','review-supervisor':'北矿娘的请示与公告'};
const TASK_STATE = { done: ['完成', 'tag-ok'], partial: ['部分完成', 'tag-warn'], queued: ['排队中', 'tag-warn'], running: ['运行中', 'tag-warn'], failed: ['失败', 'tag-danger'], never: ['还没运行', ''] };
const fmtWhen = (iso) => (iso ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)) : '—');

function taskSummary(task, r = {}) {
  if (task === 'organize') return r.classified != null ? `已归档 ${r.classified} 个项目` : '';
  if (task === 'summaries') return r.generated ? `生成 ${r.generated.length} 份说明书 · 等待核对` : '';
  if (task === 'supervisor') return r.questions ? `${r.questions.length} 个项目需要你拿主意` : '';
  if (task === 'github') return r.created ? `新增 ${r.created.length} 个候选 · 更新 ${r.refreshed?.length ?? 0} 个 · 等待人工核对` : '';
  if (task === 'news') return r.created ? `新发现 ${r.created.length} 条（列表里共 ${r.listed ?? 0} 条）` : '';
  if (task === 'notices') return r.sports != null ? `体育部 ${r.sports} 条 · 图书馆 ${r.library} 条${r.libraryStatus === 'needs-browser' ? '（图书馆需要浏览器组件）' : ''}` : '';
  if (task === 'links') return r.checked != null ? `检查 ${r.checked} 个，${r.broken} 个打不开` : '';
  if (task === 'media') return r.projects != null ? `${r.projects} 个项目，${r.withImage} 个找到配图` : '';
  if (task === 'mirror') return r.repositories != null ? `${r.repositories} 个仓库，新镜像 ${r.mirrored} 个文件，${r.blocked} 个因许可证只给原站链接` : '';
  return '';
}

// ---------- 手机同步：App 在手机上登录学校账号取到数据，同步到本人账号，电脑端只读展示 ----------
// 数据结构由 App 定：常见是 {items:[{...}]}；认不出来的就按“字段：值”原样列出，不猜含义。
const SYNC_ORDER = ['seat', 'timetable', 'exam', 'library', 'card', 'grades'];
const FIELD = {
  date: '日期', start: '开始', end: '结束', area: '区域', seat: '座位', status: '状态', room: '地点', building: '楼',
  course: '课程', teacher: '老师', weekday: '星期', weeks: '周次', time: '时间', title: '书名', author: '作者',
  due: '应还', borrowed: '借出', balance: '余额', amount: '金额', place: '地点', score: '成绩', credit: '学分',
  term: '学期', gpa: '绩点', kind: '类型', name: '名称', seatNo: '座位号',
};
const cell = (v) => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

function syncTable(data) {
  const items = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : null;
  const extra = !Array.isArray(data) && data && typeof data === 'object' ? Object.entries(data).filter(([k]) => k !== 'items') : [];
  let html = '';
  if (extra.length) html += `<dl class="me-dl me-sync-kv">${extra.map(([k, v]) => `<div><dt>${esc(FIELD[k] ?? k)}</dt><dd>${esc(cell(v))}</dd></div>`).join('')}</dl>`;
  if (items) {
    if (!items.length) return `${html}<p class="muted">没有记录。</p>`;
    const keys = [...new Set(items.slice(0, 50).flatMap((x) => (x && typeof x === 'object' ? Object.keys(x) : [])))].slice(0, 8);
    html += keys.length
      ? `<div class="me-sync-scroll"><table class="me-sync-table"><thead><tr>${keys.map((k) => `<th>${esc(FIELD[k] ?? k)}</th>`).join('')}</tr></thead>
          <tbody>${items.slice(0, 200).map((x) => `<tr>${keys.map((k) => `<td>${esc(cell(x?.[k]))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
      : `<ul class="me-plain">${items.slice(0, 200).map((x) => `<li>${esc(cell(x))}</li>`).join('')}</ul>`;
    if (items.length > 200) html += `<p class="muted">只显示前 200 条，共 ${items.length} 条。</p>`;
  }
  return html || '<p class="muted">没有记录。</p>';
}

// 北矿娘的未读：导航上的角标、通知页顶部的提示
function setBkUnread(n) {
  st.bkUnread = n || 0;
  const badge = $('#bk-unread');
  if (badge) { badge.hidden = !st.bkUnread; badge.textContent = st.bkUnread; }
}

const SECTIONS = {
  codex() {
    if (!st.user) return needLogin();
    if (!st.user.moderator) return empty('Codex 仅向本机站主开放。', '');
    return '<div id="codex-root"></div>';
  },
  beikuang() {
    if (!st.user) return needLogin();
    if (!st.user.moderator) return `<h2 class="me-h">北矿娘</h2>${empty('只有维护者能和北矿娘对话。', '')}`;
    return '<div id="bk-root"></div>';
  },

  synced() {
    if (!st.user) return needLogin();
    const sy = st.sync;
    if (!sy) return '<h2 class="me-h">手机同步</h2><p class="acct-sub">正在读取…</p>';
    if (sy.error) return `<h2 class="me-h">手机同步</h2><p class="acct-err">${esc(sy.error)}</p>`;
    const kinds = SYNC_ORDER.filter((k) => sy.items?.[k]);
    return `<div class="me-h-row"><h2 class="me-h">手机同步</h2>${kinds.length ? '<button class="btn btn-outline btn-sm" type="button" data-sync-clear="all">清除全部同步数据</button>' : ''}</div>
      <p class="acct-sub">座位、课表、成绩这些数据由手机 App 在你的手机上登录学校账号取得，再同步到你的 Luokixi 账号，只有你自己能看到。<b>网站和服务器不保存学校账号和密码，也不会代你登录学校系统。</b></p>
      ${kinds.length ? kinds.map((k) => {
        const it = sy.items[k];
        const when = it.fetchedAt || it.syncedAt;
        const head = `<span class="me-sync-title"><b>${esc(it.label)}</b><span>${when ? `手机取得于 ${esc(timeAgo(when))}` : ''}${it.source ? ` · ${esc(it.source)}` : ''}</span></span>
          <button class="me-x" type="button" data-sync-clear="${esc(k)}">删除</button>`;
        return it.sensitive
          ? `<details class="card me-card me-sync"><summary class="me-sync-head">${head}<span class="me-sync-hint">点开显示</span></summary>${syncTable(it.data)}</details>`
          : `<section class="card me-card me-sync"><div class="me-sync-head">${head}</div>${syncTable(it.data)}</section>`;
      }).join('') : `<div class="ap-empty"><b>还没有从手机同步过数据。</b><p>在 Luokixi 手机 App 里登录学校账号，打开“同步到电脑”，选择要同步的内容（座位、课表、考试、借阅、校园卡、成绩可以分别开关）。</p></div>`}
      <p class="me-msg" role="status"></p>`;
  },

  maintenance() {
    if (!st.user?.moderator) return `<h2 class="me-h">维护机器人</h2>${empty('只有维护者能看到这里。', '维护机器人的运行状态和待审核的新闻只对维护者开放。')}`;
    const m = st.maint;
    if (!m) return '<h2 class="me-h">维护机器人</h2><p class="acct-sub">正在读取采集状态…</p><div data-operations-panel></div>';
    if (m.error) return `<h2 class="me-h">维护机器人</h2><p class="acct-err">采集状态暂不可用：${esc(m.error)}</p><div data-operations-panel></div>`;
    const tasks = Object.entries(m.tasks ?? {});
    const repos = Object.values(m.mirror ?? {});
    const lib = m.notices?.library ?? {};
    return `<div class="me-h-row"><h2 class="me-h">维护机器人</h2><button class="btn btn-primary btn-sm" type="button" data-run="all">全部运行一次</button></div>
      <p class="acct-sub">机器人定时读学校公开网站（先看 robots.txt，每次有数量上限），抓到的新闻先进“待审核”，你点通过才会上首页和校圈头条。学校图片只引用原图地址并保留署名，不复制。</p>
      <ul class="ap-list me-maint">${tasks.map(([task, t]) => {
        const [label, cls] = TASK_STATE[t.state] ?? [t.state, ''];
        return `<li class="ap-row"><span class="ap-row-text"><b>${esc(TASK_NAMES[task] ?? task)}</b><span>每 ${t.everyHours} 小时 · 上次 ${esc(fmtWhen(t.updated))}${taskSummary(task, t.result) ? ` · ${esc(taskSummary(task, t.result))}` : ''}${t.error ? ` · ${esc(t.error)}` : ''}</span></span>
          <span class="tag ${cls}">${label}</span><button class="btn btn-secondary btn-sm" type="button" data-run="${esc(task)}">运行</button></li>`;
      }).join('')}</ul>

      <div data-operations-panel></div>
      ${projectReviews(m)}
      ${newsReviews(m)}
      ${guideReviews(m)}
      ${supervisorReviews(m)}

      <h3 class="me-h3">打不开的官方链接 <span class="muted num">${m.brokenLinks?.length ?? 0}</span></h3>
      ${m.brokenLinks?.length ? `<ul class="me-plain">${m.brokenLinks.map((l) => `<li><a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.url)}</a> <span class="muted">${esc(l.where)} · ${esc(l.error ?? '')}</span></li>`).join('')}</ul>` : '<p class="muted">上次巡检没有发现坏链接。</p>'}

      <h3 class="me-h3">本站下载镜像</h3>
      ${repos.length ? `<ul class="ap-list">${repos.map((r) => `<li class="ap-row"><span class="ap-row-text"><b>${esc(r.repository)}</b><span>${r.status === 'license-blocked' ? `只给原站链接：${esc(r.reason ?? '')}` : r.status === 'ok' ? `${esc(r.license)} · ${esc(r.tag ?? '')} · 本次新镜像 ${r.mirrored?.length ?? 0} 个文件` : esc(r.reason ?? r.status ?? '')}</span></span>
          <span class="tag ${r.status === 'ok' ? 'tag-ok' : r.status === 'license-blocked' ? '' : 'tag-danger'}">${r.status === 'ok' ? '已镜像' : r.status === 'license-blocked' ? '许可不允许' : '失败'}</span>
          <button class="btn btn-secondary btn-sm" type="button" data-mirror="${esc(r.repository)}">重新检查</button></li>`).join('')}</ul>` : '<p class="muted">还没有镜像记录。点上面“本站下载镜像”的运行，会检查开源广场里每个项目的最新正式版。</p>'}

      <h3 class="me-h3">图书馆与体育部公告</h3>
      <p class="muted">${lib.status === 'needs-browser' ? esc(lib.reason) : lib.status === 'ok' ? `图书馆 ${lib.items?.length ?? 0} 条` : '还没读取'} · 体育部 ${m.notices?.sports?.length ?? 0} 条 · 显示在地图的楼的小窗里</p>
      <p class="me-msg" role="status"></p>`;
  },

  growth() {
    if (!st.user) return needLogin();
    const u = st.me?.profile ?? st.user;
    const prefs = u.preferences ?? {};
    const n = st.contrib?.total ?? null;
    const lv = n == null ? null : levelOf(n);
    const goals = prefs.goals ?? [];
    const interests = prefs.interests ?? [];
    return `<h2 class="me-h">成长</h2>
      <section class="ap-list me-level">
        <div class="ap-row"><span class="me-level-badge">${lv ? esc(lv.name.split(' ')[0]) : '…'}</span>
          <span class="ap-row-text"><b>${lv ? esc(lv.name) : '正在读取贡献记录'}</b><span>${n == null ? '' : lv.next ? `已被采纳 ${n} 次贡献 · 再 ${lv.need} 次升到 ${esc(lv.next)}` : `已被采纳 ${n} 次贡献 · 最高等级`}</span></span>
          <a class="ap-more" href="#contributions">贡献记录</a></div>
        ${lv ? `<div class="me-level-bar" aria-hidden="true"><i style="transform:scaleX(${lv.progress.toFixed(3)})"></i></div>` : ''}
        <p class="ap-sub me-level-rule">试行规则：只按被采纳的公共贡献次数算（资料修正、项目说明、任务成果、复现报告等），不含 Star、外部刷题和匿名评价。规则调整前会公示。</p>
      </section>

      <h3 class="me-h3">生涯规划</h3>
      <form class="ap-list me-goals" id="goals-form">
        ${goals.length ? goals.map((g, i) => `<div class="ap-row me-goal"><span class="me-goal-n num">${i + 1}</span>
          <span class="ap-row-text"><b>${esc(g)}</b><span><a href="materials.html?q=${encodeURIComponent(g)}">找资料</a> · <a href="circle.html?q=${encodeURIComponent(g)}">找同伴</a> · <a href="./#chances">看比赛</a></span></span>
          <button class="me-x" type="button" data-goal-x="${i}" aria-label="删掉这个目标">删除</button></div>`).join('')
          : '<div class="ap-row"><span class="ap-row-text"><b>还没有目标。</b><span>写下一个具体的目标，比如“大二参加电赛”“六级考到 500 分”“做一个开源机械臂”。</span></span></div>'}
        <div class="ap-row me-goal-add"><input name="goal" maxlength="80" placeholder="添加一个目标（最多 12 个）" ${goals.length >= 12 ? 'disabled' : ''}><button class="btn btn-primary btn-sm" type="submit" ${goals.length >= 12 ? 'disabled' : ''}>添加</button></div>
      </form>
      <p class="ap-sub">目标保存在你的账号里，只有你自己看得到，用来推荐和你相关的资料、讨论和比赛。</p>

      <h3 class="me-h3">兴趣</h3>
      <form class="me-tags" id="interests-form">
        ${interests.map((t, i) => `<span class="tag">${esc(t)}<button type="button" data-interest-x="${i}" aria-label="删掉 ${esc(t)}">×</button></span>`).join('')}
        <input name="interest" maxlength="40" placeholder="例如：机器人、嵌入式、考研" ${interests.length >= 12 ? 'disabled' : ''}>
        <button class="btn btn-secondary btn-sm" type="submit" ${interests.length >= 12 ? 'disabled' : ''}>添加</button>
      </form>
      <p class="me-msg" role="status"></p>`;
  },

  awards() {
    const list = readAwards();
    return `<div class="me-h-row"><h2 class="me-h">奖项</h2>${list.length ? '<button class="btn btn-outline btn-sm" type="button" data-act="awards-export">导出</button>' : ''}</div>
      <p class="acct-sub">奖项的核验和公开展示还在做：现在记录<b>只保存在这个浏览器里</b>，标注“未核验”，不会出现在你的公开主页上。核验上线后，可以带着证明材料一键提交。</p>
      ${list.length ? `<ul class="ap-list me-awards">${list.map((a, i) => `<li class="ap-row"><span class="me-award-medal" data-level="${esc(a.level)}">${esc((a.level || '奖')[0])}</span>
        <span class="ap-row-text"><b>${esc(a.name)}</b><span>${[a.year, a.level, a.result, a.role].filter(Boolean).map(esc).join(' · ')}${a.evidence ? ` · <a href="${esc(a.evidence)}" target="_blank" rel="noopener">证明</a>` : ''} · 未核验</span></span>
        <button class="me-x" type="button" data-award-x="${i}" aria-label="删除 ${esc(a.name)}">删除</button></li>`).join('')}</ul>`
        : '<div class="ap-empty"><b>还没有奖项记录。</b><p>比赛名称、届次、级别、你的角色，再附一个证明链接（获奖公示、证书照片的网盘链接都可以）。</p></div>'}
      <form class="card me-card acct-form me-award-form" id="award-form">
        <div class="acct-row">
          <label class="acct-field"><span>比赛名称</span><input name="name" maxlength="80" required placeholder="例如：全国大学生电子设计竞赛"></label>
          <label class="acct-field"><span>年份 / 届次</span><input name="year" maxlength="30" placeholder="2025 · 第十七届"></label>
        </div>
        <div class="acct-row">
          <label class="acct-field"><span>级别</span><select name="level">${AWARD_LEVELS.map((l) => `<option>${l}</option>`).join('')}</select></label>
          <label class="acct-field"><span>获奖情况</span><input name="result" maxlength="40" placeholder="一等奖 / 省二 / 优胜奖"></label>
        </div>
        <div class="acct-row">
          <label class="acct-field"><span>你的角色</span><input name="role" maxlength="40" placeholder="队长 / 硬件 / 算法"></label>
          <label class="acct-field"><span>证明链接（选填）</span><input name="evidence" type="url" placeholder="https://…"></label>
        </div>
        <div class="me-actions"><button class="btn btn-primary" type="submit">记下这个奖项</button><span class="me-msg" role="status"></span></div>
      </form>`;
  },

  contributions() {return '<h2 class="me-h">每一次共建，都留下回响。</h2><div id="my-contribution"></div>';},
  account() {
    if (!st.user) return needLogin();
    const u = st.me?.profile ?? st.user;
    return `<h2 class="me-h">账户</h2>
      <div class="card me-card">
        <dl class="me-dl">
          <div><dt>用户名</dt><dd>@${esc(u.username)}</dd></div>
          <div><dt>邮箱</dt><dd>${esc(u.email ?? '')} ${u.emailVerified ? '<span class="tag tag-ok">已验证</span>' : '<span class="tag tag-warn">未验证</span>'}</dd></div>
          <div><dt>身份</dt><dd>${u.campusVerified ? '<span class="tag tag-ok">已确认矿大身份</span>' : '<span class="tag">未确认矿大身份</span>'} ${u.githubVerified ? '<span class="tag tag-accent">已绑定 GitHub</span>' : ''}</dd></div>
        </dl>
        ${u.developer ? '<p class="notice"><span class="notice-dot" aria-hidden="true"></span><span>开发者账号可以直接发帖、回复、上传和测试，无需验证邮箱。</span></p>' : u.emailVerified ? '' : '<p class="notice"><span class="notice-dot" aria-hidden="true"></span><span><strong>邮箱还没验证。</strong>验证之前不能投稿、收藏和回复。</span></p><button class="btn btn-primary" type="button" data-act="resend">重新发送验证邮件</button>'}
        <p class="me-msg" role="status"></p>
      </div>
      <div class="me-actions"><button class="btn btn-secondary" type="button" data-act="logout">退出登录</button></div>`;
  },

  entries() {
    if (!st.user) return needLogin();
    const list = st.me?.entries ?? [];
    if (!list.length) return `<h2 class="me-h">我的投稿</h2>${empty('还没有投稿。', '项目、资料、题解和讨论都从这里开始。', '<a class="btn btn-primary" href="contribute.html">去投稿</a>')}`;
    return `<h2 class="me-h">我的投稿</h2><ul class="me-list" role="list">${list
      .map((e) => {
        const [label, cls] = STATE[e.state] ?? [e.state ?? '未知', ''];
        return `<li class="card me-row">
          <div class="me-row-main"><span class="tag">${KIND[e.kind] ?? e.kind}</span><h3>${esc(titleOf(e))}</h3>
            ${e.reviewNote ? `<p class="me-note"><b>审核意见</b>${esc(e.reviewNote)}</p>` : ''}</div>
          <div class="me-row-side"><span class="tag ${cls}">${label}</span><span class="muted">${timeAgo(e.updated)}更新</span></div>
        </li>`;
      })
      .join('')}</ul>`;
  },

  stars() {
    if (!st.user) return needLogin();
    const list = st.me?.stars ?? [];
    if (!list.length) return `<h2 class="me-h">收藏</h2>${empty('还没有收藏。', '在“发现”里遇到喜欢的项目，点一下爱心就会出现在这里。', '<a class="btn btn-primary" href="discover.html">去发现</a>')}`;
    return `<h2 class="me-h">收藏</h2><ul class="me-list" role="list">${list
      .map((e) => `<li class="card me-row"><div class="me-row-main"><span class="tag">${KIND[e.kind] ?? e.kind}</span><h3>${esc(e.data?.title ?? '')}</h3>
        ${e.data?.credit ? `<p class="muted">原作者：${esc(e.data.credit)}</p>` : ''}</div>
        <div class="me-row-side"><span class="muted">${e.collection ? esc(e.collection) : ''}</span><span class="muted num">本站 ${e.siteStars} 人收藏</span></div></li>`)
      .join('')}</ul>`;
  },

  plans() {
    if (!st.user) return needLogin();
    const list = (st.me?.workspaces ?? []).filter((w) => w.kind === 'workflow');
    if (!list.length) return `<h2 class="me-h">搭建清单</h2>${empty('还没有搭建清单。', '在“发现”里把想用的项目加入清单，写下目标，就能生成分步的搭建清单。', '<a class="btn btn-primary" href="discover.html">去发现</a>')}`;
    return `<h2 class="me-h">搭建清单</h2>${list
      .map((w) => {
        const steps = w.data?.steps ?? [];
        return `<details class="card me-plan"><summary><h3>${esc(w.title)}</h3><span class="muted">${steps.length} 步 · ${timeAgo(w.updated)}更新</span></summary>
          ${w.data?.notice ? `<p class="notice"><span class="notice-dot" aria-hidden="true"></span><span>${esc(w.data.notice)}</span></p>` : ''}
          <ol class="plan-steps">${steps.map((s) => `<li><b>${esc(s.title)}</b><p>${esc(s.instructions ?? '')}</p></li>`).join('')}</ol></details>`;
      })
      .join('')}`;
  },

  notices() {
    if (!st.user) return needLogin();
    const n = st.notes;
    const head = `<div class="me-h-row"><h2 class="me-h">通知</h2>${n?.unread ? '<button class="btn btn-outline btn-sm" type="button" data-act="read-all">全部标为已读</button>' : ''}</div><p class="me-msg" role="status" tabindex="-1"></p>`;
    const bk = st.user.moderator && st.bkUnread ? `<a class="me-bk-card" href="#beikuang"><span class="bk-mini" aria-hidden="true">北</span>
        <span><b>北矿娘有 ${st.bkUnread} 条新消息</b><small>机器人的消息和要你决定的事，都在她那里</small></span><span class="me-bk-chev" aria-hidden="true">›</span></a>` : '';
    if (!n) return `${head}${bk}<p class="acct-sub">正在载入…</p>`;
    if (!n.items.length) return `${head}${bk}${empty('没有通知。', '关注的项目有新版本、讨论被回复、投稿审核有结果时，会出现在这里。')}`;
    const fmt = (d) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric' }).format(d);
    const today = fmt(new Date()), yesterday = fmt(new Date(Date.now() - 86400000));
    const groups = new Map();
    for (const x of n.items) {
      const d = fmt(new Date(x.created));
      const label = d === today ? '今天' : d === yesterday ? '昨天' : d;
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(x);
    }
    return `${head}${bk}${[...groups].map(([label, items]) => `<h3 class="me-note-day">${esc(label)}</h3>
      <ul class="me-notes" role="list">${items.map((x) => {
        const robot = st.user.moderator && x.event === 'maintenance';
        const href = noticeHref(x.action?.href);
        const destination = href ? ` · <a href="${esc(href)}" data-notice-open="${x.id}">${esc(x.action.label || '查看详情')} ›</a>` : x.action?.kind === 'content' ? ` · ${esc(x.action.label || '内容暂不可查看')}` : '';
        return `<li class="me-note${x.read ? '' : ' is-unread'}"><span class="me-note-dot" aria-hidden="true"></span>
          <div class="me-note-main"><p>${esc(x.text)}</p><span>${timeAgo(x.created)}${robot ? ' · <a href="#beikuang">交给北矿娘了 ›</a>' : destination}</span></div></li>`;
      }).join('')}</ul>`).join('')}`;
  },

  profile() {
    if (!st.user) return needLogin();
    const u = st.me?.profile ?? st.user;
    const links = u.externalLinks ?? {};
    return `<h2 class="me-h">资料设置</h2>
      <form class="card me-card acct-form" id="profile-form">
        <div class="acct-row">
          <label class="acct-field"><span>昵称</span><input name="display_name" maxlength="40" value="${esc(u.name ?? '')}"></label>
          <label class="acct-field"><span>专业</span><input name="major" maxlength="40" value="${esc(u.major ?? '')}" placeholder="例如：机械工程"></label>
        </div>
        <div class="acct-row">
          <label class="acct-field"><span>学院</span><input name="faculty" maxlength="80" value="${esc(u.preferences?.faculty ?? '')}" placeholder="例如：机电与信息工程学院"></label>
          <label class="acct-field"><span>入学年份</span><input name="year" maxlength="4" inputmode="numeric" value="${esc(u.preferences?.year ?? '')}" placeholder="2025"></label>
        </div>
        <label class="acct-field"><span>主要在哪个校区</span><select name="campus">${['', '学院路', '沙河'].map((c) => `<option value="${c}"${(u.preferences?.campus ?? '') === c ? ' selected' : ''}>${c || '不填'}</option>`).join('')}</select></label>
        <label class="acct-field"><span>一句话介绍</span><input name="bio" maxlength="160" value="${esc(u.bio ?? '')}"></label>
        <fieldset class="me-links"><legend>平台主页</legend>
          <p class="acct-hint">这里填的是你的公开主页链接，只用于展示，不代表平台认证；刷题数据只读取这些主页上公开的信息。</p>
          ${PLATFORMS.map(([k, label, ph]) => `<label class="acct-field"><span>${label}</span><input name="link-${k}" type="url" inputmode="url" value="${esc(links[k] ?? '')}" placeholder="${ph}"></label>`).join('')}
        </fieldset>
        <label class="me-check"><input type="checkbox" name="digestEnabled"${u.digestEnabled ? ' checked' : ''}> 每周发一封摘要邮件（关注的项目、被回复的讨论）</label>
        <p class="acct-err" role="alert" hidden></p>
        <div class="me-actions"><button class="btn btn-primary" type="submit">保存</button><span class="me-msg" role="status"></span></div>
      </form>`;
  },

  local() {
    let data = null;
    try { data = notebook?.read(); } catch (e) { return `<h2 class="me-h">本机足迹</h2><p class="acct-err">${esc(e.message)}</p>`; }
    const problems = data?.problems ?? [];
    const saved = data?.savedProjects ?? [];
    const label = { todo: '待做', review: '再练', solved: '自评完成' };
    return `<h2 class="me-h">本机足迹</h2>
      <p class="acct-sub">这些记录只保存在这个浏览器里，不需要登录，也不会上传。换电脑或清理浏览器之前，记得导出备份。</p>
      <div class="me-actions"><button class="btn btn-outline btn-sm" type="button" data-act="export">导出备份</button>
        <label class="btn btn-outline btn-sm">导入备份<input type="file" accept="application/json,.json" data-act="import" hidden></label>
        <span class="me-msg" role="status"></span></div>
      <h3 class="me-h3">收藏的项目 <span class="muted num">${saved.length}</span></h3>
      ${saved.length ? `<ul class="me-plain" role="list">${saved.map((u) => `<li><a href="${esc(u)}" target="_blank" rel="noopener">${esc(u.replace(/^https:\/\//, ''))}</a></li>`).join('')}</ul>` : '<p class="muted">还没有本机收藏。</p>'}
      <h3 class="me-h3">题目足迹 <span class="muted num">${problems.length}</span></h3>
      ${problems.length ? `<ul class="me-plain" role="list">${problems.map((p) => `<li><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.title)}</a> <span class="tag">${label[p.status] ?? p.status}</span></li>`).join('')}</ul>` : '<p class="muted">还没有题目足迹。</p>'}`;
  },
};

// ---------- 渲染与切换 ----------

let disposeOperations;
function show(sec) {
  disposeOperations?.();
  disposeContribution?.();
  stopBeikuang();
  stopCodexChat();
  if (!SECTIONS[sec]) sec = st.user ? 'account' : 'local';
  $$('#me-nav a').forEach((a) => (a.getAttribute('aria-current') === 'page' ? a.removeAttribute('aria-current') : null));
  $(`#me-nav a[data-sec="${sec}"]`)?.setAttribute('aria-current', 'page');
  main.innerHTML = SECTIONS[sec]();
  main.dataset.sec = sec;
  if(sec==='contributions') disposeContribution=mountContribution($('#my-contribution'),st.user);
  if (sec === 'codex' && st.user?.moderator) mountCodexChat($('#codex-root'));
  if (sec === 'beikuang' && st.user?.moderator) mountBeikuang($('#bk-root'), { unread: setBkUnread });
  if (sec === 'maintenance' && st.user?.moderator) disposeOperations = mountOperations($('[data-operations-panel]'));
  if (sec === 'maintenance' && st.user?.moderator && !st.maint) loadMaint();
  if (sec === 'synced' && st.user && !st.sync)
    hubApi.syncData()
      .then((r) => { st.sync = r; if (main.dataset.sec === 'synced') show('synced'); })
      .catch((e2) => { st.sync = { error: e2.message }; if (main.dataset.sec === 'synced') show('synced'); });
  if (sec === 'growth' && st.user && !st.contrib)
    hubApi.contributions({ username: st.user.username })
      .then((r) => { st.contrib = r; if (main.dataset.sec === 'growth') show('growth'); })
      .catch(() => { st.contrib = { total: 0, error: true }; });
  if (sec === 'notices' && st.user && !st.notes) loadNotices();
}

async function loadMaint() {
  try { st.maint = await hubApi.maintenanceStatus(); } catch (e) { st.maint = { error: e.message }; }
  if (main.dataset.sec === 'maintenance') show('maintenance');
}

// Both entry points share the same mutations. A read receipt is kept separate from approval.
async function openNoticeReview(id) {
  const notice = st.notes?.items.find(x => x.id === id);
  if (!st.user?.moderator || !(notice?.action?.kind in REVIEW_TITLES) || st.reviewBusy) return;
  st.reviewNotice = id;
  st.maint = null;
  show('notices');
  const [queue, receipt] = await Promise.allSettled([
    hubApi.maintenanceStatus(), notice.read ? Promise.resolve() : hubApi.readNotifications([id]),
  ]);
  // A slow reply must not reopen a closed or newly selected notification.
  if (st.reviewNotice !== id) return;
  st.maint = queue.status === 'fulfilled' ? queue.value : { error: queue.reason.message };
  if (receipt.status === 'fulfilled' && !notice.read) {
    notice.read = true;
    st.notes.unread = Math.max(0, st.notes.unread - 1);
    updateUnread();
  }
  if (main.dataset.sec === 'notices') {
    show('notices');
    const panel = $('.me-notice-review');
    panel?.scrollIntoView({ block: 'start' });
    const focus = $('summary, [data-news-act], [data-retry-review], [data-close-review]', panel);
    focus?.focus({ preventScroll: true });
    if (receipt.status === 'rejected') msg('审核内容已打开，但已读状态未保存。可稍后重试。', true);
  }
}

function updateUnread() {
  $('#me-unread').hidden = !st.notes.unread;
  $('#me-unread').textContent = st.notes.unread;
  const bell = $('[data-bell]'), count = $('[data-bell-count]');
  if (bell && count) {
    count.hidden = !st.notes.unread;
    count.textContent = st.notes.unread > 99 ? '99+' : st.notes.unread;
    bell.setAttribute('aria-label', st.notes.unread ? `消息，${st.notes.unread} 条未读` : '消息');
  }
}

async function performReview(action, success) {
  if (st.reviewBusy) return;
  st.reviewBusy = true;
  const buttons = $$('[data-project-review] button, [data-news-act], [data-guide-review] button, [data-supervisor-case] button, [data-supervisor-news] button', main);
  buttons.forEach(b => { b.disabled = true; });
  let feedback = '', failed = false;
  try {
    try {
      await action();
      feedback = success;
    } catch (ex) {
      feedback = ex.message ?? '操作没有成功，请重试。'; failed = true;
      // Another maintainer may already have processed this revision.
      if (ex.status !== 409) { msg(feedback, true); $('.me-msg', main)?.focus(); return; }
    }
    const [queue, inbox] = await Promise.allSettled([hubApi.maintenanceStatus(), hubApi.notifications()]);
    st.maint = queue.status === 'fulfilled' ? queue.value : { error: queue.reason.message };
    if (inbox.status === 'fulfilled') { st.notes = inbox.value; updateUnread(); }
    else feedback += ' 通知数量暂未刷新，请重新打开通知页。';
    if (['notices', 'maintenance'].includes(main.dataset.sec)) {
      show(main.dataset.sec);
      msg(feedback, failed);
      $('.me-msg', main)?.focus();
    }
  } finally {
    st.reviewBusy = false;
    buttons.forEach(b => { b.disabled = false; });
  }
}

async function loadNotices() {
  try {
    st.notes = await hubApi.notifications();
    updateUnread();
    if (main.dataset.sec === 'notices') show('notices');
  } catch (e) {
    if (main.dataset.sec === 'notices') main.innerHTML = `<h2 class="me-h">通知</h2><p class="acct-err">${esc(e.message)}</p>`;
  }
}

const msg = (text, err = false) => {
  const el = $('.me-msg', main);
  if (el) {
    el.textContent = text;
    el.classList.toggle('is-err', err);
  }
};

main.addEventListener('click', async (e) => {
  const openedNotice = e.target.closest('[data-notice-open]');
  if (openedNotice) {
    // A read receipt never blocks navigation or approves content.
    hubApi.request('notifications/read', { ids: [Number(openedNotice.dataset.noticeOpen)] }, { keepalive: true }).catch(() => {});
    return;
  }
  const robot = e.target.closest('[data-summarize],[data-classify],[data-draft-announcement],[data-supervisor-discuss]');
  if (robot) {
    robot.disabled = true;
    try {
      if (robot.hasAttribute('data-supervisor-discuss')) {
        const form = robot.closest('[data-supervisor-case]');
        const discussion = await hubApi.discussSupervisor({id:form.dataset.supervisorCase,message:form.elements.answer.value || '请一起核对这项请示。'});
        msg('讨论已加入 AI 工作室，由北矿娘和 Codex 各回复一轮。');
        const link = document.createElement('a');
        link.href = `studio.html?room=${encodeURIComponent(discussion.room)}`;
        link.textContent = ' 查看这次讨论 →';
        $('.me-msg',main)?.append(link);
      } else if (robot.hasAttribute('data-classify')) {
        await performReview(() => hubApi.classifyGithub(robot.dataset.classify), '分类已更新，仍可在审核表中调整。');
      } else {
        const job = robot.hasAttribute('data-summarize') ? await hubApi.summarizeGithub(robot.dataset.summarize) : await hubApi.draftAnnouncement();
        msg('任务已排队，机器人完成后会显示待审内容。你可以继续浏览。');
        const sec = main.dataset.sec;
        for (let i=0;i<140;i++) {
          await new Promise(resolve=>setTimeout(resolve,1500));
          if (main.dataset.sec !== sec) break;
          const next = await hubApi.job(job.id);
          if (next.state === 'failed') throw new Error(next.error || '生成未完成，请稍后重试。');
          if (next.state === 'done') { await performReview(() => Promise.resolve(), '草稿已完成，请核对后决定是否公开。'); break; }
        }
      }
    } catch (ex) { msg(ex.message || '机器人暂时无法完成任务。',true); }
    finally { robot.disabled=false; }
    return;
  }
  const reject = e.target.closest('[data-reject-guide],[data-reject-announcement]');
  if (reject) {
    const form=reject.closest('form'), note=form.elements.note.value.trim();
    if (!note) return msg('请填写需要修改的地方。',true);
    if (form.dataset.guideReview) await performReview(() => hubApi.reviewGuide({repository:form.dataset.guideReview,sourceFingerprint:form.dataset.source,approve:false,note}), '导读已退回，暂不公开。');
    else await performReview(() => hubApi.review(form.dataset.supervisorNews,Number(form.dataset.revision),'reject',note), '公告已退回，暂不公开。');
    return;
  }
  const reviewNotice = e.target.closest('[data-review-notice]');
  if (reviewNotice) { await openNoticeReview(Number(reviewNotice.dataset.reviewNotice)); return; }
  if (e.target.closest('[data-close-review]')) {
    if (st.reviewBusy) return;
    const id = st.reviewNotice;
    st.reviewNotice = null; show('notices');
    $(`[data-review-notice="${id}"]`, main)?.focus();
    return;
  }
  if (e.target.closest('[data-retry-review]')) { await openNoticeReview(st.reviewNotice); return; }
  const clear = e.target.closest('[data-sync-clear]');
  if (clear) {
    e.preventDefault();
    const kind = clear.dataset.syncClear;
    if (kind === 'all' && !confirm('清除这个账号里所有从手机同步上来的数据？手机里的数据不受影响。')) return;
    clear.disabled = true;
    try {
      await hubApi.clearSync(kind);
      if (kind === 'all') st.sync.items = {};
      else delete st.sync.items[kind];
      show('synced');
      msg('已删除。手机里的数据不受影响，下次同步会重新上传你选择的内容。');
    } catch (ex) {
      msg(ex.message ?? '删除没有成功。', true);
      clear.disabled = false;
    }
    return;
  }
  const skip = e.target.closest('[data-skip-project]');
  if (skip) {
    await performReview(() => hubApi.curateGithub({ repository:skip.dataset.skipProject, shelf:'unlisted', reason:'维护者决定不推荐此自动采集候选' }), '已设为不推荐，不会加入开源广场。');
    return;
  }
  const news = e.target.closest('[data-news-act]');
  if (news) {
    const row = news.closest('[data-news]'), approve = news.dataset.newsAct === 'approve';
    await performReview(() => hubApi.review(row.dataset.news, Number(row.dataset.rev), approve ? 'approve' : 'reject', approve ? '维护者核对：标题、时间、配图署名与原文一致' : '维护者决定不上首页'), approve ? '已同意发布，新闻会出现在首页和校圈。' : '已退回，新闻不会公开。');
    return;
  }
  const run = e.target.closest('[data-run],[data-mirror]');
  if (run) {
    run.disabled = true;
    try {
      if (run.dataset.run) {
        await hubApi.runMaintenance(run.dataset.run);
        msg('已经排进队列，后台机器人几秒钟后开始；稍后刷新这一页看结果。');
      } else if (run.dataset.mirror) {
        await hubApi.refreshMirror(run.dataset.mirror);
        msg(`已排队重新检查 ${run.dataset.mirror}。`);
      }
      setTimeout(() => { st.maint = null; if (main.dataset.sec === 'maintenance') loadMaint(); }, 4000);
    } catch (ex) {
      msg(ex.message ?? '操作没有成功。', true);
    } finally {
      run.disabled = false;
    }
    return;
  }
  const x = e.target.closest('[data-goal-x],[data-interest-x],[data-award-x]');
  if (x) {
    if (x.hasAttribute('data-award-x')) {
      const list = readAwards();
      list.splice(Number(x.dataset.awardX), 1);
      writeAwards(list);
      return show('awards');
    }
    const key = x.hasAttribute('data-goal-x') ? 'goals' : 'interests';
    const i = Number(x.dataset.goalX ?? x.dataset.interestX);
    const list = [...((st.me?.profile ?? st.user).preferences?.[key] ?? [])];
    list.splice(i, 1);
    x.disabled = true;
    try {
      await savePrefs({ [key]: list });
      show('growth');
    } catch (ex) {
      msg(ex.message ?? '保存失败。', true);
      x.disabled = false;
    }
    return;
  }
  const b = e.target.closest('button[data-act]');
  if (!b || b.disabled) return;
  b.disabled = true;
  try {
    if (b.dataset.act === 'resend') {
      const r = await hubApi.sendVerification();
      msg(r?.emailDelivery === 'smtp' || r?.capabilities?.emailDelivery === 'smtp' ? '验证邮件已发出，请查收。' : '开发模式：验证邮件只保存在站主电脑上，你的邮箱不会收到。');
    }
    if (b.dataset.act === 'logout') {
      await hubApi.logout();
      location.href = './';
      return;
    }
    if (b.dataset.act === 'read-all') {
      await hubApi.readNotifications(st.notes.items.filter((x) => !x.read).map((x) => x.id));
      st.notes = null;
      await loadNotices();
    }
    if (b.dataset.act === 'awards-export') {
      const blob = new Blob([JSON.stringify({ version: 1, note: '本机记录，未核验', awards: readAwards() }, null, 2)], { type: 'application/json' });
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `luokixi-奖项-${new Date().toISOString().slice(0, 10)}.json` });
      a.click();
      URL.revokeObjectURL(a.href);
    }
    if (b.dataset.act === 'export') {
      const blob = new Blob([JSON.stringify(notebook.export(), null, 2)], { type: 'application/json' });
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `luokixi-足迹-${new Date().toISOString().slice(0, 10)}.json` });
      a.click();
      URL.revokeObjectURL(a.href);
      msg('已导出。');
    }
  } catch (ex) {
    msg(ex.message ?? '操作没有成功。', true);
  } finally {
    b.disabled = false;
  }
});

main.addEventListener('change', async (e) => {
  if (e.target.dataset.act !== 'import') return;
  try {
    const raw = JSON.parse(await e.target.files[0].text());
    notebook.import(raw);
    show('local');
    msg('已导入，原有记录都保留了。');
  } catch (ex) {
    msg(ex.message ?? '备份文件无法读取。', true);
  }
});

// 生涯规划和兴趣：直接存进账号（服务端 preferences.goals / interests，各最多 12 条）
async function savePrefs(patch) {
  const u = st.me?.profile ?? st.user;
  const prefs = { faculty: '', year: '', campus: '', goals: [], interests: [], courses: [], ...(u.preferences ?? {}), ...patch };
  const r = await hubApi.updateProfile({ preferences: prefs });
  const next = r?.user ?? r?.profile;
  st.me = { ...st.me, profile: next ?? { ...u, preferences: prefs } };
  if (st.user) st.user.preferences = (next ?? {}).preferences ?? prefs;
}

main.addEventListener('submit', async (e) => {
  const form = e.target;
  if (form.matches('[data-guide-review],[data-supervisor-case],[data-supervisor-news]')) {
    e.preventDefault();
    if (form.dataset.guideReview) await performReview(() => hubApi.reviewGuide({repository:form.dataset.guideReview,sourceFingerprint:form.dataset.source,approve:true,note:form.elements.note.value}), '中文说明书已公开。');
    else if (form.dataset.supervisorCase) await performReview(() => hubApi.answerSupervisor({id:form.dataset.supervisorCase,answer:form.elements.answer.value}), '北矿娘已收到你的答复，审核记录已保存。');
    else await performReview(() => hubApi.request(`entries/${encodeURIComponent(form.dataset.supervisorNews)}/review`,{revision:Number(form.dataset.revision),decision:'approve',note:form.elements.note.value,supervisorQuestionsResolved:form.elements.resolved.checked}), '北矿娘的公告已发布。');
    return;
  }
  if (e.target.matches('[data-project-review]')) {
    e.preventDefault();
    const form = e.target, f = form.elements;
    await performReview(() => hubApi.curateGithub({ repository:form.dataset.projectReview, shelf:f.shelf.value, reason:f.reason.value,
      category:f.category.value,approveGuide:f.approveGuide?.checked === true,
      checks:{sourceRead:f.sourceRead.checked,licenseChecked:f.licenseChecked.checked,downloadsChecked:f.downloadsChecked.checked} }), '已同意推荐，项目已加入开源广场；未标记为已实测。');
    return;
  }
  const id = e.target.id;
  if (id === 'goals-form' || id === 'interests-form') {
    e.preventDefault();
    const u = st.me?.profile ?? st.user;
    const key = id === 'goals-form' ? 'goals' : 'interests';
    const input = e.target.elements[key === 'goals' ? 'goal' : 'interest'];
    const v = input.value.trim();
    if (!v) return input.focus();
    const list = [...(u.preferences?.[key] ?? [])];
    if (list.includes(v)) return msg('已经有这一条了。', true);
    list.push(v);
    try {
      await savePrefs({ [key]: list.slice(0, 12) });
      show('growth');
      msg('已保存到你的账号。');
    } catch (ex) {
      msg(ex.message ?? '保存失败。', true);
    }
    return;
  }
  if (id === 'award-form') {
    e.preventDefault();
    const f = e.target.elements;
    const evidence = f.evidence.value.trim();
    if (evidence && !/^https?:\/\//.test(evidence)) return msg('证明链接需要是完整的网址。', true);
    const list = readAwards();
    list.unshift({ name: f.name.value.trim(), year: f.year.value.trim(), level: f.level.value, result: f.result.value.trim(), role: f.role.value.trim(), evidence, created: new Date().toISOString(), verified: false });
    if (!writeAwards(list.slice(0, 100))) return msg('这个浏览器不能保存数据（可能是隐私模式）。', true);
    show('awards');
    msg('已记下，只保存在这个浏览器里。');
    return;
  }
  if (id !== 'profile-form') return;
  e.preventDefault();
  const f = e.target.elements;
  const err = $('.acct-err', main);
  const btn = $('button[type=submit]', e.target);
  err.hidden = true;
  const externalLinks = {};
  for (const [k] of PLATFORMS) {
    const v = f[`link-${k}`].value.trim();
    if (v && !/^https:\/\//.test(v)) {
      err.textContent = '平台主页需要是 https:// 开头的完整链接。';
      err.hidden = false;
      return f[`link-${k}`].focus();
    }
    if (v) externalLinks[k] = v;
  }
  btn.disabled = true;
  try {
    const year = f.year.value.trim();
    if (year && !/^20\d{2}$/.test(year)) {
      err.textContent = '入学年份写四位数字，比如 2025。';
      err.hidden = false;
      btn.disabled = false;
      return f.year.focus();
    }
    const prefs = (st.me?.profile ?? st.user).preferences ?? {};
    const r = await hubApi.updateProfile({
      display_name: f.display_name.value.trim(), major: f.major.value.trim(), bio: f.bio.value.trim(),
      externalLinks, digestEnabled: f.digestEnabled.checked,
      preferences: { ...prefs, faculty: f.faculty.value.trim(), year, campus: f.campus.value },
    });
    if (r?.user ?? r?.profile) st.me = { ...st.me, profile: r.user ?? r.profile };
    renderWho();
    msg('已保存。');
  } catch (ex) {
    err.textContent = ex.message ?? '保存失败。';
    err.hidden = false;
  } finally {
    btn.disabled = false;
  }
});

addEventListener('hashchange', () => show(location.hash.slice(1)));

// 左上角的头像和昵称；保存资料以后也要跟着刷新
function renderWho() {
  const u = st.me?.profile ?? st.user;
  const links = u?.externalLinks ?? {};
  const line = u ? [u.preferences?.faculty, u.major, u.preferences?.year && `${u.preferences.year} 级`, u.preferences?.campus].filter(Boolean).join(' · ') : '';
  $('#me-who').innerHTML = u
    ? `${avatarHTML({ login: u.username, name: u.name, avatar: u.avatar }, 64)}<div><p class="me-name">${esc(u.name)}</p><p class="muted">@${esc(u.username)}</p>${line ? `<p class="me-line">${esc(line)}</p>` : ''}
      <p class="me-ext">${links.github ? `<a href="${esc(links.github)}" target="_blank" rel="noopener">GitHub ↗</a>` : ''}${links.luogu ? `<a href="${esc(links.luogu)}" target="_blank" rel="noopener">洛谷 ↗</a>` : ''}${!links.github && !links.luogu ? '<a href="#profile">关联 GitHub / 洛谷</a>' : ''}</p>
      ${links.luogu ? '<p class="me-sync"><button type="button" disabled title="洛谷题解同步需要读取你在洛谷公开发表的题解，接口还在接入">同步洛谷题解</button><small>接口接入中，暂不能同步</small></p>' : ''}</div>`
    : `<p class="me-name">${st.online ? '未登录' : '离线'}</p><p class="muted">${st.online ? `<a href="${esc(loginURL())}">登录</a> 后查看投稿与收藏` : '社区服务未连接'}</p>`;
}

(async () => {
  const s = await hubState();
  st.online = s.online;
  st.user = s.user;
  if (st.user) {
    try { st.me = await hubApi.me(); } catch (e) { main.innerHTML = `<p class="acct-err">${esc(e.message)}</p>`; }
    loadNotices();
  }
  renderWho();
  if (st.user?.moderator) {
    $('#me-nav').insertAdjacentHTML('afterbegin', '<a href="#beikuang" data-sec="beikuang">北矿娘 <span class="me-badge num" id="bk-unread" hidden></span></a><a href="#codex" data-sec="codex">Codex 对话</a><a href="#maintenance" data-sec="maintenance">维护机器人</a>');
    hubApi.beikuangUnread().then((r) => { setBkUnread(r.unread); if (main.dataset.sec === 'notices') show('notices'); }).catch(() => {});
  }
  show(location.hash.slice(1));
})();
