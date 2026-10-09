import { fuzzySearch, scoreSearchItem } from '../js/fuzzy-search.js';
import { attachSearchSuggestions } from '../js/search-suggestions.js';
// 校园探索：只画矿大的一张游戏地图。
// - 只有插画一种底图：楼、路、操场按 OpenStreetMap 的真实轮廓画，校外留白；Codex 的迪士尼风格重绘审过后自动替换。
// - 每个人的地图不一样：自己填的课表变成“今天的任务点”，到过的楼会点亮；这些只存在本机。
// - 按 Codex 的调研（docs/CAMPUS_MARKET_RESEARCH.md 任务 A）：“我有两小时，去哪学习”，用课表算空闲、按距离排学习地点，
//   空座和空教室数据没接通时明说，不编数字。
// - 所有人共享的：同学投稿、维护者核对过的地点（/api/hub/map/places），演出、奶龙这类限时事件会发光。
// 没连上服务、加载失败、确实还没有地点，三种情况分别如实说明；不放虚构地点，也不说“附近没有”。
import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { initShell, observeReveal, observeLive, reducedMotion } from '../js/shell.js';
import { canParticipate, hubApi, hubState, loginURL } from '../js/hub.js';
import { PLACE_TYPES, glyphSVG, fmtTime, timeLeft, toLocalInput, withOffset } from '../js/places.js';
import { campusServiceHTML, campusServiceButtons } from '../js/campus-services.js';
import { mapIcon } from '../js/map-icons.js';
import { BUILDING_USE, createCampusMap, pointInFeature, buildingModelSVG } from '../js/campus-map.js';
import { DAYS, courseSuggestions, importMe, loadMe, newId, quests, readyMe, saveMe, todayIndex, toggleVisited, visitedSet } from '../js/quests.js';
import { esc } from '../js/data.js';
import { normalizePlan, dateOf, occurrences } from '../js/campus-plan.js';
import { subscribePlan } from '../js/campus-store.js';
import { campusRoute, datedActivity, localActivity } from '../js/campus-route.js';
import { prepareCampusData } from '../js/campus-geometry.js';
import '../styles/community.css';
import '../styles/map.css';
import '../styles/atlas.css';
import '../styles/campus-workbench.css';
import '../styles/campus-essential.css';
import { depthSlides } from '../js/depth-slider.js';

initShell();

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const ORDER = Object.keys(PLACE_TYPES);
const CAMPUS_SHORT = { xueyuanlu: '学院路', shahe: '沙河' };
const safeURL = (u) => (typeof u === 'string' && /^https:\/\//.test(u) ? u : null);
const mobile = matchMedia('(max-width: 760px)');
const params = new URLSearchParams(location.search);
if (params.get('embedded') === '1') document.body.classList.add('is-map-embedded');
let routeDate = params.get('date') || dateOf();
try { occurrences({version:1,courses:[]}, routeDate, routeDate); } catch { routeDate = dateOf(); }
let routeEnabled = params.get('route') === 'today';
let currentRoute = null;
let directRoute={from:'',to:'',result:null};
const buildingNames={};
const plannerLink = extra => `planner.html?date=${encodeURIComponent(routeDate)}${extra || ''}`;
const REPORTS_KEY = 'luokixi.map.reports';

let planReadError;
const initialPlan = await readyMe().catch(error=>{planReadError=error;return null;});
let planCorrupt=Boolean(initialPlan?.corrupt);
let recoveryRaw=initialPlan?.corrupt?initialPlan.raw:null;
const me0 = initialPlan?.data || normalizePlan();
const st = {
  online: false,
  user: null,
  me: me0,
  campus: CAMPUS_SHORT[params.get('campus')] ? params.get('campus') : CAMPUS_SHORT[me0.profile.campus] ? me0.profile.campus : 'xueyuanlu',
  tab: ['places', 'buildings', 'route'].includes(params.get('tab')) ? params.get('tab') : 'buildings',
  art: {}, // Codex 交付并审过的重绘插画：public/art/campus-map/manifest.json
  type: PLACE_TYPES[params.get('type')] ? params.get('type') : 'all',
  q: params.get('q') ?? '',
  expired: false,
  places: [],
  typeNames: {},
  state: 'loading', // 同学标注：loading | offline | error | ready
  error: '',
  fetchedAt: 0,
  selected: params.get('place'), // 同学标注的地点 id
  building: params.get('building') || params.get('b'), // OSM 楼，例如 way/123
  campuses: null,
  maps: {}, // 校区插画数据缓存
  mapError: '',
  pending: [],
  openQuest: null,
  study: { hours: 2, socket: false }, // “我有两小时，去哪学习？”的条件
  // 这次会话里自己提交过的现场反馈。服务端不返回“我选了什么”，只用来让按钮显示刚才的选择。
  reports: (() => {
    try { return JSON.parse(sessionStorage.getItem(REPORTS_KEY)) ?? {}; } catch { return {}; }
  })(),
};

const typeName = (k) => st.typeNames[k] ?? PLACE_TYPES[k]?.name ?? k;
const campusName = (k) => st.campuses?.campuses?.[k]?.name ?? CAMPUS_SHORT[k] ?? k;
const find = (id) => st.places.find((f) => f.id === id);
const latlngOf = (f) => [f.geometry.coordinates[1], f.geometry.coordinates[0]];
const centerOf = (b) => [b.properties.center[1], b.properties.center[0]];

// ---------- 提示 ----------

let toastTimer;
function toast(msg, action) {
  const el = $('#cx-toast');
  el.innerHTML = `${esc(msg)}${action ? ` <a href="${esc(action.href)}" target="_top">${esc(action.label)}</a>` : ''}`;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('is-on'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('is-on');
    setTimeout(() => (el.hidden = true), 300);
  }, 3600);
}

// 收藏、关注、反馈、投稿都要：服务在线 + 已登录 + 邮箱已验证
function blocked(action) {
  if (!st.online) return toast(`社区服务没有连接，暂时不能${action}。`), true;
  if (!st.user) return toast(`登录之后才能${action}。`, { href: loginURL(), label: '去登录' }), true;
  if (!canParticipate(st.user)) return toast(`验证邮箱之后才能${action}。`, { href: 'me.html#account', label: '去验证' }), true;
  return false;
}

// ---------- 同学标注的数据 ----------

const norm = (s) => String(s ?? '').toLowerCase();
const terms = () => norm(st.q).split(/\s+/).filter(Boolean);
function matches(f) {
  const d = f.properties.data;
  return scoreSearchItem(d, st.q, { getText: d => [d.summary,d.addressHint,d.accessNotes,typeName(f.properties.placeType)].join(' ') }) >= 0;
}
const inCampus = () => st.places.filter((f) => f.properties.campus === st.campus);
const visible = () =>
  inCampus()
    .filter((f) => st.type === 'all' || f.properties.placeType === st.type)
    .sort((a, b) => Number(a.properties.expired) - Number(b.properties.expired));
const isEvent = (f) => !f.properties.expired && f.properties.data.duration === 'temporary';

const validFeature = (f) =>
  f?.geometry?.type === 'Point' && f.geometry.coordinates?.every(Number.isFinite) && f.properties?.data?.title && PLACE_TYPES[f.properties.placeType];

async function loadPlaces({ quiet = false } = {}) {
  if (!st.online) {
    st.state = 'offline';
    return renderAll();
  }
  if (!quiet) {
    st.state = 'loading';
    renderBody();
  }
  try {
    const all = [];
    let offset = 0;
    do {
      const r = await hubApi.places({ includeExpired: st.expired ? 1 : undefined, offset });
      all.push(...(r.features ?? []).filter(validFeature));
      st.typeNames = r.placeTypes ?? st.typeNames;
      offset = r.nextOffset;
    } while (offset != null && all.length < 2000);
    st.places = all;
    st.state = 'ready';
    st.fetchedAt = Date.now();
  } catch (e) {
    if (quiet && st.state === 'ready') toast(`刷新没有成功：${e.message}`);
    else {
      st.state = 'error';
      st.error = e.message ?? '未知错误';
    }
  }
  if (st.selected && st.state === 'ready' && !find(st.selected)) st.selected = null;
  renderAll();
}

// ---------- 地图 ----------

let map;
let cm;
const pinLayer = L.layerGroup();
const questLayer = L.layerGroup();
const previewLayer = L.layerGroup();
const markers = new Map();
const panel = $('#cx-panel');
const explore = $('#explore');
const inspector = $('#cx-inspector'), inspectorBody = $('#cx-inspector-body');
let inspectorKey = '', inspectorEpoch = 0, inspectorMotion = null, activation = null, inspectorOpener = null;
const recentCards = [];
function recordActivation(target, keyboard) {
  activation = { keyboard, target, rect: target.getBoundingClientRect() };
  explore.dataset.motion = keyboard ? 'instant' : 'smooth';
}
document.addEventListener('click', event => {
  if (!event.target.closest('#explore')) return;
  const target = event.target.closest('button,a,[role="button"],.cm-b');
  if (target) recordActivation(target, event.detail === 0);
}, true);
// Native marker keys do not dispatch a DOM click; record them before Leaflet's handler.
document.addEventListener('keydown', event => {
  if (event.target.closest('#explore')) recordActivation(event.target, true);
}, true);
for (const type of ['pointerdown','wheel']) explore.addEventListener(type,()=>{explore.dataset.motion='smooth';},{capture:true,passive:true});
function animateCard(element, entering, prior = false) {
  const style = getComputedStyle(element);
  const from = prior ? { opacity: style.opacity, transform: style.transform } : { opacity: 0, transform: 'translateY(12px) scale(.97)' };
  inspectorMotion?.cancel();
  if (reducedMotion() || activation?.keyboard || !activation) return null;
  const easing = getComputedStyle(document.documentElement).getPropertyValue('--ease-ios').trim() || 'ease-out';
  const box=element.getBoundingClientRect(), point=activation.rect;
  element.style.transformOrigin=(point?Math.max(0,Math.min(box.width,point.x+point.width/2-box.x)):box.width/2)+'px '+(point?Math.max(0,Math.min(box.height,point.y+point.height/2-box.y)):box.height)+'px';
  return element.animate([entering ? from : {opacity:style.opacity,transform:style.transform}, entering ? {opacity:1,transform:'none'} : {opacity:0,transform:'translateY(12px) scale(.97)'}], {duration:entering?250:180,easing});
}
function closeInspector() {
  inspectorKey=''; const token=++inspectorEpoch;
  panel.classList.remove('has-inspector');panel.inert=false;
  if(inspector.hidden)return;
  inspector.inert=true;
  inspectorMotion=animateCard($('.cx-inspector-surface',inspector),false,true);
  if(inspectorMotion)inspectorMotion.finished.catch(()=>{}).then(()=>{if(token===inspectorEpoch)inspector.hidden=true;});
  else inspector.hidden=true;
}
function showInspector(html, kind) {
  const key=st.campus+':'+kind+':'+(kind==='building'?st.building:st.selected);
  const changed=key!==inspectorKey, prior=!inspector.hidden;
  inspectorEpoch++;inspector.hidden=false;inspector.inert=false;
  panel.classList.add('has-inspector');panel.inert=mobile.matches;
  if(inspectorBody.innerHTML!==html)inspectorBody.innerHTML=html;
  if(changed){
    if(activation?.target && !inspector.contains(activation.target))inspectorOpener=activation.target;
    const name=kind==='building'?cm.building(st.building)?.properties.name:find(st.selected)?.properties.data.title;
    const item={key,kind,campus:st.campus,id:kind==='building'?st.building:st.selected,name:name||'未命名建筑'};
    const i=recentCards.findIndex(x=>x.key===key);if(i>=0)recentCards.splice(i,1);recentCards.push(item);while(recentCards.length>4)recentCards.shift();
    inspectorBody.scrollTop=0;
    inspector.dataset.depth=String(Math.min(recentCards.length,3));
    const recent=recentCards.filter(x=>x.key!==key).slice(-2).reverse();
    $('#cx-recent').innerHTML=recent.map(x=>`<button type="button" data-recent-key="${esc(x.key)}">${esc(x.name)}</button>`).join('');$('#cx-recent').hidden=!recent.length;
    inspectorMotion=animateCard($('.cx-inspector-surface',inspector),true,prior);
  }
  inspectorKey=key;
}
function restoreCanvasFocus(){
  const opener=inspectorOpener,box=opener?.isConnected?opener.getBoundingClientRect():null;
  const visible=box&&box.width&&box.height&&!(mobile.matches&&panel.contains(opener)&&!panel.classList.contains('is-open'));
  (activation?.keyboard&&visible?opener:$('#cx-map')).focus({preventScroll:true});
}
$('#cx-inspector-close').addEventListener('click',()=>{back();setSheet(false);restoreCanvasFocus();});
$('#cx-recent').addEventListener('click',async event=>{const key=event.target.closest('[data-recent-key]')?.dataset.recentKey,item=recentCards.find(x=>x.key===key);if(!item)return;await setCampus(item.campus,{fit:false});if(item.kind==='building')selectBuilding(item.id);else select(item.id);});
$('#cx-reset').addEventListener('click',()=>{back();map.closePopup();setSheet(false);fitCampus(!reducedMotion()&&!activation?.keyboard);});


function initMap() {
  const c = st.campuses?.campuses?.[st.campus];
  map = L.map('cx-map', {
    zoomControl: false,
    scrollWheelZoom: true,
    minZoom: 14,
    maxZoom: 20,
    zoomSnap: 0.1,
    zoomDelta: 0.5,
    wheelPxPerZoomLevel: 120,
    wheelDebounceTime: 30,
    zoomAnimation: !reducedMotion(),
    markerZoomAnimation: !reducedMotion(),
    keyboard: false,
    // 校区范围文件没有加载出来时，先看北京北部（两个校区都在这一片）
    center: c?.center ?? [40.07, 116.3],
    zoom: c ? 16.5 : 12,
  });
  map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
  map.attributionControl.addAttribution('楼、路、校门 © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap 贡献者</a>（ODbL）');
  L.control.zoom({ position: 'bottomright', zoomInTitle: '放大', zoomOutTitle: '缩小' }).addTo(map);
  map.createPane('cx-quest').style.zIndex = '595';
  cm = createCampusMap(map, {
    onBuilding: (f) => (bpick ? bpick(f) : selectBuilding(f.properties.osm)),
  });
  pinLayer.addTo(map);
  questLayer.addTo(map);
  previewLayer.addTo(map);

  // 页面能上下滚动，滚轮默认不缩放地图；点一下地图以后才接管滚轮
  const el = $('#cx-map');
  el.tabIndex=0;
  el.addEventListener('keydown',event=>{
    if(event.target!==el)return;
    const step={'ArrowLeft':[-80,0],'ArrowRight':[80,0],'ArrowUp':[0,-80],'ArrowDown':[0,80]}[event.key];
    if(step){event.preventDefault();map.stop();map.panBy(step,{animate:false});}
    else if(['+','=','-'].includes(event.key)){event.preventDefault();map.stop();map.setZoom(map.getZoom()+(event.key==='-'?-.5:.5),{animate:false});}
  });
  map.on('click', () => map.scrollWheelZoom.enable());
  el.addEventListener('focus', () => map.scrollWheelZoom.enable());

  let hintTimer;
  el.addEventListener('wheel', () => {
    if (map.scrollWheelZoom.enabled()) return;
    $('#cx-wheel-hint').classList.add('is-on');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => $('#cx-wheel-hint').classList.remove('is-on'), 1200);
  }, { passive: true });
}

function mapNote(text, kind = '') {
  const el = $('#cx-map-note');
  if (!text && el.dataset.kind && el.dataset.kind !== kind) return;
  el.textContent = text;
  el.dataset.kind = text ? kind : '';
  el.hidden = !text;
}

async function loadCampusMap(campus) {
  if (!st.maps[campus]) {
    try {
      const r = await fetch(`data/campus-map/${campus}.json`, { cache: 'no-cache' });
      if (!r.ok) throw new Error(`${r.status}`);
      st.maps[campus] = prepareCampusData(await r.json());
      st.mapError = '';
    } catch (e) {
      st.mapError = `${campusName(campus)}的楼宇数据没有加载出来（${e.message}）。`;
      st.maps[campus] = null;
    }
  }
  if (campus !== st.campus) return;
  cm.load(st.maps[campus]);
  void loadBuildingNames(campus);
  cm.setArt(st.art[campus] ?? null);
  if (st.building && !cm.building(st.building)) st.building = null;
  if (st.building) cm.select(st.building);
  renderAll();
}

