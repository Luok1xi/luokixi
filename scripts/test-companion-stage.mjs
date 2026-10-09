import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {stageCast,stagePose,stageLines,stageTurn} from '../campus/stage-catalog.js';
import {createBrowserVoice} from '../campus/companion/public/voice-ui.js';

test('stage uses owner art, validated poses and real operational state',()=>{
 for(const actor of Object.values(stageCast))for(const path of Object.values(actor.poses))assert.ok(existsSync(new URL('../public'+path,import.meta.url)));
 assert.equal(stagePose('codex','angry').pose,'angry');assert.equal(stagePose('codex','happy','thinking').pose,'think');
 assert.equal(stagePose('codex','unsupported').pose,'neutral');assert.equal(stagePose('beikuang','angry').pose,'angry','uses the new costume expression edit');
 assert.equal(stagePose('unknown'),null);
 const run={state:'running',seats:['beikuang','codex'],messages:[{seat:'beikuang'}]};
 assert.equal(stageTurn(run),'codex');assert.equal(stageTurn({...run,state:'completed'}),null);
});
test('stage history keeps real order and selected expression, without inventing old emotions',()=>{
 const runs=[{id:'new',messages:[{id:2,seat:'codex',body:'新回复',expression:'composed'},{id:3,seat:'design',body:'不是这两位'}]},
 {id:'old',messages:[{id:1,seat:'beikuang',body:'旧回复'}]}];
 const result=stageLines(runs);assert.deepEqual(result.map(l=>l.text),['旧回复','新回复']);
 assert.equal(result[0].emotion,'neutral');assert.equal(result[1].emotion,'composed');assert.equal(runs[0].id,'new');
});
test('original browser voice is opt-in, cancellable, ignores stale callbacks and resolves interruption',async()=>{
 const oldWindow=globalThis.window,oldUtterance=globalThis.SpeechSynthesisUtterance;const queue=[],events=[];
 globalThis.window={speechSynthesis:{cancel(){},getVoices:()=>[{lang:'zh-CN'}],speak(u){queue.push(u);}}};
 globalThis.SpeechSynthesisUtterance=class{constructor(text){this.text=text;}};
 try{
  const voice=createBrowserVoice({onState:s=>events.push(s)});assert.equal(queue.length,0);
  const first=voice.say('第一句');queue[0].onstart();assert.equal(events.at(-1),'speaking');
  const second=voice.say('第二句');await first;queue[0].onend();assert.equal(voice.speaking,true);
  queue[1].onstart();voice.stop();await second;assert.equal(voice.speaking,false);
  queue[1].onerror({error:'interrupted'});assert.equal(events.at(-1),'idle');
 }finally{globalThis.window=oldWindow;globalThis.SpeechSynthesisUtterance=oldUtterance;}
});
