// 账号：登录 / 注册 / 忘记密码 / 重置密码 / 邮箱验证 / 退订
// 接口见 docs/HUB_API.md「账号」。所有失败都原样展示服务端的中文说明，不做乐观成功。
import { initShell } from '../js/shell.js';
import { hubApi, hubState } from '../js/hub.js';
import { esc } from '../js/data.js';
import '../styles/account.css';

initShell();

const $ = (s, r = document) => r.querySelector(s);
const body = $('#acct-body');
const params = new URLSearchParams(location.search);

// 邮件链接的令牌：优先读 #verify/<token>、#reset/<uid>/<token>、#unsubscribe/<token>（片段不会发给服务器，
// 也不会出现在 Referer 里），兼容 ?mode=…&token=…&uid=…。读完立即从地址栏抹掉。
function readLinkToken() {
  const [mode, a, b] = location.hash.slice(1).split('/').map(decodeURIComponent);
  let out = null;
  if (mode === 'verify' || mode === 'unsubscribe') out = { mode, token: a };
  else if (mode === 'reset') out = { mode, uid: a, token: b };
  else if (['verify', 'unsubscribe', 'reset'].includes(params.get('mode')) && params.get('token'))
    out = { mode: params.get('mode'), token: params.get('token'), uid: params.get('uid') };
  if (out) history.replaceState(null, '', `auth.html?mode=${out.mode}`);
  return out;
}

// 只允许跳回本站页面，防止开放重定向
function nextPage() {
  const n = params.get('next') ?? '';
  return /^[a-z0-9-]+\.html(\?[^#]*)?$/.test(n) ? n : 'me.html';
}

const link = (mode, text) => `<a href="auth.html?mode=${mode}${params.get('next') ? `&next=${encodeURIComponent(params.get('next'))}` : ''}" data-mode="${mode}">${text}</a>`;

const field = (name, label, type = 'text', attrs = '') =>
  `<label class="acct-field"><span>${label}</span><input name="${name}" type="${type}" ${attrs}></label>`;

const VIEWS = {
  login: () => ({
    title: '登录 Luokixi',
    sub: '用邮箱登录，收藏项目、投稿和参与讨论。',
    form: `${field('email', '邮箱', 'email', 'autocomplete="email" required')}
      ${field('password', '密码', 'password', 'autocomplete="current-password" required minlength="12"')}`,
    submit: '登录',
    links: `${link('forgot', '忘记密码？')}<span>还没有账号？${link('register', '创建账号')}</span>`,
    run: async (f) => {
      await hubApi.login({ email: f.email.value.trim(), password: f.password.value });
      location.href = nextPage();
      return null;
    },
  }),
  register: () => ({
    title: '创建账号',
    sub: '只需要一个邮箱。验证邮箱后就可以投稿、收藏和回复。',
    form: `${field('email', '邮箱', 'email', 'autocomplete="email" required')}
      <div class="acct-row">${field('username', '用户名', 'text', 'autocomplete="username" required pattern="[A-Za-z0-9._-]{3,30}" placeholder="3–30 位英文、数字、. _ -"')}
      ${field('name', '昵称', 'text', 'autocomplete="nickname" maxlength="40" placeholder="可选"')}</div>
      ${field('password', '密码', 'password', 'autocomplete="new-password" required minlength="12" placeholder="至少 12 位"')}
      <p class="acct-hint" id="pw-hint">建议用一句好记的话，比用复杂符号更安全。</p>`,
    submit: '创建账号',
    links: `<span>已经有账号？${link('login', '登录')}</span>`,
    run: async (f) => {
      const r = await hubApi.register({
        email: f.email.value.trim(), username: f.username.value.trim(), name: f.name.value.trim(), password: f.password.value,
      });
      const smtp = r?.capabilities?.emailDelivery === 'smtp';
      return `<p class="acct-ok">${esc(r?.message ?? '账号已创建。')}</p>
        <p class="acct-sub">${smtp ? '请去邮箱点开验证链接。验证之前可以浏览，但不能投稿、收藏和回复。' : '当前是开发模式：服务器没有配置发信，验证邮件只保存在站主电脑上，你的邮箱不会收到。'}</p>
        <a class="btn btn-primary acct-wide" href="${esc(nextPage())}">继续</a>`;
    },
  }),
  forgot: () => ({
    title: '找回密码',
    sub: '输入注册时用的邮箱，我们会发一封重置邮件。',
    form: field('email', '邮箱', 'email', 'autocomplete="email" required'),
    submit: '发送重置邮件',
    links: link('login', '返回登录'),
    run: async (f) => {
      const r = await hubApi.resetRequest(f.email.value.trim());
      return `<p class="acct-ok">${esc(r?.message ?? '如果这个邮箱注册过，会收到一封重置邮件。')}</p>${link('login', '返回登录')}`;
    },
  }),
  reset: ({ uid, token }) => ({
    title: '设置新密码',
    sub: '设置完成后，其他设备上的登录会全部失效。',
    form: `${field('password', '新密码', 'password', 'autocomplete="new-password" required minlength="12" placeholder="至少 12 位"')}
      ${field('password2', '再输入一次', 'password', 'autocomplete="new-password" required minlength="12"')}`,
    submit: '保存新密码',
    links: link('login', '返回登录'),
    run: async (f) => {
      if (!uid || !token) throw new Error('链接不完整。请回到邮件，重新点开重置链接。');
      if (f.password.value !== f.password2.value) throw new Error('两次输入的密码不一样。');
      const r = await hubApi.resetConfirm({ uid, token, password: f.password.value });
      return `<p class="acct-ok">${esc(r?.message ?? '密码已更新。')}</p><a class="btn btn-primary acct-wide" href="auth.html?mode=login">用新密码登录</a>`;
    },
  }),
};

// 不需要表单、打开就执行的模式
const ACTIONS = {
  verify: async ({ token }) => {
    const r = await hubApi.verify(token);
    return { title: '邮箱已验证', html: `<p class="acct-ok">${esc(r?.message ?? '验证成功。')}</p><a class="btn btn-primary acct-wide" href="me.html">进入我的</a>` };
  },
  unsubscribe: async ({ token }) => {
    const r = await hubApi.unsubscribe(token);
    return { title: '已退订', html: `<p class="acct-ok">${esc(r?.message ?? '以后不会再收到每周摘要。')}</p><p class="acct-sub">想重新订阅，可以在“我的 → 资料设置”里打开。</p>` };
  },
};

function render(mode, ctx, s) {
  const v = VIEWS[mode](ctx);
  document.title = `${v.title} · Luokixi`;
  const github = s.capabilities?.githubLogin && (mode === 'login' || mode === 'register');
  body.innerHTML = `
    <h1 class="acct-title">${v.title}</h1>
    <p class="acct-sub">${v.sub}</p>
    ${s.online ? '' : '<p class="notice"><span class="notice-dot" aria-hidden="true"></span><span><strong>社区服务未连接。</strong>现在只能浏览公开内容，暂时不能登录或注册。</span></p>'}
    <form class="acct-form" novalidate>
      <fieldset${s.online ? '' : ' disabled'}>${v.form}</fieldset>
      <p class="acct-err" role="alert" hidden></p>
      <button class="btn btn-primary acct-wide" type="submit"${s.online ? '' : ' disabled'}>${v.submit}</button>
      ${github ? `<a class="btn btn-secondary acct-wide" href="${esc(hubApi.githubLoginUrl)}">使用 GitHub ${mode === 'login' ? '登录' : '注册'}</a>` : ''}
    </form>
    <nav class="acct-links">${v.links}</nav>`;
  const form = $('form', body);
  const err = $('.acct-err', body);
  const btn = $('button[type=submit]', body);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (btn.disabled) return;
    err.hidden = true;
    const bad = [...form.elements].find((x) => x.willValidate && !x.checkValidity());
    if (bad) {
      err.textContent = `${bad.closest('label')?.querySelector('span')?.textContent ?? '这一项'}：${bad.validationMessage}`;
      err.hidden = false;
      return bad.focus();
    }
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = '请稍候…';
    try {
      const html = await v.run(form.elements);
      if (html) body.innerHTML = html;
    } catch (ex) {
      err.textContent = ex.message ?? '操作没有成功，请稍后重试。';
      err.hidden = false;
      btn.disabled = false;
      btn.textContent = label;
    }
  });
  $('input', form)?.focus();
}

