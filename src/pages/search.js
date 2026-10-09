import { attachSearchSuggestions } from '../js/search-suggestions.js';
import { initShell } from '../js/shell.js';
import { hubApi } from '../js/hub.js';
import { campusApi } from '../../campus/client.js';
import { esc } from '../js/data.js';
import { LEARNING_GROUPS, LEARNING_ACCESS, loadLearningCatalogue, searchLearningCatalogue, normalizeLocalFullTextResults, safeLearningUrl, buildLearningHelpUrl } from '../js/learning-catalog.js';
import '../styles/learning.css';
import '../styles/learning-gallery.css';

initShell();
const $ = (selector) => document.querySelector(selector);
const TYPE_LABELS = { all: '全部', ...LEARNING_GROUPS };
const FILTER_IDS = { course: 'courses', term: 'terms', faculty: 'faculty', access: 'access' };
const FILTER_LABELS = { course: '全部课程', term: '全部学期', faculty: '全部学院', access: '全部方式' };
const MISSING_LABELS = { school: '适用学校', access: '获取方式', publicationStatus: '发表状态', courseId: '适用课程', term: '适用学期', faculty: '学院', sourceUrl: '来源', version: '版本', checkedAt: '核对时间', offeringId: '开课安排', course_code: '官方课程代码' };
let filters = readFilters();
let catalogue = { items: [], courses: [], notes: [] };
let localPending = true;
let localError = '';
let remote = { groups: [], facets: {}, nextOffset: null, limitations: [] };
let remotePending = false;
let remoteError = '';
let generation = 0;
let visibleLimit = 12;
let localTextEnabled = false;
let localTextPending = false;
let localTextError = '';
let localTextResult = { items: [], total: 0, scanned: 0 };
let localTextGeneration = 0;
const isLocalHost = ['127.0.0.1', 'localhost'].includes(location.hostname);

function readFilters() {
  const params = new URLSearchParams(location.search);
  return { q: (params.get('q') || '').slice(0, 160), type: Object.hasOwn(TYPE_LABELS, params.get('type')) ? params.get('type') : 'all', school: 'cumtb', course: params.get('course') || '', term: params.get('term') || '', faculty: params.get('faculty') || '', access: params.get('access') || '' };
}
function saveURL() {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value && key !== 'school' && !(key === 'type' && value === 'all')) params.set(key, value);
  const next = `${location.pathname}${params.size ? `?${params}` : ''}`;
  if (next !== `${location.pathname}${location.search}`) history.pushState(null, '', next);
}
function helpURL() { return buildLearningHelpUrl(filters.q, filters.course, filters); }
function safeLink(url, label, extra = '') {
  const href = safeLearningUrl(url);
  return href ? `<a href="${esc(href)}"${/^https?:\/\//.test(href) ? ' target="_blank" rel="noopener noreferrer"' : ''}${extra}>${label}</a>` : '';
}
function dateLabel(value) {
  const date = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '待核实';
}
function sourceLabel(url) {
  try { return new URL(url, location.href).hostname; } catch { return '来源'; }
}
function cardHTML(item) {
  const group = item.group || 'resources';
  const href = safeLearningUrl(item.href);
  const courseLink = item.courseId ? `<a href="course.html?id=${encodeURIComponent(item.courseId)}">${esc(item.courseName || item.courseId)}</a>` : '适用课程待核实';
  const source = safeLink(item.sourceUrl, esc(sourceLabel(item.sourceUrl)));
  const snippet = item.snippet || item.match?.snippet || item.summary;
  const missing = (Array.isArray(item.missingMetadata) ? item.missingMetadata : []).map((key) => MISSING_LABELS[key] || key);
  const scope = [group === 'courses' ? '' : courseLink, item.term ? `学期 ${esc(item.term)}` : group === 'courses' ? '' : '学期待补充', item.faculty ? esc(item.faculty) : '', item.version ? `版本 ${esc(item.version)}` : '', item.year ? `${esc(item.year)} 年` : ''].filter(Boolean).join('<span aria-hidden="true">·</span>');
  const kind = item.scope === 'learning-topic' ? '学习专题' : item.materialType && !['other', 'course'].includes(item.materialType) ? ({ notes: '笔记', textbook: '教材', exam: '试卷', exercise: '练习', code: '代码', data: '数据', dataset: '数据集', tool: '工具', paper: '论文', question: '问答', experience: '学习经验' }[item.materialType] || item.materialType) : LEARNING_GROUPS[group] || '资料';
  return `<li class="learning-card">
    <div class="learning-card-copy">
      <div class="learning-card-meta"><span>${esc(kind)}</span>${filters.q && item.match ? `<span class="learning-match">${esc(item.match.reason || (item.match.kind === 'exact' ? '编号精确匹配' : '目录关键词匹配'))}</span>` : ''}</div>
      <h4>${href ? safeLink(href, esc(item.title)) : esc(item.title)}</h4>
      ${snippet ? `<p>${esc(snippet)}</p>` : '<p>尚未补充摘要。</p>'}
      ${scope ? `<div class="learning-card-meta">${scope}</div>` : ''}
      ${item.matchPage ? `<div class="learning-card-meta">本机文件 · 命中第 ${esc(item.matchPage)} 页</div>` : ''}
      <div class="learning-card-meta"><span>来源 ${source || (item.localOnly ? '本机资料目录' : '待核实')}</span><span>核对 ${esc(dateLabel(item.checkedAt))}</span></div>
      ${missing.length ? `<p class="learning-missing">待补充：${esc(missing.join('、'))}</p>` : ''}
    </div>
    <div class="learning-card-side"><span class="learning-tag"${item.localOnly || item.access === 'local-only' || item.access === 'private' ? ' data-local' : ''}>${esc(LEARNING_ACCESS[item.access] || '获取方式待核实')}</span>${href ? safeLink(href, `${group === 'courses' ? '进入课程' : group === 'questions' ? '查看讨论' : group === 'experiences' ? '阅读经验' : '查看资料'} <span aria-hidden="true">↗</span>`) : '<span class="learning-muted">入口待补充</span>'}</div>
  </li>`;
}

