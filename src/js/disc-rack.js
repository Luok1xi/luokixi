// 开源广场 · 光碟架：每个项目一张光碟，盘面用项目 README 里的真实图片裁出来。
// 参考 a24.raviklaassens.com 公开可见的效果和参数量级（Ravi Klaassens 的 A24 概念站），代码为本项目原创，没有使用原站代码或素材。
// Three.js 只在这个页面按需加载；GSAP 负责全部时间线。渲染只在看得见、有变化时进行。
// 没有真实图片的项目画成分类色的空白光盘，只印项目名，不另造画面。
import { gsap } from 'gsap';
import { CustomEase } from 'gsap/CustomEase';
import { reducedMotion } from './shell.js';
import { createDiscPrinter } from './disc-print.js';

gsap.registerPlugin(CustomEase);
// 全站统一的“快出慢停”曲线，和换页、弹窗同一套手感
if (!CustomEase.get('lk')) CustomEase.create('lk', '0.32, 0.72, 0, 1');
if (!CustomEase.get('lk-main')) CustomEase.create('lk-main', '0.625, 0.05, 0, 1');

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const DEG = Math.PI / 180;
// 光碟尺寸（半径为 1）：中心孔、透明夹持区、厚度
const R = 1, HOLE = 0.125, HUB = 0.3, THICK = 0.014;

// 有 WebGL 才用光碟架，否则页面退回原来的竖滑流
export function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return Boolean(gl);
  } catch {
    return false;
  }
}

// ---------- 盘面 ----------

