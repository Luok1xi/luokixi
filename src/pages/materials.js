// 资料：Apple Store 式的资料商店。搜索、按学科逛、一份份放进资料袋，最后在浏览器里打包成 ZIP。
// 目录与打包逻辑沿用 Codex v0.3：本机资料服务 → 公共目录 → 已审核的公开投稿；资料袋存在本浏览器。
// 版式（Opus）：两段式大标题、带图标的学科行、单列白卡片、放入资料袋时缩略图沿弧线飞进右上角的资料袋。
import { initShell, reducedMotion } from '../js/shell.js';
import { hubApi, hubState, loginURL } from '../js/hub.js';
import { esc } from '../js/data.js';
import { buildMaterialZip } from '../js/material-bag.js';
import { mountArt } from '../js/art.js';
import { BAG_KEY, BAG_LIMIT, readBag, loadMaterials, yearKey } from '../js/materials-catalog.js';
import '../styles/product-forms.css';
import '../styles/market.css';

initShell();

const $ = (s) => document.querySelector(s);

let all = [];
let filtered = [];
let subject = '';
let limit = 24;
let busy = false;
let controller = null;

let bag = readBag();

// 学科：[匹配词, 显示名, 图标]。图标是 SF Symbols 式的线稿，Codex 的商品图登记后（mat-<key>）会替换
const ICON = {
  all: '<path d="M4 6.5h16M4 12h16M4 17.5h10"/>',
  cet: '<path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="3" y="13" width="4" height="7" rx="1.6"/><rect x="17" y="13" width="4" height="7" rx="1.6"/>',
  calc: '<path d="M14.5 4.5c-1.6-.9-3.2.2-3.5 2l-1.9 11c-.3 1.8-1.9 2.9-3.5 2"/><path d="M7.5 11h7"/>',
  linalg: '<rect x="4" y="4" width="16" height="16" rx="2.5"/><path d="M9.5 4v16M14.5 4v16M4 9.5h16M4 14.5h16"/>',
  physics: '<circle cx="12" cy="12" r="1.6"/><ellipse cx="12" cy="12" rx="9" ry="3.6"/><ellipse cx="12" cy="12" rx="9" ry="3.6" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="9" ry="3.6" transform="rotate(-60 12 12)"/>',
  chem: '<path d="M9.5 3.5h5M10.5 3.5v6L5 19a1.2 1.2 0 0 0 1 1.8h12a1.2 1.2 0 0 0 1-1.8l-5.5-9.5v-6"/><path d="M7.4 15h9.2"/>',
  code: '<path d="m8.5 8-4.5 4 4.5 4M15.5 8l4.5 4-4.5 4M13.5 5.5l-3 13"/>',
  mech: '<circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8"/>',
  ielts: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.6 2.4 2.6 14.6 0 17M12 3.5c-2.6 2.4-2.6 14.6 0 17"/>',
};
const SUBJECTS = [
  ['', '全部资料', 'all', 211],
  ['英语四级', '英语四级', 'cet', 4],
  ['英语六级', '英语六级', 'cet', 330],
  ['高等数学', '高等数学', 'calc', 262],
  ['线性代数', '线性代数', 'linalg', 192],
  ['大学物理', '大学物理', 'physics', 28],
  ['大学化学', '大学化学', 'chem', 150],
  ['计算机', '计算机与编程', 'code', 222],
  ['机械', '机械与控制', 'mech', 18],
  ['雅思', '雅思', 'ielts', 300],
];
const symbol = (key) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON[key] ?? ICON.all}</svg>`;
const BAG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.5 8h13l-1 12.5h-11z"/><path d="M9 8V6.5a3 3 0 0 1 6 0V8"/></svg>';

const inBag = (x) => bag.some((b) => b.url === x.url);

function saveBag() {
  try { localStorage.setItem(BAG_KEY, JSON.stringify(bag)); } catch {
    $('#bag-status').textContent = '浏览器未允许保存，关闭页面后资料袋可能丢失。';
  }
  $('#bag-count').textContent = bag.length;
  $('#bag-dock-count').textContent = bag.length;
  $('#bag-dock-summary').textContent = bag.length ? `已选 ${bag.length} 份 · 点“去打包”一次下载` : '点资料右边的“＋”，一份份放进来';
  document.querySelector('.mt-bagbar')?.classList.toggle('has-items', bag.length > 0);
  $('#bag-dock-open').disabled = !bag.length;
  $('#bag-download').disabled = !bag.length || busy;
}

// 缩略图沿一条弧线飞进右上角的资料袋，资料袋跳一下（只动 transform 和 opacity）
function flyToBag(from) {
  const target = $('#bag-open');
  if (!from || !target || reducedMotion()) return;
  const a = from.getBoundingClientRect();
  const b = target.getBoundingClientRect();
  if (!a.width || !b.width) return;
  const ghost = from.cloneNode(true);
  ghost.classList.add('mt-ghost');
  Object.assign(ghost.style, { left: `${a.left}px`, top: `${a.top}px`, width: `${a.width}px`, height: `${a.height}px` });
  document.body.append(ghost);
  setTimeout(() => ghost.remove(), 1500); // 页面在后台时动画会被挂起，兜底清掉
  const dx = b.left + b.width / 2 - (a.left + a.width / 2);
  const dy = b.top + b.height / 2 - (a.top + a.height / 2);
  const lift = Math.min(160, Math.abs(dx) * 0.25 + 60);
  ghost.animate(
    [
      { transform: 'translate(0, 0) scale(1) rotate(0deg)', opacity: 1 },
      { transform: `translate(${dx * 0.45}px, ${dy * 0.45 - lift}px) scale(0.62) rotate(-8deg)`, opacity: 1, offset: 0.45 },
      { transform: `translate(${dx}px, ${dy}px) scale(0.14) rotate(-14deg)`, opacity: 0.2 },
    ],
    { duration: 720, easing: 'cubic-bezier(0.45, 0, 0.25, 1)' },
  ).finished.then(() => {
    ghost.remove();
    target.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.18)' }, { transform: 'scale(1)' }], { duration: 420, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' });
  });
}

function add(item, button) {
  if (!item) return;
  if (inBag(item)) {
    bag = bag.filter((x) => x.url !== item.url);
  } else {
    if (bag.length >= BAG_LIMIT) {
      $('#library-status').textContent = `资料袋已放入 ${BAG_LIMIT} 份，请先打包这一批。`;
      return;
    }
    bag.push(item);
    flyToBag(button?.closest('.mt-row')?.querySelector('.mt-doc'));
  }
  saveBag();
  renderList();
  renderBag();
}

// 文件图标：像访达里的文档图标，右上角折角，底部写格式
const doc = (x) => `<span class="mt-doc" data-format="${esc(x.format)}"><span class="mt-doc-page"><i></i><i></i><i></i><i class="is-short"></i></span><b>${esc(String(x.format || '').toUpperCase() || 'FILE')}</b></span>`;

function row(x) {
  const on = inBag(x);
  return `<article class="mt-row ap-card">
    ${doc(x)}
    <div class="mt-info">
      <p class="mt-kicker">${esc(x.course)} · ${esc(x.kind)}${x.year ? ` · ${esc(x.year)}` : ''}</p>
      <h3 class="mt-title">${esc(x.title)}</h3>
      <p class="mt-meta">${esc(x.pages ? `${x.pages} 页 · ` : '')}${esc(x.note || '请以原文件为准')}</p>
      <p class="mt-rights">${esc(x.rights || '')}</p>
    </div>
    <div class="mt-actions">
      <a class="ap-more" href="${esc(x.url)}" target="_blank" rel="noopener">${x.external ? '前往原站' : '预览'}</a>
      ${x.external
        ? '<span class="mt-note">仅原站链接，不能打包</span>'
        : `<button class="mt-add${on ? ' is-on' : ''}" type="button" data-add="${esc(x.id)}" aria-pressed="${on}" aria-label="${on ? '从资料袋拿出' : '放进资料袋'}：${esc(x.title)}"><span aria-hidden="true">${on ? '✓' : '＋'}</span><em>${on ? '已放入' : '放入资料袋'}</em></button>`}
    </div>
  </article>`;
}

function renderList() {
  const focused = document.activeElement?.dataset?.add;
  const q = $('#library-q').value.trim().toLowerCase().replaceAll('线代', '线性代数').replaceAll('高数', '高等数学').replaceAll('大物', '大学物理');
  const kind = $('#library-kind').value;
  const year = $('#library-year').value;
  const sort = $('#library-sort').value;
  filtered = all.filter((x) => (!subject || x.course.includes(subject))
    && (!q || q.split(/\s+/).every((w) => `${x.title} ${x.course} ${x.year} ${x.kind}`.toLowerCase().includes(w)))
    && (!kind || `${x.kind} ${x.title}`.includes(kind))
    && (!year || x.year === year));
  if (sort === 'new') filtered.sort((a, b) => yearKey(b) - yearKey(a));
  if (sort === 'old') filtered.sort((a, b) => yearKey(a) - yearKey(b));
  if (sort === 'pages') filtered.sort((a, b) => (b.pages ?? 0) - (a.pages ?? 0));
  $('#library-heading').textContent = SUBJECTS.find((x) => x[0] === subject)?.[1] || '全校资料库';
  $('#library-count').textContent = `${filtered.length} 份实际文件。`;
  $('#library-subjects').innerHTML = SUBJECTS.map(([id, name, icon, h]) => {
    const n = all.filter((x) => !id || x.course.includes(id)).length;
    return `<button class="mt-rail-item" type="button" data-subject="${id}" aria-pressed="${id === subject}" style="--h:${h}">
      <span class="mt-rail-icon" data-art="mat-${icon}">${symbol(icon)}</span>
      <span class="mt-rail-name">${name}</span><span class="mt-rail-n num">${n}</span>
    </button>`;
  }).join('');
  $('#library-list').innerHTML = filtered.length
    ? filtered.slice(0, limit).map(row).join('')
    : `<div class="ap-empty"><b>这一格，等你来补充。</b><p>当前没有符合条件的文件。换个关键词，或者分享这门课的第一份资料。</p><button class="btn btn-primary" type="button" data-upload>分享资料</button></div>`;
  $('#library-more').hidden = filtered.length <= limit;
  mountArt($('#library-subjects'));
  if (focused) document.querySelector(`[data-add="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
}

