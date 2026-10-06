// 从 OpenStreetMap 取两个校区的楼、路、草地、操场、校门，整理成插画地图用的 GeoJSON。
// 用法：node scripts/build-campus-map.mjs        → 写入 public/data/campus-map/<校区>.json
// 数据许可：© OpenStreetMap 贡献者，ODbL 1.0。导出的文件是派生数据库，同样按 ODbL 提供，页面上必须署名。
// 只做分类和简化，不补画、不猜测：OSM 里没有的楼和路，地图上也没有。
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(root, 'public/data/campus-map');
const ENDPOINT = 'https://overpass-api.de/api/interpreter';
const UA = 'luokixi-campus-map-build/0.1 (student-run open-source study site)';

const campuses = JSON.parse(await readFile(resolve(root, 'public/data/campuses.json'), 'utf8')).campuses;
// 人工更正：按名称猜错用途的楼，可以在这里改，每条必须写来源。格式见 docs/CAMPUS_MAP_ART.md
const overrides = await readFile(resolve(OUT, 'overrides.json'), 'utf8')
  .then((t) => JSON.parse(t).buildings ?? {})
  .catch(() => ({}));
const wayId = (url) => Number(/way\/(\d+)/.exec(url)?.[1]);

const r6 = (v) => Math.round(v * 1e6) / 1e6;
const pt = (g) => [r6(g.lon), r6(g.lat)]; // GeoJSON 顺序：经度, 纬度

// ---------- 分类 ----------

const has = (name, words) => words.some((w) => name.includes(w));

function buildingUse(tags) {
  const n = tags.name ?? '';
  if (has(n, ['图书馆'])) return 'library';
  if (has(n, ['食堂', '餐厅', '餐饮'])) return 'canteen';
  if (has(n, ['宿舍', '公寓'])) return 'dorm';
  if (has(n, ['体育馆', '游泳', '球馆', '健身'])) return 'sports';
  if (has(n, ['医院', '医务', '卫生'])) return 'clinic';
  if (has(n, ['礼堂', '会堂', '剧场', '音乐厅', '活动中心'])) return 'hall';
  if (has(n, ['实验', '科研', '研究', '科技楼'])) return 'lab';
  if (has(n, ['教学', '教室', '综合楼', '学院', '主楼'])) return 'teaching';
  const b = tags.building;
  if (['dormitory', 'residential', 'apartments', 'house'].includes(b)) return 'dorm';
  if (['university', 'school', 'college'].includes(b)) return 'teaching';
  if (['sports_hall', 'sports_centre', 'stadium', 'grandstand'].includes(b)) return 'sports';
  if (['commercial', 'retail', 'supermarket', 'kiosk'].includes(b)) return 'shop';
  return 'other';
}

function classify(tags) {
  if (tags.building || tags['building:part']) return 'building';
  if (tags.highway) {
    if (tags.area === 'yes' || tags.highway === 'pedestrian') return 'plaza';
    if (['footway', 'path', 'steps', 'cycleway', 'corridor'].includes(tags.highway)) return 'path';
    if (['primary', 'secondary', 'tertiary', 'trunk', 'primary_link', 'secondary_link'].includes(tags.highway)) return 'mainroad';
    return 'road';
  }
  if (tags.leisure === 'track' || tags.sport === 'running' || tags.sport === 'athletics') return 'track';
  if (tags.leisure === 'pitch') return 'pitch';
  if (tags.leisure === 'stadium' || tags.leisure === 'sports_centre') return 'sportsground';
  if (tags.leisure === 'swimming_pool' || tags.natural === 'water' || tags.water || tags.landuse === 'basin') return 'water';
  if (['park', 'garden'].includes(tags.leisure) || ['grass', 'forest', 'meadow', 'village_green', 'recreation_ground', 'flowerbed'].includes(tags.landuse) || ['wood', 'scrub', 'grassland'].includes(tags.natural)) return 'green';
  if (tags.amenity === 'parking') return 'parking';
  return null;
}

// ---------- 几何 ----------

