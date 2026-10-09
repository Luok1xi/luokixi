import test from 'node:test';
import assert from 'node:assert/strict';
import { constrainStrand, pointerImpulse } from '../src/js/curtain-physics.js';

test('strands stay pinned and elastic lengths stay bounded during a sweep',()=>{
 const rest=Array.from({length:32},(_,i)=>i?15:0);
 const nodes=rest.map((_,i)=>({x:0,y:i*15,px:0,py:i*15}));
 for(let frame=0;frame<900;frame++) {
  for(let i=1;i<nodes.length;i++) {const n=nodes[i],vx=(n.x-n.px)*.982,vy=(n.y-n.py)*.982;n.px=n.x;n.py=n.y;n.x+=vx+(frame<45&&i>12&&i<18?.5:0);n.y+=vy+.34;}
  constrainStrand(nodes,rest);
  assert.deepEqual(nodes[0],{x:0,y:0,px:0,py:0});
  for(let i=1;i<nodes.length;i++) {
   assert.ok(Number.isFinite(nodes[i].x)&&Number.isFinite(nodes[i].y));
   assert.ok(Math.hypot(nodes[i].x-nodes[i-1].x,nodes[i].y-nodes[i-1].y)<=15*1.025+1e-8);
  }
 }
});

test('mouse event frequency does not change the impulse over a physics interval',()=>{
 for(const samples of [1,2,4,16]) {
  let distance=0;for(let i=0;i<samples;i++)distance+=12/samples;
  assert.equal(pointerImpulse(4,distance),14);
 }
 assert.equal(pointerImpulse(0,1000),20);assert.equal(pointerImpulse(0,-1000),-20);
 assert.equal(pointerImpulse(8,0),4);
});
