/* =====================================================================
   core.js —— 引擎核心（摘自《请不要攻略我》，供 Luokixi 开源广场试玩）
   ---------------------------------------------------------------------
   只留选项要用的部分，留下的代码与原版逐行一致：
   · 全局命名空间 LV（所有模块都挂在它下面）
   · 小工具函数（创建元素、等待、夹值……）、让 await gsap 不卡死
   · 事件总线 · 播放状态 · 舞台缩放
   · 输入系统：一个“处理器栈”，最上面的处理器优先收到点击/按键
   原版里的存档、设置、跨周目标记和剧情相关内容没有带过来。
   ===================================================================== */
(function () {
  'use strict';

  const LV = (window.LV = window.LV || {});

  /* ------------------------------------------------------------------
     DOM 小工具
     ------------------------------------------------------------------ */

  /** 查询一个元素 */
  LV.$ = (sel, root) => (root || document).querySelector(sel);

  /**
   * 创建元素。
   * @param {string} tag   标签名
   * @param {string} [cls] class
   * @param {string} [html] innerHTML
   */
  LV.el = function (tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  };

  /** 把字符串里的 HTML 特殊字符转义，防止剧本文字被当成标签 */
  LV.esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  LV.clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  LV.rand = (a, b) => a + Math.random() * (b - a);
  LV.pick = (arr) => arr[(Math.random() * arr.length) | 0];

  /** 普通等待（毫秒） */
  LV.sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** 等下一帧 */
  LV.frame = () => new Promise((r) => requestAnimationFrame(() => r()));

  /* ------------------------------------------------------------------
     让 `await gsap.to(...)` 永远不会卡死
     ------------------------------------------------------------------
     引擎里到处是 `await gsap.to(...)`，剧本命令也直接 return 一个 tween 让执行器等。
     GSAP 3.12 自带的 then() 有三个坑，任何一个踩中，剧情就停在原地不动：
       1) 时长为 0 的 tween（快进时所有动画都是 0 秒）创建时就已经播完，
          之后再 then() 永远不会 resolve —— 快进一开，第一句台词就卡住；
       2) tween 被 kill / 被新动画覆盖，then() 也永远不会 resolve；
       3) 同一个 tween 只记得最后一个 then() 的回调，前面的会被忘掉。
     这里把 then() 换成：播完、时长为 0、被打断，都会 resolve；可以被等任意多次。
     ------------------------------------------------------------------ */
  (function patchGsapThen() {
    const gsap = window.gsap;
    if (!gsap || !gsap.core || !gsap.core.Animation) return;
    const proto = gsap.core.Animation.prototype;

    /** 已经不会再动了：播完了，或者已经不在任何时间线上（被 kill / 0 秒 tween 播完就被移走） */
    const settled = (a) => !a.parent || (a.totalProgress() === 1 && a._ts >= 0);

    /** 给动画挂一个“结束时通知我”，支持多个等待者 */
    function addWaiter(a, fn) {
      if (!a._lvWaiters) {
        a._lvWaiters = [];
        const flush = () => {
          const list = a._lvWaiters;
          a._lvWaiters = null;
          a._prom = null;
          if (list) list.forEach((g) => g());
        };
        a._prom = flush;                           // GSAP 播完时会调 _prom
        const prev = a.eventCallback('onInterrupt');
        a.eventCallback('onInterrupt', function () { // 被 kill 时
          if (prev) prev.apply(this, arguments);
          flush();
        });
      }
      a._lvWaiters.push(fn);
    }

    proto.then = function (onFulfilled) {
      const self = this;
      return new Promise((resolve) => {
        const f = typeof onFulfilled === 'function' ? onFulfilled : (x) => x;
        const settle = () => {
          // 暂时拿掉 then：resolve(自己) 时不会被当成 thenable 又绕回来（GSAP 原版也这么做）
          const own = Object.prototype.hasOwnProperty.call(self, 'then');
          const saved = self.then;
          self.then = null;
          try {
            resolve(f(self));
          } finally {
            if (own) self.then = saved; else delete self.then;
          }
        };
        if (settled(self)) settle();
        else addWaiter(self, settle);
      });
    };
  })();

  /**
   * GSAP 入场动画的统一写法：LV.tweenIn(元素们, 从, 到)
   * ------------------------------------------------------------------
   * 很多按钮在 CSS 里写了 `transition: transform`（给 :hover / :active 用）。
   * GSAP 每一帧写一次 transform，浏览器又把这一帧“过渡”0.25 秒——
   * 结果动画像被拖着走：慢半拍、终点发飘。
   * 所以动画期间先把元素自己的 transition 关掉，播完清掉行内样式，CSS 原样接管。
   */
  LV.tweenIn = function (targets, from, to) {
    const gsap = window.gsap;
    const list = gsap.utils.toArray(targets);
    list.forEach((e) => { e.style.transition = 'none'; });
    const restore = () => list.forEach((e) => { e.style.transition = ''; });
    const userDone = to && to.onComplete;
    return gsap.fromTo(list, from, Object.assign({ clearProps: 'transform,opacity' }, to, {
      onComplete() { restore(); if (userDone) userDone.apply(this, arguments); },
      onInterrupt: restore,
    }));
  };

  /** 同上，给离场 / 一次性的 gsap.to 用：动画期间关掉 CSS transition（不清行内样式） */
  LV.tweenTo = function (targets, vars) {
    const gsap = window.gsap;
    const list = gsap.utils.toArray(targets);
    list.forEach((e) => { e.style.transition = 'none'; });
    return gsap.to(list, vars);
  };

  /* ------------------------------------------------------------------
     事件总线（模块之间松耦合地通知）
     ------------------------------------------------------------------ */
  const listeners = {};
  LV.bus = {
    on(name, fn) { (listeners[name] = listeners[name] || []).push(fn); },
    off(name, fn) { const a = listeners[name]; if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } },
    emit(name, data) { (listeners[name] || []).slice().forEach((fn) => fn(data)); },
  };

  /* ------------------------------------------------------------------
     播放状态：自动 / 快进
     ------------------------------------------------------------------ */
  LV.play = {
    auto: false,
    skip: false,        // 快进开关（按钮）
    skipHeld: false,    // 按住 Ctrl 快进
    noSkip: 0,          // >0 时禁止快进（回放、倒计时等段落）
    skipping() { return (this.skip || this.skipHeld) && this.noSkip === 0; },
    setAuto(on) { this.auto = on; if (on) this.skip = false; LV.bus.emit('mode'); },
    setSkip(on) { this.skip = on; if (on) this.auto = false; LV.bus.emit('mode'); },
  };

  /* ------------------------------------------------------------------
     舞台缩放：1920×1080 等比缩放到窗口里（黑边居中）
     ------------------------------------------------------------------ */
  LV.fitStage = function () {
    const stage = document.getElementById('stage');
    if (!stage) return;
    const s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
    stage.style.setProperty('--s', s.toFixed(5));
    LV.scale = s;
  };
  window.addEventListener('resize', LV.fitStage);

  /**
   * 舞台现在实际显示的缩放。
   * 用舞台的真实显示宽度来算，而不是 LV.scale —— 这样外面再套一层缩放（浏览器缩放、调试时的放大）也不会算错。
   */
  LV.stageScale = function () {
    return document.getElementById('stage').getBoundingClientRect().width / 1920 || LV.scale || 1;
  };

  /** 把浏览器坐标换算成舞台坐标（1920×1080 空间） */
  LV.toStage = function (clientX, clientY) {
    const r = document.getElementById('stage').getBoundingClientRect();
    const s = r.width / 1920 || LV.scale || 1;
    return { x: (clientX - r.left) / s, y: (clientY - r.top) / s };
  };

  /** 一个元素在舞台坐标里的位置和大小 {x, y, w, h} */
  LV.stageRect = function (el) {
    const r = el.getBoundingClientRect();
    const sr = document.getElementById('stage').getBoundingClientRect();
    const s = sr.width / 1920 || LV.scale || 1;
    return { x: (r.left - sr.left) / s, y: (r.top - sr.top) / s, w: r.width / s, h: r.height / s };
  };

  /* ------------------------------------------------------------------
     输入系统
     ------------------------------------------------------------------
     处理器（handler）是一个普通对象，可以实现这些方法：
       advance()   左键 / 空格 / 回车 / 滚轮向下
       rclick()    右键
       wheelUp()   滚轮向上 / ↑
       menu()      Esc
       key(e)      其他按键
     modal: true 表示“到我为止”，下面的处理器收不到任何输入（菜单用）。
     ------------------------------------------------------------------ */
  const stack = [];
  LV.input = {
    push(h) { stack.push(h); return h; },
    remove(h) { const i = stack.indexOf(h); if (i >= 0) stack.splice(i, 1); },
    top() { return stack[stack.length - 1]; },
    /** 读档 / 回标题时：清掉所有临时处理器（保留 persistent 的，比如全局快捷键） */
    clearTransient() {
      for (let i = stack.length - 1; i >= 0; i--) if (!stack[i].persistent || stack[i].modal) stack.splice(i, 1);
    },
    /** 把一个动作派发给处理器栈；返回是否被处理 */
    dispatch(action, ev) {
      for (let i = stack.length - 1; i >= 0; i--) {
        const h = stack[i];
        if (typeof h[action] === 'function') {
          if (h[action](ev) !== false) return true;
        }
        if (h.modal) return false;
      }
      return false;
    },
  };

  /** 这些元素自己处理点击，不当作“推进剧情” */
  const UI_SELECTOR = 'button, input, .choice, .slot, .slider, .toggle, .lg-word, .frow, .interactive-ui, select, a';
  LV.UI_SELECTOR = UI_SELECTOR;   // mobile.js 的长按 / 双指也要避开这些元素

  LV.initInput = function () {
    const stage = document.getElementById('stage');

    stage.addEventListener('click', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest(UI_SELECTOR)) return;
      LV.audio && LV.audio.unlock();
      LV.input.dispatch('advance', e);
    });

    stage.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      LV.input.dispatch('rclick', e);
    });

    // 滚轮：向上翻记录，向下推进。加一点节流，避免触控板一下滚出十几次。
    let wheelLock = 0;
    stage.addEventListener('wheel', (e) => {
      const now = performance.now();
      if (now < wheelLock) return;
      wheelLock = now + 220;
      if (e.deltaY < 0) LV.input.dispatch('wheelUp', e);
      else if (e.deltaY > 0) LV.input.dispatch('wheelDown', e);
    }, { passive: true });

    window.addEventListener('keydown', (e) => {
      if (e.target && e.target.tagName === 'INPUT') return;   // 输入框里打字时不抢按键
      LV.audio && LV.audio.unlock();
      switch (e.key) {
        case ' ':
        case 'Enter':
          e.preventDefault();
          if (!e.repeat) LV.input.dispatch('advance', e);
          break;
        case 'ArrowDown':
        case 'PageDown':
          LV.input.dispatch('wheelDown', e);
          break;
        case 'ArrowUp':
        case 'PageUp':
          LV.input.dispatch('wheelUp', e);
          break;
        case 'Escape':
          LV.input.dispatch('menu', e);
          break;
        case 'Control':
          if (!LV.play.skipHeld) { LV.play.skipHeld = true; LV.bus.emit('mode'); LV.bus.emit('skipkick'); }
          break;
        default:
          LV.input.dispatch('key', e);
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.key === 'Control') { LV.play.skipHeld = false; LV.bus.emit('mode'); }
    });
    window.addEventListener('blur', () => { if (LV.play.skipHeld) { LV.play.skipHeld = false; LV.bus.emit('mode'); } });
  };
})();
