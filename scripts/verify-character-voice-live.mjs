// Local, owner-authenticated TTS only. No chat/model calls or publication.
import {request} from 'playwright';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const phase=process.env.VOICE_PHASE||'after';
assert.ok(['before','after','shinsekai'].includes(phase));
const dir='campus/.data/voice-verification-20261009',base='http://127.0.0.1:17860';
await mkdir(dir,{recursive:true});
const client=await request.newContext({baseURL:base,timeout:310000});
try{
 let s=await (await client.get('/api/hub/auth/session')).json();
 const secret=await readFile('campus/.data/hub/owner-private/developer-account.txt','utf8');
 const email=secret.match(/登录邮箱（仅本机占位）：([^\r\n]+)/)?.[1]?.trim();
 const password=secret.match(/初始密码：([^\r\n]+)/)?.[1]?.trim();
 assert.ok(email&&password,'local owner credential exists');
 const login=await client.post('/api/hub/auth/login',{headers:{'X-CSRFToken':s.csrfToken,Origin:base},data:{email,password}});
 assert.ok(login.ok(),'local login');s=await (await client.get('/api/hub/auth/session')).json();
 const status=await (await client.get('/api/hub/studio/voice')).json();
 assert.equal(status.voice,'七海千秋');
 const text='お疲れさま。今日は資料の整理を進めて、見つかった問題も確認しておくね。終わったら、まとめて知らせるよ。';
 const start=Date.now();
 const response=await client.post('/api/hub/studio/voice',{headers:{'X-CSRFToken':s.csrfToken,Origin:base},data:{text,seat:'beikuang',language:'ja',expression:'neutral'}});
 const data=await response.json();assert.ok(response.ok(),data.error||'voice API failed');
 const bytes=Buffer.from(data.audio,'base64');assert.equal(bytes.toString('ascii',0,4),'RIFF');assert.ok(bytes.length>4000);
 await writeFile(`${dir}/${phase}.wav`,bytes);
 const report={phase,text,status,elapsedMs:Date.now()-start,bytes:bytes.length,cached:data.cached};
 if(phase==='shinsekai'){
  assert.deepEqual(status.tuning,{text_split_method:'cut5'});
  const decorated=await client.post('/api/hub/studio/voice',{headers:{'X-CSRFToken':s.csrfToken,Origin:base},data:{text:'（息を吸う）'+text+' *うなずく*',seat:'beikuang',language:'ja',expression:'neutral'}});
  const cleaned=await decorated.json();assert.ok(decorated.ok());assert.equal(cleaned.cached,true);
  assert.deepEqual(Buffer.from(cleaned.audio,'base64'),bytes);report.actionDescriptionsExcluded=true;
 }
 await writeFile(`${dir}/${phase}.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await client.dispose();}
