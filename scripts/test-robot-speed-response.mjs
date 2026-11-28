import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSpeedCapture, speedResponse, importSpeedCSV, speedCSV, scopeRange, captureFingerprint, nearestSpeedSample } from '../src/js/robot-speed-response.js';

function pulse(sign = 1) {
  const rows = Array.from({ length: 1000 }, (_, index) => {
    const t = index * 2, target = t >= 200 && t < 1200 ? sign * 200 : 0;
    let encL = t < 200 ? 0 : t < 300 ? sign * (t - 200) * 2 : target ? sign * (200 + (index % 2 ? 3 : -3)) : 0;
    if (t === 320) encL = sign * 230;
    return { index, t, setL: target, setR: 0, encL, encR: 0, pwmL: target ? 2000 : 0, pwmR: 0 };
  });
  return normalizeSpeedCapture({ header: { dt_ms: 2, stride: 1, side: 1, kpL: 97, kiL: 130, fan_pct: 30 }, rows, complete: true, issues: [] });
}

test('step metrics use defined plateau and raw extrema, excluding overshoot from platform', () => {
  const response = speedResponse(pulse());
  assert.equal(response.available, true);
  assert.equal(response.target, 200);
  assert.equal(response.startMs, 200);
  assert.equal(response.endMs, 1200);
  assert.equal(response.riseMs, 80);
  assert.equal(response.overshootPct, 15);
  assert.equal(response.platformStartMs, 500);
  assert.equal(response.peakToPeak, 6);
  assert.equal(response.mean, 200);
  assert.equal(response.platformN, 350);
  assert.equal(response.returnMs, 0);
  assert.equal(speedResponse(pulse(), 'R').available, false);
});

test('negative step uses directional response; plateau retains signed values', () => {
  const result = speedResponse(pulse(-1));
  assert.equal(result.riseMs, 80); assert.equal(result.overshootPct, 15);
  assert.equal(result.peakToPeak, 6); assert.equal(result.mean, -200);
});

test('missing feedback, sparse or dropped samples and variable targets do not yield trusted metrics', () => {
  const missing = pulse(); missing.rows[400].encL = NaN;
  assert.equal(speedResponse(missing).available, false);
  const gap = pulse(); gap.rows.splice(400, 4);
  assert.equal(speedResponse(gap).available, false);
  assert.equal(normalizeSpeedCapture(gap).complete, false);
  const changing = pulse(); changing.rows[300].setL = 190;
  assert.equal(speedResponse(changing).available, false);
  const sparse = pulse(); sparse.rows = sparse.rows.filter((_, i) => i % 50 === 0); sparse.header.stride = 50;
  assert.equal(speedResponse(sparse).available, false);
});

test('truncated active pulse cannot pretend to contain return or prestep measurements', () => {
  const cap = pulse(); cap.rows = cap.rows.slice(100, 500); cap.complete = false;
  const response = speedResponse(cap);
  assert.equal(response.completePulse, false);
  assert.equal(response.riseMs, null); assert.equal(response.overshootPct, null); assert.equal(response.returnMs, null);
});

test('CSV supports actual host capture names and does not invent missing values or certify completion', () => {
  const capture = importSpeedCSV('index,target,encL,encR,pwmL,pwmR,gyro_x10,setL,setR,phase,time_ms,gyro_dps\n0,0,0,0,0,0,0,0,0,0,0,0\n1,200,20,,1000,0,2,200,0,1,2,0.2\n');
  assert.equal(capture.rows[1].t, 2); assert.equal(capture.rows[1].setL, 200);
  assert.equal(Number.isNaN(capture.rows[1].encR), true); assert.equal(capture.complete, false);
  for (const name of ['t', 't_ms', 'time_ms']) assert.equal(importSpeedCSV(`${name},encL\n0,1\n2,2`).rows[1].t, 2);
  assert.equal(Number.isNaN(importSpeedCSV('t,encL,encR\n0,1,  \n2,2,').rows[0].encR), true);
});

test('missing return samples do not produce a settling time', () => {
  const cap = pulse(); cap.rows[900].encL = NaN;
  assert.equal(speedResponse(cap).returnMs, null);
});

test('CSV round trip retains exact numeric samples and metadata, while import remains unverified', () => {
  const cap = pulse(), restored = importSpeedCSV(speedCSV(cap));
  assert.deepEqual(restored.rows, cap.rows); assert.deepEqual(restored.header, cap.header);
  assert.equal(restored.complete, false); assert.equal(speedResponse(restored).peakToPeak, 6);
});

test('CSV errors explain missing or malformed time, duplicate headers, short rows and nonfinite times', () => {
  for (const text of ['index,encL\n0,1', 't,t,encL\n0,0,1', 't,encL\n0', 't,encL\n0,1\n0,2', 't,encL\nno,1', 't,setL\n0,1']) assert.throws(() => importSpeedCSV(text));
});

test('range presets use measured step and clamp to recorded interval', () => {
  const cap = pulse();
  assert.deepEqual(scopeRange(cap, 'L', 'all'), [0, 1998]);
  assert.deepEqual(scopeRange(cap, 'L', 'rise'), [150, 500]);
  assert.deepEqual(scopeRange(cap, 'L', 'plateau'), [500, 1200]);
  assert.deepEqual(scopeRange(cap, 'L', 'fall'), [1150, 1600]);
});

test('repeat imports deduplicate identical data but preserve a different sample or gain', () => {
  const a = pulse(), b = pulse();
  assert.equal(captureFingerprint(a), captureFingerprint(b));
  b.rows[400].encL += 1; assert.notEqual(captureFingerprint(a), captureFingerprint(b));
  const c = pulse(); c.header.kpL += 1; assert.notEqual(captureFingerprint(a), captureFingerprint(c));
});

test('hover snaps to actual nearest sample including missing values and endpoints', () => {
  const cap = pulse(); cap.rows[400].encL = NaN;
  assert.equal(nearestSpeedSample(cap, 799.5).row.t, 800);
  assert.equal(Number.isNaN(nearestSpeedSample(cap, 799.5).row.encL), true);
  assert.equal(nearestSpeedSample(cap, 799).row.t, 798);
  assert.equal(nearestSpeedSample(cap, -100).index, 0);
  assert.equal(nearestSpeedSample(cap, 99999).index, 999);
});
