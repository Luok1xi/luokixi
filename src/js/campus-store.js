// Campus plans stay in IndexedDB. No server or localStorage plan writes occur here.
import { normalizePlan } from './campus-plan.js';

export const CAMPUS_DB_NAME = 'luokixi-campus-plan';
export const CAMPUS_LEGACY_KEY = 'luokixi.campus.me';
const STORE = 'plans';
const KEY = 'current';

function storageError(cause) {
  const error = new Error('本机校园数据库不可用，计划未保存；请保留备份后再试。', { cause });
  error.code = 'storage_unavailable';
  return error;
}
function conflict(expected, actual) {
  const error = new Error('计划已在另一个页面更新，当前改动未覆盖新版本。请重新读取后再保存。');
  error.code = 'conflict';
  error.expectedRevision = expected;
  error.actualRevision = actual;
  return error;
}
const revisionOf = (record) => Number.isSafeInteger(record?.revision) && record.revision >= 0 ? record.revision : 0;

// Dependency injection supports isolated native-browser and fake-indexeddb tests.
// Production consumers use the singleton functions exported below.
export function createPlanStore(options = {}) {
  const name = options.name || CAMPUS_DB_NAME;
  const legacyKey = options.legacyKey || CAMPUS_LEGACY_KEY;
  const channelName = options.channelName || `${name}:changes`;
  const subscribers = new Set();
  let connection;
  let opening;
  let initializing;
  let channel;
  let legacyCorrupt;
  let active = true;

  function legacyStorage() {
    try { return Object.hasOwn(options, 'legacyStorage') ? options.legacyStorage : globalThis.localStorage; }
    catch { return undefined; }
  }
  function removeLegacy() {
    const storage = legacyStorage();
    try { storage?.removeItem(legacyKey); } catch { /* The committed IndexedDB record remains authoritative. */ }
    legacyCorrupt = undefined;
  }
  async function open() {
    if (connection) return connection;
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      const factory = options.indexedDB ?? globalThis.indexedDB;
      if (!factory) { reject(storageError()); return; }
      let request;
      try { request = factory.open(name, 1); } catch (error) { reject(storageError(error)); return; }
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
      };
      request.onblocked = () => reject(storageError(new Error('数据库被旧页面占用。')));
      request.onerror = () => reject(storageError(request.error));
      request.onsuccess = () => {
        if (!active) { request.result.close(); reject(storageError(new Error('数据库连接已关闭。'))); return; }
        connection = request.result;
        connection.onversionchange = () => { connection.close(); connection = undefined; opening = undefined; };
        resolve(connection);
      };
    }).catch((error) => { opening = undefined; throw error; });
    return opening;
  }
  function transaction(db, mode, edit) {
    return new Promise((resolve, reject) => {
      let tx;
      let result;
      let failure;
      try { tx = db.transaction(STORE, mode); } catch (error) { reject(storageError(error)); return; }
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(failure || storageError(tx.error));
      tx.onerror = () => { /* onabort is the final outcome; do not publish uncommitted data. */ };
      const store = tx.objectStore(STORE);
      const request = store.get(KEY);
      request.onsuccess = () => {
        try {
          const next = edit(request.result);
          result = next.record;
          if (next.write) store.put(next.record, KEY);
        } catch (error) { failure = error; tx.abort(); }
      };
    });
  }
  function snapshot(record) {
    const revision = revisionOf(record);
    if (record === undefined) return { data: normalizePlan(), revision: 0, ...(legacyCorrupt ? { corrupt: true, raw: legacyCorrupt.raw } : {}) };
    try {
      if (!Number.isSafeInteger(record.revision) || record.revision < 1 || record.data?.version !== 1 || !Array.isArray(record.data.courses)) throw new Error('数据库记录格式错误。');
      return { data: normalizePlan(record.data), revision };
    } catch { return { data: normalizePlan(), revision, corrupt: true, raw: record.data ?? record }; }
  }
  function publish(state) {
    for (const fn of subscribers) {
      try { fn(structuredClone(state)); } catch { /* One view cannot prevent other views from receiving updates. */ }
    }
  }
  function connectChannel() {
    if (channel) return;
    const Channel = Object.hasOwn(options, 'BroadcastChannel') ? options.BroadcastChannel : globalThis.BroadcastChannel;
    if (!Channel) return;
    try {
      channel = new Channel(channelName);
      channel.unref?.();
      channel.onmessage = () => { if (active) readPlan().then(publish).catch(() => {}); };
    } catch { /* Compare-and-swap inside IDB remains safe without broadcast support. */ }
  }
  async function ready() {
    if (initializing) return initializing;
    initializing = (async () => {
      const db = await open();
      const storage = legacyStorage();
      let raw;
      let migrated;
      try { raw = storage?.getItem(legacyKey) ?? null; } catch { raw = null; }
      if (raw !== null) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed?.version !== 1 || !Array.isArray(parsed.courses)) throw new Error('旧校园备份格式错误。');
          migrated = normalizePlan(parsed);
        } catch { legacyCorrupt = { raw }; }
      }
      let committedLegacy = false;
      await transaction(db, 'readwrite', (record) => {
        if (record !== undefined || !migrated) return { record, write: false };
        committedLegacy = true;
        return { record: { revision: 1, data: migrated }, write: true };
      });
      if (committedLegacy) {
        // Remove only the exact legacy value successfully committed above.
        try { if (storage?.getItem(legacyKey) === raw) storage.removeItem(legacyKey); } catch { /* recoverable leftover */ }
        legacyCorrupt = undefined;
      }
      connectChannel();
    })().catch((error) => { initializing = undefined; throw error; });
    return initializing;
  }
  async function readPlan() {
    await ready();
    const db = await open();
    return snapshot(await transaction(db, 'readonly', (record) => ({ record, write: false })));
  }
  async function writePlan(data, expectedRevision) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('保存计划需要上次读取的有效版本号。');
    const normalized = normalizePlan(data);
    await ready();
    const db = await open();
    const record = await transaction(db, 'readwrite', (current) => {
      const actual = revisionOf(current);
      if (actual !== expectedRevision) throw conflict(expectedRevision, actual);
      if (actual === Number.MAX_SAFE_INTEGER) throw new Error('计划版本号已达到上限，请导出备份后重建数据库。');
      return { record: { revision: actual + 1, data: normalized }, write: true };
    });
    const state = snapshot(record);
    removeLegacy();
    publish(state);
    try { channel?.postMessage({ revision: state.revision }); } catch { /* committed data is available on the next read */ }
    return state;
  }
  async function clearPlan(expectedRevision) {
    return writePlan(normalizePlan(), expectedRevision);
  }
  function subscribePlan(fn) {
    if (typeof fn !== 'function') throw new TypeError('订阅需要回调函数。');
    subscribers.add(fn);
    ready().catch(() => {});
    return () => subscribers.delete(fn);
  }
  function close() {
    active = false;
    channel?.close();
    connection?.close();
    channel = undefined;
    connection = undefined;
    subscribers.clear();
  }
  return { ready, readPlan, writePlan, clearPlan, subscribePlan, close };
}

const defaultStore = createPlanStore();
export const ready = () => defaultStore.ready();
export const readPlan = () => defaultStore.readPlan();
export const writePlan = (data, expectedRevision) => defaultStore.writePlan(data, expectedRevision);
export const clearPlan = (expectedRevision) => defaultStore.clearPlan(expectedRevision);
export const subscribePlan = (fn) => defaultStore.subscribePlan(fn);
