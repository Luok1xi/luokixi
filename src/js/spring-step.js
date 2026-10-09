// Closed-form damped spring: re-targeting keeps velocity, and 60/120/144 Hz
// reach the same position at the same elapsed time (no Euler drift).
export function springStep(value, velocity, target, seconds, { stiffness = 640, damping = .86 } = {}) {
  if (seconds <= 0) return [value, velocity];
  const w = Math.sqrt(stiffness), a = damping*w, delta = value-target;
  if (damping >= 1) {
    const e = Math.exp(-w*seconds), b = velocity+w*delta;
    return [target+e*(delta+b*seconds), e*(velocity-w*b*seconds)];
  }
  const f = w*Math.sqrt(1-damping*damping), e = Math.exp(-a*seconds);
  const sin = Math.sin(f*seconds), cos = Math.cos(f*seconds);
  return [target+e*(delta*cos+(velocity+a*delta)/f*sin), e*(velocity*cos-(a*velocity+w*w*delta)/f*sin)];
}
