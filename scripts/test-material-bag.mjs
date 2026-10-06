import test from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'fflate';
import { buildMaterialZip, localFileURL, fileName, MAX_BYTES } from '../src/js/material-bag.js';
globalThis.location={href:'http://127.0.0.1:17860/materials.html'};
const item={id:'a',title:'线性代数 / 试卷',course:'线性代数',format:'pdf',url:'/api/file/qa-a',rights:'测试文件'};
test('ZIP retains bytes, UTF-8 filenames, provenance and deduplicates URLs',async()=>{
 let calls=0;const original=new TextEncoder().encode('%PDF-1.4\nTest only');
 const packed=await buildMaterialZip([item,{...item,id:'duplicate'}],{fetcher:async()=>{calls++;return new Response(original,{headers:{'Content-Type':'application/pdf'}});}});
 const files=unzipSync(packed);assert.equal(calls,1);assert.equal(Object.keys(files).length,2);
 const pdf=Object.keys(files).find(x=>x.endsWith('.pdf'));assert.ok(pdf.includes('线性代数'));assert.deepEqual(files[pdf],original);
 const source=JSON.parse(strFromU8(files['来源与许可.json']));assert.equal(source.files[0].rights,'测试文件');assert.equal(source.files[0].bytes,original.length);
});
test('restricted download targets reject external origins, auth and traversal',()=>{
 for(const url of ['https://evil.example/file.pdf','/api/hub/auth/session','/files/../../auth.html','javascript:alert(1)'])assert.throws(()=>localFileURL(url));
 assert.ok(localFileURL('/api/hub/uploads/01234567-abcd-1234-abcd-0123456789ab/file'));
 assert.equal(fileName('../../foo?.pdf'),'.._.._foo_.pdf');
});
test('missing, HTML and oversized files fail instead of creating misleading archives',async()=>{
 for(const response of [new Response('',{status:404}),new Response('<html>login</html>',{headers:{'Content-Type':'text/html'}}),new Response('a',{headers:{'Content-Length':String(MAX_BYTES+1)}})]){
  await assert.rejects(buildMaterialZip([item],{fetcher:async()=>response}));
 }
 await assert.rejects(buildMaterialZip(Array(31).fill(item)));
});
test('cancel stops file collection',async()=>{
 const c=new AbortController();c.abort();let fetched=false;
 await assert.rejects(buildMaterialZip([item],{signal:c.signal,fetcher:async()=>{fetched=true;}}),{name:'AbortError'});assert.equal(fetched,false);
});
