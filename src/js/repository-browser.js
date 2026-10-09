import { attachSearchSuggestions } from './search-suggestions.js';
import { hubApi } from '../../campus/hub-client.js';
import { esc } from './data.js';
import '../styles/repository.css';

export function mountRepository(root) {
  if (!root) return;
  root.innerHTML = `<h2 class="headline">项目资料仓库</h2><p class="muted">按用途找工具，阅读中文说明，选择适合自己的文件。已存到本站的文件可以直接下载。</p>
    <form class="repo-search" role="search"><label>搜索项目<input name="q" type="search" placeholder="机器人、数据分析、工作流…"></label>
      <label>分类<select name="category"><option value="">全部分类</option></select></label>
      <label>下载方式<select name="download"><option value="">所有项目</option><option value="local">仅本站可下载</option></select></label><button class="btn btn-primary btn-sm" type="submit">搜索</button></form>
    <p class="repo-status" role="status"></p><div class="repo-results"></div><button class="btn btn-outline btn-sm" type="button" data-repo-more hidden>查看更多</button>`;
  const form=root.querySelector('form'),results=root.querySelector('.repo-results'),status=root.querySelector('.repo-status'),more=root.querySelector('[data-repo-more]');
  let controller, offset=0, generation=0;
  const known = new Map();
  attachSearchSuggestions(form.elements.q, {
    getItems: async q => {
      const data = await hubApi.repositories({q,category:form.elements.category.value,download:form.elements.download.value});
      for (const item of data.items) known.set(item.repository,item);
      return [...known.values()];
    },
    getTitle: item => item.repository,
    getText: item => item.description,
    getKeywords: item => (item.classification?.labels || []).map(c => c.name).join(' '),
    getMeta: item => item.description,
  });
  const bytes=n=>n>=1048576?`${(n/1048576).toFixed(1)} MB`:`${(n/1024).toFixed(1)} KB`;
  async function load(append=false) {
    controller?.abort();controller=new AbortController();const current=++generation;
    if (!append) offset=0;
    status.textContent='正在读取仓库目录…';more.disabled=true;
    try {
      const data=await hubApi.repositories({...Object.fromEntries(new FormData(form)),offset},{signal:controller.signal});
      if (current!==generation) return;
      if (form.elements.category.options.length===1) for(const c of data.categories) form.elements.category.add(new Option(c.name,c.id));
      for (const item of data.items) known.set(item.repository,item);
      const html=data.items.map(p=>`<article class="card repo-item"><div class="repo-heading"><h3>${p.pageUrl?`<a href="${esc(p.pageUrl)}">${esc(p.repository)}</a>`:esc(p.repository)}</h3><span class="tag">${p.downloadState==='local'?'本站可下载':'原站入口'}</span></div>
        <p>${esc(p.description)}</p><p class="muted">${p.classification.labels.map(c=>esc(c.name)).join(' · ') || '待分类'} · ${esc(p.license || '许可待核')}${p.stale?' · 来源更新暂未成功':''}</p>
        <div class="repo-files">${p.localFiles.map(f=>`<a class="btn btn-outline btn-sm" href="${esc(f.url)}" download>${esc(f.name)} · ${bytes(f.size)}${f.kind==='source-archive'?' · 源码':''}</a>`).join('')}</div>
        <details><summary>官方文件与版本 · ${p.downloads.length} 项</summary><ul>${p.downloads.map(f=>`<li><a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.name)} ↗</a> · ${f.kind==='source-archive'?'源码，需要构建':esc(f.platform==='unknown'?'系统未确认':f.platform)}${f.bytes?' · '+bytes(f.bytes):''}</li>`).join('')}</ul></details>
        <p><a href="${esc(p.url)}" target="_blank" rel="noopener">GitHub 原仓库 ↗</a>${p.pageUrl?` · <a href="${esc(p.pageUrl)}">说明书与文件详情</a>`:''}</p></article>`).join('');
      if(append) results.insertAdjacentHTML('beforeend',html);else results.innerHTML=html||'<p class="muted">暂时没有匹配的已收录项目。可以换个关键词，或去通知页核对新候选。</p>';
      offset+=data.items.length;status.textContent=`共 ${data.total} 个匹配项目`;more.hidden=offset>=data.total;
    } catch(ex) { if(current===generation){status.textContent=ex.message||'目录暂时无法读取，请重试。';more.hidden=true;} }
    finally {if(current===generation) more.disabled=false;}
  }
  form.addEventListener('submit',e=>{e.preventDefault();load();});
  form.querySelectorAll('select').forEach(s=>s.addEventListener('change',()=>load()));
  more.addEventListener('click',()=>load(true));
  load();
}
