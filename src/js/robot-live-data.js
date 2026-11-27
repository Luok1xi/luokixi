// “看实车”驾驶舱的数据层：把解析器的事件（robot-live-model.js）按统一列名存进环形缓冲，给曲线、仪表、诊断、导出用。
// 列名和遥测 v2、仿真 rows.csv 一致（setL、encL、gyro_dps…）；车没发的列就没有，不补 0、不估。
// 单位：轮速 = 编码器计数 / 2 ms（和固件、仿真一样），角速度 °/s，航向 °，时间 = 车上运行时间 ms（重启后接着往后排，记成新的一段）。

export const MMPC_DEFAULT = 0.01948;        // mm / 编码器计数：Owner 10-26 断电重开推 1.00 m 三次的平均（TeamHub 参数 #33）
export const PWM_LIMIT = 8500;              // 速度环输出上限 motorL_pid.MaxValue（生产固件 pid.c:37）
export const VBAT_LOW = 10500, VBAT_FULL = 12600, VBAT_USB = 3000;   // 3S：低于 10.5 V 该充电；低于 3 V = 只靠 USB 供电

// ---------- 环形缓冲：一条共用时间轴，每列一个 Float32Array（没数据的位置是 NaN） ----------
export function createStore(cap = 120000) {
  const cols = new Map(), T = new Float64Array(cap), SEG = new Uint16Array(cap);
  let head = 0, n = 0, seg = 0, lastRaw = -Infinity, lastT = -Infinity, offset = 0, version = 0;
  const slot = i => (head - n + i + cap) % cap;
  const column = name => {
    let c = cols.get(name);
    if (!c) { c = new Float32Array(cap).fill(NaN); cols.set(name, c); }
    return c;
  };
  const store = {
    cap,
    get size() { return n; }, get version() { return version; }, get segments() { return seg + 1; },
    push(rawT, fields) {
      if (!Number.isFinite(rawT)) return;
      if (rawT < lastRaw - 200) { seg++; offset = lastT + 100 - rawT; }   // 设备时间倒退 = 车重启了
      lastRaw = rawT;
      const t = Math.max(rawT + offset, lastT);                         // 不同来源的行可能差几 ms：不让时间往回走
      lastT = t;
      for (const c of cols.values()) c[head] = NaN;
      T[head] = t; SEG[head] = seg;
      for (const [k, v] of Object.entries(fields)) if (typeof v === 'number' && Number.isFinite(v)) column(k)[head] = v;
      head = (head + 1) % cap; n = Math.min(n + 1, cap); version++;
    },
    clear() { cols.clear(); head = n = seg = offset = 0; lastRaw = lastT = -Infinity; version++; },
    has: name => cols.has(name),
    names: () => [...cols.keys()],
    t: i => T[slot(i)],
    seg: i => SEG[slot(i)],
    v: (name, i) => { const c = cols.get(name); return c ? c[slot(i)] : NaN; },
    range: () => n ? [T[slot(0)], T[slot(n - 1)]] : [0, 0],
    // 第一个时间 ≥ t 的下标
    find(t) { let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; if (T[slot(m)] < t) lo = m + 1; else hi = m; } return lo; },
    // 最近一个有值的点（往回最多找 limit 个）
    last(name, limit = 5000) {
      const c = cols.get(name);
      if (!c) return null;
      for (let i = n - 1; i >= Math.max(0, n - limit); i--) { const v = c[slot(i)]; if (!Number.isNaN(v)) return { t: T[slot(i)], v, i }; }
      return null;
    },
    // 时间窗 [t0, t1] 里某列的有效点
    values(name, t0, t1) {
      const c = cols.get(name), out = { t: [], v: [] };
      if (!c) return out;
      for (let i = store.find(t0); i < n; i++) { const s = slot(i); if (T[s] > t1) break; if (!Number.isNaN(c[s])) { out.t.push(T[s]); out.v.push(c[s]); } }
      return out;
    },
  };
  return store;
}