function renderFilters(local) {
  if (!$('#learning-types').children.length) $('#learning-types').innerHTML = Object.entries(TYPE_LABELS).map(([type, label]) => `<button type="button" data-type="${type}">${label}</button>`).join('');
  $('#learning-types').querySelectorAll('[data-type]').forEach((button) => button.setAttribute('aria-current', String(filters.type === button.dataset.type)));
  for (const [key, facetKey] of Object.entries(FILTER_IDS)) {
    const choices = new Map();
    for (const choice of [...(local.facets?.[facetKey] || []), ...(remote.facets?.[facetKey] || [])]) {
      const value = String(choice.value ?? choice.id ?? '');
      if (value) choices.set(value, (key === 'access' ? LEARNING_ACCESS[value] : '') || choice.label || choice.name || value);
    }
    if (filters[key] && !choices.has(filters[key])) choices.set(filters[key], key === 'access' ? LEARNING_ACCESS[filters[key]] || filters[key] : filters[key]);
    const element = $(`#learning-${key}`);
    const options = `<option value="">${FILTER_LABELS[key]}</option>` + [...choices].map(([value, label]) => `<option value="${esc(value)}">${esc(label)}</option>`).join('');
    if (element.innerHTML !== options) element.innerHTML = options;
    element.value = filters[key];
  }
  $('#learning-reset').hidden = !Object.keys(FILTER_IDS).some((key) => filters[key]) && filters.type === 'all';
  $('#learning-ask').href = helpURL();
  $('#learning-local-toggle').hidden = !catalogue.isLocal || !isLocalHost;
  $('#learning-local-text').disabled = filters.access === 'private';
}

