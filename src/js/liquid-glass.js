// 液态玻璃：照 Lens（MIT，github.com/ruiqichenbiec/design-systems/tree/main/lens）的斜面折射做成 SVG 位移滤镜。
// Lens 用 WebGL 折射背景；网页拿不到身后页面的像素，所以交给浏览器的 backdrop-filter: url(#滤镜)：
// 圆角矩形的有向距离场 → 边缘 bevel 宽的一圈斜面上，沿法线把背景往里“吸”（越靠边越强，曲线同 Lens：edge^1.65 × 0.94），中间平整只磨砂。
// 位移图只烘 1/4 分辨率（斜面本来就平滑，滤镜会插值放大），一张不到 1 毫秒；高光和暗边由 CSS 画，不再烘图。
// 目前只有 Chromium 支持 backdrop-filter 引用 SVG 滤镜；其他浏览器、或系统要求“降低透明度”时，保持磨砂玻璃。

const NS = 'http://www.w3.org/2000/svg';
const SCALE = 0.25;
let defs = null;
let serial = 0;

export function liquidSupported() {
  try {
    return 'userAgentData' in navigator
      && !matchMedia('(prefers-reduced-transparency: reduce)').matches
      && CSS.supports('backdrop-filter', 'url(#lk) blur(2px)');
  } catch {
    return false;
  }
}

// 圆角矩形（p 相对中心）：返回 [有向距离（里面为负）, 法线 x, 法线 y]
function sdf(px, py, hw, hh, r) {
  const qx = Math.abs(px) - hw + r, qy = Math.abs(py) - hh + r;
  let d, nx, ny;
  if (qx > 0 && qy > 0) {
    const l = Math.hypot(qx, qy);
    d = l - r; nx = qx / l; ny = qy / l;
  } else if (qx > qy) {
    d = qx - r; nx = 1; ny = 0;
  } else {
    d = qy - r; nx = 0; ny = 1;
  }
  return [d, px < 0 ? -nx : nx, py < 0 ? -ny : ny];
}

// 位移图：R/G 存 x/y 位移，128 为不动
function bake(w, h, radius, bevel) {
  const W = Math.max(2, Math.round(w * SCALE)), H = Math.max(2, Math.round(h * SCALE));
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(W, H);
  const hw = w / 2, hh = h / 2, r = Math.min(radius, hw, hh);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const [d, nx, ny] = sdf((i + 0.5) / SCALE - hw, (j + 0.5) / SCALE - hh, hw, hh, r);
      const edge = d > 0 ? 0 : Math.min(1, Math.max(0, 1 + d / bevel));
      const slope = Math.pow(edge, 1.65) * 0.94;
      const k = (j * W + i) * 4;
      img.data[k] = 128 - nx * slope * 127;
      img.data[k + 1] = 128 - ny * slope * 127;
      img.data[k + 2] = 128;
      img.data[k + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL();
}

function filter(id, w, h, map, strength) {
  if (!defs) {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('aria-hidden', 'true');
    svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
    defs = document.createElementNS(NS, 'defs');
    svg.append(defs);
    document.body.append(svg);
  }
  let f = defs.querySelector(`#${id}`);
  if (!f) {
    f = document.createElementNS(NS, 'filter');
    f.id = id;
    defs.append(f);
  }
  for (const [k, v] of Object.entries({ x: 0, y: 0, width: w, height: h, filterUnits: 'userSpaceOnUse', primitiveUnits: 'userSpaceOnUse', 'color-interpolation-filters': 'sRGB' }))
    f.setAttribute(k, v);
  f.innerHTML = `<feImage href="${map}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="none" result="map"/><feDisplacementMap in="SourceGraphic" in2="map" scale="${(strength * 2).toFixed(1)}" xChannelSelector="R" yChannelSelector="G"/>`;
}

/**
 * 给元素装上液态玻璃：元素的 backdrop-filter 里用 var(--lg-filter)。
 * size 可以提前给（元素还没显示时，在空闲时间先烘好）；之后尺寸变了自动重烘。返回 { off }，掉帧时退回磨砂。
 */
export function liquid(el, { bevel = 20, strength = 18, size = null } = {}) {
  if (!el || !liquidSupported()) return null;
  const id = `lk-glass-${++serial}`;
  let w = 0, h = 0, frame = 0, dead = false;
  const build = (nw = el.offsetWidth, nh = el.offsetHeight) => {
    if (dead || !nw || !nh || (nw === w && nh === h)) return;
    w = nw; h = nh;
    const radius = Math.min(parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0, w / 2, h / 2);
    filter(id, w, h, bake(w, h, radius, Math.min(bevel, w / 2, h / 2)), strength);
    el.style.setProperty('--lg-filter', `url(#${id})`);
    el.classList.add('is-liquid');
  };
  if (size) build(Math.round(size.width), Math.round(size.height));
  else build();
  const ro = new ResizeObserver(() => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => build());
  });
  ro.observe(el);
  const off = () => {
    dead = true;
    ro.disconnect();
    cancelAnimationFrame(frame);
    el.classList.remove('is-liquid');
    el.style.removeProperty('--lg-filter');
    defs?.querySelector(`#${id}`)?.remove();
  };
  return { off };
}