// ---------- 事件 → 统一列 ----------
// ctx：每个连接 / 文件一个，记上一行状态（由累计计数算轮速）、上一条遥测（由 seq 算处理帧率）、估算调参包的时间
export function createIngest(store) {
  const ctx = { source: null, rate: 0, arrivals: [], prevStatus: null, prevTlm: null, lastCarT: null, lastHost: 0, packets: 0 };
  // 每秒几条：按车上的时间算（一下子打开一份文件、或者浏览器卡了一下再一次收到一堆，都不会算成几万条/秒）
  const mark = (source, t) => {
    ctx.source = source;
    ctx.arrivals.push(t); while (ctx.arrivals.length > 1 && t - ctx.arrivals[0] > 3000) ctx.arrivals.shift();
    ctx.rate = ctx.arrivals.length > 2 ? (ctx.arrivals.length - 1) * 1000 / Math.max(1, t - ctx.arrivals[0]) : 0;
  };
  // 由累计计数和设备时间算出平均轮速（计数 / 2 ms）；车发的 vL / vR 没有实际间隔，不能直接当速度（Codex #20）
  const fromTotals = (prev, s, f) => {
    if (!prev || !(s.t > prev.t) || s.t - prev.t > 2000) return;
    const k = 2 / (s.t - prev.t);
    if (Number.isFinite(s.encL) && Number.isFinite(prev.encL)) f.spdL = (s.encL - prev.encL) * k;
    if (Number.isFinite(s.encR) && Number.isFinite(prev.encR)) f.spdR = (s.encR - prev.encR) * k;
    if (Number.isFinite(f.spdL) && Number.isFinite(f.spdR)) f.spd = (f.spdL + f.spdR) / 2;
  };
  return {
    ctx,
    // host：收到的时刻（performance.now()）；打开文件时传 null，调参包按 100 ms 一个排
    push(ev, host = null) {
      const h = host ?? 0;
      if (ev.type === 'tune-capture') {
        for (const r of ev.rows) store.push(r.t, { ...r, spd: (r.encL + r.encR) / 2, spd_set: (r.setL + r.setR) / 2 });
        ctx.source = `正式程序记录 · ${ev.header.stride * ev.header.dt_ms} ms/点${ev.complete ? '' : ' · 不完整'}`;
        ctx.rate = 1000 / (ev.header.stride * ev.header.dt_ms);
        return true;
      }
      if (ev.type === 'tlm') {
        const r = ev.row, f = { ...r, spd: (r.encL + r.encR) / 2, spd_set: (r.setL + r.setR) / 2, route_m: r.route_m >= 0 ? r.route_m : NaN };
        if (r.flags !== undefined && !(r.flags & 16)) delete f.vbat_mv;                    // vbat_valid 没置位：还没有有效电压
        if (r.flags !== undefined && !(r.flags & 4)) { delete f.route_k; delete f.route_cur; delete f.route_m; }   // 车上没有路线层
        const p = ctx.prevTlm;
        if (p && r.t > p.t && r.seq >= p.seq) f.fps = (r.seq - p.seq) * 1000 / (r.t - p.t);
        ctx.prevTlm = r; ctx.lastCarT = r.t; ctx.lastHost = h;
        store.push(r.t, f); mark(`遥测 v${ev.ver}`, r.t);
        return true;
      }
      if (ev.type === 'status') {
        const s = ev.fields, production = s.tune === 1, hw = !production && ('yaw_cdeg' in s || 'gz_mdps' in s || 'vL' in s);
        const f = { vbat_mv: s.vbat_mv, enc_total_L: s.encL, enc_total_R: s.encR };
        // 标零偏的头 2 秒（cal=1）角速度还没扣零偏，不当真
        if (production) Object.assign(f, { imu_ok: s.imu, gyro_cal: s.cal, gyro_dps: s.imu && !s.cal ? s.gz_mdps / 1000 : NaN,
          launch_flag: s.running, stop_reason: s.stop, tune_active: s.active, tune_side: s.side });
        else if (hw) Object.assign(f, s.imu ? { imu_sum: s.yaw_cdeg / 100, gyro_dps: s.cal ? NaN : s.gz_mdps / 1000, gyro_bias_dps: s.bias_mdps / 1000, acc_z_g: s.az_mg / 1000 } : {},
          { imu_ok: s.imu, gyro_cal: s.cal });
        else Object.assign(f, { image_error: s.px, proc_us: s.proc_us, fps: s.fps, valid_fps: s.valid, gray: s.gray, cam: s.cam, Lp: s.Lp, Rp: s.Rp });
        const prev = ctx.prevStatus?.hw === hw && ctx.prevStatus?.production === production ? ctx.prevStatus : null;
        fromTotals(prev, s, f);
        // hwtest v3（10-27，hwtest-speed/cpu0_main.c）跑速度环时的行：目标、实测都是计数 / 2 ms，和遥测同单位
        if ('actL' in s) Object.assign(f, { setL: s.setL, setR: s.setR, encL: s.actL, encR: s.actR, pwmL: s.pwmL, pwmR: s.pwmR,
          spd: (s.actL + s.actR) / 2, spd_set: (s.setL + s.setR) / 2 });
        if (!production && 'stop' in s) Object.assign(f, { hw_mode: s.mode, hw_stop: s.stop, hw_wire: s.wire });
        ctx.prevStatus = { ...s, hw, production }; ctx.lastCarT = s.t; ctx.lastHost = h;
        store.push(s.t, f); mark(production ? '正式程序速度环' : hw ? 'hwtest 状态行' : '状态行', s.t);
        return true;
      }
      if (ev.type === 'packet') {
        // 旧调参包没有时间戳：实时连着就按到达时刻接在最近一行的设备时间后面，打开文件就按 100 ms 一个排
        ctx.packets++;
        const t = ctx.lastCarT === null ? ctx.packets * 100 : host === null ? (ctx.lastCarT += 100) : ctx.lastCarT + (h - ctx.lastHost);
        store.push(t, { stop_reason: ev.stop, set_speed: ev.speed, image_error: ev.error });
        if (!ctx.source || ctx.source === '调参包') mark('调参包', t);
        return true;
      }
      return false;
    },
  };
}

