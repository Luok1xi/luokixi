import { normalizePlan } from './campus-plan.js';
// Merge explicit import previews without overwriting an existing course, event or reference.
// Deterministic replacement IDs make repeating the same import idempotent.
function stable(value) {
 if(Array.isArray(value))return value.map(stable);
 if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>[k,stable(value[k])]));
 return value;
}
function signature(value) {
 const data=structuredClone(value);delete data.id;data.cancelled=Boolean(data.cancelled);
 if(data.slots)data.slots.sort((a,b)=>a.id.localeCompare(b.id));
 if(data.tags)data.tags.sort();
 return JSON.stringify(stable(data));
}
function hash(text) {
 let a=2166136261,b=2654435761;
 for(const char of text){const n=char.codePointAt(0);a=Math.imul(a^n,16777619);b=Math.imul(b^n,2246822519);}
 return (a>>>0).toString(36)+(b>>>0).toString(36);
}
export function mergeCampusPlans(base,incoming) {
 const next=normalizePlan(base);
 const source=normalizePlan({term:incoming.term||next.term,courses:incoming.courses||[],events:incoming.events||[],hiddenOccurrences:incoming.hiddenOccurrences||[]});
 const maps={course:new Map(),event:new Map()},warnings=[];
 const added={courses:0,events:0},skipped={courses:0,events:0};
 for(const [field,kind] of [['courses','course'],['events','event']]){
  for(const original of source[field]){
   const item=structuredClone(original),key=item.id;
   if(field==='events'&&maps.course.has(item.courseId))item.courseId=maps.course.get(item.courseId);
   const sig=signature(item),old=next[field].find(x=>x.id===key);
   if(old&&signature(old)===sig){maps[kind].set(key,old.id);skipped[field]++;continue;}
   if(old){
    item.id=kind+'-import-'+hash(key+':'+sig);
    const same=next[field].find(x=>x.id===item.id);
    if(same){if(signature(same)!==sig)throw new Error('导入编号冲突，尚未改动原计划。请导出备份后核对编号。');maps[kind].set(key,same.id);skipped[field]++;continue;}
    warnings.push('同编号的'+(field==='courses'?'课程':'日程')+'内容不同，已作为新记录保留：'+(item.name||item.title));
   }
   next[field].push(item);maps[kind].set(key,item.id);added[field]++;
  }
 }
 let orphan=0;
 for(const hidden of source.hiddenOccurrences){
  const parts=hidden.split(':'),kind=parts[0],oldId=decodeURIComponent(parts[1]),newId=maps[kind]?.get(oldId);
  if(!newId){orphan++;continue;}
  parts[1]=encodeURIComponent(newId);const mapped=parts.join(':');
  if(!next.hiddenOccurrences.includes(mapped))next.hiddenOccurrences.push(mapped);
 }
 if(orphan)warnings.push(orphan+' 条导入隐藏记录没有对应课程或日程，未作用到现有安排；完整替换可保留原备份记录。');
 return {plan:normalizePlan(next),warnings,added,skipped};
}