function loadImage(src) {
  return new Promise((resolve) => {
    if (!src || !/^https?:\/\//.test(src) && !src.startsWith('/')) return resolve(null);
    const img = new Image();
    img.crossOrigin = 'anonymous'; // 外站图片要能画进 WebGL；对方不允许跨域时退回排版盘面
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function ringInk(g, S) {
  try {
    const band = g.getImageData(0, 0, S, Math.round(S * 0.12)).data;
    let sum = 0, n = 0;
    for (let i = 0; i < band.length; i += 64) { sum += 0.2126 * band[i] + 0.7152 * band[i + 1] + 0.0722 * band[i + 2]; n++; }
    return sum / n > 150 ? 'rgba(20,20,22,.82)' : 'rgba(255,255,255,.86)';
  } catch {
    return 'rgba(255,255,255,.86)';
  }
}

function drawRingText(g, S, text, ink) {
  const cx = S / 2, rad = S * 0.455;
  g.save();
  g.fillStyle = ink;
  g.font = `600 ${Math.round(S * 0.022)}px "PingFang SC","Microsoft YaHei",system-ui,sans-serif`;
  g.textBaseline = 'middle';
  let a = -Math.PI * 0.62;
  const end = a + Math.PI * 1.38;
  for (const ch of (text + '   ·   ').repeat(4)) {
    const w = g.measureText(ch).width + S * 0.004;
    if (a > end) break;
    g.save();
    g.translate(cx + Math.cos(a) * rad, cx + Math.sin(a) * rad);
    g.rotate(a + Math.PI / 2);
    g.fillText(ch, -w / 2, 0);
    g.restore();
    a += w / rad;
  }
  g.restore();
}

// 一张 1024² 的盘面：真实图片居中裁切；没有图片时分类色底 + 项目名
async function discArt(THREE, d, img, printer) {
  const S = 1024, c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.save();
  g.beginPath(); g.arc(S / 2, S / 2, S / 2, 0, Math.PI * 2); g.clip();
  if (img) {
    const s = Math.max(S / img.width, S / img.height);
    const w = img.width * s, h = img.height * s;
    g.drawImage(img, (S - w) / 2, (S - h) / 2, w, h);
    const v = g.createRadialGradient(S / 2, S / 2, S * 0.2, S / 2, S / 2, S * 0.52);
    v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,.28)');
    g.fillStyle = v; g.fillRect(0, 0, S, S);
  } else {
    const bg = g.createLinearGradient(0, 0, S, S);
    bg.addColorStop(0, `hsl(${d.hue} 34% 34%)`); bg.addColorStop(1, `hsl(${(d.hue + 30) % 360} 30% 18%)`);
    g.fillStyle = bg; g.fillRect(0, 0, S, S);
    g.fillStyle = 'rgba(255,255,255,.94)';
    g.textAlign = 'center';
    const lines = d.label;
    let fs = S * 0.1;
    const font = () => `800 ${fs}px "PingFang SC","Microsoft YaHei",system-ui,sans-serif`;
    g.font = font();
    const widest = Math.max(...lines.map((t) => g.measureText(t).width));
    if (widest > S * 0.62) { fs *= (S * 0.62) / widest; g.font = font(); }
    lines.forEach((t, i) => g.fillText(t, S / 2, S * 0.74 + (i - (lines.length - 1) / 2) * fs * 1.12));
    g.font = `500 ${S * 0.026}px ui-monospace,"SF Mono",Menlo,monospace`;
    g.fillStyle = 'rgba(255,255,255,.6)';
    g.fillText(d.repo, S / 2, S * 0.27);
  }
  // 细颗粒，像印刷出来的盘面
  try {
    const grain = await printer.apply(g.getImageData(0, 0, S, S));
    g.putImageData(grain, 0, 0);
  } catch (error) { if (error?.name === 'AbortError') throw error; /* 跨域图片读不了像素时跳过颗粒 */ }
  const ink = ringInk(g, S);
  drawRingText(g, S, d.ring, ink);
  g.fillStyle = ink; g.textAlign = 'center';
  g.font = `700 ${S * 0.03}px "Inter Variable","SF Pro Display",system-ui,sans-serif`;
  g.fillText('Luokixi', S / 2, S * 0.885);
  g.restore();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function grooveTexture(THREE) {
  const S = 512, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d');
  g.fillStyle = '#7a7a7a'; g.fillRect(0, 0, S, S);
  for (let r = S * 0.15; r < S * 0.5; r += 1.6) {
    const v = Math.random() > 0.5 ? 255 : 0;
    g.strokeStyle = `rgba(${v},${v},${v},.05)`;
    g.beginPath(); g.arc(S / 2, S / 2, r, 0, Math.PI * 2); g.stroke();
  }
  return new THREE.CanvasTexture(c);
}

// 柔和的影棚环境：上方大面积柔光、两侧条形灯，给光碟反光
function studioEnv(THREE, renderer) {
  const W = 1024, H = 512, c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  const sky = g.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#ffffff'); sky.addColorStop(0.45, '#d9d6d0'); sky.addColorStop(0.55, '#8d8a86'); sky.addColorStop(1, '#3a3937');
  g.fillStyle = sky; g.fillRect(0, 0, W, H);
  g.fillStyle = 'rgba(255,255,255,.95)';
  g.fillRect(W * 0.12, H * 0.18, W * 0.08, H * 0.42);
  g.fillRect(W * 0.62, H * 0.12, W * 0.2, H * 0.12);
  g.fillStyle = 'rgba(120,180,255,.7)'; g.fillRect(W * 0.86, H * 0.25, W * 0.05, H * 0.35);
  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  const pm = new THREE.PMREMGenerator(renderer);
  const env = pm.fromEquirectangular(tex);
  tex.dispose(); pm.dispose();
  return env;
}

function discMaterials(THREE, grooves) {
  return {
    back: new THREE.MeshPhysicalMaterial({
      color: '#1b1f2b', metalness: 1, roughness: 0.22, roughnessMap: grooves,
      iridescence: 1, iridescenceIOR: 1.8, iridescenceThicknessRange: [120, 880], clearcoat: 0.35, envMapIntensity: 1.4,
    }),
    edge: new THREE.MeshStandardMaterial({ color: '#f4f4f4', metalness: 0.55, roughness: 0.08 }),
    hub: new THREE.MeshPhysicalMaterial({
      color: '#cfd8e2', roughness: 0.28, metalness: 0, transparent: true, opacity: 0.32, clearcoat: 1, side: THREE.DoubleSide, forceSinglePass: true, envMapIntensity: 1.4, depthWrite: false,
    }),
    stack: new THREE.MeshStandardMaterial({ color: '#b9c2cc', roughness: 0.25, metalness: 0.3, transparent: true, opacity: 0.75, side: THREE.DoubleSide, forceSinglePass: true }),
    lip: new THREE.MeshStandardMaterial({ color: '#e9ecef', metalness: 0.6, roughness: 0.15, side: THREE.DoubleSide }),
    holeEdge: new THREE.MeshStandardMaterial({ color: '#d8dde3', roughness: 0.3, side: THREE.BackSide }),
  };
}

function buildDisc(THREE, geo, mats, tex) {
  const disc = new THREE.Group();
  const front = new THREE.Mesh(geo.face, new THREE.MeshPhysicalMaterial({
    map: tex, roughness: 0.46, metalness: 0.08, clearcoat: 0.8, clearcoatRoughness: 0.22, envMapIntensity: 0.8,
  }));
  front.position.z = THICK / 2;
  const back = new THREE.Mesh(geo.face, mats.back);
  back.rotation.y = Math.PI; back.position.z = -THICK / 2;
  const edge = new THREE.Mesh(geo.edge, mats.edge); edge.rotation.x = Math.PI / 2;
  const hub = new THREE.Mesh(geo.hub, mats.hub);
  const stack = new THREE.Mesh(geo.stack, mats.stack); stack.position.z = THICK * 0.6;
  const lip = new THREE.Mesh(geo.lip, mats.lip); lip.position.z = THICK * 0.55;
  const holeEdge = new THREE.Mesh(geo.holeEdge, mats.holeEdge); holeEdge.rotation.x = Math.PI / 2;
  disc.add(front, back, edge, hub, stack, lip, holeEdge);
  // 盘内各层形状固定；只更新整张盘的矩阵，反光、透明圈与厚度仍完整保留。
  disc.children.forEach((mesh) => { mesh.updateMatrix(); mesh.matrixAutoUpdate = false; });
  disc.userData.front = front;
  return disc;
}

// ---------- 手绘圈：在光碟外侧画 1.18 圈，起止不闭合，每秒只重画 10 次，线条轻微抖动 ----------

function scribblePath(pts, seed) {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
  const cy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
  const out = [], n = pts.length, total = Math.round(n * 1.18), start = Math.floor(rnd() * n);
  for (let k = 0; k <= total; k++) {
    const p = pts[(start + k) % n];
    const t = k / total;
    const grow = 1.07 + 0.05 * Math.sin(t * Math.PI * 2 + rnd()) + (rnd() - 0.5) * 0.018 + t * 0.03;
    out.push({ x: cx + (p.x - cx) * grow, y: cy + (p.y - cy) * grow });
  }
  return out;
}

// ---------- 文字在遮罩里整行换：旧的 0.4 秒向上滑出，新的 0.7 秒从下方升起 ----------

export function swapLines(els, values, prev) {
  prev?.kill();
  const inner = els.map((el) => {
    if (!el.querySelector(':scope > .lk-m')) el.innerHTML = `<span class="lk-m"><span class="lk-mi"></span></span>`;
    return el.querySelector('.lk-mi');
  });
  const set = () => inner.forEach((n, i) => { if (typeof values[i] === 'function') values[i](n); else n.textContent = values[i]; });
  if (reducedMotion()) { gsap.set(inner, { yPercent: 0 }); set(); return gsap.timeline(); }
  return gsap.timeline()
    .to(inner, { yPercent: -120, duration: 0.4, stagger: 0.016, ease: 'lk' })
    .add(set)
    .fromTo(inner, { yPercent: 120 }, { yPercent: 0, duration: 0.7, stagger: 0.05, ease: 'lk' });
}

// ---------- 光碟架 ----------

// items: [{ key, hue, label: [行], repo, ring, cover }]
export async function mountRack(root, items, { onActive, onOpen } = {}) {
  const THREE = await import('three');
  const stage = root.querySelector('.dg-stage');
  const canvas = root.querySelector('.dg-canvas');
  const sc = root.querySelector('.dg-scribble');
  const sg = sc.getContext('2d');

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;
  const scene = new THREE.Scene();
  const environment = studioEnv(THREE, renderer);
  scene.environment = environment.texture;
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 60);
  camera.position.set(0, 0, 4.4);
  const key = new THREE.DirectionalLight('#fff7e6', 1.5); key.position.set(3.5, 4, 5);
  const rim = new THREE.DirectionalLight('#5aa8ff', 0.9); rim.position.set(-4, -2, -3);
  scene.add(key, rim, new THREE.HemisphereLight('#ffffff', '#9a958d', 0.55));
  const rig = new THREE.Group();
  scene.add(rig);
  // 所有光碟共用几何体和非贴图材质，只有盘面贴图各不相同
  const geo = {
    face: new THREE.RingGeometry(HUB, R, 160, 1),
    edge: new THREE.CylinderGeometry(R, R, THICK, 160, 1, true),
    hub: new THREE.RingGeometry(HOLE, HUB, 96, 1),
    stack: new THREE.RingGeometry(HUB * 0.68, HUB * 0.74, 96, 1),
    lip: new THREE.RingGeometry(HUB * 0.985, HUB * 1.01, 96, 1),
    holeEdge: new THREE.CylinderGeometry(HOLE, HOLE, THICK, 64, 1, true),
  };
  const grooves = grooveTexture(THREE);
  const mats = discMaterials(THREE, grooves);
  const placeholder = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  placeholder.needsUpdate = true;

  const st = { pos: -6, intro: 0, open: 0, press: 0 };
  let list = [], discs = [], active = 0, target = 0, tween = null, mobile = false, visible = false, running = false;
  let velocity = 0, lastPos = st.pos, hovering = false, detailOpen = false, destroyed = false;

  const reduceQuery = matchMedia('(prefers-reduced-motion: reduce)');
  const hoverQuery = matchMedia('(hover: hover) and (pointer: fine)');
  let reduce = reduceQuery.matches, stageWidth = 1, stageHeight = 1;
  let stageRect = null, ink = '#111', introTween = null, openTween = null;
  // 分类与搜索可以反复使用同一张盘。只为即将进入视野的盘制作原尺寸贴图，
  // 每个空闲片段最多处理一张，避免一次筛选同步重画整个目录。
  const parked = new Map(), artJobs = new Map();
  const printer = createDiscPrinter();
  let artTask = null, artBusy = false;
  const signature = (d) => JSON.stringify([d.key, d.hue, d.label, d.repo, d.ring, d.cover]);
  function scheduleArt() {
    if (artTask != null || artBusy || !artJobs.size || destroyed || document.hidden || !visible) return;
    if (![...artJobs.keys()].some((disc) => disc.parent === rig)) return;
    const run = async () => {
      artTask = null;
      if (destroyed || document.hidden || !visible) return;
      const next = [...artJobs.keys()].filter((d) => d.parent === rig && !d.userData.disposed).sort((a, b) =>
        Math.abs(discs.indexOf(a) - st.pos) - Math.abs(discs.indexOf(b) - st.pos))[0];
      if (!next) return;
      const job = artJobs.get(next); artJobs.delete(next);
      artBusy = true;
      try { if (!next.userData.disposed && next.parent === rig) await job(); }
      catch (error) { if (!destroyed && error?.name !== 'AbortError') console.warn('[disc] 盘面准备失败',error); }
      finally { artBusy = false; scheduleArt(); }
    };
    artTask = window.requestIdleCallback ? requestIdleCallback(run, { timeout: 160 }) : setTimeout(run, 16);
  }
  function queueArt(disc, job) { artJobs.set(disc, job); scheduleArt(); }
  function trimArt() {
    const ready = [...discs, ...parked.values()].filter((d) => d.userData.artReady);
    ready.sort((a, b) => a.userData.artUsed - b.userData.artUsed);
    let excess = ready.length - 24;
    for (const disc of ready) {
      if (excess <= 0) break;
      const i = discs.indexOf(disc);
      if (i >= 0 && Math.abs(i - st.pos) < 5) continue;
      disc.userData.front.material.map.dispose();
      disc.userData.front.material.map = placeholder;
      disc.userData.front.material.color.setStyle(`hsl(${disc.userData.data.hue}, 34%, 26%)`);
      disc.userData.artReady = false;
      excess--;
    }
  }
  function ensureArt(disc) {
    const state = disc.userData;
    state.artUsed = performance.now();
    if (state.artReady || state.artBuilding || artJobs.has(disc)) return;
    state.artBuilding = true;
    queueArt(disc, async () => {
      const d = state.data, material = state.front.material;
      let texture;
      try { texture = await discArt(THREE,d,null,printer); }
      finally { state.artBuilding = false; }
      if (destroyed || state.disposed) { texture.dispose(); return; }
      // Upload before exposing the texture to the next animation frame.
      renderer.initTexture(texture);
      material.map = texture;
      material.color.set('#ffffff');
      state.artReady = true;
      trimArt(); wake();
      loadImage(d.cover).then((img) => {
        if (!img || destroyed || state.disposed || !state.artReady) return;
        queueArt(disc, async () => {
          if (!state.artReady) return;
          const old = material.map;
          const texture = await discArt(THREE,d,img,printer);
          if (destroyed || state.disposed || !state.artReady || material.map !== old) { texture.dispose(); return; }
          renderer.initTexture(texture);
          material.map = texture;
          old.dispose();
          // 两张都是带贴图的盘面，无需重复触发材质编译。
          wake();
        });
      });
    });
  }
  function makeDisc(d, i) {
    const id = signature(d);
    let disc = parked.get(id);
    if (disc) parked.delete(id);
    else {
      disc = buildDisc(THREE, geo, mats, placeholder);
      disc.userData.spin = (i * 1.7) % (Math.PI * 2);
      disc.userData.tilt = { x: 0, y: 0 };
      disc.userData.front.material.color.setStyle(`hsl(${d.hue}, 34%, 26%)`);
      disc.userData.signature = id;
      disc.userData.data = d;
      disc.userData.artReady = false;
    }
    disc.userData.removal = 0;
    rig.add(disc);
    return disc;
  }
  function disposeDisc(disc) {
    rig.remove(disc);
    disc.userData.disposed = true;
    artJobs.delete(disc);
    gsap.killTweensOf(disc.userData.tilt);
    gsap.killTweensOf(disc.userData);
    const map = disc.userData.front.material.map;
    if (map && map !== placeholder) map.dispose();
    disc.userData.front.material.dispose();
  }
  function parkDisc(disc) {
    rig.remove(disc);
    gsap.killTweensOf(disc.userData.tilt);
    gsap.killTweensOf(disc.userData);
    disc.userData.tilt.x = disc.userData.tilt.y = 0;
    const id = disc.userData.signature;
    if (parked.has(id)) disposeDisc(parked.get(id));
    parked.set(id, disc);
  }

  function layout(dt) {
    rig.rotation.set((mobile ? -14 : -24) * DEG, (mobile ? -10 : -30) * DEG, (mobile ? 0 : -6) * DEG);
    discs.forEach((disc, i) => {
      const m = i - st.pos, am = Math.abs(m);
      let x, y, z, s;
      if (mobile) {
        x = m * 2.05; y = -0.05; z = -Math.min(am, 2) * 0.6;
        s = lerp(1.1, 0.6, Math.min(am, 1));
      } else {
        x = Math.sin(m * 0.42) * 4.2; y = -Math.sin(m * 0.42) * 0.25; z = -(1 - Math.cos(m * 0.42)) * 3.0;
        s = lerp(1, 0.78, Math.min(am, 1));
      }
      disc.visible = am < 3.6;
      // 离视野很远的盘不进入场景图，Three 不必每帧遍历其七层矩阵。
      if (am < 4.6) {
        if (disc.parent !== rig) rig.add(disc);
        ensureArt(disc);
      } else if (disc.parent === rig) rig.remove(disc);
      if (!disc.visible) return;
      disc.position.set(x, y + (1 - st.intro) * 0.4, z - (1 - st.intro) * 6);
      const isActive = i === active, o = st.open;
      if (isActive) {
        // 打开详情：这张盘抬起、移到一侧、缩小，留在详情旁边
        disc.position.x = lerp(disc.position.x, mobile ? 0 : -2.35, o);
        disc.position.y += o * (mobile ? 1.55 : 0.55);
        disc.position.z += o * (mobile ? 0.2 : 0.4);
        disc.scale.setScalar(s * (1 - st.press * 0.035) * (1 - o * (mobile ? 0.62 : 0.3)));
      } else {
        // 其余的盘向两侧散开、退到远处，给详情让出干净的版面
        disc.position.x += Math.sign(m || 1) * o * 5;
        disc.position.z -= o * 7;
        disc.position.y -= o * 1.2;
        disc.scale.setScalar(s * (1 - o * 0.35));
      }
      const removal = disc.userData.removal;
      disc.position.y -= removal * 2.5;
      disc.scale.multiplyScalar(1 - removal * 0.99);
      if (!reduce) disc.userData.spin += dt * (-0.14 - Math.min(Math.abs(velocity) * 1.6, 7) * Math.sign(velocity || 1) * 0.3);
      const tilt = disc.userData.tilt;
      disc.rotation.set(tilt.x, tilt.y + (isActive ? 0 : m * -0.05), disc.userData.spin - (isActive ? o : 0) * 16 * DEG);
    });
  }

  function frame(_t, dtMs) {
    if (destroyed || document.hidden || !visible) return;
    if (reduce && performance.now() > idleUntil && !dragging) { stop(); return; }
    if (pendingPointer) { const pointer = pendingPointer; pendingPointer = null; updateHover(pointer); }
    const dt = Math.min(dtMs, 50) / 1000;
    velocity = lerp(velocity, (st.pos - lastPos) / Math.max(dt, 1e-3), 0.2);
    lastPos = st.pos;
    layout(dt);
    renderer.render(scene, camera);
    drawScribble();
  }

  function size() {
    const w = stage.clientWidth, h = stage.clientHeight;
    if (!w || !h) return;
    stageRect = null;
    if (w === stageWidth && h === stageHeight && sc.width) return;
    stageWidth = w; stageHeight = h;
    mobile = w < 760;
    // 像素预算：画布总像素不超过 260 万，超出就降低渲染倍率
    renderer.setPixelRatio(Math.max(0.75, Math.min(devicePixelRatio, 1.5, Math.sqrt(2.6e6 / (w * h)))));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.fov = mobile ? 46 : 40;
    camera.position.z = mobile ? 5.4 : 4.4;
    camera.updateProjectionMatrix();
    const dpr = Math.min(devicePixelRatio, 2);
    sc.width = Math.round(w * dpr); sc.height = Math.round(h * dpr);
    scrib.last = 0; wake();
  }

  // ---------- 手绘圈 ----------
  const scrib = { show: 0, seed: 7, last: 0, drawn: false };
  const vec = new THREE.Vector3();
  function rimPoints(disc) {
    const pts = [];
    disc.updateWorldMatrix(true, false);
    for (let k = 0; k < 64; k++) {
      const a = (k / 64) * Math.PI * 2;
      vec.set(Math.cos(a) * R, Math.sin(a) * R, 0).applyMatrix4(disc.matrixWorld).project(camera);
      pts.push({ x: (vec.x * 0.5 + 0.5) * sc.width, y: (-vec.y * 0.5 + 0.5) * sc.height });
    }
    return pts;
  }
  function drawScribble() {
    if (scrib.show <= 0.001 || detailOpen || !discs[active]) {
      if (scrib.drawn) { sg.clearRect(0, 0, sc.width, sc.height); scrib.drawn = false; }
      return;
    }
    const now = performance.now();
    // 自转不改变圆形边缘。稳定悬停时只按手绘圈的 10 Hz 节奏更新；
    // 拖动、俯仰和描线过程中仍逐帧追随光碟。
    const moving = dragging || Math.abs(velocity) > 0.005 || tween?.isActive() || introTween?.isActive() || gsap.isTweening(discs[active].userData.tilt);
    if (!moving && Math.abs(scrib.show - scrib.lastShow) < 0.001 && now - scrib.last < 100) return;
    if (!reduce && now - scrib.last >= 100) scrib.seed = (scrib.seed * 48271) % 2147483647;
    scrib.last = now; scrib.lastShow = scrib.show;
    const pts = scribblePath(rimPoints(discs[active]), scrib.seed);
    sg.clearRect(0, 0, sc.width, sc.height);
    sg.lineWidth = 2.2 * (sc.width / stageWidth);
    sg.lineCap = 'round'; sg.lineJoin = 'round';
    sg.strokeStyle = ink;
    sg.beginPath();
    const upto = Math.max(2, Math.floor(pts.length * scrib.show));
    sg.moveTo(pts[0].x, pts[0].y);
    for (let k = 1; k < upto; k++) {
      const p = pts[k], q = pts[k - 1];
      sg.quadraticCurveTo(q.x, q.y, (p.x + q.x) / 2, (p.y + q.y) / 2);
    }
    sg.stroke();
    scrib.drawn = true;
  }
  let scribTween;
  function setScribble(on) {
    scribTween?.kill();
    scribTween = gsap.to(scrib, { show: on ? 1 : 0, duration: reducedMotion() ? 0 : on ? 0.55 : 0.25, ease: on ? 'lk' : 'power2.in', onUpdate: wake });
  }

  // ---------- 切换 ----------
  function setActive(i) {
    if (i === active || !list[i]) return;
    active = i;
    setScribble(false);
    onActive?.(i);
  }
  function go(i, { duration = 0.95 } = {}) {
    if (!list.length || destroyed) return;
    introTween?.kill();
    st.introDone = true; st.intro = 1;
    i = clamp(Math.round(i), 0, list.length - 1);
    target = i;
    tween?.kill();
    tween = gsap.to(st, { pos: i, duration: reducedMotion() ? 0 : duration, ease: 'lk', onUpdate: wake, onComplete: () => setScribble(hovering && !detailOpen) });
    setActive(i);
    wake();
  }

  // ---------- 输入：拖动、滚轮、键盘、悬停 ----------
  let dragging = false, dragX = 0, moved = 0;
  const pxPerDisc = () => stageWidth * (mobile ? 0.55 : 0.32);
  const bounds = () => stageRect ??= stage.getBoundingClientRect();
  let pendingPointer = null;
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  function hitActive(e) {
    if (!discs[active]) return null;
    const r = bounds();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    return ray.intersectObject(discs[active], true)[0] ?? null;
  }
  const on = (el, type, fn, opts) => { el.addEventListener(type, fn, opts); cleanups.push(() => el.removeEventListener(type, fn, opts)); };
  const cleanups = [];
  on(stage, 'pointerdown', (e) => {
    if (detailOpen || e.button > 0 || !list.length) return;
    introTween?.kill(); st.introDone = true; st.intro = 1; stageRect = null;
    pendingPointer = null;
    dragging = true; moved = 0; dragX = e.clientX;
    stage.setPointerCapture(e.pointerId);
    tween?.kill();
    if (hitActive(e)) gsap.to(st, { press: 1, duration: 0.18, ease: 'power2.out', overwrite: 'auto', onUpdate: wake });
  });
  on(stage, 'pointermove', (e) => {
    if (dragging) {
      const dx = e.clientX - dragX; dragX = e.clientX; moved += Math.abs(dx);
      st.pos = clamp(st.pos - dx / pxPerDisc(), -0.4, list.length - 0.6);
      if (moved > 6) setActive(clamp(Math.round(st.pos), 0, list.length - 1));
      wake();
      return;
    }
    if (detailOpen || !hoverQuery.matches) return;
    // 高频鼠标事件只保留最新位置；一帧最多拾取、更新一次。
    pendingPointer = { clientX: e.clientX, clientY: e.clientY }; wake();
  });
  function updateHover(e) {
    if (detailOpen) return;
    const hit = hitActive(e);
    if (!!hit !== hovering) { hovering = !!hit; setScribble(hovering); stage.style.cursor = hovering ? 'pointer' : ''; }
    if (reducedMotion() || !discs[active]) return;
    // 悬停时这张盘朝指针方向轻轻偏一点（只动 3D 物体）
    const r = bounds();
    gsap.to(discs[active].userData.tilt, {
      x: hit ? ((e.clientY - r.top) / r.height - 0.5) * -0.35 : 0,
      y: hit ? ((e.clientX - r.left) / r.width - 0.5) * 0.35 : 0,
      duration: 0.6, ease: 'lk', overwrite: true, onUpdate: wake,
    });
  }
  const release = (e) => {
    if (!dragging) return;
    dragging = false;
    gsap.to(st, { press: 0, duration: 0.35, ease: 'lk', overwrite: 'auto', onUpdate: wake });
    if (e.type === 'pointercancel') { go(st.pos); return; }
    if (moved < 6) {
      if (hitActive(e)) { onOpen?.(active); return; }
      go(st.pos);
      return;
    }
    go(st.pos + clamp(velocity * 0.18, -2, 2));
  };
  on(stage, 'pointerup', release);
  on(stage, 'pointercancel', release);
  on(stage, 'pointerleave', () => {
    pendingPointer = null;
    if (hovering) { hovering = false; setScribble(false); stage.style.cursor = ''; }
    if (discs[active]) gsap.to(discs[active].userData.tilt, { x: 0, y: 0, duration: 0.6, ease: 'lk', onUpdate: wake });
  });
  // 滚轮：一次推一张，推到头就停（整个页面本来不滚动）
  let wheelAcc = 0, wheelLock = 0;
  on(stage, 'wheel', (e) => {
    if (detailOpen) return;
    e.preventDefault();
    const now = performance.now();
    wheelAcc += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (now > wheelLock && Math.abs(wheelAcc) > 40) {
      go(target + Math.sign(wheelAcc));
      wheelAcc = 0; wheelLock = now + 420;
    }
  }, { passive: false });
  on(stage, 'keydown', (e) => {
    if (detailOpen) return;
    if (e.key === 'ArrowRight') { go(target + 1); e.preventDefault(); }
    else if (e.key === 'ArrowLeft') { go(target - 1); e.preventDefault(); }
    else if (e.key === 'Home') { go(0); e.preventDefault(); }
    else if (e.key === 'End') { go(list.length - 1); e.preventDefault(); }
    else if (e.key === 'Enter') { onOpen?.(active); e.preventDefault(); }
  });
  // 只有键盘聚焦时画圈；点击带来的聚焦不画
  on(stage, 'focus', () => { if (stage.matches(':focus-visible') && !detailOpen) setScribble(true); });
  on(stage, 'blur', () => { if (!hovering) setScribble(false); });

  // ---------- 渲染循环：可见时保留慢自转，隐藏/离屏即停 ----------
  let idleUntil = 0;
  function stop() { gsap.ticker.remove(frame); running = false; }
  function wake() {
    idleUntil = performance.now() + 1500;
    if (destroyed || document.hidden || !visible) return;
    scheduleArt();
    if (!running) { running = true; gsap.ticker.add(frame); }
  }
  const io = new IntersectionObserver(([en]) => {
    visible = en.isIntersecting;
    if (visible) { wake(); if (!st.introDone) intro(); }
    else stop();
  }, { threshold: 0.1 });
  io.observe(stage);
  const ro = new ResizeObserver(size);
  ro.observe(stage);
  on(document, 'visibilitychange', () => { if (document.hidden) stop(); else wake(); });
  on(window, 'scroll', () => { stageRect = null; }, { passive: true, capture: true });
  on(reduceQuery, 'change', () => { reduce = reduceQuery.matches; wake(); });
  function refreshInk() {
    ink = getComputedStyle(root).getPropertyValue('--dg-ink').trim() || '#111';
    scrib.last = 0; wake();
  }
  const themeObserver = new MutationObserver(refreshInk);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  on(matchMedia('(prefers-color-scheme: dark)'), 'change', refreshInk);
  refreshInk();

  // 进场：一摞光碟从远处滑过来，越来越慢，停在第一张
  function intro() {
    st.introDone = true;
    if (reducedMotion()) { st.pos = target; st.intro = 1; wake(); return; }
    introTween = gsap.timeline({ onUpdate: wake })
      .fromTo(st, { intro: 0 }, { intro: 1, duration: 1.1, ease: 'lk' }, 0)
      .fromTo(st, { pos: target - 6 }, { pos: target, duration: 1.9, ease: 'expo.out' }, 0.1)
      .add(() => setScribble(true), 1.5)
      .add(() => { if (!hovering && !stage.matches(':focus-visible')) setScribble(false); }, 3.2);
  }

  const api = {
    get active() { return active; },
    get length() { return list.length; },
    go,
    setItems(next) {
      tween?.kill(); introTween?.kill();
      dragging = false; pendingPointer = null;
      discs.forEach(parkDisc);
      list = next.slice();
      discs = list.map(makeDisc);
      const stale = [...parked].sort(([, a], [, b]) =>
        Number(a.userData.artReady) - Number(b.userData.artReady) || (a.userData.artUsed || 0) - (b.userData.artUsed || 0));
      for (const [id, disc] of stale) {
        if (parked.size <= 16) break;
        parked.delete(id); disposeDisc(disc);
      }
      trimArt();
      active = clamp(active, 0, Math.max(0, list.length - 1));
      target = active;
      if (st.introDone) { st.pos = active; st.intro = 1; }
      lastPos = st.pos; velocity = 0;
      wake();
    },
    append(more) {
      const start = list.length;
      list.push(...more);
      discs.push(...more.map((d, k) => makeDisc(d, start + k)));
      wake();
    },
    // 移除一张（不感兴趣）：盘向下沉走，后面的补上来
    remove(i) {
      const disc = discs[i];
      if (!disc || disc.userData.removal) return;
      const finish = () => {
        const current = discs.indexOf(disc);
        if (current < 0 || destroyed) return;
        disposeDisc(disc);
        discs.splice(current, 1); list.splice(current, 1);
        st.pos = Math.min(st.pos, Math.max(0, list.length - 1));
        active = -1;
        if (list.length) go(clamp(current, 0, list.length - 1), { duration: 0.6 });
        else { active = target = 0; st.pos = 0; wake(); }
      };
      if (reducedMotion()) return finish();
      // 动画写入独立状态，避免每帧 layout 覆盖下沉与缩小效果。
      gsap.to(disc.userData, { removal: 1, duration: 0.45, ease: 'power2.in', onUpdate: wake, onComplete: finish });
    },
    setOpen(open) {
      detailOpen = open;
      openTween?.kill();
      if (open) {
        introTween?.kill(); st.introDone = true; st.intro = 1;
        // 入场/切盘途中也能点开；位置继续靠拢当前盘，返回不会留在半途。
        if (Math.abs(st.pos - active) > 0.001) go(active, { duration: 0.4 });
        setScribble(false);
      }
      return openTween = gsap.to(st, { open: open ? 1 : 0, duration: reducedMotion() ? 0 : open ? 0.75 : 0.8, ease: open ? 'lk-main' : 'lk', onUpdate: wake });
    },
    focus() { stage.focus({ preventScroll: true }); },
    destroy() {
      destroyed = true;
      stop();
      tween?.kill(); introTween?.kill(); openTween?.kill(); scribTween?.kill();
      gsap.killTweensOf(st);
      if (artTask != null) { if (window.cancelIdleCallback) cancelIdleCallback(artTask); else clearTimeout(artTask); }
      artJobs.clear();
      printer.dispose();
      io.disconnect(); ro.disconnect(); themeObserver.disconnect();
      cleanups.forEach((f) => f());
      discs.forEach(disposeDisc);
      parked.forEach(disposeDisc); parked.clear();
      placeholder.dispose(); grooves.dispose(); environment.dispose();
      Object.values(geo).forEach((g) => g.dispose());
      Object.values(mats).forEach((m) => m.dispose());
      renderer.dispose();
    },
  };
  api.setItems(items);
  size();
  return api;
}
