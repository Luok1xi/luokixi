import { fuzzySearch } from '../js/fuzzy-search.js';
import { attachSearchSuggestions } from '../js/search-suggestions.js';
import { initShell } from '../js/shell.js';
import { canParticipate, hubApi, loginURL } from '../js/hub.js';
import { esc } from '../js/data.js';
import { normalizeSource, listPrivateResources, savePrivateResource, deletePrivateResource,
  exportPrivateResourceIndex } from '../js/private-resources.js';
import '../styles/collect.css';
import '../styles/learning-gallery.css';

initShell();
const $ = selector => document.querySelector(selector);
const params = new URLSearchParams(location.search);
const form = $('#collect-form');
let courses = [], offerings = [], privateItems = [], busy = false, courseEpoch = 0, previewEpoch = 0;
let publicEntry = null, publicUpload = null, postedSignature = '', chosenFile = null;
const text = id => $(id).value.trim();
const isPublic = () => form.elements.visibility.value === 'public';
const file = () => $('#file').files[0] || null;
const course = () => courses.find(item => item.id === text('#course'));

function feedback(selector, message, error = false) {
  const node = $(selector); node.textContent = message; node.classList.toggle('is-error', error);
}
function setBusy(value) {
  busy = value;
  form.setAttribute('aria-busy', String(value));
  // Freeze the submitted values while upload/create/submit progress in sequence.
  for (const element of form.elements) {
    if (value) { element.dataset.wasDisabled = String(element.disabled); element.disabled = true; }
    else { element.disabled = element.dataset.wasDisabled === 'true'; delete element.dataset.wasDisabled; }
  }
}
function showDestination() {
  const shared = isPublic();
  $('#public-options').hidden = !shared;
  $('#rights').required = shared;
  $('#license').required = shared;
  $('#source-note').required = shared;
  $('#course').required = shared;
  $('#save').textContent = shared ? '确认发送并提交公开审核' : '保存到本机';
  $('#save-scope').textContent = shared ? '会发送填写的信息及所选文件；审核通过后才公开。' : '不会上传，也不会进入公开搜索。';
}
function learning(sourceUrl) {
  return { school: 'cumtb', courseId: text('#course'), offeringId: text('#offering'), term: text('#term'),
    faculty: course()?.faculty || '', materialType: text('#material-type'), version: text('#version'),
    access: text('#access'), checkedAt: text('#checked-at'), sourceUrl };
}

async function loadOfferings() {
  const epoch = ++courseEpoch;
  offerings = [];
  $('#offering').innerHTML = '<option value="">不限某次开课 / 尚未核实</option>';
  $('#offering').disabled = true; $('#term').readOnly = false; $('#term').value = '';
  if (!text('#course') || !hubApi.available) return;
  feedback('#course-status', '正在读取该课程的开课记录…');
  try {
    const result = await hubApi.course(text('#course'));
    if (epoch !== courseEpoch) return;
    offerings = result.offerings || [];
    $('#offering').innerHTML += offerings.map(item => `<option value="${esc(item.id)}">${esc([item.term, ...(item.teachers || []).map(t => t.name)].filter(Boolean).join(' · ') || '开课信息待核实')}</option>`).join('');
    $('#offering').disabled = !offerings.length;
    feedback('#course-status', offerings.length ? '可关联具体开课，避免把不同学期的经验混在一起。' : '该课程尚无已登记的开课记录；可以先关联课程。');
    if (params.get('offering') && offerings.some(item => item.id === params.get('offering'))) {
      $('#offering').value = params.get('offering'); $('#offering').dispatchEvent(new Event('change'));
    }
  } catch (error) { if (epoch === courseEpoch) feedback('#course-status', `${error.message} 仍可仅关联课程。`, true); }
}

