/* 试玩外壳（Luokixi 开源广场）：轮流演示《请不要攻略我》的几种选项。
   选项系统是游戏原来的代码；这里的台词是为试玩新写的，不是游戏剧情。 */
(function () {
  'use strict';
  const LV = window.LV;
  const gsap = window.gsap;
  const stage = document.getElementById('stage');
  const cap = { k: document.getElementById('demo-k'), t: document.getElementById('demo-t') };
  const nav = document.getElementById('demo-nav');
  const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // ?demo=1：开源广场精选里只播不操作——替玩家点，演完从头再来
  const DEMO = /[?&]demo=1/.test(location.search);
  if (DEMO) document.documentElement.classList.add('lk-demo');
  const later = (alive, ms, fn) => setTimeout(() => { if (alive()) fn(); }, ms);

  // 和游戏 mobile.js 一样：触屏上把选项放到手指按得到的大小
  const TOUCH = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
  if (TOUCH) document.body.classList.add('touch');
  const fit = () => { LV.fitStage(); if (TOUCH) stage.style.setProperty('--touch-px', (1 / LV.stageScale()) + 'px'); };
  window.addEventListener('resize', fit);
  fit();
  LV.initInput();
  LV.choice.init();

  function say(k, t) {
    cap.k.textContent = k;
    cap.t.textContent = t;
    if (!reduced()) gsap.fromTo([cap.k, cap.t], { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.5, stagger: 0.06, ease: 'spring' });
  }

  const ROUNDS = [
    {
      name: '普通',
      async play(alive) {
        say('普通选项', '周末的第一件事？点一个，或者按 1 / 2 / 3');
        if (DEMO) later(alive, 2400, () => LV.input.dispatch('key', { key: '2' }));
        const i = await LV.choice.show(['去图书馆占座', '去操场跑两圈', '回宿舍补觉']);
        if (!alive() || i < 0) return;
        say('普通选项', `选了 ${'ABC'[i]}：选中的那张亮一下，其余的先退场`);
        await LV.sleep(2400);
      },
    },
    {
      name: '限时',
      async play(alive) {
        say('限时选项', '6 秒内回一句。最后 3 秒，进度条变红，跟着心跳');
        const i = await LV.choice.show(['马上回', '等会儿再说', '假装没看见'], { timed: 6 });
        if (!alive()) return;
        say('限时选项', i < 0 ? '时间到。不选，也是一种回答' : '赶上了');
        await LV.sleep(2600);
      },
    },
    {
      name: '第四个',
      async play(alive) {
        say('D 选项', '三个选项之外，有人在写第四个');
        await LV.choice.showD(['先复习高数', '先打一把游戏', '先睡一觉'], '先复习，再打一把', { try: '全都要', reject: '一次只能选一个' });
        if (!alive()) return;
        say('D 选项', '这一个你按不了——有只手替你按了');
        await LV.sleep(2600);
      },
    },
    {
      name: '英雄',
      async play(alive) {
        say('英雄选项', '金边的，看起来很重要。去按按看');
        const hero = LV.choice.showHero(['拯救世界', '拯救期末', '拯救睡眠'], () => { if (alive()) say('英雄选项', '按不下去的。它们会一个个消失'); });
        if (DEMO) later(alive, 1800, () => hero.btns[0].click());
        for (const [ms, step] of [[3800, () => hero.blink()], [1400, () => hero.vanish(2)], [1000, () => hero.vanish(1)], [1000, () => hero.vanish(0)], [1300, () => hero.clear()]]) {
          await LV.sleep(ms);
          if (!alive()) return;
          step();
        }
      },
    },
    {
      name: '……',
      async play(alive) {
        say('沉默', '三个都是“……”。点了也没用，3 秒后自己往下走');
        await LV.choice.show(['……', '……', '……'], { dead: true, hang: 3 });
        if (!alive()) return;
        say('沉默', '没有选，故事也往下走了');
        await LV.sleep(4000);
      },
    },
  ];

  const tabs = ROUNDS.map((r, i) => {
    const b = LV.el('button', '', LV.esc(r.name));
    b.type = 'button';
    b.addEventListener('click', (e) => { e.stopPropagation(); run(i); });
    nav.appendChild(b);
    return b;
  });

  let token = 0;
  async function run(from) {
    const mine = ++token;
    const alive = () => mine === token;
    LV.bus.emit('abort');                     // 正在显示的选项收起来（choices.js 自己监听）
    for (let i = from; i < ROUNDS.length; i++) {
      tabs.forEach((b, j) => b.setAttribute('aria-current', String(j === i)));
      await ROUNDS[i].play(alive);
      if (!alive()) return;
    }
    tabs.forEach((b) => b.removeAttribute('aria-current'));
    if (DEMO) { later(alive, 600, () => run(0)); return; }
    say('试完了', '点下面任意一种，再看一遍');
  }
  run(0);
})();
