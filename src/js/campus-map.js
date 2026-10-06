// 矿大校园插画地图：像游乐园导览图一样，只画校园里面的东西，不加载任何外部底图瓦片。
// 楼、路、草地、操场、校门全部来自 OpenStreetMap（public/data/campus-map/*.json，ODbL），只换画法，不补画。
// Codex 按上海迪士尼导览图风格重绘的整图交付并审过以后（public/art/campus-map/manifest.json），叠在同一投影上替换矢量画法。
// 颜色、线宽、楼的“墙”都在 map.css 里用 CSS 变量控制，深色外观自动换成夜景配色。
import * as L from 'leaflet';

export const BUILDING_USE = {
  teaching: { name: '教学楼' },
  library: { name: '图书馆' },
  canteen: { name: '食堂' },
  dorm: { name: '宿舍' },
  sports: { name: '体育' },
  lab: { name: '实验与科研' },
  hall: { name: '礼堂与会堂' },
  clinic: { name: '医务' },
  shop: { name: '商店' },
  other: { name: '其他建筑' },
};

// 楼的高度分档：没有层数数据的按低层画，不猜
const tier = (levels) => (!levels ? 'lv-s' : levels <= 3 ? 'lv-s' : levels <= 8 ? 'lv-m' : 'lv-l');

function pane(map, name, z) {
  const p = map.getPane(name) ?? map.createPane(name);
  p.style.zIndex = String(z);
  return name;
}

