// Compositor trace, separate from rAF timing; run with the same viewport/build.
import {chromium} from 'playwright';
import {writeFile} from 'node:fs/promises';
const phase=process.argv[2]||'after',base=process.env.MOTION_BASE||'http://127.0.0.1:17860';
const browser=await chromium.launch({headless:false,channel:'msedge'});
try {
 const page=await browser.newPage({viewport:{width:1440,height:1000},deviceScaleFactor:1});
 await page.goto(base+'/',{waitUntil:'domcontentloaded'});await page.waitForTimeout(1000);
 await page.keyboard.press('Control+k');await page.locator('.sl input[type=search]').waitFor();
 const client=await browser.newBrowserCDPSession();
 await client.send('Tracing.start',{categories:'benchmark,cc,viz,disabled-by-default-devtools.timeline.frame',transferMode:'ReturnAsStream'});
 await page.waitForTimeout(5000);await page.keyboard.press('Escape');await page.waitForTimeout(200);
 const complete=new Promise(resolve=>client.once('Tracing.tracingComplete',resolve));
 await client.send('Tracing.end');const {stream}=await complete;
 const chunks=[];let eof=false;
 while(!eof){const part=await client.send('IO.read',{handle:stream});chunks.push(part.base64Encoded?Buffer.from(part.data,'base64').toString():part.data);eof=part.eof;}
 await client.send('IO.close',{handle:stream});
 const text=chunks.join('');await writeFile(`campus/.data/motion-20261009/trace-${phase}.json`,text);
 const events=JSON.parse(text).traceEvents;
 console.log(JSON.stringify(events.filter(e=>e.name==='FrameSequenceTrackerV3').map(e=>e.args),null,2));
} finally {await browser.close();}
