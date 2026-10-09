import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {WebsiteJobs} from '../website-jobs.mjs';
import {sentencePhrasing,gptSovitsTuning} from '../src/tts.mjs';

test('transport restart keeps completed replies and never repeats a running receipt',()=>{
 const db=new DatabaseSync(':memory:');try{
  const first=new WebsiteJobs(db);first.put('one',{state:'done',result:{text:'同一条回复',messages:[]}});
  first.put('two',{state:'running'});
  const restarted=new WebsiteJobs(db);
  assert.equal(restarted.get('one').result.text,'同一条回复');assert.equal(restarted.get('one').state,'done');
  assert.equal(restarted.get('two').state,'interrupted');assert.equal(restarted.get('missing'),null);
 }finally{db.close();}
});
test('Nanami natural phrasing retains commas without forcing a new synthesized fragment',()=>{
 const text='でも、今日は大丈夫。まず、資料を確認するね！';
 assert.equal(sentencePhrasing(text),'でも、今日は大丈夫。\nまず、資料を確認するね！');
 const profile=gptSovitsTuning({ttsPhrasing:'sentence',ttsCompatibility:'shinsekai',ttsTuning:{fragment_interval:0.18}});
 assert.equal(profile.text_split_method,'cut0');assert.equal(profile.fragment_interval,.18);
 assert.equal(gptSovitsTuning({}).text_split_method,'cut5','Rem remains unchanged');
 assert.ok(sentencePhrasing(('資料を確認、').repeat(60)).split('\n').every(s=>[...s].length<=160));
});
