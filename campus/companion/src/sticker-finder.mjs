import {publicText,digest} from './public-reader.mjs';
import {stickers,expressiveStickers,findStickers} from './message-chain.mjs';
import {dateKey} from './time.mjs';

const repo='r48n34/sekai-sticker-v2',api='https://api.github.com/repos/'+repo;
// Search one inspected public collection, pin its commit, inspect new image bytes
// before putting them in the model's sendable catalogue. No arbitrary image URLs.
export class StickerFinder{
 constructor(service,{downloads,vision,read=publicText}={}){
  Object.assign(this,{service,downloads,vision,read});this.checked=0;this.inflight=null;
  service.store.db.exec('CREATE TABLE IF NOT EXISTS sticker_assets(id TEXT PRIMARY KEY,download_id TEXT,label TEXT,source TEXT,at INTEGER); CREATE TABLE IF NOT EXISTS sticker_checks(day TEXT PRIMARY KEY,at INTEGER)');
  for(const row of service.store.db.prepare('SELECT * FROM sticker_assets ORDER BY at DESC LIMIT 24').all())this.register(row);
 }
 register(row){if(stickers.some(s=>s.id===row.id))return;const entry={id:row.id,label:row.label,file:row.id+'.png',downloadId:row.download_id,tags:'Miku '+row.label};stickers.push(entry);expressiveStickers.push(entry);}
 async json(url){const r=await this.read(url,{headers:{Accept:'application/vnd.github+json'}});if(r.status!==200)throw new Error('表情素材目录 HTTP '+r.status);return JSON.parse(r.text);}
 async refresh(){
  const now=this.service.clock(),day=dateKey(now),db=this.service.store.db;
  if(db.prepare('SELECT 1 FROM sticker_checks WHERE day=?').get(day))return {status:'cached'};
  db.prepare('INSERT INTO sticker_checks VALUES(?,?)').run(day,now);db.exec('DELETE FROM sticker_checks WHERE day NOT IN (SELECT day FROM sticker_checks ORDER BY day DESC LIMIT 35)');
  const commit=await this.json(api+'/commits/HEAD'),sha=commit.sha;if(!/^[a-f0-9]{40}$/.test(sha))throw new Error('表情来源提交无效。');
  const rows=await this.json(api+'/contents/public/img/Miku?ref='+sha);if(!Array.isArray(rows))throw new Error('表情目录无效。');
  const candidates=rows.filter(x=>x.type==='file'&&/^Miku_\d{2,3}\.png$/.test(x.name)&&x.size>0&&x.size<=1000000&&!stickers.some(s=>s.file==='miku_'+x.name.slice(5))).slice(0,3);
  let added=0;for(const item of candidates){
   if(db.prepare('SELECT COUNT(*) n FROM sticker_assets').get().n>=24)break;
   const url='https://raw.githubusercontent.com/'+repo+'/'+sha+'/public/img/Miku/'+item.name,id='found_'+digest(item.sha||url).slice(0,16);
   if(db.prepare('SELECT 1 FROM sticker_assets WHERE id=?').get(id))continue;
   const file=await this.downloads.download(url),{bytes,mime}=await this.downloads.file(file.id);
   if(bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw new Error('候选素材不是 PNG。');
   const observation=await this.vision.observe(bytes);
   if(typeof observation.description!=='string'||!observation.description.trim()||observation.description.length>1200)continue;
   const row={id,download_id:file.id,label:observation.description.slice(0,350),source:url,at:now};
   db.prepare('INSERT OR IGNORE INTO sticker_assets VALUES(?,?,?,?,?)').run(row.id,row.download_id,row.label,row.source,row.at);this.register(row);added++;
  }
  return {status:'checked',added,source:'https://github.com/'+repo,commit:sha};
 }
 async find(query){let discovery;try{this.inflight??=this.refresh().finally(()=>{this.inflight=null;});discovery=await this.inflight;}catch(e){discovery={status:'unavailable',error:e.message};}return {stickers:findStickers(query),discovery};}
}
