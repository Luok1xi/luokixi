import test from 'node:test';
import assert from 'node:assert/strict';
import {speechChunks,createCharacterSpeech} from '../src/js/character-speech.js';

test('long Japanese speech splits at clauses, preserves every character and bounds requests',()=>{
  const text='あ'.repeat(80)+'、'+'い'.repeat(60)+'。'+'う'.repeat(100)+'、'+'え'.repeat(40)+'👩‍💻';
  const chunks=speechChunks(text,120);
  assert.equal(chunks.join(''),text);
  assert.equal(chunks[0],'あ'.repeat(80)+'、');
  assert.ok(chunks.every(s=>[...s].length<=120));
  assert.deepEqual(speechChunks('うん、確認したよ。大丈夫。'),['うん、確認したよ。大丈夫。']);
  assert.deepEqual(speechChunks(''),[]);
  assert.throws(()=>speechChunks('あ'.repeat(601)),/自然停顿/);
  const longLine='確認しておくね。'.repeat(25);
  assert.deepEqual(speechChunks(longLine),[longLine],'normal dialogue stays one synthesis as in Shinsekai');
});

test('next chunk is prepared while current audio plays; interruption never starts it',async()=>{
  const saved={Audio:globalThis.Audio,fetch:globalThis.fetch,location:globalThis.location};
  let player,plays=0;const requests=[];
  globalThis.location={hostname:'127.0.0.1'};
  globalThis.Audio=class{constructor(){player=this;}pause(){}load(){}removeAttribute(){}async play(){plays++;}};
  globalThis.fetch=async(url,options)=>{
    if(url.endsWith('/auth/session'))return Response.json({csrfToken:'test'});
    requests.push(JSON.parse(options.body));return Response.json({audio:'UklGRg==',type:'audio/wav'});
  };
  const speech=createCharacterSpeech();
  try{
    const text='あ'.repeat(400)+'。'+'い'.repeat(400)+'。';
    const pending=speech.say(text,{language:'ja'});
    for(let n=0;n<20&&requests.length<2;n++)await new Promise(r=>setImmediate(r));
    assert.equal(requests.length,2);assert.equal(plays,1,'second synthesis starts before first playback ends');
    player.onended();
    for(let n=0;n<20&&plays<2;n++)await new Promise(r=>setImmediate(r));
    assert.equal(plays,2);assert.equal(requests.length,2,'prefetched audio reused');
    speech.stop();assert.equal((await pending).state,'cancelled');
    assert.equal(plays,2);
  }finally{speech.dispose();Object.assign(globalThis,saved);}
});
