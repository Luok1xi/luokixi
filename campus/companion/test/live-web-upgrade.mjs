import {DatabaseSync} from 'node:sqlite';
import {createCanvas} from '@napi-rs/canvas';
import {writeFile,mkdir} from 'node:fs/promises';
import {Store} from '../src/store.mjs';
import {Service} from '../src/service.mjs';
import {Models} from '../src/models.mjs';
import {Vision} from '../src/vision.mjs';
import {BrowserReader} from '../src/browser-reader.mjs';
import {SocialReader} from '../src/social-reader.mjs';
import {readConfig} from '../src/config.mjs';
import {nowMinute} from '../src/time.mjs';
if(!process.argv.includes('--paid-check'))throw new Error('Pass --paid-check for budgeted real model verification');
const db=new DatabaseSync('data/miku.sqlite');db.exec('PRAGMA busy_timeout=5000');
const ledger={db,read:()=>JSON.parse(db.prepare('SELECT json FROM state WHERE id=1').get().json),transaction:fn=>{db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}};
const store=new Store(':memory:',nowMinute()),service=new Service(store),models=new Models(ledger,readConfig),vision=new Vision(service,models),browser=new BrowserReader({dataDir:'test-output/browser-profile'}),report={at:new Date().toISOString()};
try{
 const before=models.usage().spent,c=createCanvas(640,360),ctx=c.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,640,360);ctx.fillStyle='red';ctx.fillRect(50,50,100,100);ctx.fillStyle='black';ctx.font='40px sans-serif';ctx.fillText('MIKU 314',200,115);
 try{const r=await vision.observe(c.toBuffer('image/png'));report.vision={...r,costCny:models.usage().spent-before};}catch(e){report.vision={error:e.message};}
 console.log(JSON.stringify({vision:report.vision}));
 const reader=new SocialReader();for(const source of [{kind:'bilibili-search',query:'机器人'},{kind:'zhihu-search',query:'学习方法'}]){const name=source.kind.split('-')[0];report[name]={};try{const r=await reader.discover(source);report[name].api={count:r.length,title:r[0]?.title};}catch(e){report[name].api={error:e.message};}try{const r=await browser.discover(source);report[name].browser={count:r.length,title:r[0]?.title};}catch(e){report[name].browser={error:e.message,status:browser.status[name]};}console.log(JSON.stringify({[name]:report[name]}));}
 await mkdir('test-output',{recursive:true});await writeFile('test-output/live-web-upgrade.json',JSON.stringify(report,null,2));
}finally{await browser.close();store.close();db.close();}
