const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
export function renderSocial({api,notify}){
  if(document.querySelector('#social-watch'))return;
  const box=document.createElement('section');box.id='social-watch';box.className='card';
  box.innerHTML='<h2>自动关注微信与 QQ</h2><p>启用后由 她 定期读取账号近期会话，不需要转发。读取范围是当前登录账号；实际覆盖范围以下方状态为准，不能把界面读不到或离线当作没有新消息。</p><p class="muted">连续新消息先合并，再交给模型分析；最多每天 8 次、间隔至少 30 分钟，并计入自主活动预算。重要发现只私下发给你，不向原好友或群回复。每个会话最多保留 1000 条，本机最多 500 个来源；可在下方查看原文与分析。</p><div id="social-channels"></div><div class="actions"><button id="social-check">现在检查连接与新消息</button><button id="social-refresh">刷新状态</button><a href="http://127.0.0.1:17842/webui" target="_blank" rel="noreferrer">QQ 采集登录页</a></div><p class="meta">微信界面采集需要会话控件可读、电脑空闲，可能切换聊天并改变已读状态；当前不支持绕过账号的界面读取限制。QQ 从本机接口读近期文字，未下载的图片、视频不会被当作已看过。</p>';
  document.querySelector('#research').prepend(box);
  async function refresh(){const data=await api('/api/social');box.querySelector('#social-channels').innerHTML=data.channels.map(c=>`<article><h3>${c.platform==='qq'?'QQ':'微信'} · ${c.enabled?'自动检查已开启':'已暂停'}</h3><p>${esc(c.detail)}</p><p class="meta">状态：${esc(c.status)} · 今日共分析 ${data.todayAnalyses} 次</p><button data-platform="${esc(c.platform)}" data-enabled="${c.enabled?'false':'true'}">${c.enabled?'暂停读取':'启用账号自动读取'}</button></article>`).join('');box.querySelectorAll('[data-platform]').forEach(b=>b.onclick=guard(async()=>{await api('/api/social/settings',{platform:b.dataset.platform,enabled:b.dataset.enabled==='true'});await refresh();}));}
  const guard=fn=>async()=>{try{await fn();}catch(e){notify(e.message,true);}};
  box.querySelector('#social-refresh').onclick=guard(refresh);
  box.querySelector('#social-check').onclick=guard(async()=>{const button=box.querySelector('#social-check');button.disabled=true;try{await api('/api/social/check',{});await refresh();notify('已检查，读取状态已更新。');}finally{button.disabled=false;}});
  guard(refresh)();
  const timer=setInterval(()=>{if(box.closest('.tab.active'))guard(refresh)();},20000);window.addEventListener('pagehide',()=>clearInterval(timer),{once:true});
}
