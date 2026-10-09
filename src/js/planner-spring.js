// Independent X/Y springs, damping ratio 0.8, response 0.34s. Retargeting keeps
// presentation position and velocity. Only active transforms receive frames.
export function createPlannerSprings() {
  const states = new Map(), media = matchMedia('(prefers-reduced-motion: reduce)');
  let frame = 0, previous = 0;
  const paint = state => { state.node.style.transform = `translate3d(${state.x}px,${state.y}px,0) scale(${state.sx},${state.sy})`; };
  function run(now) {
    const dt = Math.min((now - (previous || now - 16)) / 1000, 0.032); previous = now;
    const omega = 2 * Math.PI / 0.34, damping = 0.8;
    let active = false;
    for (const state of states.values()) {
      if (!state.node.isConnected) { states.delete(state.node); continue; }
      if (state.settled) continue;
      // Substeps make low-frequency frames stable without jumping to the target.
      for (let i = 0; i < 4; i++) for (const axis of ['x', 'y', 'sx', 'sy']) {
        const velocity = 'v' + axis, target = 't' + axis;
        state[velocity] += (omega * omega * (state[target] - state[axis]) - 2 * damping * omega * state[velocity]) * dt / 4;
        state[axis] += state[velocity] * dt / 4;
      }
      if (Math.abs(state.x - state.tx) + Math.abs(state.y - state.ty) < 0.12 && Math.abs(state.sx-state.tsx)+Math.abs(state.sy-state.tsy)<0.002 && Math.abs(state.vx) + Math.abs(state.vy) < 1) {
        state.x = state.tx; state.y = state.ty; state.vx = state.vy = 0; state.settled = true;
        state.sx=state.tsx;state.sy=state.tsy;state.vsx=state.vsy=0;
        state.node.style.willChange = ''; state.done?.(); state.done = null;
      } else active = true;
      paint(state);
    }
    frame = active ? requestAnimationFrame(run) : 0;
    if (!active) previous = 0;
  }
  function target(node, x = 0, y = 0, options = {}) {
    let state = states.get(node);
    if (!state) { state = { node, x: 0, y: 0, tx: 0, ty: 0, vx: 0, vy: 0, sx:1, sy:1, tsx:1, tsy:1, vsx:0, vsy:0, settled: true }; states.set(node, state); }
    if (options.from) { state.x = options.from.x; state.y = options.from.y;state.sx=options.from.sx??state.sx;state.sy=options.from.sy??state.sy; }
    if (options.velocity) { state.vx = options.velocity.x; state.vy = options.velocity.y; }
    state.tx = x; state.ty = y; state.tsx=options.scale?.x??1;state.tsy=options.scale?.y??1;state.done = options.done;
    if (media.matches || options.instant) { Object.assign(state, { x, y, vx: 0, vy: 0, sx:state.tsx,sy:state.tsy,vsx:0,vsy:0,settled: true }); paint(state); state.done?.(); state.done = null; return; }
    state.settled = false; node.style.willChange = 'transform'; paint(state);
    if (!frame) frame = requestAnimationFrame(run);
  }
  function stop(node) { const state = states.get(node); states.delete(node); node.style.transform = ''; node.style.willChange = ''; return state ? { x: state.x, y: state.y, vx: state.vx, vy: state.vy } : null; }
  return { target, stop, destroy() { cancelAnimationFrame(frame); states.forEach((_, node) => stop(node)); states.clear(); } };
}
