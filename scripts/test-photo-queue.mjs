import test from 'node:test';
import assert from 'node:assert/strict';
import {createPhotoQueue} from '../src/js/photo-queue.js';
import {projectImage, institutionIcon} from '../src/js/project-image.js';
const photo = (n) => new File(['photo'+n], n+'.png', {type:'image/png',lastModified:n});

test('consecutive selections append, duplicates do not replace, and a tenth image preserves nine', () => {
  const errors=[], q=createPhotoQueue({onError:e=>errors.push(e)});
  q.add([photo(1)]); q.add([photo(2),photo(3)]); q.add([photo(1)]);
  assert.equal(q.files().length,3);
  q.add(Array.from({length:7},(_,i)=>photo(i+4)));
  assert.equal(q.files().length,9); assert.equal(errors.length,2); q.destroy();
});
test('failed upload keeps photos and receipts; retry does not reupload completed files, order is explicit', async () => {
  const q=createPhotoQueue(); q.add([photo(1),photo(2),photo(3)]);
  let calls=0;
  await assert.rejects(q.uploadAll(async()=>{ calls++; if(calls===2)throw Error('offline'); return {id:'first'}; }),/offline/);
  const ids=await q.uploadAll(async()=>({id:'uploaded-'+ ++calls}));
  assert.deepEqual(ids,['first','uploaded-3','uploaded-4']); assert.equal(calls,4);
  q.move(q.files()[2].id,0);
  assert.deepEqual(await q.uploadAll(()=>{throw Error('should not upload');}),['uploaded-4','first','uploaded-3']);
  q.remove(q.files()[0].id); assert.equal(q.files().length,2); q.clear(); assert.equal(q.files().length,0); q.destroy();
});
test('file type and size validation reject unsupported uploads without losing selected photos', () => {
  const errors=[],q=createPhotoQueue({onError:e=>errors.push(e)}); q.add([photo(1), new File(['x'],'x.svg',{type:'image/svg+xml'})]);
  assert.equal(q.files().length,1); assert.equal(errors.length,1); q.destroy();
});
test('source image upgrades generated covers, preserves author covers, and Tsinghua never uses owner avatar', () => {
  const real={image:'/api/hub/source-media/'+'a'.repeat(64),credit:'README'};
  assert.equal(projectImage({cover:'art/projects/category-course.webp'},real).cover,real.image);
  assert.equal(projectImage({cover:'https://author.test/original.jpg'},real).cover,'https://author.test/original.jpg');
  assert.match(institutionIcon({title:'清华大学计算机系课程攻略',repo:{fullName:'PKUanonym/REKCARC-TSC-UHT'}}).src,/tsinghua/);
});
