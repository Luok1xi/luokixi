import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizePlan,occurrenceId} from '../src/js/campus-plan.js';
import {mergeCampusPlans} from '../src/js/campus-merge.js';
const term={starts:'2026-10-05',weeks:20};
const course={id:'course-old',name:'数学',slots:[{id:'slot-old',day:3,start:'08:00',end:'09:00'}]};
const event={id:'event-old',title:'讨论',kind:'meeting',date:'2026-10-07',start:'10:00',end:'11:00',courseId:course.id};
test('semantically equal normalized fields and absent cancelled=false are not duplicate imports',()=>{
 const base=normalizePlan({term,courses:[course]});
 const incoming=normalizePlan({term,courses:[{...course,cancelled:false}]});
 const result=mergeCampusPlans(base,incoming);
 assert.equal(result.plan.courses.length,1);assert.equal(result.skipped.courses,1);
});
test('conflicting imported records keep both versions and translate only imported course/event references',()=>{
 const base=normalizePlan({term,courses:[course],events:[event]});
 const incoming=normalizePlan({term,courses:[{...course,name:'新版数学'}],events:[{...event,title:'新版讨论'}],hiddenOccurrences:[occurrenceId('course',course.id,'2026-10-07','slot-old'),occurrenceId('event',event.id,'2026-10-07')]});
 const result=mergeCampusPlans(base,incoming),p=result.plan;
 assert.equal(p.courses.length,2);assert.equal(p.events.length,2);assert.equal(p.events[0].courseId,course.id);assert.equal(p.events[1].courseId,p.courses[1].id);
 assert(p.hiddenOccurrences.includes(occurrenceId('course',p.courses[1].id,'2026-10-07','slot-old')));
 assert(p.hiddenOccurrences.includes(occurrenceId('event',p.events[1].id,'2026-10-07')));
 assert(!p.hiddenOccurrences.includes(occurrenceId('course',course.id,'2026-10-07','slot-old')));
 assert(!p.hiddenOccurrences.includes(occurrenceId('event',event.id,'2026-10-07')));
 assert.equal(mergeCampusPlans(p,incoming).plan.courses.length,2);
 assert.equal(mergeCampusPlans(p,incoming).plan.events.length,2);
});
test('independent records with different IDs remain independent even if their names and times match',()=>{
 const result=mergeCampusPlans({term,courses:[course]},{term,courses:[{...course,id:'separate'}]});
 assert.equal(result.plan.courses.length,2);
});
test('orphaned import exceptions never hide an unrelated existing course or event',()=>{
 const result=mergeCampusPlans({term,courses:[course]},{term,hiddenOccurrences:[occurrenceId('course',course.id,'2026-10-07','slot-old')]});
 assert.equal(result.plan.hiddenOccurrences.length,0);assert.equal(result.warnings.length,1);
});
test('invalid imports and combined limits fail atomically without mutating either input',()=>{
 const base={term,courses:[course]},before=structuredClone(base);
 assert.throws(()=>mergeCampusPlans(base,{term,events:[{...event,start:'12:00',end:'11:00'}]}));
 const incoming={term,courses:Array.from({length:60},(_,i)=>({...course,id:'new-'+i}))};
 assert.throws(()=>mergeCampusPlans(base,incoming),/最多 60/);assert.deepEqual(base,before);assert.equal(incoming.courses.length,60);
});

