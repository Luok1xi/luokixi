// One atlas and one instanced draw for the whole curtain. Canvas 2D remains the
// fallback when hardware WebGL is unavailable; both paths use the exact same glyphs.
const SOFTWARE_RENDERER = /\b(?:swiftshader|llvmpipe|softpipe|warp)\b|microsoft basic render driver|software (?:rasterizer|renderer|rendering)/i;

export function isSoftwareWebGL(gl) {
  // The performance-caveat flag is the browser's decision. Also reject known
  // software adapters when exposed, without guessing from the browser or vendor.
  const renderers = [];
  try {
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    if (debug) renderers.push(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL));
  } catch { /* Renderer information can be blocked by privacy settings. */ }
  try { renderers.push(gl.getParameter(gl.RENDERER)); } catch { /* Use the browser's caveat decision. */ }
  return renderers.some(name => typeof name === 'string' && SOFTWARE_RENDERER.test(name));
}
const VERTEX = `#version 300 es
precision highp float;
layout(location=0) in vec2 corner;
layout(location=1) in vec2 center;
layout(location=2) in vec2 basis;
layout(location=3) in vec4 uvRect;
layout(location=4) in float opacity;
uniform vec2 resolution;
uniform float cell;
out vec2 uv;
out float alpha;
void main() {
  vec2 p = corner * cell;
  p = center + vec2(basis.x*p.x-basis.y*p.y, basis.y*p.x+basis.x*p.y);
  gl_Position = vec4(p.x/resolution.x*2.-1., 1.-p.y/resolution.y*2., 0., 1.);
  uv = uvRect.xy + (corner+.5)*uvRect.zw;
  alpha = opacity;
}`;
const FRAGMENT = `#version 300 es
precision mediump float;
uniform sampler2D atlas;
in vec2 uv;
in float alpha;
out vec4 color;
void main() { color = texture(atlas, uv) * alpha; }`;

function gpuPainter(canvas, gl) {
  const shader = (type, source) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, source); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { gl.deleteShader(s); throw new Error('Curtain shader unavailable'); }
    return s;
  };
  const vertex = shader(gl.VERTEX_SHADER, VERTEX), fragment = shader(gl.FRAGMENT_SHADER, FRAGMENT);
  const program = gl.createProgram(); gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
  gl.deleteShader(vertex); gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Curtain renderer unavailable');
  const vao = gl.createVertexArray(), corners = gl.createBuffer(), instances = gl.createBuffer(), texture = gl.createTexture();
  gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, corners);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-.5,-.5, .5,-.5, -.5,.5, -.5,.5, .5,-.5, .5,.5]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, instances);
  for (const [location, size, offset] of [[1,2,0],[2,2,2],[3,4,4],[4,1,8]]) {
    gl.enableVertexAttribArray(location); gl.vertexAttribPointer(location, size, gl.FLOAT, false, 36, offset*4); gl.vertexAttribDivisor(location, 1);
  }
  gl.useProgram(program);
  const resolution = gl.getUniformLocation(program, 'resolution'), cellUniform = gl.getUniformLocation(program, 'cell');
  gl.uniform1i(gl.getUniformLocation(program, 'atlas'), 0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  let data = new Float32Array(1024*9), length = 0, uploaded = null, cell = 0, allocated = 0;
  canvas.dataset.renderer = 'webgl2';
  return {
    canvas,
    begin(atlas, nextCell) {
      length = 0; cell = nextCell;
      gl.viewport(0, 0, canvas.width, canvas.height); gl.clear(gl.COLOR_BUFFER_BIT);
      if (atlas !== uploaded) { uploaded = atlas; gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas); }
      gl.uniform2f(resolution, canvas.width, canvas.height); gl.uniform1f(cellUniform, cell);
    },
    glyph(x, y, c, s, u, v, alpha) {
      if (length+9 > data.length) { const next = new Float32Array(data.length*2); next.set(data); data = next; }
      data[length++] = x; data[length++] = y; data[length++] = c; data[length++] = s;
      data[length++] = u/uploaded.width; data[length++] = v/uploaded.height;
      data[length++] = cell/uploaded.width; data[length++] = cell/uploaded.height; data[length++] = alpha;
    },
    flush() {
      if (!length) return;
      gl.bindBuffer(gl.ARRAY_BUFFER, instances);
      if (allocated < data.byteLength) { allocated = data.byteLength; gl.bufferData(gl.ARRAY_BUFFER, allocated, gl.DYNAMIC_DRAW); }
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data.subarray(0, length));
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, length/9);
    },
    destroy() { gl.deleteTexture(texture); gl.deleteBuffer(corners); gl.deleteBuffer(instances); gl.deleteVertexArray(vao); gl.deleteProgram(program); },
  };
}

export function createCurtainPainter(canvas, { forceCanvas = false } = {}) {
  let gl = null;
  try {
    gl = !forceCanvas && canvas.getContext('webgl2', {
      alpha:true, antialias:false, depth:false, stencil:false,
      premultipliedAlpha:true, preserveDrawingBuffer:false,
      failIfMajorPerformanceCaveat:true,
    });
    if (gl && !isSoftwareWebGL(gl)) return gpuPainter(canvas, gl);
  } catch { /* Keep the curtain available on blocked/older graphics drivers. */ }
  // Release a rejected/partially initialized context before replacing its canvas.
  // Losing it cannot unlock that canvas for 2D, so the replacement below is needed.
  try { gl?.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* Already unavailable. */ }
  let ctx = canvas.getContext('2d');
  if (!ctx) {
    const replacement = canvas.cloneNode(false); canvas.replaceWith(replacement); canvas = replacement; ctx = canvas.getContext('2d');
  }
  canvas.dataset.renderer = '2d';
  let atlas, cell;
  return {
    canvas,
    begin(next, size) { atlas = next; cell = size; ctx.setTransform(1,0,0,1,0,0); ctx.clearRect(0,0,canvas.width,canvas.height); },
    glyph(x,y,c,s,u,v,alpha) { ctx.globalAlpha = alpha; ctx.setTransform(c,s,-s,c,x,y); ctx.drawImage(atlas,u,v,cell,cell,-cell/2,-cell/2,cell,cell); },
    flush() { ctx.globalAlpha = 1; },
    destroy() {},
  };
}
