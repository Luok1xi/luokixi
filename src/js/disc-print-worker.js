import { makePrintGrain, applyPrintGrain } from './print-grain.js';
let grain;
self.onmessage = ({data:{id,buffer}}) => {
  const pixels = new Uint8ClampedArray(buffer);
  if (grain?.length !== pixels.length/4) grain = makePrintGrain(pixels.length/4);
  applyPrintGrain(pixels,grain);
  self.postMessage({id,buffer},[buffer]);
};
