import { initShell } from '../js/shell.js';
import { hubApi, hubState, loginURL } from '../js/hub.js';
import { esc } from '../js/data.js';
import '../styles/learning.css';
import '../styles/course.css';
initShell();
const $ = (s) => document.querySelector(s);
const states = { updated: '已发现更新', unchanged: '没有新内容', empty: '有效订阅，本次为空', failed: '检查失败', unchecked: '尚未检查' };
const date = (v) => v ? new Date(v).toLocaleString('zh-CN') : '暂无';
async function load() {
  try {
    const data = await hubApi.request('learning/sources');
    $('#sources-status').textContent = `${data.items.length} 个已登记来源`;
    $('#sources-list').innerHTML = data.items.map((source) => `<article class="course-row"><span class="course-row-num">${source.enabled ? '开' : '停'}</span><div><h3><a href="${esc(source.url)}" target="_blank" rel="noopener noreferrer">${esc(source.name)}</a></h3><p>${esc(source.metadata?.school || '学校待核对')} · ${esc(source.metadata?.department || '部门待补充')} · ${esc(source.kind)} · 每 ${source.intervalHours} 小时</p><p>维护人：${esc(source.metadata?.maintainer || '待指定')}</p><p>${esc(states[source.status] || source.status)}${source.matched != null ? ` · 读到 ${source.matched} 条 · ${source.pending || 0} 条待审核` : ''}</p><p class="course-row-meta">最近尝试：${esc(date(source.lastAttempt))}<br>最近成功：${esc(date(source.lastSuccess))}</p>${source.error ? `<p>${esc(source.error)}</p>` : ''}</div><button class="course-text-button" type="button" data-refresh="${esc(source.id)}">检查</button></article>`).join('') || '<p class="course-empty">尚未登记来源。可先添加已核对的公开课程或图书馆订阅。</p>';
    $('#source-editor').hidden = false;
  } catch (error) { $('#sources-status').textContent = error.message; }
}
$('#sources-list').onclick = async (event) => {
  const button = event.target.closest('[data-refresh]'); if (!button) return;
  button.disabled = true;
  try { const job = await hubApi.refreshSource(button.dataset.refresh); $('#sources-status').textContent = `已排队检查（${job.state}），采集服务完成后刷新此页查看结果。`; } catch (error) { $('#sources-status').textContent = error.message; } finally { button.disabled = false; }
};
$('#source-form').onsubmit = async (event) => {
  event.preventDefault(); const f = event.currentTarget, button = f.querySelector('button'), output = $('#source-form-status'); button.disabled = true;
  try { await hubApi.saveSource({ name: f.elements.name.value, url: f.elements.url.value, kind: f.elements.kind.value, entry_kind: f.elements.entry_kind.value, interval_hours: Number(f.elements.interval_hours.value), enabled: f.elements.enabled.checked, metadata: { school: '中国矿业大学（北京）', department: f.elements.department.value, maintainer: f.elements.maintainer.value } }); output.textContent = '来源已登记。'; f.reset(); await load(); } catch (error) { output.textContent = error.message; } finally { button.disabled = false; }
};
hubState().then((state) => { if (!state.user) $('#sources-status').innerHTML = `<a href="${esc(loginURL())}">维护者登录后查看来源 ›</a>`; else load(); });
