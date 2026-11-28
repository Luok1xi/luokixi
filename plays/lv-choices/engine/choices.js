/* =====================================================================
   choices.js —— 选项
   ---------------------------------------------------------------------
   普通选项之外，还有几种特殊的选项：
     timed  限时：进度条走完就算了
     dead   A/B/C 都是“……”，选了也没有反应
     hang   选项停在屏幕上，几秒后剧情自己往下走
     D      第四个选项像圆珠笔写上去的，玩家按不了，一只手伸进来替你按
     hero   金边的英雄选项；按下去什么都不会发生，最后一个个消失
   （摘自《请不要攻略我》；代码与原版一致，只把注释里的剧情说明换成了中性的说法）
   ===================================================================== */
(function () {
  'use strict';
  const LV = window.LV;
  const gsap = window.gsap;
  const KEYS = ['A', 'B', 'C', 'D', 'E'];

  let box, choiceEpoch = 0, currentChoice = null;

  // Each presentation owns only its timers, input and nodes; abort settles its caller.
  function beginChoice() {
    if (currentChoice) currentChoice.close(-1);
    const epoch = ++choiceEpoch;
    const timers = new Map(), nodes = new Set();
    const job = {
      live: true, handler: null, timerTween: null, resolve: null, nodes,
      valid() { return job.live && currentChoice === job && epoch === choiceEpoch; },
      later(fn, ms) { const id = setTimeout(() => { timers.delete(id); if (job.valid()) fn(); }, ms); timers.set(id, null); return id; },
      wait(ms) { return new Promise(resolve => { const id = setTimeout(() => { timers.delete(id); resolve(); }, ms); timers.set(id, resolve); }); },
      clearDelays() { timers.forEach((resolve, id) => { clearTimeout(id); if (resolve) resolve(); }); timers.clear(); },
      close(value) {
        if (!job.live) return;
        job.live = false; job.clearDelays();
        if (job.handler) LV.input.remove(job.handler);
        if (job.timerTween) job.timerTween.kill();
        nodes.forEach(node => { gsap.killTweensOf([node, ...node.querySelectorAll('*')]); node.remove(); });
        if (currentChoice === job) { currentChoice = null; LV.choice.active = false; }
        const resolve = job.resolve; job.resolve = null; if (resolve) resolve(value);
      },
    };
    currentChoice = job;
    return job;
  }
  LV.bus.on('abort', () => { choiceEpoch++; if (currentChoice) currentChoice.close(-1); });

  function makeButton(text, i, cls) {
    const b = LV.el('button', 'choice ' + (cls || ''), `<span class="key">${KEYS[i]}</span><span class="txt">${LV.esc(text)}</span>`);
    b.addEventListener('mouseenter', () => LV.audio.se('tick'));
    return b;
  }

  /** 选项依次滑入 */
  function enter(btns) {
    if (!btns.length) return;
    if (LV.play.skipping() || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { gsap.set(btns, { clearProps: 'transform,opacity' }); return; }
    // tweenIn：动画期间关掉按钮自己的 CSS transition，结束后清掉行内样式（否则 :hover 位移会被盖住）
    LV.tweenIn(btns, { x: 90, scale: 0.94, opacity: 0 }, { x: 0, scale: 1, opacity: 1, duration: 0.7, stagger: 0.08, ease: 'spring' });
  }

  /** 选中后：选中的那个亮一下，其他的先退场 */
  async function leave(btns, picked, job) {
    if (!job.valid()) return;
    btns.forEach((b) => { b.style.transition = 'none'; b.style.pointerEvents = 'none'; });   // 离场时不再响应 hover
    gsap.killTweensOf(btns); // Stop a fast tap from racing the entrance tween.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { btns.forEach(b => b.remove()); return; }
    const others = btns.filter((b, i) => i !== picked);
    if (others.length) gsap.to(others, { x: -50, scale: 0.96, opacity: 0, duration: 0.28, stagger: 0.035, ease: 'power2.in' });
    if (picked >= 0 && btns[picked]) {
      const b = btns[picked];
      b.classList.add('picked');
      // 选中：圆标那里蹦出一小把心心
      const k = b.querySelector('.key');
      if (k && LV.feel && !LV.play.skipping()) { const r = LV.stageRect(k); LV.feel.sparkle(r.x + r.w / 2, r.y + r.h / 2); }
      await gsap.timeline()
        .to(b, { scale: 1.045, duration: 0.42, ease: 'springPop' })
        .to(b, { scale: 0.98, opacity: 0, duration: 0.26, ease: 'power2.in', delay: 0.02 });
    } else {
      await LV.sleep(320);
    }
    if (!job.valid()) return;
    btns.forEach(b => b.remove());
  }

  LV.choice = {
    active: false,
    _beginPresentation: beginChoice, // Shared ownership for v6 Grab/Push presentations.

    init() { box = document.getElementById('choices'); },

    /**
     * 显示一组选项，返回选中的序号（0 开始）；限时选项超时返回 -1。
     * @param {string[]} options
     * @param {object} o  timed 秒 · dead · hang 秒
     */
    show(options, o) {
      o = o || {};
      const job = beginChoice();
      if (!options.length) { job.close(-1); return Promise.resolve(-1); }
      LV.choice.active = true;
      LV.choice.late = false;
      box.innerHTML = '';
      const btns = options.map((t, i) => makeButton(t, i, o.dead ? 'dead' : ''));
      const editLocked = !!(o.edits && o.edits.length && (o.editStyle || 'subtle') !== 'subtle');
      btns.forEach((b) => { job.nodes.add(b); if (editLocked) b.classList.add('ed-lock'); box.appendChild(b); });
      enter(btns);

      return new Promise((resolve) => {
        job.resolve = resolve;
        let done = false;
        const live = () => job.valid() && !done;
        let timerTween = null;
        const finish = async (i, scripted = false) => {
          if (!live() || (!scripted && i >= 0 && btns[i]?.classList.contains('ed-lock'))) return;
          done = true; job.clearDelays();
          LV.input.remove(handler);
          if (timerTween) timerTween.kill();
          if (i >= 0) LV.audio.se('select');
          await leave(btns, i, job);
          if (!job.valid()) return;
          job.close(i);
        };
        // 键盘 1/2/3 也可以选；拦住“推进”，免得误点跳过选项
        const handler = {
          modal: false,
          advance() { return true; },
          wheelDown() { return true; },
          key(e) { const n = parseInt(e.key, 10); if (n >= 1 && n <= btns.length) { finish(n - 1); return true; } return false; },
        };
        job.handler = handler; LV.input.push(handler);

        btns.forEach((b, i) => b.addEventListener('click', (e) => { e.stopPropagation(); finish(i); }));

        // 改选项（edits: [{i, text}]）
        //   subtle：刚看向选项，某一句就悄悄换了几个字
        //   overt ：马克笔划掉、写上新的字；press>=0 时那只手伸进来替玩家按
        if (o.edits && o.edits.length) {
          const style = o.editStyle || 'subtle';
          const apply = async () => {
            if (!live()) return;
            if (style === 'subtle') {
              o.edits.forEach(({ i, text }) => {
                const b = btns[i];
                if (!b) return;
                const tx = b.querySelector('.txt');
                if (LV.play.skipping()) { tx.textContent = text; return; }
                b.classList.add('ed-glitch');
                LV.audio.se('tick');
                job.later(() => { if (live()) tx.textContent = text; }, 120);
                job.later(() => b.classList.remove('ed-glitch'), 320);
              });
              return;
            }
            // overt
            btns.forEach((b) => b.classList.add('ed-lock'));
            for (const { i, text } of o.edits) {
              const b = btns[i];
              if (!b) continue;
              const tx = b.querySelector('.txt');
              if (LV.play.skipping()) { tx.textContent = text; continue; }
              await job.wait(500); if (!live()) return;
              tx.innerHTML = `<s class="d-old">${LV.esc(tx.textContent)}<i class="s1"></i><i class="s2"></i></s><span class="ed-new">${LV.esc(text)}</span>`;
              b.classList.add('ed-overt');
              LV.audio.se('pen');
              await gsap.fromTo(tx.querySelector('.s1'), { scaleX: 0 }, { scaleX: 1, duration: 0.2, ease: 'power2.out' }); if (!live()) return;
              await gsap.fromTo(tx.querySelector('.s2'), { scaleX: 0 }, { scaleX: 1, duration: 0.2, ease: 'power2.out' }); if (!live()) return;
              LV.audio.se('pen');
              await gsap.fromTo(tx.querySelector('.ed-new'), { clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0% 0 0)', duration: LV.clamp(text.length * 0.12, 0.6, 1.4), ease: 'power1.inOut' }); if (!live()) return;
            }
            if (o.press != null && o.press >= 0 && btns[o.press]) {
              await job.wait(LV.play.skipping() ? 0 : 700); if (!live()) return;
              if (!LV.play.skipping()) await pressWithHand(btns[o.press], job); if (!live()) return;
              finish(o.press, true);
            } else {
              btns.forEach((b) => b.classList.remove('ed-lock'));
            }
          };
          if (style === 'subtle') {
            let fired = false;
            const once = () => { if (fired || !live()) return; fired = true; job.later(apply, 260); };
            btns.forEach((b) => b.addEventListener('mouseenter', once));
            job.later(once, 1600);
          } else {
            job.later(apply, 600);
          }
        }

        if (o.timed) {
          // 限时：条走完算沉默（返回 -1），沉默有沉默的后果。
          //   最后三秒：条变红，一下一下地跳，带心跳声。
          //   patient="一句话"：条走完什么都不罚，条淡掉，冒出那句话，选项还在原地等。
          const bar = LV.el('div', 'choice-timer', '<i></i>');
          job.nodes.add(bar); box.insertBefore(bar, box.firstChild);
          gsap.fromTo(bar, { opacity: 0 }, { opacity: 1, duration: 0.3 });
          let lastBeat = 0;
          job.timerTween = timerTween = gsap.fromTo(bar.firstChild, { scaleX: 1 }, {
            scaleX: 0, duration: o.timed, delay: 0.6, ease: 'none',
            onUpdate() {
              const left = o.timed * (1 - this.progress());
              if (left > 3 || left <= 0 || !live()) return;
              const sec = Math.ceil(left);
              if (sec === lastBeat) return;
              lastBeat = sec;
              bar.classList.add('urgent');
              LV.audio.se('beat');
            },
            onComplete: () => {
              if (!live()) return;
              bar.classList.remove('urgent');
              if (o.patient) {
                LV.choice.late = true;
                gsap.to(bar, { opacity: 0, duration: 0.6 });
                const note = LV.el('div', 'choice-note', LV.esc(o.patient));
                job.nodes.add(note); box.appendChild(note);
                gsap.fromTo(note, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.6, delay: 0.5 });
                return;
              }
              LV.audio.se('chimeDown');
              finish(-1);
            },
          });
        }

        if (o.hang) {
          // 停在屏幕上：点了也没用；hang 秒后剧情继续，选项慢慢淡掉
          btns.forEach((b) => b.addEventListener('click', () => LV.audio.se('tick')));
          done = true;
          LV.input.remove(handler);
          job.later(() => {
            if (!job.valid()) return;
            LV.choice.active = false;
            resolve(-1);
            gsap.to(btns, { opacity: 0, duration: 2.6, ease: 'sine.inOut', delay: 1.2, onComplete: () => { if (job.valid()) job.close(-1); } });
          }, o.hang * 1000);
        }
      });
    },

    /**
     * D 选项。A/B/C 出现 → 光标靠近（或 1 秒后）第四个选项慢慢浮现 →
     * 一只手从画面右侧伸进 UI 层，按下 D。
     */
    showD(options, dText, o) {
      o = o || {};
      const job = beginChoice();
      LV.choice.active = true;
      box.innerHTML = '';
      const btns = options.map((t, i) => makeButton(t, i));
      btns.forEach((b) => { job.nodes.add(b); box.appendChild(b); b.addEventListener('click', (e) => { e.stopPropagation(); LV.audio.se('tick'); }); });
      enter(btns);
      const blocker = { advance() { return true; }, wheelDown() { return true; } };
      job.handler = blocker; LV.input.push(blocker);

      return new Promise((resolve) => {
        job.resolve = resolve;
        let appeared = false;
        const appearD = async () => {
          if (appeared || !job.valid()) return;
          appeared = true;
          await job.wait(350); if (!job.valid()) return;
          const d = makeButton(o.try ? o.try : dText, 3, 'd-option');
          d.addEventListener('click', (e) => { e.stopPropagation(); });
          d.addEventListener('mouseenter', (e) => e.stopImmediatePropagation(), true);
          job.nodes.add(d); box.appendChild(d);
          LV.audio.se('pen');
          // 像是有人正在写上去：从左到右一点点露出来
          gsap.fromTo(d, { opacity: 0, clipPath: 'inset(0 100% 0 0)' }, { opacity: 1, clipPath: 'inset(0 0% 0 0)', duration: o.try ? 1.1 : 1.5, ease: 'power1.inOut' });
          if (o.try && !LV.play.skipping()) {
            // o.try：先写上另一句 → 校验不通过 → 划掉两道 → 写上 dText
            await job.wait(1500); if (!job.valid()) return;
            const txt = d.querySelector('.txt');
            const tag = LV.el('span', 'd-reject', `✕ 校验未通过：${LV.esc(o.reject || '不符合规则')}`);
            d.appendChild(tag);
            d.classList.add('rejected');
            LV.audio.se('chimeDown');
            gsap.fromTo(d, { x: -10 }, { x: 0, duration: 0.5, ease: 'elastic.out(1, .3)' });
            gsap.fromTo(tag, { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: 0.3 });
            await job.wait(1300); if (!job.valid()) return;
            txt.innerHTML = `<s class="d-old">${LV.esc(o.try)}<i class="s1"></i><i class="s2"></i></s><span class="d-new">${LV.esc(dText)}</span>`;
            LV.audio.se('pen');
            const s1 = txt.querySelector('.s1'), s2 = txt.querySelector('.s2');
            await gsap.fromTo(s1, { scaleX: 0 }, { scaleX: 1, duration: 0.22, ease: 'power2.out' }); if (!job.valid()) return;
            await gsap.fromTo(s2, { scaleX: 0 }, { scaleX: 1, duration: 0.22, ease: 'power2.out' }); if (!job.valid()) return;
            gsap.to(tag, { opacity: 0, duration: 0.3, onComplete: () => tag.remove() });
            d.classList.remove('rejected');
            await job.wait(350); if (!job.valid()) return;
            LV.audio.se('pen');
            await gsap.fromTo(txt.querySelector('.d-new'), { clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0% 0 0)', duration: 1.2, ease: 'power1.inOut' }); if (!job.valid()) return;
            const ok = LV.el('span', 'd-pass', '✓');
            d.appendChild(ok);
            LV.audio.se('tick');
            gsap.fromTo(ok, { opacity: 0, scale: 1.8 }, { opacity: 1, scale: 1, duration: 0.35, ease: 'springPop' });
            await job.wait(900); if (!job.valid()) return;
          } else if (o.try) {
            d.querySelector('.txt').textContent = dText;
          }
          await job.wait(2600); if (!job.valid()) return;
          await pressWithHand(d, job); if (!job.valid()) return;
          LV.input.remove(blocker);
          await leave(btns.concat([d]), 3, job); if (!job.valid()) return;
          job.close(3);
        };
        btns.forEach((b) => b.addEventListener('mouseenter', appearD));
        job.later(appearD, 1100);
      });
    },

    /**
     * 金边英雄选项。不阻塞剧本——显示后剧情继续。
     * 返回一个控制器，用它让选项一个个消失。
     * @param {Function} onFirstClick 玩家第一次去按的时候
     */
    showHero(options, onFirstClick) {
      if (currentChoice) currentChoice.close(-1);
      box.innerHTML = '';
      const btns = options.map((t, i) => makeButton(t, i, 'hero'));
      let clicked = false;
      btns.forEach((b) => {
        box.appendChild(b);
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          LV.audio.se('click');
          LV.tweenIn(b, { scale: 0.96 }, { scale: 1, duration: 0.3, ease: 'back.out(3)' });
          if (!clicked) { clicked = true; if (onFirstClick) onFirstClick(); }
        });
      });
      enter(btns);
      return {
        btns,
        /** 轻轻闪一下 */
        blink() { gsap.fromTo(btns, { opacity: 0.45 }, { opacity: 1, duration: 0.35, stagger: 0.05 }); },
        /** 让第 i 个消失 */
        vanish(i) {
          const b = btns[i];
          if (!b) return;
          b.style.pointerEvents = 'none';
          LV.tweenTo(b, { opacity: 0, filter: 'blur(6px)', scale: 0.98, duration: 0.9, ease: 'sine.in' });
        },
        clear() { btns.forEach(b => b.remove()); },
      };
    },
  };

  /** 一只手从 UI 层外面伸进来，按下按钮 */
  async function pressWithHand(target, job) {
    if (!job.valid()) return;
    const stage = document.getElementById('stage');
    const hand = LV.el('div', '', LV.sprites.icon('hand'));
    hand.id = 'hand';
    job.nodes.add(hand); stage.appendChild(hand);
    const r = LV.stageRect(target);
    // 手指尖在手图的 (26, 116)；按在字的右边一点，别把字挡住
    const tx = r.x + 640 - 26;
    const ty = r.y + r.h / 2 - 116;
    // 只动 transform（x / y），不动 left / top：每一帧都不用重新排版
    gsap.set(hand, { left: 0, top: 0, x: 1960, y: ty + 40, rotation: 6 });
    await gsap.to(hand, { x: tx, y: ty, rotation: 0, duration: 1.3, ease: 'springSoft' }); if (!job.valid()) return;
    await job.wait(250); if (!job.valid()) return;
    // 按下
    await gsap.to(hand, { x: tx - 10, duration: 0.12, ease: 'power2.in' }); if (!job.valid()) return;
    target.classList.add('pressed');
    LV.audio.se('click');
    await gsap.to(hand, { x: tx, duration: 0.3, ease: 'springPop' }); if (!job.valid()) return;
    await job.wait(300); if (!job.valid()) return;
    gsap.to(hand, { x: 1980, duration: 0.8, ease: 'power2.in', onComplete: () => hand.remove() });
  }
})();