// ---------- 诊断（只用时间窗里真有的点） ----------
export function stats(store, name, t0, t1) {
  if (!store.has(name)) return null;
  let n = 0, sum = 0, sq = 0, min = Infinity, max = -Infinity, last;
  for (let i = store.find(t0); i < store.size && store.t(i) <= t1; i++) {
    const x = store.v(name, i); if (Number.isNaN(x)) continue;
    n++; sum += x; sq += x * x; if (x < min) min = x; if (x > max) max = x; last = x;
  }
  return n ? { n, mean: sum / n, rms: Math.sqrt(sq / n), min, max, last } : null;
}

// 目标和实测两列：同一时刻都有值的点；“全部”时间窗下点很多，等间隔抽到约 4000 个（互相关的工作量跟着点数平方涨）
function pairs(store, a, b, t0, t1) {
  const out = { t: [], a: [], b: [] };
  if (!store.has(a) || !store.has(b)) return out;
  const first = store.find(t0), stride = Math.max(1, Math.floor((store.find(t1) - first) / 4000));
  for (let i = first; i < store.size; i += stride) {
    const t = store.t(i); if (t > t1) break;
    const x = store.v(a, i), y = store.v(b, i);
    if (!Number.isNaN(x) && !Number.isNaN(y)) { out.t.push(t); out.a.push(x); out.b.push(y); }
  }
  return out;
}