function renderBag() {
  $('#bag-list').innerHTML = bag.length
    ? `<ul class="ap-list">${bag.map((x) => `<li class="ap-row mt-bag-row">${doc(x)}
        <span class="ap-row-text"><b>${esc(x.title)}</b><span>${esc(x.course)} · ${esc(String(x.format || '').toUpperCase())}</span></span>
        <button class="mt-remove" type="button" data-remove="${esc(x.id)}" aria-label="移除 ${esc(x.title)}" ${busy ? 'disabled' : ''}>移除</button></li>`).join('')}</ul>`
    : `<div class="ap-empty mt-bag-empty"><span class="mt-bag-empty-icon">${BAG}</span><b>资料袋还是空的。</b><p>把需要的试卷、答案和笔记，一份份放进来。</p></div>`;
  saveBag();
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-add],[data-remove],[data-subject],[data-upload],[data-close]');
  if (!b) return;
  if (b.hasAttribute('data-close')) b.closest('dialog').close();
  if (b.hasAttribute('data-add')) add(all.find((x) => x.id === b.dataset.add), b);
  if (b.hasAttribute('data-remove') && !busy) {
    bag = bag.filter((x) => x.id !== b.dataset.remove);
    renderBag();
    renderList();
  }
  if (b.hasAttribute('data-subject')) {
    subject = b.dataset.subject;
    limit = 24;
    renderList();
  }
  if (b.hasAttribute('data-upload')) openUpload();
});

