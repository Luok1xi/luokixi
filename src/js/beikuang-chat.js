// 北矿娘的窗口（个人中心 → 北矿娘）：和她聊天、看她今天干了什么、处理她交给你的事。
// 她审核过的东西自己发布；没过的只在这里交给你，一件一张卡片：发布 / 不要了 / 回她一句。
// 她本身（人设、语气、Codex）不在这里改；新能力写在 campus/beikuang-skills/ 的技能里。
import { hubApi } from './hub.js';
import { esc } from './data.js';
import { pop } from './fx.js';
import '../styles/beikuang.css';

const QUICK = ['今天进度怎么样？', '有什么要我决定的？', '今天辛苦啦'];
const DONE = { published: '已发布', dismissed: '不要了', answered: '已回复', stale: '已在别处处理' };
const KIND_SHORT = { news: '新闻', project: '项目', guide: '导读', photo: '照片', announcement: '公告', case: '请示' };
const SEND = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg>';

let root = null;
let view = null;
let timer = 0;
let busyUntil = 0;
let seen = new Set();
let onUnread = () => {};

const timeOf = (iso) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
function dayOf(iso) {
  const fmt = (d) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric' }).format(d);
  const d = new Date(iso);
  const today = fmt(new Date());
  const yesterday = fmt(new Date(Date.now() - 86400000));
  return fmt(d) === today ? '今天' : fmt(d) === yesterday ? '昨天' : fmt(d);
}
function ago(iso) {
  if (!iso) return '还没巡检过';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  return s < 90 ? '刚刚巡检过' : s < 3600 ? `${Math.round(s / 60)} 分钟前巡检过` : s < 86400 ? `${Math.round(s / 3600)} 小时前巡检过` : `${dayOf(iso)}巡检过`;
}

export function mountBeikuang(container, { unread } = {}) {
  stopBeikuang();
  root = container;
  onUnread = unread || (() => {});
  seen = new Set();
  root.innerHTML = `<section class="bk" aria-label="北矿娘">
      <header class="bk-head"><span class="bk-avatar" aria-hidden="true">北</span>
        <div class="bk-id"><h2>北矿娘</h2><p data-bk-line>正在找她…</p></div>
        <div class="bk-head-actions"><button class="as-get is-small" type="button" data-bk-run>巡检一遍</button><button class="as-get is-small" type="button" data-bk-report>写日报</button></div>
      </header>
      <div class="bk-stats" data-bk-stats></div>
      <div class="bk-thread" role="log" aria-live="polite" data-bk-thread><div class="as-skeleton bk-skeleton"></div></div>
      <form class="bk-compose" data-bk-form>
        <div class="bk-quick">${QUICK.map((q) => `<button type="button" class="as-tag" data-bk-quick="${esc(q)}">${esc(q)}</button>`).join('')}</div>
        <div class="bk-field"><label class="sr-only" for="bk-input">和北矿娘说</label>
          <textarea id="bk-input" rows="1" maxlength="2000" placeholder="和北矿娘说点什么…" enterkeyhint="send"></textarea>
          <button class="bk-send" type="submit" aria-label="发送">${SEND}</button></div>
        <p class="bk-note" data-bk-note role="status"></p>
      </form>
    </section>`;
  root.addEventListener('click', onClick);
  root.addEventListener('submit', onSubmit);
  root.addEventListener('input', grow);
  root.addEventListener('keydown', onKey);
  refresh(true);
}

export function stopBeikuang() {
  clearTimeout(timer);
  if (root) {
    root.removeEventListener('click', onClick);
    root.removeEventListener('submit', onSubmit);
    root.removeEventListener('input', grow);
    root.removeEventListener('keydown', onKey);
  }
  root = null;
}

const $ = (s) => root?.querySelector(s);
const note = (text) => { const el = $('[data-bk-note]'); if (el) el.textContent = text || ''; };

async function refresh(first = false) {
  clearTimeout(timer);
  if (!root) return;
  try {
    view = await hubApi.beikuang();
  } catch (e) {
    if (first) $('[data-bk-thread]').innerHTML = `<div class="as-empty"><b>暂时找不到她</b><p>${esc(e.message)}</p></div>`;
    timer = setTimeout(() => refresh(), 30000);
    return;
  }
  if (!root) return;
  render(first);
  if (view.unread) {
    hubApi.readBeikuang().then(() => onUnread(0)).catch(() => {});
  } else onUnread(0);
  const waiting = view.typing || Date.now() < busyUntil;
  timer = setTimeout(() => refresh(), waiting ? 2500 : 60000);
}

