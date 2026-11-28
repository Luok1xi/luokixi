/* sprites-hand.js —— 摘自《请不要攻略我》sprites.js：只留“按 D 的那只手” */
(function () {
  'use strict';
  const ICONS = {
    // 按 D 的那只手：长袖子 + 伸出的食指
    hand: `<svg viewBox="0 0 360 260"><path d="M360,60 C300,60 250,70 210,90 L230,200 C270,190 310,186 360,186 Z" fill="#8e9bb6"/><path d="M212,92 C204,120 206,170 228,198" fill="none" stroke="#7a86a1" stroke-width="12"/>
      <path d="M214,110 C180,104 150,104 118,108 L30,104 C14,104 12,126 28,130 L112,138 C100,150 100,170 112,178 C104,190 110,206 124,208 C120,222 132,234 146,232 L200,226 C214,220 222,196 220,170 Z" fill="#f4d4c6" stroke="#dcae9d" stroke-width="3"/>
      <ellipse cx="34" cy="116" rx="12" ry="9" fill="#f2a9a9" opacity=".8"/></svg>`,
  };
  window.LV.sprites = { icon: (name) => ICONS[name] || '' };
})();
