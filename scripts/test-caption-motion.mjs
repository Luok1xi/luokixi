import test from 'node:test';
import assert from 'node:assert/strict';
import {captionSpring,createCaptionMotion} from '../src/js/caption-motion.js';
import {dialogueRuns} from '../src/js/stage-playback.js';

test('long subtitle DOM is bounded, Unicode and original text survive intact',()=>{
  for(const text of ['你好，「嗯。」👩‍💻\n再见。','A'.repeat(699),'一二三，四五六！'.repeat(100),'👨‍👩‍👧‍👧'.repeat(80),'']){
    const {runs,duration}=dialogueRuns(text);
    assert.equal(runs.map(run=>run.text).join(''),text);
    assert.ok(runs.length<=24);
    assert.ok(duration<=2780);
    assert.ok(runs.every((run,i)=>i===0||run.delay>=runs[i-1].delay));
    assert.ok(runs.every(run=>!run.text.includes('\uFFFD')));
  }
  const long=dialogueRuns('长'.repeat(699)).runs;
  assert.equal(new Set(long.map(run=>run.delay)).size,long.length,'long text has paced groups, not a single late dump');
});

test('spring has a bounded tap, physical velocity and converges without a perpetual frame loop',()=>{
  const plan=captionSpring(0,-90);
  assert.equal(plan.sample(0).position,0);
  assert.equal(plan.sample(0).velocity,-90);
  assert.ok(plan.duration<300);
  assert.ok(plan.frames.length<38);
  assert.deepEqual(plan.sample(plan.duration),{position:0,velocity:0});
  let maximum=0;
  for(let ms=0;ms<600;ms++)maximum=Math.max(maximum,Math.abs(plan.sample(ms).position));
  assert.ok(maximum<2);
  const at=plan.sample(55),next=captionSpring(at.position,at.velocity);
  assert.equal(next.sample(0).position,at.position,'interruption preserves presentation position');
  assert.equal(next.sample(0).velocity,at.velocity,'interruption preserves velocity');
  assert.throws(()=>captionSpring(NaN,0));
});

test('rapid advancement replaces only one compositor animation without resetting position',()=>{
  const animations=[];
  const element={animate(frames,options){const item={frames,options,currentTime:0,canceled:false,cancel(){this.canceled=true;}};animations.push(item);return item;}};
  let reduced=false;
  const motion=createCaptionMotion(element,()=>reduced);
  motion.tap();
  const first=animations[0];first.currentTime=45;
  const expected=captionSpring(0,-90).sample(45).position;
  motion.tap();
  assert.ok(first.canceled);
  assert.equal(animations.filter(item=>!item.canceled).length,1);
  assert.equal(animations[1].frames[0].transform,`translateY(${expected.toFixed(5)}px)`);
  const current=animations[1];
  first.onfinish();assert.equal(current.canceled,false,'stale completion cannot cancel the current spring');
  for(let i=0;i<30;i++){animations.at(-1).currentTime=4;motion.tap();}
  assert.equal(animations.filter(item=>!item.canceled).length,1);
  const maximum=Math.max(...animations.at(-1).frames.map(frame=>Math.abs(parseFloat(frame.transform.slice(11)))));
  assert.ok(maximum<4,'rapid taps cannot shake the reading surface');
  reduced=true;motion.tap();assert.equal(animations.filter(item=>!item.canceled).length,0);
  motion.stop();
});
