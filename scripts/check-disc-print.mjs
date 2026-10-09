import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const out = 'campus/.data/motion-20261009'; await mkdir(out,{recursive:true});
const browser = await chromium.launch({headless:true,executablePath:'C:/Users/user/AppData/Local/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe'});
const results = [];
try {
 for(const fallback of [false,true]) {
  const page = await browser.newPage(); let workers = 0; page.on('worker',()=>workers++);
  await page.addInitScript(fallback=>{if(fallback)window.Worker=function(){throw new Error('Worker blocked');};},fallback);
  await page.goto('http://127.0.0.1:17875/');
  const result = await page.evaluate(async()=>{
   const {createDiscPrinter}=await import('/src/js/disc-print.js');
   const printer=createDiscPrinter(), image=new ImageData(1024,1024); image.data.fill(128);
   await printer.apply(image);
   let correct=true,changed=0;
   for(let i=0;i<image.data.length;i+=4) {
    const n=image.data[i]; if(n<121||n>135||image.data[i+1]!==n||image.data[i+2]!==n||image.data[i+3]!==128)correct=false;
    changed+=Number(n!==128);
   }
   const pending=printer.apply(new ImageData(1024,1024)).then(()=>false,()=>true); printer.dispose();
   return {correct,changed,cancelled:await pending};
  });
  assert.equal(result.correct,true); assert.ok(result.changed>800000); assert.equal(result.cancelled,true);
  assert.equal(workers,fallback?0:1);
  results.push({fallback,workers,...result}); await page.close();
 }
 await writeFile(`${out}/disc-print-browser.json`,JSON.stringify(results,null,2)); console.log(JSON.stringify(results));
}finally{await browser.close();}
