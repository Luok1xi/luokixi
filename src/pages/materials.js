import { fuzzySearch } from '../js/fuzzy-search.js';
import { attachSearchSuggestions } from '../js/search-suggestions.js';
// Document gallery: real catalogue metadata, preview, direct download and browser-local bag.
import { initShell, reducedMotion } from '../js/shell.js';
import { canParticipate, hubApi, hubState, loginURL } from '../js/hub.js';
import { esc } from '../js/data.js';
import { buildMaterialZip } from '../js/material-bag.js';
import { mountShelfMotion, mountHeroBooks, createBookReader, createBagMotion, flyBookToBag, cancelBookTransfer } from '../js/materials-motion.js';
import { groupMaterialBundles } from '../js/materials-bundles.js';
import { BAG_KEY, BAG_LIMIT, readBag, loadMaterials, yearKey } from '../js/materials-catalog.js';
import '../styles/product-forms.css';
import '../styles/market.css';
import '../styles/materials-gallery.css';
import '../styles/learning-gallery.css';

initShell();

const $ = (s) => document.querySelector(s);

let all = [];
let bundles = [];
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

const downloadableFiles = item => (item.files || [item]).filter(file => !file.external && file.url);
const inBag = item => { const files=downloadableFiles(item);return files.length>0&&files.every(file=>bag.some(saved=>saved.url===file.url)); };
const bagSelection = item => downloadableFiles(item).filter(file=>bag.some(saved=>saved.url===file.url)).length;
const findItem = id => bundles.find(item=>item.id===id)||all.find(item=>item.id===id);
const ROLE_NAMES = {paper:'试卷',answer:'答案',audio:'听力',other:'其他'};
const bagLabel = item => { const files=downloadableFiles(item),selected=bagSelection(item);return inBag(item)?(item.files?.length>1?'已收好整册':'已放入资料袋'):selected?`补齐本册（${selected}/${files.length}）`:item.files?.length>1?`整册放入资料袋 · ${files.length}`:'放入资料袋'; };
const bundleDate = item => yearKey(item)*100 + Number(item.groupKey?.split('_')[2] || 0);
const fileCount = items => new Set(items.flatMap(item=>downloadableFiles(item)).map(file=>file.url)).size;

function saveBag() {
  try { localStorage.setItem(BAG_KEY, JSON.stringify(bag)); } catch {
    $('#bag-status').textContent = '浏览器未允许保存，关闭页面后资料袋可能丢失。';
  }
  $('#bag-count').textContent = bag.length;
  $('#bag-dock-count').textContent = bag.length;
  $('#bag-dock-summary').textContent = bag.length ? `已选 ${bag.length} 份 · 点“去打包”一次下载` : '收好需要的资料，一次打包';
  document.querySelector('.mt-bagbar')?.classList.toggle('has-items', bag.length > 0);
  $('#bag-dock-open').disabled = !bag.length;
  $('#bag-download').disabled = !bag.length || busy;
}

function updateBagButtons() {
  document.querySelectorAll('[data-add]').forEach(button => {
    const item=findItem(button.dataset.add);
    if(!item)return;
    const on=inBag(item),selected=bagSelection(item);
    button.classList.toggle('is-on',on);
    button.setAttribute('aria-pressed',on?'true':selected?'mixed':'false');
    button.setAttribute('aria-label',`${on?'从资料袋拿出':'放入资料袋'}：${item.title}`);
    button.querySelector('span').textContent=on?'✓':'＋';
    button.querySelector('em').textContent=bagLabel(item);
  });
  document.querySelectorAll('[data-reader-count]').forEach(el=>el.textContent=bag.length);
}
function add(item, button) {
  if (!item || busy) return;
  const files=downloadableFiles(item);
  if (!files.length) return;
  if (inBag(item)) {
    cancelBookTransfer();
    const urls=new Set(files.map(file=>file.url));
    bag=bag.filter(file=>!urls.has(file.url));
  } else {
    const existing=new Set(bag.map(file=>file.url));
    const missing=files.filter(file=>!existing.has(file.url));
    if (bag.length+missing.length>BAG_LIMIT) {
      const message=`本册还需 ${missing.length} 个位置，资料袋还剩 ${BAG_LIMIT-bag.length} 个。请先打包或移除部分文件。`;
      $('#library-status').textContent=message;
      document.querySelectorAll('[data-reader-status]').forEach(el=>el.textContent=message);
      return;
    }
    bag.push(...missing);
    const reader=button?.closest('.mt-reader');
    const from=reader?.querySelector('.mt-reader-object .mt-book')||button?.closest('.mt-row')?.querySelector('.mt-book');
    flyBookToBag(from,reader?.querySelector('.mt-reader-bag')||$('#bag-open'));
  }
  document.querySelectorAll('[data-reader-status]').forEach(el=>el.textContent=inBag(item)?`已收好 ${files.length} 份文件。`:'已从资料袋取出。');
  saveBag();updateBagButtons();renderBag();
}

