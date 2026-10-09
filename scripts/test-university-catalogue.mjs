import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUniversityCatalogue, filterUniversityResources, universityCounts, selectionPayload } from '../src/js/university-catalogue.js';

// Deliberately synthetic inputs. These never enter the catalogue or production database.
const catalogue = () => normalizeUniversityCatalogue({
  schools:[{id:'a',name:'测试985院校',groups:['985','211']},{id:'b',name:'测试特色院校',groups:['strong-non-211']}],
  sources:[{id:'a-s',name:'测试来源A',schoolId:'a',url:'https://example.org/a',checkedAt:'2026-10-07T00:00:00Z'}],
  resources:[
    {id:'a-1',sourceId:'a-s',schoolId:'a',title:'同名习题',course:'高等数学',year:2024,kind:'exam',state:'indexed',bankId:'missing',questionCount:999},
    {id:'a-2',sourceId:'a-s',schoolId:'a',title:'答案',course:'高等数学',year:2024,kind:'answer',state:'downloaded',bankId:null},
    {id:'a-3',sourceId:'a-s',schoolId:'a',title:'同名习题',course:'高等数学',year:2024,kind:'exercise',state:'extracted',bankId:'bank-a'},
    {id:'b-1',schoolId:'b',title:'同名习题',course:'数据结构',year:2022,kind:'notes',state:'extracted'},
    {id:'b-2',schoolId:'b',title:'目录介绍',course:'unknown',year:null,kind:'article',state:'indexed'},
    {id:'b-2',schoolId:'b',title:'重复ID不能变成两份资料',state:'indexed'},
  ],
  questionBanks:[{id:'bank-a',schoolId:'a',title:'真实结构化摘要',questionCount:3},{id:'bank-empty',questionCount:0},{id:'standalone',schoolId:'b',title:'没有重复原件索引的题库',questionCount:2}],
});

test('directory text and untrusted questionCount never become selectable questions',()=>{
  const data=catalogue();
  const metadata=data.resources.find(r=>r.id==='a-1');
  assert.equal(metadata.phase,'indexed');assert.equal(metadata.bankId,'');assert.equal(metadata.questionCount,0);
  assert.equal(data.resources.find(r=>r.id==='b-1').phase,'extracted');
  assert.equal(data.resources.find(r=>r.id==='a-3').phase,'structured');
});
test('same titles across schools remain distinct while repeated IDs deduplicate',()=>{
  const data=catalogue();
  assert.equal(data.resources.filter(r=>r.id==='b-2').length,1);
  assert.equal(data.resources.filter(r=>r.title==='同名习题').length,3);
});
test('985 resources also belong to 211, specialist filter is separate',()=>{
  const data=catalogue();
  assert.equal(filterUniversityResources(data.resources,{group:'211'}).length,3);
  assert.equal(filterUniversityResources(data.resources,{group:'985'}).length,3);
  assert.equal(filterUniversityResources(data.resources,{group:'specialist'}).length,3);
});
test('school course year kind filters intersect without cross-school leakage',()=>{
  const rows=filterUniversityResources(catalogue().resources,{school:'a',course:'高等数学',year:'2024',kind:'answer'});
  assert.deepEqual(rows.map(r=>r.id),['a-2']);
  assert.equal(filterUniversityResources(catalogue().resources,{school:'b',course:'高等数学'}).length,0);
});
test('unknown values remain explicit instead of inferred from unrelated fields',()=>{
  const rows=filterUniversityResources(catalogue().resources,{year:'__unknown',course:'__unknown',kind:'unknown'});
  assert.deepEqual(rows.map(r=>r.id),['b-2']);
  assert.equal(rows[0].course,'');assert.equal(rows[0].year,'');
});
test('have-original includes extracted and structured originals',()=>{
  const rows=filterUniversityResources(catalogue().resources,{phase:'downloaded'});
  assert.deepEqual(rows.map(r=>r.id),['a-2','a-3','b-1']);
});
test('counts keep metadata, files, and unique structured questions separate',()=>{
  const data=catalogue();
  assert.deepEqual(universityCounts(data.resources),{resources:6,schools:2,originals:3,banks:2,questions:5});
  assert.equal(universityCounts([...data.resources,data.resources.find(r=>r.bankId==='bank-a')]).questions,5);
});
test('selecting duplicate local IDs from different banks preserves provenance',()=>{
  const selection=new Map([['bank-a',new Set(['q1','q2'])],['bank-b',new Set(['q1'])],['empty',new Set()]]);
  assert.deepEqual(selectionPayload(selection),{bankIds:['bank-a','bank-b'],questionIds:[{bankId:'bank-a',questionId:'q1'},{bankId:'bank-a',questionId:'q2'},{bankId:'bank-b',questionId:'q1'}]});
});
test('empty and malformed catalogue arrays degrade to zero, not invented counts',()=>{
  assert.deepEqual(universityCounts(normalizeUniversityCatalogue().resources),{resources:0,schools:0,originals:0,banks:0,questions:0});
  assert.equal(normalizeUniversityCatalogue({resources:'not-an-array',schools:null,questionBanks:[{id:'a',questionCount:-1}]}).resources.length,0);
});