function render() {
  const local = searchLearningCatalogue(catalogue.items, filters);
  renderFilters(local);
  const allGroups = Object.entries(LEARNING_GROUPS).map(([key, label]) => {
    const localGroup = local.groups.find((group) => group.key === key);
    const publicGroup = remote.groups?.find((group) => group.key === key);
    const merged = new Map();
    const identity = (item) => `${key}:${key === 'courses' ? item.courseId || item.id : item.id}`;
    for (const item of localGroup?.items || []) merged.set(identity(item), item);
    if (key === 'resources') for (const item of localTextResult.items) merged.set(identity(item), item);
    for (const item of publicGroup?.items || []) {
      const previous = merged.get(identity(item));
      merged.set(identity(item), { ...previous, ...item, summary: item.summary || previous?.summary || '', group: key });
    }
    // An exact identifier remains above a looser title match from another source.
    const exact = (item) => item.match?.kind === 'exact' || Number(item.match?.score) >= 1000;
    const items = [...merged.values()].sort((a, b) => Number(exact(b)) - Number(exact(a)));
    return { key, label, items, hasMore: !!publicGroup?.hasMore || items.length > (filters.type === 'all' ? 4 : visibleLimit) };
  }).filter((group) => group.items.length && (filters.type === 'all' || group.key === filters.type));
  const count = allGroups.reduce((total, group) => total + Math.min(group.items.length, filters.type === 'all' ? 4 : visibleLimit), 0);
  const pending = localPending || remotePending || localTextPending;
  $('#learning-results').setAttribute('aria-busy', String(pending));
  $('#learning-results-heading').textContent = filters.q ? `“${filters.q}”的搜索结果` : filters.type === 'all' ? '探索课程与资料' : TYPE_LABELS[filters.type];
  $('#learning-result-status').textContent = pending ? `正在${count ? '更新' : '读取'}结果…` : `已显示 ${count} 项`;
  const notes = [...new Set(catalogue.notes || [])];
  const limitations = Array.isArray(remote.limitations) ? remote.limitations : [];
  const readableLimitations = limitations.map((note) => typeof note === 'string' ? note : note.message || note.label || '').filter(Boolean);
  const scopeNotes = [...new Set([...notes, ...readableLimitations])];
  $('#learning-notices').innerHTML = [localError ? `<p class="learning-note" data-error>${esc(localError)}<button type="button" data-retry-local>重试目录</button></p>` : '', remoteError ? `<p class="learning-note" data-error>${esc(remoteError)}${hubApi.available ? '<button type="button" data-retry>重试公开内容</button>' : ''}</p>` : '', localTextError ? `<p class="learning-note" data-error>${esc(localTextError)}<button type="button" data-retry-text>重试正文检索</button></p>` : '', localTextEnabled && !localTextPending && !localTextError && filters.access !== 'private' ? `<p class="learning-note">本次最多检索 30 条本机正文结果，已读取 ${localTextResult.scanned} 条；筛选后显示 ${localTextResult.items.length} 条。${safeLink(`knowledge.html?q=${encodeURIComponent(filters.q)}`, '查看全部正文结果 ↗')}</p>` : '', scopeNotes.length ? `<details class="learning-scope"><summary>来源与收录范围</summary>${scopeNotes.map((note) => `<p>${esc(note)}</p>`).join('')}</details>` : ''].join('');
  if (allGroups.length) {
    $('#learning-results').innerHTML = allGroups.map((group) => `<section class="learning-group" aria-labelledby="learning-group-${group.key}"><div class="learning-group-head"><h3 id="learning-group-${group.key}">${esc(group.label)}<span>${Math.min(group.items.length, filters.type === 'all' ? 4 : visibleLimit)} 项已载入</span></h3>${filters.type === 'all' ? `<button type="button" data-type="${group.key}">查看这类结果 <span aria-hidden="true">→</span></button>` : ''}</div><ul class="learning-list">${group.items.slice(0, filters.type === 'all' ? 4 : visibleLimit).map(cardHTML).join('')}</ul></section>`).join('');
  } else if (pending) {
    $('#learning-results').innerHTML = '<p class="learning-loading">正在读取课程、资料与公开经验…</p>';
  } else {
    $('#learning-results').innerHTML = `<div class="learning-empty"><h3>${localError && remoteError ? '暂时无法读取搜索目录' : '已载入的目录里还没有匹配内容'}</h3><p>${localError && remoteError ? '请重试连接；读取失败不代表内容不存在。' : '试试课程全名、减少筛选，或把问题交给同学一起补充。'}</p><a class="btn btn-outline" href="${esc(helpURL())}">带着这个问题继续</a></div>`;
  }
  const more = $('#learning-more');
  more.hidden = filters.type === 'all' || (!allGroups.some((group) => group.hasMore) && remote.nextOffset == null);
  more.disabled = remotePending;
  more.textContent = remotePending ? '正在读取…' : '继续查看';
}

async function queryPublic({ more = false } = {}) {
  const ticket = ++generation;
  if (!more) { remote = { groups: [], facets: {}, nextOffset: null, limitations: [] }; visibleLimit = 12; }
  remoteError = '';
  if (localTextEnabled || ['private', 'local-only'].includes(filters.access)) { remotePending = false; render(); return; }
  if (!hubApi.available) {
    remoteError = '当前为静态目录模式，公开问答与经验搜索暂不可用。';
    remotePending = false; render(); return;
  }
  remotePending = true; render();
  try {
    const result = await hubApi.searchLearning({ ...filters, limit: 12, offset: more ? remote.nextOffset || 0 : 0 });
    if (ticket !== generation) return;
    if (more) {
      for (const group of result.groups || []) {
        const previous = remote.groups.find((entry) => entry.key === group.key);
        if (previous) {
          const unique = new Map([...(previous.items || []), ...(group.items || [])].map((item) => [item.id, item]));
          Object.assign(previous, group, { items: [...unique.values()] });
        } else remote.groups.push(group);
      }
      Object.assign(remote, { nextOffset: result.nextOffset, facets: result.facets, limitations: result.limitations });
    } else remote = result;
  } catch {
    if (ticket !== generation) return;
    remoteError = '公开内容暂时读取失败。下面保留已载入的课程和本机资料，结果可能不完整。';
  } finally {
    if (ticket === generation) { remotePending = false; render(); }
  }
}