// 文件图标：像访达里的文档图标，右上角折角，底部写格式
const doc = (x) => `<span class="mt-doc" data-format="${esc(x.format)}"><span class="mt-doc-page"><i></i><i></i><i></i><i class="is-short"></i></span><b>${esc(String(x.format || '').toUpperCase() || 'FILE')}</b></span>`;

const coverPalette = ['var(--book-blue)','var(--book-violet)','var(--book-green)','var(--book-rust)','var(--book-slate)','var(--book-olive)'];
function cover(x) {
  const index=[...String(x.course)].reduce((n,c)=>n+c.codePointAt(0),0)%coverPalette.length;
  const key=x.coverKey||SUBJECTS.find(([id])=>id&&x.course?.includes(id))?.[2]||'all';
  return `<span class="mt-book" style="--cover-color:${coverPalette[index]}"><span class="mt-book-back"></span><span class="mt-book-pages"></span><span class="mt-book-front"><small>LUOKIXI / ${esc(String(x.isCollection?'COLLECTION':x.format||'FILE').toUpperCase())}</small><strong>${esc(x.course||x.title)}</strong><span class="mt-book-graphic"><i></i><i></i><i></i>${symbol(key)}</span><span class="mt-book-bottom"><span>${esc(x.isSuite?`${x.year}.${x.groupKey.split('_')[2]} · 第${x.groupKey.split('_')[3]}套`:x.year||x.kind||'课程资料')}</span><em>${esc(x.kind||'资料')}</em></span></span></span>`;
}
let galleryMotion;
let heroMotion;
const bagMotion=createBagMotion($('#bag-dialog'),$('#bag-open'));
const bookReader=createBookReader({getItem:findItem,cover,inBag,bagLabel,onBag:()=>openBag()});
function row(x,index) {
  const on=inBag(x),roles=Object.entries(x.roles).filter(([,files])=>files.length);
  const missing=x.missingRoles.map(role=>ROLE_NAMES[role]);
  return `<article class="mt-row" data-index="${index}">
    <div class="mt-cover-stage"><span class="mt-shelf-index" aria-hidden="true">${String(index+1).padStart(2,'0')} / ${String(filtered.length).padStart(2,'0')}</span><span class="mt-shelf-shadow" aria-hidden="true"></span><div class="mt-book-float"><div class="mt-book-tilt"><button type="button" class="mt-book-button" data-book="${esc(x.id)}" aria-label="翻开 ${esc(x.title)}">${cover(x)}<span class="mt-book-hint" aria-hidden="true">点击翻阅 ↗</span></button></div></div></div>
    <div class="mt-info"><p class="mt-kicker">${esc(x.course)} · ${x.isSuite?'真题套卷':esc(x.kind)}${x.year?` · ${esc(x.year)}`:''}</p>
      <h3 class="mt-title"><button class="mt-title-open" type="button" data-book="${esc(x.id)}">${esc(x.title)}</button></h3>
      ${x.schools?.length || x.discipline ? `<p class="mt-meta">${esc([...(x.schools||[]),x.discipline,x.priority].filter(Boolean).join(' · '))}</p>` : ''}
      ${x.paperId ? `<a class="ap-more" href="question-workshop.html?paper=${encodeURIComponent(x.paperId)}">编辑题目与排版 ↗</a>` : x.bankId ? '<a class="ap-more" href="question-workshop.html">到题目工坊编辑 ↗</a>' : ''}
      <div class="mt-suite-contents" aria-label="本册内容">${roles.map(([role,files])=>`<span><i aria-hidden="true">${role==='audio'?'◌':role==='answer'?'↳':'▱'}</i>${ROLE_NAMES[role]}<b>${files.length}</b></span>`).join('')}</div>
      ${x.isSuite?`<p class="mt-meta">${missing.length?`已收录 ${x.fileCount} 份文件 · 尚缺${missing.join('、')}`:`试卷、答案与听力已收齐 · ${x.fileCount} 份文件`}</p>`:x.note?`<p class="mt-meta">${esc(x.note)}</p>`:''}
      <p class="mt-byline"><span>${x.fileCount} ${x.external?'个来源':'份文件'}${x.pages?` · ${esc(x.pages)} 页`:''}</span>${x.uploader?`<span>上传者 ${esc(x.uploader)}</span>`:''}${x.uploadedAt?`<span>收录 ${esc(new Date(x.uploadedAt).toLocaleString('zh-CN'))}</span>`:''}<span>审核：${esc(x.reviewedBy||'历史审核者未记录')}</span>${!x.isCollection&&Number.isFinite(x.stars)?`<span>${x.stars} 人收藏</span>`:''}</p>
      <div class="mt-actions">
        ${downloadableFiles(x).length?`<button class="mt-add${on?' is-on':''}" type="button" data-add="${esc(x.id)}" aria-pressed="${on}" aria-label="${on?'从资料袋拿出':'放入资料袋'}：${esc(x.title)}"><span aria-hidden="true">${on?'✓':'＋'}</span><em>${bagLabel(x)}</em></button>`:`<a class="ap-more" href="${esc(x.url)}" target="_blank" rel="noopener">前往原站 ↗</a>`}
      </div>
    </div></article>`;
}

