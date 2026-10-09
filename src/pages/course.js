import { initShell } from '../js/shell.js';
import { hubApi, hubState, loginURL } from '../js/hub.js';
import { esc } from '../js/data.js';
import { loadLearningCatalogue, LEARNING_ACCESS } from '../js/learning-catalog.js';
import '../styles/learning.css';
import '../styles/course.css';
import '../styles/learning-gallery.css';

initShell();
const $ = (q, root = document) => root.querySelector(q);
const params = new URLSearchParams(location.search);
const courseId = params.get('id') || '';
const state = { local: { items: [], courses: [] }, course: null, user: null, followed: false, thread: null };
const accessNames = { public: '公开获取', campus: '学校授权入口', request: '需向来源申请', unknown: '获取方式待核对', 'local-only': '仅本机', 'external-link': '原站获取', 'awaiting-contributions': '待补充' };
const safeHref = (value) => {
  try { const target = new URL(value, location.href); return /^https?:$/.test(target.protocol) && !target.username && !target.password ? target.href : '#'; } catch { return '#'; }
};
const date = (value) => value ? String(value).slice(0, 10) : '尚未核对';
const moveTo = (node) => node.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
const empty = (text) => `<p class="course-empty">${esc(text)}</p>`;
function resourceRow(item, i) {
  const access = LEARNING_ACCESS[item.access] || accessNames[item.access] || '获取方式待核对';
  const kindNames = { exercise: '练习', exam: '试卷', notes: '笔记', textbook: '教材', paper: '论文', code: '代码', data: '数据', other: '资料', resource: '资料', question: '问题', course: '课程' };
  const details = [kindNames[item.materialType] || item.materialType || kindNames[item.kind] || '资料', item.term || '学期待核对', item.version || '版本待核对', access];
  return `<article class="course-row"><span class="course-row-num">${String(i + 1).padStart(2, '0')}</span><div><h3><a href="${esc(safeHref(item.href))}">${esc(item.title)}</a></h3>${item.summary ? `<p>${esc(item.summary)}</p>` : ''}<p class="course-row-meta">${details.map(esc).join(' · ')}</p><p class="course-row-meta">来源：${esc(item.sourceName || item.sourceNote || (item.sourceUrl ? new URL(safeHref(item.sourceUrl)).hostname : item.access === 'private' ? '个人收藏' : item.localOnly ? '本机资料目录' : '待核对'))} · 核对：${esc(date(item.checkedAt))}</p></div><a class="course-row-arrow" href="${esc(safeHref(item.href))}" aria-label="查看 ${esc(item.title)}">↗</a></article>`;
}
function renderCourse(remote) {
  const localCourse = state.local.courses.find((item) => item.id === courseId);
  const course = remote || localCourse;
  if (!course) { $('#course-title').textContent = '这门课程尚未建档'; $('#course-description').textContent = '可以换一门课程查找，或把具体需求写下来。'; renderDirectory(); return; }
  state.course = course;
  $('#course-title').textContent = course.name || course.title;
  document.title = `${course.name || course.title} · Luokixi`;
  const isCampus = course.scope === 'campus-catalogue';
  $('#course-description').textContent = `${isCampus ? '校内资料目录' : '学习专题'}${course.faculty ? ` · ${course.faculty}` : ' · 开课学院待核对'}${course.verifiedCourseCode ? ` · ${course.verifiedCourseCode}` : ' · 官方课程编号待核对'}`;
  $('#course-content').hidden = false;
  $('#course-directory').hidden = true;
  $('#course-collect').href = `collect.html?course=${encodeURIComponent(courseId)}`;
  $('#course-search').href = `search.html?course=${encodeURIComponent(courseId)}`;
  $('#course-review').href = `reputation.html?view=courses&course=${encodeURIComponent(courseId)}`;
  const localItems = state.local.items.filter((item) => item.group === 'resources' && (item.courseId === courseId || item.courseIds?.includes(courseId)));
  const resources = [...(remote?.resources || [])];
  const seen = new Set(resources.map((item) => item.resourceId || item.id));
  for (const item of localItems) if (!seen.has(item.resourceId || item.id)) { resources.push(item); seen.add(item.resourceId || item.id); }
  $('#course-resource-list').innerHTML = resources.length ? resources.map(resourceRow).join('') : empty(remote ? '还没有关联到这门课程的资料。补充一份你用过的资源，会成为后来的同学的起点。' : '当前本机目录没有对应资料；公开社区数据尚未连接。');
  const offerings = remote?.offerings || [];
  $('#course-offerings').innerHTML = offerings.map((item) => `<a href="reputation.html?offering=${esc(item.id)}">${esc(item.term)} · ${esc(item.teachers.map((teacher) => teacher.name).join('、') || '教师待核对')} ↗</a>`).join('');
  const experiences = remote?.experiences || [];
  $('#course-experience-list').innerHTML = experiences.length ? experiences.map((item, i) => {
    const review = item.review || {};
    return `<article class="course-row"><span class="course-row-num">${String(i + 1).padStart(2, '0')}</span><div><h3><a href="${esc(safeHref(item.href))}">${esc(item.title)}</a></h3><p>${esc(item.summary)}</p><p class="course-row-meta">${esc(item.term || '学期待核对')} · ${esc(review.author?.name || review.author?.username || '匿名同学')}${review.rating ? ` · ${esc(review.rating)} / 5` : ''}</p></div><a class="course-row-arrow" href="${esc(safeHref(item.href))}" aria-label="阅读完整经验">↗</a></article>`;
  }).join('') : empty(remote ? '暂无已审核的课程经验。开课学期和任课教师核对后，可以在对应开课记录下分享。' : '课程经验暂时无法读取，请稍后重试。');
  const questions = remote?.questions || [];
  $('#course-question-list').innerHTML = questions.length ? questions.map((item, i) => `<article class="course-row"><span class="course-row-num">${String(i + 1).padStart(2, '0')}</span><div><h3><a href="${esc(safeHref(item.href))}">${esc(item.title)}</a></h3><p>${esc(item.acceptedAnswer?.body || item.summary)}</p><p class="course-row-meta">${item.acceptedAnswer ? '<span class="course-accepted">已有采纳答案</span> · ' : ''}${Number(item.answerCount || 0)} 条公开回复</p></div><a class="course-row-arrow" href="${esc(safeHref(item.href))}" aria-label="阅读问题与答案">↗</a></article>`).join('') : empty(remote ? '还没有公开问题。遇到困难时，把课程版本和已经尝试过的方法一起写下来。' : '问题暂时无法读取，请稍后重试。');
  $('#course-provenance').innerHTML = `<div><b>课程范围</b><p>${esc(localCourse?.sourceNote || (isCampus ? '依据本站课程目录；请以学校当前开课安排为准。' : '学习专题，不代表已核对本校培养方案。'))}</p>${course.prerequisites ? `<p>先修：${esc(course.prerequisites)}</p>` : ''}${course.sourceUrl ? `<a href="${esc(safeHref(course.sourceUrl))}" target="_blank" rel="noopener noreferrer">查看课程来源 ↗</a>` : ''}</div><div><b>仍待补充</b><p>${esc((remote?.gaps || []).map((gap) => gap.label).join(' · ') || '可以补充资料来源、教材版本与适用学期。')}</p><p>目录核对：${esc(date(localCourse?.checkedAt || course.checkedAt))}</p></div>`;
}
function renderDirectory() {
  $('#course-directory').innerHTML = `<div class="course-directory">${state.local.courses.map((item) => `<a href="course.html?id=${esc(item.id)}"><b>${esc(item.name)}</b><small>${item.scope === 'campus-catalogue' ? '校内资料目录' : '学习专题'} · 查看资料与经验 ↗</small></a>`).join('')}</div>`;
}
function savedDraft() { try { return JSON.parse(sessionStorage.getItem(`lk-learning-question:${courseId}`) || '{}'); } catch { return {}; } }
function showComposer() {
  const box = $('#question-composer'), form = $('#question-form');
  box.hidden = false;
  if (!form.dataset.initialized) {
    const draft = savedDraft();
    form.elements.title.value = draft.title || (params.get('q') ? `求助：${params.get('q')}`.slice(0, 160) : '');
    form.elements.body.value = draft.body || (params.get('q') ? `我正在查找“${params.get('q')}”。\n希望获得：` : '');
    form.elements.courseId.value = draft.courseId || courseId;
    $('#question-context').textContent = params.get('q') ? `来自搜索：${params.get('q')}${params.get('term') ? ` · 学期 ${params.get('term')}` : ''}。下面的内容可自行修改，提交前不会公开。` : '具体描述需要什么帮助。草稿只保存在当前浏览器标签页。';
    form.dataset.initialized = '1';
  }
  moveTo(box); form.elements.title.focus({ preventScroll: true });
}
$('#course-ask').onclick = showComposer;
$('[data-ask]').onclick = showComposer;
$('#question-cancel').onclick = () => { $('#question-composer').hidden = true; $('#course-ask').focus(); };
$('#question-form').oninput = (event) => {
  const form = event.currentTarget;
  try { sessionStorage.setItem(`lk-learning-question:${courseId}`, JSON.stringify({ title: form.elements.title.value, body: form.elements.body.value, courseId: form.elements.courseId.value })); } catch { /* Form remains usable without storage. */ }
};
$('#question-form').onsubmit = async (event) => {
  event.preventDefault();
  const form = event.currentTarget, output = $('#question-status'), button = $('button[type=submit]', form);
  if (!state.user) { output.innerHTML = `草稿已留在本页。<a href="${esc(loginURL())}">登录后提交 ›</a>`; return; }
  button.disabled = true; output.textContent = '正在提交…';
  try {
    const result = await hubApi.request('learning/questions', { title: form.elements.title.value, body: form.elements.body.value, courseId: form.elements.courseId.value, term: params.get('term') || '', confirmPublic: form.elements.confirm.checked });
    try { sessionStorage.removeItem(`lk-learning-question:${courseId}`); } catch { /* no storage */ }
    const submittedCourse = form.elements.courseId.value;
    form.reset(); delete form.dataset.initialized;
    output.textContent = '已提交审核。公开后的回复会出现在你的消息中。';
    if (submittedCourse !== courseId) { location.assign(`course.html?${submittedCourse ? `id=${encodeURIComponent(submittedCourse)}&` : ''}question=${encodeURIComponent(result.id)}`); return; }
    await showThread(result.id);
  } catch (error) { output.textContent = error.message; }
  finally { button.disabled = false; }
};
async function showThread(id) {
  const box = $('#course-thread'); box.hidden = false; box.innerHTML = '<p role="status">正在读取问题…</p>';
  try {
    const entry = await hubApi.entry(id); state.thread = entry;
    if (entry.kind !== 'topic' || entry.data?.circle) throw new Error('这不是课程求助，请从原页面阅读。');
    const data = entry.data?.title ? entry.data : entry.draft;
    if (!data) throw new Error('问题尚未公开或已撤回。');
    const linkedIds = [...new Set([data.learning?.courseId, ...(Array.isArray(data.courses) ? data.courses : [])].filter(Boolean))];
    if (courseId && !linkedIds.includes(courseId)) {
      const actualCourse = linkedIds[0] || '';
      const href = `course.html?${actualCourse ? `id=${encodeURIComponent(actualCourse)}&` : ''}question=${encodeURIComponent(id)}`;
      box.innerHTML = `<p role="status">这条问题不属于当前课程。</p><a href="${esc(href)}">在原课程范围下阅读 ›</a>`;
      return;
    }
    const published = Boolean(entry.revision);
    const canAccept = state.user && (entry.owner?.id === state.user.id || state.user.moderator);
    box.innerHTML = `<p class="learning-eyebrow">${published ? '课程问答' : '仅作者可见 · 待审核'}</p><h2 id="thread-title">${esc(data.title)}</h2><p class="course-thread-body">${esc(data.body || data.summary)}</p><p class="course-thread-footer">${esc(entry.owner?.name || '同学')} · ${esc(date(entry.created))}</p>${published ? `<div class="course-thread-actions"><button class="btn btn-outline" type="button" id="thread-watch">${entry.watch?.includes('discussion') ? '已关注回复' : '关注回复'}</button><span class="learning-muted">${entry.replies.filter((reply) => reply.state === 'published').length} 条公开回复</span></div>` : '<p class="course-empty">审核通过后，其他同学才能看到和回复。后续进展可在个人中心查看。</p>'}<div>${entry.replies.map((reply) => `<article class="course-reply" id="reply-${esc(reply.id)}"><div class="course-reply-header"><b>${esc(reply.author?.name || '同学')}</b><span>${esc(date(reply.created))}</span>${reply.accepted ? '<span class="course-accepted">已采纳</span>' : ''}${reply.state !== 'published' ? '<span>待审核</span>' : ''}</div><p class="course-reply-body">${esc(reply.body)}</p>${canAccept && reply.author?.id !== state.user.id && reply.state === 'published' && !reply.accepted ? `<button type="button" class="course-text-button" data-accept="${esc(reply.id)}">采纳这个回答</button>` : ''}</article>`).join('')}</div>${published ? '<form id="thread-reply"><label>你的回答<textarea name="body" required maxlength="20000" rows="3" placeholder="分享可复查的资料或自己的学习方法"></textarea></label><button class="btn btn-primary" type="submit">提交回答</button></form>' : ''}<p id="thread-status" role="status"></p>`;
    if (/^#reply-[0-9a-f-]+$/.test(location.hash)) { const target = document.getElementById(location.hash.slice(1)); if (target) moveTo(target); }
    if ($('#thread-watch')) $('#thread-watch').onclick = async (event) => {
      if (!state.user) { $('#thread-status').innerHTML = `<a href="${esc(loginURL())}">登录后关注回复 ›</a>`; return; }
      event.currentTarget.disabled = true;
      try { await hubApi.watch(id, entry.watch?.includes('discussion') ? [] : ['discussion', 'revision']); await showThread(id); } catch (error) { $('#thread-status').textContent = error.message; if ($('#thread-watch')) $('#thread-watch').disabled = false; }
    };
    box.querySelectorAll('[data-accept]').forEach((button) => button.onclick = async () => {
      button.disabled = true;
      try { await hubApi.accept(button.dataset.accept); await showThread(id); } catch (error) { $('#thread-status').textContent = error.message; button.disabled = false; }
    });
    if ($('#thread-reply')) $('#thread-reply').onsubmit = async (event) => {
      event.preventDefault(); const form = event.currentTarget, button = $('button', form);
      if (!state.user) { $('#thread-status').innerHTML = `<a href="${esc(loginURL())}">登录后提交回答 ›</a>`; return; }
      button.disabled = true;
      try { const reply = await hubApi.reply(id, form.elements.body.value); await showThread(id); $('#thread-status').textContent = reply.state === 'published' ? '回答已发布。' : '回答已提交审核。'; } catch (error) { $('#thread-status').textContent = error.message; button.disabled = false; }
    };
  } catch (error) { box.innerHTML = `<p role="status">${esc(error.message)}</p>`; }
}
$('#course-follow').onclick = async (event) => {
  if (!state.user) { $('#course-status').innerHTML = `<a href="${esc(loginURL())}">登录后关注课程更新 ›</a>`; return; }
  const button = event.currentTarget; button.disabled = true;
  try { const result = await hubApi.request(`learning/courses/${encodeURIComponent(courseId)}/follow`, { enabled: !state.followed }); state.followed = result.following; button.textContent = state.followed ? '已关注课程更新' : '关注课程更新'; $('#course-status').textContent = state.followed ? '新的已审核资料、经验和求助会通知你。' : '已取消关注。'; } catch (error) { $('#course-status').textContent = error.message; } finally { button.disabled = false; }
};
async function init() {
  const localPromise = loadLearningCatalogue().then((result) => { state.local = result; }).catch(() => { $('#course-status').textContent = '本机资料目录暂时读取失败。'; });
  const remotePromise = courseId ? hubApi.getLearningCourse(courseId).then((value) => ({ value })).catch((error) => ({ error })) : Promise.resolve({});
  const sessionPromise = hubState().then((value) => { state.user = value.user; });
  const courseListPromise = (async () => { const items = []; let offset = 0; do { const result = await hubApi.request(`learning/courses?limit=24&offset=${offset}`); items.push(...result.items); offset = result.nextOffset; } while (offset != null && items.length < 1000); return items; })().catch(() => []);
  await Promise.all([localPromise, sessionPromise]);
  const publicCourses = await courseListPromise;
  const knownCourses = new Map(state.local.courses.map((course) => [course.id, course]));
  for (const course of publicCourses) knownCourses.set(course.id, { ...knownCourses.get(course.id), ...course });
  state.local.courses = [...knownCourses.values()];
  $('#question-course').innerHTML += state.local.courses.map((item) => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('');
  const remote = await remotePromise;
  if (courseId) {
    renderCourse(remote.value);
    if (remote.error) $('#course-status').textContent = '公开社区暂时无法读取；以下保留本机课程目录。';
    if (remote.value) {
      $('#course-follow').hidden = false;
      if (state.user) try { const follow = await hubApi.request(`learning/courses/${encodeURIComponent(courseId)}/follow`); state.followed = follow.following; $('#course-follow').textContent = follow.following ? '已关注课程更新' : '关注课程更新'; } catch { /* Follow action reports actual error. */ }
    }
  } else renderDirectory();
  if (params.has('ask')) showComposer();
  if (params.get('question')) { await showThread(params.get('question')); moveTo(document.getElementById(location.hash.slice(1)) || $('#course-thread')); }
}
init().catch((error) => { $('#course-status').textContent = error.message; });
