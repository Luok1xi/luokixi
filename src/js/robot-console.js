import {createHubClient} from '../../campus/hub-client.js';
import {esc} from './data.js';
import '../styles/robot-console.css';
const client=createHubClient();
const labels={queued:'排队',running:'执行中',done:'完成',failed:'失败',partial:'部分完成',published:'已上架',escalated:'待补充',withdrawn:'已下架'};
const metrics={examined:'检查',discovered:'发现',collected:'新增',refreshed:'更新',skipped:'跳过',published:'上架',escalated:'待补充',classified:'分类',questions:'题目',generated:'导读',cached:'缓存',illustrated:'配图',broken:'失效'};
const operations={run_robot:'运行机器人',review_content:'审核内容',edit_content:'编辑内容',withdraw_content:'下架内容',restore_content:'恢复内容',curate_project:'整理项目',code_candidate:'提交候选',code_test:'测试候选',code_apply:'应用修复',code_rollback:'回退修复',skill_review:'评估技能',skill_install:'安装技能',tool_install:'安装工具',tool_run:'试用工具',discuss:'找搭档讨论'};
const num=n=>Number.isFinite(n)?n.toLocaleString('zh-CN'):'未测';
export function mountRobotConsole(root){
 let stopped=false,timer,busy=false,signature='';
 async function update(){
  if(stopped||busy||document.hidden)return;busy=true;
  try{
   const d=await client.request('studio/robots');if(stopped)return;
   const nextSignature=JSON.stringify({...d,at:undefined});
   if(nextSignature===signature)return;
   const expanded=[...root.querySelectorAll('details')].map(e=>e.open);
   const focusedRefresh=document.activeElement?.matches('[data-robots-refresh]');
   signature=nextSignature;
   const seats=d.seats.map(s=>`<article><h3>${s.seat==='codex'?'Codex':'北矿娘'}</h3><p><strong>${s.reviewed}</strong> 审核 · <strong>${s.published}</strong> 上架 · ${s.dismissed} 不采用</p><p class="small-note">平均排队 ${s.meanQueueSeconds===null?'未测':num(Math.round(s.meanQueueSeconds/60))+' 分钟'} · ${s.failedActions} 次执行失败</p><p>${Object.entries(s.actions).map(([k,v])=>`${esc(operations[k]||k)} ${v}`).join(' · ')||'本周期暂无维护工具执行记录'}</p></article>`).join('');
   root.innerHTML=`<header class="section-heading"><div><p class="section-label">实际运行记录 · 近 ${d.days} 天</p><h2>机器人工作台</h2></div><button type="button" class="btn btn-secondary" data-robots-refresh>刷新</button></header><p>${d.policy.enabled?'两位原版角色已启用自主维护':'自主维护暂停'} · ${d.policy.dailyConversationLimit===null?'对话次数不设每日上限':'每日调用上限 '+d.policy.dailyConversationLimit}</p><div class="robot-seats">${seats}</div>
    <div class="robot-table-wrap"><table><caption>搜寻、整理与维护效率</caption><thead><tr><th>机器人</th><th>最近状态</th><th>实际处理</th><th>成功率</th><th>平均耗时</th><th>检查 / 分钟</th></tr></thead><tbody>${d.robots.map(r=>`<tr><th scope="row">${esc(r.name)}<small>${esc(r.function)}</small></th><td>${r.latest?esc(labels[r.latest.state]||r.latest.state):'尚无运行记录'}${r.latest?.error?`<details><summary>错误</summary>${esc(r.latest.error)}</details>`:''}</td><td>${Object.entries(r.counts).map(([k,v])=>`${esc(metrics[k]||k)} ${v}`).join(' · ')||'—'}</td><td>${r.successRate===null?'未测':Math.round(r.successRate*100)+'%'}</td><td>${r.meanDurationMs===null?'未测':num(Math.round(r.meanDurationMs/1000))+' 秒'}</td><td>${num(r.examinedPerMinute)}</td></tr>`).join('')}</tbody></table></div><p class="small-note">${esc(d.measurement)}</p>
    ${d.coverage?`<details class="robot-coverage"><summary>项目整理进度：${d.coverage.chineseGuides} / ${d.coverage.projects} 份中文导读 · ${d.coverage.withPackages} 个项目有本站下载</summary><div class="robot-table-wrap"><table><thead><tr><th>项目</th><th>中文导读</th><th>已保存文件</th><th>仍需处理</th></tr></thead><tbody>${d.coverage.items.map(p=>`<tr><td>${esc(p.repository)}<small>★ ${num(p.stars)}</small></td><td>${p.guide==='reviewed'?p.chapters+' 章 · 已核对':p.guide==='pending'?'等待核对':'待生成'}</td><td>${p.packages}</td><td>${esc(p.error||'—')}</td></tr>`).join('')}</tbody></table></div></details>`:''}
    ${d.tools?.length?`<details><summary>可安装工具与真实试验记录</summary><ul>${d.tools.map(t=>`<li><b>${esc(t.name)}</b> · ${t.state==='ready'?'已安装，试运行通过':t.state==='installing'?'正在下载与测试':t.state==='failed'?'安装失败':'可自主评估安装'}<p>${esc(t.purpose)}</p><small>${esc(t.license)} · ${(t.packages||[]).map(p=>esc(p.join(' '))).join(' / ')}</small>${t.receipt?.durationMs?`<p>安装与测试 ${num(t.receipt.durationMs)} 毫秒</p>`:''}${t.receipt?.error?`<p>${esc(t.receipt.error)}</p>`:''}<a href="${esc(t.source)}" target="_blank" rel="noopener">官方来源</a></li>`).join('')}</ul></details>`:''}
    <details><summary>接入的项目与范围</summary><ul>${d.integrations.map(i=>`<li><a href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.name)}</a> · ${esc(i.mode)}</li>`).join('')}</ul></details>
    <details ${d.recent.some(r=>r.state==='failed')?'open':''}><summary>最近维护与未解决记录</summary><ol class="robot-receipts">${d.recent.map(r=>`<li><time>${esc(new Date(r.at).toLocaleString('zh-CN'))}</time><b>${r.seat==='codex'?'Codex':'北矿娘'}</b> ${esc(operations[r.operation]||r.operation)} · ${esc(labels[r.state]||r.state)}${r.error?`<p>${esc(r.error)}</p>`:''}${r.result?.state?`<span>执行结果：${esc(labels[r.result.state]||r.result.state)}</span>`:''}</li>`).join('')||'<li>还没有维护工具记录</li>'}</ol></details>`;
   [...root.querySelectorAll('details')].forEach((e,i)=>{if(expanded[i]!==undefined)e.open=expanded[i];});
   if(focusedRefresh)root.querySelector('[data-robots-refresh]')?.focus({preventScroll:true});
  }catch(e){if(!stopped&&!root.querySelector('table'))root.textContent=e.message;}
  finally{busy=false;clearTimeout(timer);if(!stopped)timer=setTimeout(update,15000);}
 }
 root.addEventListener('click',e=>{if(e.target.closest('[data-robots-refresh]'))void update();});
 const visibility=()=>{if(!document.hidden)void update();};document.addEventListener('visibilitychange',visibility);
 void update();return()=>{stopped=true;clearTimeout(timer);document.removeEventListener('visibilitychange',visibility);};
}