// 面板盖住的部分不算可见区域
function covered() {
  const m = $('#cx-map').getBoundingClientRect();
  if (mobile.matches) {
    const h = panel.classList.contains('is-open') ? panel.offsetHeight : peek();
    return { left: 0, right: 0, bottom: Math.min(!inspector.hidden&&!inspector.inert?inspector.offsetHeight:h, m.height * 0.8) };
  }
  if (explore.classList.contains('is-picking')) return { left: 0, bottom: 0 };
  return { left: !inspector.hidden&&innerWidth<1100?0:Math.max(0, panel.getBoundingClientRect().right - m.left), right: !inspector.hidden&&!inspector.inert?inspector.offsetWidth+24:0, bottom: 0 };
}

function viewPad() {
  const c = covered();
  return { paddingTopLeft: [c.left + 24, 24], paddingBottomRight: [(c.right || 0) + 24, c.bottom + 24] };
}

function fitCampus(animate = !reducedMotion()) {
  const data = st.maps[st.campus];
  const b = data ? L.geoJSON(data.boundary).getBounds() : st.campuses?.campuses?.[st.campus]?.bounds;
  if (!map || !b) return;
  map.stop();
  map.fitBounds(b, { ...viewPad(), maxZoom: 17.5, animate });
}

function focusOn(latlng, zoom = Math.max(map.getZoom(), 17.5)) {
  const pad = viewPad();
  // 把目标点放到“没被面板盖住的那块区域”的中央
  const dx = (pad.paddingTopLeft[0] - pad.paddingBottomRight[0]) / 2;
  const dy = (pad.paddingTopLeft[1] - pad.paddingBottomRight[1]) / 2;
  const target = map.unproject(map.project(latlng, zoom).subtract([dx, dy]), zoom);
  map.stop();
  if (reducedMotion() || activation?.keyboard) map.setView(target, zoom, { animate: false });
  else map.flyTo(target, zoom, { duration: 0.28 });
}

// 三种标记一眼分开：限时事件是星形爆闪 + 倒计时，活动是圆角方块，其他地点是圆形徽章
const pinKind = (f) => (isEvent(f) ? 'burst' : f.properties.placeType === 'event' ? 'event' : 'place');

function pinIcon(f) {
  const p = f.properties;
  const kind = pinKind(f);
  const cls = ['cx-pin', `is-${kind}`, f.id === st.selected ? 'is-on' : '', p.expired ? 'is-expired' : '', isEvent(f) ? 'is-temp' : ''].filter(Boolean).join(' ');
  const left = isEvent(f) ? timeLeft(p.data.expiresAt).replace('还剩 ', '') : '';
  return L.divIcon({
    className: 'cx-pin-wrap',
    html: `<span class="${cls}" style="--h:${PLACE_TYPES[p.placeType].hue}"><i>${glyphSVG(p.placeType)}</i>${left ? `<em class="cx-pin-left">${esc(left)}</em>` : ''}</span>`,
    iconSize: [36, 44],
    iconAnchor: [18, 42],
  });
}

function drawPins() {
  if (!map) return;
  pinLayer.clearLayers();
  markers.clear();
  for (const f of visible()) {
    const m = L.marker(latlngOf(f), {
      icon: pinIcon(f),
      title: f.properties.data.title,
      alt: f.properties.data.title,
      riseOnHover: true,
      zIndexOffset: f.id === st.selected ? 1000 : isEvent(f) ? 500 : 0,
    });
    m.on('click', () => select(f.id, { zoom: false }));
    m.addTo(pinLayer);
    markers.set(f.id, m);
  }
}

function refreshPin(id) {
  const f = id && find(id);
  const m = id && markers.get(id);
  if (!f || !m) return;
  m.setIcon(pinIcon(f));
  m.setZIndexOffset(id === st.selected ? 1000 : isEvent(f) ? 500 : 0);
}

// 今天的课：在楼上标出金色序号，按上课顺序连一条虚线（只是顺序，不是步行路线）
function routeOccurrences() { return occurrences(st.me, routeDate, routeDate); }
function drawToday() {
  questLayer.clearLayers();
  if (!cm?.data) return;
  if(directRoute.result){for(const leg of directRoute.result.legs)L.polyline(leg.coordinates.map(([lng,lat])=>[lat,lng]),{className:'cx-route',color:'#0894ff',dashArray:leg.mode==='walkway'?null:'6 8',interactive:false}).addTo(questLayer);return;}
  const prefs = st.me.routePrefs?.[st.campus] || {start:'',via:[]};
  const stops = [], add = (id,title,time='') => {
    const b=cm.building(id);if(!b)return;
    const stop={osm:id,title,name:b.properties.name||id,center:b.properties.center,time};stops.push(stop);
    L.marker(centerOf(b),{pane:'cx-quest',keyboard:false,icon:L.divIcon({className:'cx-pin-wrap',html:`<span class="cx-cls"><b>${stops.length}</b><em>${esc(time)} ${esc(title.slice(0,8))}</em></span>`,iconSize:[28,28],iconAnchor:[14,14]})}).on('click',()=>selectBuilding(id)).addTo(questLayer);
  };
  if(routeEnabled && prefs.start)add(prefs.start,'常用起点');
  if(routeEnabled)for(const id of prefs.via || [])add(id,cm.building(id)?.properties.name || '途经地点');
  for(const item of routeOccurrences())if(item.building?.campus===st.campus)add(item.building.osm,item.title,item.start);
  currentRoute=campusRoute(stops,cm.data);
  if(routeEnabled)for(const leg of currentRoute.legs)L.polyline(leg.coordinates.map(([lng,lat])=>[lat,lng]),{className:'cx-route',color:leg.mode==='walkway'?'#0894ff':'#b58b35',dashArray:leg.mode==='walkway'?null:'6 8',interactive:false}).addTo(questLayer);
}
function dayRouteHTML() {
  const prefs=st.me.routePrefs?.[st.campus] || {start:'',via:[]};
  const options=cm?.buildings() || [];
  const option=(selected)=>options.map(b=>`<option value="${esc(b.properties.osm)}"${selected.includes(b.properties.osm)?' selected':''}>${esc(b.properties.name || `未命名建筑 ${b.properties.osm}`)}${(st.me.favorites || []).some(f=>f.campus===st.campus&&f.osm===b.properties.osm)?' · 常用':''}</option>`).join('');
  const items=routeOccurrences(),missing=items.filter(x=>!x.building?.osm || x.building.campus===st.campus&&!cm?.building(x.building.osm));
  return `<section class="cx-q cx-route-panel"><div class="cx-q-head"><h3>${esc(routeDate)} 路线</h3><a href="${plannerLink('&view=day')}" target="_top">完整计划 →</a></div>
    <form data-form="route" class="cx-route-form"><label>日期<input type="date" name="date" value="${esc(routeDate)}" required></label><label>常用起点<select name="start"><option value="">从第一处已填写地点开始</option>${option([prefs.start])}</select></label><label>途经地点（可多选）<select name="via" multiple size="3">${option(prefs.via || [])}</select></label><button class="btn btn-primary btn-sm" type="submit">显示路线估算</button></form>
    ${!items.length?'<p class="cx-quiet">这一天没有已排个人课程或活动。先在完整计划填写安排，再在地图选择真实建筑。</p>':''}
    ${st.me.courses.length&&!st.me.term.starts?'<p class="cx-hint">周课程尚未填写学期开学日期，未猜测周次；请在完整计划补充学期。</p>':''}
    ${currentRoute?.stops.length?`<ol class="cx-route-stops">${currentRoute.stops.map(stop=>`<li><button class="btn-link" data-osm="${esc(stop.osm)}">${esc(stop.time)} ${esc(stop.title)}${stop.name!==stop.title?` · ${esc(stop.name)}`:''}</button></li>`).join('')}</ol>`:''}
    ${routeEnabled&&currentRoute?.legs.length?`<p class="cx-route-summary">约 ${Math.round(currentRoute.meters)} 米 · 约 ${currentRoute.minutes} 分钟（按 75 米/分钟估算）</p><p class="cx-hint">${currentRoute.mode==='mixed'?'含直线估算；步行路网尚未完整覆盖。':'根据已记录的 OSM 步行路网估算最短路线。'} 楼中心到路网为直线接入；未核对入口、开放时间、楼层或无障碍条件。</p>`:'<p class="cx-hint">请自行选择起点和途经地点；本站不会猜测你的宿舍或食堂。至少两个已知地点才能连线。</p>'}
    ${missing.length?`<p class="cx-hint">尚未定位：${missing.map(x=>esc(x.title)).join('、')}。请在计划里填写本校区的真实建筑。</p>`:''}
    ${items.some(x=>x.building?.campus&&x.building.campus!==st.campus)?'<p class="cx-hint">另有其他校区安排，本图只显示当前校区；校区间交通请自行核对。</p>':''}</section>`;
}
function classCountdown() {
  const now=Date.now(),list=routeOccurrences().filter(x=>x.source==='course');
  const current=list.find(x=>Date.parse(`${x.date}T${x.start}:00+08:00`)<=now&&Date.parse(`${x.date}T${x.end}:00+08:00`)>now);
  const next=list.find(x=>Date.parse(`${x.date}T${x.start}:00+08:00`)>now);
  return current?`正在上《${current.title}》，${current.end} 结束。`:next?`下一节《${next.title}》还有 ${Math.max(0,Math.ceil((Date.parse(`${next.date}T${next.start}:00+08:00`)-now)/60000))} 分钟。`:'这一天没有尚未开始的课程。';
}

function renderMarks() {
  if (!cm?.data) return;
  const visited = visitedSet(st.me, st.campus);
  const course = new Set(st.me.courses.filter((c) => c.building?.campus === st.campus).map((c) => c.building.osm));
  const quest = st.openQuest && currentQuests().find((q) => q.id === st.openQuest);
  const target = new Set(quest ? quest.steps.filter((s) => !s.done).flatMap((s) => s.targets) : []);
  cm.mark({ 'is-visited': visited, 'is-course': course, 'is-target': target });
  drawToday();
  renderLegend();
}

function renderLegend() {
  const el = $('#cx-legend');
  const data = st.maps[st.campus];
  const bits = [];
  bits.push(st.art[st.campus] ? '插画按卫星截图和 OpenStreetMap 轮廓重绘，是概念插画，不是实拍' : '楼与道路依据 OpenStreetMap 真实轮廓；点击图标查看用途与详情');
  if (data && data.counts.building < 20) bits.push(`${campusName(st.campus)}在 OpenStreetMap 上只画了 ${data.counts.building} 栋楼，地图会随着补充变完整`);
  if (questLayer.getLayers().length > 1) bits.push(routeEnabled ? '今日个人路线估算；蓝色为已记录步行路网，虚线为直线估算，非实测导航' : '数字来自本人这一天的课程和活动；点选可查看位置');
  el.innerHTML = bits.map(esc).join(' · ');
  el.hidden = !bits.length;
}

// ---------- 手机上的底部面板 ----------

const peek = () => $('.cx-panel-head', panel).offsetHeight + 26;

function setSheet(open) {
  if (!mobile.matches) return;
  if (!inspector.hidden && !inspector.inert) open = false;
  panel.classList.toggle('is-open', open);
  $('#cx-handle').setAttribute('aria-expanded', String(open));
  $('#cx-handle .sr-only').textContent = open ? '收起面板' : '展开面板';
}

// 抽屉露出的高度：面板收起的位置、地图缩放按钮和署名都按它避让
function syncPeek() {
  explore.style.setProperty('--peek', `${peek()}px`);
}

$('#cx-handle').addEventListener('click', () => setSheet(!panel.classList.contains('is-open')));
$('#cx-q').addEventListener('focus', () => setSheet(true));
mobile.addEventListener('change', () => {
  panel.classList.remove('is-open');
  panel.inert = mobile.matches && !inspector.hidden && !inspector.inert;
  syncPeek();
});
addEventListener('resize', syncPeek, { passive: true });

// ---------- 渲染：任务 ----------

const currentQuests = () => quests(st.me, st.campus, CAMPUS_SHORT[st.campus], cm?.buildings() ?? []);

function playerHTML() {
  const p = st.me.profile;
  const all = currentQuests();
  const collect = all.find((q) => q.id === 'collect');
  const ratio = collect?.total ? collect.done / collect.total : 0;
  const name = st.user?.name ?? '同学';
  const sub = [p.faculty, p.major, p.year && `${p.year} 级`].filter(Boolean).join(' · ');
  return `<button class="cx-player" type="button" data-act="me">
    <span class="cx-ring" style="--p:${ratio.toFixed(3)}" aria-hidden="true"><span>${esc([...name][0] ?? '我')}</span></span>
    <span class="cx-player-main"><b>${esc(name)}</b><span>${sub ? esc(sub) : '填上学院和课表，地图就变成你的'}</span></span>
    ${collect ? `<span class="cx-player-n"><b class="num">${collect.done}</b><span>/ ${collect.total} 栋</span></span>` : ''}
  </button>`;
}

function todayHTML() {
  const day=todayIndex(new Date(`${routeDate}T12:00:00+08:00`)),now=Date.now();
  let nextGiven=false;
  const list=routeOccurrences().filter(x=>x.source==='course').map(x=>{
    const start=Date.parse(`${x.date}T${x.start}:00+08:00`),end=Date.parse(`${x.date}T${x.end}:00+08:00`);
    const status=end<=now?'done':start<=now?'now':!nextGiven?'next':'later';
    if(status==='now'||status==='next')nextGiven=true;
    return {course:x.course,slot:x.slot,status};
  });
  let body;
  if (!st.me.courses.length)
    body = `<div class="cx-empty cx-empty-sm"><p>还没有课表。把每周的课和上课的楼填进来，这里会出现今天的任务点。</p>
      <button class="btn btn-primary btn-sm" type="button" data-act="me">添加我的课</button></div>`;
  else if (!list.length) body = '<p class="cx-quiet">今天没有课。去地图上没点亮的地方转转？</p>';
  else
    body = `<ol class="cx-today" role="list">${list
      .map((x) => {
        const label = { done: '上完了', now: '正在上', next: '下一节' }[x.status];
        const other = x.course.building && x.course.building.campus !== st.campus;
        return `<li><button class="cx-class is-${x.status}" type="button" data-course-building="${esc(x.course.building?.osm ?? '')}" data-campus="${esc(x.course.building?.campus ?? '')}"${x.course.building ? '' : ' disabled'}>
          <time class="num">${esc(x.slot.start)}</time>
          <span class="cx-class-main"><b>${esc(x.course.name)}</b><span>${x.course.building ? esc(x.course.building.name || '未命名的楼') : '还没选上课地点'}${x.course.room ? ` · ${esc(x.course.room)}` : ''}</span></span>
          ${label ? `<span class="tag ${x.status === 'next' ? 'tag-accent' : x.status === 'now' ? 'tag-ok' : ''}">${label}</span>` : ''}
          ${other ? `<span class="tag">在${CAMPUS_SHORT[x.course.building.campus]}</span>` : ''}
        </button></li>`;
      })
      .join('')}</ol>`;
  return `${routeHTML()}<p class="cx-count" data-class-countdown>${esc(classCountdown())}</p><section class="cx-q"><div class="cx-q-head"><h3>${esc(routeDate)} · ${DAYS[day - 1]}</h3>${st.me.courses.length ? '<button class="btn-link" type="button" data-act="me">课表</button>' : ''}</div>${body}</section>`;
}

function eventsHTML() {
  let body;
  if (st.state === 'offline') body = '<p class="cx-quiet">限时事件来自同学投稿，需要连接社区服务才能看到。</p>';
  else if (st.state === 'loading') body = '<p class="cx-quiet">正在加载…</p>';
  else if (st.state === 'error') body = `<p class="cx-quiet">没有加载出来：${esc(st.error)}</p>`;
  else {
    const list = inCampus().filter(isEvent).sort((a, b) => Date.parse(a.properties.data.expiresAt) - Date.parse(b.properties.data.expiresAt));
    body = list.length
      ? `<ul class="cx-events" role="list">${list
          .map((f) => `<li><button class="cx-event" type="button" data-id="${esc(f.id)}" style="--h:${PLACE_TYPES[f.properties.placeType].hue}">
            <span class="cx-event-glyph">${glyphSVG(f.properties.placeType)}</span>
            <span class="cx-class-main"><b>${esc(f.properties.data.title)}</b><span>${esc(timeLeft(f.properties.data.expiresAt))}${f.properties.observations?.gone ? ` · ${f.properties.observations.gone} 人说已经不在了` : ''}</span></span>
          </button></li>`)
          .join('')}</ul>`
      : '<p class="cx-quiet">现在没有限时事件。看到演出、展览或者奶龙，可以标出来，核对后所有人都看得到。</p>';
  }
  return `<section class="cx-q"><div class="cx-q-head"><h3>限时事件</h3><button class="btn-link" type="button" data-add-place>标一个</button></div>${body}</section>`;
}