const closed = (g) => g.length > 3 && g[0].lat === g.at(-1).lat && g[0].lon === g.at(-1).lon;

// 把多段 way 首尾相接拼成闭合环（多边形关系用）
function rings(segments) {
  const pool = segments.map((s) => s.map(pt));
  const out = [];
  while (pool.length) {
    let ring = pool.shift();
    let grown = true;
    while (grown && (ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1])) {
      grown = false;
      for (let i = 0; i < pool.length; i += 1) {
        const s = pool[i];
        const same = (a, b) => a[0] === b[0] && a[1] === b[1];
        if (same(ring.at(-1), s[0])) ring = ring.concat(s.slice(1));
        else if (same(ring.at(-1), s.at(-1))) ring = ring.concat(s.slice(0, -1).reverse());
        else if (same(ring[0], s.at(-1))) ring = s.concat(ring.slice(1));
        else if (same(ring[0], s[0])) ring = s.slice(1).reverse().concat(ring);
        else continue;
        pool.splice(i, 1);
        grown = true;
        break;
      }
    }
    if (ring.length >= 4) out.push(ring);
  }
  return out;
}

function geometry(el) {
  if (el.type === 'node') return { type: 'Point', coordinates: pt(el) };
  if (el.type === 'way' && el.geometry) {
    return closed(el.geometry) && !['path', 'road', 'mainroad'].includes(classify(el.tags ?? {}))
      ? { type: 'Polygon', coordinates: [el.geometry.map(pt)] }
      : { type: 'LineString', coordinates: el.geometry.map(pt) };
  }
  if (el.type === 'relation' && el.members) {
    const outer = rings(el.members.filter((m) => m.role === 'outer' && m.geometry).map((m) => m.geometry));
    const inner = rings(el.members.filter((m) => m.role === 'inner' && m.geometry).map((m) => m.geometry));
    if (!outer.length) return null;
    // 内环简单地挂到第一个外环上；校园里的多边形关系很少，足够用
    return outer.length === 1
      ? { type: 'Polygon', coordinates: [outer[0], ...inner] }
      : { type: 'MultiPolygon', coordinates: outer.map((o, i) => (i ? [o] : [o, ...inner])) };
  }
  return null;
}

// 射线法判断点是否在校园轮廓内
function inside([x, y], ring) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

// 多边形的面积中心（经纬度很小的范围内按平面近似）
function centroid(geom) {
  const ring = geom.type === 'Polygon' ? geom.coordinates[0] : geom.type === 'MultiPolygon' ? geom.coordinates[0][0] : null;
  if (!ring) return geom.type === 'Point' ? geom.coordinates : geom.coordinates[Math.floor(geom.coordinates.length / 2)];
  let a = 0;
  let x = 0;
  let y = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[i + 1];
    const f = x0 * y1 - x1 * y0;
    a += f;
    x += (x0 + x1) * f;
    y += (y0 + y1) * f;
  }
  if (!a) return ring[0];
  return [r6(x / (3 * a)), r6(y / (3 * a))];
}

// ---------- 抓取 ----------

async function overpass(query) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
      body: `data=${encodeURIComponent(query)}`,
    });
    if (res.ok) return res.json();
    if (attempt === 3) throw new Error(`Overpass ${res.status}: ${(await res.text()).slice(0, 200)}`);
    await new Promise((r) => setTimeout(r, 4000 * attempt));
  }
}