async function queryLocal(refresh = false) {
  localPending = true; localError = ''; render();
  try { catalogue = await loadLearningCatalogue({ refresh }); }
  catch { localError = '课程与资料目录暂时读取失败，无法确认本机资料的搜索结果。'; }
  finally { localPending = false; render(); }
}

async function queryLocalText() {
  const ticket = ++localTextGeneration;
  localTextResult = { items: [], total: 0, scanned: 0 };
  localTextError = '';
  if (!localTextEnabled || !catalogue.isLocal || !isLocalHost || filters.access === 'private') { localTextPending = false; render(); return; }
  localTextPending = true; render();
  try {
    const response = await campusApi.catalogue({ q: filters.q }, { signal: AbortSignal.timeout(7000) });
    if (ticket !== localTextGeneration) return;
    localTextResult = normalizeLocalFullTextResults(response, catalogue, filters);
  } catch {
    if (ticket === localTextGeneration) localTextError = '本机正文检索暂时失败，当前仍可查看目录匹配结果。';
  } finally {
    if (ticket === localTextGeneration) { localTextPending = false; render(); }
  }
}

function updateFilters(patch) {
  Object.assign(filters, patch); saveURL();
  $('#learning-q').value = filters.q;
  queryPublic();
  queryLocalText();
}

attachSearchSuggestions($('#learning-q'), {
  getItems: () => {
    const local = searchLearningCatalogue(catalogue.items, { ...filters, q: '', limit: 10000 }).items;
    // Suggestions never make a request and never copy private/local titles into a public query.
    const publicItems = localTextEnabled || ['private', 'local-only'].includes(filters.access) ? [] : (remote.groups || []).flatMap(group => group.items || []);
    return [...local, ...publicItems];
  },
  getText: item => [item.summary, item.courseName, item.reportedCourseName, item.materialType, item.term, item.year].filter(Boolean).join(' '),
  getKeywords: item => [item.id, item.code, item.resourceId].filter(Boolean).join(' '),
  getMeta: item => [item.courseName, item.term, LEARNING_ACCESS[item.access]].filter(Boolean).join(' · '),
  onSelect: (item, { query }) => updateFilters({ q: query, ...(item.access === 'private' ? { access: 'private' } : item.localOnly || item.access === 'local-only' ? { access: 'local-only' } : {}) }),
});

$('#learning-q').value = filters.q;
$('#learning-search-form').addEventListener('submit', (event) => { event.preventDefault(); updateFilters({ q: $('#learning-q').value.trim() }); });
for (const key of Object.keys(FILTER_IDS)) $(`#learning-${key}`).addEventListener('change', (event) => updateFilters({ [key]: event.target.value }));
$('#learning-reset').addEventListener('click', () => updateFilters({ type: 'all', course: '', term: '', faculty: '', access: '' }));
$('#learning-local-text').checked = false;
$('#learning-local-text').addEventListener('change', (event) => { localTextEnabled = event.target.checked; queryPublic(); queryLocalText(); });
document.addEventListener('click', (event) => {
  const type = event.target.closest('[data-type]');
  const query = event.target.closest('[data-query]');
  if (type) { updateFilters({ type: type.dataset.type }); $(`#learning-types [data-type="${filters.type}"]`).focus({ preventScroll: true }); }
  if (query) updateFilters({ q: query.dataset.query });
  if (event.target.closest('[data-retry]')) queryPublic();
  if (event.target.closest('[data-retry-local]')) queryLocal(true);
  if (event.target.closest('[data-retry-text]')) queryLocalText();
});
$('#learning-more').addEventListener('click', () => {
  visibleLimit += 12;
  if (remote.nextOffset != null) queryPublic({ more: true }); else render();
});
window.addEventListener('popstate', () => { filters = readFilters(); $('#learning-q').value = filters.q; queryPublic(); queryLocalText(); });
queryLocal();
queryPublic();