function render(first) {
  const t = view.today || {};
  $('[data-bk-line]').textContent = `${view.role} · ${view.enabled ? ago(view.lastRun?.at) : '已暂停'}${view.running ? ' · 正在巡检' : ''}`;
  $('[data-bk-stats]').innerHTML = [
    ['今天发布', t.published ?? 0], ['等你决定', t.escalated ?? 0], ['待办', t.queued ?? 0],
    ['Codex 今日', t.codexLimit ? `${t.codexCalls}/${t.codexLimit}` : '未启用'],
  ].map(([k, v]) => `<span class="bk-stat"><b class="num">${esc(v)}</b>${esc(k)}</span>`).join('')
    + `<details class="bk-skills"><summary>她会的技能 · ${view.skills.length}</summary><ul>${view.skills.map((s) =>
      `<li><b>${esc(s.title)}</b><span>${esc(s.description)}</span></li>`).join('')}</ul></details>`;
  const box = $('[data-bk-thread]');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  let lastDay = '';
  let html = '';
  for (const m of view.messages) {
    const day = dayOf(m.created);
    if (day !== lastDay) { html += `<p class="bk-day">${esc(day)}</p>`; lastDay = day; }
    html += message(m);
  }
  if (view.typing) html += '<div class="bk-row is-her bk-typing" aria-label="北矿娘正在输入"><span class="bk-mini" aria-hidden="true">北</span><div class="bk-bubble"><i></i><i></i><i></i></div></div>';
  if (!view.messages.length && !view.typing) {
    html = `<div class="bk-empty"><span class="bk-avatar is-big" aria-hidden="true">北</span><b>我是北矿娘～</b>
      <p>机器人抓到的新闻、项目、导读和照片都先交给我。审核过的我自己发，拿不准的在这里告诉你；晚上 9 点后给你写小报告。</p></div>`;
  }
  box.innerHTML = html;
  // 新来的消息轻轻浮上来；第一次打开不动
  box.querySelectorAll('[data-msg]').forEach((el) => {
    if (!first && !seen.has(el.dataset.msg)) el.classList.add('is-new');
    seen.add(el.dataset.msg);
  });
  if (first || nearBottom) box.scrollTop = box.scrollHeight;
}

function message(m) {
  if (m.role === 'owner') {
    return `<div class="bk-row is-me" data-msg="${esc(m.id)}"><div class="bk-bubble">${esc(m.body)}</div><time>${esc(timeOf(m.created))}</time></div>`;
  }
  const tag = m.generated === 'template' && m.fallback ? `<small class="bk-fallback">${esc(m.fallback)}，这是她的预设回复</small>`
    : m.generated === 'template' && m.kind === 'chat' ? '<small class="bk-fallback">这是她的预设回复</small>' : '';
  if (m.kind === 'report') {
    const s = m.stats || {};
    const chips = [['看了', s.seen], ['发布', s.published], ['等你', s.escalated], ['机器人出错', s.botFailures]]
      .filter(([, v]) => v).map(([k, v]) => `<span><b class="num">${esc(v)}</b>${esc(k)}</span>`).join('');
    return `<div class="bk-row is-her" data-msg="${esc(m.id)}"><span class="bk-mini" aria-hidden="true">北</span>
      <article class="bk-report"><p class="bk-report-title">今日小报告</p><p>${esc(m.body)}</p>${chips ? `<div class="bk-report-chips">${chips}</div>` : ''}${tag}</article>
      <time>${esc(timeOf(m.created))}</time></div>`;
  }
  const tasks = (m.tasks || []).map((id) => view.tasks[id]).filter(Boolean);
  return `<div class="bk-row is-her" data-msg="${esc(m.id)}"><span class="bk-mini" aria-hidden="true">北</span>
    <div class="bk-stack"><div class="bk-bubble">${esc(m.body)}</div>${tag}
      ${tasks.length ? `<ul class="bk-tasks">${tasks.map(task).join('')}</ul>` : ''}</div>
    <time>${esc(timeOf(m.created))}</time></div>`;
}

