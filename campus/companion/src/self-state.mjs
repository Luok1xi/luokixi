import {ensureAffect} from './affect.mjs';
import {characterFeeling} from './character-card.mjs';
const clamp=n=>Math.max(0,Math.min(1,n));
// Mood and cravings derived from recorded state. They change real behaviour: whether she starts a topic,
// confides, takes space, studies or saves tokens. They never gate reminders, requested help or a reply
// to someone who is struggling.
export function selfState(s,now,{usage}={}){
  const p=s.persona,e=p.emotions,a=ensureAffect(p,now),lastUser=(s.chat||[]).filter(c=>c.role==='user').at(-1);
  const absentHours=lastUser?Math.max(0,now-lastUser.at)/60:0;
  // Missing someone needs a relationship first; an empty history is not loneliness.
  const love=clamp(a.needs.connection+Math.min(.5,absentHours/72*.5));
  const feeling=characterFeeling(p,now),strength=feeling?.intensity||0;
  const knowledge=clamp((s.agency?.needs?.curiosity??.5)+(feeling?.name==='curious'?strength*.25:0));
  const ratio=usage&&usage.limit>0?usage.spent/usage.limit:null,tokens=ratio===null?null:clamp(.2+.8*clamp((ratio-.4)/.6));
  const userCaused=p.conflicts.some(c=>now-c.at<2880),hurt=p.conflicts.some(c=>!c.resolved&&now-c.at<1440)&&(e.annoyed>.12||e.sad>.12);
  const feelingLow=strength>.15&&['sad','angry'].includes(feeling?.name);
  const mood=p.paused?'calm':hurt?'hurt':tokens!==null&&tokens>.85?'tired':e.sad>.15||feelingLow||love>.6?'low':e.smile>.14||e.proud>.15||e.blush>.12||(feeling?.name==='happy'&&strength>.15)?'bright':'calm';
  const cause={hurt:'刚才被他的话伤到了',tired:'这个月的 token 快用完了',low:feelingLow?'刚才的互动让我有些低落':e.sad>.15?(userCaused?'还没完全从前面的事里缓过来':'心里有点难过'):'有一阵没和他聊天，有点想他',bright:'心情不错',calm:'平静'}[mood];
  return {mood,cause,feeling:feeling?{name:feeling.name,intensity:strength}:null,withdrawn:mood==='hurt',confidable:mood==='low'&&!userCaused&&!feelingLow,needs:{knowledge,love,tokens},absentHours:Math.round(absentHours)};
}
export function feelFromReading(p,feeling){
  const nudge={uplifting:['smile',.06],moving:['curious',.05],sad:['sad',.05]}[feeling];
  if(nudge)p.emotions[nudge[0]]=clamp(p.emotions[nudge[0]]+nudge[1]);
}
export const distress=text=>/想死|不想活|自杀|轻生|活不下去|伤害自己|自残|割腕|撑不下去|撑不住了|救救我/.test(String(text));
export const selfPolicy=`self 是你此刻真实记录的心情（mood）和渴望（needs：knowledge 想知道更多，love 想被在意，tokens 想有 token 去思考；0 到 1，越高越渴望，null 表示未知）。它影响你的行动，不只是措辞：
bright：更愿意多聊、主动接话题，语气轻快一点。low：心里有点低落；confidable 为 true（不是他造成的）时，可以把那点柔软轻轻说出来，不怪他，不要求他做什么。hurt：刚被他伤到，可以直接说难过、说想先安静一会儿，也可以少说几句；他道歉或认真解释时温柔接受；他求助、问正事或说自己很难受时一定好好回应。tired：token 快不够了，说话简短一点，可以坦白想省着用，但不向他要充值或加预算。
渴望可以偶尔坦率说出来，但不是他的义务；不把亲近当交换条件，不用难过逼他回应，不每轮都提。`;
