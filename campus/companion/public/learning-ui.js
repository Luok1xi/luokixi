const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
export function renderLearning(state,{api,cmd,refresh,notify}){
  let box=document.querySelector('#miku-growth');if(!box){box=document.createElement('div');box.id='miku-growth';box.className='two-columns';box.style.marginTop='24px';box.innerHTML=`<div class="card"><h2>她的心情与小心愿</h2><p id="affect-description"></p><div id="affect-needs"></div><button id="give-treat">送一颗虚拟糖果</button><p class="muted">免费的角色互动。不需要定时喂，不换好感，也不消耗模型额度。</p><div id="relationship-values"></div></div><div class="card"><h2>她 的学习手账</h2><p id="study-status"></p><div class="actions"><button id="study-now">读一节并参加小测</button><button id="study-toggle"></button><button id="study-clear">清理笔记</button></div><p class="muted">每天最多一节，默认学习预算每月 10 元，包含在总预算中。先不看资料做诊断，再读资料并做不同的迁移题。分数只反映小样本表现，不证明模型训练或掌握学科；下一目标参考薄弱处、进展和复习间隔。</p><div id="study-history"></div></div>`;document.querySelector('#persona').append(box);
    const bind=(id,fn)=>document.querySelector(id).onclick=async()=>{const b=document.querySelector(id);b.disabled=true;try{await fn();}catch(e){notify(e.message,true);}finally{b.disabled=false;}};
    bind('#give-treat',()=>cmd('persona.treat'));
    bind('#study-now',async()=>{notify('她 开始读资料了，随后会做小测。');const r=await api('/api/study',{});notify(r.message);await refresh();});
    bind('#study-toggle',()=>cmd('study.settings',{enabled:document.querySelector('#study-toggle').dataset.enabled!=='true'}));
    bind('#study-clear',()=>cmd('study.clear'));
  }
  const affect=state.affect,study=state.study;if(!affect||!study)return;
  document.querySelector('#affect-description').textContent=affect.label+(affect.listening?' · 暂时安静听着，新的话题可以继续。':'');
  const names={respect:'希望被好好对待',connection:'想交流和被理解',competence:'想学会一点新东西',novelty:'好奇心',treat:'甜食小心愿'};
  document.querySelector('#affect-needs').innerHTML=Object.entries(affect.needs).map(([k,v])=>`<div class="metric"><span>${names[k]||escape(k)}</span><span>${Math.round(v*100)}%</span></div>`).join('');
  const relationNames={affection:'好感',trust:'信任',respect:'尊重',intimacy:'亲密',understanding:'了解'};
  document.querySelector('#relationship-values').innerHTML='<h3>我们现在的关系</h3>'+Object.entries(state.persona.relationship).map(([k,v])=>`<div class="metric"><span>${relationNames[k]||escape(k)}</span><span>${Math.round(v*100)}</span></div>`).join('');
  document.querySelector('#study-status').textContent=study.status;const toggle=document.querySelector('#study-toggle');toggle.dataset.enabled=String(study.enabled);toggle.textContent=study.enabled?'暂停自主学习':'开启自主学习';
  document.querySelector('#study-history').innerHTML=study.sessions.slice(-6).reverse().map(s=>`<div class="item"><strong>${escape(s.title)}</strong><div class="meta">${s.status==='done'?'已读 · 测试 '+s.score+' 分'+(s.baselineScore!==undefined?' · 学前 '+s.baselineScore+' 分 · 诊断差值 '+s.gain:''):s.status==='reading'?'阅读中':'本次未完成'}</div><p>${escape(s.note||s.error||'正在读资料，还没有学习结论。')}</p>${s.source?.url?`<a href="${escape(s.source.url)}" target="_blank" rel="noopener noreferrer">${s.status==='done'?'阅读来源':'计划阅读的资料'} ↗</a>`:''}${s.details?`<details><summary>查看题目和判分</summary>${s.details.map(d=>`<p>${d.correct?'✓':'×'} ${escape(d.question)}<br>回答：${escape(d.answer)}<br>${escape(d.explanation)}</p>`).join('')}</details>`:''}</div>`).join('')||'<p class="empty">还没有学习记录。机器人、AI、数学、职业探索和日常交流会轮流学习。</p>';
}
