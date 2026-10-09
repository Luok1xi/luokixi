import test from 'node:test';
import assert from 'node:assert/strict';
import { createCurtainPainter, isSoftwareWebGL } from '../src/js/curtain-painter.js';

function adapter(renderer, { masked = 'WebKit WebGL', privateRenderer = false } = {}) {
  return {
    RENDERER: 7937,
    released: 0,
    shaderCalls: 0,
    getExtension(name) {
      if (name === 'WEBGL_debug_renderer_info') return privateRenderer ? null : { UNMASKED_RENDERER_WEBGL: 37446 };
      if (name === 'WEBGL_lose_context') return { loseContext: () => this.released++ };
      return null;
    },
    getParameter(name) { return name === this.RENDERER ? masked : renderer; },
    createShader() { this.shaderCalls++; throw new Error('Software adapter must not compile shaders'); },
  };
}

function fixture(gl) {
  const operations = [], requests = [];
  const ctx = Object.fromEntries(['setTransform', 'clearRect', 'drawImage'].map(name => [name, (...args) => operations.push([name, ...args])]));
  function canvas() {
    let locked = false;
    return {
      width: 1280, height: 880, dataset: {},
      getContext(kind, attributes) {
        requests.push({ kind, attributes });
        if (kind === 'webgl2') { locked = !!gl; return gl; }
        if (kind === '2d') return locked ? null : ctx;
        return null;
      },
      cloneNode() { return canvas(); },
      replaceWith(next) { this.replacement = next; },
    };
  }
  return { canvas: canvas(), ctx, requests, operations };
}

test('explicit software renderers are rejected without confusing hardware vendors or masked adapters', () => {
  for (const name of [
    'ANGLE (Microsoft, Microsoft Basic Render Driver (0x0000008C), D3D11)',
    'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)',
    'llvmpipe (LLVM 17.0.6, 256 bits)', 'softpipe', 'ANGLE D3D11 WARP', 'Software Rasterizer',
  ]) assert.equal(isSoftwareWebGL(adapter(name)), true, name);
  for (const name of [
    'ANGLE (NVIDIA, NVIDIA GeForce RTX 5070 Laptop GPU, D3D11)',
    'ANGLE (Intel, Intel(R) UHD Graphics, D3D11)', 'AMD Radeon Graphics',
    'Apple M3', 'Mesa Intel(R) UHD Graphics', '',
  ]) assert.equal(isSoftwareWebGL(adapter(name)), false, name);
  assert.equal(isSoftwareWebGL(adapter('WARP', { privateRenderer: true })), false, 'masked information delegates to browser caveat policy');
  assert.equal(isSoftwareWebGL(adapter('', { privateRenderer: true, masked: 'Software Renderer' })), true);
  assert.equal(isSoftwareWebGL({ getExtension() { throw new Error('blocked'); }, getParameter() { throw new Error('blocked'); } }), false);
});

test('WARP falling through the browser caveat check is released and draws the same glyph in Canvas 2D', () => {
  const gl = adapter('ANGLE (Microsoft, Microsoft Basic Render Driver, D3D11)');
  const f = fixture(gl), painter = createCurtainPainter(f.canvas);
  assert.equal(f.requests[0].attributes.failIfMajorPerformanceCaveat, true);
  assert.equal(gl.shaderCalls, 0);
  assert.equal(gl.released, 1);
  assert.equal(painter.canvas, f.canvas.replacement);
  assert.equal(painter.canvas.dataset.renderer, '2d');
  assert.equal(painter.canvas.width, 1280);
  assert.equal(painter.canvas.height, 880);
  const atlas = { width: 512, height: 512 };
  painter.begin(atlas, 32);
  painter.glyph(170, 230, 0.8, 0.6, 64, 96, 0.7);
  assert.equal(f.ctx.globalAlpha, 0.7);
  painter.flush();
  assert.deepEqual(f.operations, [
    ['setTransform', 1, 0, 0, 1, 0, 0], ['clearRect', 0, 0, 1280, 880],
    ['setTransform', 0.8, 0.6, -0.6, 0.8, 170, 230],
    ['drawImage', atlas, 64, 96, 32, 32, -16, -16, 32, 32],
  ]);
  assert.equal(f.ctx.globalAlpha, 1);
});

test('browser caveat rejection and explicit Canvas mode retain the existing canvas', () => {
  const f = fixture(null), painter = createCurtainPainter(f.canvas);
  assert.equal(f.requests[0].attributes.failIfMajorPerformanceCaveat, true);
  assert.equal(painter.canvas, f.canvas);
  assert.equal(painter.canvas.dataset.renderer, '2d');
  const forced = fixture(adapter('WARP'));
  assert.equal(createCurtainPainter(forced.canvas, { forceCanvas: true }).canvas, forced.canvas);
  assert.deepEqual(forced.requests.map(request => request.kind), ['2d']);
});
