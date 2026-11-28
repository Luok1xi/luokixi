import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/js/robot-live-data.js';
import { createChart, nearest, sparkSVG } from '../src/js/robot-live-charts.js';

function canvasFixture(width = 800) {
  const strokes = [];
  let path = [], styleReads = 0;
  globalThis.devicePixelRatio = 1;
  globalThis.getComputedStyle = () => { styleReads++; return { getPropertyValue: () => '' }; };
  const ctx = new Proxy({
    beginPath() { path = []; },
    moveTo(x, y) { path.push(['move', x, y]); },
    lineTo(x, y) { path.push(['line', x, y]); },
    stroke() { strokes.push({ color: this.strokeStyle, path: [...path] }); },
  }, { get: (obj, name) => obj[name] ?? (() => {}) });
  const canvas = { getContext: () => ctx, getBoundingClientRect: () => ({ width, height: 180 }) };
  return { canvas, strokes, resize(value) { width = value; }, get styleReads() { return styleReads; } };
}

test('nearest selects by timestamp distance on either side and skips missing samples', () => {
  const s = createStore();
  s.push(0, { a: 10 }); s.push(20, {}); s.push(100, { a: 30 });
  assert.equal(nearest(s, 'a', 5), 10);
  assert.equal(nearest(s, 'a', 95), 30);
  assert.equal(nearest(s, 'a', 50), 10);
  assert.equal(nearest(s, 'a', -20), 10);
  assert.equal(nearest(s, 'a', 200), 30);
  assert.ok(Number.isNaN(nearest(s, 'absent', 50)));
});

test('pixel envelope keeps a one-sample spike and does not add a cursor for null hover', () => {
  const s = createStore();
  s.push(100, { a: 0 }); s.push(100.1, { a: 100 }); s.push(100.2, { a: -100 }); s.push(100.3, { a: 0 });
  const f = canvasFixture(), chart = createChart(f.canvas, s, { series: [{ key: 'a', color: 'red' }], fixed: { l: [-100, 100] } });
  const result = chart.draw({ t0: 0, t1: 1000, hoverT: null });
  const line = f.strokes.find(x => x.color === 'red').path;
  assert.ok(line.some(p => p[2] === 8), 'positive one-sample spike is still drawn');
  assert.ok(line.some(p => p[2] === 162), 'negative one-sample spike is still drawn');
  assert.deepEqual(result.readout, []);
  assert.equal(f.styleReads, 1);
});

test('missing values break the line even when the points are close on screen', () => {
  const s = createStore();
  s.push(100, { a: 1 }); s.push(110, {}); s.push(120, { a: 2 }); s.push(130, { a: 3 });
  const f = canvasFixture(), chart = createChart(f.canvas, s, { series: [{ key: 'a', color: 'red' }] });
  chart.draw({ t0: 0, t1: 1000, hoverT: null });
  const line = f.strokes.find(x => x.color === 'red').path;
  assert.equal(line.filter(p => p[0] === 'move').length, 2);
});

test('a restart inside one pixel cannot connect the following pixel to the old run', () => {
  const s = createStore();
  s.push(1000, { a: 1 }); s.push(1010, { a: 2 }); s.push(0, { a: 3 }); s.push(10, { a: 4 });
  const f = canvasFixture(), chart = createChart(f.canvas, s, { series: [{ key: 'a', color: 'red' }] });
  chart.draw({ t0: 0, t1: 100000, hoverT: null });
  const line = f.strokes.find(x => x.color === 'red').path;
  assert.equal(line.filter(p => p[0] === 'move').length, 2);
});

test('hover reuses the envelope; data, scale, width, time window and ghost changes invalidate it', () => {
  const s = createStore(100), ghostStore = createStore(100);
  for (let i = 0; i < 50; i++) { s.push(i * 10, { a: i }); ghostStore.push(i * 10, { a: i + 2 }); }
  let reads = 0, scale = 1;
  const v = s.v; s.v = (...a) => { reads++; return v(...a); };
  const f = canvasFixture(), chart = createChart(f.canvas, s, { series: [{ key: 'a', color: 'red', scale: () => scale }] });
  const draw = (extra = {}) => chart.draw({ t0: 0, t1: 1000, hoverT: null, ...extra });
  draw(); assert.ok(reads >= 50);
  reads = 0; draw({ hoverT: 100 }); assert.ok(reads <= 2, 'hover reads only neighboring samples');
  reads = 0; s.push(500, { a: 99 }); draw(); assert.ok(reads >= 51);
  reads = 0; scale = 2; draw(); assert.ok(reads >= 51);
  reads = 0; f.resize(640); draw(); assert.ok(reads >= 51);
  reads = 0; draw({ t1: 900 }); assert.ok(reads >= 51);
  const ghost = { store: ghostStore, offset: 0 };
  reads = 0; draw({ ghost }); assert.ok(reads >= 51);
  reads = 0; draw({ ghost }); assert.equal(reads, 0);
  reads = 0; ghostStore.push(500, { a: 20 }); draw({ ghost }); assert.ok(reads >= 51);
  reads = 0; ghost.offset = 20; draw({ ghost }); assert.ok(reads >= 51);
});

test('a store without a revision never reuses stale pixel values', () => {
  const s = createStore(100), f = canvasFixture();
  s.push(0, { a: 1 });
  const unversioned = Object.fromEntries(['has','find','t','v','seg'].map(k => [k, s[k]]));
  Object.defineProperty(unversioned, 'size', { get: () => s.size });
  const chart = createChart(f.canvas, unversioned, { series: [{ key: 'a', color: 'red' }] });
  chart.draw({ t0: 0, t1: 1000, hoverT: null });
  s.push(10, { a: 20 });
  chart.draw({ t0: 0, t1: 1000, hoverT: 10 });
  assert.equal(chart.draw({ t0: 0, t1: 1000, hoverT: 10 }).readout[0].v, 20);
});

test('battery sparkline bounds SVG size while retaining one-sample peaks and endpoints in time order', () => {
  const values = Array(150000).fill(12);
  values[0] = 11; values[67891] = 9; values[67901] = 14; values[149999] = 13;
  const svg = sparkSVG(values), points = svg.match(/points="([^"]+)"/)[1].split(' ').map(p => p.split(',').map(Number));
  assert.ok(points.length <= 400, `${points.length} points`);
  assert.deepEqual(points[0], [0, 14]);
  assert.deepEqual(points.at(-1), [100, 6]);
  assert.ok(points.some(([, y]) => y === 22), 'single-sample voltage dip survives');
  assert.ok(points.some(([, y]) => y === 2), 'single-sample peak survives');
  assert.ok(points.every((p, i) => !i || p[0] >= points[i - 1][0]), 'no reordered extrema');
  assert.ok(svg.length < 5000);
  assert.match(sparkSVG([5, 5], { lo: 0, hi: 10 }), /0.0,12.0 100.0,12.0/);
});