export function createCampusMap(map, { onBuilding } = {}) {
  const container = map.getContainer();
  container.classList.add('cm');
  container.dataset.mode = 'illustrated';
  const panes = {
    ground: pane(map, 'cm-ground', 250),
    area: pane(map, 'cm-area', 260),
    road: pane(map, 'cm-road', 270),
    art: pane(map, 'cm-art', 275),
    building: pane(map, 'cm-building', 280),
    mark: pane(map, 'cm-mark', 590),
  };
  // 每个层用自己的 SVG 渲染器，这样 CSS 能按层设置滤镜（楼的“墙”）
  const svg = (name) => L.svg({ pane: name, padding: 0.4 });
  const renderers = { ground: svg(panes.ground), area: svg(panes.area), road: svg(panes.road), building: svg(panes.building) };
  const groups = Object.fromEntries(['ground', 'area', 'road', 'building', 'label', 'mark'].map((k) => [k, L.layerGroup().addTo(map)]));

  let data = null;
  let selected = null;
  const byOsm = new Map();

  // 线宽和“墙高”跟着缩放变：17 级为基准
  const syncZoom = () => {
    const z = map.getZoom();
    container.style.setProperty('--cm-s', String(2 ** (z - 17)));
    container.dataset.zoom = z >= 17.5 ? 'near' : z >= 16 ? 'mid' : 'far';
  };
  map.on('zoomend', syncZoom);
  syncZoom();

  function clear() {
    Object.values(groups).forEach((g) => g.clearLayers());
    byOsm.clear();
    selected = null;
  }

  function load(next) {
    clear();
    data = next;
    if (!data) return;
    const ring = data.boundary.coordinates[0].map(([lng, lat]) => [lat, lng]);
    const [w, s, e, n] = ring.reduce(([a, b, c, d], [lat, lng]) => [Math.min(a, lng), Math.min(b, lat), Math.max(c, lng), Math.max(d, lat)], [180, 90, -180, -90]);
    const pad = 0.08;
    // 校外：一块挖掉校园的大遮罩。插画模式下它就是“纸面”，卫星和标准模式下是半透明压暗
    L.polygon([[[s - pad, w - pad], [s - pad, e + pad], [n + pad, e + pad], [n + pad, w - pad]], ring], {
      pane: panes.ground, renderer: renderers.ground, className: 'cm-mask', interactive: false,
    }).addTo(groups.ground);
    L.polygon(ring, { pane: panes.ground, renderer: renderers.ground, className: 'cm-campus', interactive: false }).addTo(groups.ground);

    const areas = data.features.filter((f) => !['building', 'road', 'mainroad', 'path'].includes(f.properties.kind));
    L.geoJSON(areas, {
      pane: panes.area, renderer: renderers.area, interactive: false,
      style: (f) => ({ className: `cm-a cm-a-${f.properties.kind}` }),
    }).addTo(groups.area);

    // 路分两遍画：先画宽一点的描边，再画路面，路口才会自然连在一起
    const roads = data.features.filter((f) => ['road', 'mainroad', 'path'].includes(f.properties.kind));
    for (const layer of ['case', 'fill']) {
      L.geoJSON(roads, {
        pane: panes.road, renderer: renderers.road, interactive: false,
        style: (f) => ({ className: `cm-r cm-r-${layer} cm-r-${f.properties.kind}${f.properties.context ? ' is-context' : ''}`, lineCap: 'round', lineJoin: 'round' }),
      }).addTo(groups.road);
    }
    L.polygon(ring, { pane: panes.road, renderer: renderers.road, className: 'cm-edge', interactive: false, fill: false }).addTo(groups.road);

    const buildings = data.features.filter((f) => f.properties.kind === 'building');
    L.geoJSON(buildings, {
      pane: panes.building, renderer: renderers.building,
      style: (f) => ({ className: `cm-b cm-b-${f.properties.use} ${tier(f.properties.levels)}` }),
      onEachFeature: (f, layer) => {
        byOsm.set(f.properties.osm, { feature: f, layer });
        layer.on('click', (ev) => {
          L.DomEvent.stopPropagation(ev);
          onBuilding?.(f);
        });
        layer.on('mouseover', () => layer.getElement()?.classList.add('is-hover'));
        layer.on('mouseout', () => layer.getElement()?.classList.remove('is-hover'));
      },
    }).addTo(groups.building);

    // 名字标签：有名字的楼、校门、带名字的设施
    for (const f of buildings.filter((b) => b.properties.name)) {
      const [lng, lat] = f.properties.center;
      L.marker([lat, lng], {
        pane: panes.mark,
        icon: L.divIcon({ className: 'cm-label-wrap', html: `<span class="cm-label cm-l-${f.properties.use}">${escapeHTML(f.properties.name)}</span>`, iconSize: null }),
        keyboard: false,
      })
        .on('click', () => onBuilding?.(f))
        .addTo(groups.label);
    }
    for (const p of data.pois ?? []) {
      const [lng, lat] = p.geometry.coordinates;
      const gate = p.properties.kind === 'gate';
      if (!gate && !p.properties.name) continue;
      L.marker([lat, lng], {
        pane: panes.mark, interactive: false, keyboard: false,
        icon: L.divIcon({
          className: 'cm-label-wrap',
          html: gate ? `<span class="cm-gate" title="${escapeHTML(p.properties.name || '校门')}">门</span>` : `<span class="cm-label cm-l-poi is-minor">${escapeHTML(p.properties.name)}</span>`,
          iconSize: null,
        }),
      }).addTo(groups.label);
    }
  }

  // Codex 的重绘插画：一张按截图范围对齐的整图。有它时插画模式改用这张图，
  // 矢量的楼只留透明的点击区域和选中描边，名字标签照常显示。
  let artLayer = null;
  function setArt(art) {
    artLayer?.remove();
    artLayer = null;
    container.dataset.art = art ? 'on' : 'off';
    if (!art) return;
    artLayer = L.imageOverlay(art.image, art.bounds, { pane: panes.art, interactive: false, className: 'cm-art', alt: '' }).addTo(map);
  }

  function select(osm) {
    if (selected) byOsm.get(selected)?.layer.getElement()?.classList.remove('is-on');
    selected = osm;
    byOsm.get(osm)?.layer.getElement()?.classList.add('is-on');
  }

  // 给楼加状态：到过（is-visited）、有我的课（is-course）、当前任务目标（is-target）
  function mark(states) {
    for (const [osm, { layer }] of byOsm) {
      const el = layer.getElement();
      if (!el) continue;
      for (const cls of ['is-visited', 'is-course', 'is-target']) el.classList.toggle(cls, Boolean(states[cls]?.has(osm)));
    }
  }

  return {
    load, setArt, select, mark,
    get data() { return data; },
    building: (osm) => byOsm.get(osm)?.feature ?? null,
    buildings: () => [...byOsm.values()].map((x) => x.feature),
    group: groups.mark,
  };
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// 点是否在多边形里（GeoJSON 坐标：经度, 纬度）
export function pointInFeature([lng, lat], feature) {
  const polys = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.type === 'MultiPolygon' ? feature.geometry.coordinates : [];
  return polys.some((rings) => {
    let hit = false;
    const ring = rings[0];
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) hit = !hit;
    }
    return hit;
  });
}

