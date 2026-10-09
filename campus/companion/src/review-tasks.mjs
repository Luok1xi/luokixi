import {dateKey,dateMinute} from './time.mjs';
export function reviewTasks(state,day){
 const end=dateMinute(day,'23:59'),ids=new Set((state.plan?.allocations||[]).filter(x=>dateKey(x.start)===day).map(x=>x.taskId));
 return state.tasks.filter(t=>t.status==='open'&&t.remaining>0&&(t.deadline<=end||ids.has(t.id)));
}