async function build(key, campus) {
  const id = wayId(campus.osm);
  const [[s, w], [n, e]] = campus.bounds;
  const pad = 0.004; // 大约 400 米：校外只取主要道路，给校园一点上下文
  const query = `[out:json][timeout:90];
way(${id})->.campus;
.campus out geom tags;
.campus map_to_area->.a;
(
  nwr(area.a)["building"];
  nwr(area.a)["building:part"];
  way(area.a)["highway"];
  nwr(area.a)["leisure"];
  nwr(area.a)["landuse"];
  nwr(area.a)["natural"];
  nwr(area.a)["amenity"];
  nwr(area.a)["shop"];
  nwr(area.a)["water"];
  node(area.a)["barrier"="gate"];
  node(area.a)["entrance"];
  node(area.a)["name"];
);
out geom tags;
way["highway"~"^(primary|secondary|tertiary|trunk|residential|unclassified)$"](${s - pad},${w - pad},${n + pad},${e + pad})->.ctx;
.ctx out geom tags;`;
  const data = await overpass(query);
  const els = data.elements ?? [];
  const boundaryEl = els.find((x) => x.type === 'way' && x.id === id);
  if (!boundaryEl) throw new Error(`${key}: 没有取到校园轮廓 way/${id}`);
  const ring = boundaryEl.geometry.map(pt);
  const seen = new Set([`way/${id}`]);
  const features = [];
  const pois = [];
  for (const el of els) {
    const osm = `${el.type}/${el.id}`;
    if (seen.has(osm)) continue;
    seen.add(osm);
    const tags = el.tags ?? {};
    const geom = geometry(el);
    if (!geom) continue;
    if (el.type === 'node') {
      const poi = tags.barrier === 'gate' || tags.entrance ? 'gate' : tags.amenity || tags.shop ? 'amenity' : tags.natural === 'tree' ? null : tags.name ? 'label' : null;
      if (poi) pois.push({ type: 'Feature', geometry: geom, properties: { osm, kind: poi, name: tags.name ?? '', amenity: tags.amenity ?? tags.shop ?? '' } });
      continue;
    }
    const kind = classify(tags);
    if (!kind) continue;
    const props = { osm, kind, name: tags.name ?? '' };
    // bbox 查询带回来的校外道路标成上下文，地图上画得很淡
    if (['road', 'mainroad', 'path'].includes(kind) && !geom.coordinates.some((c) => inside(c, ring))) props.context = true;
    if (kind === 'building') {
      props.use = buildingUse(tags);
      const lv = Number.parseInt(tags['building:levels'], 10);
      if (Number.isFinite(lv) && lv > 0) props.levels = Math.min(lv, 40);
      props.center = centroid(geom);
      const fix = overrides[osm];
      if (fix?.source) {
        if (fix.use) props.use = fix.use;
        if (fix.name && !props.name) props.name = fix.name;
        if (Number.isInteger(fix.levels) && !props.levels) props.levels = fix.levels;
        props.corrected = fix.source;
      }
    }
    if (kind === 'pitch' && tags.sport) props.sport = tags.sport;
    if (['path', 'road', 'mainroad'].includes(kind) && tags.name) props.center = centroid(geom);
    if (tags.amenity && kind !== 'building') props.amenity = tags.amenity;
    features.push({ type: 'Feature', geometry: geom, properties: props });
  }
  const order = ['green', 'water', 'sportsground', 'pitch', 'track', 'parking', 'plaza', 'mainroad', 'road', 'path', 'building'];
  features.sort((a, b) => order.indexOf(a.properties.kind) - order.indexOf(b.properties.kind));
  const counts = Object.fromEntries(order.map((k) => [k, features.filter((f) => f.properties.kind === k).length]));
  return {
    version: 1,
    campus: key,
    name: campus.name,
    license: 'ODbL-1.0',
    attribution: '© OpenStreetMap 贡献者',
    source: `https://www.openstreetmap.org/way/${id}`,
    generatedAt: new Date().toISOString(),
    notice: '楼、路、草地和校门都来自 OpenStreetMap，按原样分类绘制，没有补画。名称可能和学校现在的叫法不同，欢迎到 OpenStreetMap 修正。',
    counts,
    boundary: { type: 'Polygon', coordinates: [boundaryEl.geometry.map(pt)] },
    features,
    pois,
  };
}

await mkdir(OUT, { recursive: true });
for (const [key, campus] of Object.entries(campuses)) {
  const result = await build(key, campus);
  await writeFile(resolve(OUT, `${key}.json`), `${JSON.stringify(result)}\n`);
  console.log(key, result.counts, 'pois', result.pois.length);
  await new Promise((r) => setTimeout(r, 2000)); // Overpass 是公共服务，两次请求之间歇一下
}
