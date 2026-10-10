// GSAP 的全站入口（Opus · 2026-10-10）。只在真的要用时 import()，首屏不加载。
// 只用 GSAP 做浏览器原生做不好的事：Flip（多个元素重排）、Draggable + Inertia（拖拽和甩出去的惯性）、
// SplitText（按行切标题）。单个元素的进出场、按压、弹窗仍走 WAAPI / CSS，跑在合成线程上。
//
// 曲线和 tokens.css 一致：'ios'（大面）、'out'（小东西）、'ios-in'（出场）；
// 弹簧和 motion.js 的 SPRINGS 一致：'spring-smooth' / 'spring-snappy' / 'spring-bouncy' / 'spring-interactive'，
// 配套时长用 springEase(name).duration。
import { gsap } from 'gsap';
import { CustomEase } from 'gsap/CustomEase';
import { SPRINGS, springEase } from './motion.js';

gsap.registerPlugin(CustomEase);
CustomEase.create('ios', '0.32,0.72,0,1');
CustomEase.create('ios-in', '0.4,0,1,1');
CustomEase.create('out', '0.22,1,0.36,1');
for (const name of Object.keys(SPRINGS)) gsap.registerEase(`spring-${name}`, springEase(name).ease);
gsap.defaults({ ease: 'ios', duration: 0.42 });

export { gsap };

let flip, drag, split;
export const loadFlip = () => (flip ??= import('gsap/Flip').then(({ Flip }) => {
  gsap.registerPlugin(Flip);
  return Flip;
}));

export const loadDraggable = () => (drag ??= Promise.all([import('gsap/Draggable'), import('gsap/InertiaPlugin')]).then(([d, i]) => {
  gsap.registerPlugin(d.Draggable, i.InertiaPlugin);
  return { Draggable: d.Draggable, InertiaPlugin: i.InertiaPlugin };
}));

export const loadSplitText = () => (split ??= import('gsap/SplitText').then(({ SplitText }) => {
  gsap.registerPlugin(SplitText);
  return SplitText;
}));
