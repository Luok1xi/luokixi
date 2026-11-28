const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["./three.module-DFPdTWIZ.js","./three.module-BNgLwbNs.js"])))=>i.map(i=>d[i]);
import{r as e}from"./data-Dv5cexaq.js";import{c as t,i as n}from"./motion-C2sOdNpi.js";import{t as r}from"./preload-helper-BaNbYf_w.js";import{d as i,n as a,u as o}from"./items-Dl80fwFT.js";import{n as s,t as c}from"./disc-rack-CXnCYODt.js";import{t as l}from"./album-plugins-DWDg3vg7.js";import{a as u,i as d,n as f,r as p,t as m}from"./wall-art-BO73Beb6.js";import{t as h}from"./disc-print-qrC50m4M.js";var g=`
uniform float uR, uAngle, uOffset, uOffsetY, uLift, uVel, uFlat, uGrabS, uDepth, uVertical, uFluidAmt;
uniform vec2 uGrab, uRes, uDims;
uniform vec4 uHole;
uniform sampler2D uFluid;
varying vec2 vUv, vS, vScreen;
varying float vFace;

// 几何体都是 1×1 的平面，尺寸由 uDims 给（桌面横排、手机竖排共用一套几何体）
vec3 deform(vec3 position) {
  float x = position.x * uDims.x + uOffset;
  float y = position.y * uDims.y + uOffsetY;
  float th = uAngle + x / uR;
  float s = th * uR;
  float a = abs(th);
  float v = uVel;
  // 速度：两头捏细、拧过去，中间鼓出来
  float pinch = 1.0 - min(0.78, abs(v) * 1.35 * smoothstep(0.02, 0.75, a));
  float twist = v * 1.55 * smoothstep(0.03, 0.85, a) * sign(th);
  float bulge = abs(v) * 2.3 * exp(-th * th * 4.0);
  // 拖动：手底下那块被拽向镜头，上下往手的位置收一点
  vec2 dg = vec2(s - uGrab.x, y - uGrab.y);
  float grab = uGrabS * exp(-dot(dg, dg) / 2.4);
  float yy = y * pinch + (uGrab.y - y) * grab * 0.32;
  float r = uR + uDepth - uLift - bulge - grab * 1.9;
  // 拧：高度的一部分变成前后
  r -= yy * sin(twist);
  yy *= cos(twist);
  vec3 bent = vec3(sin(th) * r, yy, -cos(th) * r);
  float rf = uR + uDepth - uLift;
  // 打开时这一张慢慢展平，正对镜头
  vec3 plane = vec3(sin(uAngle) * rf + cos(uAngle) * x, y, -cos(uAngle) * rf + sin(uAngle) * x);
  vFace = mix(cos(th), 1.0, uFlat);
  vS = vec2(x, y);
  vec3 p = mix(bent, plane, uFlat);
  return uVertical > 0.5 ? vec3(p.y, -p.x, p.z) : p;
}

// 投到屏幕上以后再做两件屏幕空间的事：洞口撑开、液体推开
vec4 place(vec3 world) {
  vec4 clip = projectionMatrix * viewMatrix * vec4(world, 1.0);
  vec2 px = (clip.xy / clip.w * 0.5 + 0.5) * uRes;
  if (uHole.w > 0.0) {
    vec2 d = px - uHole.xy;
    float r = length(d) + 1e-3;
    px += d / r * uHole.z * exp(-pow(r / max(uHole.z, 1.0), 2.0) * 0.7) * uHole.w;
  }
  vScreen = px / uRes;
  vec2 f = texture2D(uFluid, vScreen).xy;
  px += f * uRes * uFluidAmt;
  clip.xy = (px / uRes * 2.0 - 1.0) * clip.w;
  return clip;
}
void main() {
  vUv = uv;
  gl_Position = place(deform(position));
}`,_=`
  vec2 flow = texture2D(uFluid, vScreen).xy;
`,v=`
uniform vec2 uFluidTexel, uRes;
vec3 fluidLight(vec3 color, float sheen) {
  float left = texture2D(uFluid, vScreen - vec2(uFluidTexel.x, 0.0)).z;
  float right = texture2D(uFluid, vScreen + vec2(uFluidTexel.x, 0.0)).z;
  float down = texture2D(uFluid, vScreen - vec2(0.0, uFluidTexel.y)).z;
  float up = texture2D(uFluid, vScreen + vec2(0.0, uFluidTexel.y)).z;
  vec2 slope = vec2(right - left, up - down) / (2.0 * uFluidTexel);
  slope.x *= uRes.y / uRes.x;
  vec3 normal = normalize(vec3(-slope * 1.5, 1.0));
  vec3 light = normalize(vec3(-0.45, 0.65, 1.0));
  vec3 halfway = normalize(light + vec3(0.0, 0.0, 1.0));
  float diffuse = clamp(1.0 + (dot(normal, light) - light.z) * 1.2, 0.56, 1.14);
  float specular = max(0.0, pow(max(dot(normal, halfway), 0.0), 40.0) - pow(halfway.z, 40.0));
  return color * diffuse + specular * sheen;
}
`,ee=`
uniform sampler2D uMap, uCover, uFluid;
uniform vec2 uDims;
uniform vec4 uCoverRect;
uniform float uReady, uDim, uWhite, uOpacity, uAngle, uGloss, uVertical, uCoverOn, uCoverAspect;
varying vec2 vUv, vS, vScreen;
varying float vFace;
${v}
void main() {
  ${_}
  // 手机竖排时贴图转回来
  vec2 uv = uVertical > 0.5 ? vec2(vUv.y, 1.0 - vUv.x) : vUv;
  // 液体把画面往回抹一点（顶点已经推开了，这里让画面跟着“流”）
  uv = clamp(uv - flow * 0.16, 0.0, 1.0);
  // 圆角
  vec2 q = abs(vUv - 0.5) * uDims;
  vec2 b = uDims * 0.5 - 0.06;
  float alpha = 1.0 - smoothstep(-0.004, 0.004, length(max(q - b, 0.0)) - 0.06);
  vec3 c = mix(vec3(0.13), texture2D(uMap, uv).rgb, uReady);
  // 插件给的封面（视频 / 图）铺在 CD 盒的小册子位置，按 cover 方式裁
  if (uCoverOn > 0.5) {
    vec2 k = (uv - uCoverRect.xy) / uCoverRect.zw;
    if (all(greaterThanEqual(k, vec2(0.0))) && all(lessThanEqual(k, vec2(1.0)))) {
      vec2 s = uCoverAspect > 1.0 ? vec2(1.0 / uCoverAspect, 1.0) : vec2(1.0, uCoverAspect);
      c = texture2D(uCover, (k - 0.5) * s + 0.5).rgb;
    }
  }
  // 玻璃盖子上的一道反光，随卡片转动扫过去
  float sweep = vUv.x * 0.8 + (1.0 - vUv.y) * 0.45 - 0.62 - uAngle * 0.9;
  c += uGloss * (smoothstep(0.07, 0.0, abs(sweep)) * 0.16 + smoothstep(0.03, 0.0, abs(sweep - 0.12)) * 0.08);
  c = fluidLight(c, 0.08);
  c *= mix(0.3, 1.0, smoothstep(0.5, 1.0, vFace)) * (1.0 - uDim * 0.4);
  c = mix(c, vec3(0.985), uWhite);
  // 透明的圆角不写深度，不然会挡住后画的光碟和卡片
  if (alpha * uOpacity < 0.004) discard;
  gl_FragColor = vec4(c, alpha * uOpacity);
  #include <colorspace_fragment>
}`,te=`
uniform sampler2D uMap, uFluid;
uniform float uReady, uDim, uOpacity, uSpin;
varying vec2 vUv, vScreen;
varying float vFace;
${v}
void main() {
  ${_}
  vec2 p = vUv - 0.5 - flow * 0.16;
  float cs = cos(uSpin), sn = sin(uSpin);
  vec2 uv = vec2(cs * p.x - sn * p.y, sn * p.x + cs * p.y) + 0.5;
  vec4 t = texture2D(uMap, uv);
  float r = length(vUv - 0.5);
  float alpha = t.a * (1.0 - smoothstep(0.495, 0.5, r)) * uReady;
  vec3 c = t.rgb * mix(0.3, 1.0, smoothstep(0.5, 1.0, vFace)) * (1.0 - uDim * 0.4);
  // 盘面的一圈高光
  c += smoothstep(0.012, 0.0, abs(r - 0.47)) * 0.25;
  c = fluidLight(c, 0.14);
  // 圆外面那四个角不写深度：光碟滑到隔壁盒子上时，隔壁不会被挖成黑块
  if (alpha * uOpacity < 0.004) discard;
  gl_FragColor = vec4(c, alpha * uOpacity);
  #include <colorspace_fragment>
}`,ne=`varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,re=`
varying vec3 vW; uniform float uSpin, uFade;
void main() {
  float c = cos(uSpin), s = sin(uSpin);
  vec2 p = mat2(c, -s, s, c) * vW.xz / 0.9;
  vec2 g = abs(fract(p - 0.5) - 0.5) / fwidth(p);
  float line = 1.0 - min(min(g.x, g.y), 1.0);
  float fade = smoothstep(26.0, 4.0, length(vW.xz));
  gl_FragColor = vec4(vec3(0.9), line * fade * 0.24 * uFade);
}`;function ie(e,t,{size:n=192}={}){let r={type:e.HalfFloatType,format:e.RGBAFormat,minFilter:e.LinearFilter,magFilter:e.LinearFilter,wrapS:e.ClampToEdgeWrapping,wrapT:e.ClampToEdgeWrapping,depthBuffer:!1,stencilBuffer:!1},i=new e.WebGLRenderTarget(n,n,r),a=i.clone(),o=new e.Scene,s=new e.OrthographicCamera(-1,1,1,-1,0,1),c={uPrev:{value:i.texture},uTexel:{value:new e.Vector2(1/n,1/n)},uFrom:{value:new e.Vector2},uTo:{value:new e.Vector2},uForce:{value:new e.Vector2},uRadius:{value:.045},uDecay:{value:1},uStep:{value:1},uAspect:{value:1},uOn:{value:0}},l=new e.ShaderMaterial({uniforms:c,depthTest:!1,depthWrite:!1,vertexShader:`varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,fragmentShader:`
      uniform sampler2D uPrev; uniform vec2 uTexel, uFrom, uTo, uForce; uniform float uRadius, uDecay, uStep, uAspect, uOn;
      varying vec2 vUv;
      void main() {
        vec2 f = texture2D(uPrev, vUv).xy;
        // 平流：顺着自己往回取一步，抹出来的痕迹会继续往前流
        vec2 at = vUv - f * 0.22 * uStep;
        vec3 c = texture2D(uPrev, at).xyz;
        vec3 n = texture2D(uPrev, at + vec2(uTexel.x, 0.0)).xyz + texture2D(uPrev, at - vec2(uTexel.x, 0.0)).xyz
               + texture2D(uPrev, at + vec2(0.0, uTexel.y)).xyz + texture2D(uPrev, at - vec2(0.0, uTexel.y)).xyz;
        c = mix(c, n * 0.25, 1.0 - pow(0.82, uStep)) * uDecay;
        // 鼠标这一帧走过的线段：离线段越近，加得越多
        if (uOn > 0.5) {
          vec2 p = vUv - uFrom, s = uTo - uFrom;
          p.x *= uAspect; s.x *= uAspect;
          float h = clamp(dot(p, s) / max(dot(s, s), 1e-6), 0.0, 1.0);
          float d = length(p - s * h);
          float brush = exp(-d * d / (uRadius * uRadius));
          c.xy += uForce * brush;
          c.z += length(uForce) * brush * 0.6;
        }
        gl_FragColor = vec4(clamp(c.xy, -0.08, 0.08), min(c.z, 0.12), 1.0);
      }`}),u=new e.PlaneGeometry(2,2);o.add(new e.Mesh(u,l));let d=0,f=null,p=null,m=new e.Color;function h(){let e=t.getRenderTarget(),n=t.getClearAlpha();t.getClearColor(m),t.setClearColor(0,0);for(let e of[i,a])t.setRenderTarget(e),t.clear();t.setRenderTarget(e),t.setClearColor(m,n)}return h(),{get texture(){return i.texture},get texel(){return c.uTexel.value},get active(){return d>.002||!!p},move(e,t){if(f){let n=e-f.x,r=t-f.y;Math.hypot(n,r)>5e-4&&(p={from:p?.from??f,to:{x:e,y:t},dx:(p?.dx??0)+n,dy:(p?.dy??0)+r})}f={x:e,y:t}},lift(){f=null,p=null},setAspect(e){c.uAspect.value=e},step(e=1/60){if(!p&&d<.002)return!1;let n=Math.min(.05,Math.max(0,e));if(c.uStep.value=n*60,c.uDecay.value=Math.exp(-4.6*n),p){c.uFrom.value.set(p.from.x,p.from.y),c.uTo.value.set(p.to.x,p.to.y);let e=.04*Math.max(1/4,c.uStep.value);c.uForce.value.set(Math.max(-e,Math.min(e,p.dx*2)),Math.max(-e,Math.min(e,p.dy*2))),c.uOn.value=1,d=1,p=null}else c.uOn.value=0;c.uPrev.value=i.texture;let r=t.getRenderTarget();return t.setRenderTarget(a),t.render(o,s),t.setRenderTarget(r),[i,a]=[a,i],d*=c.uDecay.value,d<.002&&h(),!0},reset(){d=0,p=null,f=null,h()},dispose(){i.dispose(),a.dispose(),l.dispose(),u.dispose()}}}var y={ease:.085,wheel:.0055,drag:1/340,fling:.3,velocityEase:.12,settle:.14};function ae(e,t,n,r=y.ease){let i=1-(1-r)**(n*60);return e+(t-e)*i}function b(e,t){return((e+t/2)%t+t)%t-t/2}function oe(e=0){return{current:e,target:e,velocity:0,dragging:!1}}function se(e,t){let n=e.current;e.current=ae(e.current,e.target,t);let r=t>0?(e.current-n)/t:0;return e.velocity+=(r-e.velocity)*Math.min(1,y.velocityEase*t*60),Math.abs(e.target-e.current)<1e-4&&Math.abs(e.velocity)<.001&&!e.dragging?(e.current=e.target,e.velocity=0,!1):!0}var ce=e=>{e.target=Math.round(e.target)};function le(e,t,n){e.target=Math.round(e.target+b(t-e.target,n))}var x=(e,t)=>(Math.round(e.current)%t+t)%t,ue=(e,t=!1)=>Math.sign(e)*Math.min(Math.abs(e)*(t?40:1),160)*y.wheel,S=8.4,de=6,fe=2.55,C=new Map,pe=e=>1-(1-e)**3,me=e=>e>=1?1:1-2**(-10*e),he=e=>e<.5?4*e*e*e:1-(-2*e+2)**3/2;async function ge(_,v,ae,{start:ge=0,intro:_e=!0,onCentre:ve,onOpen:ye,onCorner:be,onEmpty:xe}={}){let w=await r(()=>import(`./three.module-DFPdTWIZ.js`),__vite__mapDeps([0,1]),import.meta.url),T=v.map(e=>({album:e}));for(;T.length<de;)T.push({album:null});let E=T.length;_.classList.add(`aw`),_.innerHTML=`<canvas class="aw-gl" aria-hidden="true"></canvas>
    <div class="aw-stage" tabindex="0" role="listbox" aria-label="专辑。左右方向键切换，回车打开" aria-activedescendant=""></div>
    <div class="aw-loader" aria-hidden="true"><i><b></b></i><i><b></b></i><i><b></b></i></div>
    <section class="aw-caption" aria-label="正中的专辑">
      <p class="aw-cap-kicker" data-c="section"></p>
      <h2 class="aw-cap-title" data-c="title"></h2>
      <p class="aw-cap-line" data-c="line"></p>
      <p class="aw-cap-meta" data-c="meta"></p>
      <button type="button" class="aw-cap-open">打开专辑 <span aria-hidden="true">→</span></button>
    </section>
    <a class="aw-corner aw-tl" href="albums.html" data-corner="home">Luokixi / 开源专辑</a>
    <button class="aw-corner aw-tr" type="button" data-corner="about">关于</button>
    <p class="aw-corner aw-bl"><a href="albums.html" data-corner="featured" aria-current="page">专辑</a><span>/</span><a href="albums.html?view=full" data-corner="full">目录</a></p>
    <button class="aw-corner aw-br" type="button" data-corner="recommend">推荐项目</button>
    <ol class="sr-only aw-options">${T.map((t,n)=>`<li id="aw-opt-${n}" role="option">${t.album?`<a href="${i(t.album)}">${e(t.album.title)}，${e(o[t.album.module]?.name||``)}，${t.album.discs.length} 首</a>`:`空位：推荐一个开源项目`}</li>`).join(``)}</ol>
    <p class="sr-only" aria-live="polite"></p>`;let D=e=>_.querySelector(e),Se=D(`.aw-gl`),O=D(`.aw-stage`),Ce=D(`[aria-live]`),we=D(`.aw-loader`),k=new w.WebGLRenderer({canvas:Se,antialias:!0,powerPreference:`high-performance`});k.outputColorSpace=w.SRGBColorSpace,k.setClearColor(`#050506`);let Te=new w.Scene,A=new w.PerspectiveCamera(38,1,.1,120),Ee=h(),j=ie(w,k),De=new w.PlaneGeometry(1,1,96,32),M=new w.DataTexture(new Uint8Array([30,30,34,255]),1,1);M.needsUpdate=!0;let N={uR:{value:S},uVel:{value:0},uGrabS:{value:0},uGrab:{value:new w.Vector2},uRes:{value:new w.Vector2(1,1)},uFluid:{value:j.texture},uFluidTexel:{value:j.texel},uFluidAmt:{value:.15},uVertical:{value:0},uHole:{value:new w.Vector4(0,0,0,0)}},Oe=()=>({uAngle:{value:0},uOffset:{value:0},uOffsetY:{value:0},uLift:{value:0},uFlat:{value:0},uDepth:{value:0},uDims:{value:new w.Vector2(1,1)},uMap:{value:M},uReady:{value:0},uDim:{value:0},uOpacity:{value:0}}),P=T.map((e,t)=>{let n={...N,...Oe(),uWhite:{value:0},uGloss:{value:1},uCover:{value:M},uCoverOn:{value:0},uCoverAspect:{value:1},uCoverRect:{value:new w.Vector4(...f)}},r={...N,...Oe(),uSpin:{value:t*1.3}};for(let e of[`uAngle`,`uLift`,`uFlat`,`uDim`,`uOpacity`])r[e]=n[e];r.uDepth.value=.07;let i=new w.Mesh(De,new w.ShaderMaterial({vertexShader:g,fragmentShader:ee,uniforms:n,transparent:!0})),a=new w.Mesh(De,new w.ShaderMaterial({vertexShader:g,fragmentShader:te,uniforms:r,transparent:!0}));i.frustumCulled=a.frustumCulled=!1,i.renderOrder=2,a.renderOrder=1,a.visible=!!e.album,Te.add(a,i);let o=e.album?e.album.discs.map(e=>ae.discs.get(e)).filter(Boolean):[];return{...e,discs:o,card:i,disc:a,cu:n,du:r,hover:0,open:0,video:null}}),ke=new w.ShaderMaterial({vertexShader:ne,fragmentShader:re,transparent:!0,depthWrite:!1,uniforms:{uSpin:{value:0},uFade:{value:0}}}),F=new w.Mesh(new w.PlaneGeometry(70,70),ke);F.rotation.x=-Math.PI/2,F.position.y=-2.55/2-.62,Te.add(F);let I=oe(ge),L=0,Ae=0,R=!1,z=!0,B=1,V=1,H=!1,je=-1,U=!1,W=!1,G=fe*m,K=fe,Me=G+.6,Ne=4.4,q=null,J=-1,Y=0,Pe=0,Fe=!1,X=_e&&!t()?0:1,Ie=0,Z=null,Le=0,Re=!1,ze=null,Be=!0,Ve=new Set,He=Math.min(3,E),Ue=e=>we.style.setProperty(`--p`,String(Math.min(1,e/He)));(async()=>{let e=[...P.keys()].sort((e,t)=>Math.abs(b(e-ge,E))-Math.abs(b(t-ge,E))),t=0;for(let r of e){if(await n(),await new Promise(e=>setTimeout(e,16)),R)return;let e=P[r];try{if(e.album){let t=`${e.album.id}:${r}`;C.has(t)||C.set(t,Promise.all([p(e.album,e.discs,Ee,{index:r}),d(a(e.discs[0]||{title:e.album.title,upstreams:[]},e.album))]).catch(e=>{throw C.delete(t),e}));let[n,i]=await C.get(t);if(R)return;We(e.cu,n),We(e.du,i),Ge(e)}else We(e.cu,C.get(`empty`)??C.set(`empty`,u()).get(`empty`))}catch(e){e?.name!==`AbortError`&&console.warn(`[albums] 卡面没画出来`,e)}Ue(++t),t>=He&&!Fe&&qe(),Q()}Fe||qe()})();function We(e,t){let n=new w.CanvasTexture(t);n.colorSpace=w.SRGBColorSpace,n.anisotropy=k.capabilities.getMaxAnisotropy(),k.initTexture(n),e.uMap.value=n,e.uReady.value=1}function Ge(e){let n=l(e.album,{idx:ae,discs:e.discs});if(!n)return;let r=(t,n)=>{t.colorSpace=w.SRGBColorSpace,e.cu.uCover.value=t,e.cu.uCoverAspect.value=n,e.cu.uCoverOn.value=1,Q()},i=e=>new w.TextureLoader().load(e,e=>{R||r(e,e.image.width/e.image.height)});if(n.video&&!t()){let t=Object.assign(document.createElement(`video`),{src:n.video,muted:!0,loop:!0,playsInline:!0,preload:`auto`,crossOrigin:`anonymous`});n.poster&&i(n.poster),t.addEventListener(`loadeddata`,()=>{R||(r(new w.VideoTexture(t),t.videoWidth/t.videoHeight||1),e.video=t,Ke())},{once:!0})}else(n.image||n.poster)&&i(n.image||n.poster)}function Ke(){for(let e of P){if(!e.video)continue;let n=z&&!document.hidden&&!t();n&&e.video.paused?e.video.play().then(()=>{Ve.add(e),Q()}).catch(()=>{}):!n&&!e.video.paused&&(e.video.pause(),Ve.delete(e))}}function qe(){Fe=!0,_.classList.add(`is-ready`),Q()}function Je(e=0){A.position.set(0,H?0:.35,0+e),A.lookAt(0,H?0:-.05,-8.4)}function Ye(){if(B=_.clientWidth,V=_.clientHeight,!B||!V)return;H=B<760,k.setPixelRatio(Math.min(devicePixelRatio,2,Math.sqrt(34e5/(B*V)))),k.setSize(B,V,!1),A.aspect=B/V,A.fov=H?50:38;let e=Math.tan(A.fov*Math.PI/360);H?(K=Math.min(3.8,2*S*e*A.aspect*.84),G=K/m,Me=G+.46,Ne=8.4-K/(1.84*e*A.aspect)):(K=fe,G=fe*m,Me=G+.6,Ne=8.4-K/(1.8*e)),N.uVertical.value=+!!H,N.uRes.value.set(B,V),F.visible=!H,j.setAspect(B/V);let t=H?K:G,n=H?G:K;for(let e of P)e.cu.uDims.value.set(G,K),e.du.uDims.value.set(n*.93,n*.93),e.sw=t,e.sh=n;Je(),A.updateProjectionMatrix(),Q()}let Xe=(e,t,n)=>H?new w.Vector3(t,-e,n):new w.Vector3(e,t,n);function Ze(){let e=_.getBoundingClientRect(),t=[],n=[];for(let[r,i]of[[-G/2,-K/2],[G/2,K/2]]){let a=Xe(r,i,-(S-Ne)).project(A);t.push(e.left+(a.x*.5+.5)*e.width),n.push(e.top+(-a.y*.5+.5)*e.height)}return{left:Math.min(...t),top:Math.min(...n),width:Math.abs(t[1]-t[0]),height:Math.abs(n[1]-n[0])}}let Qe=e=>b(e-I.current,E)*Me;function $e(e){if(L=0,R)return;let n=Math.min(.05,(e-(Ae||e))/1e3);Ae=e;let r=t(),i=!W&&se(I,n)||!!q||U||W;r&&!W&&(I.current=I.target,I.velocity=0),Y+=(Math.max(-1,Math.min(1,(W?0:I.velocity)/4.5))-Y)*Math.min(1,n*8),Pe+=(+!!q?.moved-Pe)*Math.min(1,n*7),N.uVel.value=r?0:Y,N.uGrabS.value=r?0:Pe*(q?1:.6),q&&N.uGrab.value.set(q.s,q.y),Fe&&X<1&&(X=Math.min(1,X+n/1.15),i=!0),Fe&&Ie<1&&(Ie=Math.min(1,Ie+n/.25),i=!0),Je(H?30*(1-me(X)):44*(1-me(X))),r?j.active&&j.reset():j.step(n)&&(i=!0),N.uFluid.value=j.texture,(Math.abs(Y)>.002||Pe>.002||Ve.size)&&(i=!0),P.forEach((e,t)=>{let a=Qe(t),o=e.cu;o.uAngle.value=a/S;let s=+(t===J&&!q&&!U);e.hover+=(s-e.hover)*Math.min(1,n*(s?6:8)),Math.abs(s-e.hover)>.002&&(i=!0);let c=e.open;o.uFlat.value=pe(Math.min(1,c*1.4)),o.uLift.value=e.hover*.22+he(c)*Ne,o.uWhite.value=Math.max(0,(c-.7)/.3),o.uDim.value=Math.min(1,Math.abs(a)/(Me*1.5))*(1-c),o.uOpacity.value=Ie*(U&&!c&&Z?1-Z.fade:1),o.uGloss.value=1-c;let l=e.sw/2-e.sh*.47+e.sw*.12+e.hover*.42*e.sw-Math.min(1,c*2)*.3*e.sw;e.du.uOffset.value=H?0:l,e.du.uOffsetY.value=H?l:0,!r&&(e.hover>.01||Math.abs(Y)>.01)&&(e.du.uSpin.value+=n*(.3+e.hover*1.2+Math.abs(Y)*3))}),ke.uniforms.uSpin.value=I.current*Me/S,ke.uniforms.uFade.value=pe(X)*(1-(Z?.fade||0)),k.render(Te,A);let a=x(I,E),o=Math.abs(I.target-I.current)>.03||!!q;o!==Re&&(Re=o,_.classList.toggle(`is-moving`,Re)),a!==je&&et(a),i&&z?L=requestAnimationFrame($e):Ae=0}function Q(){!L&&!R&&z&&(L=requestAnimationFrame($e))}function et(e){je=e;let t=T[e].album;O.setAttribute(`aria-activedescendant`,`aw-opt-${e}`),Ce.textContent=t?`${t.title}，${o[t.module]?.name||``}，${t.discs.length} 首`:`空位：推荐一个开源项目`,tt(t),t&&ve?.(t)}function tt(e){let t=(e,t)=>{D(`[data-c="${e}"]`).textContent=t};t(`section`,e&&o[e.module]?.name||``),t(`line`,e?e.tagline||``:`推荐一个开源项目，它就会出现在这里`),t(`meta`,e?`${e.discs.length} 张光碟`:``),D(`.aw-cap-open`).hidden=!e;let n=[D(`[data-c="title"]`)],r=[e?e.title:`空位`];ze=Be?s(n,r,ze):(Re?c:s)(n,r,ze),Be=!1}let nt=new w.Raycaster,rt=new w.Vector2;function it(e){let t=_.getBoundingClientRect();rt.set((e.clientX-t.left)/t.width*2-1,-((e.clientY-t.top)/t.height)*2+1),nt.setFromCamera(rt,A);let n=nt.ray.origin,r=nt.ray.direction,[i,a,o,s,c,l]=H?[n.y,n.z,r.y,r.z,n.x,r.x]:[n.x,n.z,r.x,r.z,n.y,r.y],u=o*o+s*s,d=2*(i*o+a*s),f=i*i+a*a-S*S,p=(-d+Math.sqrt(d*d-4*u*f))/(2*u);if(!(p>0))return null;let m=i+p*o,h=a+p*s,g=c+p*l,v=Math.atan2(H?-m:m,-h)*S,ee=P.findIndex((e,t)=>Math.abs(v-Qe(t))<G/2&&Math.abs(g)<K/2);return ee<0&&(ee=P.findIndex((e,t)=>e.album&&Math.hypot(v-Qe(t)-e.du.uOffset.value,g-e.du.uOffsetY.value)<e.sh*.465)),{s:v,y:g,i:ee}}let at=new AbortController,$=(e,t,n,r={})=>e.addEventListener(t,n,{...r,signal:at.signal});$(O,`wheel`,e=>{if(e.preventDefault(),U)return;let t=Math.abs(e.deltaX)>Math.abs(e.deltaY)?e.deltaX:e.deltaY;I.target+=ue(t,e.deltaMode===1),clearTimeout(Le),Le=setTimeout(()=>{!q&&!U&&(ce(I),Q())},y.settle*1e3),Q()},{passive:!1});let ot=e=>{let t=_.getBoundingClientRect();return[(e.clientX-t.left)/t.width,1-(e.clientY-t.top)/t.height]};$(O,`pointerdown`,e=>{if(U||e.button>0)return;j.lift();let t=it(e);O.setPointerCapture(e.pointerId),q={id:e.pointerId,x:e.clientX,y0:e.clientY,from:I.target,moved:!1,t:performance.now(),v:0,s:t?.s??0,y:t?.y??0,last:H?e.clientY:e.clientX}}),$(O,`pointermove`,e=>{let n=it(e);if(q&&e.pointerId===q.id){let t=H?e.clientY-q.y0:e.clientX-q.x;if(!q.moved&&Math.hypot(e.clientX-q.x,e.clientY-q.y0)>6&&(q.moved=!0),q.moved){let r=performance.now(),i=H?V*.42:B*.28,a=H?e.clientY:e.clientX;I.target=q.from-t/i,q.v=(q.last-a)/i/Math.max(.008,(r-q.t)/1e3),q.t=r,q.last=a,n&&(q.s=n.s,q.y=n.y)}Q()}let r=U?-1:n?.i??-1;r!==J&&(J=r,O.style.cursor=r>=0?`pointer`:``),!U&&!q&&e.pointerType===`mouse`&&!t()&&j.move(...ot(e)),Q()});let st=e=>{if(!q||e.pointerId!==q.id)return;let t=q;if(q=null,!t.moved&&e.type===`pointerup`){let t=it(e);t&&t.i>=0&&dt(t.i);return}I.target+=Math.max(-6,Math.min(6,t.v))*y.fling,ce(I),Q()};$(O,`pointerup`,st),$(O,`pointercancel`,st),$(O,`pointerleave`,()=>{J=-1,j.lift(),Q()}),$(D(`.aw-cap-open`),`click`,()=>dt(x(I,E))),$(O,`keydown`,e=>{if(U)return;let t=H?[`ArrowDown`,`ArrowRight`]:[`ArrowRight`,`ArrowDown`],n=H?[`ArrowUp`,`ArrowLeft`]:[`ArrowLeft`,`ArrowUp`];t.includes(e.key)?(e.preventDefault(),le(I,x(I,E)+1,E),Q()):n.includes(e.key)?(e.preventDefault(),le(I,x(I,E)-1,E),Q()):(e.key===`Enter`||e.key===` `)&&(e.preventDefault(),dt(x(I,E),!0))}),$(_,`click`,e=>{let t=e.target.closest(`[data-corner]`);!t||e.ctrlKey||e.metaKey||e.shiftKey||(e.preventDefault(),be?.(t.dataset.corner))});let ct=new ResizeObserver(Ye);ct.observe(_);let lt=new IntersectionObserver(([e])=>{z=e.isIntersecting&&!document.hidden,Ke(),Q()});lt.observe(_),$(document,`visibilitychange`,()=>{z=!document.hidden,Ke(),Q()});function ut(e,t){return new Promise(n=>{let r=performance.now(),i=!1,a=()=>{i||(i=!0,e(1),Q(),n())},o=n=>{if(i||R)return a();let s=Math.min(1,(n-r)/t);e(s),Q(),s<1?requestAnimationFrame(o):a()};requestAnimationFrame(o),setTimeout(a,t+300)})}async function dt(e,n=!1){if(R||U||e<0)return;let r=P[(e%E+E)%E];if(!r.album){xe?.();return}U=!0,J=-1,j.reset();let i=I.current,a=i+b(e-i,E);W=!0,I.target=a,I.velocity=0,Z={card:r,fade:0},!n&&!t()?await ut(e=>{I.current=i+(a-i)*he(Math.min(1,e*1.25)),r.open=e,Z.fade=Math.min(1,e*1.4)},820):(r.open=1,Z.fade=1),!R&&(I.current=I.target=a,W=!1,_.classList.add(`is-open`),ye?.(r.album))}async function ft(e=x(I,E),n=!1){if(R)return;let r=I.current+b(e-I.current,E);I.current=I.target=r,I.velocity=0;let i=P[(e%E+E)%E];P.forEach(e=>{e.open=0}),i.open=1,Z={card:i,fade:1},_.classList.remove(`is-open`),!n&&!t()&&await ut(e=>{i.open=1-he(e),Z.fade=1-e},620),!R&&(i.open=0,Z=null,U=!1,Q(),O.focus({preventScroll:!0}))}return Ye(),et(x(I,E)),Q(),{THREE:w,renderer:k,scene:Te,camera:A,R:S,cardRect:Ze,get centred(){return T[x(I,E)].album||v[0]},get vertical(){return H},focus:()=>O.focus({preventScroll:!0}),go(e){le(I,e,E),Q()},open:dt,close:ft,setHole(e=0,t=0,n=0,r=0){N.uHole.value.set(e,V-t,n,r),Q()},wake:Q,setBusy(e){U=e,J=-1,Q()},destroy(){R=!0,at.abort(),ct.disconnect(),lt.disconnect(),cancelAnimationFrame(L),Ee.dispose(),j.dispose(),clearTimeout(Le),ze?.kill(),P.forEach(e=>{e.video?.pause();for(let t of[e.cu,e.du])t.uMap.value!==M&&t.uMap.value.dispose();e.cu.uCover.value!==M&&e.cu.uCover.value.dispose(),e.card.material.dispose(),e.disc.material.dispose()}),De.dispose(),F.geometry.dispose(),ke.dispose(),M.dispose(),k.dispose(),_.classList.remove(`aw`,`is-ready`,`is-open`)}}}export{ge as mountAlbumWall};