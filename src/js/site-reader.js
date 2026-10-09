// Recognize only this site's stored content. Never turn the reader into a URL proxy.
export function readerTarget(value,base='http://127.0.0.1:17860/'){
  let url;try{url=new URL(value,base);}catch{return null;}
  if(url.origin!==new URL(base).origin)return null;
  const path=url.pathname;
  let m;
  if((m=/^\/api\/file\/([\w-]+)$/.exec(path)))return {kind:'document',id:m[1]};
  if((m=/^\/api\/hub\/uploads\/([a-f\d-]+)\/(?:file|photo)$/.exec(path)))return {kind:'upload',id:m[1]};
  if((m=/^\/api\/hub\/mirror\/([a-f\d-]+)\/file$/.exec(path)))return {kind:'mirror',id:m[1]};
  if((m=/^\/api\/hub\/reader\/entry\/([a-f\d-]+)\/download$/.exec(path)))return {kind:'entry',id:m[1]};
  if(/^\/api\/hub\/question-papers\/(?:collected\/)?[\w-]+\/(?:text|json)$/.test(path))return {file:path};
  if(/^\/api\/hub\/illustration\/[a-f0-9]{64}$/.test(path))return {file:path};
  if(/^\/(?:files|art)\/[\w%./-]+$/i.test(path)&&!/%2f|%5c|%25/i.test(path))return {file:path};
  return null;
}
export function readerURL(value,name='',base=globalThis.location?.href||'http://127.0.0.1:17860/'){
  const target=readerTarget(value,base);return target?`viewer.html?${new URLSearchParams({...target,...(name?{name}: {})})}`:null;
}
export function installSiteReader(){
  if(document.body.dataset.page==='viewer'||document.documentElement.dataset.readerInstalled)return;
  document.documentElement.dataset.readerInstalled='true';
  document.addEventListener('click',event=>{
    if(event.defaultPrevented||event.button!==0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;
    const link=event.target.closest('a[href]');
    if(!link||link.hasAttribute('download')||link.dataset.reader==='off')return;
    const target=readerURL(link.href,link.dataset.filename||link.textContent.trim().slice(0,160));
    if(target){event.preventDefault();location.assign(target);}
  });
}
