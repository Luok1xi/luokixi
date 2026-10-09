import test from 'node:test';
import assert from 'node:assert/strict';
import { indexedDB } from 'fake-indexeddb';
import { normalizeSource, savePrivateResource, listPrivateResources, deletePrivateResource,
  searchPrivateResources, exportPrivateResourceIndex } from '../src/js/private-resources.js';

globalThis.indexedDB = indexedDB;
let networkCalls = 0;
globalThis.fetch = () => { networkCalls++; throw new Error('Private storage must not use network'); };
const base = { title: '私人的课堂笔记', summary: '从矩阵乘法开始，尚未公开的研究想法', sourceUrl: 'https://example.edu/notes',
  learning: { school: 'wrong-school', courseId: 'linear-algebra', materialType: 'notes', version: '第 1 版' } };

test('DOI exact identity and restricted protocols', () => {
  assert.deepEqual(normalizeSource('DOI: 10.1234/ABC'), { sourceUrl: 'https://doi.org/10.1234/abc', doi: '10.1234/abc' });
  assert.deepEqual(normalizeSource('https://doi.org/10.1234/ABC'), normalizeSource('10.1234/abc'));
  assert.throws(() => normalizeSource('javascript:alert(1)'));
  assert.throws(() => normalizeSource('https://name:password@example.edu'));
  assert.notEqual(normalizeSource('https://example.edu/a?v=1').sourceUrl, normalizeSource('https://example.edu/a?v=2').sourceUrl);
});

test('save/reload stays local, deduplicates same version, preserves different version', async () => {
  const first = await savePrivateResource({ ...base, unexpectedSecret: 'should not persist' });
  const duplicate = await savePrivateResource(base);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.item.id, first.item.id);
  const otherVersion = await savePrivateResource({ ...base, learning: { ...base.learning, version: '第 2 版' } });
  assert.equal(otherVersion.duplicate, false);
  const items = await listPrivateResources();
  assert.equal(items.length, 2);
  assert.equal(items[0].learning.school, 'cumtb');
  assert.equal(items[0].unexpectedSecret, undefined);
  assert.equal(networkCalls, 0);
});

test('same filenames are not file identity, exact bytes deduplicate', async () => {
  const input = { ...base, sourceUrl: '', fileName: 'notes.txt', fileBlob: new Blob(['a private note']) };
  const first = await savePrivateResource(input);
  const same = await savePrivateResource({ ...input, fileName: 'renamed.txt' });
  assert.equal(same.duplicate, true);
  assert.equal(same.item.id, first.item.id);
  const other = await savePrivateResource({ ...input, fileBlob: new Blob(['different private bytes']) });
  assert.equal(other.duplicate, false);
  const restored = (await listPrivateResources()).find(x => x.id === first.item.id);
  assert.equal(await restored.fileBlob.text(), 'a private note');
  assert.equal(networkCalls, 0);
});

test('local search and explicit export never include private notes or file bytes', async () => {
  const items = await listPrivateResources();
  assert.ok(searchPrivateResources(items, '矩阵 研究').length);
  assert.equal(searchPrivateResources(items, 'not-present').length, 0);
  const exported = exportPrivateResourceIndex(items);
  assert.equal(exported.format, 'luokixi-private-resource-index');
  assert.deepEqual(Object.keys(exported.items[0]).sort(), ['courseId', 'doi', 'id', 'offeringId', 'sourceUrl']);
  assert.ok(!JSON.stringify(exported).includes('private note'));
  assert.ok(!JSON.stringify(exported).includes('未公开'));
  assert.equal(networkCalls, 0);
});

test('deletion persists without affecting remaining local items', async () => {
  const before = await listPrivateResources();
  await deletePrivateResource(before[0].id);
  const after = await listPrivateResources();
  assert.equal(after.length, before.length - 1);
  assert.ok(after.every(x => x.id !== before[0].id));
});

test('storage unavailable and oversized files fail clearly without upload', async () => {
  globalThis.indexedDB = undefined;
  await assert.rejects(listPrivateResources, /本地文件存储/);
  globalThis.indexedDB = indexedDB;
  await assert.rejects(savePrivateResource({ ...base, fileBlob: new Blob([new Uint8Array(25 * 1024 * 1024 + 1)]) }), /25 MB/);
  assert.equal(networkCalls, 0);
});
