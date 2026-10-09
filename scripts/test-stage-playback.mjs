import test from 'node:test';
import assert from 'node:assert/strict';
import {StagePlayback,dialogueGlyphs} from '../src/js/stage-playback.js';
import {stageLines} from '../campus/stage-catalog.js';
const line=id=>({id,text:id,speech:'うん。',seat:'codex'});
test('history is silent; polling and batches keep each new message once, including rapid following replies',()=>{
  const q=new StagePlayback();q.ingest([line('old')]);assert.equal(q.next(),undefined);
  q.ingest([line('old'),line('one'),line('two')]);assert.equal(q.next().id,'one');
  q.ingest([line('old'),line('one'),line('two'),line('three')]);
  q.ingest([line('three'),line('two'),line('one')]);
  assert.equal(q.next().id,'two');assert.equal(q.next().id,'three');assert.equal(q.next(),undefined);
  const reopened=new StagePlayback();reopened.ingest(q.lines);assert.equal(reopened.next(),undefined);
});
test('studio retains model message boundaries, Japanese and expression',()=>{
  const lines=stageLines([{id:'r',messages:[{id:1,seat:'codex',body:'first\nsecond',expression:'neutral',messages:[{type:'text',text:'第一句',speech:'一つ目。',expression:'think'},{type:'sticker',id:'think'},{type:'text',text:'第二句',speech:'二つ目。',expression:'happy'}]}]}]);
  assert.deepEqual(lines.map(l=>[l.text,l.speech,l.emotion]),[['第一句','一つ目。','think'],['第二句','二つ目。','happy']]);
  assert.equal(new Set(lines.map(l=>l.id)).size,2);
});
test('game punctuation grouping preserves graphemes and bounds long dialogue reveal',()=>{
  const text='你看，「嗯。」👩‍💻';const r=dialogueGlyphs(text);
  assert.equal(r.groups.flat().map(x=>x.char).join(''),text);
  assert.ok(r.groups.some(g=>g.map(x=>x.char).join('')==='「嗯。」'));
  assert.ok(dialogueGlyphs('长'.repeat(1000)).duration<=2780);
});

test('read history never contains queued unseen dialogue and polling cannot remove it',()=>{
 const q=new StagePlayback();q.ingest([line('old')]);q.ingest([line('old'),line('a'),line('b')]);
 assert.deepEqual(q.history.map(l=>l.id),['old']);q.next();
 q.ingest([line('b'),line('c')]);assert.deepEqual(q.history.map(l=>l.id),['old','a']);
 assert.deepEqual([q.next().id,q.next().id],['b','c']);assert.equal(q.next(),undefined);
 assert.deepEqual(q.history.map(l=>l.id),['old','a','b','c']);
});
