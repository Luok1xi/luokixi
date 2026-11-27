import { esc } from './data.js';
import { createStore, createIngest, PWM_LIMIT } from './robot-live-data.js';
import { createChart } from './robot-live-charts.js';
import { normalizeSpeedCapture, importSpeedCSV, speedCSV, speedResponse, scopeRange, captureFingerprint, nearestSpeedSample } from './robot-speed-response.js';
import '../styles/robot-speed-scope.css';

const STORAGE = 'rl-speed-runs-v1', MAX_RUNS = 12;
const format = (value, digits = 1) => Number.isFinite(value) ? value.toFixed(digits) : '—';
const metaText = capture => {
  const h = capture.header, gain = (key, scale) => h[key] === undefined ? '未记录' : format(Number(h[key]) / scale, key.startsWith('kp') ? 1 : 2);
  return `左 ${gain('kpL', 10)} / ${gain('kiL', 100)} · 右 ${gain('kpR', 10)} / ${gain('kiR', 100)} · 负压 ${h.fan_pct === undefined ? '未记录' : h.fan_pct + '%'}${h.build ? ' · ' + h.build : ''}`;
};

export function mountSpeedScope(host) {
  const controller = new AbortController(), on = (element, event, fn) => element.addEventListener(event, fn, { signal: controller.signal });
  const $ = selector => host.querySelector(selector);
  let runs = [], selected = null, reference = '', side = 'L', range = [0, 2000], hover = null, charts = null, frame = 0, disposed = false;
  let storageWarning = '';
  host.classList.add('rs-scope');
  host.innerHTML = `
    <div class="rs-heading"><div><h3>单趟速度波形</h3><p class="rl-sub">完整记录 → 放大看细节 → 和上一趟比较</p></div><div class="rs-actions"><button type="button" data-rs-import>导入 CSV</button><input type="file" data-rs-file accept=".csv,text/csv" hidden><button type="button" data-rs-csv disabled>保存 CSV</button><button type="button" data-rs-png disabled>保存波形图</button></div></div>
    <p class="rs-notice" data-rs-notice role="status">跑完后在调参区点“取完整波形”，也可以导入已保存的 capture.csv。</p>
    <div class="rs-controls"><label>查看这一趟<select data-rs-run aria-label="选择单趟记录"><option value="">暂无记录</option></select></label><label>叠加对照<select data-rs-reference aria-label="选择对照记录"><option value="">不对照</option></select></label><div class="rs-side" role="group" aria-label="选择车轮"><button type="button" data-rs-side="L" aria-pressed="true">左轮</button><button type="button" data-rs-side="R" aria-pressed="false">右轮</button></div></div>
    <div data-rs-content hidden>
      <p class="rs-meta" data-rs-meta></p><p class="rl-sub" data-rs-reference-meta></p>
      <div class="rs-metrics" data-rs-metrics></div>
      <div class="rs-windows" role="group" aria-label="波形时间窗口"><button type="button" data-rs-window="all">整趟</button><button type="button" data-rs-window="rise">起步</button><button type="button" data-rs-window="plateau">平台</button><button type="button" data-rs-window="fall">回零</button><button type="button" data-rs-zoom="0.5" aria-label="时间轴放大两倍">放大 +</button><button type="button" data-rs-zoom="2" aria-label="时间轴缩小两倍">缩小 −</button><span class="rl-sub">纵轴按整趟固定，放大不改变幅度比例</span></div>
      <figure class="rs-figure"><figcaption><span><i class="rs-target"></i>目标 <i class="rs-feedback"></i>控制器速度反馈</span><span>计数 / 2 ms · 对照为虚线</span></figcaption><canvas data-rs-speed tabindex="0" aria-label="速度波形，左右方向键逐点查看，上下方向键放大缩小"></canvas></figure>
      <output class="rs-readout" data-rs-readout aria-live="off">移动到曲线上查看采样值；也可聚焦曲线后按左右方向键。</output>
      <figure class="rs-figure rs-pwm"><figcaption>电机输出 PWM · 独立纵轴 ±8500</figcaption><canvas data-rs-pwm aria-label="电机 PWM 输出波形"></canvas></figure>
      <div class="rs-time"><label>起点 ms<input type="number" data-rs-from step="2"></label><label>终点 ms<input type="number" data-rs-to step="2"></label><label class="rs-pan">平移时间窗<input type="range" data-rs-pan min="0" max="1000" value="0" aria-label="平移波形时间窗口"></label></div>
      <p class="rl-sub" data-rs-definition></p>
      <p class="rl-sub">速度是控制器使用的编码器反馈，不等同于独立原始测速。图像不加平滑；细节来自板载记录，串口实时状态不足以替代 2 ms 阶跃波形。</p>
    </div>
    <p class="rl-sub rs-storage">最近 12 趟仅保存在此浏览器。刷新可恢复；换浏览器不会同步，重要记录请保存 CSV。</p>`;

  const hydrate = record => ({ ...record, capture: normalizeSpeedCapture(record.capture), store: null });
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE));
    if (Array.isArray(saved)) runs = saved.slice(0, MAX_RUNS).map(hydrate).filter(record => typeof record.id === 'string' && typeof record.name === 'string');
  } catch { storageWarning = '本地历史未能读取，新记录仍可导出。'; }

  function persist() {
    try { localStorage.setItem(STORAGE, JSON.stringify(runs.map(({ id, name, savedAt, capture }) => ({ id, name, savedAt, capture })))); storageWarning = ''; }
    catch { storageWarning = '浏览器存储空间不足，本趟未持久保存，请下载 CSV。'; }
  }
  function storeOf(record) {
    if (!record.store) { record.store = createStore(record.capture.rows.length + 1); createIngest(record.store).push(record.capture); }
    return record.store;
  }
  function responseOf(record) {
    record.responses ||= {};
    return record.responses[side] ||= speedResponse(record.capture, side);
  }
  const current = () => runs.find(run => run.id === selected);
  const compared = () => runs.find(run => run.id === reference && run.id !== selected);
  function updateOptions() {
    const options = runs.map(run => `<option value="${esc(run.id)}">${esc(run.name)}</option>`).join('');
    $('[data-rs-run]').innerHTML = options || '<option value="">暂无记录</option>';
    $('[data-rs-run]').value = selected || '';
    $('[data-rs-reference]').innerHTML = '<option value="">不对照</option>' + runs.filter(run => run.id !== selected).map(run => `<option value="${esc(run.id)}">${esc(run.name)}</option>`).join('');
    $('[data-rs-reference]').value = reference;
  }
  function announce() {
    const run = current();
    $('[data-rs-notice]').textContent = storageWarning || (run ? `${run.capture.complete ? '导出结构完整' : '记录完整性未确认'} · ${run.capture.rows.length} 点${run.capture.issues.length ? ' · ' + run.capture.issues.join('；') : ' · 请结合车况比较，不自动判定调参通过'}` : '跑完后在调参区点“取完整波形”，也可以导入已保存的 capture.csv。');
    $('[data-rs-notice]').dataset.complete = String(Boolean(run?.capture.complete));
  }
  function metricMarkup(result) {
    if (!result.available) return `<p class="rl-sub">${esc(result.reason)}</p>`;
    return [['上升 10→90%', result.riseMs, 'ms'], ['超调', result.overshootPct, '%'], ['平台均值', result.mean, ''], ['平台峰峰值', result.peakToPeak, ''], ['回零 ±10%', result.returnMs, 'ms']]
      .map(([label, value, unit]) => `<div><span>${label}</span><strong>${format(value)}<small>${unit}</small></strong></div>`).join('');
  }
  function rebuild() {
    const run = current(), other = compared();
    $('[data-rs-content]').hidden = !run;
    $('[data-rs-csv]').disabled = $('[data-rs-png]').disabled = !run;
    updateOptions(); announce();
    if (!run) return;
    const result = responseOf(run);
    $('[data-rs-meta]').textContent = metaText(run.capture);
    $('[data-rs-reference-meta]').textContent = other ? `对照：${other.name} · ${metaText(other.capture)}。按目标开始时刻对齐；条件不同不代表参数优劣。` : '';
    $('[data-rs-metrics]').innerHTML = metricMarkup(result);
    $('[data-rs-definition]').textContent = result.available ? `平台窗口：${format(result.platformStartMs, 0)}～${format(result.endMs, 0)} ms（目标开始后 300 ms 至回零前，${result.platformN} 点）。上升时间取首个达到 10% 与 90% 的采样点；回零需落在目标 ±10% 内并至少保持到记录末尾 100 ms。${result.completePulse ? '' : '缺少阶跃前或回零段，不能评价完整响应。'}` : '阶跃指标只适用于目标恒定的单趟测试。动态目标、缺行及稀疏状态不作响应判定。';
    const extents = [run, other].filter(Boolean).flatMap(record => record.capture.rows.flatMap(row => [row[`set${side}`], row[`enc${side}`]]).filter(Number.isFinite));
    const lo = Math.floor(Math.min(-50, ...extents) / 50) * 50, hi = Math.ceil(Math.max(350, ...extents) / 50) * 50;
    charts = {
      speed: createChart($('[data-rs-speed]'), storeOf(run), { series: [{ key: `set${side}`, label: '目标', color: '--rl-c3' }, { key: `enc${side}`, label: '反馈', color: side === 'L' ? '--rl-c1' : '--rl-c4' }], fixed: { l: [lo, hi] } }),
      pwm: createChart($('[data-rs-pwm]'), storeOf(run), { series: [{ key: `pwm${side}`, label: 'PWM', color: '--rl-c5' }], fixed: { l: [-PWM_LIMIT, PWM_LIMIT] } }),
    };
    host.style.setProperty('--rs-feedback', side === 'L' ? 'var(--rl-c1)' : 'var(--rl-c4)');
    schedule();
  }
  function setRange(next) {
    const run = current(); if (!run) return;
    const [min, max] = scopeRange(run.capture, side), span = Math.min(max - min, Math.max(2, next[1] - next[0]));
    const start = Math.max(min, Math.min(max - span, next[0]));
    range = [start, start + span]; hover = null; schedule();
  }
  function schedule() { if (!frame && !disposed) frame = requestAnimationFrame(draw); }
  function draw() {
    frame = 0;
    const run = current(), other = compared(); if (!run || !charts || disposed) return;
    const result = responseOf(run), otherResult = other && responseOf(other);
    const offset = other ? (result.available ? result.startMs : run.capture.rows[0].t) - (otherResult.available ? otherResult.startMs : other.capture.rows[0].t) : 0;
    const ghost = other ? { store: storeOf(other), offset } : null;
    const sample = hover === null ? null : nearestSpeedSample(run.capture, hover);
    // createChart 的通用悬停会跳过缺值；这里不让它把邻近有效点画成当前点。
    const speedHover = sample && Number.isFinite(sample.row[`set${side}`]) && Number.isFinite(sample.row[`enc${side}`]) ? sample.row.t : null;
    const pwmHover = sample && Number.isFinite(sample.row[`pwm${side}`]) ? sample.row.t : null;
    charts.speed.draw({ t0: range[0], t1: range[1], ghost, hoverT: speedHover });
    charts.pwm.draw({ t0: range[0], t1: range[1], ghost, hoverT: pwmHover });
    $('[data-rs-from]').value = Math.round(range[0]); $('[data-rs-to]').value = Math.round(range[1]);
    const [min, max] = scopeRange(run.capture, side), movable = max - min - (range[1] - range[0]);
    $('[data-rs-pan]').disabled = movable <= 0;
    $('[data-rs-pan]').value = movable > 0 ? Math.round((range[0] - min) / movable * 1000) : 0;
    if (sample) {
      const { row, index } = sample;
      $('[data-rs-readout]').textContent = `${format(row.t, 0)} ms · 目标 ${format(row[`set${side}`])} · 反馈 ${format(row[`enc${side}`])} · PWM ${format(row[`pwm${side}`], 0)} · 第 ${Number.isFinite(row.index) ? row.index : index} 点`;
    } else $('[data-rs-readout]').textContent = `${format(range[0], 0)}～${format(range[1], 0)} ms · 移到曲线上逐点查看；方向键逐点移动，上下键缩放。`;
  }
  function choose(id) {
    selected = id; if (reference === selected) reference = '';
    const run = current();
    if (run) { side = Number(run.capture.header.side) === 2 ? 'R' : 'L'; range = scopeRange(run.capture, side); }
    hover = null; updateSides(); rebuild();
  }
  function updateSides() { host.querySelectorAll('[data-rs-side]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.rsSide === side))); }
  function addCapture(event, name = '') {
    const capture = normalizeSpeedCapture(event), id = captureFingerprint(capture), existing = runs.find(run => run.id === id);
    if (!existing) {
      const now = new Date(), label = name || `${now.toLocaleTimeString('zh-CN', { hour12: false })} · ${Number(capture.header.side) === 2 ? '右轮' : '左 / 双轮'} · ${capture.rows.length} 点`;
      runs.unshift({ id, name: label.slice(0, 180), savedAt: now.toISOString(), capture, store: null });
      runs = runs.slice(0, MAX_RUNS); persist();
    }
    choose(id);
    return id;
  }
  function save(blob, filename) {
    const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function exportPNG() {
    const run = current(); if (!run) return;
    draw();
    const speed = $('[data-rs-speed]'), pwm = $('[data-rs-pwm]'), canvas = document.createElement('canvas'), scale = Math.max(1, devicePixelRatio || 1);
    canvas.width = speed.width; canvas.height = speed.height + pwm.height + Math.round(180 * scale);
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#121418'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.scale(scale, scale); ctx.fillStyle = '#edf2fa'; ctx.font = '15px sans-serif';
    ctx.fillText(`${run.name} · ${side === 'L' ? '左轮' : '右轮'} · 计数 / 2 ms`, 14, 24, canvas.width / scale - 28);
    ctx.font = '11px sans-serif'; ctx.fillStyle = '#b5bdc9';
    ctx.fillText(metaText(run.capture), 14, 45, canvas.width / scale - 28);
    ctx.fillText(`${run.capture.complete ? '导出结构完整' : '完整性未确认'} · ${format(range[0], 0)}～${format(range[1], 0)} ms · 黄：目标 / 蓝紫：反馈 / 红：PWM / 虚线：对照`, 14, 65, canvas.width / scale - 28);
    const other = compared(); if (other) ctx.fillText(`对照 ${other.name} · ${metaText(other.capture)}`, 14, 84, canvas.width / scale - 28);
    const result = responseOf(run);
    ctx.fillText(result.available ? `上升 ${format(result.riseMs)} ms · 超调 ${format(result.overshootPct)}% · 平台均值 ${format(result.mean)} · 峰峰值 ${format(result.peakToPeak)}（${format(result.platformStartMs, 0)}～${format(result.endMs, 0)} ms）` : result.reason, 14, 105, canvas.width / scale - 28);
    ctx.drawImage(speed, 0, 125, speed.width / scale, speed.height / scale);
    ctx.drawImage(pwm, 0, 140 + speed.height / scale, pwm.width / scale, pwm.height / scale);
    canvas.toBlob(blob => { if (blob) save(blob, `speed-${run.id}-${side}.png`); }, 'image/png');
  }
  on($('[data-rs-run]'), 'change', event => choose(event.target.value));
  on($('[data-rs-reference]'), 'change', event => { reference = event.target.value; rebuild(); });
  on($('[data-rs-import]'), 'click', () => $('[data-rs-file]').click());
  on($('[data-rs-file]'), 'change', async event => {
    const file = event.target.files[0]; if (!file) return;
    try { if (file.size > 5 * 1024 * 1024) throw Error('请导入不超过 5 MB 的单趟 CSV'); const text = await file.text(); if (!disposed) addCapture(importSpeedCSV(text), file.name); }
    catch (error) { $('[data-rs-notice]').textContent = `导入失败：${error.message}`; }
    event.target.value = '';
  });
  on($('[data-rs-csv]'), 'click', () => { const run = current(); if (run) save(new Blob([speedCSV(run.capture)], { type: 'text/csv;charset=utf-8' }), `speed-${run.id}.csv`); });
  on($('[data-rs-png]'), 'click', exportPNG);
  host.querySelectorAll('[data-rs-side]').forEach(button => on(button, 'click', () => { side = button.dataset.rsSide; hover = null; updateSides(); rebuild(); }));
  host.querySelectorAll('[data-rs-window]').forEach(button => on(button, 'click', () => { if (current()) setRange(scopeRange(current().capture, side, button.dataset.rsWindow)); }));
  const zoom = factor => { const middle = hover ?? (range[0] + range[1]) / 2, half = (range[1] - range[0]) * factor / 2; setRange([middle - half, middle + half]); };
  host.querySelectorAll('[data-rs-zoom]').forEach(button => on(button, 'click', () => zoom(Number(button.dataset.rsZoom))));
  for (const selector of ['[data-rs-from]', '[data-rs-to]']) on($(selector), 'change', () => {
    const a = Number($('[data-rs-from]').value), b = Number($('[data-rs-to]').value);
    if (Number.isFinite(a) && Number.isFinite(b) && b > a) setRange([a, b]); else schedule();
  });
  on($('[data-rs-pan]'), 'input', event => { const [min, max] = scopeRange(current().capture, side), width = range[1] - range[0], left = min + (max - min - width) * Number(event.target.value) / 1000; setRange([left, left + width]); });
  on($('[data-rs-speed]'), 'pointermove', event => {
    if (!current()) return;
    const canvas = event.currentTarget, bounds = canvas.getBoundingClientRect(), fraction = Math.max(0, Math.min(1, (event.clientX - bounds.left - 44) / Math.max(1, bounds.width - 88)));
    const t = range[0] + fraction * (range[1] - range[0]);
    hover = nearestSpeedSample(current().capture, t).row.t; schedule();
  });
  on($('[data-rs-speed]'), 'pointerleave', () => { hover = null; schedule(); });
  on($('[data-rs-speed]'), 'keydown', event => {
    if (!current() || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { zoom(event.key === 'ArrowUp' ? 0.5 : 2); return; }
    if (event.key === 'Home') { setRange(scopeRange(current().capture, side)); return; }
    const rows = current().capture.rows, i = storeOf(current()).find(hover ?? range[0]);
    hover = rows[Math.max(0, Math.min(rows.length - 1, i + (event.key === 'ArrowRight' ? 1 : -1)))].t; schedule();
  });
  const resize = new ResizeObserver(schedule); resize.observe(host);
  if (runs.length) choose(runs[0].id); else announce();
  return { addCapture, destroy() { disposed = true; controller.abort(); resize.disconnect(); cancelAnimationFrame(frame); host.replaceChildren(); } };
}