// 两点间的直线距离（米）。只用来排序和提示，不是步行距离
function meters([lat1, lng1], [lat2, lng2]) {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lng2 - lng1) * r) / 2) ** 2;
  return 6371e3 * 2 * Math.asin(Math.sqrt(a));
}

const fmtMinutes = (m) => (m >= 60 ? `${Math.floor(m / 60)} 小时${m % 60 ? ` ${m % 60} 分钟` : ''}` : `${m} 分钟`);

// 任务 A：我有两小时，去哪学习？
// 空闲时间来自自己的课表；地点来自同学标注的学习空间和地图上的图书馆。空座、空教室没有接通学校数据，直接说明。
function studyHTML() {
  const now = new Date();
  const timestamp=now.getTime();
  const list=occurrences(st.me,dateOf(now),dateOf(now)).filter(x=>x.source==='course').map(x=>({course:x.course,slot:x.slot,status:timestamp>=new Date(`${x.date}T${x.start}:00+08:00`).getTime()&&timestamp<new Date(`${x.date}T${x.end}:00+08:00`).getTime()?'now':timestamp<new Date(`${x.date}T${x.start}:00+08:00`).getTime()?'next':'done'}));
  const current = list.find((x) => x.status === 'now');
  const next = list.find((x) => x.status === 'next');
  const mins = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
  const civil=new Date(now.getTime()+8*3600000);
  const nowMin = civil.getUTCHours() * 60 + civil.getUTCMinutes();
  const want = st.study.hours * 60;
  let free = Infinity;
  let line;
  let from = null;
  let fromLabel = '';
  if (!st.me.courses.length) line = '还没有课表，按现在就能去算。填了课表，这里会算出你到下一节课之前有多久。';
  else if (!st.me.term.starts) line='学期开始日还没填写，暂时不能确认今天的课程。请在完整计划设置后再查看空闲时间。';
  else if (current) {
    line = `现在在上《${current.course.name}》，${current.slot.end} 下课。下面是下课以后能去的地方。`;
    from = current.course.building;
    fromLabel = current.course.building?.name;
    if (next) free = mins(next.slot.start) - mins(current.slot.end);
  } else if (next) {
    free = mins(next.slot.start) - nowMin;
    line = `下一节 ${next.slot.start}《${next.course.name}》，离上课还有 ${fmtMinutes(free)}。`;
    from = next.course.building;
    fromLabel = next.course.building?.name;
  } else line = list.length?'今天的课都上完了。':'今天没有已排课程。';
  const short = free < want;
  const origin = from?.campus === st.campus && from.center ? [from.center[1], from.center[0]] : null;
  const center = cm?.data ? L.geoJSON(cm.data.boundary).getBounds().getCenter() : null;
  const ref = origin ?? (center ? [center.lat, center.lng] : null);

  const socketText = (f) => /插座|充电/.test([f.properties.data.summary, f.properties.data.accessNotes, ...(f.properties.data.tags ?? [])].join(' '));
  const spots = [
    ...inCampus()
      .filter((f) => f.properties.placeType === 'study' && !f.properties.expired)
      .map((f) => ({ kind: 'place', id: f.id, name: f.properties.data.title, ll: latlngOf(f), socket: socketText(f), note: f.properties.data.addressHint })),
    ...(cm?.buildings() ?? [])
      .filter((b) => b.properties.use === 'library')
      .map((b) => ({ kind: 'building', osm: b.properties.osm, name: b.properties.name || '图书馆', ll: centerOf(b), socket: null, note: '空座和开放时间以图书馆官网为准' })),
  ]
    .filter((s) => !st.study.socket || s.socket !== false)
    .map((s) => ({ ...s, d: ref ? meters(ref, s.ll) : null }))
    .sort((a, b) => (a.d ?? 0) - (b.d ?? 0))
    .slice(0, 5);

  const chips = [1, 2, 3]
    .map((h) => `<button type="button" data-study-hours="${h}" aria-pressed="${st.study.hours === h}">${h} 小时</button>`)
    .join('');
  return `<section class="cx-q cx-study">
    <div class="cx-q-head"><h3>空出来的时间，去哪学习</h3></div>
    <div class="cx-study-ctl" role="group" aria-label="学习条件">${chips}
      <button type="button" class="cx-study-socket" data-study-socket aria-pressed="${st.study.socket}">需要插座</button></div>
    <p class="cx-quiet">${esc(line)}${Number.isFinite(free) && short && st.me.courses.length ? ` <b class="cx-warn">不够 ${st.study.hours} 小时。</b>` : ''}</p>
    ${spots.length
      ? `<ul class="cx-events" role="list">${spots
          .map((s) => `<li><button class="cx-event cx-spot" type="button" ${s.kind === 'place' ? `data-id="${esc(s.id)}"` : `data-osm="${esc(s.osm)}"`} style="--h:${PLACE_TYPES.study.hue}">
            <span class="cx-event-glyph is-still">${glyphSVG('study')}</span>
            <span class="cx-class-main"><b>${esc(s.name)}</b><span>${[
              s.d != null ? `${fromLabel && origin ? `离${esc(fromLabel)}` : '离校区中心'}直线约 ${Math.round(s.d / 10) * 10} 米` : '',
              s.socket ? '同学说有插座' : s.socket === null ? '插座情况未知' : '',
              s.note ? esc(s.note) : '',
            ].filter(Boolean).join(' · ')}</span></span>
          </button></li>`)
          .join('')}</ul>`
      : `<p class="cx-quiet">${st.study.socket ? '还没有同学标注过“有插座”的学习地点。' : '这个校区还没有同学标注的学习空间。'}找到好地方，可以标出来。</p>`}
    <p class="cx-hint">空座位、空教室还没有接通学校数据：图书馆官网的剩余座位还在核实统计口径，教室安排需要学校授权。现在只按距离和同学标注排序，去之前以现场为准。<a href="https://lib.cumtb.edu.cn/" target="_blank" rel="noopener">图书馆官网</a></p>
  </section>`;
}

// 想去清单：同学标注的地点里，自己收藏过的（Codex 建议：收藏形成私人“想去清单”）
function wantHTML() {
  if (!st.online || !st.user || st.state !== 'ready') return '';
  const list = inCampus().filter((f) => f.properties.starred);
  return `<section class="cx-q"><div class="cx-q-head"><h3>想去</h3></div>
    ${list.length ? `<ul class="cx-list" role="list">${list.map(rowHTML).join('')}</ul>` : '<p class="cx-quiet">在同学标注的地点卡上点“收藏”，就会出现在这里，只有你自己看得到。</p>'}
  </section>`;
}

function questHTML(q) {
  const open = st.openQuest === q.id;
  const pct = q.total ? Math.round((q.done / q.total) * 100) : 0;
  const complete = q.total && q.done === q.total;
  const steps = q.collect
    ? `<div class="cx-chips">${q.steps.map((s) => `<button type="button" class="cx-chip${s.done ? ' is-done' : ''}" data-osm="${esc(s.targets[0] ?? '')}">${esc(s.title)}</button>`).join('')}</div>`
    : `<ol class="cx-steps-list" role="list">${q.steps
        .map((s) => `<li class="${s.done ? 'is-done' : ''}"><span class="cx-check-dot" aria-hidden="true"></span>
          <span class="cx-class-main"><b>${esc(s.title)}</b>${s.hint ? `<span>${esc(s.hint)}</span>` : ''}</span>
          ${s.targets.length ? `<button class="btn-link" type="button" data-osm="${esc(s.targets[0])}">${s.done ? '看看' : '去这里'}</button>` : '<span class="muted">地图上还没有</span>'}</li>`)
        .join('')}</ol>`;
  return `<article class="cx-quest${open ? ' is-open' : ''}${complete ? ' is-complete' : ''}${q.personal ? ' is-personal' : ''}">
    <button class="cx-quest-head" type="button" data-quest="${q.id}" aria-expanded="${open}">
      <span class="cx-quest-title"><b>${esc(q.title)}</b>${complete ? '<span class="tag tag-ok">已完成</span>' : q.personal ? '<span class="tag tag-accent">你的</span>' : ''}</span>
      <span class="num cx-quest-n">${q.done}/${q.total}</span>
      <span class="cx-bar" aria-hidden="true"><i style="transform:scaleX(${(pct / 100).toFixed(3)})"></i></span>
    </button>
    ${open ? `<div class="cx-quest-body"><p class="cx-hint">${esc(q.lead)}</p>${steps}</div>` : ''}
  </article>`;
}

function questsHTML() {
  const list = currentQuests();
  const mapMissing = !cm?.data;
  return `${playerHTML()}${todayHTML()}${studyHTML()}${eventsHTML()}${wantHTML()}
    <section class="cx-q"><div class="cx-q-head"><h3>探索任务</h3></div>
      ${mapMissing ? `<p class="cx-quiet">${esc(st.mapError || '正在加载楼宇数据…')}</p>` : list.map(questHTML).join('') || '<p class="cx-quiet">这个校区的地图数据还太少，暂时生成不了任务。</p>'}
      <p class="cx-hint">“到过”是你自己点的，本站不读取你的位置。</p>
    </section>`;
}

// ---------- 渲染：同学标注 ----------

const SKELETON = `<div class="cx-skel" aria-label="正在加载地点">${'<span></span>'.repeat(4)}</div>`;

function stateHTML() {
  if (st.state === 'loading') return SKELETON;
  if (st.state === 'offline')
    return `<div class="cx-empty">
      <p class="cx-empty-title">社区服务没有连接。</p>
      <p>同学标注的地点经过核对后保存在社区服务里。现在打开的是只读的静态页面，所以这里看不到，<b>不代表附近什么都没有</b>。</p>
      <p class="muted">楼宇地图和你自己的任务不受影响。</p>
    </div>`;
  if (st.state === 'error')
    return `<div class="cx-empty">
      <p class="cx-empty-title">地点没有加载出来。</p>
      <p>${esc(st.error)}</p>
      <p class="muted">这不代表附近没有地点。</p>
      <button class="btn btn-primary btn-sm" type="button" data-act="refresh">重试</button>
    </div>`;
  return '';
}

function typesHTML() {
  const counts = {};
  inCampus().forEach((f) => (counts[f.properties.placeType] = (counts[f.properties.placeType] ?? 0) + 1));
  const n = (k) => (st.state === 'ready' ? `<span class="seg-count">${k === 'all' ? inCampus().length : counts[k] ?? 0}</span>` : '');
  return `<div class="cx-types" role="group" aria-label="按分类筛选">${[
    `<button type="button" data-type="all" aria-pressed="${st.type === 'all'}">全部${n('all')}</button>`,
    ...ORDER.map((k) => `<button type="button" data-type="${k}" aria-pressed="${st.type === k}" style="--h:${PLACE_TYPES[k].hue}">${glyphSVG(k)}${esc(typeName(k))}${n(k)}</button>`),
  ].join('')}</div>`;
}

function rowHTML(f) {
  const p = f.properties;
  const d = p.data;
  const temp = d.duration === 'temporary';
  const photo = p.photos?.[0]?.previewUrl;
  const o = p.observations ?? {};
  const badge = p.expired
    ? '<span class="tag tag-danger">已过期</span>'
    : temp
      ? `<span class="tag tag-warn">限时 · ${esc(timeLeft(d.expiresAt))}</span>`
      : '';
  const obs = o.stillThere || o.gone ? `<span class="cx-row-obs">还在 ${o.stillThere} · 不在 ${o.gone}</span>` : '';
  return `<li><button class="cx-row${f.id === st.selected ? ' is-on' : ''}${p.expired ? ' is-expired' : ''}" type="button" data-id="${esc(f.id)}" style="--h:${PLACE_TYPES[p.placeType].hue}">
    <span class="cx-thumb">${photo ? `<img src="${esc(photo)}" alt="" loading="lazy" decoding="async">` : glyphSVG(p.placeType)}</span>
    <span class="cx-row-main">
      <span class="cx-row-title">${esc(d.title)}</span>
      <span class="cx-row-sub">${esc(typeName(p.placeType))}${d.addressHint ? ` · ${esc(d.addressHint)}` : ''}</span>
      ${badge || obs ? `<span class="cx-row-meta">${badge}${obs}</span>` : ''}
    </span>
  </button></li>`;
}

function placesHTML() {
  const state = stateHTML();
  if (state) return state;
  const all = inCampus();
  const list = visible();
  if (!all.length)
    return `${typesHTML()}<div class="cx-empty">
      <p class="cx-empty-title">${esc(campusName(st.campus))}还没有核对过的地点。</p>
      <p>第一个，可以由你来标：一个安静的自习角落、一家常去的窗口，或者今天偶遇的奶龙。</p>
      <button class="btn btn-primary btn-sm" type="button" data-add-place>标一个地点</button>
      ${st.expired ? '' : '<p class="muted">过期的限时发现默认不显示，可以在下方打开。</p>'}
    </div>`;
  if (!list.length)
    return `${typesHTML()}<div class="cx-empty"><p class="cx-empty-title">这一类还没有地点。</p>
      <button class="btn btn-outline btn-sm" type="button" data-type="all">看全部</button></div>`;
  return `${typesHTML()}<p class="cx-count">${esc(campusName(st.campus))} · <span class="num">${list.length}</span> 个地点</p>
    <ul class="cx-list" role="list">${list.map(rowHTML).join('')}</ul>`;
}

// ---------- 渲染：楼宇 ----------

