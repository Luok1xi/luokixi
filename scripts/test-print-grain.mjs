import test from 'node:test';
import assert from 'node:assert/strict';
import { makePrintGrain, applyPrintGrain } from '../src/js/print-grain.js';

test('worker grain matches the original RGB pixel loop and preserves alpha', () => {
  let seed = 7;
  const grain = makePrintGrain(4096,()=>((seed=seed*48271%2147483647)/2147483647));
  const expected = Uint8ClampedArray.from({length:4096*4},(_,i)=>(i*13)%256);
  const actual = expected.slice(), alpha = expected.filter((_,i)=>i%4===3);
  for(let i=0,p=0;i<expected.length;i+=4,p++) {const n=grain[p];expected[i]+=n;expected[i+1]+=n;expected[i+2]+=n;}
  // Chunked fallback and worker's single loop produce byte-identical textures.
  for(let from=0;from<grain.length;from+=127) applyPrintGrain(actual,grain,from,Math.min(grain.length,from+127));
  assert.deepEqual(actual,expected); assert.deepEqual(actual.filter((_,i)=>i%4===3),alpha);
  assert.ok(grain.every(n=>n>=-7&&n<=7));
});
