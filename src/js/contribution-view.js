import {hubApi} from './hub.js';
import {mountCity} from './heatmap.js';
import {esc} from './data.js';
import '../styles/contribution-view.css';
export function mountContribution(root,user){
 let disposed=false,cleanup;
 root.innerHTML='<p>正在读取贡献记录…</p>';
 (async()=>{try{
  const r=user?await hubApi.contributions({username:user.username}):{items:[],total:0};if(disposed)return;
  const end=new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'}),t=Date.parse(end+'T00:00:00Z')-363*86400000,counts=Array(364).fill(0);
  for(const x of r.items){const i=Math.floor((Date.parse(x.date+'T00:00:00Z')-t)/86400000);if(i>=0&&i<counts.length)counts[i]++;}
  root.innerHTML=`<div class="contribution-wave"><canvas aria-label="过去一年已采纳贡献的立体波形"></canvas><p>${counts.some(Boolean)?'柱高对应有效贡献；下方可查看记录。':'目前没有贡献数据，波纹只是等待共建的装饰动画。'}</p></div><p class="contribution-note">${user?`累计 ${r.total} 次有效贡献。显示最近 ${r.items.length} 条可见记录，不包含收藏或外部刷题。`:'登录后查看自己的真实贡献。'}</p><div class="contribution-records">${r.items.slice(0,100).map(x=>`<article><time>${esc(x.date)}</time><b>${esc(x.summary)}</b><span>${esc(x.category)}</span></article>`).join('')}</div>`;
  cleanup=mountCity(root.querySelector('canvas'),{start:new Date(t).toISOString().slice(0,10),counts},{unit:'次有效贡献'});
 }catch(e){if(!disposed)root.textContent=e.message;}})();
 return()=>{disposed=true;cleanup?.();};
}
