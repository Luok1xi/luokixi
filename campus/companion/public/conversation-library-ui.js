const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);

export function renderConversationLibrary(state,{api,cmd,notify}){
  if(!document.querySelector('#breakfast-habit')){
    const form=document.createElement('form');form.id='breakfast-habit';form.className='card form-grid';
    form.innerHTML='<h2 class="full">早餐习惯</h2><p class="full muted">8—9 点只是当前的生活参考。填写后才记作你的习惯，用于理解聊天，不自动创建提醒或移动课程。</p><label>通常开始<input name="start" type="time" required></label><label>通常结束<input name="end" type="time" required></label><button class="primary">记住我的习惯</button>';
    document.querySelector('#settings').append(form);
    const habit=state.settings.breakfastHabit||{start:'08:00',end:'09:00'};
    form.elements.start.value=habit.start;form.elements.end.value=habit.end;
    form.onsubmit=async event=>{event.preventDefault();try{await cmd('life.breakfast',Object.fromEntries(new FormData(form)));}catch(e){notify(e.message,true);}};
  }
  if(document.querySelector('#conversation-library'))return;
  const card=document.createElement('section');card.id='conversation-library';card.className='card';
  card.innerHTML=`<h2>一起看一段聊天</h2><p class="muted">导入你选定的片段，请先取得参与者同意并移除无关隐私。自动采集的会话也可在这里核对；实际读取状态请看上方。不会自动回复他们。</p>
    <form id="conversation-import" class="form-grid"><label>片段名称<input name="title" maxlength="100" required placeholder="例如：机器人竞赛报名"></label><label>内容类型<select name="kind"><option value="competition">竞赛群与通知</option><option value="personal">私人聊天与沟通</option></select></label>
    <label class="full">粘贴聊天原文<textarea name="rawText" rows="6" maxlength="16000" placeholder="保留发言人和时间，便于结合上下文理解。"></textarea></label>
    <label class="full">或选择本机文件（TXT / JSON）<input name="file" type="file" accept=".txt,.json,text/plain,application/json"></label>
    <details class="full"><summary>结构化文件格式</summary><p>JSON 文件是消息数组，每条包含 sender（发言人）、text（原文）、at（北京时间，未知时为 null）。每次最多 200 条、合计 16000 字。</p><pre>[{"sender":"队长","text":"周五交材料","at":"2026-09-26 10:00"}]</pre><p>纯文本会保留原文，不会把导入时间冒充消息时间。</p></details>
    <label class="full check"><input name="append" type="checkbox"> 追加到下方选中的片段（相同消息自动去重）</label><button class="primary">保存这段聊天</button></form>
    <div class="actions"><label>已保存的片段<select id="conversation-source"><option value="">请选择</option></select></label><button id="conversation-reload">刷新列表</button><button id="conversation-analyze" class="primary" disabled>请 她 帮我看看</button><button id="conversation-delete" disabled>删除片段与分析</button></div>
    <p class="meta">保存仅写入本机。点击分析才将当前片段发送给已配置的模型；每次最多分析最近导入的 60 条、16000 字。手动分析结果不主动推送；自动采集的重要发现会由 她 私下告诉你。</p>
    <p id="conversation-status" role="status"></p><div id="conversation-result"></div><details><summary>核对导入原文</summary><div id="conversation-original"></div></details>`;
  document.querySelector('#research').append(card);
  const get=id=>card.querySelector(id),select=get('#conversation-source');let selected=null,epoch=0,busy=false;
  const buttons=()=>{get('#conversation-analyze').disabled=busy||!select.value;get('#conversation-delete').disabled=!select.value;};
  const clear=()=>{epoch++;selected=null;get('#conversation-original').replaceChildren();get('#conversation-result').replaceChildren();get('#conversation-status').textContent='';};
  async function list(preferred=select.value){const data=await api('/api/conversations');select.innerHTML='<option value="">请选择</option>'+data.sources.map(s=>`<option value="${esc(s.id)}">${esc(s.title)} · ${s.count} 条</option>`).join('');select.value=data.sources.some(s=>s.id===preferred)?preferred:'';buttons();}
  const evidence=items=>(items||[]).map(e=>{const row=selected?.messages.find(m=>m.id===e.messageId);return `<blockquote>${esc(e.quote)}<br><small>${esc(row?.sender)} · ${esc(row?.sentAt||'时间未标注')}</small></blockquote>`;}).join('');
  function result(data){
    if(!data){get('#conversation-result').replaceChildren();return;}
    get('#conversation-result').innerHTML=`<div class="card"><h3>她 的想法</h3><p style="white-space:pre-wrap">${esc(data.text||data.summary)}</p></div>${data.advice.map(a=>`<details><summary>${esc(a.text)}</summary>${evidence(a.evidence)}</details>`).join('')}${data.todos.map((t,i)=>`<article class="card"><h3>${esc(t.title)}</h3><p>截止原文：${esc(t.deadlineText||'未明确，需要确认')}</p><ol>${t.steps.map(s=>`<li>${esc(s)}</li>`).join('')}</ol>${evidence(t.evidence)}<button data-todo="${i}">填写工时并确认待办</button></article>`).join('')}${data.uncertainties.length?`<p>还不确定：${data.uncertainties.map(esc).join('；')}</p>`:''}`;
    get('#conversation-result').querySelectorAll('[data-todo]').forEach(button=>{button.onclick=()=>{const todo=data.todos[Number(button.dataset.todo)],form=document.querySelector('#task-form');document.querySelector('#task-reset').click();form.elements.title.value=todo.title.slice(0,200);form.elements.priority.value=todo.priority;form.elements.deadline.value='';form.elements.remaining.value='';document.querySelector('nav [data-tab="tasks"]').click();form.elements.deadline.focus();notify('请确认这是你的任务，并填写真实截止时间和剩余工时。');};});
  }
  async function open(){clear();buttons();if(!select.value)return;const token=epoch,id=select.value;const data=await api('/api/conversations/read?id='+encodeURIComponent(id));if(token!==epoch)return;selected=data;get('#conversation-original').innerHTML=data.messages.map(m=>`<p><strong>${esc(m.sender)}</strong> <small>${esc(m.sentAt||'时间未标注')}</small><br><span style="white-space:pre-wrap">${esc(m.text)}</span></p>`).join('');result(data.analysis);}
  const guard=fn=>async(...args)=>{try{await fn(...args);}catch(e){notify(e.message,true);}};
  select.onchange=guard(open);get('#conversation-reload').onclick=guard(async()=>{await list();await open();});
  get('#conversation-import').onsubmit=guard(async event=>{
    event.preventDefault();const form=event.currentTarget,file=form.elements.file.files[0],input={title:form.elements.title.value,kind:form.elements.kind.value};
    if(form.elements.append.checked){if(!select.value)throw Error('请先选择要追加的片段。');input.sourceId=select.value;}
    if(file){if(file.size>200000)throw Error('文件过大，请先选取一小段聊天。');const content=await file.text();if(file.name.toLowerCase().endsWith('.json'))input.messages=JSON.parse(content);else input.rawText=content;}else input.rawText=form.elements.rawText.value;
    const button=form.querySelector('button');button.disabled=true;
    try{const saved=await api('/api/conversations/import',input);form.reset();await list(saved.sourceId);await open();notify(`已保存 ${saved.added} 条，尚未调用模型。`);}finally{button.disabled=false;}
  });
  get('#conversation-analyze').onclick=guard(async()=>{const id=select.value,token=epoch;busy=true;buttons();get('#conversation-status').textContent='她 正在结合原文思考…';try{const data=await api('/api/conversations/analyze',{sourceId:id});if(token===epoch){result(data);get('#conversation-status').textContent='分析完成，可以展开核对原文。';}}catch(e){if(token===epoch)get('#conversation-status').textContent='暂时没能分析，已保存的原文仍在。'+e.message;throw e;}finally{busy=false;buttons();}});
  get('#conversation-delete').onclick=guard(async()=>{const id=select.value;clear();select.value='';buttons();await api('/api/conversations/remove',{sourceId:id});await list('');notify('已删除这份片段及其分析。');});
  guard(list)();
}