// 校历、两校区交通由 Codex 从学校公开通知整理（data/calendar.json、data/shuttle.json）；
// 图书馆、体育部公告由维护机器人读学校公开网站（/api/hub/campus/notices）。都没有的时候如实说“待接入”。
const json = (path) => fetch(path, { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
const svc = { notices: null, calendar: null, shuttle: null, loaded: false };
async function loadServices() {
  if (svc.loaded) return;
  svc.loaded = true;
  // 面板可能比“社区服务是否在线”的检查先渲染，这里自己等一下状态
  const online = (await hubState()).online;
  const [calendar, shuttle, notices] = await Promise.all([json('data/calendar.json'), json('data/shuttle.json'), online ? hubApi.campusNotices().catch(() => null) : null]);
  Object.assign(svc, { calendar, shuttle, notices });
  if (view() === 'buildings') renderBody();
}

function termWeek(cal) {
  const now = Date.now();
  const weeks = cal?.weeks ?? [];
  let cur = null;
  for (const w of weeks) if (Date.parse(w.start) <= now) cur = w;
  return cur ? cur.n : null;
}

const SVC = (icon, h, title, sub, action) => `<li class="cx-svc"><span class="ap-symbol" style="--h:${h}">${icon}</span><span class="cx-svc-text"><b>${title}</b><span>${sub}</span></span>${action}</li>`;
const IC = {
  cal: '<svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="15" rx="3"/><path d="M4 10h16M9 3v4M15 3v4"/></svg>',
  bus: '<svg viewBox="0 0 24 24"><rect x="5" y="4" width="14" height="13" rx="3"/><path d="M5 11h14M8 20v-3M16 20v-3M8.5 14h.01M15.5 14h.01"/></svg>',
  book: '<svg viewBox="0 0 24 24"><path d="M3 5c4-2 7-1 9 1 2-2 5-3 9-1v15c-4-2-7-1-9 0-2-1-5-2-9 0zM12 6v14"/></svg>',
  ball: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.6 2.4 2.6 14.6 0 17M12 3.5c-2.6 2.4-2.6 14.6 0 17"/></svg>',
  school: '<svg viewBox="0 0 24 24"><path d="m2 8 10-5 10 5-10 5zM6 11v6c4 3 8 3 12 0v-6"/></svg>',
  seat: '<svg viewBox="0 0 24 24"><path d="M7 4v8h10V4M5 12h14v3H5zM7 15v5M17 15v5"/></svg>',
};

function servicesHTML() {
  loadServices();
  const n = svc.notices;
  const lib = n?.library ?? {};
  const libLatest = lib.items?.[0];
  const sport = n?.sports?.find((x) => x.list?.includes('cgyy')) ?? n?.sports?.[0];
  const week = termWeek(svc.calendar);
  const routes = svc.shuttle?.routes ?? [];
  const ext = (href, text = '查看') => `<a class="cx-svc-go" href="${esc(href)}" target="_blank" rel="noopener">${text} ↗</a>`;
  return `<section class="cx-services" aria-label="校园服务">
    <h3 class="cx-group-h">校园服务</h3>
    <ul class="cx-svc-list" role="list">
      ${SVC(IC.cal, 4, '校历', week ? `${esc(svc.calendar.term ?? '本学期')} · 第 ${week} 周` : '本学期校历待接入（教务处公开校历）', svc.calendar?.source ? ext(svc.calendar.source) : ext('https://jwc.cumtb.edu.cn/', '教务处'))}
      ${SVC(IC.bus, 150, '两校区交通', routes.length ? `${routes.length} 条线路 · ${esc(routes[0].from)} → ${esc(routes[0].to)}` : '校车时刻待核对；学校公开后会显示在这里', routes[0]?.source ? ext(routes[0].source) : '')}
      ${SVC(IC.book, 262, '图书馆公告', libLatest ? `${esc(libLatest.title)} · ${esc(libLatest.date)}` : lib.status === 'needs-browser' ? '公告页需要浏览器读取，维护者装好浏览器组件后会自动显示' : st.online ? '正在读取…' : '需要社区服务', ext(lib.url || 'https://lib.cumtb.edu.cn/', '官网'))}
      ${SVC(IC.seat, 211, '图书馆座位', '官网预约 + 放号前提醒（本站不代登录、不代抢座）', '<a class="cx-svc-go" href="reservations.html">座位助手 →</a>')}
      ${SVC(IC.ball, 28, '体育场馆', sport ? `${esc(sport.title)}${sport.date ? ` · ${esc(sport.date)}` : ''}` : '预约指南 · 在“矿大北京体育服务号”里由你确认', ext(sport?.url || 'https://tiyu.cumtb.edu.cn/xwzx/cgyy.htm', '预约指南'))}
      ${SVC(IC.school, 330, '教务与教室', '课表请自己填进“我的课程”；空教室和借用流程以教务处为准', ext('https://jwc.cumtb.edu.cn/', '教务处'))}
    </ul>
    ${n?.checked ? `<p class="cx-hint">公告由维护机器人读学校公开网站，核对于 ${esc(fmtTime(n.checked))}。</p>` : ''}
  </section>`;
}

function buildingsHTML() {
  if (!cm?.data) return `<div class="cx-empty"><p>${esc(st.mapError || '正在加载楼宇数据…')}</p></div>`;
  const all = cm.buildings();
  const named = all.filter((b) => b.properties.name);
  const visited = visitedSet(st.me, st.campus);
  const groups = Object.keys(BUILDING_USE)
    .map((use) => [use, named.filter((b) => b.properties.use === use)])
    .filter(([, list]) => list.length);
  const sparse = all.length < 20;
  return `${sparse ? `<p class="notice"><span class="notice-dot" aria-hidden="true"></span><span><strong>${esc(campusName(st.campus))}的楼还没画全。</strong>OpenStreetMap 上目前只有 ${all.length} 栋楼。可以在 OpenStreetMap 上补画，本站更新数据后就会出现在这里。</span></p>` : ''}
    <p class="cx-count">${named.length} 栋有名字${all.length > named.length ? `，另有 ${all.length - named.length} 栋还没有名字（地图上能点，卡片里没有名称）` : ''}</p>
    ${groups
      .map(([use, list]) => `<h3 class="cx-group-h"><i class="cm-swatch cm-sw-${use}" aria-hidden="true"></i>${BUILDING_USE[use].name}</h3>
        <ul class="cx-list" role="list">${list
          .map((b) => `<li><button class="cx-row cx-brow" type="button" data-osm="${esc(b.properties.osm)}"><span class="cx-row-main"><span class="cx-row-title">${esc(b.properties.name)}</span>
            <span class="cx-row-sub">${b.properties.levels ? `${b.properties.levels} 层` : '层数未知'}</span></span>${visited.has(b.properties.osm) ? '<span class="tag tag-ok">到过</span>' : ''}</button></li>`)
          .join('')}</ul>`)
      .join('')}<details class="cx-service-folder"><summary>校园服务与官方入口</summary>${servicesHTML()}</details>`;
}

// ---------- 渲染：搜索 ----------

function searchHTML() {
  const bs = fuzzySearch((cm?.buildings() ?? []).filter(b => b.properties.name), st.q, { getTitle:b => b.properties.name, getKeywords:b => [BUILDING_USE[b.properties.use]?.name,...(b.properties.aliases || [])].join(' '), limit:12 });
  const ps = inCampus().filter(matches).slice(0, 20);
  if (!bs.length && !ps.length)
    return `<div class="cx-empty"><p class="cx-empty-title">${esc(campusName(st.campus))}里没有找到“${esc(st.q.trim())}”。</p>
      <p>地图上的楼名来自 OpenStreetMap，可能和平时的叫法不一样。也可以切换到另一个校区再搜。</p></div>`;
  return `${bs.length ? `<h3 class="cx-group-h">楼</h3><ul class="cx-list" role="list">${bs
    .map((b) => `<li><button class="cx-row cx-brow" type="button" data-osm="${esc(b.properties.osm)}"><span class="cx-row-main"><span class="cx-row-title">${esc(b.properties.name)}</span><span class="cx-row-sub">${BUILDING_USE[b.properties.use].name}</span></span></button></li>`)
    .join('')}</ul>` : ''}
    ${ps.length ? `<h3 class="cx-group-h">同学标注</h3><ul class="cx-list" role="list">${ps.map(rowHTML).join('')}</ul>` : ''}`;
}

// ---------- 渲染：楼的卡片（Apple Park 式的介绍页） ----------

const fact = (k, v) => (v ? `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>` : '');

function namingHTML(p){
 const value=buildingNames[st.campus]?.[p.osm];
 return `<section class="cx-name-panel"><h3>大家怎么叫这栋楼</h3><p class="cx-name-original">${p.official_name?'官方名称：'+esc(p.official_name):'地图名称（OSM）：'+esc((p.mapName??p.name)||'尚未命名')}</p><div class="cx-name-options">${(value?.names||[]).slice(0,6).map(n=>`<button type="button" data-name-vote="${esc(n.name)}" data-name-osm="${esc(p.osm)}" aria-pressed="${n.name===value.mine}"><b>${esc(n.name)}</b><span>${n.votes} 人支持</span></button>`).join('')}</div><form class="cx-name-form" data-form="building-name" data-osm="${esc(p.osm)}"><input name="name" maxlength="40" required aria-label="建筑常用名称" placeholder="写下你熟悉的名称"><button type="submit" class="btn btn-primary btn-sm">提名</button></form>${value?.mine?`<button class="btn-link" data-name-vote="" data-name-osm="${esc(p.osm)}">撤回我的支持</button>`:''}<p class="cx-name-note">登录并验证邮箱后可参与，每个账号每栋一票。学生常用名不替代官方名称。</p></section>`;
}
async function loadBuildingNames(campus){
 try{const result=await hubApi.request('map/names?campus='+encodeURIComponent(campus));buildingNames[campus]=result.buildings;
 for(const feature of st.maps[campus]?.features||[]){const p=feature.properties;if(!p?.osm)continue;p.mapName??=p.name||'';p.studentName=result.buildings[p.osm]?.preferred||'';p.name=p.studentName||p.mapName;}
 if(st.campus===campus&&st.maps[campus]){cm.load(st.maps[campus]);cm.select(st.building);renderAll();}
 }catch{/* The map remains usable when the optional community service is offline. */}
}
async function voteBuildingName(osm,name){
 if(!st.user){location.href=loginURL();return;}
 await hubApi.request('map/names',{campus:st.campus,osm,name});await loadBuildingNames(st.campus);toast(name?'已记录你的名称选择。':'已撤回你的支持。');
}
function navPoints(){return [...(cm?.buildings()||[]).map(b=>({id:'b|'+b.properties.osm,name:b.properties.name||'未命名建筑 '+b.properties.osm,center:b.properties.center})),...inCampus().filter(f=>!f.properties.expired).map(f=>({id:'p|'+f.id,name:f.properties.data.title,center:f.geometry.coordinates}))];}
function routeHTML(){
 const points=navPoints(),options=selected=>points.map(p=>`<option value="${esc(p.id)}"${p.id===selected?' selected':''}>${esc(p.name)}</option>`).join('');
 const r=directRoute.result;
 return `<section class="cx-navigation"><h3>去哪里</h3><form data-form="navigation"><label>起点<select name="from" required><option value="">选择出发地点</option>${options(directRoute.from)}</select></label><label>终点<select name="to" required><option value="">选择目的地</option>${options(directRoute.to)}</select></label><button class="btn btn-primary" type="submit">在地图上规划路线</button></form>${r?`<div class="cx-route-result"><b>约 ${r.minutes} 分钟</b><p>${Math.round(r.meters)} 米 · 校园步行</p><small>${r.mode==='mixed'?'部分路段为直线估算，请现场核对通行。':'依据已有步行路网估算，入口和开放情况请现场核对。'}</small></div>`:''}<details class="cx-service-folder"><summary>这一天的课程路线</summary>${dayRouteHTML()}</details></section>`;
}
function beginNavigation(target){directRoute.to=target;setTab('route');setSheet(true);map.closePopup();}
function activitiesHTML(){return placesHTML()+`<details class="cx-service-folder"><summary>探索校园</summary>${currentQuests().map(questHTML).join('')||'<p class="cx-quiet">此校区暂无探索任务。</p>'}</details>`;}

function buildingHTML(b) {
  const p = b.properties;
  const use = BUILDING_USE[p.use];
  const visited = visitedSet(st.me, st.campus).has(p.osm);
  const courses = st.me.courses.filter((c) => c.building?.osm === p.osm && c.building.campus === st.campus);
  const here = routeOccurrences().filter(x => x.building?.osm === p.osm && x.building.campus === st.campus);
  const favorite=(st.me.favorites || []).some(x=>x.campus===st.campus&&x.osm===p.osm);
  const inside = inCampus().filter((f) => pointInFeature(f.geometry.coordinates, b));
  const [lat, lng] = centerOf(b);
  const photo=inside.flatMap(f=>f.properties.photos||[]).find(p=>p.previewUrl);
  return `<article class="bc cm-tone-${p.use}" aria-labelledby="bc-title">
    <button class="cx-back" type="button" data-act="back"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14.5 5.5-6.5 6.5 6.5 6.5"/></svg>返回</button>
    <p class="bc-eyebrow">${esc(campusName(st.campus))} · ${esc(use.name)}</p>
    <h2 class="bc-title" id="bc-title" tabindex="-1">${esc(p.name || '一栋还没有名字的楼')}</h2>
    ${p.studentName?'<p class="cx-name-original">学生常用名 · '+esc(p.mapName||'原地图未命名')+'</p>':''}
    <figure class="bc-hero">${photo?`<img class="cx-building-photo" src="${esc(photo.previewUrl)}" alt="${esc(p.name||'建筑')}的同学投稿照片">`:buildingModelSVG(b)}
      <figcaption>${photo?'同学公开投稿照片':`按 OpenStreetMap 轮廓绘制 · ${p.levels?`${p.levels} 层`:'层数未知，按 3 层示意'}`}</figcaption></figure>

    <div class="bc-cta">
      <button class="btn btn-primary" data-act="navigate-building">导航到这里</button>
      <button class="btn btn-secondary" data-act="favorite-building" aria-pressed="${favorite}">${favorite?'已收藏':'收藏地点'}</button>
    </div>
    <p class="cx-hint">路线以楼宇中心为端点，入口请现场核对。</p>
    ${campusServiceHTML(p.use,st.campus)?`<details class="cx-service-folder"><summary>预约与官方服务</summary>${campusServiceHTML(p.use,st.campus)}</details>`:''}
    <p class="cx-visit-note"><button class="btn-link" type="button" data-act="visit" aria-pressed="${visited}">${visited?'✓ 到过这里':'标记到过这里'}</button></p>
    <dl class="bc-rows">
      <div><dt>${esc(routeDate)} 到这里</dt><dd>${here.length?here.map(x=>`<p>${esc(x.start)}—${esc(x.end)} ${esc(x.title)}${x.course?.floor || x.event?.floor ? ` · 楼层 ${esc(x.course?.floor || x.event?.floor)}`:''}</p>`).join(''):'这一天没有已填写到此楼的安排。'}</dd></div>
      <div><dt>你的课</dt><dd>${courses.length
        ? `<ul role="list">${courses.map((c) => `<li><b>${esc(c.name)}</b>${c.room ? ` · ${esc(c.room)}` : ''}<span>${c.slots.map((s) => `${DAYS[s.day - 1]} ${s.start}`).join('、')}</span></li>`).join('')}</ul>`
        : `<button class="btn-link" type="button" data-act="course-here">把一门课放在这里</button>`}</dd></div>
      <div><dt>相关活动</dt><dd>${inside.filter(f=>f.properties.placeType==='event'&&!f.properties.expired).length?`<ul role="list">${inside.filter(f=>f.properties.placeType==='event'&&!f.properties.expired).map(f=>`<li><button class="btn-link" data-id="${esc(f.id)}">${esc(f.properties.data.title)}</button></li>`).join('')}</ul>`:'暂无已公开活动'}</dd></div>
      <div><dt>同学标注</dt><dd>${inside.length
        ? `<ul role="list">${inside.map((f) => `<li><button class="btn-link" type="button" data-id="${esc(f.id)}">${esc(f.properties.data.title)}</button></li>`).join('')}</ul>`
        : `<button class="btn-link" type="button" data-act="add-here">在这栋楼标一个地点</button>`}</dd></div>
      <div><dt>楼层</dt><dd>${p.levels ? `${p.levels} 层` : '未知'}</dd></div>
      <div><dt>数据</dt><dd><a href="https://www.openstreetmap.org/${esc(p.osm)}" target="_blank" rel="noopener">在 OpenStreetMap 上查看或修正</a></dd></div>
    </dl>
    ${namingHTML(p)}
  </article>`;
}

// ---------- 渲染：同学标注的地点卡片 ----------

function obsHTML(p) {
  const o = p.observations ?? {};
  const temp = p.data.duration === 'temporary';
  const mine = st.user && p.owner?.id === st.user.id;
  const last = st.reports[p.id];
  const controls = mine
    ? '<p class="cx-hint">这是你标的地点，现场反馈留给其他同学。情况有变化时，可以再标一条新的；修改原记录的页面还在做。</p>'
    : `<div class="cx-obs-btns" role="group" aria-label="现场反馈">
        <button class="btn btn-sm ${last === 'still-there' ? 'btn-primary' : 'btn-outline'}" type="button" data-act="obs" data-status="still-there" aria-pressed="${last === 'still-there'}">还在</button>
        <button class="btn btn-sm ${last === 'gone' ? 'btn-primary' : 'btn-outline'}" type="button" data-act="obs" data-status="gone" aria-pressed="${last === 'gone'}">已经不在了</button>
        ${last ? '<button class="btn-link" type="button" data-act="obs" data-status="clear">撤回我的反馈</button>' : ''}
      </div>`;
  return `<section class="cx-obs">
    <h3>${temp ? '它还在吗' : '现场有变化吗'}</h3>
    <p class="cx-obs-n"><span><b class="num">${o.stillThere ?? 0}</b> 人说还在</span><span><b class="num">${o.gone ?? 0}</b> 人说不在了</span>${o.lastReportAt ? `<span class="muted">最近一次 ${esc(fmtTime(o.lastReportAt))}</span>` : ''}</p>
    ${controls}
    ${o.notice ? `<p class="cx-hint">${esc(o.notice)}</p>` : ''}
  </section>`;
}

function activityDetailsHTML(f) {
  const p=f.properties,d=p.data,event=localActivity(f,new URL(`map.html?place=${encodeURIComponent(f.id)}&campus=${encodeURIComponent(p.campus)}`,location.href).href);
  const source=activityURL(d.links?.source);
  const registration=activityURL(d.registrationURL);
  const joined=event&&st.me.events.some(e=>e.id===event.id);
  const explicitTimes=d.startsAt&&d.endsAt&&Number.isFinite(Date.parse(d.startsAt))&&Number.isFinite(Date.parse(d.endsAt));
  const dates=datedActivity(d);
  return `<section class="cx-activity-details" aria-label="活动日程">
    ${explicitTimes?`<p><b>活动时间（北京时间）</b><br>${esc(activityTime(d.startsAt))} → ${esc(activityTime(d.endsAt))}</p>`:dates?`<p><b>活动时间（北京时间）</b><br>${esc(dates.date)} ${esc(dates.start)}–${esc(dates.end)}</p>`:''}
    <p>${d.building?`所在楼宇：${esc(d.building.name||d.building.osm)} · ${esc(campusName(d.building.campus))}<br>`:''}本地提醒：${d.reminderMinutes?`提前 ${esc(d.reminderMinutes)} 分钟（需要打开本站）`:'不提醒'}</p>
    <p>${source?`<a href="${esc(source)}" target="_blank" rel="noopener noreferrer">查看活动原来源 ↗</a>`:'来源：这条已审核的同学投稿，参加前请向发布者核对。'}${registration?` · <a href="${esc(registration)}" target="_blank" rel="noopener noreferrer">报名入口 ↗</a>`:''}</p>
    ${event?`<button class="btn btn-outline btn-sm" data-act="add-local-event" ${joined?'disabled':''}>${joined?'已加入本地日程':'加入本地日程'}</button>`:explicitTimes?'<p class="cx-hint">这是跨日或不足一分钟的活动。当前本地日程按天记录，请打开完整计划按真实时间分天填写；不会自动截断活动。</p>':'<p class="cx-hint">这条发现没有明确的活动起止日期与时间，暂不能加入日程；看到时间和有效期不作为活动时间。</p>'}
  </section>`;
}
const activityURL=value=>{try{if(typeof value!=='string'||/[\s\u0000-\u001f\u007f]/.test(value))return null;const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password?u.href:null;}catch{return null;}};
const activityTime=value=>new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(value));

function detailHTML(f) {
  const p = f.properties;
  const d = p.data;
  const temp = d.duration === 'temporary';
  const nav = !p.expired;
  const photos = p.photos ?? [];
  const watching = (p.watch ?? []).includes('revision');
  return `<article class="cx-detail" style="--h:${PLACE_TYPES[p.placeType].hue}" aria-labelledby="cx-detail-title">
    <button class="cx-back" type="button" data-act="back"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14.5 5.5-6.5 6.5 6.5 6.5"/></svg>返回</button>
    ${photos.length ? `<div class="cx-photos${photos.length > 1 ? ' is-multi' : ''}">${photos.length > 1 ? depthSlides(photos.map((ph) => ph.previewUrl), `${d.title}的照片`) : photos.map((ph, i) => `<img src="${esc(ph.previewUrl)}" alt="${esc(d.title)}，第 ${i + 1} 张照片" loading="lazy" decoding="async">`).join('')}</div>` : `<div class="cx-photo-empty">${glyphSVG(p.placeType)}</div>`}
    ${d.photoCredit || d.license ? `<p class="cx-credit">照片 ${esc(d.photoCredit || '')}${d.license ? ` · ${esc(d.license)}` : ''}</p>` : ''}
    <p class="bc-eyebrow">${esc(CAMPUS_SHORT[p.campus] ?? '')} · ${esc(typeName(p.placeType))}${p.expired ? ' · 已过期' : temp ? ` · 限时 · ${esc(timeLeft(d.expiresAt))}` : ''}</p>
    <h2 class="bc-title" id="cx-detail-title" tabindex="-1">${esc(d.title)}</h2>
    ${d.summary ? `<p class="bc-lead">${esc(d.summary)}</p>` : ''}
    ${p.placeType==='event'?activityDetailsHTML(f):''}
    <p><a href="planner.html?date=${encodeURIComponent(p.placeType==='event'?(datedActivity(d)?.date||routeDate):routeDate)}&view=day" target="_top">打开我的计划 →</a></p>
    <div class="bc-cta">
      ${nav ? `<button class="btn btn-primary" data-act="navigate-place">导航到这里</button>` : `<p class="cx-nonav">${p.expired ? '已经过期，不再提供前往导航。' : '暂时没有导航链接。'}</p>`}
    </div>
    
    <dl class="bc-rows">
      ${fact('详细位置', d.addressHint)}
      ${fact('开放和通行', d.accessNotes)}
      ${d.observedAt ? fact('看到的时间', fmtTime(d.observedAt)) : ''}
      ${temp && d.expiresAt ? fact(p.expired ? '过期于' : '大概待到', fmtTime(d.expiresAt)) : ''}
      ${fact('投稿', p.owner ? `${p.owner.name}（@${p.owner.username}）` : '')}
      ${d.locationReviewedAt ? fact('坐标核对', fmtTime(d.locationReviewedAt)) : ''}
    </dl>
    ${d.tags?.length ? `<p class="cx-taglist">${d.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</p>` : ''}
    <div class="cx-actions" role="group" aria-label="操作">
      <button class="cx-act${p.starred ? ' is-on' : ''}" type="button" data-act="star" aria-pressed="${Boolean(p.starred)}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.5 4.2 12.9a4.9 4.9 0 0 1 6.9-6.9l.9.9.9-.9a4.9 4.9 0 0 1 6.9 6.9z"/></svg>
        <span>收藏</span><span class="num">${p.siteStars ?? 0}</span></button>
      <button class="cx-act${watching ? ' is-on' : ''}" type="button" data-act="watch" aria-pressed="${watching}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2H4.5z"/><path d="M10 21h4"/></svg>
        <span>${watching ? '已关注' : '关注修改'}</span></button>
      <button class="cx-act" type="button" data-act="share">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/></svg>
        <span>复制链接</span></button>
    </div>
    ${p.expired ? '' : obsHTML(p)}
    ${p.sourceLabel ? `<p class="cx-source">${esc(p.sourceLabel)}</p>` : ''}
    <details class="cx-report">
      <summary>报告问题</summary>
      <form data-form="report">
        <label class="sr-only" for="cx-report-reason">问题说明</label>
        <textarea id="cx-report-reason" name="reason" rows="3" maxlength="2000" required placeholder="例如：照片里能认出人脸、位置标错了、这里其实要刷卡才能进"></textarea>
        <button class="btn btn-outline btn-sm" type="submit">提交给维护者</button>
      </form>
    </details>
  </article>`;
}

// ---------- 面板总调度 ----------

function view() {
  if (st.q.trim()) return 'search';
  if (st.selected && st.state === 'ready' && find(st.selected)) return 'place';
  if (st.building && cm?.building(st.building)) return 'building';
  return st.tab;
}

function renderBody() {
  const body = $('#cx-body');
  if ([body,inspectorBody].some(el=>el.contains(document.activeElement)) && /^(TEXTAREA|INPUT|SELECT)$/.test(document.activeElement.tagName)) return;
  const v = view(), detail = v === 'place' || v === 'building';
  const renderers={search:searchHTML,place:()=>detailHTML(find(st.selected)),building:()=>buildingHTML(cm.building(st.building)),quests:activitiesHTML,places:activitiesHTML,buildings:buildingsHTML,route:routeHTML};
  const html=renderers[detail?st.tab:v]();
  if(body.innerHTML!==html)body.innerHTML=html;
  body.dataset.view=detail?st.tab:v;
  panel.classList.remove('is-detail');
  if(detail)showInspector(renderers[v](),v);else closeInspector();
  $$('#cx-tabs [data-tab]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.tab===st.tab&&v!=='search')));
  $('#cx-expired-wrap').hidden = st.tab !== 'places';
}

function renderFetched() {
  const el = $('#cx-fetched');
  if (st.state !== 'ready') return (el.innerHTML = '');
  const t = new Date(st.fetchedAt);
  el.innerHTML = `<button type="button" class="btn-link" data-act="refresh" title="重新获取同学标注">${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')} 获取 · 刷新</button>`;
}

function renderThemes() {
  const counts = {};
  st.places.forEach((f) => (counts[f.properties.placeType] = (counts[f.properties.placeType] ?? 0) + 1));
  const shortcuts = [['library','图书馆','study'],['sports','运动场馆','sports'],['canteen','食堂','food']].map(([use,name,glyph]) => `<button class="cx-theme" type="button" data-building-type="${use}"><span class="cx-theme-glyph">${glyphSVG(glyph)}</span><span>${name}</span></button>`).join('');
  $('#cx-themes').innerHTML = shortcuts + ['event','discovery'].map(
    (k) => `<a class="cx-theme" href="#explore" data-go-type="${k}" style="--h:${PLACE_TYPES[k].hue}">
      <span class="cx-theme-glyph">${glyphSVG(k)}</span><span>${esc(typeName(k))}</span>${st.state === 'ready' ? `<span class="cx-theme-n num">${counts[k] ?? 0}</span>` : ''}</a>`,
  ).join('');
}

function renderAll() {
  drawPins();
  renderMarks();
  renderThemes();
  renderBody();
  renderFetched();
}

function syncURL() {
  const q = new URLSearchParams();
  q.set('campus', st.campus);
  if(params.get('embedded')==='1')q.set('embedded','1');
  if(routeEnabled){q.set('route','today');q.set('date',routeDate);}
  if (st.tab !== 'buildings') q.set('tab', st.tab);
  if (st.type !== 'all') q.set('type', st.type);
  if (st.selected) q.set('place', st.selected);
  else if (st.building) q.set('building', st.building);
  const qs = q.toString();
  history.replaceState(null, '', `${location.pathname}${qs ? `?${qs}` : ''}${location.hash}`);
}

// ---------- 交互 ----------

// 返回楼宇数据加载完成的 Promise，需要接着选楼的地方可以等它
function setCampus(c, { fit = true } = {}) {
  if(c!==st.campus)directRoute={from:'',to:'',result:null};
  if (!CAMPUS_SHORT[c] || c === st.campus) return Promise.resolve();
  st.campus = c;
  $$('#cx-campus [data-campus]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.campus === c)));
  if (st.selected && find(st.selected)?.properties.campus !== c) st.selected = null;
  st.building = null;
  st.openQuest = null;
  renderAll();
  syncURL();
  return loadCampusMap(c).then(() => c === st.campus && fit && fitCampus(!reducedMotion()&&!activation?.keyboard));
}

function setTab(t) {
  st.tab = t==='quests'?'places':t;
  st.selected = null;
  st.building = null;
  cm?.select(null);
  st.q = '';
  $('#cx-q').value = '';
  renderAll();
  syncURL();
  $('#cx-body').scrollTop = 0;
}

function select(id, { zoom = true } = {}) {
  const f = find(id);
  if (!f) return;
  const prev = st.selected;
  st.selected = id;
  st.building = null;
  cm.select(null);
  if (f.properties.campus !== st.campus) {
    setCampus(f.properties.campus, { fit: false });
    st.selected = id;
  }
  refreshPin(prev);
  refreshPin(id);
  renderBody();
  setSheet(true);
  inspectorBody.scrollTop = 0;
  syncURL();
  // 等手机面板展开以后再算可见区域
  requestAnimationFrame(() => focusOn(latlngOf(f), zoom ? Math.max(map.getZoom(), 17.5) : map.getZoom()));
  $('#cx-detail-title')?.focus({ preventScroll: true });
}

// ---------- 点楼：在楼上弹出小窗（用途、层数、今天在这里的课、预约入口、导航、详情） ----------

let pop = null;
function popNoticeHTML(use) {
  const n = svc.notices;
  if (!n) return '';
  const list = use === 'library' ? n.library?.items ?? [] : use === 'sports' ? n.sports ?? [] : [];
  if (!list.length) return '';
  return `<div class="mp-pop-news"><b>最新公告</b>${list.slice(0, 2).map((x) => x.url
    ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title)}<small>${esc(x.date ?? '')}</small></a>`
    : `<span>${esc(x.title)}<small>${esc(x.date ?? '')}</small></span>`).join('')}</div>`;
}

function buildingPopHTML(b) {
  const p = b.properties;
  const use = BUILDING_USE[p.use] ?? BUILDING_USE.other;
  const inside = inCampus().filter((f) => pointInFeature(f.geometry.coordinates, b));
  const now=Date.now();
  const today = routeOccurrences().filter(x=>x.source==='course'&&x.building?.campus===st.campus&&x.building?.osm===p.osm).map(x=>({course:x.course,slot:x.slot,status:now>=new Date(`${x.date}T${x.start}:00+08:00`).getTime()&&now<new Date(`${x.date}T${x.end}:00+08:00`).getTime()?'now':''}));
  const visited = visitedSet(st.me, st.campus).has(p.osm);
  const [lat, lng] = centerOf(b);
  return `<div class="mp-pop" data-osm="${esc(p.osm)}">
    <p class="mp-pop-kicker"><span class="mp-pop-icon cm-l-${esc(p.use)}">${mapIcon(p.use)}</span>${esc(use.name)} · ${esc(campusName(st.campus))}</p>
    <h3 class="mp-pop-title">${esc(p.name || '一栋还没有名字的楼')}</h3>
    <p class="mp-pop-meta">${p.levels ? `${p.levels} 层` : '层数未知'}${inside.length ? ` · 同学标了 ${inside.length} 个地点` : ''}</p>
    ${today.length ? `<ul class="mp-pop-classes">${today.map((x) => `<li class="is-${x.status}"><b>${esc(x.slot.start)}</b>${esc(x.course.name)}${x.course.room ? ` · ${esc(x.course.room)}` : ''}</li>`).join('')}</ul>` : ''}
    ${campusServiceButtons(p.use, st.campus)}
    ${popNoticeHTML(p.use)}
    <div class="mp-pop-foot">
      <button type="button" data-pop="detail">详情</button>
      <button type="button" data-pop="navigate">导航</button>
      <button type="button" data-pop="visit" aria-pressed="${visited}">${visited ? '✓ 到过' : '我到过'}</button>
      <button type="button" data-pop="course">放一门课</button>
    </div>
  </div>`;
}

function openBuildingPop(f) {
  if(st.selected||st.building)back();
  const osm = f.properties.osm;
  if (!svc.loaded) loadServices().then(() => pop?.isOpen() && pop.setContent(buildingPopHTML(f)));
  cm.select(osm);
  pop?.remove();
  pop = L.popup({ className: 'mp-popup', maxWidth: 320, minWidth: 260, autoPanPaddingTopLeft: [mobile.matches ? 16 : 420, 120], autoPanPaddingBottomRight: [24, 24], offset: [0, -4] })
    .setLatLng(centerOf(f))
    .setContent(buildingPopHTML(f))
    .openOn(map);
  const popup=pop;
  const wrapper=popup.getElement()?.querySelector('.leaflet-popup-content-wrapper');
  if(wrapper)animateCard(wrapper,true);
  pop.once('remove', () => {
    if (st.building !== osm) cm.select(st.building);
    if(pop === popup)pop = null;
  });
}

// 小窗里的按钮
document.addEventListener('click', async (e) => {
  const b = e.target.closest('.mp-pop [data-pop]');
  if (!b) return;
  const osm = b.closest('.mp-pop').dataset.osm;
  const f = cm.building(osm);
  if (!f) return;
  if (b.dataset.pop === 'navigate') {beginNavigation('b|'+osm);return;}
  if (b.dataset.pop === 'detail') {
    map.closePopup();
    selectBuilding(osm);
  } else if (b.dataset.pop === 'visit') {
    const campus=st.campus;let on;
    if(!await saveAndRender(latest=>{on=toggleVisited(latest,campus,osm);}))return;
    toast(on ? '点亮了这栋楼。' : '已取消“到过”。');
    pop?.setContent(buildingPopHTML(f));
  } else if (b.dataset.pop === 'course') {
    map.closePopup();
    location.assign(plannerLink('&building='+encodeURIComponent(osm)+'&campus='+st.campus));
  }
});

function selectBuilding(osm, { zoom = true } = {}) {
  const b = cm.building(osm);
  if (!b) return;
  const prev = st.selected;
  st.selected = null;
  refreshPin(prev);
  st.building = osm;
  st.q = '';
  $('#cx-q').value = '';
  cm.select(osm);
  renderBody();
  setSheet(true);
  inspectorBody.scrollTop = 0;
  syncURL();
  requestAnimationFrame(() => focusOn(centerOf(b), zoom ? Math.max(map.getZoom(), 18) : map.getZoom()));
  $('#bc-title')?.focus({ preventScroll: true });
}

function back() {
  const prev = st.selected;
  st.selected = null;
  st.building = null;
  cm.select(null);
  refreshPin(prev);
  renderBody();
  syncURL();
}

$('#cx-campus').addEventListener('click', (e) => {
  const b = e.target.closest('[data-campus]');
  if (b) setCampus(b.dataset.campus);
});

$('#cx-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]');
  if (b) setTab(b.dataset.tab);
});

$('#cx-themes').addEventListener('click', (e) => {
  const service = e.target.closest('[data-building-type]');
  if (service) {
    const building = cm.buildings().find(f => f.properties.use === service.dataset.buildingType);
    if (building) selectBuilding(building.properties.osm);
    else toast('当前底图还没有标明这个设施的位置，请在校园设施中查找或补充。');
    return;
  }
  const a = e.target.closest('[data-go-type]');
  if (!a) return;
  st.type = a.dataset.goType;
  setTab('places');
});

let qTimer;
$('#cx-q').addEventListener('input', (e) => {
  clearTimeout(qTimer);
  if (e.isComposing) return;
  qTimer = setTimeout(() => {
    st.q = e.target.value;
    renderBody();
  }, 160);
});

$('#cx-q').addEventListener('compositionend', () => { clearTimeout(qTimer); st.q = $('#cx-q').value; renderBody(); });
attachSearchSuggestions($('#cx-q'), {
  getItems: () => [
    ...(cm?.buildings() || []).filter(b => b.properties.name).map(b => ({title:b.properties.name,keywords:BUILDING_USE[b.properties.use]?.name,kind:'建筑'})),
    ...inCampus().filter(f => st.expired || !f.properties.expired).map(f => ({...f.properties.data,kind:typeName(f.properties.placeType)})),
  ],
  onSelect: () => { clearTimeout(qTimer); st.q = $('#cx-q').value; renderBody(); },
});

$('#cx-expired').addEventListener('change', (e) => {
  st.expired = e.target.checked;
  loadPlaces();
});

async function saveAndRender(patch, revision) {
  try {
    if(planCorrupt && typeof patch==='function')throw new Error('本地计划原内容需要修复，请先导出原备份再显式导入；未覆盖原记录。');
    if(!await saveMe(patch, revision))throw new Error('浏览器没有保存成功，请保留备份后再试。');
    st.me=loadMe();renderMarks();renderBody();return true;
  } catch(error) {
    try{const snapshot=await readyMe();st.me=snapshot.data;planCorrupt=Boolean(snapshot.corrupt);}catch{}
    renderMarks();renderBody();
    toast(error.code==='conflict'?'另一个页面已更新计划，本次修改没有覆盖它；请核对后重试。':error.message);return false;
  }
}

subscribePlan(snapshot => { planCorrupt=Boolean(snapshot.corrupt);recoveryRaw=snapshot.corrupt?snapshot.raw:null;if(snapshot.corrupt)return toast('本地计划需要修复，原内容已保留。'); st.me=snapshot.data;renderMarks();renderBody(); });

async function act(btn) {
  const a = btn.dataset.act;
  if (a === 'back') return back();
  if (a === 'refresh') return loadPlaces();
  if (a === 'me') return location.assign(plannerLink(''));
  if(a==='navigate-building'&&st.building)return beginNavigation('b|'+st.building);
  if(a==='navigate-place'&&st.selected)return beginNavigation('p|'+st.selected);
  if (a === 'visit' && st.building) {
    const before = currentQuests().filter((q) => q.total && q.done === q.total).map((q) => q.id);
    const campus=st.campus,osm=st.building;let on;
    if(!await saveAndRender(latest=>{on=toggleVisited(latest,campus,osm);}))return;
    const finished = currentQuests().find((q) => q.total && q.done === q.total && !before.includes(q.id));
    return toast(finished ? `任务完成：${finished.title}。` : on ? '点亮了这栋楼。' : '已取消“到过”。');
  }
  if(a==='favorite-building' && st.building){
    const b=cm.building(st.building),favorite={campus:st.campus,osm:b.properties.osm,name:b.properties.name,center:b.properties.center};
    await saveAndRender(latest=>{latest.favorites??=[];const i=latest.favorites.findIndex(x=>x.campus===favorite.campus&&x.osm===favorite.osm);if(i<0)latest.favorites.push(favorite);else latest.favorites.splice(i,1);});return;
  }
  if (a === 'course-here' && st.building) return location.assign(plannerLink('&building='+encodeURIComponent(st.building)+'&campus='+st.campus));
  if (a === 'add-here' && st.building) {
    const b = cm.building(st.building);
    const [lng, lat] = b.properties.center;
    return openAdd({ location: { lat, lng }, campus: st.campus, title: b.properties.name ? `${b.properties.name}` : '' });
  }
  const f = st.selected && find(st.selected);
  const p = f?.properties;
  if (!p) return;
  if(a==='add-local-event'){
    const event=localActivity(f,new URL(`map.html?place=${encodeURIComponent(f.id)}&campus=${encodeURIComponent(p.campus)}`,location.href).href);
    if(!event)return toast('没有可直接记录的单日活动起止时间，请在完整计划核对填写。');
    let added=false;
    if(await saveAndRender(latest=>{if(!latest.events.some(e=>e.id===event.id)){latest.events.push(event);added=true;}})){
      routeDate=event.date;renderMarks();renderBody();syncURL();
      toast(added?'已加入本地日程，来源与提醒已保留。':'这条活动已在本地日程中，保留你已有的修改。',{href:plannerLink('&view=day'),label:'查看日程'});
    }
    return;
  }
  if (a === 'share') {
    const url = `${location.origin}${location.pathname}?place=${encodeURIComponent(p.id)}`;
    try {
      await navigator.clipboard.writeText(url);
      toast('链接已复制。');
    } catch {
      toast(url);
    }
    return;
  }
  if (a === 'star' && !blocked('收藏')) {
    const r = await hubApi.star(p.id, !p.starred);
    Object.assign(p, { starred: Boolean(r.starred), siteStars: r.siteStars ?? p.siteStars, watch: r.watch ?? p.watch });
    toast(p.starred ? '已收藏，在“我的”里能找到。' : '已取消收藏。');
  }
  if (a === 'watch' && !blocked('关注')) {
    const on = (p.watch ?? []).includes('revision');
    const r = await hubApi.watch(p.id, on ? [] : ['revision']);
    p.watch = r.watch ?? (on ? [] : ['revision']);
    toast(on ? '已取消关注。' : '已关注。这条地点被修改时，会在“我的 · 通知”里提醒你。');
  }
  if (a === 'obs' && !blocked('反馈')) {
    const status = btn.dataset.status;
    const r = await hubApi.observePlace(p.id, status);
    p.observations = r.observations ?? p.observations;
    if (status === 'clear') delete st.reports[p.id];
    else st.reports[p.id] = status;
    try { sessionStorage.setItem(REPORTS_KEY, JSON.stringify(st.reports)); } catch { /* 隐私模式 */ }
    toast(status === 'clear' ? '已撤回你的反馈。' : '谢谢，已记下。这是同学反馈，不会改变它的有效期。');
  }
  renderBody();
}

explore.addEventListener('click', async (e) => {
  if(!e.target.closest('#cx-body,#cx-inspector-body'))return;
  const hours = e.target.closest('[data-study-hours]');
  if (hours) {
    st.study.hours = Number(hours.dataset.studyHours);
    return renderBody();
  }
  if (e.target.closest('[data-study-socket]')) {
    st.study.socket = !st.study.socket;
    return renderBody();
  }
  const quest = e.target.closest('[data-quest]');
  if (quest) {
    st.openQuest = st.openQuest === quest.dataset.quest ? null : quest.dataset.quest;
    renderMarks();
    return renderBody();
  }
  const type = e.target.closest('[data-type]');
  if (type) {
    st.type = type.dataset.type === st.type && type.dataset.type !== 'all' ? 'all' : type.dataset.type;
    drawPins();
    renderBody();
    return syncURL();
  }
  const cls = e.target.closest('[data-course-building]');
  if (cls && cls.dataset.courseBuilding) {
    await setCampus(cls.dataset.campus, { fit: false });
    return selectBuilding(cls.dataset.courseBuilding);
  }
  const osm = e.target.closest('[data-osm]');
  if (osm && osm.dataset.osm) return selectBuilding(osm.dataset.osm);
  const row = e.target.closest('[data-id]');
  if (row) return select(row.dataset.id);
  const btn = e.target.closest('button[data-act]');
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  try {
    await act(btn);
  } catch (err) {
    toast(err.message ?? '操作没有成功。');
  } finally {
    btn.disabled = false;
  }
});

$('#cx-fetched').addEventListener('click', (e) => e.target.closest('[data-act="refresh"]') && loadPlaces());

explore.addEventListener('submit', async (e) => {
  if(e.target.dataset.form==='building-name'){e.preventDefault();const button=e.target.querySelector('[type=submit]');button.disabled=true;try{await voteBuildingName(e.target.dataset.osm,e.target.elements.name.value);}catch(error){toast(error.message);}finally{button.disabled=false;}return;}
  if(e.target.dataset.form==='navigation'){
    e.preventDefault();const points=navPoints(),from=points.find(p=>p.id===e.target.elements.from.value),to=points.find(p=>p.id===e.target.elements.to.value);
    if(!from||!to||from.id===to.id)return toast('请选择两个不同的地点。');
    directRoute={from:from.id,to:to.id,result:campusRoute([from,to],cm.data)};renderMarks();renderBody();
    map.stop();map.fitBounds(directRoute.result.legs.flatMap(l=>l.coordinates.map(([lng,lat])=>[lat,lng])),{...viewPad(),maxZoom:18,animate:!reducedMotion(),duration:.28});return;
  }

  if(e.target.dataset.form==='route'){
    e.preventDefault();const form=e.target,date=form.date.value;
    try {occurrences(st.me,date,date);}catch(error){return toast(error.message);}
    const campus=st.campus,prefs={start:form.start.value,via:[...form.via.selectedOptions].map(o=>o.value)};
    if(prefs.via.length>10)return toast('途经地点最多选择 10 处。');
    if(!await saveAndRender(latest=>{latest.routePrefs??={};latest.routePrefs[campus]=prefs;}))return;
    directRoute.result=null;routeDate=date;routeEnabled=true;renderMarks();renderBody();syncURL();
    const points=currentRoute?.stops.map(stop=>[stop.center[1],stop.center[0]]);
    if(points?.length>1)map.fitBounds(points,{padding:[50,50],maxZoom:18});return;
  }
  if (e.target.dataset.form !== 'report') return;
  e.preventDefault();
  const p = find(st.selected)?.properties;
  const reason = e.target.reason.value.trim();
  if (!p || !reason || blocked('报告问题')) return;
  const btn = $('button[type=submit]', e.target);
  btn.disabled = true;
  try {
    await hubApi.report(p.id, reason);
    e.target.closest('details').open = false;
    e.target.reset();
    toast('已经交给维护者，谢谢。');
  } catch (err) {
    toast(err.message ?? '没有提交成功。');
  } finally {
    btn.disabled = false;
  }
});

addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || document.querySelector('dialog[open]')) return;
  if (picking) endPick(false);
  else if (bpick) bpick(null);
  else if ((!inspector.hidden&&!inspector.inert) || ((st.selected || st.building) && [panel,inspector].some(el=>el.contains(document.activeElement)))) {activation={keyboard:true,target:document.activeElement,rect:document.activeElement.getBoundingClientRect()};back();setSheet(false);restoreCanvasFocus();}
});

// 只在页面可见时刷新；切回来时如果超过两分钟没更新，就静默刷新一次
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (st.state === 'ready' && Date.now() - st.fetchedAt > 120e3) loadPlaces({ quiet: true });
  renderMarks(); // 过了几个小时，“下一节课”会变
});
setInterval(() => {
  if (document.visibilityState !== 'visible' || picking) return;
  if (st.state === 'ready' && Date.now() - st.fetchedAt > 300e3) loadPlaces({ quiet: true });
  else if (view() === 'quests') renderBody();
}, 60e3);

// ---------- 我的校园：学院专业、课表 ----------

const meDlg = $('#cx-me');
const courseForm = $('#cx-course-form');
let courseBuilding = null;

function slotRow(slot = { day: todayIndex(), start: '08:00', end: '09:35' }) {
  return `<div class="cx-slot">
    <label class="sr-only">星期</label><select name="day">${DAYS.map((d, i) => `<option value="${i + 1}"${slot.day === i + 1 ? ' selected' : ''}>${d}</option>`).join('')}</select>
    <label class="sr-only">开始</label><input type="time" name="start" value="${slot.start}" required>
    <span aria-hidden="true">–</span>
    <label class="sr-only">结束</label><input type="time" name="end" value="${slot.end}" required>
    <button class="cx-slot-x" type="button" data-slot-x aria-label="删掉这个时间">×</button>
  </div>`;
}

function renderCourses() {
  const list = st.me.courses;
  $('#cx-courses').innerHTML = list.length
    ? list
        .map((c) => `<li class="cx-course" data-course="${esc(c.id)}">
          <div><b>${esc(c.name)}</b><span>${c.building ? `${esc(CAMPUS_SHORT[c.building.campus] ?? '')} · ${esc(c.building.name || '未命名的楼')}` : '没有选上课地点'}${c.room ? ` · ${esc(c.room)}` : ''}</span>
          <span>${c.slots.map((s) => `${DAYS[s.day - 1]} ${s.start}–${s.end}`).join('　')}</span></div>
          <button class="btn-link cx-danger" type="button" data-course-x>删除</button></li>`)
        .join('')
    : '<li class="cx-quiet">还没有课。</li>';
}

function renderBuildingSelect() {
  const named = (cm?.buildings() ?? []).filter((b) => b.properties.name).sort((a, b) => a.properties.name.localeCompare(b.properties.name, 'zh'));
  $('#cx-building-select').innerHTML = `<option value="">从${esc(CAMPUS_SHORT[st.campus])}有名字的楼里选…</option>${named
    .map((b) => `<option value="${esc(b.properties.osm)}"${courseBuilding?.osm === b.properties.osm ? ' selected' : ''}>${esc(b.properties.name)}</option>`)
    .join('')}`;
  $('#cx-course-building').textContent = courseBuilding
    ? `${CAMPUS_SHORT[courseBuilding.campus]} · ${courseBuilding.name || '一栋还没有名字的楼'}`
    : '还没有选楼。';
}

function setCourseBuilding(f) {
  courseBuilding = f
    ? { campus: st.campus, osm: f.properties.osm, name: f.properties.name, center: f.properties.center }
    : null;
  renderBuildingSelect();
}

let suggestLoaded = false;
async function openMe({ building } = {}) {
  const f = $('#cx-profile').elements;
  const p = st.me.profile;
  f.faculty.value = p.faculty || '';
  f.major.value = p.major || '';
  f.year.value = p.year || '';
  f.campus.value = p.campus || st.campus;
  if (building) setCourseBuilding(building);
  else renderBuildingSelect();
  if (!$('#cx-slots').childElementCount) $('#cx-slots').innerHTML = slotRow();
  renderCourses();
  if (!meDlg.open) meDlg.showModal();
  if (building) courseForm.elements.name.focus();
  if (!suggestLoaded) {
    suggestLoaded = true;
    const list = await courseSuggestions();
    $('#cx-course-names').innerHTML = list.map((c) => `<option value="${esc(c.name)}">`).join('');
  }
}

$('#cx-profile').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  const year = f.year.value.trim();
  if (year && !/^20\d{2}$/.test(year)) return toast('入学年份写四位数字，比如 2026。');
  const profile = { faculty: f.faculty.value.trim(), major: f.major.value.trim(), year, campus: f.campus.value };
  if(!await saveAndRender(latest=>{Object.assign(latest.profile,profile);}))return;
  toast('已保存在这个浏览器里。');
});

$('#cx-slot-add').addEventListener('click', () => $('#cx-slots').insertAdjacentHTML('beforeend', slotRow()));
$('#cx-slots').addEventListener('click', (e) => {
  if (e.target.closest('[data-slot-x]') && $$('.cx-slot').length > 1) e.target.closest('.cx-slot').remove();
});
$('#cx-building-select').addEventListener('change', (e) => setCourseBuilding(cm.building(e.target.value)));

courseForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#cx-course-err');
  const name = courseForm.elements.name.value.trim();
  const slots = $$('.cx-slot').map((row) => ({ day: Number($('select', row).value), start: $('[name=start]', row).value, end: $('[name=end]', row).value }));
  const problems = [];
  if (!name) problems.push('写上课程名。');
  if (!courseBuilding) problems.push('选一栋上课的楼（下拉里选，或者在地图上点）。');
  if (slots.some((s) => !s.start || !s.end || s.end <= s.start)) problems.push('每个上课时间都要有开始和结束，结束要晚于开始。');
  err.hidden = !problems.length;
  err.innerHTML = problems.map(esc).join('<br>');
  if (problems.length) return;
  const added={ id: newId(), name, courseId: '', room: courseForm.elements.room.value.trim(), building: structuredClone(courseBuilding), slots };
  if(!await saveAndRender(latest=>{latest.courses.push(added);if(!latest.profile.campus)latest.profile.campus=added.building.campus;}))return;
  renderCourses();
  courseForm.reset();
  setCourseBuilding(null);
  $('#cx-slots').innerHTML = slotRow();
  toast(`已添加《${name}》。`);
});

$('#cx-courses').addEventListener('click', async (e) => {
  const li = e.target.closest('[data-course]');
  if (!li || !e.target.closest('[data-course-x]')) return;
  const id=li.dataset.course;
  if(!await saveAndRender(latest=>{latest.courses=latest.courses.filter(c=>c.id!==id);}))return;
  renderCourses();
});

$('#cx-me-export').addEventListener('click', () => {
  const exported=planCorrupt&&recoveryRaw!=null?typeof recoveryRaw==='string'?recoveryRaw:JSON.stringify(recoveryRaw,null,2):JSON.stringify(st.me,null,2);
  const blob = new Blob([exported], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `luokixi-我的校园-${new Date().toISOString().slice(0, 10)}.json` });
  a.click();
  URL.revokeObjectURL(a.href);
});

$('#cx-me-import').addEventListener('change', async (e) => {
  try {
    const snapshot=await readyMe();
    const imported=importMe(JSON.parse(await e.target.files[0].text()));
    if(!await saveAndRender(imported,snapshot.revision))return;
    openMe();
    toast('已导入。');
  } catch (err) {
    toast(err.message ?? '备份文件读不出来。');
  } finally {
    e.target.value = '';
  }
});

$('#cx-me-clear').addEventListener('click', async () => {
  const snapshot=await readyMe().catch(error=>{toast(error.message);return null;});if(!snapshot)return;
  if (!confirm('清空这个浏览器里的学院、课表和“到过”的记录？清空前可以先导出备份。')) return;
  if(!await saveAndRender(importMe({ version: 1, courses: [] }),snapshot.revision))return;
  openMe();
});

// 在地图上点一栋楼，作为上课地点
let bpick = null;
$('#cx-building-pick').addEventListener('click', () => {
  meDlg.close();
  explore.classList.add('is-picking');
  $('#cx-bpick').hidden = false;
  $('#cx-bpick-title').textContent = `点一栋${CAMPUS_SHORT[st.campus]}的楼。`;
  setSheet(false);
  explore.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
  bpick = (f) => {
    bpick = null;
    explore.classList.remove('is-picking');
    $('#cx-bpick').hidden = true;
    if (f) setCourseBuilding(f);
    openMe();
  };
});
$('#cx-bpick-cancel').addEventListener('click', () => bpick?.(null));

// ---------- 标一个地点 ----------

const form = $('#cx-form');
const draft = { id: null, rev: null, location: null, accuracy: null, photos: [] };

function renderTypePick() {
  $('#cx-typepick').innerHTML = ORDER.map(
    (k) => `<label style="--h:${PLACE_TYPES[k].hue}"><input type="radio" name="placeType" value="${k}"><span>${glyphSVG(k)}${esc(typeName(k))}</span></label>`,
  ).join('');
}

function renderGate() {
  let html = '';
  if (!st.online) html = '<p class="notice"><span class="notice-dot" aria-hidden="true"></span><span><strong>社区服务没有连接。</strong>现在不能投稿，可以先看看要填哪些内容。</span></p>';
  else if (!st.user) html = `<p class="notice"><span class="notice-dot" aria-hidden="true"></span><span><strong>登录之后才能投稿。</strong>投稿会记在你的账号下，审核结果也会通知你。</span></p><a class="btn btn-primary btn-sm" href="${esc(loginURL())}">登录或注册</a>`;
  else if (!canParticipate(st.user)) html = '<p class="notice"><span class="notice-dot" aria-hidden="true"></span><span><strong>邮箱还没验证。</strong>验证之后才能上传照片和投稿。</span></p><a class="btn btn-primary btn-sm" href="me.html#account">去验证</a>';
  $('#cx-gate').innerHTML = html;
  const locked = Boolean(html);
  form.inert = locked;
  form.classList.toggle('is-locked', locked);
}

const activityBuildings=new Map();
let activityBuildingEpoch=0;
async function syncActivityFields() {
  const isActivity=form.elements.placeType.value==='event';
  $('#cx-activity-fields').hidden=!isActivity;
  if(!isActivity)return;
  const campus=form.elements.campus.value,epoch=++activityBuildingEpoch,select=$('#cx-event-building');
  const prior=select.dataset.campus===campus?select.value:'';
  select.disabled=true;
  if(!st.maps[campus]&&!activityBuildings.has(campus)){
    activityBuildings.set(campus,fetch(`data/campus-map/${campus}.json`).then(r=>{if(!r.ok)throw new Error();return r.json();}).then(data=>{st.maps[campus]=data;return data;}).catch(()=>null));
  }
  const data=st.maps[campus]||await activityBuildings.get(campus);
  if(epoch!==activityBuildingEpoch||campus!==form.elements.campus.value)return;
  const buildings=(data?.features??[]).filter(f=>f.properties?.kind==='building');
  select.innerHTML='<option value="">不指定楼宇</option>'+buildings.map(f=>`<option value="${esc(f.properties.osm)}">${esc(f.properties.name||f.properties.osm)}</option>`).join('');
  select.dataset.campus=campus;select.value=prior;select.disabled=!buildings.length;
}

function syncDuration() {
  const temp = form.elements.duration.value === 'temporary';
  $$('[data-temp-only]', form).forEach((el) => (el.hidden = !temp));
  if (temp && !form.elements.expiresAt.value) setExpiry('tonight');
}

function setExpiry(kind) {
  const base = new Date(form.elements.observedAt.value || Date.now());
  let end;
  if (kind === 'tonight') {
    end = new Date(base);
    end.setHours(23, 59, 0, 0);
    // 已经很晚了就顺延 24 小时
    if (end - base < 3600e3) end = new Date(base.getTime() + 24 * 3600e3);
  } else end = new Date(base.getTime() + Number(kind) * 3600e3);
  form.elements.expiresAt.value = toLocalInput(end);
}

function inBounds(loc, campus, margin = 0.004) {
  const b = st.campuses?.campuses?.[campus]?.bounds;
  if (!b || !loc) return true;
  return loc.lat >= b[0][0] - margin && loc.lat <= b[1][0] + margin && loc.lng >= b[0][1] - margin && loc.lng <= b[1][1] + margin;
}

function renderLoc() {
  const el = $('#cx-loc');
  const btn = $('#cx-pick-start');
  if (!draft.location) {
    el.textContent = '还没有选点。';
    btn.textContent = '在地图上选点';
    return;
  }
  const { lat, lng } = draft.location;
  const campus = form.elements.campus.value;
  el.innerHTML = `<span class="num">${lat.toFixed(6)}, ${lng.toFixed(6)}</span>（WGS84${draft.accuracy != null ? `，定位误差约 ${Math.round(draft.accuracy)} 米` : ''}）
    ${inBounds(draft.location, campus) ? '' : `<br><span class="cx-warn">这个点在${esc(campusName(campus))}的范围之外。如果确实在校门外附近，可以继续。</span>`}`;
  btn.textContent = '重新选点';
}

function renderPhotos() {
  $$('.cx-up-item', $('#cx-up')).forEach((n) => n.remove());
  $('.cx-up-add', $('#cx-up')).insertAdjacentHTML(
    'beforebegin',
    draft.photos
      .map(
        (ph) => `<figure class="cx-up-item${ph.state === 'error' ? ' is-err' : ''}" data-key="${ph.key}">
        <img src="${esc(ph.url)}" alt="${esc(ph.name)}">
        ${ph.state === 'done' ? '' : `<figcaption>${ph.state === 'error' ? esc(ph.error ?? '上传失败') : '上传中…'}</figcaption>`}
        <button type="button" data-remove="${ph.key}" aria-label="移除 ${esc(ph.name)}">×</button>
      </figure>`,
      )
      .join(''),
  );
}

function openAdd(preset = {}) {
  if (!$('#cx-typepick').childElementCount) renderTypePick();
  renderGate();
  const f = form.elements;
  if (preset.location) {
    draft.location = { lat: Number(preset.location.lat.toFixed(6)), lng: Number(preset.location.lng.toFixed(6)) };
    draft.accuracy = null;
  }
  if (preset.campus) f.campus.value = preset.campus;
  else if (!draft.id && !draft.location) f.campus.value = st.campus;
  if (preset.title && !f.title.value) f.title.value = preset.title;
  if (!f.observedAt.value) f.observedAt.value = toLocalInput(new Date());
  if (!f.photoCredit.value && st.user) f.photoCredit.value = st.user.name ?? st.user.username ?? '';
  syncDuration();
  syncActivityFields();
  renderLoc();
  $('#cx-add').showModal();
}

function resetDraft() {
  draft.photos.forEach((ph) => URL.revokeObjectURL(ph.url));
  Object.assign(draft, { id: null, rev: null, location: null, accuracy: null, photos: [] });
  form.reset();
  form.hidden = false;
  $('#cx-done').hidden = true;
  $('#cx-err').hidden = true;
  renderPhotos();
  openAdd();
}

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-add-place]')) openAdd();
});

form.addEventListener('change', (e) => {
  if (e.target.name === 'duration') syncDuration();
  if (e.target.name === 'campus') {renderLoc();syncActivityFields();}
  if (e.target.name === 'placeType') syncActivityFields();
});

$('.cx-quick', form).addEventListener('click', (e) => {
  const b = e.target.closest('[data-expire]');
  if (b) setExpiry(b.dataset.expire);
});

$('#cx-files').addEventListener('change', (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  for (const file of files) {
    if (draft.photos.length >= 10) {
      toast('最多 10 张照片。');
      break;
    }
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
      toast(`${file.name} 不是 JPG、PNG 或 WebP。`);
      continue;
    }
    if (file.size > 25 * 1048576) {
      toast(`${file.name} 超过了 25 MB。`);
      continue;
    }
    const ph = { key: Math.random().toString(36).slice(2), name: file.name, url: URL.createObjectURL(file), state: 'uploading', id: null };
    draft.photos.push(ph);
    hubApi
      .upload(file)
      .then((r) => Object.assign(ph, { id: r.id, state: 'done' }))
      .catch((err) => Object.assign(ph, { state: 'error', error: err.message }))
      .finally(renderPhotos);
  }
  renderPhotos();
});

$('#cx-up').addEventListener('click', (e) => {
  const b = e.target.closest('[data-remove]');
  if (!b) return;
  const ph = draft.photos.find((x) => x.key === b.dataset.remove);
  if (ph) URL.revokeObjectURL(ph.url);
  draft.photos = draft.photos.filter((x) => x !== ph);
  renderPhotos();
});

function collect() {
  const f = form.elements;
  const temp = f.duration.value === 'temporary';
  return {
    title: f.title.value.trim(),
    summary: f.summary.value.trim(),
    addressHint: f.addressHint.value.trim(),
    accessNotes: f.accessNotes.value.trim(),
    photoCredit: f.photoCredit.value.trim(),
    license: f.license.value,
    tags: f.tags.value.split(/[,，、]/).map((s) => s.trim().slice(0, 80)).filter(Boolean).slice(0, 12),
    campus: f.campus.value,
    placeType: f.placeType.value,
    duration: f.duration.value,
    ...(f.placeType.value==='event'?{
      ...(f.startsAt.value||f.endsAt.value?{startsAt:f.startsAt.value?f.startsAt.value+':00+08:00':'',endsAt:f.endsAt.value?f.endsAt.value+':00+08:00':''}:{}),
      links:f.activitySourceURL.value.trim()?{source:f.activitySourceURL.value.trim()}:{},
      registrationURL:f.registrationURL.value.trim(),reminderMinutes:Number(f.reminderMinutes.value),
      building:(()=>{const b=st.maps[f.campus.value]?.features.find(b=>b.properties?.kind==='building'&&b.properties.osm===f.eventBuilding.value);return b?{campus:f.campus.value,osm:b.properties.osm,name:b.properties.name||'',center:b.properties.center||null}:null;})(),
    }:{}),
    location: draft.location
      ? { ...draft.location, coordinateSystem: 'wgs84', ...(draft.accuracy != null ? { accuracyMeters: Math.min(10000, Math.round(draft.accuracy)) } : {}) }
      : null,
    observedAt: f.observedAt.value ? withOffset(f.observedAt.value) : '',
    expiresAt: temp && f.expiresAt.value ? withOffset(f.expiresAt.value) : '',
    uploads: draft.photos.filter((p) => p.id).map((p) => p.id),
    rightsConfirmed: f.rightsConfirmed.checked,
    publicLocationConfirmed: f.publicLocationConfirmed.checked,
  };
}

// 先在页面上把能检查的都检查了，服务端的检查仍然是最终标准
function problems(d, submit) {
  const out = [];
  if (!d.placeType) out.push('选一个分类。');
  if (!d.title) out.push('写一个名称。');
  if(d.placeType==='event'){
    if((d.startsAt||d.endsAt)&&(!d.startsAt||!d.endsAt))out.push('活动开始和结束时间需要一起填写。');
    else if(d.startsAt&&(!Number.isFinite(Date.parse(d.startsAt))||!Number.isFinite(Date.parse(d.endsAt))||Date.parse(d.endsAt)<=Date.parse(d.startsAt)))out.push('活动结束时间需要晚于开始时间。');
    if([d.startsAt,d.endsAt].some(t=>t&&Date.parse(t)>Date.now()+730*86400e3))out.push('活动时间最多填写到未来两年。');
    for(const [label,url] of [['活动原来源',d.links?.source],['报名链接',d.registrationURL]])if(url&&!activityURL(url))out.push(`${label}需要完整的 HTTP 或 HTTPS 链接。`);
  }
  if (draft.photos.some((p) => p.state === 'uploading')) out.push('等照片上传完。');
  if (!submit) return out;
  if (!d.location) out.push('在地图上选一个点。');
  if (!d.addressHint) out.push('写一句详细位置。');
  if (!d.summary) out.push('写一句介绍。');
  if (!d.uploads.length) out.push('至少加一张照片。');
  if (d.duration === 'temporary') {
    const seen = Date.parse(d.observedAt);
    const until = Date.parse(d.expiresAt);
    if (!d.observedAt) out.push('填写看到的时间。');
    else if (seen > Date.now() + 5 * 60e3) out.push('看到的时间不能晚于现在。');
    if (!d.expiresAt) out.push('填写大概待到什么时候。');
    else if (until <= Date.now()) out.push('有效期已经过了，限时发现要在过期之前提交。');
    else if (seen && (until <= seen || until - seen > 7 * 86400e3)) out.push('有效期要晚于看到的时间，而且不能超过 7 天。');
  }
  if (!d.rightsConfirmed) out.push('确认你有权分享这些照片。');
  if (!d.publicLocationConfirmed) out.push('确认这是可以公开的公共区域。');
  return out;
}

function showErr(list) {
  const el = $('#cx-err');
  el.innerHTML = list.length > 1 ? `还差几项：<ul>${list.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : esc(list[0] ?? '');
  el.hidden = !list.length;
  if (list.length) el.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
}

async function persist(submit) {
  const data = collect();
  const errs = problems(data, submit);
  showErr(errs);
  if (errs.length) return;
  const buttons = [$('#cx-save'), $('#cx-submit')];
  buttons.forEach((b) => (b.disabled = true));
  try {
    let e = draft.id ? await hubApi.save(draft.id, draft.rev, data) : await hubApi.create('place', data);
    draft.id = e.id;
    draft.rev = e.editRevision;
    if (!submit) return toast('草稿已保存，在“我的 · 我的投稿”里也能看到。');
    e = await hubApi.submit(draft.id, draft.rev);
    draft.rev = e.editRevision;
    form.hidden = true;
    $('#cx-done').hidden = false;
    $('#cx-done').innerHTML = `<div class="cx-done">
      <p class="cx-done-mark" aria-hidden="true">${glyphSVG(data.placeType)}</p>
      <h3>已提交，等维护者核对。</h3>
      <p>核对校区、坐标、照片来源之后，它会出现在地图上。审核结果会出现在“我的 · 通知”里。${data.duration === 'temporary' ? '限时发现到期之前没有审核完，就不会上图，可以再提交一条新的。' : ''}</p>
      <div class="btn-group"><a class="btn btn-outline" href="me.html#entries">查看我的投稿</a><button class="btn btn-primary" type="button" data-again>再标一个</button></div>
    </div>`;
  } catch (err) {
    showErr([err.message ?? '没有保存成功。']);
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  persist(true);
});
$('#cx-save').addEventListener('click', () => persist(false));
$('#cx-done').addEventListener('click', (e) => e.target.closest('[data-again]') && resetDraft());

// ---------- 在地图上选点 ----------

let picking = null;

function pickCoord() {
  if (!picking) return;
  const c = map.getCenter();
  const campus = form.elements.campus.value;
  $('#cx-pick-coord').textContent = `${c.lat.toFixed(6)}, ${c.lng.toFixed(6)}`;
  $('#cx-pick-hint').textContent = inBounds({ lat: c.lat, lng: c.lng }, campus) ? '尽量对准入口或者具体的位置。' : `现在在${campusName(campus)}的范围之外。`;
}

function startPick() {
  const campus = form.elements.campus.value;
  $('#cx-add').close();
  explore.classList.add('is-picking');
  $('#cx-pick').hidden = false;
  setSheet(false);
  if (campus !== st.campus) setCampus(campus, { fit: false });
  map.invalidateSize();
  if (draft.location) map.setView([draft.location.lat, draft.location.lng], 18.5, { animate: false });
  else fitCampus(false);
  // 选点时滚轮、双指和双击都以十字为中心缩放，不会把十字下面的点挪走
  map.options.scrollWheelZoom = 'center';
  map.options.touchZoom = 'center';
  map.options.doubleClickZoom = 'center';
  map.scrollWheelZoom.enable();
  picking = { accuracy: draft.accuracy, moved: false, circle: null };
  map.on('move', pickCoord);
  map.on('dragstart', markMoved);
  pickCoord();
  explore.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
  $('#cx-pick-ok').focus({ preventScroll: true });
}

function markMoved() {
  if (picking) picking.moved = true;
}

function endPick(ok) {
  if (!picking) return;
  if (ok) {
    const c = map.getCenter();
    draft.location = { lat: Number(c.lat.toFixed(6)), lng: Number(c.lng.toFixed(6)) };
    draft.accuracy = picking.moved ? null : picking.accuracy;
  }
  picking.circle?.remove();
  map.off('move', pickCoord);
  map.off('dragstart', markMoved);
  map.options.scrollWheelZoom = true;
  map.options.touchZoom = true;
  map.options.doubleClickZoom = true;
  picking = null;
  explore.classList.remove('is-picking');
  $('#cx-pick').hidden = true;
  map.invalidateSize();
  renderLoc();
  $('#cx-add').showModal();
}

$('#cx-pick-start').addEventListener('click', startPick);
$('#cx-pick-ok').addEventListener('click', () => endPick(true));
$('#cx-pick-cancel').addEventListener('click', () => endPick(false));
$('#cx-pick-geo').addEventListener('click', (e) => {
  const btn = e.currentTarget;
  if (!navigator.geolocation) return toast('这个浏览器不支持定位，请直接拖动地图。');
  btn.disabled = true;
  btn.textContent = '正在定位…';
  // 只读取一次，用来挪地图；不会持续定位，也不会单独上传
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      btn.disabled = false;
      btn.textContent = '用我现在的位置';
      if (!picking) return;
      const { latitude, longitude, accuracy } = pos.coords;
      map.setView([latitude, longitude], 18.5, { animate: !reducedMotion() });
      picking.circle?.remove();
      picking.circle = L.circle([latitude, longitude], { radius: accuracy, className: 'cx-acc', interactive: false }).addTo(map);
      picking.accuracy = accuracy;
      picking.moved = false;
      if (accuracy > 30) toast(`定位误差大约 ${Math.round(accuracy)} 米，请再拖动地图对准。`);
    },
    (err) => {
      btn.disabled = false;
      btn.textContent = '用我现在的位置';
      toast(err.code === 1 ? '没有定位权限。直接拖动地图选点也可以。' : '没有拿到位置，请直接拖动地图选点。');
    },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 },
  );
});

