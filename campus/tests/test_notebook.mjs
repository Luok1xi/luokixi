import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createNotebook,normalizeProblemURL} from '../../src/js/community-notebook.js';
const make=()=>{const map=new Map();return createNotebook({getItem:k=>map.get(k)||null,setItem:(k,v)=>map.set(k,v)});};
test('normalizes platform URLs and rejects lookalike hosts',()=>{
  assert.equal(normalizeProblemURL('https://leetcode.cn/problems/two-sum/description/?x=1'),'https://leetcode.cn/problems/two-sum');
  assert.throws(()=>normalizeProblemURL('https://leetcode.cn.evil.test/problems/two-sum'));
  assert.throws(()=>normalizeProblemURL('https://a:b@leetcode.cn/problems/two-sum'));
});
test('notes survive export/import, duplicates preserve existing notes',()=>{
  const a=make(),b=make(),url='https://www.luogu.com.cn/problem/P1001';
  a.addProblem(url,'A+B');a.updateProblem(url,{status:'review',note:'记得处理输入。'});
  b.import(a.export());b.updateProblem(url,{status:'solved',note:'我的新笔记'});b.import(a.export());
  assert.equal(b.read().problems.length,1);assert.equal(b.read().problems[0].note,'我的新笔记');
});
test('malformed import does not partially write',()=>{
  const a=make();a.addProblem('https://leetcode.cn/problems/two-sum','两数之和');const before=a.export();
  assert.throws(()=>a.import({...before,problems:[...before.problems,{url:'javascript:alert(1)',status:'solved',title:'bad',note:''}]}));
  assert.equal(a.read().problems.length,1);
});
test('public profile links are validated and bookmarking toggles',()=>{
  const a=make();a.setProfiles({github:'https://github.com/example',luogu:'https://www.luogu.com.cn/user/123',leetcode:'https://leetcode.cn/u/example/'});
  assert.equal(a.read().profiles.leetcode,'https://leetcode.cn/u/example');
  assert.throws(()=>a.setProfiles({github:'https://evil.test/user'}));
  a.toggleProject('https://github.com/example/motor');a.toggleProject('https://github.com/example/motor');assert.equal(a.read().savedProjects.length,0);
});
test('a failed storage write surfaces an error instead of a success',()=>{
  const a=createNotebook({getItem:()=>null,setItem:()=>{throw new Error('quota');}});
  assert.throws(()=>a.addProblem('https://www.luogu.com.cn/problem/P1001','A+B'),/未能保存/);
});
