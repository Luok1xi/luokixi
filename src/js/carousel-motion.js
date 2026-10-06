import { SPRINGS } from './motion.js';

// Positions are in slide widths, velocities in slide widths per second.
// The closed form uses elapsed time directly: a missed frame never slows time.
const { response, damping } = SPRINGS.snappy;
const omega = (2 * Math.PI) / response;
const decay = damping * omega;
const frequency = omega * Math.sqrt(1 - damping * damping);
const STEP_MS = 1000 / 60;
const MAX_MS = 1200;
const POSITION_EPSILON = 0.0007;
const VELOCITY_EPSILON = 0.009;

function finite(value, name) {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
  return value;
}

function initial({ from, to, velocity = 0 }) {
  finite(from, 'from');
  finite(to, 'to');
  finite(velocity, 'velocity');
  finite(from - to, 'displacement');
  return { from, to, velocity };
}

function at({ from, to, velocity }, seconds) {
  const t = Math.max(0, finite(seconds, 'seconds'));
  if (t === 0) return { position: from, velocity };
  const a = from - to;
  const b = (velocity + decay * a) / frequency;
  const envelope = Math.exp(-decay * t);
  const cosine = Math.cos(frequency * t);
  const sine = Math.sin(frequency * t);
  return {
    position: to + envelope * (a * cosine + b * sine),
    velocity: envelope * ((-decay * a + frequency * b) * cosine
      + (-decay * b - frequency * a) * sine),
  };
}

export function sampleMotion(options, seconds) {
  return at(initial(options), seconds);
}

export function planMotion(options) {
  const state = initial(options);
  let lastOutside = -1;
  // Check the whole window so crossing the target is not mistaken for settling.
  for (let step = 0; step <= 72; step++) {
    const point = at(state, step / 60);
    if (Math.abs(point.position - state.to) > POSITION_EPSILON
      || Math.abs(point.velocity) > VELOCITY_EPSILON) lastOutside = step;
  }
  const duration = Math.min(MAX_MS, Math.max(16, (lastOutside + 1) * STEP_MS));
  const sample = (milliseconds) => {
    finite(milliseconds, 'milliseconds');
    if (milliseconds >= duration) return { position: state.to, velocity: 0 };
    return at(state, milliseconds / 1000);
  };
  const frames = [];
  for (let step = 0; step * STEP_MS < duration; step++) {
    const milliseconds = step * STEP_MS;
    frames.push({ offset: milliseconds / duration, ...sample(milliseconds) });
  }
  frames.push({ offset: 1, position: state.to, velocity: 0 });
  return { duration, frames, sample };
}