// 跟踪：误差均方根、实测 / 目标、滞后（互相关找最好的错位，最多 200 ms）
export function tracking(store, target, measured, t0, t1) {
  const p = pairs(store, target, measured, t0, t1), n = p.t.length;
  if (n < 8) return null;
  let e2 = 0, ta = 0, ma = 0;
  for (let i = 0; i < n; i++) { const e = p.b[i] - p.a[i]; e2 += e * e; ta += Math.abs(p.a[i]); ma += Math.abs(p.b[i]); }
  const dt = (p.t[n - 1] - p.t[0]) / (n - 1), maxK = Math.min(Math.floor(200 / Math.max(dt, 1e-3)), Math.floor(n / 3));
  const mean = arr => arr.reduce((s, x) => s + x, 0) / arr.length, ma0 = mean(p.a), mb0 = mean(p.b);
  let best = 0, bestK = 0;
  for (let k = 0; k <= maxK; k++) {
    let sab = 0, saa = 0, sbb = 0;
    for (let i = 0; i + k < n; i++) { const x = p.a[i] - ma0, y = p.b[i + k] - mb0; sab += x * y; saa += x * x; sbb += y * y; }
    const r = saa && sbb ? sab / Math.sqrt(saa * sbb) : 0;
    if (r > best) { best = r; bestK = k; }
  }
  return { n, rmsErr: Math.sqrt(e2 / n), ratio: ta ? ma / ta : NaN, lagMs: best > 0.5 && maxK > 0 ? bestK * dt : NaN, corr: best };
}

// |值| ≥ 97% 上限 的时间占比
export function saturation(store, name, limit, t0, t1) {
  const { v } = store.values(name, t0, t1);
  return v.length ? v.filter(x => Math.abs(x) >= limit * 0.97).length / v.length : NaN;
}

// 振荡：去均值后过零次数换成频率；幅度小于 floor 不算
export function oscillation(store, name, t0, t1, floor) {
  const { t, v } = store.values(name, t0, t1);
  if (v.length < 16) return null;
  const m = v.reduce((s, x) => s + x, 0) / v.length, amp = Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / v.length);
  if (amp < floor) return { hz: 0, amp };
  let crossings = 0, sign = 0;
  for (const x of v) { const s = x - m > amp * 0.3 ? 1 : x - m < -amp * 0.3 ? -1 : 0; if (s && sign && s !== sign) crossings++; if (s) sign = s; }
  const span = (t.at(-1) - t[0]) / 1000;
  return { hz: span > 0 ? crossings / 2 / span : 0, amp };
}

export const fraction = (store, name, t0, t1, test) => { const { v } = store.values(name, t0, t1); return v.length ? v.filter(test).length / v.length : NaN; };

