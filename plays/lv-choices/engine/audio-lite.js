/* =====================================================================
   audio-lite.js —— 声音（摘自《请不要攻略我》audio.js，只留选项要用的音效）
   ---------------------------------------------------------------------
   用 Web Audio 现场合成，不带任何音频文件。合成积木（tone / noise / musicbox）
   和下面六个音效的写法与原版一致；原版现在的界面音效（tick / click / select）
   换成了录音文件，这里用原版留着的合成版本。
   ===================================================================== */
(function () {
  'use strict';
  const LV = window.LV;

  let ctx = null;
  let seBus, reverbIn, noiseBuf;

  function init() {
    if (ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    // iPhone 静音键会把 Web Audio 一起静掉；按“媒体播放”处理就不会（iOS 16.4+）
    try { if (navigator.audioSession && navigator.audioSession.type !== 'playback') navigator.audioSession.type = 'playback'; } catch (e) { /* ignore */ }
    ctx = new AC();

    const master = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 3;
    master.connect(comp).connect(ctx.destination);

    seBus = ctx.createGain();
    seBus.gain.value = 0.75;        // 原版设置里音效音量的默认值
    seBus.connect(master);

    // 混响：用一段指数衰减的噪声当作脉冲响应
    const conv = ctx.createConvolver();
    conv.buffer = makeImpulse(2.6, 2.4);
    reverbIn = ctx.createGain();
    reverbIn.gain.value = 0.9;
    const wet = ctx.createGain();
    wet.gain.value = 0.32;
    reverbIn.connect(conv).connect(wet).connect(master);

    // 两秒白噪声，所有噪声类音效共用
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }

  function makeImpulse(sec, decay) {
    const len = Math.floor(ctx.sampleRate * sec);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const ch = buf.getChannelData(c);
      for (let i = 0; i < len; i++) ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  /** 一个振荡器音：可以滑音、可以接滤波器 */
  function tone(o) {
    const t = o.t != null ? o.t : ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(o.f, t);
    if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t + (o.glide || o.dur));
    if (o.detune) osc.detune.value = o.detune;
    const g = ctx.createGain();
    const a = o.a || 0.004;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(o.g || 0.3, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
    let node = osc.connect(g);
    if (o.lp) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = o.lp;
      node = g.connect(f);
    }
    node.connect(o.dest || seBus);
    if (o.rev) node.connect(reverbIn);
    osc.start(t);
    osc.stop(t + o.dur + 0.05);
  }

  /** 一段滤波噪声 */
  function noise(o) {
    const t = o.t != null ? o.t : ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = o.ft || 'bandpass';
    f.frequency.setValueAtTime(o.f || 1000, t);
    if (o.to) f.frequency.exponentialRampToValueAtTime(o.to, t + o.dur);
    f.Q.value = o.q || 1;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(o.g || 0.3, t + (o.a || 0.004));
    g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
    src.connect(f).connect(g).connect(o.dest || seBus);
    if (o.rev) g.connect(reverbIn);
    src.start(t, Math.random() * 1.5);
    src.stop(t + o.dur + 0.05);
  }

  /** 八音盒 / 钢片琴：正弦波 + 几个泛音，快起慢落 */
  function musicbox(t, f, vel, dest, soft) {
    const dec = Math.max(0.7, 2.1 - f / 900) * (soft ? 1.35 : 1);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vel, t + (soft ? 0.012 : 0.004));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dec);
    const parts = soft ? [[1, 1], [2, 0.18], [3, 0.05]] : [[1, 1], [2.0, 0.3], [3.01, 0.09], [4.17, 0.035]];
    parts.forEach(([p, amp]) => {
      const o = ctx.createOscillator();
      o.type = soft ? 'triangle' : 'sine';
      if (soft && p > 1) o.type = 'sine';
      o.frequency.value = f * p;
      const og = ctx.createGain();
      og.gain.value = amp;
      o.connect(og).connect(g);
      o.start(t);
      o.stop(t + dec + 0.05);
    });
    g.connect(dest);
    g.connect(reverbIn);
  }

  /* ------------------------------------------------------------------
     音效表（只留选项用到的六个）
     ------------------------------------------------------------------ */
  const SE = {
    click() {           // 很轻的“嗒”
      noise({ f: 3600, q: 1.4, dur: 0.028, g: 0.55 });
      tone({ f: 1800, dur: 0.02, g: 0.05 });
    },
    tick() { tone({ f: 2300, dur: 0.035, g: 0.035 }); },
    select() {
      const t = ctx.currentTime;
      musicbox(t, 1318.5, 0.12, seBus);
      musicbox(t + 0.06, 1975.5, 0.09, seBus);
    },
    chimeDown() {
      const t = ctx.currentTime;
      musicbox(t, 987.8, 0.14, seBus);
      musicbox(t + 0.11, 659.3, 0.14, seBus);
    },
    pen() {             // 圆珠笔写字的沙沙声
      const t = ctx.currentTime;
      for (let i = 0; i < 6; i++) noise({ t: t + i * 0.08, f: 5200, q: 4, dur: 0.06, g: 0.05 });
    },
    beat() { tone({ f: 70, to: 45, dur: 0.18, g: 0.5 }); },
  };

  // 任何一次点击都试着解锁（浏览器要求用户先点一下才能出声）
  ['pointerup', 'touchend', 'click', 'keydown'].forEach((t) => window.addEventListener(t, () => { if (LV.audio && LV.audio.unlock) LV.audio.unlock(); }, { capture: true, passive: true }));

  LV.audio = {
    /** 第一次点击时调用：创建并恢复 AudioContext */
    unlock() {
      init();
      if (ctx && (ctx.state === 'suspended' || ctx.state === 'interrupted')) ctx.resume().catch(() => {});
    },
    /** 播放音效；还没解锁时不出声 */
    se(id) {
      if (LV.play.skipping() || !ctx || ctx.state !== 'running' || !SE[id]) return;
      SE[id]();
    },
  };
})();
