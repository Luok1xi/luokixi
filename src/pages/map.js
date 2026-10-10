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
import { hubApi, hubState, loginURL } from '../js/hub.js';
import { PLACE_TYPES, glyphSVG, fmtTime, timeLeft, toLocalInput, withOffset } from '../js/places.js';
import { campusServiceHTML, campusServiceButtons } from '../js/campus-services.js';
import { mapIcon } from '../js/map-icons.js';
import { BUILDING_USE, createCampusMap, pointInFeature, buildingModelSVG } from '../js/campus-map.js';
import { DAYS, classesOn, courseSuggestions, importMe, loadMe, newId, quests, saveMe, todayIndex, toggleVisited, visitedSet } from '../js/quests.js';
import { esc } from '../js/data.js';
import '../styles/community.css';
import '../styles/map.css';
import '../styles/atlas.css';
import { toast } from '../js/fx.js';

initShell();

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const ORDER = Object.keys(PLACE_TYPES);
const CAMPUS_SHORT = { xueyuanlu: '学院路', shahe: '沙河' };
const safeURL = (u) => (typeof u === 'string' && /^https:\/\//.test(u) ? u : null);
const mobile = matchMedia('(max-width: 760px)');
const params = new URLSearchParams(location.search);
const REPORTS_KEY = 'luokixi.map.reports';

const me0 = loadMe();
const st = {
  online: false,
  user: null,
  me: me0,
  campus: CAMPUS_SHORT[params.get('campus')] ? params.get('campus') : CAMPUS_SHORT[me0.profile.campus] ? me0.profile.campus : 'xueyuanlu',
  tab: ['quests', 'places', 'buildings'].includes(params.get('tab')) ? params.get('tab') : 'buildings',
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
  building: params.get('b'), // OSM 楼，例如 way/123
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

// 统一用顶栏下方的胶囊提示（src/js/toast.js）

// 收藏、关注、反馈、投稿都要：服务在线 + 已登录 + 邮箱已验证
function blocked(action) {
  if (!st.online) return toast(`社区服务没有连接，暂时不能${action}。`), true;
  if (!st.user) return toast(`登录之后才能${action}。`, { href: loginURL(), label: '去登录' }), true;
  if (!st.user.emailVerified) return toast(`验证邮箱之后才能${action}。`, { href: 'me.html#account', label: '去验证' }), true;
  return false;
}

// ---------- 同学标注的数据 ----------

const norm = (s) => String(s ?? '').toLowerCase();
const terms = () => norm(st.q).split(/\s+/).filter(Boolean);
function matches(f) {
  const d = f.properties.data;
  const hay = norm([d.title, d.summary, d.addressHint, d.accessNotes, ...(d.tags ?? []), typeName(f.properties.placeType)].join(' '));
  return terms().every((t) => hay.includes(t));
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

function initMap() {
  const c = st.campuses?.campuses?.[st.campus];
  map = L.map('cx-map', {
    zoomControl: false,
    scrollWheelZoom: true,
    minZoom: 14,
    maxZoom: 20,
    zoomSnap: 0.5,
    // 校区范围文件没有加载出来时，先看北京北部（两个校区都在这一片）
    center: c?.center ?? [40.07, 116.3],
    zoom: c ? 16.5 : 12,
  });
  map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
  map.attributionControl.addAttribution('楼、路、校门 © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap 贡献者</a>（ODbL）');
  L.control.zoom({ position: 'bottomright', zoomInTitle: '放大', zoomOutTitle: '缩小' }).addTo(map);
  map.createPane('cx-quest').style.zIndex = '595';
  cm = createCampusMap(map, {
    onBuilding: (f) => (bpick ? bpick(f) : openBuildingPop(f)),
  });
  pinLayer.addTo(map);
  questLayer.addTo(map);
  previewLayer.addTo(map);

  // 页面能上下滚动，滚轮默认不缩放地图；点一下地图以后才接管滚轮
  const el = $('#cx-map');
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
      st.maps[campus] = await r.json();
      st.mapError = '';
    } catch (e) {
      st.mapError = `${campusName(campus)}的楼宇数据没有加载出来（${e.message}）。`;
      st.maps[campus] = null;
    }
  }
  if (campus !== st.campus) return;
  cm.load(st.maps[campus]);
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
    return { left: 0, bottom: Math.min(h, m.height * 0.8) };
  }
  if (explore.classList.contains('is-picking')) return { left: 0, bottom: 0 };
  return { left: Math.max(0, panel.getBoundingClientRect().right - m.left), bottom: 0 };
}

