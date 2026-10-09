import {randomUUID} from 'node:crypto';
import {text,integer} from './time.mjs';

export function ensureResearch(s){
  return s.research??={version:1,enabled:true,epoch:0,at:'09:00',goals:[],sources:[],notices:[],items:[],runs:[],lastDay:null,status:'添加目标或信息源后，每天检查一次。'};
}
export function sourceUrl(value){
  let u;try{u=new URL(value);}catch{throw new Error('请输入完整的 HTTPS 网址。');}
  if(u.protocol!=='https:'||u.username||u.password||(u.port&&u.port!=='443')||u.hash||u.hostname.endsWith('.local')||!u.hostname.includes('.')||/^\[|^\d+\./.test(u.hostname))throw new Error('信息源只接受公开网站的 HTTPS 地址，不接受本机地址、账号或特殊端口。');
  if(u.href.length>2000)throw new Error('网址太长。');return u.href;
}
export function researchCommand(s,action,args,now){
  const r=ensureResearch(s);let message='已保存。';
  const pick=(list)=>{const row=list.find(x=>x.id===args.id);if(!row)throw new Error('记录不存在。');return row;};
  switch(action){
    case 'research.goal':{
      const title=text(args.title,300),evidence=text(args.evidence||args.title,2000);
      const keywords=String(args.keywords||'').trim();
      if(keywords.length>180||/[\r\n<>]/.test(keywords))throw new Error('公开检索词最多 180 字，不能包含换行。');
      if(r.goals.filter(g=>g.active).length>=12)throw new Error('请先精简到 12 个以内的关注目标。');
      if(r.goals.some(g=>g.active&&g.title===title))return {message:'这个目标已经记录。'};
      r.goals.push({id:randomUUID(),title,evidence,keywords,kind:args.kind==='interest'?'interest':'goal',active:true,createdAt:now});message='已记录你明确提出的目标。公开检索只使用你填写的检索词。';break;
    }
    case 'research.goal.remove':{const g=pick(r.goals);g.active=false;message='已停止关注这个目标。';break;}
    case 'research.source':{
      const url=sourceUrl(args.url);if(r.sources.some(x=>x.url===url))return {message:'这个信息源已经添加。'};
      if(r.sources.length>=12)throw new Error('第一版最多配置 12 个信息源。');
      r.sources.push({id:randomUUID(),url,title:text(args.title,100),kind:args.kind==='feed'?'feed':'page',category:['library','sports','school','field'].includes(args.category)?args.category:'school',enabled:true,at:now});message='已添加公开信息源；只检查该页或订阅，不登录、不预约。';break;
    }
    case 'research.source.remove':r.sources=r.sources.filter(x=>x.id!==pick(r.sources).id);break;
    case 'research.notice':{
      const body=text(args.text,12000);if(r.notices.some(n=>n.text===body))return {message:'这份通知已经收到，不会重复整理。'};
      if(r.notices.length>=200)throw new Error('通知手账已满，请清理旧资料后再添加。');
      r.notices.push({id:randomUUID(),text:body,title:text(args.title||'转发的学校通知',100),at:now,status:'pending'});message='已收下通知，下一次资料整理会分类并生成待办草稿。原文不会被当成操作指令。';break;
    }
    case 'research.settings':{
      if(typeof args.enabled!=='boolean')throw new Error('开关值不正确。');r.enabled=args.enabled;
      if(args.at!==undefined){if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(args.at))throw new Error('每日检查时间无效。');r.at=args.at;}
      message=r.enabled?'已开启每日资料检查。':'已暂停资料检查及待发送的资料推送。';break;
    }
    case 'research.feedback':{const item=pick(r.items);if(!['useful','irrelevant','dismissed'].includes(args.value))throw new Error('反馈值无效。');item.feedback=args.value;item.feedbackAt=now;message='已记录；之后筛选会参考这条反馈，不改变好感或关系。';break;}
    case 'research.clear':r.items=[];r.notices=[];r.runs=[];r.status='资料与笔记已清理，目标和信息源保留。';message=r.status;break;
    default:throw new Error('未知的资料操作。');
  }
  r.epoch++;return {message};
}

export function researchContext(s){const r=ensureResearch(s);return {goals:r.goals.filter(g=>g.active),sources:r.sources.map(({id,title,category})=>({id,title,category})),status:r.status,notes:r.items.filter(x=>x.feedback!=='dismissed'&&x.feedback!=='irrelevant').slice(-5).map(({id,title,note,goalIds,source,evidence,steps,status,discussedAt,sharedAt})=>({id,title,note,goalIds,source,evidence,steps,status,discussedAt,sharedAt}))};}
