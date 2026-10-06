import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleMotion, planMotion } from '../src/js/carousel-motion.js';

const near = (actual, expected, epsilon = 1e-10) =>
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} is not near ${expected}`);

test('elapsed-time samples are independent of refresh rate and missed frames', () => {
  const state = { from: 0, to: 1, velocity: 0.7 };
  const expected = sampleMotion(state, 0.4);
  for (const fps of [10, 20, 30, 60, 120]) {
    let point;
    for (let frame = 0; frame <= fps * 0.4; frame++) {
      point = sampleMotion(state, frame / fps);
    }
    near(point.position, expected.position);
    near(point.velocity, expected.velocity);
  }
  // Restarting an analytic segment after a dropped frame gives the same motion.
  const middle = sampleMotion(state, 0.1);
  const resumed = sampleMotion({ from: middle.position, to: 1, velocity: middle.velocity }, 0.3);
  near(resumed.position, expected.position);
  near(resumed.velocity, expected.velocity);
});

test('plans preserve initial state and pin the completed endpoint exactly', () => {
  const options = { from: 2, to: 5, velocity: -0.6 };
  const plan = planMotion(options);
  assert.deepEqual(plan.sample(0), { position: 2, velocity: -0.6 });
  assert.deepEqual(plan.frames[0], { offset: 0, position: 2, velocity: -0.6 });
  assert.deepEqual(plan.sample(plan.duration), { position: 5, velocity: 0 });
  assert.deepEqual(plan.sample(plan.duration + 10000), { position: 5, velocity: 0 });
  assert.deepEqual(plan.frames.at(-1), { offset: 1, position: 5, velocity: 0 });
  assert.deepEqual(plan.sample(-10), plan.sample(0));
  const rawEnd = sampleMotion(options, plan.duration / 1000);
  assert.ok(Math.abs(rawEnd.position - options.to) <= 0.0007);
  assert.ok(Math.abs(rawEnd.velocity) <= 0.009);
});

test('interrupting and reversing preserves presentation position and velocity', () => {
  const first = planMotion({ from: 0, to: 3 });
  const interrupted = first.sample(125);
  assert.ok(interrupted.velocity > 0);
  const reversed = planMotion({ from: interrupted.position, to: -1, velocity: interrupted.velocity });
  assert.deepEqual(reversed.sample(0), interrupted);
  // A reversal first keeps its momentum; it must not instantly flip velocity.
  assert.ok(reversed.sample(0.1).velocity > 0);
  near((reversed.sample(0.001).position - interrupted.position) / 0.000001,
    interrupted.velocity, 0.001);
  assert.deepEqual(reversed.sample(reversed.duration), { position: -1, velocity: 0 });
});

test('stationary, forward, backward and high-velocity plans stay finite and bounded', () => {
  for (const options of [
    { from: 1, to: 1 },
    { from: 0, to: 7 },
    { from: 7, to: 0, velocity: -15 },
    { from: -2, to: 4, velocity: 100 },
    { from: 0, to: 1, velocity: 1e8 },
  ]) {
    const plan = planMotion(options);
    assert.ok(plan.duration >= 16 && plan.duration <= 1200);
    assert.ok(plan.frames.length >= 2 && plan.frames.length <= 73);
    for (let i = 0; i < plan.frames.length; i++) {
      const frame = plan.frames[i];
      for (const value of Object.values(frame)) assert.ok(Number.isFinite(value));
      assert.ok(frame.offset >= 0 && frame.offset <= 1);
      if (i) assert.ok(frame.offset > plan.frames[i - 1].offset);
      if (i && i < plan.frames.length - 1) {
        near((frame.offset - plan.frames[i - 1].offset) * plan.duration, 1000 / 60);
      }
    }
    assert.deepEqual(plan.sample(plan.duration), { position: options.to, velocity: 0 });
  }
  assert.equal(planMotion({ from: 1, to: 1 }).duration, 16);
  assert.equal(planMotion({ from: 0, to: 1, velocity: 1e8 }).duration, 1200);
});

test('invalid inputs fail rather than leaking non-finite animation values', () => {
  for (const value of [NaN, Infinity, -Infinity, undefined]) {
    assert.throws(() => sampleMotion({ from: value, to: 1 }, 0.1), TypeError);
    assert.throws(() => planMotion({ from: 0, to: value }), TypeError);
  }
  assert.throws(() => sampleMotion({ from: 0, to: 1, velocity: NaN }, 0.1), TypeError);
  assert.throws(() => sampleMotion({ from: 0, to: 1 }, Infinity), TypeError);
  assert.throws(() => planMotion({ from: 0, to: 1 }).sample(NaN), TypeError);
});