function viewPad() {
  const c = covered();
  return { paddingTopLeft: [c.left + 24, 24], paddingBottomRight: [24, c.bottom + 24] };
}

function fitCampus(animate = !reducedMotion()) {
  const data = st.maps[st.campus];
  const b = data ? L.geoJSON(data.boundary).getBounds() : st.campuses?.campuses?.[st.campus]?.bounds;
  if (!map || !b) return;
  map.fitBounds(b, { ...viewPad(), maxZoom: 17.5, animate });
}

function focusOn(latlng, zoom = Math.max(map.getZoom(), 17.5)) {
  const pad = viewPad();
  // 把目标点放到“没被面板盖住的那块区域”的中央
  const dx = (pad.paddingTopLeft[0] - pad.paddingBottomRight[0]) / 2;
  const dy = (pad.paddingTopLeft[1] - pad.paddingBottomRight[1]) / 2;
  const target = map.unproject(map.project(latlng, zoom).subtract([dx, dy]), zoom);
  if (reducedMotion()) map.setView(target, zoom, { animate: false });
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
function drawToday() {
  questLayer.clearLayers();
  if (!cm?.data) return;
  const today = classesOn(st.me, todayIndex()).filter((x) => x.course.building?.campus === st.campus && x.status !== 'done');
  const pts = [];
  today.forEach((x, i) => {
    const b = cm.building(x.course.building.osm);
    if (!b) return;
    const ll = centerOf(b);
    pts.push(ll);
    L.marker(ll, {
      pane: 'cx-quest',
      keyboard: false,
      icon: L.divIcon({ className: 'cx-pin-wrap', html: `<span class="cx-cls is-${x.status}" title="${esc(`${x.slot.start} ${x.course.name}`)}"><b>${i + 1}</b><em>${esc(x.slot.start)} ${esc(x.course.name.slice(0, 8))}</em></span>`, iconSize: [28, 28], iconAnchor: [14, 14] }),
    })
      .on('click', () => selectBuilding(b.properties.osm))
      .addTo(questLayer);
  });
  if (pts.length > 1) L.polyline(pts, { className: 'cx-route', interactive: false }).addTo(questLayer);
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
  bits.push(st.art[st.campus] ? '插画按卫星截图和 OpenStreetMap 轮廓重绘，是概念插画，不是实拍' : '插画按 OpenStreetMap 的真实轮廓绘制，颜色表示用途');
  if (data && data.counts.building < 20) bits.push(`${campusName(st.campus)}在 OpenStreetMap 上只画了 ${data.counts.building} 栋楼，地图会随着补充变完整`);
  if (questLayer.getLayers().length > 1) bits.push('金色数字是今天的上课顺序，虚线不是步行路线');
  el.innerHTML = bits.map(esc).join(' · ');
  el.hidden = !bits.length;
}

// ---------- 手机上的底部面板 ----------

const peek = () => $('.cx-panel-head', panel).offsetHeight + 26;

function setSheet(open) {
  if (!mobile.matches) return;
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
  const day = todayIndex();
  const list = classesOn(st.me, day);
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
  return `<section class="cx-q"><div class="cx-q-head"><h3>今天 · ${DAYS[day - 1]}</h3>${st.me.courses.length ? '<button class="btn-link" type="button" data-act="me">课表</button>' : ''}</div>${body}</section>`;
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
  const list = classesOn(st.me, todayIndex(now), now);
  const current = list.find((x) => x.status === 'now');
  const next = list.find((x) => x.status === 'next');
  const mins = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const want = st.study.hours * 60;
  let free = Infinity;
  let line;
  let from = null;
  let fromLabel = '';
  if (!st.me.courses.length) line = '还没有课表，按现在就能去算。填了课表，这里会算出你到下一节课之前有多久。';
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
  } else line = '今天的课都上完了。';
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
  return `${servicesHTML()}${sparse ? `<p class="notice"><span class="notice-dot" aria-hidden="true"></span><span><strong>${esc(campusName(st.campus))}的楼还没画全。</strong>OpenStreetMap 上目前只有 ${all.length} 栋楼。可以在 OpenStreetMap 上补画，本站更新数据后就会出现在这里。</span></p>` : ''}
    <p class="cx-count">${named.length} 栋有名字${all.length > named.length ? `，另有 ${all.length - named.length} 栋还没有名字（地图上能点，卡片里没有名称）` : ''}</p>
    ${groups
      .map(([use, list]) => `<h3 class="cx-group-h"><i class="cm-swatch cm-sw-${use}" aria-hidden="true"></i>${BUILDING_USE[use].name}</h3>
        <ul class="cx-list" role="list">${list
          .map((b) => `<li><button class="cx-row cx-brow" type="button" data-osm="${esc(b.properties.osm)}"><span class="cx-row-main"><span class="cx-row-title">${esc(b.properties.name)}</span>
            <span class="cx-row-sub">${b.properties.levels ? `${b.properties.levels} 层` : '层数未知'}</span></span>${visited.has(b.properties.osm) ? '<span class="tag tag-ok">到过</span>' : ''}</button></li>`)
          .join('')}</ul>`)
      .join('')}`;
}