async function loadCourses() {
  if (!hubApi.available) { feedback('#course-status', '当前为静态浏览，暂不能读取课程目录；私人资料可先保存，稍后关联。'); return; }
  try {
    let offset = 0;
    for (let page = 0; page < 63; page++) {
      const result = await hubApi.request(`learning/courses?offset=${offset}&limit=24`);
      courses.push(...(result.items || []));
      if (result.nextOffset == null || result.nextOffset <= offset) break;
      offset = result.nextOffset;
    }
    $('#course').innerHTML = '<option value="">稍后关联</option>' + courses.map(item => `<option value="${esc(item.id)}">${esc(item.name)}${item.faculty ? ` · ${esc(item.faculty)}` : ''}</option>`).join('');
    const requested = params.get('course');
    if (requested && courses.some(item => item.id === requested)) { $('#course').value = requested; await loadOfferings(); }
    else feedback('#course-status', courses.length ? '课程按现有目录关联，未核实的信息可留空。' : '尚无课程记录，私人资料可先保存；公开投稿需先有明确课程。');
  } catch (error) { feedback('#course-status', `${error.message} 私人资料可先不关联课程。`, true); }
}

function renderMatches(matches) {
  $('#duplicates').hidden = !matches.length;
  $('#duplicates').innerHTML = matches.length ? `<strong>已有相同来源，先看看是否适用</strong><ul>${matches.map(item => `<li><a href="project.html?id=${encodeURIComponent(item.id)}">${esc(item.title)}</a> · ${esc(item.version || '版本未核实')}</li>`).join('')}</ul><p>相同来源可能有不同版本。可在已有条目订阅更新、回复补充；新版本请注明区别后提交。</p>` : '';
}

$('#source').addEventListener('input', () => {
  previewEpoch++; renderMatches([]); feedback('#preview-status', '');
});
$('#preview').addEventListener('click', async () => {
  if (busy) return;
  const epoch = ++previewEpoch;
  try {
    const source = normalizeSource(text('#source'));
    if (!source.sourceUrl) throw new Error('请先填写公开链接或 DOI。');
    $('#preview').disabled = true;
    feedback('#preview-status', $('#fetch-metadata').checked ? '正在查重并读取来源网页的公开标题…' : '正在本站公开记录中查找相同来源…');
    const result = await hubApi.request('learning/preview', { source: source.sourceUrl, fetchMetadata: $('#fetch-metadata').checked });
    if (epoch !== previewEpoch) return;
    if (!text('#title') && result.title) $('#title').value = result.title;
    if (!text('#credit') && result.credit) $('#credit').value = result.credit;
    renderMatches(result.matches || []);
    feedback('#preview-status', result.notice || '识别完成，请确认标题和适用范围。');
  } catch (error) { if (epoch === previewEpoch) feedback('#preview-status', error.message, true); }
  finally { if (!busy) $('#preview').disabled = false; }
});

