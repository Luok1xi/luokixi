// 社区内容的分类与校验规则。前端页面、构建脚本、PR 校验共用这一份，改这里即可。
// 不依赖浏览器或 Node 专有 API。

// 分类表与 Codex 的服务端共用：content/categories.json
import shared from '../../content/categories.json' with { type: 'json' };

export const CATEGORIES = shared.categories;

export const ORIGINS = {
  cumtb: '矿大同学',
  external: '外部推荐',
};

const SLUG = /^[a-z0-9][a-z0-9-]{1,47}$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37})$/;
const URL_OK = (u) => typeof u === 'string' && /^https:\/\/[^\s]+$/.test(u) && u.length <= 300;
const str = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

// 链接只接受这些平台，防止被用来挂广告或钓鱼链接
export const LINK_HOSTS = {
  repo: ['github.com', 'gitee.com', 'gitlab.com', 'codeberg.org'],
  hardware: ['oshwhub.com', 'easyeda.com', 'oshwlab.com', 'grabcad.com', 'printables.com', 'thingiverse.com'],
  video: ['www.bilibili.com', 'bilibili.com', 'b23.tv', 'www.youtube.com', 'youtu.be'],
  paper: ['arxiv.org', 'doi.org', 'www.cnki.net', 'kns.cnki.net'],
  site: null, // 项目主页可以是任意 https 地址
};

const hostOf = (u) => {
  try { return new URL(u).hostname; } catch { return ''; }
};

export function validateProject(slug, p) {
  const errs = [];
  if (!SLUG.test(slug)) errs.push(`文件名 ${slug} 只能用小写字母、数字和连字符`);
  if (!str(p.title, 40)) errs.push('title：必填，不超过 40 字');
  if (!str(p.summary, 120)) errs.push('summary：必填，不超过 120 字');
  if (!CATEGORIES[p.category]) errs.push(`category：只能是 ${Object.keys(CATEGORIES).join(' / ')}`);
  if (!ORIGINS[p.origin]) errs.push('origin：只能是 cumtb 或 external');
  if (p.origin === 'external' && !str(p.credit, 60)) errs.push('外部项目必须填写 credit（原作者）');
  if (p.origin === 'cumtb' && (!Array.isArray(p.authors) || !p.authors.length)) errs.push('本校项目至少填写一位作者的 GitHub 用户名');
  if (p.authors && (!Array.isArray(p.authors) || p.authors.some((a) => !LOGIN.test(a)))) errs.push('authors：GitHub 用户名格式不对');
  if (p.tags && (!Array.isArray(p.tags) || p.tags.length > 6 || p.tags.some((t) => !str(t, 12)))) errs.push('tags：最多 6 个，每个不超过 12 字');
  if (!p.links || typeof p.links !== 'object') errs.push('links：至少需要一个链接');
  else {
    const keys = Object.keys(p.links);
    if (!keys.length) errs.push('links：至少需要一个链接');
    for (const k of keys) {
      if (!(k in LINK_HOSTS)) { errs.push(`links.${k}：不支持的链接类型`); continue; }
      const u = p.links[k];
      if (!URL_OK(u)) { errs.push(`links.${k}：必须是 https 链接`); continue; }
      const hosts = LINK_HOSTS[k];
      if (hosts && !hosts.includes(hostOf(u))) errs.push(`links.${k}：只接受 ${hosts.join('、')}`);
    }
  }
  if (p.year != null && !(Number.isInteger(p.year) && p.year >= 2000 && p.year <= 2100)) errs.push('year：四位年份');
  if (p.cover != null && !/^art\/projects\/[a-z0-9-]+\.(webp|png|jpg|svg)$/.test(p.cover)) errs.push('cover：放在 public/art/projects/ 下');
  return errs;
}

export function validatePerson(login, p) {
  const errs = [];
  if (!LOGIN.test(login)) errs.push(`文件名 ${login} 必须是 GitHub 用户名`);
  if (p.github !== login) errs.push('github 字段必须和文件名一致');
  if (!str(p.name, 20)) errs.push('name：必填，不超过 20 字');
  if (p.major != null && !str(p.major, 20)) errs.push('major：不超过 20 字');
  if (p.grade != null && !(Number.isInteger(p.grade) && p.grade >= 1990 && p.grade <= 2100)) errs.push('grade：入学年份，四位数字');
  if (p.bio != null && !str(p.bio, 80)) errs.push('bio：不超过 80 字');
  const oj = p.oj ?? {};
  if (oj.luogu != null && !(Number.isInteger(oj.luogu) && oj.luogu > 0)) errs.push('oj.luogu：洛谷 UID（数字）');
  if (oj.leetcode != null && !/^[A-Za-z0-9_-]{1,40}$/.test(oj.leetcode)) errs.push('oj.leetcode：力扣个人主页地址里的那段 ID');
  if (oj.codeforces != null && !/^[A-Za-z0-9_.-]{3,24}$/.test(oj.codeforces)) errs.push('oj.codeforces：Codeforces 用户名');
  for (const [k, u] of Object.entries(p.links ?? {})) if (!URL_OK(u)) errs.push(`links.${k}：必须是 https 链接`);
  return errs;
}
