import test from 'node:test';
import assert from 'node:assert/strict';
import { filterDiscovery, projectTopics } from '../src/js/discover-filters.js';
const rows = [
 {title:'Robot Firmware',repository:'student/robot',category:'embedded',shelf:'practical',tags:['STM32']},
 {title:'Notebook',repository:'campus/notebook',category:'software',idea:'日常笔记与待办',shelf:'creative'},
 {title:'Linear Algebra',repository:'course/linalg',category:'course'},
 {title:'Renderer 2024',repository:'cs/renderer',category:'software'},
];
test('editorial and subject indexes share the catalogue without altering identities',()=>{
 assert.deepEqual(filterDiscovery(rows,{shelf:'cs'}).map(x=>x.repository),['campus/notebook','cs/renderer']);
 assert.equal(filterDiscovery(rows,{shelf:'daily'})[0],rows[1]);
 assert.equal(filterDiscovery(rows,{shelf:'embedded'})[0],rows[0]);
 assert.equal(filterDiscovery(rows,{shelf:'practical'})[0],rows[0]);
 assert.equal(filterDiscovery(rows,{shelf:'all',hidden:['student/robot']}).length,3);
});
test('inline search combines typo/alias matching with current category and respects numbers',()=>{
 assert.equal(filterDiscovery(rows,{query:'Notebok'})[0],rows[1]);
 assert.equal(filterDiscovery(rows,{query:'线代'})[0],rows[2]);
 assert.equal(filterDiscovery(rows,{shelf:'embedded',query:'Notebok'}).length,0);
 assert.equal(filterDiscovery(rows,{query:'Renderer 2025'}).length,0);
 assert.ok(projectTopics(rows[0]).includes('embedded'));
});
