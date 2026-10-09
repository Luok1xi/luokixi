// Local route estimates from documented OSM walkways. No location inference or network calls.
export function distance(a, b) {
  const r = Math.PI / 180, [x,y] = a, [u,v] = b;
  const h = Math.sin((v-y)*r/2)**2 + Math.cos(y*r)*Math.cos(v*r)*Math.sin((u-x)*r/2)**2;
  return 6371000 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}
const coordinate = p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;
const key = p => p.join(',');
export function walkwayGraph(data) {
  const nodes = new Map();
  for (const feature of data?.features ?? []) {
    const p = feature.properties ?? {};
    if (feature.geometry?.type !== 'LineString' || p.context || p.kind !== 'path' || ['no','private'].includes(p.access) || p.foot === 'no') continue;
    const points = feature.geometry.coordinates;
    for (let i=1;i<points.length;i++) {
      const a=points[i-1],b=points[i];
      if (!coordinate(a) || !coordinate(b) || key(a)===key(b)) continue;
      for (const point of [a,b]) if (!nodes.has(key(point))) nodes.set(key(point), { point, edges:new Map() });
      const weight=distance(a,b);
      nodes.get(key(a)).edges.set(key(b),weight);nodes.get(key(b)).edges.set(key(a),weight);
    }
  }
  return nodes;
}
export function walkingLeg(graph, from, to) {
  if (!coordinate(from) || !coordinate(to)) throw new Error('路线地点需要真实经纬度。');
  const straight = () => ({ coordinates:[from,to], meters:distance(from,to), mode:'straight', notice:'直线估算；步行路网未覆盖或不连通，入口与通行需现场核对。' });
  if (!graph?.size) return straight();
  const nearest = point => [...graph].map(([id,node])=>({id,d:distance(point,node.point)})).sort((a,b)=>a.d-b.d)[0];
  const start=nearest(from),end=nearest(to);
  if (start.d>200 || end.d>200) return straight();
  const costs=new Map([[start.id,0]]), previous=new Map(), open=new Set([start.id]),done=new Set();
  while (open.size) {
    const current=[...open].sort((a,b)=>costs.get(a)-costs.get(b))[0];open.delete(current);
    if (current===end.id) break;
    done.add(current);
    for (const [id,cost] of graph.get(current).edges) {
      if (done.has(id)) continue;
      const next=costs.get(current)+cost;
      if (next<(costs.get(id)??Infinity)) { costs.set(id,next);previous.set(id,current);open.add(id); }
    }
  }
  if (!costs.has(end.id)) return straight();
  const ids=[end.id];while(ids[0]!==start.id)ids.unshift(previous.get(ids[0]));
  return { coordinates:[from,...ids.map(id=>graph.get(id).point),to],meters:start.d+costs.get(end.id)+end.d,mode:'walkway',notice:'OSM 步行路网最短路估算，楼中心到路网为直线接入；未核对入口、开放或无障碍条件。' };
}
export function campusRoute(stops, data) {
  const graph=walkwayGraph(data),legs=[];
  for(let i=1;i<stops.length;i++)legs.push({...walkingLeg(graph,stops[i-1].center,stops[i].center),from:stops[i-1],to:stops[i]});
  const meters=legs.reduce((sum,leg)=>sum+leg.meters,0);
  return { stops,legs,meters,minutes:Math.ceil(meters/75),mode:legs.some(leg=>leg.mode==='straight')?'mixed':'walkway' };
}
export function datedActivity(data) {
  const validDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
  const validTime=value=>typeof value==='string'&&/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
  if(validDate(data?.date)&&validTime(data.start)&&validTime(data.end)&&data.end>data.start)return {date:data.date,start:data.start,end:data.end};
  if(![data?.startsAt,data?.endsAt].every(value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)&&validDate(value.slice(0,10))))return null;
  const start=Date.parse(data?.startsAt),end=Date.parse(data?.endsAt);
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start)return null;
  const civil=timestamp=>new Date(timestamp+8*3600000).toISOString();
  const a=civil(start),b=civil(end);
  return a.slice(0,10)===b.slice(0,10)&&b.slice(11,16)>a.slice(11,16)?{date:a.slice(0,10),start:a.slice(11,16),end:b.slice(11,16)}:null;
}

// Published UUID is stable across public revisions; keep personal changes when added again.
export function localActivity(feature, fallbackSourceURL = '') {
  const p=feature?.properties ?? {},data=p.data ?? {},dates=datedActivity(data);
  const sourceId=String(p.id ?? feature?.id ?? '');
  if(p.placeType!=='event'||!dates||! /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sourceId))return null;
  const webURL=value=>{
    try {if(typeof value!=='string'||/[\s\u0000-\u001f\u007f]/.test(value))return '';const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password?u.href:'';}catch{return '';}
  };
  const b=data.building;
  const building=b&&b.campus===p.campus&&typeof b.osm==='string'&&typeof b.name==='string'?{campus:b.campus,osm:b.osm,name:b.name,center:coordinate(b.center)?[...b.center]:null}:null;
  return {id:'place-'+sourceId.replaceAll('-',''),title:data.title,kind:'activity',...dates,
    location:String(data.addressHint||building?.name||data.title).slice(0,160),
    notes:'来自已公开校园活动；参加前请核对原来源与报名要求。'+(data.summary?'\n'+data.summary:''),
    repeat:'none',sourceURL:webURL(data.links?.source)||webURL(fallbackSourceURL),registrationURL:webURL(data.registrationURL),
    reminderMinutes:Number.isInteger(data.reminderMinutes)&&data.reminderMinutes>=0&&data.reminderMinutes<=120?data.reminderMinutes:0,building};
}
