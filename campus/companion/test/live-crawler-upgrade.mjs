import {mkdir,writeFile} from 'node:fs/promises';
import {Store} from '../src/store.mjs';
import {Service} from '../src/service.mjs';
import {CrawlEngine} from '../src/crawl-engine.mjs';
import {AdaptiveReader} from '../src/web-tools.mjs';
import {BrowserReader} from '../src/browser-reader.mjs';
import {CapabilityMemory} from '../src/capability-memory.mjs';
import {StickerFinder} from '../src/sticker-finder.mjs';
const store=new Store(':memory:'),service=new Service(store),browser=new BrowserReader({dataDir:'test-output/browser-profile'}),memory=new CapabilityMemory(service),reader=new CrawlEngine({service,reader:new AdaptiveReader({browser,memory})}),report={at:new Date().toISOString()};
try{
 const urls=['https://proceedings.mlr.press/v267/gaven25a.html','https://aclanthology.org/2025.acl-long.1266/'];
 const began=Date.now();report.papers=(await reader.documents(urls)).map(r=>({url:r.url,ok:!!r.document,title:r.document?.title,characters:r.document?.text.length,readLevel:r.document?.readLevel,error:r.error}));report.firstMs=Date.now()-began;
 const second=Date.now();report.cached=(await reader.documents(urls)).map(r=>({url:r.url,cached:r.document?.cached,error:r.error}));report.cachedMs=Date.now()-second;
 try{const entries=await reader.discover({kind:'bilibili-search',query:'机器人'});report.bilibili={results:entries.length};if(entries[0]){const doc=await reader.document(entries[0].url);Object.assign(report.bilibili,{title:doc.title,characters:doc.text.length,readLevel:doc.readLevel});}}catch(e){report.bilibili={error:e.message};}
 report.stickerDiscovery=await new StickerFinder(service).find('害羞');report.crawler=reader.health.crawler;
 await mkdir('test-output',{recursive:true});await writeFile('test-output/live-crawler-upgrade.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));if(!report.papers.some(r=>r.ok))process.exitCode=1;
}finally{await reader.tail;await browser.close();store.close();}
