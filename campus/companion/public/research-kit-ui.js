const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const when=minutes=>minutes?new Date((minutes+480)*60000).toISOString().slice(5,16).replace('T',' '):'';
const statusName={queued:'排队中',running:'研究中',done:'已完成',partial:'部分完成',failed:'失败',cancelled:'已停止',interrupted:'已中断'};
const keyFields=[['tavilyKey','Tavily Key','每月 1000 次免费额度，英文与国际资料较好'],['bochaKey','博查 Key','中文网页与新闻较好，按次计费'],['braveKey','Brave Search Key','可选'],['s2Key','Semantic Scholar Key','可选，免费申请后减少限流']];

// Research toolkit panel: search providers, skills, quick test runs and background research projects.
export function initResearchKit({api,guard,notify}){
  const host=document.querySelector('#research');if(!host||document.querySelector('#kit-panel'))return;
  const panel=document.createElement('div');panel.className='card';panel.id='kit-panel';
  panel.innerHTML=`<p class="eyebrow">RESEARCH TOOLKIT</p><h2>检索与科研</h2>
    <p class="muted" id="kit-status">正在读取工具状态…</p>
    <div class="two-columns">
      <form id="kit-project" class="form-grid"><h3 class="full">开始一个研究项目</h3>
        <label class="full">研究问题<textarea name="question" rows="3" maxlength="500" required placeholder="例如：四足机器人强化学习步态控制的主流方法、仿真到实机迁移的难点，以及适合本科生复现的开源项目。"></textarea></label>
        <p class="muted full">在后台运行，通常需要 3—15 分钟：拆解子问题 → 检索论文和网页 → 精读全文 → 逐字核对引文 → 写成带参考文献的报告。完成后 她 会在聊天里告诉你。也可以直接在对话里说“帮我深入研究一下……”。</p>
        <button class="primary">开始研究</button></form>
      <form id="kit-quick" class="form-grid"><h3 class="full">快速检索测试</h3>
        <label class="full">问题<input name="question" maxlength="300" required placeholder="例如：ORB-SLAM3 和 VINS-Fusion 的区别"></label>
        <p class="muted full">直接查看检索执行器每一步调用了什么、读了哪些来源。结果不会写进聊天和记忆，会产生少量模型费用。</p>
        <button>检索</button></form>
    </div>
    <div id="kit-quick-result"></div>
    <h3>研究项目</h3><div id="kit-projects"><p class="muted">暂无。</p></div>
    <details><summary>搜索服务与花费上限</summary><form id="kit-config" class="form-grid"></form></details>
    <details><summary id="kit-skills-title">技能</summary><div id="kit-skills"></div></details>
    <details><summary>工具经验（真实调用统计）</summary><div id="kit-experience"></div></details>`;
  host.prepend(panel);
  const $=s=>panel.querySelector(s);let data=null,openReport=null;

  async function refresh(){
    data=await api('/api/research-kit');const s=data.status,c=data.config;
    $('#kit-status').textContent=`通用网页搜索：${s.webSearch.length?s.webSearch.join('、'):'未配置（下方“搜索服务”中填写 Key）'}；学术库：${s.scholarly.join('、')}；参考来源：${s.reference.join('、')}；社区：${s.community.join('、')||'未接入'}；技能 ${data.skills.length} 个。${c.agentEnabled===false?'对话中的自动检索已关闭。':''}`;
    $('#kit-skills-title').textContent=`技能（${data.skills.length} 个，按需加载）`;
    $('#kit-skills').innerHTML=data.skills.map(k=>`<div class="item"><strong>${esc(k.name)}</strong>${esc(k.description)}<div class="meta">常用工具：${esc(k.tools.join('、')||'—')}</div></div>`).join('')+(data.skillErrors.length?`<p class="warning">${esc(data.skillErrors.join('；'))}</p>`:'')+'<p class="muted">技能文件在项目的 skills 文件夹，每个技能一个 SKILL.md，可以自己增加或修改，保存后下次检索自动生效。</p>';
    $('#kit-experience').innerHTML=data.experience.length?data.experience.map(r=>`<div class="item"><strong>${esc(r.capability)} · ${esc(r.implementation)}</strong><div class="meta">${esc(r.scope)} · 成功 ${r.successes}/${r.attempts} · 平均 ${r.latencyMs}ms${r.lastFailure?' · 最近失败：'+esc(r.lastFailure):''}</div></div>`).join(''):'<p class="muted">还没有调用记录。</p>';
    if(!$('#kit-config').dataset.ready)renderConfig(c);
    renderProjects();
  }
  function renderConfig(c){
    const form=$('#kit-config');form.dataset.ready='1';
    form.innerHTML=keyFields.map(([k,label,hint])=>`<label>${label}<input type="password" name="${k}" autocomplete="off" placeholder="${c[k.replace('Key','Configured')]?'已保存，留空不修改':'未填写'}"><small class="muted">${hint}${c[k.replace('Key','Configured')]?` · <span class="kit-inline"><input type="checkbox" class="kit-check" name="clear_${k}"> 清除</span>`:''}</small></label>`).join('')+
      `<label>SearXNG 地址（可选，自建）<input name="searxngUrl" value="${esc(c.searxngUrl||'')}" placeholder="http://127.0.0.1:8080"></label>
       <label>对话中每次检索上限（元）<input type="number" name="agentQuickLimit" min="0.05" max="2" step="0.05" value="${c.agentQuickLimit}"></label>
       <label>每个研究项目上限（元）<input type="number" name="researchRunLimit" min="0.2" max="10" step="0.1" value="${c.researchRunLimit}"></label>
       <label class="full kit-inline"><input type="checkbox" class="kit-check" name="agentEnabled" ${c.agentEnabled!==false?'checked':''}> 对话中需要资料时自动检索（关闭后恢复旧的单步工具；修改后需重启服务）</label>
       <p class="muted full">Key 只保存在本机 data/config.json，网页不会回显。学术库、维基、GitHub、StackOverflow 不需要 Key。费用全部计入原有月度预算。</p>
       <button class="primary">保存搜索设置</button>`;
    form.onsubmit=guard(async e=>{e.preventDefault();const f=new FormData(form),body={};
      for(const [k]of keyFields){const v=String(f.get(k)||'').trim();if(v)body[k]=v;if(f.get('clear_'+k))body['clear_'+k]=true;}
      body.searxngUrl=String(f.get('searxngUrl')||'').trim();body.agentQuickLimit=Number(f.get('agentQuickLimit'));body.researchRunLimit=Number(f.get('researchRunLimit'));body.agentEnabled=!!f.get('agentEnabled');
      await api('/api/config',body);form.dataset.ready='';notify('搜索设置已保存。');await refresh();});
  }
  function renderProjects(){
    const box=$('#kit-projects');if(!data.projects.length){box.innerHTML='<p class="muted">暂无。</p>';return;}
    box.innerHTML=data.projects.map(p=>`<div class="item" data-id="${esc(p.id)}"><strong>${esc(p.question)}</strong>
      <div class="meta">${statusName[p.status]||esc(p.status)} · ${when(p.created)}${p.cost?` · 约 ¥${Number(p.cost).toFixed(3)}`:''}${p.sources?` · ${p.sources} 个来源 · 引文核对 ${p.verified}/${p.findings}`:''}${p.channel!=='local'?' · 来自'+({weixin:'微信',feishu:'飞书'})[p.channel]:''}</div>
      ${['queued','running'].includes(p.status)?`<p class="muted">${esc(p.progress?.text||'')}${p.progress?.step?`（第 ${p.progress.step} 步）`:''}</p>`:''}
      ${p.summary?`<p>${esc(p.summary)}</p>`:''}${p.error&&!['done'].includes(p.status)?`<p class="warning">${esc(p.error)}</p>`:''}
      <div class="actions">${['done','partial'].includes(p.status)?`<button type="button" data-kit="view">查看报告</button><a href="/api/projects/export?id=${encodeURIComponent(p.id)}&format=md">导出 Markdown</a> · <a href="/api/projects/export?id=${encodeURIComponent(p.id)}&format=bib">导出 BibTeX</a> `:''}${['queued','running'].includes(p.status)?'<button type="button" data-kit="cancel">停止</button>':'<button type="button" data-kit="remove">删除</button>'}</div>
      ${openReport===p.id?'<pre class="kit-report">读取中…</pre>':''}</div>`).join('');
    if(openReport)void showReport(openReport);
  }
  async function showReport(id){const res=await fetch('/api/projects/export?id='+encodeURIComponent(id)+'&format=md');const pre=panel.querySelector(`[data-id="${CSS.escape(id)}"] .kit-report`);if(pre)pre.textContent=res.ok?await res.text():'报告读取失败。';}
  $('#kit-projects').addEventListener('click',guard(async e=>{const b=e.target.closest('[data-kit]');if(!b)return;const id=b.closest('[data-id]').dataset.id;
    if(b.dataset.kit==='view'){openReport=openReport===id?null:id;renderProjects();return;}
    if(b.dataset.kit==='remove'&&!confirm('删除这个研究项目和报告？'))return;
    notify((await api('/api/projects/'+b.dataset.kit,{id})).message);await refresh();}));
  $('#kit-project').onsubmit=guard(async e=>{e.preventDefault();const form=e.target,q=form.elements.question.value.trim();const r=await api('/api/projects/start',{question:q});form.reset();notify(r.duplicate?'这个问题已经在研究中。':`已开始研究，当前排第 ${r.position||1} 位。`);await refresh();});
  $('#kit-quick').onsubmit=guard(async e=>{e.preventDefault();const form=e.target,button=form.querySelector('button'),out=$('#kit-quick-result');button.disabled=true;out.innerHTML='<p class="muted">检索中，通常 20—90 秒…</p>';
    try{const r=await api('/api/investigate',{question:form.elements.question.value.trim()});
      out.innerHTML=`<div class="card kit-result"><p class="eyebrow">结论 · 可信度 ${({high:'高',medium:'中',low:'低'})[r.confidence]}</p><p class="kit-answer">${esc(r.answer)}</p>
        ${r.findings.length?'<h3>关键事实</h3>'+r.findings.map(f=>`<div class="item">${esc(f.claim)} ${f.sources.map(s=>'['+esc(s)+']').join('')} ${f.verified?'✓已核对原文':'⚠未能逐字核对'}${f.quote?`<div class="meta">“${esc(f.quote)}”</div>`:''}</div>`).join(''):''}
        ${r.gaps.length?`<p class="warning">未查清：${esc(r.gaps.join('；'))}</p>`:''}
        <h3>来源</h3>${r.sources.map(s=>`<div class="item">[${esc(s.ref)}] <a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title||s.url)}</a><div class="meta">${esc([s.year,s.venue,s.readLevel&&'读取：'+s.readLevel].filter(Boolean).join(' · '))}</div></div>`).join('')||'<p class="muted">没有引用来源。</p>'}
        <details><summary>检索过程：${r.stats.steps} 轮、${r.stats.toolCalls} 次工具调用、${(r.stats.ms/1000).toFixed(1)} 秒、约 ¥${r.stats.cost}，技能 ${esc(r.stats.skills.join('、')||'无')}</summary>${r.trace.map(t=>`<div class="meta">第 ${t.step} 轮 ${esc(t.args)}：${t.ok?'成功':'失败 '+esc(t.error)} · ${t.ms}ms</div>`).join('')}</details></div>`;
    }catch(err){out.innerHTML=`<p class="warning">${esc(err.message)}</p>`;throw err;}finally{button.disabled=false;}});
  void refresh().catch(e=>{$('#kit-status').textContent='工具状态读取失败：'+e.message;});
  setInterval(()=>{if(host.classList.contains('active')&&data?.projects.some(p=>['queued','running'].includes(p.status)))void refresh().catch(()=>{});},8000);
  document.querySelector('[data-tab="research"]')?.addEventListener('click',()=>void refresh().catch(()=>{}));
}
