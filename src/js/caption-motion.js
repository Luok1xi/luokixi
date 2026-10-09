import { SPRINGS } from './motion.js';

// A small tap is an impulse, not a replay from a fixed start position. Sample
// the exact spring once; the browser composites its transform with no rAF loop.
const { response, damping } = SPRINGS.interactive;
const omega = 2 * Math.PI / response;
const decay = omega * damping;
const frequency = omega * Math.sqrt(1 - damping * damping);

export function captionSpring(position = 0, velocity = 0) {
  if (!Number.isFinite(position) || !Number.isFinite(velocity)) throw new TypeError('Caption motion must be finite');
  function point(ms) {
    const time = Math.max(0, ms) / 1000;
    const b = (velocity + decay * position) / frequency;
    const envelope = Math.exp(-decay * time), c = Math.cos(frequency * time), s = Math.sin(frequency * time);
    return {
      position: envelope * (position * c + b * s),
      velocity: envelope * ((-decay * position + frequency * b) * c + (-decay * b - frequency * position) * s),
    };
  }
  let duration = 0;
  // A target crossing is not a rest. Inspect the whole response, including its tail.
  for (let ms = 0; ms <= 600; ms += 1000 / 120) {
    const p = point(ms);
    if (Math.abs(p.position) > .01 || Math.abs(p.velocity) > .2) duration = ms + 1000 / 120;
  }
  duration = Math.max(16, duration);
  const sample = ms => ms >= duration ? { position: 0, velocity: 0 } : point(ms);
  const frames = [];
  for (let ms = 0; ms < duration; ms += 1000 / 120) {
    frames.push({ offset: ms / duration, transform: `translateY(${sample(ms).position.toFixed(5)}px)` });
  }
  frames.push({ offset: 1, transform: 'translateY(0px)' });
  return { duration, sample, frames };
}

export function createCaptionMotion(element, reduced = () => false) {
  let animation = null, plan = null;
  function stop() { animation?.cancel(); animation = null; plan = null; }
  function tap() {
    if (reduced() || !element.animate) { stop(); return; }
    // currentTime is the presentation clock, so background pauses cannot cause a jump.
    const current = animation && plan ? plan.sample(Number(animation.currentTime) || 0) : { position: 0, velocity: 0 };
    animation?.cancel();
    // Cap total spring energy, not just speed: repeated taps can otherwise keep
    // adding displacement. This bounds travel to 3px without snapping position.
    const energyVelocity = omega * Math.sqrt(Math.max(0, 9 - current.position ** 2));
    plan = captionSpring(current.position, Math.max(-energyVelocity, current.velocity - 90));
    const next = element.animate(plan.frames, { duration: plan.duration, easing: 'linear' });
    animation = next;
    next.onfinish = () => { if (animation === next) { stop(); } };
  }
  return { tap, stop };
}