function task(t) {
  const open = t.state === 'escalated';
  const link = t.link ? `<a class="bk-link" href="${esc(t.link)}" target="_blank" rel="noopener noreferrer">原文 ↗</a>` : '';
  const body = `<span class="bk-kind">${esc(KIND_SHORT[t.kind] || t.kindLabel)}</span>
    <div class="bk-task-main"><b>${esc(t.title)}</b>
      ${open ? `<p>${esc((t.why.length ? t.why : [t.note]).join('；'))}</p>` : `<p class="bk-done">${esc(DONE[t.state] || t.state)}${t.decidedBy ? ` · ${esc(t.decidedBy)}` : ''}</p>`}
      ${open && t.kind === 'photo' && t.image ? `<img class="bk-thumb" src="${esc(t.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}
    </div>`;
  if (!open) return `<li class="bk-task is-closed" data-task="${esc(t.id)}">${body}</li>`;
  if (t.kind === 'case') {
    return `<li class="bk-task" data-task="${esc(t.id)}">${body}
      <form class="bk-answer" data-bk-answer="${esc(t.id)}"><label class="sr-only" for="ans-${esc(t.id)}">回她一句</label>
        <input id="ans-${esc(t.id)}" name="answer" maxlength="4000" required placeholder="回她一句，比如：先只给原仓库入口">
        <button class="as-get is-small is-primary" type="submit">回复</button></form>${link}</li>`;
  }
  return `<li class="bk-task" data-task="${esc(t.id)}">${body}
    <div class="bk-task-actions"><button class="as-get is-small is-primary" type="button" data-bk-decide="publish">${t.kind === 'photo' ? '用这张' : '发布'}</button>
      <button class="as-get is-small" type="button" data-bk-decide="dismiss">不要了</button>${link}</div></li>`;
}

async function send(words) {
  const text = words.trim();
  if (!text) return;
  const area = $('#bk-input');
  area.value = '';
  grow();
  busyUntil = Date.now() + 180000;
  view.messages.push({ id: `local-${Date.now()}`, role: 'owner', body: text, created: new Date().toISOString(), tasks: [] });
  view.typing = true;
  render(false);
  try {
    await hubApi.tellBeikuang(text);
    note('');
  } catch (e) {
    note(e.message);
  }
  timer = setTimeout(() => refresh(), 1200);
}

async function onClick(e) {
  const quick = e.target.closest('[data-bk-quick]');
  if (quick) { send(quick.dataset.bkQuick); return; }
  const decide = e.target.closest('[data-bk-decide]');
  if (decide) {
    const card = decide.closest('[data-task]');
    card.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    try {
      const t = await hubApi.decideBeikuang(card.dataset.task, decide.dataset.bkDecide);
      view.tasks[t.id] = t;
      card.outerHTML = task(t);
      pop(root.querySelector(`[data-task="${CSS.escape(t.id)}"] .bk-done`));
    } catch (err) {
      note(err.message);
      card.querySelectorAll('button').forEach((b) => { b.disabled = false; });
      if (err.status === 409) refresh();
    }
    return;
  }
  if (e.target.closest('[data-bk-run]')) {
    try { await hubApi.runBeikuang(); note('她去巡检啦，有拿不准的会在这里告诉你。'); busyUntil = Date.now() + 90000; timer = setTimeout(() => refresh(), 2500); }
    catch (err) { note(err.message); }
    return;
  }
  if (e.target.closest('[data-bk-report]')) {
    try { await hubApi.beikuangReport(); note('她在写今天的小报告～'); busyUntil = Date.now() + 180000; timer = setTimeout(() => refresh(), 2500); }
    catch (err) { note(err.message); }
  }
}

async function onSubmit(e) {
  e.preventDefault();
  const answer = e.target.closest('[data-bk-answer]');
  if (answer) {
    const button = answer.querySelector('button');
    button.disabled = true;
    try {
      const t = await hubApi.answerBeikuang(answer.dataset.bkAnswer, answer.elements.answer.value);
      view.tasks[t.id] = t;
      answer.closest('[data-task]').outerHTML = task(t);
      note(t.message || '');
    } catch (err) { note(err.message); button.disabled = false; }
    return;
  }
  if (e.target.matches('[data-bk-form]')) send($('#bk-input').value);
}

function onKey(e) {
  if (e.target.id === 'bk-input' && e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send(e.target.value);
  }
}

function grow() {
  const area = $('#bk-input');
  if (!area) return;
  area.style.height = 'auto';
  area.style.height = `${Math.min(area.scrollHeight, 160)}px`;
}