// ---------- 维护者：审核地点 ----------

async function loadPending() {
  const r = await hubApi.moderation();
  st.pending = (r.entries ?? []).filter((e) => e.kind === 'place');
  $('#cx-mod-n').textContent = st.pending.length;
  $('#cx-mod-btn').hidden = false;
}

function reviewHTML(e) {
  const d = e.draft ?? {};
  const loc = d.location;
  const temp = d.duration === 'temporary';
  return `<article class="cx-rv card" data-entry="${esc(e.id)}">
    <div class="cx-tags">
      <span class="tag">${esc(campusName(d.campus))}</span>
      <span class="tag cx-type-tag" style="--h:${PLACE_TYPES[d.placeType]?.hue ?? 0}">${glyphSVG(d.placeType)}${esc(typeName(d.placeType))}</span>
      ${temp ? `<span class="tag tag-warn">限时 · ${esc(timeLeft(d.expiresAt))}</span>` : '<span class="tag">长期</span>'}
      ${e.owner ? `<span class="muted">@${esc(e.owner.username)}</span>` : ''}
    </div>
    <h3>${esc(d.title ?? '未命名')}</h3>
    ${d.summary ? `<p>${esc(d.summary)}</p>` : ''}
    <dl class="cx-facts">
      ${fact('详细位置', d.addressHint)}
      ${loc ? fact('坐标', `${loc.lat}, ${loc.lng}（WGS84${loc.accuracyMeters != null ? `，误差约 ${Math.round(loc.accuracyMeters)} 米` : ''}）`) : fact('坐标', '没有选点')}
      ${loc && !inBounds(loc, d.campus) ? '<div><dt>注意</dt><dd class="cx-warn">坐标在所选校区的范围之外</dd></div>' : ''}
      ${fact('开放和通行', d.accessNotes)}
      ${d.observedAt ? fact('看到的时间', fmtTime(d.observedAt)) : ''}
      ${temp && d.expiresAt ? fact('大概待到', fmtTime(d.expiresAt)) : ''}
      ${d.placeType==='event'&&d.startsAt?fact('活动起止（北京时间）',`${activityTime(d.startsAt)} → ${activityTime(d.endsAt)}`):''}
      ${d.placeType==='event'?fact('日程楼宇',d.building?`${d.building.name||d.building.osm} · ${campusName(d.building.campus)}`:'未指定，不从坐标或教室号推测'):''}
      ${d.placeType==='event'?fact('本地提醒',d.reminderMinutes?`提前 ${d.reminderMinutes} 分钟`:'不提醒'):''}
      ${d.placeType==='event'&&activityURL(d.links?.source)?`<div><dt>活动原来源</dt><dd><a href="${esc(activityURL(d.links.source))}" target="_blank" rel="noopener noreferrer">核对原来源 ↗</a></dd></div>`:''}
      ${d.placeType==='event'&&activityURL(d.registrationURL)?`<div><dt>报名</dt><dd><a href="${esc(activityURL(d.registrationURL))}" target="_blank" rel="noopener noreferrer">核对报名入口 ↗</a></dd></div>`:''}
      ${fact('照片', `${d.photoCredit || '未署名'} · ${d.license || '未选许可'}`)}
    </dl>
    ${d.uploads?.length ? `<div class="cx-rv-photos">${d.uploads.map((u) => `<a href="/api/hub/uploads/${esc(u)}/photo" target="_blank" rel="noopener"><img src="/api/hub/uploads/${esc(u)}/photo" alt="投稿照片" loading="lazy"></a>`).join('')}</div>` : '<p class="cx-warn">没有照片。</p>'}
    ${loc ? '<button class="btn btn-secondary btn-sm" type="button" data-rv="preview">在地图上看位置</button>' : ''}
    <fieldset class="cx-rv-checks">
      <legend>核对（三项都确认后才能通过）</legend>
      <label class="cx-check"><input type="checkbox" data-check> 校区和坐标对得上，详细位置说得清楚</label>
      <label class="cx-check"><input type="checkbox" data-check> 是公共区域，不会暴露某个人的行踪</label>
      <label class="cx-check"><input type="checkbox" data-check> 照片来源可信，没有能认出来的人脸</label>
    </fieldset>
    <label class="cx-field"><span>审核意见</span><textarea rows="2" maxlength="3000" data-note placeholder="通过时写核对了什么；退回时写清楚要改哪里"></textarea></label>
    <p class="cx-err" hidden></p>
    <div class="cx-form-actions">
      <button class="btn btn-outline" type="button" data-rv="reject">退回修改</button>
      <button class="btn btn-primary" type="button" data-rv="approve" disabled>核对通过，上图</button>
    </div>
  </article>`;
}

