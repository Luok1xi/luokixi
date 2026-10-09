import { makePrintGrain, applyPrintGrain } from './print-grain.js';
const nextTask = () => globalThis.scheduler?.yield?.() ?? new Promise(resolve=>setTimeout(resolve,0));

export function createDiscPrinter() {
  let worker, failed = false, disposed = false, serial = 0, grain;
  const pending = new Map();
  const unavailable = () => {
    failed = true; worker?.terminate(); worker = null;
    for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error('Disc worker unavailable')); }
    pending.clear();
  };
  function prepare() {
    if (worker || failed || disposed) return worker;
    try {
      worker = new Worker(new URL('./disc-print-worker.js',import.meta.url),{type:'module'});
      worker.onmessage = ({data:{id,buffer}}) => {
        const task = pending.get(id); if (!task) return;
        pending.delete(id); clearTimeout(task.timer); task.resolve(new Uint8ClampedArray(buffer));
      };
      worker.onerror = unavailable; worker.onmessageerror = unavailable;
    } catch { unavailable(); }
    return worker;
  }
  return {
    async apply(image) {
      if (disposed) throw new DOMException('Disc disposed','AbortError');
      const ready = prepare();
      if (ready) {
        try {
          const pixels = await new Promise((resolve,reject)=>{
            const id = ++serial, buffer = image.data.slice().buffer;
            const timer = setTimeout(unavailable,15000);
            pending.set(id,{resolve,reject,timer});
            try { ready.postMessage({id,buffer},[buffer]); }
            catch { unavailable(); }
          });
          if (disposed) throw new DOMException('Disc disposed','AbortError');
          image.data.set(pixels); return image;
        } catch (error) { if (disposed) throw error; }
      }
      // CSP/driver/worker failures keep exactly the same effect; split the CPU
      // fallback so pointer movement and the renderer can run between chunks.
      if (grain?.length !== image.data.length/4) grain = makePrintGrain(image.data.length/4);
      for (let from=0;from<grain.length;from+=32768) {
        await nextTask();
        if (disposed) throw new DOMException('Disc disposed','AbortError');
        applyPrintGrain(image.data,grain,from,Math.min(grain.length,from+32768));
      }
      return image;
    },
    dispose() { disposed = true; unavailable(); grain = null; },
  };
}
