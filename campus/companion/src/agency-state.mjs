import {characterCard} from './character-card.mjs';
export function ensureAgency(s,now){
  s.agency??={version:1,enabled:true,epoch:0,dailyLimit:3,monthlyLimit:10,lastAt:null,updatedAt:now,needs:{curiosity:.55,creation:.4,expression:.25},runs:[],artifacts:[]};
  const a=s.agency,days=Math.max(0,Math.min(7,(now-a.updatedAt)/1440));
  // Current preference: reading diaries, with music creation paused. Keep older artifacts as history.
  if((a.preferenceVersion||0)<2){a.preferenceVersion=2;a.creationEnabled=false;a.shareIdleMinutes=30;a.shareStyle='diary';}
  if((a.conversationVersion||0)<2){a.conversationVersion=2;a.dailyBurstLimit=6;a.maxUnanswered=0;a.shareCheckLimit=12;}
  // People stop texting after a few unanswered messages; 0 used to mean unlimited.
  if((a.conversationVersion||0)<3){a.conversationVersion=3;if(!a.maxUnanswered)a.maxUnanswered=3;}
  a.interests??={study:['能源与矿业','机器人','AI','数学','学习方法'],leisure:['动漫','J-pop','音乐创作'],reflection:['哲学思考','社会上有意思的事情'],source:'用户明确指定：学习之余喜欢动漫、音乐和创作，知乎优先哲学与学习'};
  // The 2026-10-06 redesign adds the character's own field without dropping interests the user chose.
  if((a.interestsVersion||0)<2){a.interestsVersion=2;if(!a.interests.study.includes('能源与矿业'))a.interests.study.unshift('能源与矿业');}
  if(characterCard.id==='codex'&&!a.characterInterests){a.interests={study:characterCard.stable.interests,leisure:['游戏','音乐','设计'],reflection:['技术与人的关系'],source:'Codex 独立人格卡'};a.characterInterests='codex';}
  // Interest replenishes with time, independently of whether the user replies.
  for(const [key,target] of Object.entries({curiosity:.65,creation:.55,expression:.25}))a.needs[key]=target+(a.needs[key]-target)*Math.exp(-days*.3);
  a.updatedAt=now;return a;
}
export function agencyContext(s,now){const a=ensureAgency(s,now);return {enabled:a.enabled,interests:a.interests,needs:a.needs,creationEnabled:a.creationEnabled,shareStyle:a.shareStyle,meaning:'角色动机，不是用户需要满足的义务。当前暂停歌曲及虚构作品创作，保留真实阅读与工作记录，自主决定是否分享；音乐仍然是兴趣。旧作品只是历史，不代表正在创作。',recent:a.runs.slice(-3).map(({action,status,reason,result})=>({action,status,reason,result})),artifacts:a.creationEnabled?a.artifacts.slice(-2):[]};}