function renderList() {
  galleryMotion?.();
  const focused = document.activeElement?.dataset?.add;
  const q = $('#library-q').value.trim();
  const kind = $('#library-kind').value;
  const year = $('#library-year').value;
  const sort = $('#library-sort').value;
  const candidates = bundles.filter((x) => (!subject || x.course.includes(subject))
    && (!kind || x.kind===kind || x.files.some(file=>`${file.kind} ${file.title}`.includes(kind)))
    && (!year || x.year === year)
    && (!$('#library-university').value || x.schools?.includes($('#library-university').value))
    && (!$('#library-discipline').value || x.discipline === $('#library-discipline').value)
    && (!$('#library-priority').value || x.priority === $('#library-priority').value));
  filtered = fuzzySearch(candidates, q, { getText: bundleSearchText, limit: Infinity });
  if (sort === 'new') filtered.sort((a, b) => bundleDate(b) - bundleDate(a));
  if (sort === 'old') filtered.sort((a, b) => bundleDate(a) - bundleDate(b));
  if (sort === 'pages') filtered.sort((a, b) => (b.pages ?? 0) - (a.pages ?? 0));
  $('#library-heading').textContent = SUBJECTS.find((x) => x[0] === subject)?.[1] || '全部资料';
  $('#library-count').textContent = `${filtered.length} 册 · ${fileCount(filtered)} 份文件`;
  $('#library-subjects').innerHTML = SUBJECTS.map(([id, name, icon, h]) => {
    const n = bundles.filter((x) => !id || x.course.includes(id)).length;
    return `<button class="mt-rail-item" type="button" data-subject="${id}" aria-pressed="${id === subject}" style="--h:${h}">
      <span class="mt-rail-icon">${symbol(icon)}</span>
      <span class="mt-rail-name">${name}</span><span class="mt-rail-n num">${n}</span>
    </button>`;
  }).join('');
  $('#library-list').innerHTML = filtered.length
    ? filtered.slice(0, limit).map(row).join('')
    : `<div class="ap-empty"><b>没有找到相关资料</b><p>试试其他关键词或分类。</p><button class="btn btn-primary" type="button" data-upload>分享资料</button></div>`;
  $('#library-more').hidden = filtered.length <= limit;
  $('#library-total').textContent = `${bundles.length} 册资料 · ${fileCount(bundles)} 份文件。试卷、答案与听力按套归册。`;
  const coverItems = [...new Map(bundles.map(x=>[x.course,x])).values()].slice(0,3);
  if (!$('#library-covers').children.length) $('#library-covers').innerHTML=coverItems.map(x=>`<button class="mt-hero-book" type="button" data-book="${esc(x.id)}" aria-label="翻开 ${esc(x.title)}">${cover(x)}</button>`).join('');
  updateBagButtons();
  galleryMotion=mountShelfMotion($('#library-list'));
  if(!heroMotion)heroMotion=mountHeroBooks($('#library-covers'));
  if (focused) document.querySelector(`[data-add="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
}

function renderBag() {
  $('#bag-list').innerHTML = bag.length
    ? `<ul class="ap-list">${bag.map((x) => `<li class="ap-row mt-bag-row"><span class="mt-bag-cover" aria-hidden="true">${cover(x)}</span>
        <span class="ap-row-text"><b>${esc(x.title)}</b><span>${esc(x.course)} · ${esc(String(x.format || '').toUpperCase())}</span></span>
        <button class="mt-remove" type="button" data-remove="${esc(x.id)}" aria-label="移除 ${esc(x.title)}" ${busy ? 'disabled' : ''}>移除</button></li>`).join('')}</ul>`
    : `<div class="ap-empty mt-bag-empty"><span class="mt-bag-empty-icon">${BAG}</span><b>资料袋还是空的。</b><p>整册收好试卷、答案和听力，也可以只选其中一份。</p></div>`;
  saveBag();
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-add],[data-remove],[data-subject],[data-upload],[data-close]');
  if (!b) return;
  if (b.hasAttribute('data-close')) {const dialog=b.closest('dialog');if(dialog.id==='bag-dialog')bagMotion.close();else dialog.close();}
  if (b.hasAttribute('data-add')) add(findItem(b.dataset.add), b);
  if (b.hasAttribute('data-remove') && !busy) {
    bag = bag.filter((x) => x.id !== b.dataset.remove);
    renderBag();
    updateBagButtons();
  }
  if (b.hasAttribute('data-subject')) {
    subject = b.dataset.subject;
    limit = 24;
    renderList();
    document.querySelector(`[data-subject="${CSS.escape(subject)}"]`)?.focus({preventScroll:true});
  }
  if (b.hasAttribute('data-upload')) openUpload();
});

// 点对话框外面的遮罩也能关上
document.querySelectorAll('dialog.mt-sheet').forEach(d=>d.addEventListener('click',event=>{if(event.target===d&&!busy){if(d.id==='bag-dialog')bagMotion.close();else d.close();}}));
$('#bag-dialog').addEventListener('cancel',event=>{event.preventDefault();if(!busy)bagMotion.close();});

const bundleSearchText = (item) => [item.course, item.year, item.kind, ...(item.schools || []), item.discipline, item.priority, ...(item.files || []).map(file => `${file.title} ${file.kind}`)].filter(Boolean).join(' ');
attachSearchSuggestions($('#library-q'), {
  getItems: () => bundles.filter(item => (!subject || item.course.includes(subject)) && (!$('#library-kind').value || item.kind === $('#library-kind').value || item.files.some(file => `${file.kind} ${file.title}`.includes($('#library-kind').value))) && (!$('#library-year').value || item.year === $('#library-year').value)),
  getText: bundleSearchText, getMeta: item => [item.course, item.year, `${item.files?.length || 1} 份文件`].filter(Boolean).join(' · '),
});

$('#library-search').onsubmit = (e) => {
  e.preventDefault();
  limit = 24;
  renderList();
};
let debounce;
$('#library-q').oninput = (event) => {
  if (event.isComposing) { clearTimeout(debounce); return; }
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    limit = 24;
    renderList();
  }, 130);
};
['#library-kind', '#library-year', '#library-sort', '#library-university', '#library-discipline', '#library-priority'].forEach((id) => ($(id).onchange = () => {
  limit = 24;
  renderList();
}));
$('#library-more').onclick = () => {
  limit += 24;
  renderList();
};

const openBag = event => {
  renderBag();
  bagMotion.open(event?.detail===0);
};
matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change',()=>{galleryMotion?.();galleryMotion=mountShelfMotion($('#library-list'));});
$('#bag-dock-open').onclick = openBag;
$('#bag-open').onclick = openBag;
$('#bag-clear').onclick = () => {
  if (!busy) {
    bag = [];
    renderBag();
    updateBagButtons();
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
  else if (!canParticipate(s.user)) html = '<div class="ap-empty mt-gate"><b>先验证邮箱。</b><p>验证之后才能上传文件和提交审核。</p><a class="btn btn-primary" href="me.html#account">去验证</a></div>';
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
  const [loaded, session] = await Promise.all([loadMaterials(), hubState()]);
  const items = [...loaded.items], notes = [...loaded.notes];
  let collectionManifest = loaded.collectionManifest ? {...loaded.collectionManifest, collections: [...loaded.collectionManifest.collections]} : null;
  // Private assembled questions live in the same gallery, under the signed-in owner.
  if (session.user) {
    try {
      const [result, collected] = await Promise.all([hubApi.request('question-papers'), hubApi.request('question-papers/collected').catch(() => ({banks: [], errors: [{reason: '已采集题库暂时读取失败'}]}))]);
      for (const bank of collected.banks || []) {
        const profile = bank.classification || {};
        const common = {course: bank.course || '待归类', kind: '已采集题库', status: 'ready', private: true,
          schools: profile.schools || [], discipline: profile.discipline || '待归类', priority: '待核对',
          coverKey: profile.coverKey || 'all', source: bank.sourceUrl, rights: bank.license || '仅私人学习，许可待核对',
          note: `${bank.questionCount} 道结构化题目 · 已采集，未人工复核 · 可直接下载或到题目工坊编辑`,
          fresh: bank.checkedAt, bankId: bank.id};
        const members = ['md', 'json'].map(format => ({...common, id: `collected-${bank.id}-${format}`, format,
          title: `${bank.title} · ${format === 'md' ? '可编辑文本' : '结构化题目'}`,
          url: `/api/hub/question-papers/collected/${encodeURIComponent(bank.id)}/${format === 'md' ? 'text' : 'json'}`}));
        items.push(...members);
        collectionManifest ||= {schemaVersion: 1, collections: []};
        collectionManifest.collections.push({id: `collected-${bank.id}`, title: bank.title, course: common.course,
          verified: true, source: 'registered-collected-bank', members: members.map((file, order) => ({id: file.id, role: 'paper', order}))});
      }
      if (collected.errors?.length) notes.push(`${collected.errors.length} 份采集来源暂不可读取，已保留原件与错误记录。`);
      for (const paper of result.papers || []) {
        if (!paper.questionCount) continue;
        const classification = paper.classification || {};
        const common = {course: paper.course || '待归类', year: '', kind: '题册', status: 'ready',
          rights: '私人学习副本', source: '', private: true, paperId: paper.id,
          schools: classification.schools || [], discipline: classification.discipline || '待归类',
          priority: classification.priority || '待核对', coverKey: classification.coverKey || 'all',
          note: `${paper.questionCount} 道可编辑题目 · ${paper.state === 'shelved' ? '整理已复核' : '待核对'} · 仅你可见`,
          fresh: paper.updated};
        const members = ['md', 'json'].map((format) => ({...common, id: `question-${paper.id}-${format}`,
          title: `${paper.title} · ${format === 'md' ? '可编辑文本' : '结构化题目'}`, format,
          url: `/api/hub/question-papers/${encodeURIComponent(paper.id)}/${format === 'md' ? 'text' : 'json'}`}));
        items.push(...members);
        collectionManifest ||= {schemaVersion: 1, collections: []};
        collectionManifest.collections.push({id: `private-question-${paper.id}`, title: paper.title,
          course: common.course, verified: true, source: 'private-question-workshop',
          members: members.map((file, order) => ({id: file.id, role: 'paper', order}))});
      }
    } catch {
      notes.push('私人题册暂时读取失败，可从识题与组卷继续查看。');
    }
  }
  all = items;
  bundles = groupMaterialBundles(items, { manifest: collectionManifest });
  $('#library-status').textContent = notes.join(' ');
  for (const [selector, values] of [['#library-university', bundles.flatMap(x => x.schools || [])], ['#library-discipline', bundles.map(x => x.discipline).filter(Boolean)]]) {
    $(selector).insertAdjacentHTML('beforeend', [...new Set(values)].sort().map(value => `<option>${esc(value)}</option>`).join(''));
  }
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