function renderReview() {
  $('#cx-review-body').innerHTML = st.pending.length
    ? `<p class="cx-hint">核对的是这条记录（校区、坐标、公共区域、照片来源），不代表你到现场确认过它还在。</p>${st.pending.map(reviewHTML).join('')}`
    : '<div class="cx-empty"><p class="cx-empty-title">没有待审核的地点。</p></div>';
}

async function openReview() {
  $('#cx-review').showModal();
  $('#cx-review-body').innerHTML = '<p class="muted">正在载入…</p>';
  try {
    await loadPending();
    renderReview();
  } catch (e) {
    $('#cx-review-body').innerHTML = `<p class="cx-err">${esc(e.message)}</p>`;
  }
}

$('#cx-mod-btn').addEventListener('click', openReview);

$('#cx-review-body').addEventListener('input', (e) => {
  const card = e.target.closest('.cx-rv');
  if (!card) return;
  const checked = $$('[data-check]', card).every((c) => c.checked);
  $('[data-rv="approve"]', card).disabled = !(checked && $('[data-note]', card).value.trim());
});

$('#cx-review-body').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-rv]');
  if (!b || b.disabled) return;
  const card = b.closest('.cx-rv');
  const entry = st.pending.find((x) => x.id === card.dataset.entry);
  if (!entry) return;
  if (b.dataset.rv === 'preview') {
    const loc = entry.draft.location;
    $('#cx-review').close();
    previewLayer.clearLayers();
    L.marker([loc.lat, loc.lng], {
      icon: L.divIcon({ className: 'cx-pin-wrap', html: '<span class="cx-pin is-preview"><i></i></span>', iconSize: [36, 44], iconAnchor: [18, 42] }),
      interactive: false,
    }).addTo(previewLayer);
    if (entry.draft.campus !== st.campus) setCampus(entry.draft.campus, { fit: false });
    $('#cx-preview-bar').hidden = false;
    explore.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
    focusOn([loc.lat, loc.lng], 18.5);
    return;
  }
  const note = $('[data-note]', card).value.trim();
  const err = $('.cx-err', card);
  if (!note) {
    err.textContent = b.dataset.rv === 'reject' ? '退回时请写清楚要改哪里。' : '写一句审核意见。';
    err.hidden = false;
    return;
  }
  b.disabled = true;
  try {
    if (b.dataset.rv === 'approve') await hubApi.review(entry.id, entry.editRevision, 'approve', note, { locationChecked: true });
    else await hubApi.review(entry.id, entry.editRevision, 'reject', note);
    st.pending = st.pending.filter((x) => x !== entry);
    $('#cx-mod-n').textContent = st.pending.length;
    renderReview();
    toast(b.dataset.rv === 'approve' ? '已核对通过，正在刷新地图。' : '已退回，投稿人会收到你的意见。');
    if (b.dataset.rv === 'approve') loadPlaces({ quiet: true });
  } catch (ex) {
    err.textContent = ex.message ?? '操作没有成功。';
    err.hidden = false;
    b.disabled = false;
  }
});

