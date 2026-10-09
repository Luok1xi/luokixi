// Read-only check of the installed, running application. Does not send model or Feishu requests.
import {createRequire} from 'node:module';
import {mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
let playwright;try{playwright=require('playwright');}catch{playwright=require('C:/Users/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');}
const url='http://127.0.0.1:'+(process.env.MIKU_PORT||17839);
const health=await (await fetch(url+'/health',{signal:AbortSignal.timeout(3000)})).json();assert.equal(health.app,'miku-local');
const browser=await playwright.chromium.launch({channel:'msedge',headless:true});
try{const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(url);await page.locator('#send').waitFor();await page.waitForFunction(()=>!document.querySelector('#model-status').textContent.includes('读取'));
  for(const tab of ['plan','tasks','courses','memory','persona','research','settings','chat']){await page.locator(`nav [data-tab="${tab}"]`).click();assert.ok(await page.locator('#'+tab).isVisible());}
  assert.deepEqual(errors,[]);mkdirSync(resolve('test-output'),{recursive:true});await page.screenshot({path:resolve('test-output/installed-console.png'),fullPage:true});console.log('Installed Miku console is reachable; all panels open; no browser errors. '+url);
}finally{await browser.close();}