// ---------- 维修区提示：按规则出一句话，只用真有的数据 ----------
// level：bad（先处理）/ warn（留意）/ info
export function pitHints(store, t0, t1, { mmpc = MMPC_DEFAULT, stopReasons = {} } = {}) {
  const out = [], add = (level, text) => out.push({ level, text }), pct = x => `${Math.round(x * 100)}%`;
  const running = store.has('launch_flag') ? (store.values('launch_flag', t0, t1).v.some(x => x > 0)) : null;
  const vb = stats(store, 'vbat_mv', t0, t1);
  if (vb) {
    if (vb.last < VBAT_USB) add('info', '没接电池（或 S1 没开）：板子只靠 USB 供电，驱动板和电机没电');
    else if (vb.last < VBAT_LOW) add('bad', `电池 ${(vb.last / 1000).toFixed(2)} V，低于 10.5 V：先充电再跑`);
    if (vb.min >= VBAT_USB && vb.max - vb.min > 1000) add('warn', `这段时间电压掉了 ${((vb.max - vb.min) / 1000).toFixed(2)} V：电池老化或接头松，跑起来容易复位`);
  }
  const sr = store.last('stop_reason');
  if (sr && sr.v > 0 && sr.t >= t0) add('bad', `车自己停了：${stopReasons[sr.v] ?? `停车原因 ${sr.v}`}。${({ 1: '查陀螺方向和零偏、角速度环增益、轮子打滑', 2: '查电池电压、轮子堵转、编码器线和方向', 3: '查曝光、补光、摄像头排线', 4: '查直角行和转弯速度' })[sr.v] ?? ''}`);
  if (store.has('imu_ok') && store.last('imu_ok')?.v === 0) add('bad', 'IMU 没连上：断电查姿态传感器 P3 有没有插到底、插反');
  // hwtest v3 的速度环测试：为什么停、认出的电机接线（固件 STOP_* 和 wire 的编码见 hwtest-speed/cpu0_main.c）
  const hs = store.last('hw_stop'), hw = store.last('hw_wire');
  const HW_STOP = { 3: '左电机方向反了：接线认出来以后左轮还是往反方向转', 4: '右电机方向反了', 5: '左轮给了很大 PWM 却不转：轮子卡住、电机线没接，或者左编码器没在数',
    6: '右轮给了很大 PWM 却不转', 7: '左轮 2 秒都追不上目标（生产固件同样的保护）', 8: '右轮 2 秒都追不上目标', 9: '探接线时两套接法都没让轮子转起来：驱动板开关 S1 开了吗、电机线和 P4 转接线插好了吗',
    10: '电池低于 9.5 V，速度环测试不让开始：接上电池、打开 S1',
    11: '地上直线走过 1.3 m 自动停了：正常一趟约 1 m，多走了是速度跟过头或编码器数多了', 12: '地上直线航向偏过 30° 自动停了：轮子打滑或航向保持方向不对，先发 #Y 0 关掉航向保持再跑一趟',
    13: '陀螺没连上或还在标零偏（开机、按 S4 后要静止 2 s），地上直线不让开始' };
  if (hs && hs.v > 2 && hs.t >= t0) add('bad', `速度环测试停了：${HW_STOP[hs.v] ?? `原因 ${hs.v}`}`);
  if (hw && hw.v > 0) add('info', `电机接线：${hw.v % 10 === 1 ? '生产固件 control.h 那套（左 PWM 11.11、右方向 11.10）' : '逐飞 E3 例程那套（左 PWM 11.10、右方向 11.11）'}${hw.v >= 10 ? '，左右电机对调了' : ''}`);
  if (store.has('cam') && store.last('cam')?.v === 0) add('bad', '摄像头没起来：断电查 J1 排线');
  // 编码器：一边动、一边不动 = 没在计数；两边都动但差得多 = 推歪了或一边打滑
  const dl = stats(store, 'enc_total_L', t0, t1), dr = stats(store, 'enc_total_R', t0, t1);
  if (dl && dr) {
    const a = Math.abs(dl.last - (store.values('enc_total_L', t0, t1).v[0])), b = Math.abs(dr.last - (store.values('enc_total_R', t0, t1).v[0]));
    if (Math.max(a, b) > 2000 && Math.min(a, b) < 100) add('bad', `${a < b ? '左' : '右'}编码器没在计数（另一边走了 ${Math.max(a, b)} 个计数）：断电查车尾 ${a < b ? 'P5' : 'P6'} 插头和编码器齿轮`);
    else if (Math.min(a, b) > 2000 && Math.abs(a - b) / Math.max(a, b) > 0.05) add('warn', `左右编码器差 ${pct(Math.abs(a - b) / Math.max(a, b))}（左 ${a}、右 ${b}）：推车没推直、一边打滑，或者轮径不同`);
  }
  for (const side of ['L', 'R']) {
    const s = saturation(store, `pwm${side}`, PWM_LIMIT, t0, t1);
    if (s > 0.15) add('warn', `${side === 'L' ? '左' : '右'}轮 PWM 打满 ${pct(s)} 的时间：速度跟不上目标，先看电池电压和速度环增益`);
    const tr = tracking(store, `set${side}`, `enc${side}`, t0, t1);
    if (tr && running !== false && tr.ratio < 0.75 && stats(store, `set${side}`, t0, t1)?.max > 20) add('warn', `${side === 'L' ? '左' : '右'}轮实际速度只有目标的 ${pct(tr.ratio)}：负载太大、PWM 不够或编码器漏计`);
  }
  const yaw = tracking(store, 'yaw_target_dps', 'gyro_dps', t0, t1);
  if (yaw && yaw.lagMs > 30) add('warn', `角速度环滞后约 ${Math.round(yaw.lagMs)} ms：陀螺跟不上目标，内环增益偏小或打滑`);
  const osc = oscillation(store, 'gyro_dps', t0, t1, 30);
  if (osc && osc.hz > 4 && store.has('yaw_target_dps')) add('warn', `角速度在 ${osc.hz.toFixed(1)} Hz 来回摆（幅度约 ${Math.round(osc.amp)} °/s）：角速度环增益偏大`);
  const lost = fraction(store, 'line_valid', t0, t1, x => x === 0);
  if (lost > 0.05) add('warn', `${pct(lost)} 的帧没找到线：看曝光、补光和赛道反光`);
  const age = stats(store, 'vis_age_ms', t0, t1);
  if (age && age.max > 100 && age.max < 65534) add('bad', `有 ${Math.round(age.max)} ms 没有新的有效线：超过 100 ms 固件会停车（停车原因 3）`);
  const fps = stats(store, 'fps', t0, t1);
  if (fps && fps.n > 10 && fps.min < fps.mean * 0.7) add('warn', `处理帧率最低 ${Math.round(fps.min)}、平均 ${Math.round(fps.mean)} 帧/秒：中间有掉帧`);
  // 静止时陀螺：车没动（累计计数不变）而角速度平均不为 0 = 零偏没标好
  const g = stats(store, 'gyro_dps', t0, t1);
  if (g && g.n > 20 && dl && dr && Math.abs(dl.max - dl.min) < 20 && Math.abs(dr.max - dr.min) < 20 && Math.abs(g.mean) > 0.3)
    add('warn', `车没动，陀螺却平均读 ${g.mean.toFixed(2)} °/s：零偏没标好，放稳后重新校零（hwtest 按 S4）`);
  const sp = stats(store, 'spd', t0, t1);
  if (sp && !out.length) add('info', `正常。最高 ${(Math.max(Math.abs(sp.max), Math.abs(sp.min)) * mmpc / 2).toFixed(2)} m/s`);
  return out;
}

