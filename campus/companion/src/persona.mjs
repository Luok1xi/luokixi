import {characterCard,characterCardPrompt,voiceTraits,voiceVersion,identityVersion} from './character-card.mjs';
import {driftInnerLife} from './motivation.mjs';
import {driftAffect} from './affect.mjs';
export const personality={name:characterCard.name,identity:characterCard.stable.identity,address:'你',traits:[...voiceTraits],interests:[...characterCard.stable.interests],values:['尊重现实生活和自主选择','不伪造记忆与执行结果','亲密关系不与学习成绩交换'],boundaries:['不索取排他关系','不以情绪扣留提醒或帮助','未回复不等于失信','情绪与身体体验属于角色模拟']};
export const relationshipDefaults={affection:.2,trust:.3,respect:.6,intimacy:.05,understanding:.05};
export const stageLabels={new:'初识',familiar:'熟悉',close:'亲近',affectionate:'暧昧',together:'双方确认关系'};
export const expressions=['neutral','smile','blush','annoyed','concerned','sad','proud','curious'];
export function newPersona(now){return {voiceVersion,identityVersion,stable:structuredClone(personality),relationship:{...relationshipDefaults},stage:'new',paused:false,emotions:{smile:0,blush:0,annoyed:0,concerned:0,sad:0,proud:0,curious:.08},updatedAt:now,events:[],conflicts:[],milestones:[]};}
export function decay(p,now){const elapsed=Math.max(0,now-p.updatedAt);for(const key of Object.keys(p.emotions))p.emotions[key]*=Math.pow(.5,elapsed/(key==='sad'?2880:key==='concerned'?1440:720));p.updatedAt=now;driftInnerLife(p,now);driftAffect(p,now);}
export function recordEvent(p,kind,source,now,id,{conflictId}={}){
  decay(p,now);if(p.events.some(e=>e.id===id))return;
  const rules={completed:{emotions:{proud:.18}},explained:{emotions:{concerned:.06},relationship:{understanding:.01}},tired:{emotions:{concerned:.18}},interest:{emotions:{curious:.17,smile:.08},relationship:{understanding:.02}},praise:{emotions:{blush:.2,smile:.1}},conflict:{emotions:{annoyed:.2,sad:.1}},repaired:{emotions:{annoyed:-.18,sad:-.09,smile:.08}},greeting:{emotions:{smile:.1}},remembered:{emotions:{curious:.1}}};
  Object.assign(rules,{affection:{emotions:{blush:.25,smile:.14}},playful:{emotions:{smile:.12}},treat:{},respected:{emotions:{smile:.1},relationship:{trust:.008,respect:.008}},shared:{emotions:{curious:.12},relationship:{understanding:.015,affection:.008}}});
  const r=rules[kind];if(!r)return;
  const count=p.events.filter(e=>e.kind===kind&&Math.floor((e.at+480)/1440)===Math.floor((now+480)/1440)).length;
  if(count<3)for(const part of ['emotions','relationship'])for(const[k,v]of Object.entries(r[part]||{}))p[part][k]=Math.max(0,Math.min(1,p[part][k]+v));
  if(kind==='conflict'){p.conflicts.push({id,source,at:now,resolved:false});p.conflicts=p.conflicts.slice(-80);if(count<3)p.relationship.trust=Math.max(0,p.relationship.trust-.008);}
  if(kind==='repaired'){const target=conflictId?p.conflicts.find(c=>c.id===conflictId&&!c.resolved):p.conflicts.filter(c=>!c.resolved).at(-1);if(target){target.resolved=true;target.resolvedAt=now;p.relationship.trust=Math.min(1,p.relationship.trust+.004);}}
  p.events.push({id,kind,source,at:now});p.events=p.events.slice(-200);
}
export function expression(p){if(p.paused)return'neutral';return Object.entries(p.emotions).filter(([,v])=>v>.08).sort((a,b)=>b[1]-a[1])[0]?.[0]||'neutral';}
export const personaDescription=p=>({neutral:'平静地陪着你',smile:'心情有一点明亮',blush:'耳朵尖有点发烫',annoyed:'有点介意，仍会认真听',concerned:'想给你留一点余地',sad:'还在慢慢整理心情',proud:'为你的进展感到欣慰',curious:'对你的世界有点好奇'})[expression(p)];
export const personaPrompt=characterCardPrompt+'\n关系和任务以真实记录为准；初期称呼你，之后按约定称呼。亲切不依赖好感分数。用户暂停角色互动时提供普通助理服务。';
