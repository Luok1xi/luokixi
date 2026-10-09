import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePlan, occurrences, calendarICS } from '../src/js/campus-plan.js';
import { placeTask, reminderDue, mergeSchoolSchedule } from '../src/js/campus-schedule.js';
import { parseSchoolTable, schoolOrigin } from '../src/js/school-import.js';

const base=()=>normalizePlan({term:{starts:'2026-10-05',weeks:16},courses:[{id:'math',name:'数学',origin:'school',slots:[{id:'m',day:1,start:'08:00',end:'09:30'}]}],events:[{id:'study',title:'复习',date:'2026-10-05',start:'10:00',end:'11:00',repeat:'weekly',until:'2026-10-26'}]});
test('school class cannot move; collision leaves original untouched',()=>{const p=base(),rows=occurrences(p,'2026-10-05','2026-10-05');assert.throws(()=>placeTask(p,rows[0],'2026-10-06',600,60),/锁定/);assert.throws(()=>placeTask(p,rows[1],'2026-10-05',540,60),/重叠/);assert.equal(p.hiddenOccurrences.length,0);assert.equal(p.events[0].start,'10:00');});
test('move a single repeated task; next week and original record survive',()=>{const p=base(),row=occurrences(p,'2026-10-05','2026-10-05')[1],n=placeTask(p,row,'2026-10-06',660,90,{newId:()=> 'moved'});assert.equal(occurrences(n,'2026-10-05','2026-10-05').length,1);assert.equal(occurrences(n,'2026-10-06','2026-10-06')[0].end,'12:30');assert.equal(occurrences(n,'2026-10-12','2026-10-12').find(x=>x.source==='event').start,'10:00');});
test('pending task does not appear in calendar until scheduled',()=>{const p=base();p.events[0].unscheduled=true;assert.equal(occurrences(p,'2026-10-05','2026-10-05').length,1);const n=placeTask(p,{source:'event',sourceId:'study'},'2026-10-05',600,60);assert.equal(n.events.length,1);assert.equal(n.events[0].unscheduled,false);});
test('at-start reminder is exact and exported as a zero-minute alarm',()=>{const p=base();p.events[0].remindAtStart=true;const row=occurrences(p,'2026-10-05','2026-10-05')[1],now=Date.parse('2026-10-05T10:00:15+08:00');assert.equal(reminderDue(row,p.settings,now),true);assert.equal(reminderDue(row,p.settings,now-60000),false);assert.equal(reminderDue(row,p.settings,now+60000),false);assert.match(calendarICS(p),/TRIGGER:PT0S/);});
const payload=()=>({format:'luokixi-school-table',origin:'https://jwc.cumtb.edu.cn',path:'/schedule',tables:[[['时间','星期一','星期二','星期三','星期四','星期五'],['08:00-09:35','课程名称：高等数学\n教师：张老师\n地点：教学楼 302\n1-16周','','','','']]]});
test('school visible grid preserves names, times, teacher, room and fixed status',()=>{const r=parseSchoolTable(payload(),{term:{starts:'2026-10-05',weeks:16}});assert.equal(r.courses.length,1);assert.equal(r.courses[0].origin,'school');assert.equal(r.courses[0].name,'高等数学');assert.equal(r.courses[0].teacher,'张老师');assert.equal(r.courses[0].room,'教学楼 302');assert.equal(r.courses[0].slots[0].start,'08:00');assert.equal(r.courses[0].weeks.length,16);assert.equal(parseSchoolTable(payload(),{term:{weeks:16}}).courses[0].id,r.courses[0].id);});
test('unknown time and untrusted site rejected without dropping the class',()=>{const p=payload();p.tables[0][1][0]='第一大节';assert.throws(()=>parseSchoolTable(p),/起止时间/);assert.equal(parseSchoolTable(p,{periods:{1:'08:00-09:35'}}).courses.length,1);assert.equal(schoolOrigin('https://cumtb.edu.cn.attacker.example'),false);assert.throws(()=>parseSchoolTable({...p,origin:'https://example.com'}),/矿大官网/);});

test('school reimport updates fixed slots while retaining personal tasks and course links',()=>{
 const p=base();p.courses[0].notes='自己的备注';p.events[0].courseId='math';
 const changed={...p.courses[0],id:'new-school-id',slots:[{id:'m',day:1,start:'08:30',end:'10:00'}]};
 const next=mergeSchoolSchedule(p,{courses:[changed],events:[]});
 assert.equal(next.courses.length,1);assert.equal(next.courses[0].id,'math');assert.equal(next.courses[0].slots[0].start,'08:30');assert.equal(next.courses[0].notes,'自己的备注');assert.equal(next.events[0].courseId,'math');assert.equal(next.events[0].start,'10:00');
 assert.equal(mergeSchoolSchedule(next,{courses:[changed],events:[]}).courses.length,1);
});
test('pending ordering changes only ordering, never course timing',()=>{
 const p=base();p.events[0].unscheduled=true;p.events.push({...p.events[0],id:'second',title:'第二项'});
 const n=placeTask(p,{source:'event',sourceId:'second'},'2026-10-05',600,60,{unschedule:true,beforeId:'study'});
 assert.deepEqual(n.events.map(e=>e.id),['second','study']);assert.deepEqual(n.courses,p.courses);
});
test('school merged rows use the last covered period end, and repeated labeled blocks are retained',()=>{
 const p=payload();p.tables[0][1][1]={text:'课程名称：高等数学\n1-16周',rowSpan:2};p.tables[0].push(['09:45-10:30','','','','']);
 const result=parseSchoolTable(p,{term:{weeks:16}});assert.equal(result.courses[0].slots[0].end,'10:30');
 const q=payload();q.tables[0][1][1]='课程名称：数学\n1-8周\n课程名称：物理\n9-16周';assert.equal(parseSchoolTable(q,{term:{weeks:16}}).courses.length,2);
});
