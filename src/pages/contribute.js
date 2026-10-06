import { initShell, observeReveal } from '../js/shell.js';
import { loadSite, repoURL } from '../js/community.js';
import { CATEGORIES, validateProject, validatePerson } from '../js/schema.js';
import { esc } from '../js/data.js';
import '../styles/community.css';

initShell();

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// 中转站：各类东西最适合放在哪里（调研结论）
const HUB = [
  ['代码', 'GitHub', '国内访问慢可以用 Gitee 镜像', '版本记录、Issue、Pull Request，开源世界的通用语言。', 220, '</>'],
  ['电路与 PCB', '立创开源硬件平台', 'oshwhub.com', '原理图和 PCB 可以在线查看，别人能直接下单打板复刻。', 205, '⌁'],
  ['机械结构', '放进仓库', 'STEP / STL，或 GrabCAD、Printables', 'STEP 方便二次设计，STL 拿去就能 3D 打印。', 180, '⚙'],
  ['演示视频', '哔哩哔哩', '项目页里贴上视频链接', '一段一分钟的演示，胜过十页说明文档。', 330, '▶'],
  ['大文件', 'GitHub Releases', '单个文件最大 2 GB', '数据集、固件、视频原片不要直接塞进仓库。', 262, '⇪'],
  ['刷题记录', '洛谷 · 力扣 · Codeforces', '在这里登记账号即可', '每天自动同步到你的主页和社区热力图。', 24, '#'],
  ['试卷与笔记', '投稿到 Luokixi', '通过 GitHub Issue 上传附件', '维护者核对来源与版权后，收录到矿大资料。', 158, '✎'],
  ['论文与报告', 'arXiv · DOI', '课程报告可以放在仓库 docs/ 里', '有永久链接，方便别人引用。', 290, '∑'],
];

const LICENSES = [
  ['MIT', '代码', '最宽松。别人可以随意使用、修改、商用，只需保留你的署名。', '不想设限，就选它'],
  ['GPL-3.0', '代码', '可以使用和修改，但基于它发布的作品也必须开源。', '希望改进回流社区'],
  ['CC BY-SA 4.0', '笔记 · 文档 · 图片', '可以转载和改编，需要署名，并以相同方式共享。', '课程笔记、复习资料'],
  ['CERN-OHL-S-2.0', '硬件', '为硬件设计而写的开源许可，改过的设计也要公开。', '电路板、机械结构'],
];

const FLOW = [
  ['填表', '在这一页填好信息，自动生成格式正确的文件。'],
  ['提交', '跳到 GitHub 确认，自动替你创建 Pull Request。'],
  ['校验', '机器人检查格式和链接；名录只能本人提交。'],
  ['合并', '维护者审核通过后合并。'],
  ['上线', '网站自动重新构建，此后每天同步一次各平台数据。'],
];

const RULES = [
  ['只分享你有权分享的内容', '不传盗版教材、付费课程，以及别人没有公开的作品。'],
  ['名录只能本人登记', '校验会比对文件名和提交者的 GitHub 账号。想退出，删掉自己的文件就行。'],
  ['试卷写清来源和年份', '不确定的写“待核”，不要猜。'],
  ['原创和转载分开', '外部项目必须写清原作者，不能当成自己的。'],
  ['链接只接受常见平台', 'GitHub、Gitee、立创开源、哔哩哔哩等，防止广告和钓鱼链接。'],
  ['友善', '对新同学的第一个 Pull Request，多一点耐心。'],
];

function staticSections() {
  $('#hub-grid').innerHTML = HUB.map(
    ([what, where, alt, why, h, icon]) => `<article class="card hub-card" data-reveal>
      <span class="hub-icon" style="--h:${h}" aria-hidden="true">${esc(icon)}</span>
      <p class="hub-what">${what}</p>
      <h3 class="hub-where">${where}</h3>
      <p class="hub-alt">${alt}</p>
      <p class="hub-why">${why}</p>
    </article>`,
  ).join('');
  $('#lic-grid').innerHTML = LICENSES.map(
    ([id, scope, desc, pick]) => `<article class="card lic-card" data-reveal>
      <p class="lic-scope">${scope}</p><h3 class="lic-id num">${id}</h3><p>${desc}</p><p class="lic-pick">${pick}</p>
    </article>`,
  ).join('');
  $('#flow-list').innerHTML = FLOW.map(
    ([t, d], i) => `<li class="flow-step" data-reveal><span class="flow-n num">${i + 1}</span><h3>${t}</h3><p>${d}</p></li>`,
  ).join('');
  $('#rules-list').innerHTML = RULES.map(([t, d]) => `<li data-reveal><strong>${t}</strong><span>${d}</span></li>`).join('');
}

