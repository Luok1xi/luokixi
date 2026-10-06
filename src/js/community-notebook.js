// Browser-local, self-reported learning records. No platform account access.
const KEY = 'luokixi.community.notebook.v1';
const SCHEMA = 'luokixi-community-notebook-v1';
const states = new Set(['todo','review','solved']);
const string = (value, max, label) => {
  if (typeof value !== 'string' || value.length > max) throw new Error(`${label}格式不正确或过长。`);
  return value.trim();
};
function httpsURL(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('请填写完整链接。'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error('请使用不含账号密码的 HTTPS 链接。');
  return url;
}
export function normalizeProblemURL(raw) {
  const url = httpsURL(raw);
  const path = url.pathname.replace(/\/$/, '').replace(/\/description$/, '');
  if (!((url.hostname === 'www.luogu.com.cn' && /^\/problem\/[A-Za-z0-9_-]+$/.test(path)) ||
    (['leetcode.cn','leetcode.com'].includes(url.hostname) && /^\/problems\/[a-z0-9-]+$/.test(path)))) {
    throw new Error('仅收录洛谷或力扣的原题链接。');
  }
  return `${url.origin}${path}`;
}
function projectURL(raw) {
  const url = httpsURL(raw);
  const path = url.pathname.replace(/\/$/, '');
  if (!['github.com','gitee.com','gitlab.com','codeberg.org'].includes(url.hostname) || !/^\/[\w.-]+\/[\w.-]+$/.test(path)) throw new Error('请填写公开仓库主页。');
  return `${url.origin}${path}`;
}
function profileURL(platform, raw) {
  if (!raw) return '';
  const url = httpsURL(raw); const path = url.pathname.replace(/\/$/, '');
  const valid = {
    github: url.hostname === 'github.com' && /^\/[\w-]+$/.test(path),
    luogu: url.hostname === 'www.luogu.com.cn' && /^\/user\/\d+$/.test(path),
    leetcode: ['leetcode.cn','leetcode.com'].includes(url.hostname) && /^\/u\/[\w-]+$/.test(path),
  }[platform];
  if (!valid) throw new Error('个人主页格式不匹配；这里只保存公开链接，不验证账号归属。');
  return `${url.origin}${path}`;
}
function empty() { return {schema:SCHEMA,problems:[],savedProjects:[],profiles:{github:'',luogu:'',leetcode:''}}; }
function validate(raw) {
  if (raw?.schema!==SCHEMA || !Array.isArray(raw.problems) || raw.problems.length>1000 || !Array.isArray(raw.savedProjects) || raw.savedProjects.length>1000) throw new Error('足迹备份格式不匹配或超过 1000 条。');
  const result=empty(), seen=new Set();
  for(const p of raw.problems) {
    if (!p || !states.has(p.status)) throw new Error('存在无效完成状态，未导入。');
    const url=normalizeProblemURL(p.url);
    const title=string(p.title,100,'题目名称'), note=string(p.note,12000,'笔记');
    if (!title) throw new Error('题目名称不能为空。');
    if (seen.has(url)) continue;
    seen.add(url);
    result.problems.push({url,title,note,status:p.status,updated:typeof p.updated==='string' && Number.isFinite(Date.parse(p.updated)) ? p.updated : new Date().toISOString()});
  }
  result.savedProjects=[...new Set(raw.savedProjects.map(projectURL))];
  for(const platform of Object.keys(result.profiles)) result.profiles[platform]=profileURL(platform,raw.profiles?.[platform]||'');
  return result;
}

export function createNotebook(storage = globalThis.localStorage) {
  const read = () => {
    const raw=storage.getItem(KEY);
    if (!raw) return empty();
    try { return validate(JSON.parse(raw)); }
    catch { throw new Error('本浏览器足迹数据无法读取。请先保留原数据，再从备份恢复。'); }
  };
  const save = data => {
    try { storage.setItem(KEY,JSON.stringify(data)); }
    catch { throw new Error('浏览器未能保存。请检查存储空间或隐私设置。'); }
    return data;
  };
  return {
    read,
    addProblem(raw, title) {
      const url=normalizeProblemURL(raw), data=read();
      const name=string(title,100,'题目名称');
      if (!name) throw new Error('请填写题目名称。');
      if (data.problems.some(p=>p.url===url)) throw new Error('这道题已经在足迹中。');
      if (data.problems.length>=1000) throw new Error('足迹已达 1000 条，请先导出并整理。');
      data.problems.unshift({url,title:name,note:'',status:'todo',updated:new Date().toISOString()});
      return save(data);
    },
    updateProblem(raw, {status,note}) {
      const url=normalizeProblemURL(raw), data=read(), p=data.problems.find(p=>p.url===url);
      if (!p) throw new Error('题目不在足迹中。');
      if (!states.has(status)) throw new Error('无效完成状态。');
      p.note=string(note,12000,'笔记');p.status=status;p.updated=new Date().toISOString();
      return save(data);
    },
    removeProblem(raw) { const url=normalizeProblemURL(raw), data=read();data.problems=data.problems.filter(p=>p.url!==url);return save(data); },
    toggleProject(raw) { const url=projectURL(raw), data=read();if(!data.savedProjects.includes(url)&&data.savedProjects.length>=1000)throw new Error('收藏已达 1000 条，请先导出并整理。');data.savedProjects=data.savedProjects.includes(url)?data.savedProjects.filter(x=>x!==url):[...data.savedProjects,url];return save(data); },
    setProfiles(profiles) { const data=read();for(const platform of Object.keys(data.profiles)) data.profiles[platform]=profileURL(platform,profiles[platform]||'');return save(data); },
    export() { return {...read(),exported:new Date().toISOString()}; },
    import(raw) {
      const incoming=validate(raw), data=read();
      const known=new Set(data.problems.map(p=>p.url));
      data.problems.push(...incoming.problems.filter(p=>!known.has(p.url)));
      data.savedProjects=[...new Set([...data.savedProjects,...incoming.savedProjects])];
      for(const key of Object.keys(data.profiles)) if (!data.profiles[key]) data.profiles[key]=incoming.profiles[key];
      if (data.problems.length>1000 || data.savedProjects.length>1000) throw new Error('合并后超过 1000 条，请拆分备份。');
      return save(data);
    },
  };
}
