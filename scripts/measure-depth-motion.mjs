// Read-only isolated fixture: no network, accounts, posts, models or live database.
// Run from scripts/: node scripts/measure-depth-motion.mjs --mode candidate
// Compare: --mode compare [--baseline-dir /path/to/saved/source] [--baseline-ref 155f563]
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = name => {
  const inline = process.argv.find(value => value.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const repository = resolve(arg('repo-dir') ?? process.env.DEPTH_REPO_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
const baselineDirectory = arg('baseline-dir') ?? process.env.DEPTH_BASELINE_DIR;
const baselineRef = arg('baseline-ref') ?? '155f563';
const mode = arg('mode') ?? 'compare';
const repeats = Number(arg('repeats') ?? 2);
const selected = mode === 'compare' ? ['baseline', 'candidate'] : [mode];
if (selected.some(value => !['baseline', 'candidate'].includes(value))) throw new Error('Use --mode=baseline, candidate or compare.');
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) throw new Error('--repeats must be an integer from 1 to 10.');
if (!/^[a-zA-Z0-9_./-]{1,80}$/.test(baselineRef)) throw new Error('Invalid --baseline-ref.');
const outputPath = resolve(arg('output') ?? join(repository, 'campus/.data', `depth-motion-${mode}-result.json`));
const require = createRequire(join(repository, 'package.json'));
const { chromium } = require('playwright');
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const quantile = (values, fraction) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))].toFixed(3);
};
const baselineSource = (extension, relativePath) => {
  if (baselineDirectory) {
    const choices = [join(baselineDirectory, `depth-slider.baseline.${extension}`), join(baselineDirectory, `depth-slider.${extension}`), join(baselineDirectory, relativePath)];
    const filename = choices.find(existsSync);
    if (!filename) throw new Error(`Missing baseline ${extension}; checked ${choices.join(', ')}`);
    return readFileSync(filename, 'utf8');
  }
  try { return execFileSync('git', ['show', `${baselineRef}:${relativePath}`], { cwd: repository, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch { throw new Error('Cannot read baseline via git show. Supply --baseline-dir or DEPTH_BASELINE_DIR with saved depth-slider.js and depth-slider.css.'); }
};
const sourceFor = label => ({
  js: label === 'baseline' ? baselineSource('js', 'src/js/depth-slider.js') : readFileSync(join(repository, 'src/js/depth-slider.js'), 'utf8'),
  css: label === 'baseline' ? baselineSource('css', 'src/styles/depth-slider.css') : readFileSync(join(repository, 'src/styles/depth-slider.css'), 'utf8'),
  springStep: readFileSync(join(repository, 'src/js/spring-step.js'), 'utf8'),
  motion: readFileSync(join(repository, 'src/js/motion.js'), 'utf8'),
});
const stripModule = js => js.replace(/^import\s+.*?;\s*$/gm, '').replace(/\bexport\s+(?=(?:async\s+)?function|const|let|class)/g, '');
const transformModule = source => `const esc = value => String(value).replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));\n` +
  (source.js.includes("from './spring-step.js'") ? `const { springStep } = (() => { ${stripModule(source.springStep)}; return { springStep }; })();\n` : '') +
  (source.js.includes("from './motion.js'") ? `const { SPRINGS } = (() => { ${stripModule(source.motion)}; return { SPRINGS }; })();\n` : '') +
  stripModule(source.js) + '\nwindow.depthAPI = { depthSlides, mountDepthSlider, mountDepthPreviews };';

const browser = await chromium.launch({ headless: true, channel: 'msedge' });
const result = {
  createdAt: new Date().toISOString(), browser: browser.version(), mode, repeats,
  fixture: { rails: 30, imagesPerRail: 9, viewport: '1365 x 920', generatedSvg: true },
  limitations: [
    'Headless Edge requestAnimationFrame intervals measure renderer scheduling, not physical GPU refresh rate or presented frames.',
    'Deterministic in-browser SVG fixtures cannot verify decoding, memory or network behavior of real high-resolution photographs.',
    'DOM and requestAnimationFrame instrumentation adds equal observation overhead to both implementations.',
    'Synthetic pointer bursts measure input-handler work separately from realistic paced mouse input.',
    'The fixed 4x CPU slowdown is identical for both implementations and is not a claim about any particular user device.',
  ], implementations: {},
};

async function fixture(source, { cpu = 1, reducedMotion = 'no-preference', fallback = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1365, height: 920 }, reducedMotion });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body><main id="feed"></main></body></html>');
  await page.addStyleTag({ content: `
    :root { --fill: #e7e5df; --fg: #252525; --fg-2: #777; --fill-2: #ddd; --ease-ios: cubic-bezier(.2,.8,.2,1); --ease-out: cubic-bezier(.2,.8,.2,1); }
    * { box-sizing: border-box; } body { margin: 0; background:#f6f5f1; font:14px system-ui; }
    main { width:760px; margin:24px auto; } article { padding:24px; margin-bottom:16px; background:white; border-radius:20px; }
    article p { margin:0 0 10px; } .ds-track { --ds-ratio: 16 / 9; --ds-col: 78%; --ds-gap: 10px; }
    ${source.css}
    ${fallback ? '.ds-frame > .ds-img { animation: none !important; }' : ''}
  ` });
  await page.evaluate(({ fallback }) => {
    const bench = window.__bench = { tracked: new WeakSet(), counts: {}, operations: [], rawRaf: requestAnimationFrame.bind(window), errors: [] };
    bench.count = name => { bench.counts[name] = (bench.counts[name] ?? 0) + 1; };
    const tracked = node => bench.tracked.has(node);
    const patchProperty = name => {
      let owner = HTMLElement.prototype;
      while (owner && !Object.getOwnPropertyDescriptor(owner, name)) owner = Object.getPrototypeOf(owner);
      if (!owner) return;
      const descriptor = Object.getOwnPropertyDescriptor(owner, name);
      Object.defineProperty(owner, name, { ...descriptor,
        get: descriptor.get && function() { if (tracked(this)) bench.count(`read:${name}`); return descriptor.get.call(this); },
        set: descriptor.set && function(value) { if (tracked(this)) { bench.count(`write:${name}`); if (!Number.isFinite(Number(value))) bench.count('nonFiniteWrite'); } return descriptor.set.call(this, value); },
      });
    };
    ['scrollLeft', 'scrollWidth', 'clientWidth', 'offsetLeft', 'offsetWidth'].forEach(patchProperty);
    const scrollTo = Element.prototype.scrollTo;
    Element.prototype.scrollTo = function(...args) {
      if (tracked(this)) { bench.count('call:scrollTo'); bench.operations.push({ left: args[0]?.left ?? args[0], behavior: args[0]?.behavior ?? null }); }
      return scrollTo.apply(this, args);
    };
    const rect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function() { if (tracked(this)) bench.count('read:rect'); return rect.call(this); };
    window.requestAnimationFrame = callback => {
      bench.count('rafRequested');
      return bench.rawRaf(timestamp => { bench.count('rafCallback'); callback(timestamp); });
    };
    if (fallback) {
      const supports = CSS.supports.bind(CSS);
      CSS.supports = (...args) => args[0] === 'animation-timeline: view()' ? false : supports(...args);
    }
    bench.nextFrames = async (count = 2) => { for (let n = 0; n < count; n++) await new Promise(resolve => bench.rawRaf(resolve)); };
    bench.reset = () => { bench.counts = {}; bench.operations = []; };
    bench.snapshot = () => ({ ...bench.counts });
    bench.startFrames = () => {
      bench.deltas = []; bench.longTasks = []; bench.collect = true; let previous = null;
      bench.taskObserver?.disconnect();
      bench.taskObserver = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) if (bench.collect) bench.longTasks.push({ duration: entry.duration, startTime: entry.startTime });
      });
      bench.taskObserver.observe({ type: 'longtask', buffered: false });
      const sample = now => { if (!bench.collect) return; if (previous !== null) bench.deltas.push(now - previous); previous = now; bench.rawRaf(sample); };
      bench.rawRaf(sample);
    };
    bench.finishFrames = () => { bench.collect = false; bench.taskObserver?.disconnect(); return { deltas: bench.deltas, longTasks: bench.longTasks }; };
  }, { fallback });
  await page.addScriptTag({ content: transformModule(source) });
  await page.evaluate(async () => {
    const colors = ['#785f39', '#2c654e', '#a04449', '#305c86', '#68447b', '#ca7850', '#597c81', '#755952', '#314147'];
    const photos = colors.map((color, index) => 'data:image/svg+xml;base64,' + btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><defs><linearGradient id="g"><stop stop-color="${color}"/><stop offset="1" stop-color="#e9e2d8"/></linearGradient></defs><rect width="1280" height="720" fill="url(#g)"/><circle cx="${120 + index * 100}" cy="280" r="200" fill="${color}"/><path d="M0 610L360 360L700 540L980 160L1280 380V720H0Z" fill="#121719" opacity=".35"/><text x="550" y="150" fill="white" font-size="90">${index + 1}</text></svg>`));
    document.querySelector('#feed').innerHTML = Array.from({ length: 30 }, (_, index) => `<article><p>九图资料帖 ${index + 1}</p><div class="ds-track">${depthAPI.depthSlides(photos, '用于比较的固定图片')}</div></article>`).join('');
    window.tracks = [...document.querySelectorAll('.ds-track')];
    for (const element of document.querySelectorAll('.ds-track,.ds-frame')) __bench.tracked.add(element);
    window.disposers = tracks.map(track => depthAPI.mountDepthSlider(track, { controls: false, enter: false }));
    // Explicit eager load makes the fixed offscreen fixture deterministic; native lazy images
    // otherwise wait for visibility and an unconditional decode() can remain pending forever.
    for (const image of document.images) image.loading = 'eager';
    await Promise.all([...document.images].map(image => image.decode().catch(() => {})));
    await __bench.nextFrames(3);
    __bench.reset();
  });
  const cdp = await context.newCDPSession(page);
  if (cpu !== 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
  return { context, page, errors, close: () => context.close() };
}

const position = page => page.evaluate(() => ({ left: tracks[0].scrollLeft, classDragging: tracks[0].classList.contains('is-dragging'), maximum: tracks[0].scrollWidth - tracks[0].clientWidth }));
async function prepareDrag(page, left = 0) {
  await page.evaluate(async left => {
    const track = tracks[0]; track.classList.add('is-dragging'); track.scrollLeft = left;
    await __bench.nextFrames(2);
  }, left);
  const box = await page.locator('.ds-track').first().boundingBox();
  return { x: box.x + box.width - 26, y: box.y + box.height * .5 };
}
async function mouseDrag(page, { distance = 380, steps = 24, interval = 12, hold = 0 } = {}) {
  const point = await prepareDrag(page);
  await page.mouse.move(point.x, point.y); await page.mouse.down();
  for (let n = 1; n <= steps; n++) {
    await page.mouse.move(point.x - distance * n / steps, point.y);
    await delay(interval);
  }
  if (hold) await delay(hold);
  const atRelease = await position(page);
  const releasedAt = Date.now(); await page.mouse.up();
  let clearAt = null;
  const positions = [];
  for (let n = 0; n < 16; n++) {
    await delay(60); const state = await position(page); positions.push(state.left);
    if (clearAt === null && !state.classDragging) clearAt = Date.now() - releasedAt;
  }
  return { atRelease, final: await position(page), timeUntilDragClearedMs: clearAt, postReleaseRange: [+Math.min(...positions).toFixed(2), +Math.max(...positions).toFixed(2)] };
}

async function measure(source, cpu) {
  const run = await fixture(source, { cpu }); const { page } = run;
  try {
    const idle = await page.evaluate(async () => {
      __bench.reset();
      tracks.forEach(track => { track.classList.add('is-dragging'); track.scrollLeft = 120; });
      await __bench.nextFrames(4);
      return __bench.snapshot();
    });
    await page.evaluate(() => __bench.startFrames());
    const drag = await mouseDrag(page);
    // Stop at an exact snap point before holding: any extra movement then is stale
    // momentum rather than the legitimate nearest-frame snap between photographs.
    const heldDistance = await page.evaluate(() => {
      const frames = tracks[0].querySelectorAll('.ds-frame');
      return frames[1].offsetLeft - frames[0].offsetLeft;
    });
    const heldRelease = await mouseDrag(page, { distance: heldDistance, steps: 18, interval: 12, hold: 350 });
    heldRelease.heldAtExactSnapPoint = true;
    heldRelease.maximumPostReleaseExcursionPx = +Math.max(...heldRelease.postReleaseRange.map(left => Math.abs(left - heldRelease.atRelease.left))).toFixed(2);
    const edgePoint = await prepareDrag(page, 1e6);
    await page.mouse.move(edgePoint.x, edgePoint.y); await page.mouse.down();
    for (let n = 1; n <= 12; n++) { await page.mouse.move(edgePoint.x - n * 18, edgePoint.y); await delay(12); }
    const edgeReleasedAt = Date.now(); await page.mouse.up();
    let edgeClearAt = null;
    for (let n = 0; n < 18; n++) { await delay(50); if (!(await position(page)).classDragging) { edgeClearAt = Date.now() - edgeReleasedAt; break; } }
    const samples = await page.evaluate(() => __bench.finishFrames());
    const parallax = await page.evaluate(async () => {
      const track = tracks[0], frame = track.querySelectorAll('.ds-frame')[1], image = frame.querySelector('img');
      track.classList.add('is-dragging'); track.scrollLeft = 0; await __bench.nextFrames(3);
      const before = getComputedStyle(image).transform;
      track.scrollLeft = 330; await __bench.nextFrames(3);
      const after = getComputedStyle(image).transform;
      return { before, after, changed: before !== after, timelineSupported: CSS.supports('animation-timeline: view()') };
    });
    const burst = await page.evaluate(async () => {
      const track = tracks[0]; track.scrollLeft = 0; await __bench.nextFrames(3);
      const capture = track.setPointerCapture; track.setPointerCapture = () => {};
      const now = performance.now(), emit = (type, x, elapsed) => {
        const event = new PointerEvent(type, { bubbles: true, pointerType: 'mouse', button: 0, buttons: 1, pointerId: 7, clientX: x });
        Object.defineProperty(event, 'timeStamp', { value: now + elapsed }); track.dispatchEvent(event);
      };
      emit('pointerdown', 660, 0); __bench.reset();
      for (let n = 1; n <= 120; n++) emit('pointermove', 660 - n * 3, n);
      const duringHandlers = __bench.snapshot();
      await __bench.nextFrames(2); const afterFrame = __bench.snapshot();
      const finalLeft = track.scrollLeft;
      disposers[0](); track.setPointerCapture = capture; __bench.reset();
      await __bench.nextFrames(4);
      const afterDispose = __bench.snapshot();
      return { pointerMoves: 120, duringHandlers, afterFrame, finalLeft, afterDispose, leftoverDraggingClass: track.classList.contains('is-dragging'), mountedAfterDispose: track.dataset.depthSlider ?? null };
    });
    return {
      cpuSlowdown: cpu, idleNativeTracks: idle, drag, heldRelease, edgeTimeUntilDragClearedMs: edgeClearAt, parallax, burst,
      frames: { samples: samples.deltas.length, medianMs: quantile(samples.deltas, .5), p95Ms: quantile(samples.deltas, .95), p99Ms: quantile(samples.deltas, .99), over25Ms: samples.deltas.filter(value => value > 25).length, longTaskCount: samples.longTasks.length, longTaskTotalMs: +samples.longTasks.reduce((sum, task) => sum + task.duration, 0).toFixed(2) },
      errors: run.errors,
    };
  } finally { await run.close(); }
}

async function regressions(source) {
  const output = {};
  for (const options of [{ name: 'reducedMotion', reducedMotion: 'reduce' }, { name: 'fallback', fallback: true }]) {
    const run = await fixture(source, options);
    try {
      output[options.name] = await run.page.evaluate(async ({ name }) => {
        const track = tracks[0], image = track.querySelectorAll('img')[1];
        track.classList.add('is-dragging'); track.scrollLeft = 330; await __bench.nextFrames(3);
        const transform = getComputedStyle(image).transform, inlineTransform = image.style.transform;
        track.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' }));
        await new Promise(resolve => setTimeout(resolve, name === 'reducedMotion' ? 50 : 650));
        const afterKeyboard = track.scrollLeft;
        track.setPointerCapture = () => {};
        track.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', button: 0, pointerId: 8, clientX: 600 }));
        track.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse', button: 0, pointerId: 8, clientX: 520 }));
        await __bench.nextFrames(2);
        track.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerType: 'mouse', button: 0, pointerId: 8, clientX: 520 }));
        await __bench.nextFrames(3);
        const cancelLeft = track.scrollLeft, cancelDragging = track.classList.contains('is-dragging');
        await new Promise(resolve => setTimeout(resolve, 850));
        const cancelSettledLeft = track.scrollLeft, cancelSettledDragging = track.classList.contains('is-dragging');
        disposers.forEach(dispose => dispose()); __bench.reset(); await __bench.nextFrames(3);
        return { transform, inlineTransform, afterKeyboard, cancelLeft, cancelDragging, cancelSettledLeft, cancelSettledDragging, mountedCountAfterDispose: document.querySelectorAll('[data-depth-slider="on"]').length, animationRequestsAfterDispose: __bench.snapshot().rafRequested ?? 0 };
      }, options);
      output[options.name].errors = run.errors;
    } finally { await run.close(); }
  }
  const stateRun = await fixture(source);
  try {
    const { page } = stateRun;
    const point = await page.locator('.ds-track').first().boundingBox();
    await page.mouse.move(point.x + point.width / 2, point.y + point.height / 2);
    await page.evaluate(() => __bench.reset());
    await page.mouse.wheel(140, 0); await delay(250);
    const wheel = await page.evaluate(() => ({ counts: __bench.snapshot(), scrollOperations: [...__bench.operations] }));
    const state = await page.evaluate(async () => {
      const emit = (track, type, x, id = 7) => track.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: 'mouse', button: 0, buttons: 1, pointerId: id, clientX: x }));
      const leaveTrack = tracks[1]; leaveTrack.setPointerCapture = () => {};
      emit(leaveTrack, 'pointerdown', 600); emit(leaveTrack, 'pointermove', 597); emit(leaveTrack, 'pointerleave', 597);
      const beforeLeaveMove = leaveTrack.scrollLeft;
      emit(leaveTrack, 'pointermove', 400); await __bench.nextFrames(3);
      const afterLeaveMove = leaveTrack.scrollLeft;
      disposers[1]();
      const captureTrack = tracks[2]; captureTrack.setPointerCapture = () => {};
      emit(captureTrack, 'pointerdown', 600, 8); emit(captureTrack, 'pointermove', 500, 8); await __bench.nextFrames(2);
      emit(captureTrack, 'lostpointercapture', 500, 8); await new Promise(resolve => setTimeout(resolve, 900));
      const beforeCaptureMove = captureTrack.scrollLeft;
      emit(captureTrack, 'pointermove', 350, 8); await __bench.nextFrames(3);
      const afterCaptureMove = captureTrack.scrollLeft, captureDragging = captureTrack.classList.contains('is-dragging');
      disposers[2]();
      const hiddenTrack = tracks[3]; disposers[3](); hiddenTrack.parentElement.hidden = true;
      await __bench.nextFrames(3);
      const removeHidden = depthAPI.mountDepthSlider(hiddenTrack, { controls: true, enter: false });
      hiddenTrack.setPointerCapture = () => {};
      __bench.reset(); emit(hiddenTrack, 'pointerdown', 600, 9); emit(hiddenTrack, 'pointermove', 500, 9);
      // This track is genuinely hidden, so all frame geometry is zero.
      emit(hiddenTrack, 'pointerup', 500, 9);
      hiddenTrack.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' }));
      await __bench.nextFrames(3);
      const hiddenOperations = [...__bench.operations], nonFiniteWrites = __bench.snapshot().nonFiniteWrite ?? 0;
      hiddenTrack.parentElement.hidden = false; await __bench.nextFrames(3);
      hiddenTrack.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' }));
      await new Promise(resolve => setTimeout(resolve, 900));
      const revealedLeft = hiddenTrack.scrollLeft, revealedCount = hiddenTrack.nextElementSibling?.querySelector('.ds-count')?.textContent;
      removeHidden(); disposers.forEach(dispose => dispose());
      return {
        pointerLeaveBelowThreshold: { before: beforeLeaveMove, after: afterLeaveMove, passed: Math.abs(afterLeaveMove - beforeLeaveMove) < 1 },
        lostPointerCapture: { before: beforeCaptureMove, after: afterCaptureMove, dragging: captureDragging, passed: Math.abs(afterCaptureMove - beforeCaptureMove) < 1 && !captureDragging },
        hiddenGeometry: { operations: hiddenOperations, nonFiniteWrites, revealedLeft, revealedCount, passed: nonFiniteWrites === 0 && hiddenOperations.every(operation => Number.isFinite(operation.left)) && revealedLeft > 100 },
      };
    });
    output.interactionState = { idleWheel: { ...wheel, passed: wheel.scrollOperations.length === 0 }, ...state, errors: stateRun.errors };
  } finally { await stateRun.close(); }
  return output;
}

try {
  // Both sources are captured before any browser run so concurrent production edits cannot mix versions in one result.
  const sources = Object.fromEntries(selected.map(label => [label, sourceFor(label)]));
  for (const label of selected) {
    const source = sources[label];
    const record = result.implementations[label] = { jsSha256: createHash('sha256').update(source.js).digest('hex'), cssSha256: createHash('sha256').update(source.css).digest('hex'), runs: [] };
    for (const cpu of [1, 4]) for (let index = 0; index < repeats; index++) {
      const run = await measure(source, cpu); record.runs.push(run);
      console.log(JSON.stringify({ implementation: label, run: index + 1, cpu, frames: run.frames, burstScrollWrites: run.burst.afterFrame['write:scrollLeft'] ?? 0, idleAnimationRequests: run.idleNativeTracks.rafRequested ?? 0, edgeClearMs: run.edgeTimeUntilDragClearedMs, heldRelease: run.heldRelease, errors: run.errors }));
    }
    record.regressions = await regressions(source);
  }
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(result, null, 2));
  const candidate = result.implementations.candidate;
  if (candidate) {
    const failures = [];
    for (const run of candidate.runs) {
      if (run.errors.length) failures.push('browser errors');
      if (!run.parallax.changed) failures.push('missing scroll parallax');
      if ((run.burst.afterFrame['write:scrollLeft'] ?? 0) > 1) failures.push('pointer burst not coalesced');
      if ((run.idleNativeTracks.rafRequested ?? 0) !== 0) failures.push('empty native animation callbacks');
      if (run.heldRelease.maximumPostReleaseExcursionPx > 1) failures.push('stale release velocity');
      if (run.burst.leftoverDraggingClass || run.burst.mountedAfterDispose) failures.push('dispose retained drag state');
    }
    const regressions = candidate.regressions;
    for (const key of ['reducedMotion', 'fallback']) {
      const check = regressions[key];
      if (check.errors.length || check.cancelSettledDragging || check.mountedCountAfterDispose || check.animationRequestsAfterDispose) failures.push(key);
    }
    if (regressions.reducedMotion.transform !== 'none' || !regressions.fallback.inlineTransform) failures.push('motion preference or fallback');
    const state = regressions.interactionState;
    if (state.errors.length || !state.idleWheel.passed || !state.pointerLeaveBelowThreshold.passed
      || !state.lostPointerCapture.passed || !state.hiddenGeometry.passed) failures.push('interaction state');
    if (failures.length) throw new Error(`Motion regression: ${[...new Set(failures)].join(', ')}. See ${outputPath}`);
  }
  console.log(JSON.stringify({ output: outputPath, implementations: selected }));
} finally { await browser.close(); }
