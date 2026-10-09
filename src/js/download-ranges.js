// Verified parallel ranges. Persisted chunks are keyed by immutable server ETag.
// No external download proxy, no opaque HTML saved as a package.
const CHUNK=1024*1024, MAX=128*CHUNK;
const db = () => new Promise((resolve,reject)=>{const r=indexedDB.open('luokixi-downloads',1);r.onupgradeneeded=()=>r.result.createObjectStore('chunks');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
async function cached(mode,key,value){const d=await db();try{return await new Promise((resolve,reject)=>{const tx=d.transaction('chunks',mode),s=tx.objectStore('chunks');let result;const r=mode==='readonly'?s.get(key):value===null?s.delete(key):s.put({bytes:value,at:Date.now()},key);r.onsuccess=()=>{result=mode==='readonly'?(r.result?.bytes??r.result):r.result;};tx.oncomplete=()=>resolve(result);tx.onerror=tx.onabort=()=>reject(tx.error);});}finally{d.close();}}
export async function pruneDownloadCache(){const d=await db();try{await new Promise((resolve,reject)=>{const tx=d.transaction('chunks','readwrite'),store=tx.objectStore('chunks'),r=store.openCursor(),rows=[];let total=0;r.onsuccess=()=>{const c=r.result;if(c){const {at=0,bytes}=c.value||{};if(at<Date.now()-7*86400000)c.delete();else{rows.push({key:c.key,at,size:bytes?.byteLength||0});total+=bytes?.byteLength||0;}c.continue();}else{for(const row of rows.sort((a,b)=>a.at-b.at)){if(total<=MAX)break;store.delete(row.key);total-=row.size;}}};tx.oncomplete=resolve;tx.onerror=tx.onabort=()=>reject(tx.error);});}finally{d.close();}}
export async function downloadRanges(url,{signal,onProgress=()=>{},fetcher=fetch,read=key=>cached('readonly',key),write=(key,value)=>cached('readwrite',key,value)}={}){
 const first=await fetcher(url,{headers:{Range:'bytes=0-0'},signal});
 const range=first.headers.get('content-range')?.match(/^bytes 0-0\/(\d+)$/),etag=first.headers.get('etag'),hash=first.headers.get('x-checksum-sha256');
 if(first.status!==206||!range||!etag||etag.startsWith('W/')){await first.body?.cancel();throw Error('此文件暂不支持分段续传，请使用普通下载。');}
 const size=Number(range[1]);await first.arrayBuffer();
 if(!Number.isSafeInteger(size)||size<1||size>MAX)throw Error('大于 128 MB 的文件请使用普通下载，避免浏览器占用过多内存。');
 const scope=url+'|'+etag, chunks=new Array(Math.ceil(size/CHUNK)),local=new AbortController(),abort=signal?AbortSignal.any([signal,local.signal]):local.signal;
 let next=0,loaded=0,resumed=0,persistent=true;
 async function worker(){while(next<chunks.length){abort.throwIfAborted();const i=next++,start=i*CHUNK,end=Math.min(size,start+CHUNK)-1,key=scope+'|'+i;
  let bytes;try{bytes=await read(key);}catch{persistent=false;}
  if(!(bytes instanceof ArrayBuffer)||bytes.byteLength!==end-start+1)bytes=null;
  if(bytes)resumed+=bytes.byteLength;
  else{for(let attempt=0;attempt<3;attempt++){abort.throwIfAborted();try{
   const r=await fetcher(url,{headers:{Range:`bytes=${start}-${end}`,'If-Range':etag},signal:abort});
   if(r.status!==206||r.headers.get('content-range')!==`bytes ${start}-${end}/${size}`||r.headers.get('etag')!==etag){await r.body?.cancel();throw Error('文件版本或分段响应变化，已停止；请重新下载。');}
   bytes=await r.arrayBuffer();if(bytes.byteLength!==end-start+1)throw Error('分段文件不完整。');break;
  }catch(e){if(abort.aborted||attempt===2)throw e;await new Promise(r=>setTimeout(r,150*(attempt+1)));}}
  if(persistent)try{await write(key,bytes);}catch{persistent=false;}}
  chunks[i]=bytes;loaded+=bytes.byteLength;onProgress({loaded,size,resumed,persistent,connections:3});
 }}
 try{await Promise.all(Array.from({length:Math.min(3,chunks.length)},()=>worker().catch(e=>{local.abort();throw e;})));}
 catch(e){throw e;}
 abort.throwIfAborted();const blob=new Blob(chunks,{type:'application/octet-stream'});
 if(hash&&/^[a-f0-9]{64}$/i.test(hash)){const actual=[...new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))].map(n=>n.toString(16).padStart(2,'0')).join('');if(actual!==hash.toLowerCase()){await Promise.all(chunks.map((_,i)=>write(scope+'|'+i,null).catch(()=>{})));throw Error('完整文件校验未通过，已清除损坏分段，没有保存错误文件。');}}
 abort.throwIfAborted();await Promise.all(chunks.map((_,i)=>write(scope+'|'+i,null).catch(()=>{})));
 return {blob,size,resumed,checksumVerified:Boolean(hash&&/^[a-f0-9]{64}$/i.test(hash)),etag};
}

