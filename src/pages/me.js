// 我的：账户 / 我的投稿 / 收藏 / 搭建清单 / 通知 / 资料设置 / 本机足迹
// 线上数据来自 /api/hub/me 与 /notifications；本机足迹来自 Codex 的 community-notebook（不需要登录）。
import { initShell } from '../js/shell.js';
import { hubApi, hubState, loginURL } from '../js/hub.js';
import { createNotebook } from '../js/community-notebook.js';
import { avatarHTML, timeAgo } from '../js/community.js';
import { esc } from '../js/data.js';
import '../styles/account.css';

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

const st = { online: false, user: null, me: null, notes: null };
let notebook = null;
try { notebook = createNotebook(); } catch { /* 浏览器存储不可用 */ }

const empty = (title, text, action = '') => `<div class="empty-card"><p class="empty-title">${title}</p><p>${text}</p>${action}</div>`;
const needLogin = () =>
  st.online
    ? empty('登录后才能看到这一部分。', '投稿、收藏、搭建清单和通知都保存在你的账号里。', `<a class="btn btn-primary" href="${esc(loginURL())}">登录</a>`)
    : empty('社区服务未连接。', '现在只能使用“本机足迹”。连接社区服务后，可以登录查看投稿和收藏。');

const titleOf = (e) => (e.draft?.title || e.data?.title || '未命名');

// ---------- 各分区 ----------

const SECTIONS = {
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
        ${u.emailVerified ? '' : '<p class="notice"><span class="notice-dot" aria-hidden="true"></span><span><strong>邮箱还没验证。</strong>验证之前不能投稿、收藏和回复。</span></p><button class="btn btn-primary" type="button" data-act="resend">重新发送验证邮件</button>'}
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
    if (!n) return '<h2 class="me-h">通知</h2><p class="acct-sub">正在载入…</p>';
    if (!n.items.length) return `<h2 class="me-h">通知</h2>${empty('没有通知。', '关注的项目有新版本、讨论被回复、投稿审核有结果时，会出现在这里。')}`;
    return `<div class="me-h-row"><h2 class="me-h">通知</h2>${n.unread ? '<button class="btn btn-outline btn-sm" type="button" data-act="read-all">全部标为已读</button>' : ''}</div>
      <ul class="me-list" role="list">${n.items
        .map((x) => `<li class="card me-row${x.read ? '' : ' is-unread'}"><div class="me-row-main"><p>${esc(x.text)}</p></div><div class="me-row-side"><span class="muted">${timeAgo(x.created)}</span></div></li>`)
        .join('')}</ul>`;
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

function show(sec) {
  if (!SECTIONS[sec]) sec = st.user ? 'account' : 'local';
  $$('#me-nav a').forEach((a) => (a.getAttribute('aria-current') === 'page' ? a.removeAttribute('aria-current') : null));
  $(`#me-nav a[data-sec="${sec}"]`)?.setAttribute('aria-current', 'page');
  main.innerHTML = SECTIONS[sec]();
  main.dataset.sec = sec;
  if (sec === 'notices' && st.user && !st.notes) loadNotices();
}

async function loadNotices() {
  try {
    st.notes = await hubApi.notifications();
    $('#me-unread').hidden = !st.notes.unread;
    $('#me-unread').textContent = st.notes.unread;
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

main.addEventListener('submit', async (e) => {
  if (e.target.id !== 'profile-form') return;
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
    const r = await hubApi.updateProfile({
      display_name: f.display_name.value.trim(), major: f.major.value.trim(), bio: f.bio.value.trim(),
      externalLinks, digestEnabled: f.digestEnabled.checked,
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
  $('#me-who').innerHTML = u
    ? `${avatarHTML({ login: u.username, name: u.name }, 64)}<div><p class="me-name">${esc(u.name)}</p><p class="muted">@${esc(u.username)}</p></div>`
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
  show(location.hash.slice(1));
})();
