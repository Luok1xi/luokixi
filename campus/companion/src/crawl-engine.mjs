import {createRequire} from 'node:module';
import {digest,PublicReader} from './public-reader.mjs';
import {sourceUrl} from './research-state.mjs';
import {failureKind} from './capability-memory.mjs';
const require=createRequire(new URL('../tools/crawler/package.json',import.meta.url));
const {BasicCrawler,Configuration,RequestList,Log,LogLevel}=require('@crawlee/basic');

// Crawlee owns bounded queues, deduplication, concurrency and retries. Existing
// readers retain DNS pinning, robots checks and the isolated browser session.
export class CrawlEngine{
 constructor({reader,service,publicReader=new PublicReader()}){
  Object.assign(this,{reader,service,publicReader});this.pending=new Map();this.tail=Promise.resolve();this.hits=0;this.fetched=0;
  this.db=service.store.db;this.db.exec('CREATE TABLE IF NOT EXISTS crawl_cache(key TEXT PRIMARY KEY,body TEXT NOT NULL,expires INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS crawl_epoch(id INTEGER PRIMARY KEY,value INTEGER); INSERT OR IGNORE INTO crawl_epoch VALUES(1,0)');
 }
 get browser(){return this.reader.browser;}
 get health(){return {...this.reader.health,crawler:{engine:'Crawlee 3.18.1',cacheHits:this.hits,fetched:this.fetched,queued:this.pending.size}};}
 discover(source){return this.reader.discover(source);}
 clear(){this.reader.clear?.();this.db.exec('DELETE FROM crawl_cache; UPDATE crawl_epoch SET value=value+1');}
 async document(value){
  const url=sourceUrl(value),key=digest(url),cached=this.db.prepare('SELECT body FROM crawl_cache WHERE key=? AND expires>?').get(key,this.service.clock());
  if(cached){this.hits++;return {...JSON.parse(cached.body),cached:true};}
  if(this.pending.has(url)){this.hits++;return this.pending.get(url).promise;}
  let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});this.pending.set(url,{promise,resolve,reject});
  if(!this.scheduled){this.scheduled=true;queueMicrotask(()=>{this.scheduled=false;const entries=[...this.pending.entries()].filter(([,x])=>!x.started);for(const [,x]of entries)x.started=true;this.tail=this.tail.catch(()=>{}).then(async()=>{for(let i=0;i<entries.length;i+=4)await this.batch(entries.slice(i,i+4));});});}
  return promise;
 }
 async documents(urls){if(!Array.isArray(urls)||!urls.length||urls.length>4)throw new Error('一次可读取 1—4 个公开链接。');return Promise.all([...new Set(urls.map(sourceUrl))].map(async url=>{try{return {url,document:await this.document(url)};}catch(e){return {url,error:e.message};}}));}
 async batch(entries){
  const epoch=this.db.prepare('SELECT value FROM crawl_epoch WHERE id=1').get().value;
  const jobs=new Map(entries),settled=new Set();
  const finish=(url,error,doc)=>{if(settled.has(url))return;settled.add(url);this.pending.delete(url);error?jobs.get(url).reject(error):jobs.get(url).resolve(doc);};
  try{
   const requestList=await RequestList.open(null,entries.map(([url])=>({url,uniqueKey:url})),{persistStateKey:undefined});
   const crawler=new BasicCrawler({requestList,maxConcurrency:2,minConcurrency:2,maxRequestRetries:1,requestHandlerTimeoutSecs:180,
    log:new Log({level:LogLevel.OFF}),
    requestHandler:async({request})=>{
     let doc;try{try{doc=await this.reader.document(request.url);}catch(e){if(!/网址|域名|支持|来源/.test(e.message)||failureKind(e.message)==='policy')throw e;doc=(await this.publicReader.source({url:request.url,kind:'page'}))[0];}
      if(!doc?.text||doc.text.length<40)throw new Error('正文不足，不能记为读过。');
     }catch(e){if(failureKind(e.message)!=='transient')request.noRetry=true;throw e;}
     this.fetched++;this.reader.memory?.record({capability:'read-queue',implementation:'Crawlee 3.18.1',scope:new URL(request.url).hostname,target:request.url,ok:true});
     if(this.db.prepare('SELECT value FROM crawl_epoch WHERE id=1').get().value!==epoch){request.noRetry=true;throw new Error('阅读缓存已清除，旧结果作废。');}
     this.db.prepare('INSERT OR REPLACE INTO crawl_cache VALUES(?,?,?)').run(digest(request.url),JSON.stringify(doc),this.service.clock()+60);
     this.db.exec('DELETE FROM crawl_cache WHERE key NOT IN (SELECT key FROM crawl_cache ORDER BY expires DESC LIMIT 120)');finish(request.url,null,doc);
    },failedRequestHandler:async({request},error)=>{this.reader.memory?.record({capability:'read-queue',implementation:'Crawlee 3.18.1',scope:new URL(request.url).hostname,target:request.url,ok:false,error:error?.message||'抓取失败'});finish(request.url,error||new Error('抓取失败。'));}
   },new Configuration({persistStorage:false,telemetryEnabled:false}));
   await crawler.run();
  }catch(e){for(const [url]of entries)finish(url,e);}
  finally{for(const [url]of entries)if(!settled.has(url))finish(url,new Error('阅读队列中断，没有完整结果。'));}
 }
}
