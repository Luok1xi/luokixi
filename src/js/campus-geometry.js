// Geographic checks use footprints rather than potentially imprecise stored centers.
// Source GeoJSON remains unchanged; touching the campus edge counts as intersection.
const EPS = 1e-12;
const polygons = (value) => {
  const g = value?.geometry ?? value;
  return g?.type === 'Polygon' ? [g.coordinates] : g?.type === 'MultiPolygon' ? g.coordinates : [];
};
const cross = (a, b, p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
const onSegment = (p, a, b) => Math.abs(cross(a, b, p)) <= EPS &&
  p[0] >= Math.min(a[0], b[0]) - EPS && p[0] <= Math.max(a[0], b[0]) + EPS &&
  p[1] >= Math.min(a[1], b[1]) - EPS && p[1] <= Math.max(a[1], b[1]) + EPS;
const edges = (ring) => ring.map((p, i) => [p, ring[(i + 1) % ring.length]]);

function inRing(p, ring) {
  if (!Array.isArray(ring) || ring.length < 3) return false;
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j], b = ring[i];
    if (onSegment(p, a, b)) return true;
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) hit = !hit;
  }
  return hit;
}

export function pointInGeometry(point, geometry) {
  if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite)) return false;
  return polygons(geometry).some((rings) => inRing(point, rings[0]) && !rings.slice(1).some((hole) => inRing(point, hole)));
}

function intersectsSegment(a, b, c, d) {
  const ac = cross(a, b, c), ad = cross(a, b, d), ca = cross(c, d, a), cb = cross(c, d, b);
  if (((ac > EPS && ad < -EPS) || (ac < -EPS && ad > EPS)) &&
      ((ca > EPS && cb < -EPS) || (ca < -EPS && cb > EPS))) return true;
  return onSegment(c, a, b) || onSegment(d, a, b) || onSegment(a, c, d) || onSegment(b, c, d);
}

export function footprintsIntersect(a, b) {
  return polygons(a).some((pa) => polygons(b).some((pb) => {
    const ga = { type: 'Polygon', coordinates: pa }, gb = { type: 'Polygon', coordinates: pb };
    if (pa[0].some((p) => pointInGeometry(p, gb)) || pb[0].some((p) => pointInGeometry(p, ga))) return true;
    return pa.some((ra) => pb.some((rb) => edges(ra).some(([x, y]) => edges(rb).some(([u, v]) => intersectsSegment(x, y, u, v)))));
  }));
}

// Translate before the shoelace calculation to avoid cancellation at 116 degrees
// longitude. An inaccurate source center must never move the physical building.
function ringCenter(ring) {
  const origin = ring[0];
  let area = 0, x = 0, y = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const ax = a[0] - origin[0], ay = a[1] - origin[1], bx = b[0] - origin[0], by = b[1] - origin[1];
    const q = ax * by - bx * ay;
    area += q; x += (ax + bx) * q; y += (ay + by) * q;
  }
  return { area: Math.abs(area), point: Math.abs(area) > Number.EPSILON ? [origin[0] + x / (3 * area), origin[1] + y / (3 * area)] : origin.slice() };
}

export function featureWithValidCenter(feature) {
  const prior = feature?.properties?.center;
  if (pointInGeometry(prior, feature)) return feature;
  const shapes = polygons(feature).map((rings) => ({ rings, ...ringCenter(rings[0]) })).sort((a, b) => b.area - a.area);
  if (!shapes.length) return feature;
  let center = shapes.find((s) => pointInGeometry(s.point, feature))?.point;
  // Concave footprints or courtyards can put the centroid outside usable geometry.
  // Keep the fallback on a recorded edge, rather than inventing a location.
  if (!center) center = shapes[0].rings[0].find((p) => pointInGeometry(p, feature))?.slice();
  if (!center) return feature;
  return { ...feature, properties: { ...feature.properties, center } };
}

// Prepare public geometry only. Personal schedules are not rewritten or uploaded.
export function prepareCampusData(data) {
  if (!data || !Array.isArray(data.features)) return data;
  return {
    ...data,
    features: data.features.map((f) => f.properties?.kind === 'building' ? featureWithValidCenter(f) : f),
  };
}

export function campusBuildings(data) {
  return (data?.features ?? []).filter((f) => f.properties?.kind === 'building' && footprintsIntersect(f, data.boundary)).map(featureWithValidCenter);
}

export function campusRoads(data) {
  return (data?.features ?? []).filter((f) => !f.properties?.context && ['road', 'mainroad', 'path'].includes(f.properties?.kind));
}