// ---------- 表单 → JSON ----------

const words = (s) => s.split(/[\s,，、]+/).map((x) => x.trim()).filter(Boolean);
const today = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);

function buildProject(f) {
  const v = (k) => f.elements[k].value.trim();
  const links = Object.fromEntries(['repo', 'hardware', 'video'].map((k) => [k, v(k)]).filter(([, u]) => u));
  const obj = {
    title: v('title'), summary: v('summary'), category: v('category'),
    tags: words(v('tags')).slice(0, 6), origin: 'cumtb', authors: words(v('authors')), links,
  };
  if (v('year')) obj.year = Number(v('year'));
  if (!obj.tags.length) delete obj.tags;
  const slug = v('slug');
  return { path: `content/projects/${slug || '项目文件名'}.json`, obj, errors: validateProject(slug, obj) };
}

function buildPerson(f) {
  const v = (k) => f.elements[k].value.trim();
  const login = v('github');
  const obj = { github: login, name: v('name') };
  if (v('major')) obj.major = v('major');
  if (v('grade')) obj.grade = Number(v('grade'));
  if (v('bio')) obj.bio = v('bio');
  const oj = {};
  if (v('luogu')) oj.luogu = Number(v('luogu'));
  if (v('leetcode')) oj.leetcode = v('leetcode');
  if (v('codeforces')) oj.codeforces = v('codeforces');
  if (Object.keys(oj).length) obj.oj = oj;
  obj.joined = today();
  return { path: `content/people/${login || '你的GitHub用户名'}.json`, obj, errors: validatePerson(login, obj) };
}

// 只做最基本的着色：键、字符串、数字
const highlight = (json) =>
  esc(json).replace(/(&quot;[^&]*?&quot;)(\s*:)?|(\b\d+\b)/g, (m, s, colon, n) =>
    n ? `<span class="j-n">${n}</span>` : colon ? `<span class="j-k">${s}</span>${colon}` : `<span class="j-s">${s}</span>`,
  );

function wireForm(form, site) {
  const build = form.dataset.kind === 'project' ? buildProject : buildPerson;
  const out = {
    path: $('[data-path]', form), json: $('[data-json]', form), errors: $('[data-errors]', form),
    submit: $('[data-submit]', form), copy: $('[data-copy]', form),
  };
  let text = '';
  let touched = false;
  const update = () => {
    const { path, obj, errors } = build(form);
    text = `${JSON.stringify(obj, null, 2)}\n`;
    out.path.textContent = path;
    out.json.innerHTML = highlight(text);
    out.errors.innerHTML = touched ? errors.map((e) => `<li>${esc(e)}</li>`).join('') : '';
    const base = repoURL(site);
    const ok = !errors.length && base;
    out.submit.toggleAttribute('aria-disabled', !ok);
    out.submit.href = ok
      ? `${base}/new/${site.repo.branch}?filename=${encodeURIComponent(path)}&value=${encodeURIComponent(text)}`
      : '#';
    out.submit.title = !base ? '仓库发布到 GitHub 后可用，现在可以先复制' : errors.length ? '先把上面的问题改好' : '';
  };
  form.addEventListener('input', () => {
    touched = true;
    update();
  });
  out.submit.addEventListener('click', (e) => {
    if (out.submit.hasAttribute('aria-disabled')) {
      e.preventDefault();
      touched = true;
      update();
    }
  });
  out.copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text);
      out.copy.textContent = '已复制';
    } catch {
      out.copy.textContent = '复制失败，请手动选中';
    }
    setTimeout(() => (out.copy.textContent = '复制'), 1600);
  });
  update();
}

function wireDialogs() {
  $$('[data-open]').forEach((b) =>
    b.addEventListener('click', () => {
      const d = document.getElementById(b.dataset.open);
      d.showModal();
      d.querySelector('input, textarea')?.focus();
    }),
  );
  $$('dialog').forEach((d) => {
    d.addEventListener('click', (e) => (e.target === d || e.target.closest('[data-close]')) && d.close());
  });
}

$('#form-project select[name=category]').innerHTML = Object.entries(CATEGORIES)
  .map(([k, c]) => `<option value="${k}">${c.name}</option>`)
  .join('');
staticSections();
wireDialogs();

loadSite()
  .catch(() => ({}))
  .then((site) => {
    const base = repoURL(site);
    $('#repo-notice').hidden = Boolean(base);
    $('#resource-link').href = base ? `${base}/issues/new?template=resource.yml` : '#rules';
    if (base) $('#resource-link').target = '_blank';
    $$('.ct-form').forEach((f) => wireForm(f, site));
  })
  .finally(() => observeReveal());
