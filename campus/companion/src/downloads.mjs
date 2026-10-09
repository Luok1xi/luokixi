import {lookup} from 'node:dns/promises';
import {Agent,fetch as request} from 'undici';
import {mkdir,writeFile,rename,readFile,unlink} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {publicAddress} from './public-reader.mjs';
import {sourceUrl} from './research-state.mjs';
import {limitedBytes,imageType} from './vision.mjs';
export async function publicBytes(url,{lookupFn=lookup,fetcher=request}={}){
 for(let hop=0;hop<4;hop++){
  const u=new URL(sourceUrl(url)),addresses=await lookupFn(u.hostname,{all:true,verbatim:true});
  if(!addresses.length||addresses.some(x=>!publicAddress(x.address)))throw new Error('下载地址不是公网地址。');
  const agent=new Agent({connect:{lookup:(host,opts,cb)=>{const rows=opts.family?addresses.filter(x=>x.family===opts.family):addresses;if(host!==u.hostname||!rows.length)return cb(new Error('下载目标无效'));cb(null,opts.all?rows:rows[0].address,rows[0]?.family);}}});
  try{const r=await fetcher(u.href,{dispatcher:agent,redirect:'manual',signal:AbortSignal.timeout(30000),headers:{'User-Agent':'MikuResearch/1.0'}});
   if(r.status>=300&&r.status<400){const location=r.headers.get('location');await r.body?.cancel();if(!location)throw new Error('下载重定向没有地址。');url=new URL(location,u).href;continue;}
   const bytes=await limitedBytes(r),type=r.headers.get('content-type')||'';let mime,ext;
   if(bytes.subarray(0,5).toString()==='%PDF-'){mime='application/pdf';ext='pdf';}
   else{try{mime=imageType(bytes);ext=mime.split('/')[1];}catch{if(!/^text\/(plain|csv)(;|$)/i.test(type)||bytes.includes(0)||bytes.subarray(0,2).toString()==='MZ')throw new Error('只下载 PDF、图片或纯文本资料，不下载程序、压缩包或登录页面。');mime='text/plain';ext='txt';}}
   return {bytes,mime,ext,url:u.href};
  }finally{await agent.close();}
 }throw new Error('资料跳转过多，已停止下载。');
}
export class Downloads{
 constructor(service,{directory,fetchBytes=publicBytes}={}){this.service=service;this.directory=resolve(directory);this.fetchBytes=fetchBytes;this.pending=new Map();service.store.db.exec('CREATE TABLE IF NOT EXISTS downloads(id TEXT PRIMARY KEY,url TEXT,title TEXT,mime TEXT,ext TEXT,size INTEGER,at INTEGER)');}
 list(){return this.service.store.db.prepare('SELECT * FROM downloads ORDER BY at DESC LIMIT 40').all();}
 async save({bytes,mime,ext,url,title}){const db=this.service.store.db,id=createHash('sha256').update(bytes).digest('hex'),old=db.prepare('SELECT * FROM downloads WHERE id=?').get(id);if(old)return {...old,cached:true};if(db.prepare('SELECT COALESCE(SUM(size),0) n FROM downloads').get().n+bytes.length>100*1024*1024)throw new Error('资料缓存已达 100MB，请先整理。');await mkdir(this.directory,{recursive:true});const file=resolve(this.directory,id+'.'+ext);await writeFile(file+'.part',bytes);await rename(file+'.part',file);db.prepare('INSERT OR IGNORE INTO downloads VALUES(?,?,?,?,?,?,?)').run(id,url,String(title||new URL(url).hostname).slice(0,200),mime,ext,bytes.length,this.service.clock());return db.prepare('SELECT * FROM downloads WHERE id=?').get(id);}
 exclusive(fn){const job=(this.queue||Promise.resolve()).then(fn);this.queue=job.catch(()=>{});return job;}
 download(url){url=sourceUrl(url);if(this.pending.has(url))return this.pending.get(url);const job=this.exclusive(()=>this.run(url)).finally(()=>this.pending.delete(url));this.pending.set(url,job);return job;}
 async run(url){const db=this.service.store.db,old=db.prepare('SELECT * FROM downloads WHERE url=? ORDER BY at DESC LIMIT 1').get(url);if(old&&this.service.clock()-old.at<1440)return {...old,cached:true};if(db.prepare('SELECT COUNT(*) n FROM downloads WHERE at>?').get(this.service.clock()-1440).n>=20)throw new Error('今天的资料缓存已达 20 份，先消化已读内容。');return this.save(await this.fetchBytes(url));}
 async archive(doc){return this.exclusive(()=>{if(this.service.store.db.prepare('SELECT COUNT(*) n FROM downloads WHERE at>?').get(this.service.clock()-1440).n>=20)throw new Error('今天已缓存 20 份资料。');return this.save({bytes:Buffer.from(JSON.stringify({title:doc.title,url:doc.url,readLevel:doc.readLevel,text:doc.text,comments:doc.comments,limitations:doc.limitations},null,2)),mime:'text/plain',ext:'txt',url:doc.url,title:doc.title});});}
 async file(id){const row=this.service.store.db.prepare('SELECT * FROM downloads WHERE id=?').get(id);if(!row)throw new Error('资料不存在。');return {...row,bytes:await readFile(resolve(this.directory,row.id+'.'+row.ext))};}
 remove(id){return this.exclusive(async()=>{const db=this.service.store.db,row=db.prepare('SELECT * FROM downloads WHERE id=?').get(id);if(!row)throw new Error('资料不存在。');await unlink(resolve(this.directory,row.id+'.'+row.ext)).catch(e=>{if(e.code!=='ENOENT')throw e;});db.prepare('DELETE FROM downloads WHERE id=?').run(id);return {message:'已删除这份本机资料缓存。已有阅读笔记可在网上见闻中单独清理。'};});}
}
