import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createPlanStore } from '../src/js/campus-store.js';
import { normalizePlan } from '../src/js/campus-plan.js';

const legacyKey = 'luokixi.campus.me';
const legacy = () => ({ version: 1, profile: { faculty: '学院', major: '专业', year: '2026', campus: 'shahe' }, courses: [{ id: 'math', name: '高数', building: { campus: 'shahe', osm: 'way/123', name: '教学楼', center: [116.2, 40.1] }, slots: [{ day: 1, start: '08:00', end: '09:00' }] }], visited: { shahe: ['way/123'] } });
function storage(raw = null) {
  const values = new Map(raw === null ? [] : [[legacyKey, raw]]);
  return { writes: 0, removals: 0, getItem(key) { return values.get(key) ?? null; }, setItem(key, value) { this.writes += 1; values.set(key, value); }, removeItem(key) { this.removals += 1; values.delete(key); } };
}
function setup(extra = {}) {
  const factory = extra.indexedDB ?? new IDBFactory();
  const saved = extra.legacyStorage ?? storage();
  const options = { indexedDB: factory, legacyStorage: saved, BroadcastChannel: null, ...extra };
  return { factory, saved, store: createPlanStore(options), options };
}
async function seed(factory, record) {
  const db = await new Promise((resolve, reject) => {
    const request = factory.open('luokixi-campus-plan', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('plans');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise((resolve, reject) => {
    const tx = db.transaction('plans', 'readwrite');
    tx.objectStore('plans').put(record, 'current');
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error);
  });
  db.close();
}

class LocalChannel {
  static groups = new Map();
  constructor(name) {
    this.name = name;
    const group = LocalChannel.groups.get(name) || new Set();
    group.add(this);
    LocalChannel.groups.set(name, group);
  }
  postMessage(data) {
    for (const other of LocalChannel.groups.get(this.name) || []) if (other !== this) queueMicrotask(() => other.onmessage?.({ data }));
  }
  close() { LocalChannel.groups.get(this.name)?.delete(this); }
}

test('first read migrates valid legacy data into IDB and removes only the committed legacy plan', async () => {
  const raw = JSON.stringify(legacy());
  const { store, saved } = setup({ legacyStorage: storage(raw) });
  try {
    const first = await store.readPlan();
    assert.equal(first.revision, 1);
    assert.deepEqual(first.data.profile, legacy().profile);
    assert.deepEqual(first.data.courses[0].building, legacy().courses[0].building);
    assert.deepEqual(first.data.visited, legacy().visited);
    assert.equal(first.data.courses[0].slots[0].id, 'slot-0');
    assert.equal(saved.getItem(legacyKey), null);
    assert.equal(saved.removals, 1);
    assert.equal(saved.writes, 0, 'no planner data is ever written to localStorage');
    assert.deepEqual(await store.readPlan(), first);
    assert.equal(saved.removals, 1);
  } finally { store.close(); }
});

test('malformed or invalid legacy data is preserved and surfaced without silently replacing it', async () => {
  for (const raw of ['{bad json', JSON.stringify({ ...legacy(), courses: [{ id: 'bad', name: 'Bad', slots: [{ day: 1, start: '25:00', end: '26:00' }] }] }), JSON.stringify({ version: 2, courses: [] })]) {
    const { store, saved } = setup({ legacyStorage: storage(raw) });
    try {
      const state = await store.readPlan();
      assert.equal(state.revision, 0);
      assert.equal(state.corrupt, true);
      assert.equal(state.raw, raw);
      assert.deepEqual(state.data, normalizePlan());
      assert.equal(saved.getItem(legacyKey), raw);
      assert.equal(saved.removals, 0);
      const replaced = await store.writePlan(normalizePlan(), state.revision);
      assert.equal(replaced.revision, 1);
      assert.equal(saved.getItem(legacyKey), null, 'explicit successful replacement can clean the legacy record');
    } finally { store.close(); }
  }
});

test('a failed IDB migration retains the complete legacy backup and can be retried', async () => {
  const actual = new IDBFactory();
  let failWrites = true;
  const injected = { open(...args) {
    const request = actual.open(...args);
    request.addEventListener('success', () => {
      const db = request.result;
      const transaction = db.transaction.bind(db);
      db.transaction = (...params) => {
        const tx = transaction(...params);
        if (params[1] === 'readwrite' && failWrites) {
          const objectStore = tx.objectStore.bind(tx);
          tx.objectStore = (...stores) => {
            const out = objectStore(...stores);
            out.put = () => { throw new DOMException('Injected full disk', 'QuotaExceededError'); };
            return out;
          };
        }
        return tx;
      };
    });
    return request;
  } };
  const raw = JSON.stringify(legacy());
  const { store, saved } = setup({ indexedDB: injected, legacyStorage: storage(raw) });
  try {
    await assert.rejects(store.ready(), /Injected full disk/);
    assert.equal(saved.getItem(legacyKey), raw);
    assert.equal(saved.removals, 0);
    failWrites = false;
    const recovered = await store.readPlan();
    assert.equal(recovered.revision, 1);
    assert.equal(recovered.data.courses[0].name, '高数');
    assert.equal(saved.removals, 1);
  } finally { store.close(); }
});

test('IDB plans take precedence over leftover legacy data and invalid IDB content remains reviewable', async () => {
  const factory = new IDBFactory();
  await seed(factory, { revision: 7, data: normalizePlan({ profile: { major: '已经迁移' } }) });
  const { store, saved } = setup({ indexedDB: factory, legacyStorage: storage(JSON.stringify(legacy())) });
  try {
    const state = await store.readPlan();
    assert.equal(state.revision, 7);
    assert.equal(state.data.profile.major, '已经迁移');
    assert.equal(saved.removals, 0, 'an unrelated leftover is not removed merely by reading');
  } finally { store.close(); }
  const corruptFactory = new IDBFactory();
  const raw = { version: 1, courses: [{ id: 'bad', name: 'Broken', slots: [{ day: 1, start: '08:60', end: '09:00' }] }] };
  await seed(corruptFactory, { revision: 8, data: raw });
  const corrupt = setup({ indexedDB: corruptFactory });
  try {
    const state = await corrupt.store.readPlan();
    assert.equal(state.revision, 8);
    assert.equal(state.corrupt, true);
    assert.deepEqual(state.raw, raw);
    assert.deepEqual(state.data, normalizePlan());
    assert.equal((await corrupt.store.clearPlan(8)).revision, 9);
  } finally { corrupt.store.close(); }
});

test('multiple clients use IDB transaction revisions to reject stale writes and stale clears', async () => {
  const shared = setup();
  const other = createPlanStore(shared.options);
  try {
    const [first, second] = await Promise.all([shared.store.readPlan(), other.readPlan()]);
    assert.equal(first.revision, 0);
    assert.equal(second.revision, 0);
    const a = normalizePlan({ profile: { major: 'first writer' } });
    const b = normalizePlan({ profile: { major: 'stale writer' } });
    const outcomes = await Promise.allSettled([shared.store.writePlan(a, 0), other.writePlan(b, 0)]);
    assert.equal(outcomes.filter((x) => x.status === 'fulfilled').length, 1);
    const rejected = outcomes.find((x) => x.status === 'rejected').reason;
    assert.equal(rejected.code, 'conflict');
    assert.equal(rejected.expectedRevision, 0);
    assert.equal(rejected.actualRevision, 1);
    const latest = await other.readPlan();
    assert.equal(latest.revision, 1);
    assert.equal(latest.data.profile.major, 'first writer');
    await assert.rejects(other.clearPlan(0), (error) => error.code === 'conflict');
    assert.equal((await other.readPlan()).data.profile.major, 'first writer');
    const cleared = await other.clearPlan(1);
    assert.equal(cleared.revision, 2);
    assert.deepEqual(cleared.data, normalizePlan());
  } finally { shared.store.close(); other.close(); }
});

test('subscriptions publish only committed writes and deliver changes to other clients', async () => {
  const shared = setup({ BroadcastChannel: LocalChannel });
  const other = createPlanStore(shared.options);
  const messages = [];
  let resolveUpdate;
  const incoming = new Promise((resolve) => { resolveUpdate = resolve; });
  const off = shared.store.subscribePlan((state) => messages.push(state));
  const offOther = other.subscribePlan((state) => resolveUpdate(state));
  try {
    await Promise.all([shared.store.ready(), other.ready()]);
    const saved = await shared.store.writePlan(normalizePlan({ profile: { major: 'broadcast' } }), 0);
    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0], saved);
    assert.deepEqual(await incoming, saved);
    await assert.rejects(shared.store.writePlan(normalizePlan(), 0), (error) => error.code === 'conflict');
    assert.equal(messages.length, 1, 'failed transactions never announce success');
    messages[0].data.profile.major = 'mutated listener';
    assert.equal((await shared.store.readPlan()).data.profile.major, 'broadcast', 'listeners receive independent copies');
    off();
    await shared.store.writePlan(normalizePlan(), 1);
    assert.equal(messages.length, 1);
  } finally { off(); offOther(); shared.store.close(); other.close(); }
});

test('invalid writes and invalid expected versions neither change data nor increment revisions', async () => {
  const { store } = setup();
  try {
    await assert.rejects(store.writePlan({ events: [{ id: 'bad', title: 'Bad', date: '2026-10-07', start: '12:99', end: '14:00' }] }, 0), /时间需为/);
    await assert.rejects(store.writePlan(normalizePlan(), undefined), /版本号/);
    assert.equal((await store.readPlan()).revision, 0);
    const saved = await store.writePlan(normalizePlan({ favorites: [{ campus: 'shahe', osm: 'way/1', name: '图书馆', center: null }], routePrefs: { shahe: { start: 'way/1', via: ['place:gate'] } } }), 0);
    assert.equal(saved.revision, 1);
    assert.equal((await store.readPlan()).data.favorites[0].osm, 'way/1');
  } finally { store.close(); }
});