async function signedIn(s) {
  body.innerHTML = `<h1 class="acct-title">你已登录</h1>
    <p class="acct-sub">当前账号：<strong>${esc(s.user.name)}</strong>（@${esc(s.user.username)}）</p>
    <a class="btn btn-primary acct-wide" href="${esc(nextPage())}">继续</a>
    <button class="btn btn-secondary acct-wide" type="button" id="acct-logout">退出登录</button>`;
  $('#acct-logout').addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try {
      await hubApi.logout();
      location.reload();
    } catch (ex) {
      e.currentTarget.disabled = false;
      body.insertAdjacentHTML('beforeend', `<p class="acct-err">${esc(ex.message)}</p>`);
    }
  });
}

(async () => {
  const linkToken = readLinkToken();
  const s = await hubState();
  if (linkToken && ACTIONS[linkToken.mode]) {
    if (!s.online) return render('login', {}, s);
    body.innerHTML = '<p class="acct-sub">正在处理链接…</p>';
    try {
      const r = await ACTIONS[linkToken.mode](linkToken);
      body.innerHTML = `<h1 class="acct-title">${r.title}</h1>${r.html}`;
    } catch (ex) {
      body.innerHTML = `<h1 class="acct-title">链接无法使用</h1><p class="acct-err">${esc(ex.message)}</p><p class="acct-sub">链接可能已过期（有效期 24 小时）或已经用过。${link('login', '返回登录')}</p>`;
    }
    return;
  }
  const mode = linkToken?.mode === 'reset' ? 'reset' : VIEWS[params.get('mode')] && params.get('mode') !== 'reset' ? params.get('mode') : 'login';
  if (s.user && (mode === 'login' || mode === 'register')) return signedIn(s);
  render(mode, linkToken ?? {}, s);
})();

// 页内切换模式，不整页刷新
body.addEventListener('click', async (e) => {
  const a = e.target.closest('a[data-mode]');
  if (!a) return;
  e.preventDefault();
  history.pushState(null, '', a.href);
  params.set('mode', a.dataset.mode);
  render(a.dataset.mode, {}, await hubState());
});
addEventListener('popstate', () => location.reload());
