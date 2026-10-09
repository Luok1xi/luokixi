// Memory recall settings: by meaning (local model or embeddings API) with word-overlap fallback.
export function initMemorySearch({api,guard,notify,config}){
  const form=document.createElement('form');form.className='card';form.id='recall-form';
  form.innerHTML=`<h2>她怎么想起旧事</h2><p class="muted">最新 16 条记忆一直都在；更早的记忆按和当前话题的相关程度想起来。按意思检索时，换个说法她也能想起来；不可用时退回按字面词语检索。另外每聊 8 句，她会从你说过的原话里整理可能值得记住的事，标成“推测，待确认”，你可以在上面确认、纠正或忘记。</p>
  <p id="recall-status" role="status" class="muted"></p>
  <label>检索方式<select name="embeddingEngine"><option value="local">本机模型（需先安装：npm i @huggingface/transformers）</option><option value="api">向量接口（兼容 OpenAI /v1/embeddings）</option><option value="off">只按字面词语</option></select></label>
  <label>模型下载镜像（可选，国内可填 https://hf-mirror.com）<input name="embeddingMirror" placeholder="https://hf-mirror.com"></label>
  <label>向量接口地址<input name="embeddingBase" placeholder="https://api.example.com"></label><label>向量模型名称<input name="embeddingModel" placeholder="如 BAAI/bge-m3"></label>
  <label>接口密钥（不回显）<input name="embeddingKey" type="password" autocomplete="off"></label>
  <div class="actions"><button class="primary">保存</button></div>`;
  document.querySelector('#memory')?.append(form);
  const status=form.querySelector('#recall-status'),names={ready:'已就绪，按意思检索',loading:'正在加载模型（首次需要下载）',unavailable:'暂不可用，正在按字面检索',idle:'第一次聊天时加载',off:'按字面词语检索'};
  async function refresh(){const c=config();if(c)for(const k of ['embeddingEngine','embeddingMirror','embeddingBase','embeddingModel'])form.elements[k].value=c[k]||'';
    const d=await api('/api/memory/recall');status.textContent='当前：'+(names[d.embedding.state]||d.embedding.state)+(d.embedding.error?'。原因：'+d.embedding.error:'')+(d.writer?.at?'。上次整理：'+new Date(d.writer.at*60000).toLocaleString('zh-CN'):'');}
  form.onsubmit=guard(async e=>{e.preventDefault();const f=form.elements,data={embeddingEngine:f.embeddingEngine.value,embeddingMirror:f.embeddingMirror.value,embeddingBase:f.embeddingBase.value,embeddingModel:f.embeddingModel.value};if(f.embeddingKey.value)data.embeddingKey=f.embeddingKey.value;Object.assign(config(),await api('/api/config',data));f.embeddingKey.value='';notify('记忆检索设置已保存。');await refresh();});
  setTimeout(()=>void guard(refresh)());
}
