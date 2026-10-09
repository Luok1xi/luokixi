import {createHubClient} from '../../campus/hub-client.js';
import '../styles/ai-controls.css';
const api=createHubClient();
let dialog;
export async function openAIBudget(){
  if(!dialog){
    dialog=document.createElement('dialog');dialog.className='ai-budget';dialog.setAttribute('aria-labelledby','ai-budget-title');
    dialog.innerHTML=`<form><header><h2 id="ai-budget-title">额度设置</h2><button type="button" data-close aria-label="关闭">×</button></header>
      <p data-usage></p><label>DeepSeek 每日上限（元）<input name="dailyCny" type="number" min="0.10" max="100" step="0.01" required></label>
      <label class="check-line"><input name="codexUnlimited" type="checkbox">Codex 对话不设每日次数上限（仍受账号额度限制）</label>
      <label>关闭不限次数时，每日调用次数<input name="codexDailyCalls" type="number" min="1" max="500" step="1" required></label>
      <p class="small-note">每日北京时间 00:00 重置。原版的每月预算仍然有效，可在“记忆与阅读 → 设置”调整。服务商账号的余额与限额由服务商管理。</p>
      <p data-explanation class="small-note"></p><p data-result role="status"></p><button class="btn btn-primary" type="submit">保存额度</button></form>`;
    document.body.append(dialog);dialog.querySelector('[data-close]').onclick=()=>dialog.close();
    dialog.querySelector('form').onsubmit=async e=>{
      e.preventDefault();const button=e.target.querySelector('[type=submit]');button.disabled=true;
      try{const f=new FormData(e.target),data=await api.request('studio/budget',{dailyCny:f.get('dailyCny'),codexDailyCalls:Number(f.get('codexDailyCalls')),codexUnlimited:f.has('codexUnlimited')});
        paint(data);dialog.querySelector('[data-result]').textContent='已保存，下一次调用立即生效。已用额度没有清零。';window.dispatchEvent(new Event('ai-budget-changed'));
      }catch(error){dialog.querySelector('[data-result]').textContent=error.message;}finally{button.disabled=false;}
    };
  }
  if(!dialog.open)dialog.showModal();
  dialog.querySelector('[data-result]').textContent='正在读取…';dialog.querySelector('[type=submit]').disabled=true;
  try{paint(await api.request('studio/budget'));dialog.querySelector('[data-result]').textContent='';dialog.querySelector('[type=submit]').disabled=false;}
  catch(e){dialog.querySelector('[data-result]').textContent=e.message;}
}
function paint(data){
  dialog.querySelector('[name=dailyCny]').value=data.dailyCny;dialog.querySelector('[name=codexDailyCalls]').value=data.codexDailyCalls;
  dialog.querySelector('[name=codexUnlimited]').checked=!!data.codexUnlimited;
  dialog.querySelector('[data-usage]').textContent=`今天已预留 ¥${Number(data.reservedCny).toFixed(4)}，剩余 ¥${Number(data.remainingCny).toFixed(4)}。Codex 已用 ${data.codexCalls} 次，${data.codexUnlimited?"不设次数上限":"剩余 "+data.codexRemaining+" 次"}。`;
  dialog.querySelector('[data-explanation]').textContent=data.explanation;
}
document.addEventListener('click',event=>{if(event.target.closest('[data-ai-budget]'))void openAIBudget();});
