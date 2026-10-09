import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,sep} from 'node:path';
import {Store} from '../src/store.mjs';
import {characterCard,characterCardPrompt,characterNames,migrateCharacterIdentity} from '../src/character-card.mjs';
import {dialogueFrame,writerPrompt} from '../src/dialogue.mjs';

for(const previous of [
  {name:'Miku',version:0,idea:'想把机械少女的日常写成一小段文字'},
  {name:'墨玉',version:1,idea:'想把小窑鼠在校园里的小发现写成一小段文字'}
])test(`${previous.name} upgrades in the existing store without losing history or relationship`,()=>{
  const dir=mkdtempSync(join(tmpdir(),'beikuang-identity-')),file=join(dir,'state.sqlite');let store;
  try{
    store=new Store(file,1000);const state=store.read();
    Object.assign(state.persona,{identityVersion:previous.version,stage:'close',paused:true});
    state.persona.stable.name=previous.name;state.persona.stable.address='老朋友';
    state.persona.relationship.trust=.78;state.persona.emotions.concerned=.4;
    state.persona.inner.styleRules=[{id:'style',rule:'别每次追问',source:'用户明确要求'}];
    state.persona.inner.projects=[{id:'small-creation',title:previous.idea},{id:'custom',title:'我自己起的题目'}];
    state.memories=[{id:'memory',content:'测试记忆',source:'测试输入'}];
    state.tasks=[{id:'task',title:'测试任务',remaining:30}];
    store.save(state);store.addChat('assistant','以前叫 '+previous.name,1000);store.close();
    store=new Store(file,1010);const current=store.read();
    assert.equal(current.persona.stable.name,characterCard.name);
    assert.equal(current.persona.identityVersion,characterCard.identityVersion);
    assert.deepEqual(current.persona.stable.traits,characterCard.stable.traits);
    assert.equal(current.persona.stable.address,'老朋友');assert.equal(current.persona.stage,'close');assert.equal(current.persona.paused,true);
    assert.deepEqual(current.persona.relationship,state.persona.relationship);
    assert.deepEqual(current.persona.emotions,state.persona.emotions);
    assert.deepEqual(current.persona.inner.styleRules,state.persona.inner.styleRules);
    assert.deepEqual(current.tasks,state.tasks);assert.deepEqual(current.memories,state.memories);
    assert.equal(store.chats()[0].text,'以前叫 '+previous.name);
    assert.ok(current.persona.formerNames.includes(previous.name));
    assert.equal(current.persona.inner.projects[0].title,characterCard.stable.creationIdea);
    assert.equal(current.persona.inner.projects[1].title,'我自己起的题目');
    assert.equal(migrateCharacterIdentity(current.persona,1020),false);
  }finally{store?.close();assert.ok(realpathSync(dir).startsWith(realpathSync(tmpdir())+sep+'beikuang-identity-'));rmSync(dir,{recursive:true,force:true});}
});

test('live writer and QQ import use the same current personality without transport instructions',()=>{
  const store=new Store(':memory:',1000);
  try{
    const state=store.read(),prompt=writerPrompt(state,dialogueFrame(state,'你是谁'),1000,{});
    assert.ok(prompt.includes(characterCardPrompt));
    assert.ok(!prompt.includes('当前表达方向是温柔、单纯、可爱、开朗'));
    for(const alias of ['Miku','墨玉','北矿娘','小煤渣'])assert.ok(characterNames.includes(alias));
    const role=readFileSync(new URL('../roles/小煤渣.md',import.meta.url),'utf8');
    for(const key of ['identity','personality','voice','care','self','interests','lore'])assert.ok(role.includes(characterCard[key]));
    assert.ok(role.length<6000);assert.doesNotMatch(role,/\[SILENT\]|qq_send_message|qq_mark_read/);
  }finally{store.close();}
});
