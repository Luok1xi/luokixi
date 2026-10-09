import {downloadRanges,pruneDownloadCache} from './download-ranges.js';
import '../styles/download-accelerator.css';
const CHUNK=1024*1024;
let installed=false,active=null;
export function installAccelerator(){if(installed)return;installed=true;
 document.addEventListener('click',event=>{const a=event.target.closest?.('a[data-accelerate]');if(!a||event.defaultPrevented||event.button||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
 const u=new URL(a.href,location.href);if(u.origin!==location.origin||!/^\/api\/(file\/|hub\/(mirror|uploads)\/)/.test(u.pathname))return;
 event.preventDefault();active?.abort();document.querySelector('.download-progress')?.remove();
 const panel=document.createElement('section');panel.className='download-progress';panel.setAttribute('aria-label','本站下载');
 panel.innerHTML='<b></b><progress max="1" value="0"></progress><p role="status" aria-live="polite"></p><div><button type="button" data-toggle>暂停</button><a data-plain download>普通下载</a><button type="button" data-close aria-label="关闭下载进度">关闭</button></div>';
 panel.querySelector('b').textContent=a.dataset.filename||a.download||'本站文件';const normal=panel.querySelector('[data-plain]');normal.href=a.href;normal.download=a.dataset.filename||a.download||'';document.body.append(panel);
 const status=panel.querySelector('p'),progress=panel.querySelector('progress'),toggle=panel.querySelector('[data-toggle]');let running=false,controller,lastPaint=0,start=0;
 async function startDownload(){controller=active=new AbortController();running=true;toggle.textContent='暂停';status.textContent='正在确认版本和可用分段…';start=performance.now();
 try{await pruneDownloadCache().catch(()=>{});const result=await downloadRanges(u.pathname+u.search,{signal:controller.signal,onProgress:p=>{if(controller.signal.aborted)return;const now=performance.now();if(now-lastPaint<100&&p.loaded<p.size)return;lastPaint=now;progress.value=p.loaded/p.size;status.textContent=`${Math.round(p.loaded/p.size*100)}% · ${((p.loaded-p.resumed)/1024/Math.max(.001,(now-start)/1000)).toFixed(0)} KB/秒${p.resumed?' · 已续传 '+(p.resumed/CHUNK).toFixed(1)+' MB':''}${!p.persistent?' · 浏览器未允许保存续传分段':''}`;}});
  const link=document.createElement('a'),object=URL.createObjectURL(result.blob);link.href=object;link.download=a.dataset.filename||a.download||'download';link.click();setTimeout(()=>URL.revokeObjectURL(object),60000);status.textContent=`下载完成${result.checksumVerified?' · SHA-256 校验一致':''} · 原件和来源保持不变`;toggle.hidden=true;
 }catch(e){status.textContent=controller.signal.aborted?'已暂停，继续时复用已完成的分段。':e.message;toggle.textContent='继续下载';}finally{running=false;}}
 toggle.addEventListener('click',()=>running?controller.abort():void startDownload());panel.querySelector('[data-close]').addEventListener('click',()=>{controller?.abort();panel.remove();});normal.addEventListener('click',()=>controller?.abort());void startDownload();
 });
}
