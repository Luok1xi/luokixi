// Owner art and expression-only edits of that same costume. Never sets personality or permissions.
const art='/art/companions/';
export const stageCast={
  beikuang:{name:'北矿娘',appearance:'黑红长发、矿灯与笔记本，黑白红金校园服装',
    poses:{neutral:art+'beikuang-neutral.png',happy:art+'beikuang-happy-v2.png',angry:art+'beikuang-angry-v2.png',think:art+'beikuang-think-v2.png',sad:art+'beikuang-sad-v2.png',awkward:art+'beikuang-awkward-v2.png',surprised:art+'beikuang-surprised-v2.png'}, reaction:art+'beikuang-chibi.png'},
  codex:{name:'Codex',appearance:'银白长发、龙角、淡紫眼睛、白色长裙、龙翼与尾巴',
    poses:{neutral:art+'codex-neutral.png',composed:art+'codex-composed.png',happy:art+'codex-happy.png',
      angry:art+'codex-angry.png',think:art+'codex-think.png',sad:art+'codex-sad.png',awkward:art+'codex-awkward.png'}},
};
export function stagePose(seat,emotion='neutral',activity='idle'){
  const actor=stageCast[seat];if(!actor)return null;
  const state=activity==='thinking'?'think':actor.poses[emotion]?emotion:({curious:'think',question:'think',surprised:'think',sleepy:'composed'})[emotion]||emotion;
  return {name:actor.name,pose:actor.poses[state]?state:'neutral',url:actor.poses[state]||actor.poses.neutral};
}
export function stageLines(runs){
  return [...(runs||[])].reverse().flatMap(run=>(run.messages||[]).filter(m=>stageCast[m.seat]&&m.body).flatMap(m=>(m.messages?.length?m.messages:[{type:'text',text:m.body}]).flatMap((p,i)=>p.type==='text'?[{
    id:run.id+':'+m.id+':'+i,seat:m.seat,text:p.text,speech:p.speech||'',emotion:p.expression||m.expression||m.emotion?.name||'neutral',historical:true,
  }]:[])));
}
export function stageTurn(run){
  if(!run||!['queued','running'].includes(run.state))return null;
  const seat=run.seats?.[(run.messages?.length||0)%run.seats.length];
  return stageCast[seat]?seat:null;
}
