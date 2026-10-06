import { initShell } from '../js/shell.js';
import { hubApi, hubState, loginURL } from '../js/hub.js';
import { esc } from '../js/data.js';
import '../styles/reputation.css';

initShell();
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const params = new URLSearchParams(location.search);
const view = params.get('view') || 'teachers';
const targetType = ['teacher', 'offering', 'course'].find(k => params.has(k));
const targetId = targetType && params.get(targetType);
const content = $('#rp-content');
const editor = $('#rp-editor');
let state, current, courses = [], editing, own = [], pendingAction, serial = 0;
const flags = { pending: '待审核', rejected: '已退回', published: '已公开', withdrawn: '已撤回' };
const campusNames = { shahe: '沙河', xueyuanlu: '学院路' };
const safe = value => { try { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password ? u.href : ''; } catch { return ''; } };
const external = (href, label) => safe(href) ? '<a href="' + esc(safe(href)) + '" target="_blank" rel="noopener noreferrer">' + esc(label) + ' ↗</a>' : '';
const href = (type, id, anchor = '') => 'reputation.html?' + type + '=' + encodeURIComponent(id) + anchor;
const date = value => value ? new Date(value).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '';
const empty = (title, message = '') => '<div class="rp-empty"><h2>' + esc(title) + '</h2><p>' + esc(message) + '</p></div>';
function message(value) { $('#rp-message').textContent = value; $('#rp-message').hidden = !value; }
function allowed() {
  if (!state?.online) { message('社区服务尚未连接，请稍后重试。'); return false; }
  if (!state.user) { location.assign(loginURL()); return false; }
  if (!state.user.emailVerified) { message('请先到“我的账号”验证邮箱，再参与评价。'); return false; }
  return true;
}
function stars(value) {
  const fill = value == null ? 0 : Math.max(0, Math.min(100, value / 5 * 100));
  return '<span class="rp-stars" role="img" aria-label="' + (value == null ? '暂无评分' : esc(value) + ' 分，满分 5 分') + '">★★★★★<span aria-hidden="true" style="width:' + fill + '%">★★★★★</span></span>';
}
function portrait(person) {
  const placeholder = '<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="21" r="10"/><path d="M13 55c0-24 38-24 38 0"/></svg>';
  return '<div class="rp-portrait" aria-label="' + (person.photo ? '教师照片' : '照片暂缺') + '">' +
    (safe(person.photo?.url) ? '<img src="' + esc(safe(person.photo.url)) + '" alt="' + esc(person.name) + '的照片" loading="lazy" referrerpolicy="no-referrer">' : placeholder) + '</div>';
}
function repairPhotos() {
  $$('.rp-portrait img').forEach(img => img.addEventListener('error', () => {
    img.parentElement.innerHTML = '<span class="rp-fine">照片暂缺</span>';
  }, { once: true }));
}
function rating(data, url, unit = '人评价') {
  const s = data.stats;
  return '<div class="rp-rating"><a href="' + esc(url) + '#ratings">' + stars(s.average) +
    '<strong>' + (s.average == null ? '暂无评分' : s.average.toFixed(1)) + '</strong></a></div>' +
    '<p class="rp-fine">' + esc(data.ratingLabel || '课程体验') + ' · ' + s.count + ' ' + unit + (s.smallSample ? ' · 样本较少' : '') + '</p>';
}
function quote(item) {
  if (!item) return '<div class="rp-quote"><p class="rp-fine">还没有评价</p><p class="rp-fine">把你的真实体验留给后来的人。</p></div>';
  return '<div class="rp-quote"><p class="rp-fine">' + esc(item.label) + '</p><a href="' + esc(item.href) + '">' +
    '<blockquote>“' + esc(item.body) + '”</blockquote></a><p class="rp-fine">' + item.likes + ' 赞' +
    (item.courseName ? ' · ' + esc(item.courseName) : '') + (item.term ? ' · ' + esc(item.term) : '') + '</p></div>';
}
function card(item, kind) {
  const url = href(kind, item.id);
  return '<article class="rp-card"><a class="rp-card-link" href="' + esc(url) + '" aria-label="查看' + esc(item.name) + '详情"></a>' +
    (kind === 'teacher' ? portrait(item) : '<p class="eyebrow">' + (item.scope === 'general-topic' ? '学习专题' : '课程与资料') + '</p>') +
    '<h2>' + esc(item.name) + '</h2><p class="rp-fine">' + esc(item.faculty || '学院信息待核') + '</p>' +
    rating(item, url, kind === 'teacher' ? '人评价' : '份评价') + quote(item.highlight) +
    '<a class="rp-card-tail" href="' + esc(url) + '">查看详情 →</a></article>';
}
function distribution(stats) {
  return '<section class="rp-section" id="ratings"><h2>评分与评论</h2><div class="rp-dist"><div><strong>' +
    (stats.average == null ? '—' : stats.average.toFixed(1)) + '</strong><p class="rp-fine">满分 5 分<br>' +
    stats.count + ' 份评价' + (stats.smallSample ? '<br>样本较少' : '') + '</p></div><div>' +
    [5, 4, 3, 2, 1].map(n => '<div class="rp-dist-row"><span>' + n + ' 星</span><meter min="0" max="' +
      Math.max(1, stats.count) + '" value="' + stats.distribution[n] + '" aria-label="' + n + '星 ' +
      stats.distribution[n] + '人"></meter><span>' + stats.distribution[n] + '</span></div>').join('') +
    '</div></div></section>';
}
function reviewHTML(r, privateView = false) {
  return '<article class="rp-review" id="review-' + esc(r.id) + '"><header><div><strong>' + esc(r.author.name) +
    '</strong><p class="rp-fine">' + esc([r.courseName, r.term, date(r.publishedAt)].filter(Boolean).join(' · ')) +
    '</p></div>' + stars(r.rating) + '</header>' + (privateView ? '<p class="rp-fine">版本 ' + r.revision + ' · ' + esc(flags[r.state] || r.state) + '</p>' : '') +
    '<p class="rp-review-body">' + esc(r.body) + '</p>' +
    (privateView && r.note ? '<p class="rp-message">审核说明：' + esc(r.note) + '</p>' : '') +
    '<div class="rp-actions">' + (privateView ?
      '<button data-action="edit" data-id="' + esc(r.id) + '">修改评价</button>' +
      (r.state !== 'withdrawn' ? '<button data-action="withdraw" data-id="' + esc(r.id) + '">撤回</button>' : '') +
      (['rejected', 'withdrawn'].includes(r.state) ? '<button data-action="appeal" data-id="' + esc(r.id) + '">申诉</button>' : '') :
      (!r.own ? '<button data-action="like" data-id="' + esc(r.id) + '" aria-pressed="' + r.liked + '">赞同 · ' + r.likes + '</button>' : '') +
      '<button data-action="thread" data-id="' + esc(r.id) + '">查看回复</button><button data-action="report" data-id="' + esc(r.id) + '">举报</button>' +
      (r.own ? '<a href="reputation.html?view=mine">管理我的评价</a>' : '')) +
    '</div><div data-thread="' + esc(r.id) + '"></div></article>';
}
function pager(next, currentOffset) {
  return '<div class="rp-pager">' + (currentOffset ? '<button class="btn btn-secondary" data-page="' + Math.max(0, currentOffset - 24) + '">上一页</button>' : '') +
    (next != null ? '<button class="btn btn-secondary" data-page="' + next + '">下一页</button>' : '') + '</div>';
}
async function directory() {
  const kind = view === 'courses' ? 'course' : 'teacher';
  const offset = Number(params.get('offset') || 0);
  const query = { q: params.get('q') || '', offset };
  const data = await (kind === 'teacher' ? hubApi.teachers(query) : hubApi.courses(query));
  content.innerHTML = '<form class="rp-toolbar" id="rp-search"><input name="q" aria-label="搜索教师、课程或学院" placeholder="搜索' +
    (kind === 'teacher' ? '教师姓名、学院' : '课程名称') + '" value="' + esc(query.q) + '"><button class="btn btn-primary">搜索</button></form>' +
    '<p class="rp-fine">' + data.total + ' 项已收录资料 · 评分来自同学评价</p><div class="rp-grid">' +
    data.items.map(t => card(t, kind)).join('') + '</div>' + (!data.items.length ? empty('暂时没有匹配的资料', '可以更换关键词；教师与开课资料核对后逐步补充。') : '') + pager(data.nextOffset, offset);
  $('#rp-search').addEventListener('submit', event => {
    event.preventDefault();
    params.set('q', new FormData(event.target).get('q'));
    params.delete('offset');
    location.assign('reputation.html?' + params);
  });
}
function resourcesHTML(course) {
  return '<section class="rp-section"><h2>学习引导与资源</h2><p>' + esc(course.prerequisites || '先修建议尚待同学补充。') +
    '</p><p class="rp-fine">站内帮你选择和整理。课程讲解、练习与辅导在原平台进行。</p>' +
    (course.resources.length ? course.resources.map(r => '<div class="rp-resource"><h3>' + esc(r.title) + '</h3><p class="rp-fine">' +
      esc(r.type + ' · ' + r.audience) + '</p><p class="rp-fine">' +
      esc(({ free: '免费资源', paid: '收费', mixed: '部分收费', unknown: '收费情况以原站为准' })[r.cost]) +
      ' · 核对于 ' + esc(r.checkedAt) + '</p>' + external(r.url, '前往外部平台') + '</div>').join('') : '<p class="rp-fine">外部资源尚待核对。</p>') +
    '<p class="rp-resource"><a href="knowledge.html">到站内知识库查找资料 →</a></p></section>';
}
async function detail() {
  current = await (targetType === 'teacher' ? hubApi.teacher(targetId) : targetType === 'course' ? hubApi.course(targetId) : hubApi.offering(targetId));
  const name = current.name;
  document.title = name + ' · 选课与口碑 · Luokixi';
  content.innerHTML = '<a href="reputation.html' + (targetType === 'teacher' ? '' : '?view=courses') + '">← 返回' +
    (targetType === 'teacher' ? '教师口碑' : '课程目录') + '</a><section class="rp-detail-head">' +
    (targetType === 'teacher' ? portrait(current) : '') + '<div><p class="eyebrow">' + (targetType === 'teacher' ? '教学体验' : '课程与引导') +
    '</p><h2>' + esc(name) + '</h2><p class="rp-fine">' + esc([current.faculty, current.term, campusNames[current.campus]].filter(Boolean).join(' · ')) +
    '</p>' + external(current.sourceUrl, '查看原始资料') +
    (current.photo ? '<p class="rp-fine">' + esc(current.photo.credit) + ' · ' + external(current.photo.sourceUrl, '照片出处') + '</p>' : '') +
    (targetType !== 'course' ? '<div class="rp-actions"><button class="btn btn-primary" data-action="write">写评价</button><a href="reputation.html?view=mine">我的评价</a></div>' : '') +
    '</div></section><div id="rp-summary">' + distribution(current.stats) +
    '<section class="rp-section"><h2>同学的原话</h2>' + quote(current.highlight) + '</section></div>' +
    (targetType === 'teacher' ? '<section class="rp-section"><h2>授课信息</h2>' + (current.teaching.length ?
      current.teaching.map(t => '<p class="rp-resource">' + esc(t.name) + ' · ' + external(t.sourceUrl, '资料来源') + '</p>').join('') :
      '<p class="rp-fine">授课信息尚待核对。</p>') + '<p class="rp-fine">以上为来源页面所列经历，不代表本学期一定开课。</p></section>' : resourcesHTML(current.course || current)) +
    '<section class="rp-section"><h2>' + (targetType === 'offering' ? '本次开课的教师' : '具体开课记录') + '</h2>' +
    (targetType === 'offering' ? current.teachers.map(t => '<p class="rp-resource"><a href="' + esc(href('teacher', t.id)) + '">' + esc(t.name) + ' · 查看独立的教师口碑 →</a></p>').join('') :
      (current.offerings || []).map(o => '<p class="rp-resource"><a href="' + esc(href('offering', o.id)) + '">' +
        esc(o.name + ' · ' + o.term + ' · ' + campusNames[o.campus]) + ' →</a></p>').join('') ||
      '<p class="rp-fine">学期、校区与授课安排核对后再开放对应课程评价。</p>') +
    '</section><section class="rp-section"><h2>完整评论</h2><form class="rp-toolbar" id="rp-filters">' +
    '<label>排序 <select name="sort"><option value="newest">最新发布</option><option value="likes">点赞最多</option></select></label>' +
    '<label>学期 <input name="term" placeholder="全部学期" maxlength="80"></label>' +
    (targetType === 'teacher' ? '<label>课程 <select name="course"><option value="">全部课程</option>' + courses.map(c => '<option value="' + esc(c.id) + '">' + esc(c.name) + '</option>').join('') + '</select></label>' : '') +
    '<button class="btn btn-secondary">筛选</button></form><div id="rp-reviews"></div></section>';
  $('#rp-filters').addEventListener('submit', event => { event.preventDefault(); loadReviews(0).catch(fail); });
  await loadReviews(0);
}
async function loadReviews(offset) {
  const localSerial = ++serial;
  const filters = Object.fromEntries(new FormData($('#rp-filters')));
  filters[targetType] = targetId;
  filters.offset = offset;
  const data = await hubApi.reviews(filters);
  if (localSerial !== serial) return;
  const anchorId = location.hash.startsWith('#review-') ? location.hash.slice(8) : '';
  if (!offset && anchorId && !data.items.some(r => r.id === anchorId)) {
    try {
      const pinned = await hubApi.courseReview(anchorId);
      if ((pinned.subjectType === targetType && pinned.subjectId === targetId) || (targetType === 'course' && pinned.courseId === targetId)) data.items.unshift(pinned);
    } catch { message('引用的评价已撤回，或暂时不可查看。'); }
  }
  $('#rp-reviews').innerHTML = data.items.length ? data.items.map(r => reviewHTML(r)).join('') + pager(data.nextOffset, offset) :
    '<p class="rp-fine">还没有符合筛选条件的公开评论。</p>';
  jumpToHash();
}
function jumpToHash() {
  if (location.hash) requestAnimationFrame(() => document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView({ block: 'start' }));
}
async function mine() {
  if (!state.user) { content.innerHTML = empty('登录后管理自己的评价') + '<a class="btn btn-primary" href="' + esc(loginURL()) + '">登录 / 注册</a>'; return; }
  const data = await hubApi.myReviews();
  own = data.items;
  content.innerHTML = '<section class="rp-section"><h2>我的评价</h2><p class="rp-fine">待审、退回与撤回内容仅你和维护者可见。修改发布后，旧版本的点赞会清除。</p>' +
    (own.length ? own.map(r => '<p><a href="' + esc(href(r.subjectType, r.subjectId)) + '">查看评价对象 →</a></p>' + reviewHTML(r, true)).join('') :
      '<p>你还没有发表评价。</p>') + '</section>' + (data.cases.length ? '<section class="rp-section"><h2>我的反馈与申诉</h2>' +
      data.cases.map(c => '<article class="rp-review"><p>' + esc(c.body) + '</p><p class="rp-fine">' + esc(c.resolution || '等待维护者处理') + '</p></article>').join('') + '</section>' : '');
}
async function moderation() {
  if (!state.user?.moderator) { content.innerHTML = empty('此入口仅供维护者使用'); return; }
  const data = await hubApi.reviewModeration();
  own = data.reviews;
  const teachers = (await hubApi.teachers()).items;
  const options = courses.map(c => '<option value="' + esc(c.id) + '">' + esc(c.name) + '</option>').join('');
  content.innerHTML = '<section class="rp-section"><h2>评价审核 · ' + data.reviews.length + '</h2>' +
    data.reviews.map(r => '<article class="rp-review"><p>' + stars(r.rating) + ' · ' + esc(r.courseName || '教师整体口碑') + '</p><p class="rp-review-body">' + esc(r.body) +
      '</p><a href="' + esc(href(r.subjectType, r.subjectId)) + '">查看评价对象</a><div class="rp-actions">' +
      '<button data-action="approve" data-id="' + esc(r.id) + '" data-version="' + r.revision + '">通过</button>' +
      '<button data-action="reject" data-id="' + esc(r.id) + '" data-version="' + r.revision + '">退回</button></div></article>').join('') +
    (!data.reviews.length ? '<p class="rp-fine">没有待审核评价。</p>' : '') + '</section><section class="rp-section"><h2>回复审核</h2>' +
    data.replies.map(r => '<article class="rp-review"><p class="rp-review-body">' + esc(r.body) + '</p><div class="rp-actions">' +
      '<button data-action="reply-approve" data-id="' + esc(r.id) + '">通过回复</button><button data-action="reply-reject" data-id="' + esc(r.id) + '">退回回复</button></div></article>').join('') +
    '</section><section class="rp-section"><h2>举报与申诉</h2>' + data.cases.map(c => '<article class="rp-review"><p>' + esc(c.kind === 'appeal' ? '申诉' : '举报') +
      '</p><p class="rp-review-body">' + esc(c.body) + '</p><div class="rp-actions"><button data-action="resolve" data-id="' + esc(c.id) + '">记录处理结果</button>' +
      '<button data-action="withdraw" data-id="' + esc(c.reviewId) + '">撤回相关评价</button></div></article>').join('') +
    '</section><details class="rp-section rp-admin"><summary>补充教师与开课资料</summary>' +
    '<form id="rp-teacher-form"><h3>教师资料</h3><label>选择已有教师或新增<select name="id"><option value="">新增教师</option>' +
    teachers.map(t => '<option value="' + esc(t.id) + '">' + esc(t.name) + '</option>').join('') + '</select></label>' +
    '<div class="rp-two"><label>姓名<input name="name" required maxlength="80"></label><label>学院<input name="faculty" maxlength="120"></label></div>' +
    '<label>职称<input name="title" maxlength="80"></label><label>资料来源<input type="url" name="sourceUrl" required></label>' +
    '<label>可使用的照片地址（可选）<input type="url" name="photoUrl"></label><label>照片来源页面<input type="url" name="photoSource"></label>' +
    '<label>照片署名<input name="photoCredit" maxlength="160"></label><label class="rp-check"><input type="checkbox" name="photoRights">已核对照片可用于展示</label>' +
    '<label class="rp-check"><input type="checkbox" name="checked" required>已核对教师资料来源</label><button class="btn btn-primary">保存教师</button></form>' +
    '<form id="rp-offering-form"><h3>具体开课记录</h3><label>课程<select name="courseId">' + courses.filter(c => c.scope === 'campus-catalogue').map(c => '<option value="' + esc(c.id) + '">' + esc(c.name) + '</option>').join('') +
    '</select></label><label>授课教师<select name="teacher" required><option value="">请选择</option>' +
    teachers.map(t => '<option value="' + esc(t.id) + '">' + esc(t.name) + '</option>').join('') + '</select></label>' +
    '<div class="rp-two"><label>学期<input name="term" required maxlength="80"></label><label>校区<select name="campus"><option value="shahe">沙河</option><option value="xueyuanlu">学院路</option></select></label></div>' +
    '<label>本次开课的来源<input type="url" name="sourceUrl" required></label><label class="rp-check"><input type="checkbox" name="checked" required>已核对学期、校区与授课安排</label><button class="btn btn-primary">保存开课记录</button></form>' +
    '<form id="rp-resource-form"><h3>补充外部学习入口</h3><label>课程 / 专题<select name="courseId">' + options + '</select></label>' +
    '<label>资源名称<input name="title" required maxlength="120"></label><label>外部地址<input name="url" type="url" required></label>' +
    '<label>类型<input name="type" required placeholder="例如课程讲解、练习平台"></label><label>适用基础<input name="audience" required maxlength="200"></label>' +
    '<div class="rp-two"><label>收费情况<select name="cost"><option value="unknown">以原站为准</option><option value="free">免费</option><option value="paid">收费</option><option value="mixed">部分收费</option></select></label>' +
    '<label>核对日期<input name="checkedAt" type="date" required></label></div><button class="btn btn-primary">保存学习入口</button></form></details>';
  $('#rp-teacher-form select[name=id]').addEventListener('change', async event => {
    const t = event.target.value ? await hubApi.teacher(event.target.value) : {};
    const form = $('#rp-teacher-form');
    ['name', 'faculty', 'title', 'sourceUrl'].forEach(k => form.elements[k].value = t[k] || '');
    form.elements.photoUrl.value = t.photo?.url || '';
    form.elements.photoSource.value = t.photo?.sourceUrl || '';
    form.elements.photoCredit.value = t.photo?.credit || '';
    form.elements.photoRights.checked = false;
    form.elements.checked.checked = false;
    form.dataset.teaching = JSON.stringify(t.teaching || []);
  });
  for (const [id, kind] of [['rp-teacher-form', 'teachers'], ['rp-offering-form', 'offerings'], ['rp-resource-form', 'courses']]) {
    $('#' + id).addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.target, f = Object.fromEntries(new FormData(form)), btn = $('button[type=submit],button:not([type])', form);
      btn.disabled = true;
      try {
        let data;
        if (kind === 'teachers') data = { id: f.id || undefined, name: f.name, faculty: f.faculty, title: f.title, sourceUrl: f.sourceUrl,
          sourceChecked: f.checked === 'on', teaching: JSON.parse(form.dataset.teaching || '[]'),
          photo: f.photoUrl ? { url: f.photoUrl, sourceUrl: f.photoSource, credit: f.photoCredit, rightsConfirmed: f.photoRights === 'on' } : {} };
        else if (kind === 'offerings') data = { courseId: f.courseId, teachers: [f.teacher], term: f.term, campus: f.campus, sourceUrl: f.sourceUrl, sourceChecked: f.checked === 'on' };
        else {
          const c = await hubApi.course(f.courseId);
          data = { ...c, sourceChecked: true, resources: [...c.resources.filter(r => r.url !== f.url), { title: f.title, url: f.url, type: f.type, audience: f.audience, cost: f.cost, checkedAt: f.checkedAt }] };
        }
        await hubApi.saveReputationCatalogue(kind, data);
        message('资料已保存。');
        await moderation();
      } catch (error) { fail(error); } finally { btn.disabled = false; }
    });
  }
}
async function openEditor(review) {
  if (!allowed()) return;
  editing = review || null;
  const form = $('#rp-review-form');
  form.reset();
  form.elements.courseId.innerHTML = '<option value="">暂不填写</option>' + courses.map(c => '<option value="' + esc(c.id) + '">' + esc(c.name) + '</option>').join('');
  const kind = review?.subjectType || targetType;
  $('#rp-context-fields').hidden = kind === 'offering';
  $('#rp-editor-title').textContent = review ? '修改评价' : '分享教学体验';
  $('#rp-subject-label').textContent = kind === 'teacher' ? '教师整体教学体验 · 与课程评分分别计算' : '本次开课的课程体验';
  if (review) {
    form.elements.rating.value = review.rating;
    form.elements.body.value = review.body;
    form.elements.courseId.value = review.courseId;
    form.elements.term.value = review.term;
    form.elements.anonymous.checked = review.anonymous;
  }
  $('#rp-editor-error').textContent = '';
  editor.showModal();
}
$('#rp-review-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.target, f = new FormData(form), btn = $('button[type=submit]', form);
  const data = { rating: Number(f.get('rating')), body: f.get('body'), courseId: f.get('courseId'), term: f.get('term'), anonymous: f.has('anonymous') };
  btn.disabled = true;
  try {
    if (editing) await hubApi.saveReview(editing.id, editing.revision, data);
    else await hubApi.submitReview({ subjectType: targetType, subjectId: targetId, data });
    editor.close();
    message('评价已提交审核。可以在“我的评价”中查看结果。');
    if (view === 'mine') await mine();
  } catch (error) { $('#rp-editor-error').textContent = error.message; } finally { btn.disabled = false; }
});
$$('dialog [data-close]').forEach(btn => btn.addEventListener('click', () => btn.closest('dialog').close()));
function actionDialog(title, callback) {
  pendingAction = callback;
  $('#rp-action-form').reset();
  $('#rp-action-title').textContent = title;
  $('#rp-action-error').textContent = '';
  $('#rp-action-dialog').showModal();
}
$('#rp-action-form').addEventListener('submit', async event => {
  event.preventDefault();
  const btn = $('button[type=submit]', event.target);
  btn.disabled = true;
  try {
    await pendingAction(new FormData(event.target).get('reason'));
    $('#rp-action-dialog').close();
    message('已保存。');
    await render();
  } catch (error) { $('#rp-action-error').textContent = error.message; } finally { btn.disabled = false; }
});
content.addEventListener('click', async event => {
  const btn = event.target.closest('[data-action], [data-page]');
  if (!btn) return;
  try {
    if (btn.dataset.page != null) {
      if (targetType) return await loadReviews(Number(btn.dataset.page));
      params.set('offset', btn.dataset.page);
      return location.assign('reputation.html?' + params);
    }
    const { action, id, version } = btn.dataset;
    if (action === 'thread') {
      const r = await hubApi.courseReview(id);
      const box = $('[data-thread="' + id + '"]');
      box.innerHTML = r.replies.map(x => '<div class="rp-reply"><p class="rp-fine">' + esc(x.author.name) + ' · ' + date(x.created) + '</p><p class="rp-review-body">' + esc(x.body) + '</p></div>').join('') +
        (!r.replies.length ? '<p class="rp-fine">还没有公开回复。</p>' : '') + '<div class="rp-actions"><button data-action="reply" data-id="' + esc(id) + '">匿名回复</button></div>';
      return;
    }
    if (!allowed()) return;
    if (action === 'write') return openEditor();
    if (action === 'edit') return openEditor(own.find(r => r.id === id));
    if (action === 'like') {
      btn.disabled = true;
      const r = await hubApi.likeReview(id, btn.getAttribute('aria-pressed') !== 'true');
      btn.setAttribute('aria-pressed', String(r.liked));
      btn.textContent = '赞同 · ' + r.likes;
      if (targetType) {
        const d = await (targetType === 'teacher' ? hubApi.teacher(targetId) : targetType === 'course' ? hubApi.course(targetId) : hubApi.offering(targetId));
        $('#rp-summary').innerHTML = distribution(d.stats) + '<section class="rp-section"><h2>同学的原话</h2>' + quote(d.highlight) + '</section>';
      }
      btn.disabled = false;
      return;
    }
    const operations = {
      withdraw: ['撤回评价的原因', reason => hubApi.withdrawReview(id, reason)],
      report: ['举报说明', reason => hubApi.reportReview(id, reason)],
      appeal: ['申诉说明', reason => hubApi.appealReview(id, reason)],
      reply: ['匿名回复', reason => hubApi.replyToReview(id, reason)],
      approve: ['通过审核的说明', reason => hubApi.moderateReview(id, Number(version), 'approve', reason)],
      reject: ['退回原因', reason => hubApi.moderateReview(id, Number(version), 'reject', reason)],
      'reply-approve': ['通过回复的说明', reason => hubApi.moderateReviewReply(id, 'approve', reason)],
      'reply-reject': ['退回回复的原因', reason => hubApi.moderateReviewReply(id, 'reject', reason)],
      resolve: ['处理结果', reason => hubApi.resolveReviewCase(id, reason)],
    };
    if (operations[action]) actionDialog(...operations[action]);
  } catch (error) { btn.disabled = false; fail(error); }
});
function fail(error) { message(error.message || '暂时无法加载，请稍后重试。'); }
async function render() {
  if (targetType) await detail();
  else if (view === 'mine') await mine();
  else if (view === 'moderation') await moderation();
  else await directory();
  repairPhotos();
}
async function start() {
  state = await hubState();
  $('#rp-mod-link').hidden = !state.user?.moderator;
  const tab = targetType ? (targetType === 'teacher' ? 'teachers' : 'courses') : view;
  $('[data-tab="' + tab + '"]')?.setAttribute('aria-current', 'page');
  if (!state.online) {
    content.innerHTML = empty('口碑服务暂时未连接', '评分与评论需要社区服务。已有资料和外部学习入口仍可浏览。') +
      '<div class="rp-actions"><a href="school.html">查看校内资料</a><a href="discover.html">发现开源项目</a></div>';
    return;
  }
  let offset = 0;
  do {
    const page = await hubApi.courses({ offset });
    courses.push(...page.items);
    offset = page.nextOffset;
  } while (offset != null && courses.length < 1000);
  await render();
}
addEventListener('hashchange', jumpToHash);
start().catch(error => { content.innerHTML = empty('加载暂时失败', '刷新页面后再试。'); fail(error); });