$('#file').addEventListener('change', () => {
  const selected = file();
  if (selected !== chosenFile) { publicUpload = null; chosenFile = selected; }
  $('#clear-file').hidden = !selected;
  feedback('#file-status', selected ? `已在本机选择 ${selected.name}（${(selected.size / 1024 / 1024).toFixed(2)} MB），尚未上传。` : '选择文件只在本机读取；保存为私人资料时，原文件留在当前浏览器。');
  if (!text('#title') && selected) $('#title').value = selected.name.replace(/\.[^.]+$/, '').slice(0, 160);
});
$('#clear-file').addEventListener('click', () => { $('#file').value = ''; $('#file').dispatchEvent(new Event('change')); });
$('#course').addEventListener('change', loadOfferings);
$('#offering').addEventListener('change', () => {
  const selected = offerings.find(item => item.id === text('#offering'));
  $('#term').readOnly = Boolean(selected); $('#term').value = selected?.term || '';
});
form.querySelectorAll('[name=visibility]').forEach(radio => radio.addEventListener('change', showDestination));

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || !form.reportValidity()) return;
  let source, selected;
  try {
    source = normalizeSource(text('#source')); selected = file();
    if (!source.sourceUrl && !selected) throw new Error('请提供一个链接、DOI 或本地文件。');
    if (selected && (!selected.size || selected.size > 25 * 1024 * 1024)) throw new Error('请选择非空且不超过 25 MB 的文件。');
    if (isPublic() && (!course() || !$('#rights').checked)) throw new Error('请关联现有课程，并确认有权公开分享。');
    if (isPublic() && selected && !/\.(pdf|txt|md|csv|png|jpe?g|webp|zip|stl|step|ipynb)$/i.test(selected.name)) throw new Error('公开附件暂不支持此格式。请改用来源链接，或只保存到本机。');
    if (isPublic() && selected && text('#access') === 'campus') throw new Error('学校授权资料请只分享官方来源链接，保留原文件在本机。');
  } catch (error) { feedback('#save-status', error.message, true); return; }
  const shared = isPublic();
  const local = { title: text('#title'), summary: text('#summary'), credit: text('#credit'), ...source, learning: learning(source.sourceUrl), fileBlob: selected, fileName: selected?.name || '' };
  setBusy(true);
  feedback('#save-status', shared ? '正在确认投稿账号…' : '正在保存到当前浏览器…');
  try {
    if (!shared) {
      const result = await savePrivateResource(local);
      await loadPrivate();
      feedback('#save-status', result.duplicate ? '本机已有同一来源或相同文件、课程与版本，已保留原有记录；可在下方查看。' : '已保存到本机。笔记与文件没有上传。');
      document.getElementById(`saved-${result.item.id}`)?.classList.add('is-saved');
    } else {
      const state = await hubApi.session();
      if (!state.user) {
        feedback('#save-status', '请先登录并验证邮箱后公开投稿。当前表单还没有发送。', true);
        const link = document.createElement('a'); link.href = loginURL(); link.target = '_blank'; link.rel = 'noopener'; link.textContent = ' 在新窗口登录'; $('#save-status').append(link);
        return;
      }
      if (!canParticipate(state.user)) throw new Error('请先在账号页面完成邮箱验证后再公开投稿。');
      const payload = { title: local.title, summary: local.summary, course: course().name, courses: [course().id],
        learning: local.learning, doi: source.doi, links: source.sourceUrl ? { source: source.sourceUrl } : {},
        uploads: publicUpload ? [publicUpload.id] : [], credit: text('#credit'), license: text('#license'),
        sourceNote: text('#source-note'), rightsConfirmed: true, tags: [] };
      const signature = JSON.stringify(payload);
      feedback('#save-status', '正在建立待审核投稿…');
      if (!publicEntry) publicEntry = await hubApi.create('resource', payload);
      else if (signature !== postedSignature) publicEntry = await hubApi.save(publicEntry.id, publicEntry.editRevision, payload);
      postedSignature = signature;
      // Validate the complete metadata server-side in a draft before any file leaves
      // the browser. Both steps are covered by the explicit public-submit consent.
      if (selected && !publicUpload) {
        feedback('#save-status', '课程信息已核对，正在发送你明确选择公开的附件…');
        publicUpload = await hubApi.upload(selected);
        if (publicUpload.matchingEntries?.length) renderMatches(publicUpload.matchingEntries);
        payload.uploads = [publicUpload.id];
        publicEntry = await hubApi.save(publicEntry.id, publicEntry.editRevision, payload);
        postedSignature = JSON.stringify(payload);
      }
      publicEntry = await hubApi.submit(publicEntry.id, publicEntry.editRevision);
      feedback('#save-status', '已提交公开审核，当前尚未公开。');
      const link = document.createElement('a'); link.href = `project.html?id=${encodeURIComponent(publicEntry.id)}`; link.textContent = ' 查看投稿状态'; $('#save-status').append(link);
      // Keep the submitted record visible, but a later explicit submission is a new version/record.
      publicEntry = null; publicUpload = null; postedSignature = '';
      $('#rights').checked = false;
    }
  } catch (error) {
    feedback('#save-status', error.message + (publicEntry ? ' 已创建的草稿仍保留，可在“我的”继续处理或在此重试。' : publicUpload ? ' 附件已发送到你的账号，尚未公开；可重试投稿。' : ''), true);
  } finally { setBusy(false); $('#save-status').focus({ preventScroll: true }); }
});

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
}
const privateSearchText = item => [item.summary, item.credit, item.sourceUrl, item.doi, item.fileName, courses.find(course => course.id === item.learning?.courseId)?.name, ...Object.values(item.learning || {})].filter(Boolean).join(' ');
attachSearchSuggestions($('#private-query'), { getItems: () => privateItems, getText: privateSearchText,
  getMeta: item => [item.fileName, item.learning?.term, item.learning?.version].filter(Boolean).join(' · '), onSelect: () => renderPrivate() });
