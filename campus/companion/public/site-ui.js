// luokixi site management: her own account, how her posts go out, health/content checks and drafts.
const statusNames={draft:'等你确认',blocked:'疑似带私人内容，已拦下',failed:'提交失败','pending-review':'已提交，等网站审核',published:'已公开',rejected:'审核没通过',discarded:'不发了'};
const boardNames={daily:'矿大日常',courses:'选课与学习引导',makers:'创作与开源',teams:'组队与机会',research:'科研与生涯',reading:'精选阅读'};
export function initSite({api,guard,notify,config}){
  const card=document.createElement('div');card.className='card';card.id='site-panel';
  card.innerHTML=`<p class="eyebrow">LUOKIXI</p><h2>帮你照看网站</h2><p class="muted">给她在 luokixi 注册一个普通账号（不要给管理员权限），填在下面。她会每半小时看看网站在不在线；填了网站目录的话，每天跑一次内容校验。她会回复别人在她帖子下的留言和 @ 她的消息，也会主动把学到的东西、学校通知、让人开心的见闻写成帖子。所有帖子都要经过网站审核才公开；她的回复默认也要审核，想让回复直接公开，要用命令把她的账号设为可信（见 COMPANION-SYSTEM.md）。昵称不要用“北矿娘”，网站里已有同名的系统角色。</p>
  <form id="site-config" class="form-grid"><label>网站地址<input name="siteBase" placeholder="http://127.0.0.1:17860"></label><label>她的账号邮箱<input name="siteEmail" type="email" autocomplete="off"></label>
  <label>她的账号密码（只存在本机，不回显）<input name="sitePassword" type="password" autocomplete="new-password"></label><label>网站项目目录（可选，用于内容校验）<input name="sitePath" placeholder="D:/projects/luokixi"></label>
  <div class="full actions"><button class="primary">保存账号</button></div></form>
  <form id="site-settings" class="form-grid"><label class="check"><input type="checkbox" name="enabled"> 让她照看网站</label>
  <label>帖子怎么发<select name="mode"><option value="draft">先给我看，我确认后再提交</option><option value="submit">直接提交到网站审核队列</option></select></label>
  <label>发到哪个话题吧<select name="board"></select></label><div class="full actions"><button>保存</button><button type="button" data-site-check>现在检查一次</button></div></form>
  <p id="site-status" class="muted" role="status"></p><h3>她写的帖子和回复</h3><div id="site-drafts"></div>`;
  document.querySelector('#settings')?.append(card);
  const $=s=>card.querySelector(s),settings=$('#site-settings');
  for(const [id,name] of Object.entries(boardNames)){const o=document.createElement('option');o.value=id;o.textContent=name;settings.elements.board.append(o);}
  const time=m=>m?new Date(m*60000).toLocaleString('zh-CN'):'';
  async function refresh(){
    const c=config();if(c)for(const k of ['siteBase','siteEmail','sitePath'])$('#site-config').elements[k].value=c[k]||'';
    const d=await api('/api/site'),site=d.site,last=site.checks?.at(-1);settings.elements.enabled.checked=!!site.enabled;settings.elements.mode.value=site.mode||'draft';settings.elements.board.value=site.board||'daily';
    $('#site-status').textContent=(d.configured?'账号已填写。':'还没有填写她的网站账号。')+(last?` 最近检查：${time(last.at)} ${last.ok?'在线，'+last.latency+' 毫秒':'连不上（'+(last.error||'')+'）'}。`:'')+(site.outage?' 网站目前处于故障状态。':'')+(site.validation?` 内容校验：${site.validation.ok?'通过':'有问题'}（${time(site.validation.at)}）。`:'')+(site.lessons?.length?` 记住了 ${site.lessons.length} 条你的审核意见。`:'');
    const list=$('#site-drafts');list.replaceChildren();
    if(!site.drafts?.length){list.innerHTML='<p class="empty">还没有写过帖子或回复。</p>';return;}
    for(const draft of site.drafts){const item=document.createElement('div');item.className='item';const title=document.createElement('strong');title.textContent=(draft.kind==='reply'?'回复 · ':'帖子 · ')+draft.title;
      const meta=document.createElement('div');meta.className='meta';meta.textContent=(statusNames[draft.status]||draft.status)+' · '+time(draft.at)+(draft.note?' · '+draft.note:'');
      const body=document.createElement('pre');body.textContent=draft.body;item.append(title,meta,body);
      if(draft.status==='draft'){const actions=document.createElement('div');actions.className='actions';const ok=document.createElement('button');ok.className='primary';ok.textContent='确认提交';ok.onclick=guard(async()=>{await api('/api/site/submit',{id:draft.id});notify('已提交到网站。');await refresh();});
        const no=document.createElement('button');no.textContent='不发了';no.onclick=guard(async()=>{notify((await api('/api/command',{action:'site.draft.discard',args:{id:draft.id}})).message);await refresh();});actions.append(ok,no);item.append(actions);}
      list.append(item);}
  }
  $('#site-config').onsubmit=guard(async e=>{e.preventDefault();const f=e.target.elements,data={siteBase:f.siteBase.value,siteEmail:f.siteEmail.value,sitePath:f.sitePath.value};if(f.sitePassword.value)data.sitePassword=f.sitePassword.value;Object.assign(config(),await api('/api/config',data));f.sitePassword.value='';notify('网站账号已保存到本机。');await refresh();});
  settings.onsubmit=guard(async e=>{e.preventDefault();const f=e.target.elements;notify((await api('/api/command',{action:'site.settings',args:{enabled:f.enabled.checked,mode:f.mode.value,board:f.board.value}})).message);await refresh();});
  $('[data-site-check]').onclick=guard(async()=>{const r=await api('/api/site/check',{});notify(r.check.ok?'网站在线。':'网站连不上：'+(r.check.error||''));await refresh();});
  setTimeout(()=>void guard(refresh)());
}
