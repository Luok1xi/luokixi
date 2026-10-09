import {characterFeeling,characterName} from './character-card.mjs';
const clamp=n=>Math.max(0,Math.min(1,n));
export function ensureAffect(p,now){
  if(!p.affect){p.affect={version:1,updatedAt:now,needs:{respect:.15,connection:.2,competence:.4,novelty:.35,treat:.3},recent:[],listeningUntil:0,lastTreatAt:null};
    // v1 quiet pressure incorrectly accumulated on every ordinary message. Remove that artifact, not conflicts.
    if(p.inner)p.inner.needs.quiet=Math.min(.25,p.inner.needs.quiet);
  }return p.affect;
}
export function driftAffect(p,now){const a=ensureAffect(p,now),elapsed=Math.max(0,now-a.updatedAt);for(const [k,base]of Object.entries({respect:.15,connection:.2,competence:.4,novelty:.35,treat:.3}))a.needs[k]=base+(a.needs[k]-base)*Math.pow(.5,elapsed/720);a.updatedAt=now;return a;}
export function applyAffect(p,{event,message,now,id}){
  const a=driftAffect(p,now);if(a.recent.some(x=>x.id===id))return;
  if(event==='conflict'){a.needs.respect=clamp(a.needs.respect+.18);p.inner.needs.quiet=clamp(p.inner.needs.quiet+.08);}
  if(event==='explained'){a.needs.respect=clamp(a.needs.respect-.06);p.emotions.annoyed*=.85;}
  if(event==='repaired'){a.needs.respect=clamp(a.needs.respect-.18);p.inner.needs.quiet*=.5;}
  if(['affection','praise','playful'].includes(event))a.needs.connection=clamp(a.needs.connection-.06);
  if(event==='interest')a.needs.novelty=clamp(a.needs.novelty-.05);
  if(event==='treat'&&(a.lastTreatAt===null||now-a.lastTreatAt>=1440)){a.lastTreatAt=now;a.needs.treat=.05;p.emotions.smile=clamp(p.emotions.smile+.2);}
  a.recent.push({id,event:event||'ordinary',source:message.slice(0,300),at:now});a.recent=a.recent.slice(-40);
}
export function affectView(p,now){const a=driftAffect(p,now),e=p.emotions,last=a.recent.at(-1),hurt=e.annoyed>.15||e.sad>.18,blush=e.blush>.12,bright=e.smile>.14||e.proud>.15;
  const mode=p.paused?'assistant':hurt&&blush?'shy_but_hurt':hurt?'pouting':blush?'shy':bright?'bright':last?.event==='playful'?'playful':'warm';
  const feeling=characterFeeling(p,now);
  return {mode,feeling,label:feeling&&feeling.name!=='neutral'?({happy:'开心',sad:'有点低落',angry:'有些生气',think:'在想事情',surprised:'有点意外',awkward:'有点不好意思',question:'有些疑惑',curious:'好奇'})[feeling.name]:({assistant:'普通助理',shy_but_hurt:'有点害羞，也还介意刚才的事',pouting:'有点不高兴，仍愿意好好说',shy:'有点害羞',bright:'开心，想多说一点',playful:'想和你闹着玩',warm:'放松地和你聊天'})[mode],
    warmth:p.paused?0:Math.max(.45,.72-e.annoyed*.15),arousal:clamp(.2+e.smile*.4+e.blush*.4+e.annoyed*.2),
    punctuation:'按句意使用普通标点，不根据情绪强制添加波浪号、省略号或重复感叹号',
    needs:a.needs,lastEvent:last,unresolved:p.conflicts.filter(c=>!c.resolved).length,listening:a.listeningUntil>now};
}
export function silenceDecision(p,message,now){const a=ensureAffect(p,now);
  if(/^(?:你应该不回复我的|(?:请|先)?(?:别|不要|不用)回复我(?:了)?)[。！!\s]*$/.test(message.trim())){a.listeningUntil=now+30;return true;}
  const taunt=/^(?:你|ni|操|滚|傻逼|sb)[。！!\s]*$/i.test(message.trim());
  if(a.listeningUntil>now&&taunt)return true;
  if(a.listeningUntil>now)a.listeningUntil=0; // A new topic or question is a fresh invitation, not a loyalty test.
  return false;
}