function renderPrivate() {
  const shown = fuzzySearch(privateItems, text('#private-query'), { getText: privateSearchText, limit: Infinity });
  $('#export-index').disabled = !privateItems.length;
  feedback('#private-status', privateItems.length ? `${privateItems.length} 份保存在本机${text('#private-query') ? ` · 找到 ${shown.length} 份` : ''}` : '');
  $('#private-items').innerHTML = shown.length ? shown.map(item => {
    const courseName = courses.find(c => c.id === item.learning?.courseId)?.name || item.learning?.courseId;
    const meta = [courseName || '暂未关联课程', item.learning?.term, item.learning?.version || '版本未核实', item.credit, item.fileName].filter(Boolean).join(' · ');
    let sourceLink = '';
    try { const source = normalizeSource(item.sourceUrl); if (source.sourceUrl) sourceLink = `<a href="${esc(source.sourceUrl)}" target="_blank" rel="noopener noreferrer">打开原始链接</a>`; } catch { /* Do not render unsafe old data. */ }
    return `<article id="saved-${esc(item.id)}" class="collect-private-item${params.get('saved') === item.id ? ' is-saved' : ''}"><h3>${esc(item.title)}</h3><p>${esc(item.summary)}</p><p class="collect-hint">${esc(meta)}</p><div class="collect-private-actions">${sourceLink}${item.fileBlob ? `<button type="button" class="btn btn-secondary" data-download="${esc(item.id)}">下载本机原文件</button>` : ''}<button type="button" class="btn btn-link" data-remove="${esc(item.id)}">删除本机记录</button></div></article>`;
  }).join('') : `<p class="collect-empty">${privateItems.length ? '本机没有匹配的资料，试试更短的关键词。' : '这里留给你自己的学习资料。先保存一份链接或文件，不需要公开分享。'}</p>`;
}
async function loadPrivate() {
  try { privateItems = await listPrivateResources(); renderPrivate(); }
  catch (error) { feedback('#private-status', error.message, true); }
}
$('#private-query').addEventListener('input', event => { if (!event.isComposing) renderPrivate(); });
$('#private-query').addEventListener('compositionend', renderPrivate);
$('#private-items').addEventListener('click', async event => {
  const download = event.target.closest('[data-download]');
  if (download) {
    const item = privateItems.find(item => item.id === download.dataset.download);
    if (item?.fileBlob) downloadBlob(item.fileBlob, item.fileName || '资料文件');
  }
  const remove = event.target.closest('[data-remove]');
  if (!remove) return;
  const item = privateItems.find(item => item.id === remove.dataset.remove);
  if (!item || !confirm(`删除本机的“${item.title}”？记录和保存在浏览器中的文件会一起移除。`)) return;
  try { await deletePrivateResource(item.id); await loadPrivate(); }
  catch (error) { feedback('#private-status', error.message, true); }
});
$('#export-index').addEventListener('click', () => {
  downloadBlob(new Blob([JSON.stringify(exportPrivateResourceIndex(privateItems), null, 2)], { type: 'application/json' }), 'luokixi-private-links.json');
  feedback('#private-status', '已导出链接与课程标识索引，不包含笔记和文件。');
});
showDestination();
loadCourses().then(() => { if (privateItems.length) renderPrivate(); });
loadPrivate();
if (hubApi.available) hubApi.session().then(state => { $('#source-management').hidden = !state.user?.moderator; }).catch(() => {});