// 点对话框外面的遮罩也能关上
document.querySelectorAll('dialog.mt-sheet').forEach((d) => d.addEventListener('click', (e) => e.target === d && !busy && d.close()));

$('#library-search').onsubmit = (e) => {
  e.preventDefault();
  limit = 24;
  renderList();
};
let debounce;
$('#library-q').oninput = () => {
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    limit = 24;
    renderList();
  }, 130);
};
['#library-kind', '#library-year', '#library-sort'].forEach((id) => ($(id).onchange = () => {
  limit = 24;
  renderList();
}));
$('#library-more').onclick = () => {
  limit += 24;
  renderList();
};

const openBag = () => {
  renderBag();
  $('#bag-dialog').showModal();
};
$('#bag-dock-open').onclick = openBag;
$('#bag-open').onclick = openBag;
$('#bag-clear').onclick = () => {
  if (!busy) {
    bag = [];
    renderBag();
    renderList();
  }
};

$('#bag-cancel').onclick = () => controller?.abort();
$('#bag-download').onclick = async () => {
  if (busy) return;
  busy = true;
  controller = new AbortController();
  $('#bag-status').textContent = '正在读取所选原文件…';
  $('#bag-cancel').hidden = false;
  $('#bag-clear').disabled = true;
  $('#bag-progress').hidden = false;
  renderBag();
  try {
    const result = await buildMaterialZip([...bag], {
      signal: controller.signal,
      onProgress: (s) => {
        $('#bag-progress').max = s.total;
        $('#bag-progress').value = s.done;
        $('#bag-status').textContent = `正在打包 ${s.done}/${s.total} · ${(s.bytes / 1048576).toFixed(1)} MB`;
      },
    });
    const url = URL.createObjectURL(new Blob([result], { type: 'application/zip' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `Luokixi-资料袋-${new Date().toISOString().slice(0, 10)}.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    $('#bag-status').textContent = '打包完成，已交给浏览器下载。来源清单已附在 ZIP 内。';
  } catch (e) {
    $('#bag-status').textContent = e.name === 'AbortError' ? '已取消，资料仍保留在袋中。' : e.message;
  } finally {
    busy = false;
    $('#bag-cancel').hidden = true;
    $('#bag-clear').disabled = false;
    $('#bag-progress').hidden = true;
    renderBag();
  }
};

// ---------- 上传资料：拖入文件 → 按文件名自动填好 → 补来源与许可 → 提交审核 ----------

const KINDS = ['试卷', '答案', '笔记', '课件', '实验', '其他'];
const MAX_FILES = 10;
const MAX_BYTES = 25 * 1024 * 1024;
let picked = [];
let kindPicked = '试卷';
let uploadUser = null;

const fmtSize = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

// 从文件名猜课程、年份和类型，只填空着的格子，用户随时可以改
function guess(name) {
  const base = name.replace(/\.[^.]+$/, '').replace(/(20\d{2})\s*[-_–—]\s*(20\d{2})/, '$1–$2').replace(/[_-]+/g, ' ').trim();
  const course = SUBJECTS.find(([id]) => id && base.includes(id))?.[0]
    || all.map((x) => x.course).find((c) => c && base.includes(c))
    || (/线代/.test(base) ? '线性代数' : /高数/.test(base) ? '高等数学' : /大物/.test(base) ? '大学物理' : '');
  const range = base.match(/(20\d{2})\s*[–—-]\s*(20\d{2})/);
  const year = range ? `${range[1]}–${range[2]}` : base.match(/20\d{2}/)?.[0] ?? '';
  const term = /上学期|第一学期|秋/.test(base) ? ' 上学期' : /下学期|第二学期|春/.test(base) ? ' 下学期' : '';
  const kind = /答案|解析|评分/.test(base) ? '答案' : /笔记|整理/.test(base) ? '笔记' : /课件|讲义|ppt/i.test(base) ? '课件' : /实验|报告/.test(base) ? '实验' : /试卷|期末|期中|月考|真题|[AB]卷/.test(base) ? '试卷' : '';
  return { title: base, course, year: year ? year + term : '', kind };
}

function renderKinds() {
  $('#upload-kinds').innerHTML = KINDS.map((k) => `<button type="button" class="mt-chip" data-kind="${k}" aria-pressed="${k === kindPicked}">${k}</button>`).join('');
}

function renderFiles() {
  $('#upload-files').innerHTML = picked.map((p, i) => `<li class="mt-file is-${p.state}">
    <span class="td-fmt" data-format="${esc(p.ext)}">${esc(p.ext.toUpperCase() || 'FILE')}</span>
    <span class="mt-file-text"><b>${esc(p.file.name)}</b><small>${fmtSize(p.file.size)}${p.state === 'uploading' ? ' · 正在上传…' : p.state === 'done' ? ' · 已上传' : p.state === 'error' ? ` · ${esc(p.error)}` : ''}</small></span>
    ${p.state === 'idle' || p.state === 'error' ? `<button type="button" class="mt-remove" data-file-x="${i}">移除</button>` : ''}
  </li>`).join('');
  $('#upload-drop').classList.toggle('has-files', picked.length > 0);
}

function addFiles(list) {
  const msg = [];
  for (const file of list) {
    if (picked.length >= MAX_FILES) { msg.push(`一次最多 ${MAX_FILES} 份。`); break; }
    if (file.size > MAX_BYTES) { msg.push(`${file.name} 超过 25 MB。`); continue; }
    if (picked.some((p) => p.file.name === file.name && p.file.size === file.size)) continue;
    picked.push({ file, ext: (file.name.split('.').pop() || '').toLowerCase(), state: 'idle' });
  }
  const f = $('#upload-form').elements;
  const g = guess(picked[0]?.file.name ?? '');
  if (!f.title.value && g.title) f.title.value = g.title;
  if (!f.course.value && g.course) f.course.value = g.course;
  if (!f.year.value && g.year) f.year.value = g.year;
  if (g.kind) { kindPicked = g.kind; renderKinds(); }
  $('#upload-status').textContent = msg.join(' ');
  renderFiles();
}

async function openUpload() {
  const s = await hubState();
  uploadUser = s.user;
  const gate = $('#upload-gate');
  const form = $('#upload-form');
  let html = '';
  if (!s.online) html = '<div class="ap-empty mt-gate"><b>上传需要社区服务。</b><p>现在打开的是只读的静态页面。连接社区服务后，登录就能上传。</p></div>';
  else if (!s.user) html = `<div class="ap-empty mt-gate"><b>登录之后就能上传。</b><p>投稿记在你的账号下，审核结果会通知你。</p><a class="btn btn-primary" href="${esc(loginURL())}">登录或注册</a></div>`;
  else if (!s.user.emailVerified) html = '<div class="ap-empty mt-gate"><b>先验证邮箱。</b><p>验证之后才能上传文件和提交审核。</p><a class="btn btn-primary" href="me.html#account">去验证</a></div>';
  gate.innerHTML = html;
  form.hidden = Boolean(html);
  $('#upload-courses').innerHTML = [...new Set([...SUBJECTS.map(([id]) => id).filter(Boolean), ...all.map((x) => x.course)])].map((c) => `<option value="${esc(c)}">`).join('');
  renderKinds();
  renderFiles();
  $('#upload-dialog').showModal();
}

$('#upload-open').onclick = openUpload;
$('#upload-form').elements.files.addEventListener('change', (e) => {
  addFiles([...e.target.files]);
  e.target.value = '';
});
const drop = $('#upload-drop');
['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('is-over'); }));
['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, () => drop.classList.remove('is-over')));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  addFiles([...(e.dataTransfer?.files ?? [])]);
});
$('#upload-dialog').addEventListener('click', (e) => {
  const k = e.target.closest('[data-kind]');
  if (k) { kindPicked = k.dataset.kind; renderKinds(); }
  const x = e.target.closest('[data-file-x]');
  if (x) { picked.splice(Number(x.dataset.fileX), 1); renderFiles(); }
});

$('#upload-form').onsubmit = async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const button = form.querySelector('[type=submit]');
  const v = Object.fromEntries(new FormData(form));
  const linkOnly = v.license === '仅提供原链接，不上传文件';
  const draftOnly = v.license === '许可待核';
  const problems = [];
  if (!v.title.trim()) problems.push('写一个资料名称');
  if (!v.course.trim()) problems.push('填课程');
  if (!v.year.trim()) problems.push('填年份或学期');
  if (!v.summary.trim()) problems.push('写一句说明');
  if (!v.credit.trim()) problems.push('写原作者与来源');
  if (linkOnly && !v.source) problems.push('只给链接时要填原始来源链接');
  if (!linkOnly && !picked.length) problems.push('至少选一份文件');
  if (!draftOnly && !form.elements.rights.checked) problems.push('勾选确认有权分享');
  if (problems.length) {
    $('#upload-status').textContent = `还差：${problems.join('、')}。`;
    return;
  }
  button.disabled = true;
  try {
    const uploads = [];
    if (!linkOnly)
      for (const p of picked) {
        if (p.state === 'done') { uploads.push(p.id); continue; }
        p.state = 'uploading';
        renderFiles();
        try {
          const u = await hubApi.upload(p.file);
          Object.assign(p, { state: 'done', id: u.id });
          uploads.push(u.id);
        } catch (err) {
          Object.assign(p, { state: 'error', error: err.message });
          renderFiles();
          throw new Error(`“${p.file.name}”没有传上去：${err.message}`);
        }
        renderFiles();
      }
    const entry = await hubApi.create('resource', {
      title: v.title.trim(), course: v.course.trim(), year: v.year.trim(), summary: v.summary.trim(), credit: v.credit.trim(), sourceNote: v.credit.trim(),
      license: v.license, uploads, tags: [kindPicked], rightsConfirmed: form.elements.rights.checked, links: v.source ? { source: v.source } : {},
    });
    if (draftOnly) {
      $('#upload-status').innerHTML = '许可还没核对，已经存成草稿。<a href="me.html#entries">到我的投稿里补充 →</a>';
    } else {
      await hubApi.submit(entry.id, entry.editRevision);
      $('#upload-status').innerHTML = '已提交审核，通过后会出现在资料库里。<a href="me.html#entries">查看进度 →</a>';
    }
    form.reset();
    picked = [];
    renderFiles();
  } catch (err) {
    $('#upload-status').textContent = err.message;
  } finally {
    button.disabled = false;
  }
};

async function init() {
  saveBag();
  // 全站搜索、首页带着关键词过来时，直接填进搜索框
  const q0 = new URLSearchParams(location.search).get('q');
  if (q0) $('#library-q').value = q0;
  const { items, notes } = await loadMaterials();
  all = items;
  $('#library-status').textContent = notes.join(' ');
  const years = [...new Set(all.map((x) => x.year).filter(Boolean))].sort().reverse();
  $('#library-year').insertAdjacentHTML('beforeend', years.map((y) => `<option>${esc(y)}</option>`).join(''));
  renderList();
  const qs = new URLSearchParams(location.search);
  if (qs.has('upload')) openUpload();
  if (qs.has('bag')) openBag();
}

init().catch((e) => {
  $('#library-status').textContent = e.message;
  $('#library-count').textContent = '目录读取失败。';
  $('#library-list').innerHTML = '<div class="ap-empty"><b>目录没有读出来。</b><p>请刷新重试，或者先从旧版资料页继续浏览。</p><a class="ap-more" href="school.html">校内资料</a></div>';
});
