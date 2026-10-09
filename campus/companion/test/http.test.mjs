import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createApp} from '../src/server.mjs';
test('local HTTP authentication, CRUD, no secret exposure and export',async()=>{const app=await createApp({dbPath:':memory:',background:false});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;
  try{let res=await fetch(base+'/api/bootstrap');const cookie=res.headers.get('set-cookie').split(';')[0],boot=await res.json();assert.ok(boot.csrf);assert.equal(boot.config.deepseekKey,undefined);
    res=await fetch(base+'/api/command',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'replan'})});assert.equal(res.status,403);
    res=await fetch(base+'/api/command',{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie,'X-Miku-Token':boot.csrf},body:JSON.stringify({action:'task.add',args:{title:'HTTP test',remaining:60,deadline:'2026-12-31 12:00'},requestId:'http-1'})});assert.equal(res.status,200);assert.match((await res.json()).message,/HTTP test/);
    res=await fetch(base+'/api/state',{headers:{Cookie:cookie,Origin:'https://evil.example'}});assert.equal(res.status,403);
    const hostileStatus=await new Promise((done,reject)=>{http.get(base+'/api/state',{headers:{Cookie:cookie,Host:'evil.example'}},r=>{r.resume();done(r.statusCode);}).on('error',reject);});assert.equal(hostileStatus,403);
    res=await fetch(base+'/api/export',{headers:{Cookie:cookie}});const exported=await res.json();assert.equal(exported.state.tasks.length,1);assert.equal(exported.config,undefined);
    res=await fetch(base+'/');assert.equal(res.status,200);assert.ok((await res.text()).includes(boot.character.name));
  }finally{await app.close();}
});
