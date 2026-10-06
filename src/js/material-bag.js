import { zip, strToU8 } from 'fflate';
export const MAX_BYTES=100*1024*1024;
export function localFileURL(value,base=location.href){const u=new URL(value,base);if(u.origin!==new URL(base).origin||!/^\/(?:api\/file\/[\w-]+|api\/hub\/uploads\/[\da-f-]+\/file|files\/[\w/.-]+)$/.test(u.pathname))throw Error('这份资料需前往原站，不能直接打包。');return u.href;}
export const fileName=s=>String(s).replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').slice(0,115).replace(/[. ]+$/g,'')||'资料';
export async function buildMaterialZip(items,{signal,onProgress=()=>{},fetcher=fetch}={}) {
 if(!items.length||items.length>30)throw Error('请选择 1 至 30 份资料。');
 const files={},manifest=[],seen=new Set();let bytes=0;
 for(const item of items){
  signal?.throwIfAborted();const url=localFileURL(item.url);if(seen.has(url))continue;seen.add(url);
  const r=await fetcher(url,{signal,credentials:'same-origin'});
  if(!r.ok)throw Error(`“${item.title}”下载失败 (${r.status})；没有生成不完整的压缩包。`);
  if(/text\/html|application\/json/.test(r.headers.get('content-type')||''))throw Error(`“${item.title}”返回了网页，请先检查文件。`);
  const size=Number(r.headers.get('content-length')||0);if(bytes+size>MAX_BYTES)throw Error('所选文件超过 100 MB，请分批下载。');
  const reader=r.body.getReader(),chunks=[];let count=0;
  try{while(true){signal?.throwIfAborted();const {done,value}=await reader.read();if(done)break;count+=value.length;bytes+=value.length;if(bytes>MAX_BYTES)throw Error('所选文件超过 100 MB，请分批下载。');chunks.push(value);onProgress({done:manifest.length,total:items.length,bytes,title:item.title});}}catch(e){await reader.cancel();throw e;}
  const data=new Uint8Array(count);let offset=0;for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.length;}
  const path=`${String(manifest.length+1).padStart(2,'0')}_${fileName(item.title)}.${/^[a-z0-9]{1,8}$/i.test(item.format)?item.format:'bin'}`;
  files[path]=[data,{level:0}];manifest.push({file:path,title:item.title,course:item.course,year:item.year,source:item.source||'',rights:item.rights||'请保留原作者权利',download:url,bytes:count});
  onProgress({done:manifest.length,total:items.length,bytes,title:item.title});
 }
 files['来源与许可.json']=strToU8(JSON.stringify({exportedAt:new Date().toISOString(),notice:'文件使用遵循各自原作者许可；本机已有资料不代表允许公开转载。',files:manifest},null,2));
 return new Promise((resolve,reject)=>{signal?.throwIfAborted();const abort=()=>{terminate();reject(new DOMException('已取消打包','AbortError'));};const terminate=zip(files,{level:0},(error,result)=>{signal?.removeEventListener('abort',abort);error?reject(error):resolve(result);});signal?.addEventListener('abort',abort,{once:true});});
}