$('#cx-preview-back').addEventListener('click', () => {
  previewLayer.clearLayers();
  $('#cx-preview-bar').hidden = true;
  $('#cx-review').showModal();
});

$$('dialog').forEach((d) => d.addEventListener('click', (e) => (e.target === d || e.target.closest('[data-close]')) && d.close()));

// Codex 的重绘插画：清单里标了 review: "approved" 的才用，没有就继续用 OSM 矢量插画
async function loadArt() {
  try {
    const r = await fetch('art/campus-map/manifest.json', { cache: 'no-cache' });
    if (!r.ok) return;
    const m = await r.json();
    for (const [campus, a] of Object.entries(m.campuses ?? {})) {
      const ok = a?.review === 'approved' && typeof a.image === 'string' && /^art\/campus-map\/[\w.-]+\.(webp|png|jpg)$/.test(a.image) && Array.isArray(a.bounds);
      if (ok) st.art[campus] = { image: a.image, bounds: a.bounds };
    }
  } catch { /* 还没有交付 */ }
}

// ---------- 启动 ----------

async function init() {
  try{const snapshot=await readyMe();st.me=snapshot.data;planCorrupt=Boolean(snapshot.corrupt);}catch(error){planReadError=error;}
  if(planReadError)toast(planReadError.message);
  if(planCorrupt)toast('本地计划需要修复，原内容已保留；校园地图仍可查看。');
  if(routeEnabled)st.tab='route';
  const accountReady = hubState();
  $('#cx-q').value = st.q;
  $$('#cx-campus [data-campus]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.campus === st.campus)));
  renderThemes();
  renderBody();
  observeReveal();
  observeLive();
  syncPeek();

  try {
    const r = await fetch('data/campuses.json', { cache: 'no-cache' });
    if (r.ok) st.campuses = await r.json();
  } catch { /* 下面按北京北部的大致范围显示 */ }
  initMap();
  const artReady = loadArt().then(() => cm.setArt(st.art[st.campus] ?? null));
  await loadCampusMap(st.campus);
  void artReady;
  fitCampus(false);

  const s = await accountReady;
  st.online = s.online;
  st.user = s.user;
  if (st.user?.moderator) loadPending().catch(() => {});
  await loadPlaces();

  // 分享链接：?place=<id>。默认列表里没有，就连同过期记录再找一次
  const wanted = params.get('place');
  if (wanted && st.state === 'ready') {
    if (!find(wanted) && !st.expired) {
      st.expired = true;
      $('#cx-expired').checked = true;
      await loadPlaces();
    }
    if (find(wanted)) {
      explore.scrollIntoView({ block: 'start' });
      select(wanted);
    } else toast('这个地点不存在、已经撤回，或者还在审核中。');
  } else if (st.building && cm.building(st.building)) {
    explore.scrollIntoView({ block: 'start' });
    selectBuilding(st.building);
  }
  if(params.get('building')&&!cm.building(params.get('building')))toast('这栋楼不在当前校区已核对的地图目录中，请核对链接或切换校区。');
  // 顶栏“＋发布 → 标一个地点”直达投稿
  if (params.get('add') === 'place') openAdd();
}

init().catch(error=>toast(`校园地图暂时无法载入：${error.message}`));
setInterval(()=>{$$('[data-class-countdown]').forEach(el=>el.textContent=classCountdown());},30000);

// Cache only the public campus shell; personal plans stay in IndexedDB.
if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['127.0.0.1','localhost','[::1]'].includes(location.hostname))) {
  navigator.serviceWorker.register('campus-worker.js', { updateViaCache: 'none' }).catch(() => {
    toast('离线页面缓存未启用；课程仍仅存在此设备，可从课表与日程中导出。');
  });
}

explore.addEventListener('click',async e=>{const button=e.target.closest('[data-name-vote]');if(!button)return;button.disabled=true;try{await voteBuildingName(button.dataset.nameOsm,button.dataset.nameVote);}catch(error){toast(error.message);}finally{button.disabled=false;}});
