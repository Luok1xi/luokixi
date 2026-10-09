import test from 'node:test';
import assert from 'node:assert/strict';
import { previewPlacement, applyLocalPlacement, isFixed } from '../src/js/campus-schedule.js';
import { normalizePlan, occurrences } from '../src/js/campus-plan.js';
import { createSharedSchedule, appendSharedCalendar, clubOccurrence } from '../src/js/planner-shared.js';
import { hubApi } from '../src/js/hub.js';
const date='2026-10-07';
const event=(id,start,end,extra={})=>({id,sourceId:id,source:'club',clubId:'robot',clubName:'机器人社',title:id,canManage:true,date,start,end,...extra});
const pending=()=>event('new',null,null,{pending:true,duration:60});
test('same-club cascade yields atomically, preserves order and input',()=>{
 const items=[event('a','16:00','17:00'),event('b','17:00','17:30')],before=JSON.stringify(items),p=previewPlacement(items,pending(),date,16*60,60);
 assert.equal(p.ok,true);assert.deepEqual(p.moves.map(m=>[m.item.id,m.start,m.end]),[['new','16:00','17:00'],['a','17:00','18:00'],['b','18:00','18:30']]);assert.equal(JSON.stringify(items),before);
});
test('a main class rejects source and is never moved',()=>{
 const main=event('math','08:00','09:30',{source:'course'}),p=previewPlacement([main],pending(),date,8*60+15,60);
 assert.equal(p.ok,false);assert.deepEqual(p.blocked,[main]);assert.deepEqual(p.moves,[]);
});
test('cascade skips pinned course but never changes the course',()=>{
 const lesson=event('math','17:00','18:00',{source:'course'}),p=previewPlacement([event('a','16:00','17:00'),lesson],pending(),date,16*60,60);
 assert.equal(p.ok,true);assert.equal(p.yielded[0].start,'18:00');assert.equal(p.moves.some(m=>m.item.id==='math'),false);
});
test('unrelated existing personal conflict does not join the displacement chain',()=>{
 const items=[event('math','14:00','15:00',{source:'course'}),event('existing','14:00','15:00')],p=previewPlacement(items,pending(),date,10*60,60);
 assert.equal(p.ok,true);assert.deepEqual(p.moves.map(m=>m.item.id),['new']);assert.equal(items[1].start,'14:00');
});
test('another club and a read-only member activity cannot yield',()=>{
 for(const extra of [{clubId:'music'},{canManage:false}]){const p=previewPlacement([event('other','16:00','17:00',extra)],pending(),date,16*60,60);assert.equal(p.ok,false);assert.deepEqual(p.moves,[]);}
});
test('member cannot initiate an edit, even if the target is free',()=>{
 const p=previewPlacement([],event('member','16:00','17:00',{canManage:false}),date,10*60,60);assert.equal(p.ok,false);
});
test('no space at day end rejects the entire cascade',()=>{
 const p=previewPlacement([event('a','22:30','23:30')],pending(),date,22*60+30,60);assert.equal(p.ok,false);assert.deepEqual(p.moves,[]);
});
test('reservations and private reservation records stay fixed',()=>{
 for(const item of [event('book','09:00','10:00',{source:'reservation'}),event('local','09:00','10:00',{source:'event',event:{tags:['预约记录']}})]){assert.equal(Boolean(isFixed(item)),true);assert.equal(previewPlacement([item],pending(),date,9*60,60).ok,false);}
});
test('moving a local weekly occurrence preserves following weeks and is one transaction',()=>{
 const plan=normalizePlan({term:{starts:'2026-10-05'},events:[{id:'local',title:'旧的个人安排',date,start:'10:00',end:'11:00',repeat:'weekly',until:'2026-10-28'}]}),row=occurrences(plan,date,date)[0];
 const preview=previewPlacement([row],row,date,12*60,60),next=applyLocalPlacement(plan,preview,{newId:()=> 'exception'});
 assert.equal(occurrences(next,date,date)[0].start,'12:00');assert.equal(occurrences(next,'2026-10-14','2026-10-14')[0].start,'10:00');assert.equal(plan.hiddenOccurrences.length,0);
});
test('local schedules cannot silently displace shared club arrangements',()=>{
 const local=event('local','10:00','11:00',{source:'event',event:{},clubId:undefined}),p=previewPlacement([event('shared','12:00','13:00')],local,date,12*60,60);assert.equal(p.ok,false);
});
test('a late GET cannot overwrite a completed shared write, and equal polls do not rerender',async()=>{
 const original=hubApi.request;let resolveOld,reads=0;const old={clubs:[{id:'club',revision:1}],events:[]},fresh={clubs:[{id:'club',revision:2}],events:[{id:'event',clubId:'club',title:'新安排'}]},changes=[];
 hubApi.request=async(path,body)=>{if(body)return {club:fresh.clubs[0],events:fresh.events};if(++reads===1)return new Promise(resolve=>{resolveOld=resolve;});return fresh;};
 try{const store=createSharedSchedule({changed:data=>changes.push(JSON.parse(JSON.stringify(data)))}),read=store.refresh();await store.create('社团');resolveOld(old);await read;await new Promise(resolve=>setTimeout(resolve,0));assert.equal(store.snapshot.clubs[0].revision,2);assert.equal(changes.some(x=>x.clubs[0]?.revision===1),false);const count=changes.length;await store.refresh();assert.equal(changes.length,count);}finally{hubApi.request=original;}
});
test('shared calendar contains scheduled member activities, midnight ending and stable IDs; pending stays absent',()=>{
 const item=clubOccurrence({id:'event',clubId:'club',clubName:'机器人社',title:'夜间观测',date,start:'23:00',end:'24:00',status:'scheduled'}),pending=clubOccurrence({id:'pending',title:'待定',pending:true}),ics=appendSharedCalendar('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n',[item,pending]);
 assert.match(ics,/DTEND:20261007T160000Z/);assert.match(ics,/机器人社 · 夜间观测/);assert.match(ics,/UID:club%3Aevent@planner/);assert.doesNotMatch(ics,/待定/);assert.match(ics,/TRIGGER:PT0S/);
});
