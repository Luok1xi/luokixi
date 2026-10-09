import test from 'node:test';
import assert from 'node:assert/strict';
import {newPersona} from '../src/persona.mjs';
import {ensureInnerLife,reflectTurn} from '../src/motivation.mjs';
import {migrateCharacterVoice,activeStyleRules,voiceVersion} from '../src/character-card.mjs';
import {dialogueFrame,dialogueContext} from '../src/dialogue.mjs';

test('voice migration retires conflicting style instructions while preserving relationship, feelings and their sources',()=>{
  const p=newPersona(1000);p.voiceVersion=1;p.stable.traits=['高冷','轻傲娇'];p.stable.address='小明';p.stage='close';p.emotions.annoyed=.3;p.conflicts=[{id:'c',source:'a real event',resolved:false}];
  ensureInnerLife(p,1000).styleRules=[{id:'legacy',rule:'嘴硬，不要撒娇',source:'旧风格请求'}];
  const previous=structuredClone(p);assert.equal(migrateCharacterVoice(p,1100),true);
  assert.deepEqual(p.relationship,previous.relationship);assert.deepEqual(p.conflicts,previous.conflicts);assert.deepEqual(p.emotions,previous.emotions);assert.equal(p.stable.address,'小明');assert.equal(p.stage,'close');assert.equal(p.inner.styleRules[0].source,'旧风格请求');assert.deepEqual(activeStyleRules(p),[]);assert.equal(migrateCharacterVoice(p,1200),false);assert.equal(p.inner.styleRules[0].supersededAt,1100);
  const s={persona:p,chat:[],tasks:[],memories:[],episodes:[],summaries:[]};assert.deepEqual(dialogueContext(s,dialogueFrame(s,'在吗')).preferences,[]);
});
test('new explicit tone preferences remain usable after migrating the former voice',()=>{
  const p=newPersona(1000);ensureInnerLife(p,1000);reflectTurn(p,{message:'回复温柔一点',styleLearning:{evidence:'回复温柔一点',rule:'温柔回应'},now:1000,id:'style-1'});
  assert.equal(activeStyleRules(p).length,1);assert.equal(activeStyleRules(p)[0].voiceVersion,voiceVersion);assert.equal(migrateCharacterVoice(p,1200),false);assert.equal(activeStyleRules(p)[0].rule,'温柔回应');
});

test('a card upgrade retains explicit preferences and recovers only raw evidence from the old blanket retirement',()=>{
  const p=newPersona(1000);ensureInnerLife(p,1000);p.voiceVersion=1;
  p.inner.styleRules=[{id:'explicit',kind:'user-style-preference',source:'说话自然点',rule:'自然口语'},
    {id:'old',kind:'user-style-preference',source:'别这样冷淡',rule:'不要撒娇或追问',supersededAt:900},
    {id:'retired',kind:'user-style-preference',source:'以前的要求',rule:'旧风格',supersededAt:900,supersededBy:'user'}];
  migrateCharacterVoice(p,1100);
  const active=activeStyleRules(p);
  assert.deepEqual(active.map(r=>r.rule),['自然口语','别这样冷淡']);
  assert.equal(active[1].restoredFromSource,true);
  assert.equal(p.inner.styleRules[1].supersededAt,900,'historical evidence remains auditable');
});
