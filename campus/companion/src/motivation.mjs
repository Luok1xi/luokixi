import {voiceVersion,characterCard} from './character-card.mjs';
const clamp=n=>Math.max(0,Math.min(1,n));
export function ensureInnerLife(persona,now){
  persona.inner??={updatedAt:now,needs:{curiosity:.35,creation:.3,expression:.2,quiet:.1},intent:'listen',lastDialogueAt:null,initiativeAttempts:[],styleRules:[],appraisals:[],projects:[{id:'music-sketch',title:'想比较电子音乐里两种不同的节奏感',kind:'roleplay',status:'idea'},{id:'small-creation',title:characterCard.stable.creationIdea,kind:'roleplay',status:'idea'}]};
  return persona.inner;
}
export function driftInnerLife(persona,now){const inner=ensureInnerLife(persona,now),elapsed=Math.max(0,now-inner.updatedAt);inner.needs.quiet*=Math.pow(.5,elapsed/120);inner.needs.curiosity=.35+(inner.needs.curiosity-.35)*Math.pow(.5,elapsed/1440);inner.needs.expression=.2+(inner.needs.expression-.2)*Math.pow(.5,elapsed/1440);inner.updatedAt=now;return inner;}
export function reflectTurn(persona,{message,event=null,styleLearning=null,now,id}){
  const inner=driftInnerLife(persona,now);if(inner.appraisals.some(x=>x.id===id))return;
  // Frequent ordinary conversation is engagement, not fatigue or a reason to become cold.
  if(!event||['interest','praise','affection','playful'].includes(event))inner.needs.quiet=Math.max(.05,inner.needs.quiet-.015);
  if(event==='interest'){inner.needs.curiosity=clamp(inner.needs.curiosity+.12);inner.needs.expression=clamp(inner.needs.expression+.1);}
  if(event==='conflict')inner.needs.quiet=clamp(inner.needs.quiet+.2);
  if(event==='repaired')inner.needs.quiet=clamp(inner.needs.quiet-.1);
  if(styleLearning&&typeof styleLearning.evidence==='string'&&message.includes(styleLearning.evidence)&&typeof styleLearning.rule==='string'&&/说话|语气|回复|回答|问号|提问|反问|追问|问我|简短|啰嗦|太长|字数|人机|客服|网络用语|装萌|卖萌|撒娇|不可爱|冷淡|介绍自己|表情|标点|感叹号|波浪号|省略号|语气词|口头禅|自称/.test(styleLearning.evidence)){
    const item={id,voiceVersion,rule:styleLearning.rule.slice(0,200),source:styleLearning.evidence.slice(0,300),at:now,kind:'user-style-preference'};
    inner.styleRules=inner.styleRules.filter(r=>r.rule!==item.rule).concat(item).slice(-8);
  }
  inner.intent=persona.paused?'assist':inner.needs.quiet>.65?'keep_brief':event==='interest'?'explore_together':event==='conflict'?'state_boundary':'respond';
  inner.appraisals.push({id,event:event||'ordinary',at:now,reason:event==='conflict'?'明确事件引发保留意见；不扣留助理功能':event==='interest'?'共同兴趣激发探索与表达':'先回应当前话语，不预设追问'});inner.appraisals=inner.appraisals.slice(-80);inner.lastDialogueAt=now;
}