// ---------- 渲染：搜索 ----------

function searchHTML() {
  const t = terms();
  const bs = (cm?.buildings() ?? []).filter((b) => b.properties.name && t.every((x) => norm(b.properties.name).includes(x))).slice(0, 12);
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

function baiduMarker(lat, lng, title, content = '') {
  // 和服务端地点导航用同一种百度官方调起链接，明确声明坐标是 WGS84
  return `https://api.map.baidu.com/marker?${new URLSearchParams({ location: `${lat},${lng}`, title, content, coord_type: 'wgs84', output: 'html', src: 'webapp.luokixi.campus' })}`;
}

function buildingHTML(b) {
  const p = b.properties;
  const use = BUILDING_USE[p.use];
  const visited = visitedSet(st.me, st.campus).has(p.osm);
  const courses = st.me.courses.filter((c) => c.building?.osm === p.osm);
  const inside = inCampus().filter((f) => pointInFeature(f.geometry.coordinates, b));
  const [lat, lng] = centerOf(b);
  return `<article class="bc cm-tone-${p.use}" aria-labelledby="bc-title">
    <button class="cx-back" type="button" data-act="back"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14.5 5.5-6.5 6.5 6.5 6.5"/></svg>返回</button>
    <p class="bc-eyebrow">${esc(campusName(st.campus))} · ${esc(use.name)}</p>
    <h2 class="bc-title" id="bc-title" tabindex="-1">${esc(p.name || '一栋还没有名字的楼')}</h2>
    ${campusServiceHTML(p.use, st.campus)}
    <figure class="bc-hero">${buildingModelSVG(b)}
      <figcaption>按 OpenStreetMap 的轮廓${p.levels ? `和 ${p.levels} 层` : '绘制；层数未知，按 3 层示意'}${p.levels ? '绘制' : ''}</figcaption></figure>
    <p class="bc-lead">${inside.length ? `同学在这里标了 ${inside.length} 个地点。` : '还没有同学为这栋楼写介绍。去过的话，拍张照标一个地点吧。'}</p>
    <div class="bc-cta">
      <button class="btn ${visited ? 'btn-secondary' : 'btn-primary'}" type="button" data-act="visit" aria-pressed="${visited}">${visited ? '✓ 到过这里' : '我到过这里'}</button>
      <a class="btn btn-outline" href="${esc(baiduMarker(lat.toFixed(6), lng.toFixed(6), p.name || '矿大校园内的楼', `${campusName(st.campus)}`))}" target="_blank" rel="noopener noreferrer">在百度地图中查看位置</a>
    </div>
    <p class="cx-hint">这栋楼的入口还没有核对，打开的是楼的中心点，不是可以直接导航过去的入口。</p>
    <dl class="bc-rows">
      <div><dt>你的课</dt><dd>${courses.length
        ? `<ul role="list">${courses.map((c) => `<li><b>${esc(c.name)}</b>${c.room ? ` · ${esc(c.room)}` : ''}<span>${c.slots.map((s) => `${DAYS[s.day - 1]} ${s.start}`).join('、')}</span></li>`).join('')}</ul>`
        : `<button class="btn-link" type="button" data-act="course-here">把一门课放在这里</button>`}</dd></div>
      <div><dt>同学标注</dt><dd>${inside.length
        ? `<ul role="list">${inside.map((f) => `<li><button class="btn-link" type="button" data-id="${esc(f.id)}">${esc(f.properties.data.title)}</button></li>`).join('')}</ul>`
        : `<button class="btn-link" type="button" data-act="add-here">在这栋楼标一个地点</button>`}</dd></div>
      <div><dt>楼层</dt><dd>${p.levels ? `${p.levels} 层` : '未知'}</dd></div>
      <div><dt>数据</dt><dd><a href="https://www.openstreetmap.org/${esc(p.osm)}" target="_blank" rel="noopener">在 OpenStreetMap 上查看或修正</a></dd></div>
    </dl>
    <p class="cx-hint">“到过这里”只保存在这个浏览器里，本站不读取你的位置。</p>
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

function detailHTML(f) {
  const p = f.properties;
  const d = p.data;
  const temp = d.duration === 'temporary';
  const nav = !p.expired && safeURL(p.navigation?.url);
  const photos = p.photos ?? [];
  const watching = (p.watch ?? []).includes('revision');
  return `<article class="cx-detail" style="--h:${PLACE_TYPES[p.placeType].hue}" aria-labelledby="cx-detail-title">
    <button class="cx-back" type="button" data-act="back"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14.5 5.5-6.5 6.5 6.5 6.5"/></svg>返回</button>
    ${photos.length ? `<div class="cx-photos${photos.length > 1 ? ' is-multi' : ''}">${photos.map((ph, i) => `<img src="${esc(ph.previewUrl)}" alt="${esc(d.title)}，第 ${i + 1} 张照片" loading="lazy" decoding="async">`).join('')}</div>` : `<div class="cx-photo-empty">${glyphSVG(p.placeType)}</div>`}
    ${d.photoCredit || d.license ? `<p class="cx-credit">照片 ${esc(d.photoCredit || '')}${d.license ? ` · ${esc(d.license)}` : ''}</p>` : ''}
    <p class="bc-eyebrow">${esc(CAMPUS_SHORT[p.campus] ?? '')} · ${esc(typeName(p.placeType))}${p.expired ? ' · 已过期' : temp ? ` · 限时 · ${esc(timeLeft(d.expiresAt))}` : ''}</p>
    <h2 class="bc-title" id="cx-detail-title" tabindex="-1">${esc(d.title)}</h2>
    ${d.summary ? `<p class="bc-lead">${esc(d.summary)}</p>` : ''}
    <div class="bc-cta">
      ${nav ? `<a class="btn btn-primary" href="${esc(nav)}" target="_blank" rel="noopener noreferrer">${esc(p.navigation.label || '在地图中查看并导航')}</a>` : `<p class="cx-nonav">${p.expired ? '已经过期，不再提供前往导航。' : '暂时没有导航链接。'}</p>`}
    </div>
    ${nav && p.navigation.notice ? `<p class="cx-hint">${esc(p.navigation.notice)}</p>` : ''}
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
  // 正在输入时，后台刷新不要把输入框冲掉
  if (body.contains(document.activeElement) && /^(TEXTAREA|INPUT)$/.test(document.activeElement.tagName)) return;
  const v = view();
  const html = {
    search: searchHTML,
    place: () => detailHTML(find(st.selected)),
    building: () => buildingHTML(cm.building(st.building)),
    quests: questsHTML,
    places: placesHTML,
    buildings: buildingsHTML,
  }[v]();
  body.innerHTML = html;
  body.dataset.view = v;
  panel.classList.toggle('is-detail', v === 'place' || v === 'building');
  $$('#cx-tabs [data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === st.tab && !['place', 'building', 'search'].includes(v))));
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
  if (st.campus !== 'xueyuanlu') q.set('campus', st.campus);
  if (st.tab !== 'quests') q.set('tab', st.tab);
  if (st.type !== 'all') q.set('type', st.type);
  if (st.selected) q.set('place', st.selected);
  else if (st.building) q.set('b', st.building);
  const qs = q.toString();
  history.replaceState(null, '', `${location.pathname}${qs ? `?${qs}` : ''}${location.hash}`);
}

// ---------- 交互 ----------

// 返回楼宇数据加载完成的 Promise，需要接着选楼的地方可以等它
function setCampus(c, { fit = true } = {}) {
  if (!CAMPUS_SHORT[c] || c === st.campus) return Promise.resolve();
  st.campus = c;
  $$('#cx-campus [data-campus]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.campus === c)));
  if (st.selected && find(st.selected)?.properties.campus !== c) st.selected = null;
  st.building = null;
  st.openQuest = null;
  renderAll();
  syncURL();
  return loadCampusMap(c).then(() => fit && fitCampus());
}

function setTab(t) {
  st.tab = t;
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
  $('#cx-body').scrollTop = 0;
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
  const today = classesOn(st.me, todayIndex()).filter((x) => x.course.building?.osm === p.osm);
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
      <a href="${esc(baiduMarker(lat.toFixed(6), lng.toFixed(6), p.name || '矿大校园内的楼', campusName(st.campus)))}" target="_blank" rel="noopener noreferrer">导航 ↗</a>
      <button type="button" data-pop="visit" aria-pressed="${visited}">${visited ? '✓ 到过' : '我到过'}</button>
      <button type="button" data-pop="course">放一门课</button>
    </div>
  </div>`;
}

function openBuildingPop(f) {
  const osm = f.properties.osm;
  if (!svc.loaded) loadServices().then(() => pop?.isOpen() && pop.setContent(buildingPopHTML(f)));
  cm.select(osm);
  pop?.remove();
  pop = L.popup({ className: 'mp-popup', maxWidth: 320, minWidth: 260, autoPanPaddingTopLeft: [mobile.matches ? 16 : 420, 120], autoPanPaddingBottomRight: [24, 24], offset: [0, -4] })
    .setLatLng(centerOf(f))
    .setContent(buildingPopHTML(f))
    .openOn(map);
  pop.once('remove', () => {
    if (st.building !== osm) cm.select(st.building);
    pop = null;
  });
}

// 小窗里的按钮
document.addEventListener('click', (e) => {
  const b = e.target.closest('.mp-pop [data-pop]');
  if (!b) return;
  const osm = b.closest('.mp-pop').dataset.osm;
  const f = cm.building(osm);
  if (!f) return;
  if (b.dataset.pop === 'detail') {
    map.closePopup();
    selectBuilding(osm);
  } else if (b.dataset.pop === 'visit') {
    const on = toggleVisited(st.me, st.campus, osm);
    saveAndRender();
    toast(on ? '点亮了这栋楼。' : '已取消“到过”。');
    pop?.setContent(buildingPopHTML(f));
  } else if (b.dataset.pop === 'course') {
    map.closePopup();
    openMe({ building: f });
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
  $('#cx-body').scrollTop = 0;
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
  qTimer = setTimeout(() => {
    st.q = e.target.value;
    renderBody();
  }, 160);
});

$('#cx-expired').addEventListener('change', (e) => {
  st.expired = e.target.checked;
  loadPlaces();
});

function saveAndRender() {
  if (!saveMe(st.me)) toast('这个浏览器不能保存数据（可能是隐私模式），刷新后会丢失。');
  renderMarks();
  renderBody();
}

async function act(btn) {
  const a = btn.dataset.act;
  if (a === 'back') return back();
  if (a === 'refresh') return loadPlaces();
  if (a === 'me') return openMe();
  if (a === 'visit' && st.building) {
    const before = currentQuests().filter((q) => q.total && q.done === q.total).map((q) => q.id);
    const on = toggleVisited(st.me, st.campus, st.building);
    saveAndRender();
    const finished = currentQuests().find((q) => q.total && q.done === q.total && !before.includes(q.id));
    return toast(finished ? `任务完成：${finished.title}。` : on ? '点亮了这栋楼。' : '已取消“到过”。');
  }
  if (a === 'course-here' && st.building) return openMe({ building: cm.building(st.building) });
  if (a === 'add-here' && st.building) {
    const b = cm.building(st.building);
    const [lng, lat] = b.properties.center;
    return openAdd({ location: { lat, lng }, campus: st.campus, title: b.properties.name ? `${b.properties.name}` : '' });
  }
  const f = st.selected && find(st.selected);
  const p = f?.properties;
  if (!p) return;
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

$('#cx-body').addEventListener('click', async (e) => {
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

$('#cx-body').addEventListener('submit', async (e) => {
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
  else if ((st.selected || st.building) && $('#cx-body').contains(document.activeElement)) back();
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
  const prefs = st.user?.preferences ?? {};
  f.faculty.value = p.faculty || prefs.faculty || '';
  f.major.value = p.major || st.user?.major || '';
  f.year.value = p.year || prefs.year || '';
  f.campus.value = p.campus || st.campus;
  $('#cx-sync-wrap').hidden = !(st.online && st.user);
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
  st.me.profile = { faculty: f.faculty.value.trim(), major: f.major.value.trim(), year, campus: f.campus.value };
  saveAndRender();
  if (f.sync.checked && st.user) {
    try {
      const prefs = { ...(st.user.preferences ?? {}), faculty: st.me.profile.faculty, year, campus: CAMPUS_SHORT[st.me.profile.campus] ?? '' };
      const r = await hubApi.updateProfile({ major: st.me.profile.major, preferences: prefs });
      if (r?.user) st.user = r.user;
      return toast('已保存，也存到了你的账号里。');
    } catch (err) {
      return toast(`本机已保存；存到账号没有成功：${err.message}`);
    }
  }
  toast('已保存在这个浏览器里。');
});

$('#cx-slot-add').addEventListener('click', () => $('#cx-slots').insertAdjacentHTML('beforeend', slotRow()));
$('#cx-slots').addEventListener('click', (e) => {
  if (e.target.closest('[data-slot-x]') && $$('.cx-slot').length > 1) e.target.closest('.cx-slot').remove();
});
$('#cx-building-select').addEventListener('change', (e) => setCourseBuilding(cm.building(e.target.value)));

courseForm.addEventListener('submit', (e) => {
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
  st.me.courses.push({ id: newId(), name, courseId: '', room: courseForm.elements.room.value.trim(), building: courseBuilding, slots });
  if (!st.me.profile.campus) st.me.profile.campus = courseBuilding.campus;
  saveAndRender();
  renderCourses();
  courseForm.reset();
  setCourseBuilding(null);
  $('#cx-slots').innerHTML = slotRow();
  toast(`已添加《${name}》。`);
});

$('#cx-courses').addEventListener('click', (e) => {
  const li = e.target.closest('[data-course]');
  if (!li || !e.target.closest('[data-course-x]')) return;
  st.me.courses = st.me.courses.filter((c) => c.id !== li.dataset.course);
  saveAndRender();
  renderCourses();
});

$('#cx-me-export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(st.me, null, 2)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `luokixi-我的校园-${new Date().toISOString().slice(0, 10)}.json` });
  a.click();
  URL.revokeObjectURL(a.href);
});

$('#cx-me-import').addEventListener('change', async (e) => {
  try {
    st.me = importMe(JSON.parse(await e.target.files[0].text()));
    saveAndRender();
    openMe();
    toast('已导入。');
  } catch (err) {
    toast(err.message ?? '备份文件读不出来。');
  } finally {
    e.target.value = '';
  }
});

$('#cx-me-clear').addEventListener('click', () => {
  if (!confirm('清空这个浏览器里的学院、课表和“到过”的记录？清空前可以先导出备份。')) return;
  st.me = importMe({ version: 1, courses: [] });
  saveAndRender();
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
  else if (!st.user.emailVerified) html = '<p class="notice"><span class="notice-dot" aria-hidden="true"></span><span><strong>邮箱还没验证。</strong>验证之后才能上传照片和投稿。</span></p><a class="btn btn-primary btn-sm" href="me.html#account">去验证</a>';
  $('#cx-gate').innerHTML = html;
  const locked = Boolean(html);
  form.inert = locked;
  form.classList.toggle('is-locked', locked);
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
  if (e.target.name === 'campus') renderLoc();
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
  // 顶栏“＋发布 → 标一个地点”直达投稿
  if (params.get('add') === 'place') openAdd();
}

init();
