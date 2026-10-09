// Chinese explainer from the reviewed guide. A labelled editorial film, never a
// claim that arbitrary repository code has run successfully on this machine.
export function mountProjectFilm(host,{title,guide,source}){
 if(!host||!guide?.sections?.length)return()=>{};
 const selected=['purpose','features','first-use','limitations'].map(id=>guide.sections.find(s=>s.id===id)).filter(Boolean).slice(0,4);
 if(!selected.length)return()=>{};
 host.innerHTML='<canvas width="960" height="540" aria-label="项目中文讲解画面"></canvas><p>中文导读短片 · 自动图文讲解，非软件实录</p><div><button type="button" data-play>播放讲解</button><button type="button" data-save>下载讲解视频</button><span role="status"></span></div>';
 const canvas=host.querySelector('canvas'),ctx=canvas.getContext('2d'),play=host.querySelector('[data-play]'),save=host.querySelector('[data-save]'),status=host.querySelector('[role=status]');
 let raf=0,start=0,elapsed=0,playing=false,recorder=null,disposed=false,stream=null;const duration=selected.length*5000;
 function lines(text,x,y,width,size,lineHeight,max){ctx.font=`${size}px "Microsoft YaHei", sans-serif`;let row='',line=0;for(const ch of String(text).replace(/[#*_`]/g,'')){if(ch==='\n'||ctx.measureText(row+ch).width>width){ctx.fillText(row,x,y+line++*lineHeight);row='';if(line>=max)return;}if(ch!=='\n')row+=ch;}if(row)ctx.fillText(row,x,y+line*lineHeight);}
 function draw(ms){const index=Math.min(selected.length-1,Math.floor(ms/5000)),local=ms%5000,p=Math.min(1,local/500),e=1-Math.pow(1-p,3),s=selected[index];
 ctx.fillStyle='#f3f0eb';ctx.fillRect(0,0,960,540);ctx.fillStyle='#e2ddd7';ctx.beginPath();ctx.arc(910,30,270,0,Math.PI*2);ctx.fill();ctx.strokeStyle='#baa7a1';ctx.lineWidth=1;for(let i=0;i<4;i++){ctx.beginPath();ctx.ellipse(835,180,60+i*27,132-i*15,-.5+i*.18,0,Math.PI*2);ctx.stroke();}
 ctx.save();ctx.globalAlpha=e;ctx.translate(0,(1-e)*20);ctx.fillStyle='#7b6662';lines(title,56,65,750,20,25,1);ctx.fillStyle='#2f2a29';ctx.font='bold 34px "Microsoft YaHei", sans-serif';ctx.fillText(s.heading,56,145);lines(s.text||s.body||'',56,213,690,24,41,5);ctx.restore();
 ctx.fillStyle='#766f6b';lines('来源：'+source,56,470,840,14,20,1);lines('自动中文图文讲解 · 以原项目说明和本站导读为准',56,508,740,14,20,1);ctx.fillStyle='#82635e';ctx.fillRect(0,536,960*ms/duration,4);}
 function stop(){playing=false;cancelAnimationFrame(raf);play.textContent='继续播放';if(recorder?.state==='recording')recorder.stop();}
 function tick(now){if(!playing||disposed)return;elapsed=Math.max(0,Math.min(duration,now-start));draw(elapsed>=duration?duration-1:elapsed);if(elapsed>=duration){stop();play.textContent='重播';}else raf=requestAnimationFrame(tick);}
 function run(reset=false){if(reset||elapsed>=duration)elapsed=0;playing=true;start=performance.now()-elapsed;play.textContent='暂停';raf=requestAnimationFrame(tick);}
 play.onclick=()=>playing?stop():run();
 save.onclick=()=>{if(!globalThis.MediaRecorder||!canvas.captureStream){status.textContent='这个浏览器不支持生成视频；仍可播放讲解和下载中文导读。';return;}
 stop();const type=['video/webm;codecs=vp9','video/webm;codecs=vp8','video/webm'].find(t=>MediaRecorder.isTypeSupported(t));if(!type){status.textContent='当前浏览器不支持 WebM 导出。';return;}
 const parts=[];stream=canvas.captureStream(30);recorder=new MediaRecorder(stream,{mimeType:type,videoBitsPerSecond:1800000});save.disabled=play.disabled=true;status.textContent='正在生成视频，请保持本页打开…';
 recorder.ondataavailable=e=>{if(e.data.size)parts.push(e.data);};recorder.onstop=()=>{stream?.getTracks().forEach(t=>t.stop());save.disabled=play.disabled=false;if(disposed)return;if(elapsed<duration){status.textContent='已暂停生成，点击下载可重新生成完整短片。';return;}const blob=new Blob(parts,{type}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=title.replace(/[\\/:*?"<>|]/g,'_')+'-中文讲解.webm';a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);status.textContent='视频已生成，含中文讲解和来源。';};recorder.onerror=()=>{status.textContent='视频生成失败，请重试。';stop();};recorder.start(1000);run(true);
 };
 const hide=()=>{if(document.hidden&&playing)stop();};document.addEventListener('visibilitychange',hide);draw(500);
 return()=>{disposed=true;stop();stream?.getTracks().forEach(t=>t.stop());document.removeEventListener('visibilitychange',hide);};
}
