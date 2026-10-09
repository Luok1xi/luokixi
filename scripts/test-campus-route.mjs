import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {walkwayGraph,walkingLeg,campusRoute,datedActivity,distance,localActivity} from '../src/js/campus-route.js';
const A=[116.34,40],B=[116.3403,40],C=[116.34015,40.0001],D=[116.34015,40.002];
const path=(coordinates,properties={})=>({geometry:{type:'LineString',coordinates},properties:{kind:'path',...properties}});
test('shortest route follows the recorded shorter branch and retains exact requested stops',()=>{
 const graph=walkwayGraph({features:[path([A,C,B]),path([A,D,B])]});
 const leg=walkingLeg(graph,A,B);
 assert.equal(leg.mode,'walkway');assert.deepEqual(leg.coordinates,[A,A,C,B,B]);
 assert.ok(Math.abs(leg.meters-distance(A,C)-distance(C,B))<.001);
});
test('unmapped and disconnected walkways use explicit straight estimates',()=>{
 for(const graph of [walkwayGraph({features:[]}),walkwayGraph({features:[path([A,C]),path([B,[116.3404,40]])]})]){
 const leg=walkingLeg(graph,A,B);assert.equal(leg.mode,'straight');assert.match(leg.notice,/直线估算/);
 }
 assert.equal(walkingLeg(walkwayGraph({features:[path([A,C])]}),A,[117,41]).mode,'straight');
});
test('main roads, context, private and forbidden-foot paths never become walkways',()=>{
 const graph=walkwayGraph({features:[path([A,B],{kind:'mainroad'}),path([A,B],{context:true}),path([A,B],{access:'private'}),path([A,B],{foot:'no'})]});
 assert.equal(graph.size,0);
});
test('route preserves user-selected order and estimates minutes at 75 meters per minute',()=>{
 const stops=[{title:'User start',center:A},{title:'User waypoint',center:C},{title:'Actual class',center:B}];
 const route=campusRoute(stops,{features:[path([A,C,B])]});
 assert.deepEqual(route.stops,stops);assert.equal(route.legs.length,2);assert.equal(route.minutes,Math.ceil(route.meters/75));
 assert.equal(campusRoute([],{features:[]}).meters,0);
 assert.throws(()=>walkingLeg(new Map(),[NaN,40],B),/真实经纬度/);
});
test('observation time and expiration never fabricate activity schedule times',()=>{
 assert.equal(datedActivity({observedAt:'2026-10-07T08:00:00+08:00',expiresAt:'2026-10-07T10:00:00+08:00'}),null);
 assert.equal(datedActivity({date:'2026-13-40',start:'08:00',end:'10:00'}),null);
 assert.equal(datedActivity({startsAt:'2026-10-07T08:00:00',endsAt:'2026-10-07T10:00:00'}),null);
});
test('explicit activity times retain Shanghai civil dates and reject cross-day spans',()=>{
 assert.deepEqual(datedActivity({date:'2026-10-07',start:'08:00',end:'10:00'}),{date:'2026-10-07',start:'08:00',end:'10:00'});
 assert.deepEqual(datedActivity({startsAt:'2026-10-06T23:00:00Z',endsAt:'2026-10-07T00:00:00Z'}),{date:'2026-10-07',start:'07:00',end:'08:00'});
 assert.equal(datedActivity({startsAt:'2026-10-07T23:00:00+08:00',endsAt:'2026-10-08T01:00:00+08:00'}),null);
});
test('actual OSM campus data is usable without invented connectors',()=>{
 for(const campus of ['xueyuanlu','shahe']){
 const data=JSON.parse(readFileSync(new URL(`../public/data/campus-map/${campus}.json`,import.meta.url),'utf8'));
 const graph=walkwayGraph(data),buildings=data.features.filter(f=>f.properties.kind==='building');
 const stops=buildings.slice(0,2).map(f=>({title:f.properties.name,center:f.properties.center}));
 const route=campusRoute(stops,data);assert.ok(Number.isFinite(route.meters));assert.ok(Number.isInteger(route.minutes));
 if(!graph.size&&route.legs.length)assert.equal(route.legs[0].mode,'straight');
 }
});

test('published activity retains exact building, source, registration and local reminder with stable id',()=>{
 const f={id:'1ab23456-2345-1234-5678-123456789abc',properties:{placeType:'event',campus:'xueyuanlu',data:{
 title:'Actual published activity',summary:'From the original poster',addressHint:'Real room',
 startsAt:'2026-10-07T13:00:00+08:00',endsAt:'2026-10-07T14:00:00+08:00',
 links:{source:'https://example.test/original'},registrationURL:'https://example.test/register',reminderMinutes:15,
 building:{campus:'xueyuanlu',osm:'way/123',name:'Named map building',center:A}}}};
 const event=localActivity(f);
 assert.equal(event.id,'place-1ab23456234512345678123456789abc');assert.ok(event.id.length<=40);
 assert.equal(event.sourceURL,f.properties.data.links.source);assert.equal(event.registrationURL,f.properties.data.registrationURL);
 assert.equal(event.reminderMinutes,15);assert.deepEqual(event.building,f.properties.data.building);
 assert.deepEqual([event.date,event.start,event.end],['2026-10-07','13:00','14:00']);
 assert.equal(localActivity({...f,properties:{...f.properties,revision:2}}).id,event.id);
 assert.equal(localActivity({...f,properties:{...f.properties,placeType:'study'}}),null);
 f.properties.data.building.campus='shahe';assert.equal(localActivity(f).building,null);
 f.properties.data.links.source='https://user:password@example.test/';f.properties.data.registrationURL='javascript:alert(1)';
 const safe=localActivity(f,'http://127.0.0.1/map.html?place='+f.id);
 assert.match(safe.sourceURL,/^http:\/\/127\.0\.0\.1/);assert.equal(safe.registrationURL,'');
});

test('invalid civil activity dates, sub-minute times and untrusted identifiers cannot fabricate a local event',()=>{
 assert.equal(datedActivity({startsAt:'2026-02-30T13:00:00+08:00',endsAt:'2026-03-02T14:00:00+08:00'}),null);
 assert.equal(datedActivity({startsAt:'2026-10-07T13:00:00+08:00',endsAt:'2026-10-07T13:00:30+08:00'}),null);
 assert.equal(localActivity({id:'not-a-public-id',properties:{placeType:'event',data:{date:'2026-10-07',start:'13:00',end:'14:00'}}}),null);
});
