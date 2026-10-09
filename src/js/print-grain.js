// The original disc algorithm: the same signed noise is added to RGB, preserving
// alpha and Uint8ClampedArray rounding. Shared by the worker and its fallback.
export function makePrintGrain(length, random = Math.random) {
  const grain = new Float32Array(length);
  for (let p=0;p<length;p++) grain[p] = (random()-.5)*14;
  return grain;
}

export function applyPrintGrain(pixels, grain, from = 0, to = grain.length) {
  for (let p=from;p<to;p++) {
    const i = p*4, n = grain[p]; pixels[i] += n; pixels[i+1] += n; pixels[i+2] += n;
  }
}