// ---------- 楼的小模型：按真实轮廓和层数画一个等轴视角的“沙盘” ----------
// 用在楼的介绍卡片上。轮廓来自 OpenStreetMap；没有层数时按 3 层画，并在卡片上说明。

export function buildingModelSVG(feature) {
  const ring = (feature.geometry.type === 'MultiPolygon' ? feature.geometry.coordinates[0][0] : feature.geometry.coordinates[0]).slice(0, -1);
  const [lng0, lat0] = feature.properties.center;
  const kx = Math.cos((lat0 * Math.PI) / 180) * 111320;
  const ky = 110540;
  // 局部平面坐标（米），x 向东，y 向南
  const local = ring.map(([lng, lat]) => [(lng - lng0) * kx, -(lat - lat0) * ky]);
  const height = (feature.properties.levels ?? 3) * 3.4;
  const C = Math.cos(Math.PI / 6);
  const proj = ([x, y], z) => [(x - y) * C, (x + y) * 0.5 - z];
  const base = local.map((p) => proj(p, 0));
  const top = local.map((p) => proj(p, height));
  const xs = [...base, ...top].map((p) => p[0]);
  const ys = [...base, ...top].map((p) => p[1]);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const size = Math.max(maxX - minX, maxY - minY) || 1;
  const k = 220 / size;
  const fit = ([x, y]) => [((x - minX) * k + (300 - (maxX - minX) * k) / 2).toFixed(1), ((y - minY) * k + (240 - (maxY - minY) * k) / 2).toFixed(1)];
  const poly = (list, cls) => `<polygon class="${cls}" points="${list.map((p) => fit(p).join(',')).join(' ')}"/>`;
  // 墙：由远到近画，近处的墙盖住远处的；只画朝向观察者的墙
  const walls = local
    .map((p, i) => {
      const q = local[(i + 1) % local.length];
      const nx = q[1] - p[1];
      const ny = -(q[0] - p[0]);
      return { i, q, p, depth: (p[0] + p[1] + q[0] + q[1]) / 2, facing: nx + ny, east: nx - ny };
    })
    .sort((a, b) => a.depth - b.depth);
  const signed = local.reduce((s, p, i) => s + p[0] * local[(i + 1) % local.length][1] - local[(i + 1) % local.length][0] * p[1], 0);
  const out = walls
    .filter((w) => (signed > 0 ? w.facing > 0 : w.facing < 0))
    .map((w) => {
      // 朝东的墙在画面右侧，画暗一点；朝南的在左侧，亮一点
      const shade = (signed > 0 ? w.east : -w.east) > 0 ? 'bm-wall-r' : 'bm-wall-l';
      const quad = [proj(w.p, 0), proj(w.q, 0), proj(w.q, height), proj(w.p, height)];
      let floors = '';
      const lv = Math.round(height / 3.4);
      for (let f = 1; f < lv; f += 1) {
        const a = fit(proj(w.p, f * 3.4));
        const b = fit(proj(w.q, f * 3.4));
        floors += `<line class="bm-floor" x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}"/>`;
      }
      return poly(quad, shade) + floors;
    })
    .join('');
  return `<svg class="bm" viewBox="0 0 300 240" aria-hidden="true">
    <ellipse class="bm-shadow" cx="150" cy="${(240 - (240 - (maxY - minY) * k) / 2 - 4).toFixed(1)}" rx="${((maxX - minX) * k * 0.5).toFixed(1)}" ry="12"/>
    ${out}${poly(top, 'bm-roof')}
  </svg>`;
}
