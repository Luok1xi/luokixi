import {getDocument,GlobalWorkerOptions} from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
GlobalWorkerOptions.workerSrc=workerUrl;

// Render one page at a time: usable in desktop WebViews without a PDF plugin,
// and bounded memory for scanned textbooks. Never execute PDF scripts.
export async function mountPDF(container,url){
  container.innerHTML=`<div class="reader-pdf-controls" aria-label="PDF 翻页与缩放">
    <button type="button" data-pdf-prev disabled>上一页</button><label>第 <input data-pdf-page type="number" min="1" value="1" aria-label="页码"> 页 <span data-pdf-count></span></label><button type="button" data-pdf-next disabled>下一页</button>
    <select data-pdf-zoom aria-label="缩放"><option value="1">适合宽度</option><option value="1.5">放大 150%</option><option value="2">放大 200%</option></select><button type="button" data-pdf-rotate>旋转</button></div>
    <p data-pdf-status role="status">正在加载 PDF…</p><div class="reader-pdf-canvas" aria-busy="true"></div>
    <details class="reader-pdf-text"><summary>本页可复制文本</summary><pre></pre></details>`;
  const $=s=>container.querySelector(s),box=$('.reader-pdf-canvas'),status=$('[data-pdf-status]');
  const assets=import.meta.env.DEV?'/node_modules/pdfjs-dist/':'/vendor/pdfjs/';
  const loading=getDocument({url,isEvalSupported:false,cMapUrl:assets+'cmaps/',cMapPacked:true,
    standardFontDataUrl:assets+'standard_fonts/',wasmUrl:assets+'wasm/'});
  let pdf,number=1,zoom=1,rotation=0,turn=0,task,observer,timer,disposed=false;
  const dispose=()=>{disposed=true;turn++;clearTimeout(timer);observer?.disconnect();task?.cancel();loading.destroy();};
  addEventListener('pagehide',dispose,{once:true});
  async function copyable(page,generation){
    const data=await page.getTextContent();if(generation!==turn||disposed)return;
    const text=data.items.map(x=>x.str+(x.hasEOL?'\n':' ')).join('').trim();
    $('.reader-pdf-text pre').textContent=text||'本页没有可提取的文字，可能是扫描图片。可查看上方原页或下载 PDF。';
  }
  async function draw(){
    if(!pdf||disposed)return;
    const generation=++turn;task?.cancel();box.setAttribute('aria-busy','true');status.textContent='正在显示第 '+number+' 页…';
    $('[data-pdf-page]').value=number;$('[data-pdf-prev]').disabled=number===1;$('[data-pdf-next]').disabled=number===pdf.numPages;
    $('.reader-pdf-text pre').textContent='展开后提取本页文字。';
    try{
      const page=await pdf.getPage(number);if(generation!==turn||disposed)return;
      const angle=(page.rotate+rotation)%360,original=page.getViewport({scale:1,rotation:angle});
      const viewport=page.getViewport({scale:Math.max(180,box.clientWidth-2)*zoom/original.width,rotation:angle});
      const ratio=Math.min(devicePixelRatio||1,2,Math.sqrt(8_000_000/(viewport.width*viewport.height)));
      const canvas=document.createElement('canvas');canvas.width=Math.ceil(viewport.width*ratio);canvas.height=Math.ceil(viewport.height*ratio);
      canvas.style.width=viewport.width+'px';canvas.style.height=viewport.height+'px';canvas.setAttribute('aria-label','PDF 第 '+number+' 页');
      task=page.render({canvasContext:canvas.getContext('2d'),viewport,transform:[ratio,0,0,ratio,0,0]});await task.promise;
      if(generation!==turn||disposed)return;
      box.replaceChildren(canvas);box.setAttribute('aria-busy','false');box.dataset.page=number;status.textContent='第 '+number+' / '+pdf.numPages+' 页';
      if($('.reader-pdf-text').open)await copyable(page,generation);
    }catch(error){if(generation!==turn||disposed||error.name==='RenderingCancelledException')return;box.setAttribute('aria-busy','false');status.textContent='此页未能显示，可重试翻页或下载原件。';}
  }
  try{
    pdf=await loading.promise;if(disposed)return dispose;
    $('[data-pdf-count]').textContent='/ '+pdf.numPages;$('[data-pdf-page]').max=pdf.numPages;
    $('[data-pdf-prev]').onclick=()=>{number=Math.max(1,number-1);draw();};
    $('[data-pdf-next]').onclick=()=>{number=Math.min(pdf.numPages,number+1);draw();};
    $('[data-pdf-page]').onchange=e=>{number=Math.max(1,Math.min(pdf.numPages,Math.floor(Number(e.target.value))||1));draw();};
    $('[data-pdf-zoom]').onchange=e=>{zoom=Number(e.target.value);draw();};
    $('[data-pdf-rotate]').onclick=()=>{rotation=(rotation+90)%360;draw();};
    $('.reader-pdf-text').ontoggle=async e=>{
      if(!e.target.open)return;const generation=turn;
      try{await copyable(await pdf.getPage(number),generation);}catch{if(generation===turn)$('.reader-pdf-text pre').textContent='本页文字暂时无法提取。';}
    };
    let width=box.clientWidth;
    observer=new ResizeObserver(()=>{if(Math.abs(box.clientWidth-width)<1)return;width=box.clientWidth;clearTimeout(timer);timer=setTimeout(draw,120);});observer.observe(box);
    await draw();
  }catch(error){box.setAttribute('aria-busy','false');status.textContent=error.name==='PasswordException'?'此 PDF 需要密码，请下载后解锁。':'PDF 暂时无法显示，仍可下载原件。';}
  return dispose;
}
