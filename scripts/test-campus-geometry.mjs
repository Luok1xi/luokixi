import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { campusBuildings, campusRoads, featureWithValidCenter, footprintsIntersect, pointInGeometry, prepareCampusData } from '../src/js/campus-geometry.js';
const square = (x, y, size = 1) => ({ type: 'Polygon', coordinates: [[[x,y],[x+size,y],[x+size,y+size],[x,y+size],[x,y]]] });
const feature = (geometry, center) => ({ type:'Feature', geometry, properties:{kind:'building',osm:'way/test',center} });

test('outside centers never delete intersecting footprints', () => {
  const f = feature(square(0,0), [20,20]);
  assert.equal(footprintsIntersect(f, square(0.5,0.5)),true);
  const corrected=featureWithValidCenter(f);
  assert.deepEqual(corrected.properties.center,[0.5,0.5]);
  assert.deepEqual(f.properties.center,[20,20]);
  assert.equal(corrected.properties.osm,f.properties.osm);
});
test('intersection checks crossing polygons without contained vertices, touching edges, and disjoint geometry', () => {
  const a={type:'Polygon',coordinates:[[[0,1],[4,1],[4,2],[0,2],[0,1]]]};
  const b={type:'Polygon',coordinates:[[[1,0],[2,0],[2,4],[1,4],[1,0]]]};
  assert.equal(footprintsIntersect(a,b),true);
  assert.equal(footprintsIntersect(square(0,0),square(1,0)),true);
  assert.equal(footprintsIntersect(square(0,0),square(2,0)),false);
});
test('holes and all MultiPolygon components are honored', () => {
  const holes={type:'Polygon',coordinates:[square(0,0,10).coordinates[0],square(2,2,6).coordinates[0]]};
  assert.equal(pointInGeometry([5,5],holes),false);
  assert.equal(footprintsIntersect(holes,square(4,4)),false);
  const multi={type:'MultiPolygon',coordinates:[square(20,20).coordinates,square(0,0).coordinates]};
  assert.equal(pointInGeometry([0.5,0.5],multi),true);
  assert.equal(footprintsIntersect(multi,square(0,0)),true);
});
test('translated center computation remains stable at actual Beijing coordinates', () => {
  const f=feature(square(116.34495,39.99811,0.00004),[116.348635,39.999379]);
  const c=featureWithValidCenter(f).properties.center;
  assert.ok(Math.abs(c[0]-116.34497)<1e-10);
  assert.ok(Math.abs(c[1]-39.99813)<1e-10);
});
test('valid centers retain the original feature and concave or courtyard fallback remains on its footprint', () => {
  const f=feature(square(0,0),[0.5,0.5]); assert.equal(featureWithValidCenter(f),f);
  const donut={type:'Polygon',coordinates:[square(0,0,10).coordinates[0],square(2,2,6).coordinates[0]]};
  const c=featureWithValidCenter(feature(donut,[5,5])).properties.center;
  assert.equal(pointInGeometry(c,donut),true);
});
test('both real campuses retain building IDs while excluding all context roads', async () => {
  for (const name of ['xueyuanlu','shahe']) {
    const raw=await readFile(new URL(`../public/data/campus-map/${name}.json`,import.meta.url),'utf8');
    const d=JSON.parse(raw.replace(/^\uFEFF/,'')), before=JSON.stringify(d);
    const buildings=campusBuildings(d), originals=d.features.filter(f=>f.properties.kind==='building');
    assert.deepEqual(buildings.map(f=>f.properties.osm),originals.map(f=>f.properties.osm));
    for(const f of buildings) assert.equal(pointInGeometry(f.properties.center,f),true,f.properties.osm);
    const roads=campusRoads(d); assert.ok(roads.length>0);
    assert.equal(roads.some(f=>f.properties.context),false);
    assert.equal(JSON.stringify(d),before);
  }
});

test('prepareCampusData corrects only bad public centers and leaves the source immutable', async () => {
  const d=JSON.parse(await readFile(new URL('../public/data/campus-map/xueyuanlu.json',import.meta.url),'utf8'));
  const before=JSON.stringify(d),prepared=prepareCampusData(d);
  assert.notEqual(prepared,d);assert.notEqual(prepared.features,d.features);
  assert.deepEqual(prepared.features.map(f=>f.properties.osm),d.features.map(f=>f.properties.osm));
  for (const id of ['way/247351556','way/255743010']) {
    const original=d.features.find(f=>f.properties.osm===id),fixed=prepared.features.find(f=>f.properties.osm===id);
    assert.equal(pointInGeometry(original.properties.center,original),false);
    assert.equal(pointInGeometry(fixed.properties.center,fixed),true);
    assert.deepEqual(fixed.geometry,original.geometry);
  }
  assert.equal(JSON.stringify(d),before);
});