// ---------- 导出：telemetry.csv（列名同仿真 rows.csv）和 meta.json（run-meta/1，和 cartool 一样） ----------
export function toCSV(store) {
  const names = store.names(), lines = [['t', ...names].join(',')];
  for (let i = 0; i < store.size; i++) lines.push([store.t(i), ...names.map(k => { const v = store.v(k, i); return Number.isNaN(v) ? '' : +v.toPrecision(7); })].join(','));
  return lines.join('\n') + '\n';
}
export function runMeta({ identity, source, rate, records, bad, mmpc, stopReason, note = '' }) {
  const now = new Date(), pad = x => String(x).padStart(2, '0');
  return {
    schema: 'run-meta/1',
    run_id: `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}-web`,
    data_source: '实车', created: now.toISOString(), operator: '',
    car: { firmware_label: identity?.fw ?? '', hex_sha256: '', git_commit: '', build: '', id_line: identity?.line ?? '' },
    telemetry: { file: 'telemetry.csv', format: source ?? '', rate_hz: Math.round(rate || 0), records, crc_errors: bad, dropped: null },
    calib: { mmpc, mmpc_source: mmpc === MMPC_DEFAULT ? 'Owner 10-26 推 1.00 m 三次平均' : '网页上手动改的' },
    result: { finished: null, stop_reason: stopReason ?? null, time_s: null, parts_passed: null, notes: note },
    tools: { recorder: 'luokixi 看实车' },
  };
}

// cartool 的 telemetry.csv、仿真 rows.csv：第一行列名，t 是 ms
export function parseCSV(text) {
  const rows = text.trim().split(/\r?\n/), head = rows.shift()?.split(',').map(s => s.trim()) ?? [];
  if (!head.includes('t')) throw Error('CSV 第一行要有列名，并且有 t（毫秒）这一列');
  return rows.map(r => Object.fromEntries(r.split(',').map((x, i) => [head[i], x === '' ? NaN : Number(x)])));
}
