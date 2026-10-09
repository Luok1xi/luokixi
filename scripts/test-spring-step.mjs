import test from 'node:test';
import assert from 'node:assert/strict';
import { springStep } from '../src/js/spring-step.js';

test('spring is refresh-rate independent and preserves interruption velocity', () => {
  for (const damping of [.55,.86,1]) {
    const config = {stiffness:640,damping};
    const direct = springStep(90,-120,350,.5,config);
    for (const hz of [60,120,144,240]) {
      let p = [90,-120];
      for (let i=0;i<hz/2;i++) p = springStep(...p,350,1/hz,config);
      assert.ok(Math.abs(p[0]-direct[0])<1e-8);
      assert.ok(Math.abs(p[1]-direct[1])<1e-8);
      const retarget = springStep(...p,-50,0,config);
      assert.deepEqual(retarget,p);
    }
  }
});

test('drop starts at rest, overshoots naturally and settles without Euler instability', () => {
  const config = {stiffness:(2*Math.PI/.48)**2,damping:.55};
  assert.deepEqual(springStep(0,0,1,0,config),[0,0]);
  assert.ok(springStep(0,0,1,.28,config)[0]>1);
  const [position,velocity] = springStep(0,0,1,3,config);
  assert.ok(Math.abs(position-1)<1e-8);
  assert.ok(Math.abs(velocity)<1e-7);
});
