import { hubApi } from './hub.js';
import '../styles/operations.css';

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const date = (value) => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '尚无记录';
const size = (value) => `${(Number(value || 0) / 1048576).toFixed(1)} MB`;
const LABELS = { ok: '运行中', disabled: '已停用', waiting: '正在启动', unknown: '尚无心跳记录', stale: '需要检查' };

export function mountOperations(root) {
  if (!root) return () => {};
  let active = true;
  let generation = 0;
  let timer;
  let busy = false;
  let message = '';
  let state;
  let backups = [];

  function render(error = '') {
    if (!active || !root.isConnected) return;
    const alerts = state?.alerts?.incidents?.filter((a) => a.open) ?? [];
    root.innerHTML = `<section class="ops-panel" aria-labelledby="ops-title">
      <div class="me-h-row"><h3 id="ops-title" class="me-h3">网站运行与备份</h3><button class="btn btn-outline btn-sm" data-ops="refresh" ${busy ? 'disabled' : ''}>刷新</button></div>
      ${error ? `<p class="acct-err" role="alert">${esc(error)}</p>` : ''}
      <p class="ops-message" role="status">${esc(message || (!state ? '正在读取运行状态…' : ''))}</p>
      ${state ? `<dl class="ops-facts"><div><dt>本机版本</dt><dd>${esc(state.release)}</dd></div><div><dt>后台处理器</dt><dd>${esc(LABELS[state.worker?.state] ?? state.worker?.state)}</dd></div>
      <div><dt>上次心跳</dt><dd>${esc(date(state.worker?.lastHeartbeat))}</dd></div><div><dt>处理范围</dt><dd>${esc(state.worker?.scope)}</dd></div><div><dt>邮件投递</dt><dd>${esc(state.email?.notice)}</dd></div>
      <div><dt>待审核 / 举报</dt><dd>${state.review?.pending ?? 0} / ${state.review?.reports ?? 0}</dd></div><div><dt>等待 / 执行中</dt><dd>${state.queue?.queued ?? 0} / ${state.queue?.running ?? 0}</dd></div></dl>
      ${alerts.length ? `<ul class="ops-alerts">${alerts.map((a) => `<li><div><b>${esc(a.text)}</b><p>自 ${esc(date(a.since))} · ${a.acknowledged ? '已知悉，等待故障恢复' : '待处理'}</p></div>${!a.acknowledged ? `<button class="btn btn-outline btn-sm" data-ops="ack" data-incident="${esc(a.incident)}">我已知悉</button>` : ''}</li>`).join('')}</ul>` : '<p class="muted">当前没有持续故障告警。</p>'}
      ${state.alerts?.pendingDelivery ? `<p class="notice">还有 ${state.alerts.pendingDelivery} 条故障提醒待送达，系统会保留并重试。</p>` : ''}
      ${state.failures?.length ? `<details><summary>未完成的后台任务（${state.failures.length} 类）</summary><ul class="me-plain">${state.failures.map((j) => `<li><b>${esc(j.kind)}</b> · ${esc(j.error || j.state)} · ${esc(date(j.updated))}</li>`).join('')}</ul></details>` : ''}` : ''}
      <h4>全站私有备份</h4><p class="acct-sub">包含账号、帖子、审核记录和附件；每天保留一份，可另行手动创建。恢复验证在新目录进行。</p>
      <div class="ops-actions"><button class="btn btn-primary btn-sm" data-ops="backup" ${busy ? 'disabled' : ''}>立即备份</button><button class="btn btn-outline btn-sm" data-ops="check" ${busy ? 'disabled' : ''}>检查运行状态</button>${state?.alertPreview ? `<a class="btn btn-outline btn-sm" href="${esc(state.alertPreview)}" target="_blank" rel="noopener">故障告警演练</a>` : ''}</div>
      <p class="acct-hint">备份含私有账号数据，请只保存在自己的电脑。校圈的个人 JSON 导出与全站备份分别保留。</p>
      <ul class="ops-backups">${backups.map((b) => {
        const id = b.id ?? b.backupId;
        return `<li><div><b>${esc(date(b.createdAt ?? b.created))}</b><p>${esc(size(b.bytes ?? b.size))} · ${b.verifiedAt ? `恢复已验证 ${esc(date(b.verifiedAt))}` : '尚未进行恢复验证'}</p></div>
        <div class="ops-actions"><button class="btn btn-outline btn-sm" data-ops="verify" data-id="${esc(id)}" ${busy ? 'disabled' : ''}>验证恢复</button><a class="btn btn-secondary btn-sm" href="/api/hub/operations/backups/${encodeURIComponent(id)}/download" download>下载</a></div></li>`;
      }).join('')}</ul>${!backups.length ? '<p class="muted">尚无完整备份，先创建一份再验证恢复。</p>' : ''}
    </section>`;
  }

  async function refresh() {
    const call = ++generation;
    try {
      const [info, list] = await Promise.all([hubApi.request('operations/status'), hubApi.request('operations/backups')]);
      if (!active || call !== generation) return;
      state = info;
      backups = list.items ?? [];
      render();
    } catch (e) { if (active && call === generation) render(e.message); }
  }

  async function track(job) {
    if (!active || !root.isConnected) return;
    if (job.state === 'done') {
      const result = job.result ?? {};
      message = result.verifiedAt ? '恢复验证成功：数据库与附件已在隔离目录核对。' : '全站备份已完成。';
      busy = false;
      return refresh();
    }
    if (job.state === 'failed') { busy = false; return render(job.error || '任务未完成，原数据保留。'); }
    message = job.state === 'running' ? '正在处理，离开页面后任务仍会继续。' : '任务已排队，等待后台处理器。';
    render();
    timer = setTimeout(async () => {
      if (!active || !root.isConnected) return;
      try { await track(await hubApi.job(job.id)); }
      catch (e) { busy = false; render(e.message); }
    }, 2000);
  }

  async function click(event) {
    const btn = event.target.closest('[data-ops]');
    if (!btn || busy || !root.contains(btn)) return;
    const action = btn.dataset.ops;
    if (action === 'refresh') return refresh();
    busy = true;
    render();
    try {
      if (action === 'backup' || action === 'verify') {
        const body = { requestId: crypto.randomUUID(), ...(action === 'verify' ? { id: btn.dataset.id } : {}) };
        const job = await hubApi.request(action === 'verify' ? 'operations/backup-check' : 'operations/backup', body);
        return await track(job);
      }
      await hubApi.request(action === 'ack' ? 'operations/acknowledge' : 'operations/check', action === 'ack' ? { incident: btn.dataset.incident } : {});
      message = action === 'ack' ? '已记录知悉。告警会在检查恢复后关闭。' : '本轮运行检查已完成。';
      busy = false;
      await refresh();
    } catch (e) { busy = false; render(e.message); }
  }

  root.addEventListener('click', click);
  render();
  refresh();
  return () => { active = false; generation += 1; clearTimeout(timer); root.removeEventListener('click', click); };
}
