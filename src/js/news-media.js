// The original remains intact: only choose a frame fit and a validated focal point.
export function newsMediaLayout(media={},natural={}) {
  const size=value=>Number.isFinite(Number(value))&&Number(value)>0&&Number(value)<=32768?Number(value):0;
  const width=size(natural.width)||size(media.width),height=size(natural.height)||size(media.height);
  const fit=media.fit==='contain'||(width&&height&&height/width>1.2)?'contain':'cover';
  const match=String(media.position||media.focal||'').match(/^(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%$/);
  const position=match&&match.slice(1).every(x=>Number(x)<=100)?`${Number(match[1])}% ${Number(match[2])}%`:'50% 50%';
  return {width,height,fit,position};
}
export function bindNewsImage(image,media={}) {
  const paint=()=>{
    if(!image.naturalWidth)return;
    const value=newsMediaLayout(media,{width:image.naturalWidth,height:image.naturalHeight});
    image.style.objectFit=value.fit;image.style.objectPosition=value.position;
    if(image.parentElement?.classList.contains('hc-media'))image.parentElement.dataset.fit=value.fit;
  };
  if(image.complete)paint();else image.addEventListener('load',paint,{once:true});
}
