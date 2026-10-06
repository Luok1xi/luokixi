// 美术图的“插槽”：页面里写 <div data-art="today-exam">，Codex 交付、Opus 审过并登记进
// public/art/manifest.json（review: "approved"）之后，这里把图放进去并淡入；没登记时什么都不做，
// 页面继续显示自己由数据生成的画面。格式见 docs/ART_DIRECTION.md 第七节。
let manifest;

export function artManifest() {
  manifest ??= fetch('art/manifest.json', { cache: 'no-cache' })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => d?.slots ?? {})
    .catch(() => ({}));
  return manifest;
}

const safe = (u) => typeof u === 'string' && /^(?:art\/|\.\/art\/)[\w./-]+\.(?:webp|avif|png|jpg|svg)$/.test(u);
const attr = (s) => String(s ?? '').replace(/[&"<>]/g, (c) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[c]);

function img(src, cls, a) {
  return `<img class="art-img ${cls}" src="${attr(src)}" alt="${attr(a.alt)}" decoding="async" loading="lazy"${a.w ? ` width="${Number(a.w)}" height="${Number(a.h)}"` : ''}${a.focal ? ` style="object-position:${attr(a.focal)}"` : ''}>`;
}

export async function mountArt(scope = document) {
  const slots = await artManifest();
  for (const el of scope.querySelectorAll('[data-art]:not(.has-art)')) {
    const a = slots[el.dataset.art];
    if (!a || a.review !== 'approved' || !safe(a.src)) continue;
    // 只交了一张的按“通用”处理；深浅各一张时由样式表按当前外观二选一（也跟随右上角的手动切换）
    const html = safe(a.srcDark) ? img(a.src, 'is-light', a) + img(a.srcDark, 'is-dark', a) : img(a.src, '', a);
    el.insertAdjacentHTML('afterbegin', `<span class="art-layer">${html}</span>`);
    const first = el.querySelector('.art-img');
    const done = () => el.classList.add('has-art');
    if (first.complete) done();
    else first.addEventListener('load', done, { once: true });
  }
}
