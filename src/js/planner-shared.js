// Account schedules and local lessons have separate stores. This adapter never
// sends a private lesson or a private conflict to the community API.
import { hubApi } from './hub.js';

export function clubOccurrence(event) {
  return { ...event, source:'club', sourceId:event.id, kind:'club', pending:event.pending || event.status==='pending', duration:event.duration || 60, color:'var(--g2)', event:{remindAtStart:true} };
}
export function reservationOccurrence(event) {
  return { ...event, id:'reservation:'+event.id, sourceId:event.id, source:'reservation', kind:'personal', canManage:false, fixed:true, title:event.title || '图书馆预约', color:'var(--ok)', event:{remindAtStart:true} };
}
export function createSharedSchedule({ changed, failed }) {
  let snapshot={clubs:[],events:[],reservations:{items:[]}}, loading=false, writing=false, deferred=false, generation=0;
  function accept(result, partial=false){
    const clubs=result.clubs||(result.club?[result.club]:[]);
    let next;
    if(partial){const ids=new Set(clubs.map(c=>c.id));next={...snapshot,clubs:[...snapshot.clubs.filter(c=>!ids.has(c.id)),...clubs],events:[...snapshot.events.filter(e=>!ids.has(e.clubId)),...(result.events||[])]};}
    else next={...snapshot,...result,clubs,events:result.events||[]};
    if(JSON.stringify(next)===JSON.stringify(snapshot))return snapshot;
    snapshot=next;
    changed(snapshot);return snapshot;
  }
  async function refresh(){if(loading||writing){deferred=true;return snapshot;}loading=true;const started=generation;try{const result=await hubApi.request('club-schedule');if(started!==generation||writing){deferred=true;return snapshot;}return accept(result);}catch(e){if(started===generation)failed?.(e);throw e;}finally{loading=false;if(deferred&&!writing){deferred=false;void refresh().catch(()=>{});}}}
  async function request(path,body){if(writing)throw new Error('上一项安排正在保存，请稍等。');writing=true;generation++;try{return await hubApi.request(path,body);}finally{writing=false;if(deferred&&!loading){deferred=false;void refresh().catch(()=>{});}}}
  async function batch(changes){const clubIds=[...new Set(changes.map(c=>c.clubId))],revisions=Object.fromEntries(clubIds.map(id=>[id,snapshot.clubs.find(c=>c.id===id)?.revision]));
    try{return accept(await request('club-schedule/batch',{revisions,changes,requestKey:crypto.randomUUID()}),true);}catch(e){if(e.status===409)void refresh().catch(()=>{});throw e;}}
  return{refresh,batch,get snapshot(){return snapshot;},get writing(){return writing;},
    async create(name){return accept(await request('club-schedule/clubs',{name,requestKey:crypto.randomUUID()}),true);},
    async join(code){return accept(await request('club-schedule/join',{code}),true);},
    async invite(clubId){const club=snapshot.clubs.find(c=>c.id===clubId);const result=await request(`club-schedule/clubs/${encodeURIComponent(clubId)}/invite`,{revision:club?.revision});await refresh();return result;},
  };
}

// Calendar export is an in-memory composition, never a write to the private plan.
// Shared IDs stay stable when the owner reschedules or a member exports again.
export function appendSharedCalendar(privateICS, events) {
  const text=value=>String(value||'').replaceAll('\\','\\\\').replaceAll('\r','').replaceAll('\n','\\n').replaceAll(';','\\;').replaceAll(',','\\,');
  const fold=line=>{let output='',part='',bytes=0;for(const character of line){const size=new TextEncoder().encode(character).length;if(bytes+size>75){output+=part+'\r\n';part=' ';bytes=1;}part+=character;bytes+=size;}return output+part;};
  const stamp=(date,time)=>new Date(`${date}T${time}:00+08:00`).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');
  const lines=[];
  for(const item of events.filter(e=>!e.pending&&e.status!=='cancelled'&&e.date&&e.start&&e.end)){
    const title=item.clubName?item.clubName+' · '+item.title:item.title;
    lines.push('BEGIN:VEVENT',`UID:${encodeURIComponent(item.source+':'+item.sourceId)}@planner.luokixi.local`,`DTSTAMP:${new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z')}`,`DTSTART:${stamp(item.date,item.start)}`,`DTEND:${stamp(item.date,item.end)}`,`SUMMARY:${text(title)}`);
    if(item.location)lines.push(`LOCATION:${text(item.location)}`);if(item.statusLabel)lines.push(`DESCRIPTION:${text(item.statusLabel)}`);
    lines.push('STATUS:CONFIRMED','BEGIN:VALARM','TRIGGER:PT0S','ACTION:DISPLAY',`DESCRIPTION:${text(title)}`,'END:VALARM','END:VEVENT');
  }
  return privateICS.replace(/END:VCALENDAR\r?\n?$/,(lines.length?lines.map(fold).join('\r\n')+'\r\n':'')+'END:VCALENDAR\r\n');
}
