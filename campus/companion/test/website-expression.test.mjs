import test from 'node:test';
import assert from 'node:assert/strict';
import {parseChain} from '../src/message-chain.mjs';
import {bingSearch,sanitizeQuery} from '../vendor/qq-bridge/search.js';
import {isPrivateIp} from '../vendor/qq-bridge/safe-fetch.js';
test('per-line expression is retained without changing text or accepting unknown actions',()=>{
 const r=parseChain(JSON.stringify({messages:[{type:'text',text:'真好。',expression:'happy'},{type:'text',text:'让我想想。',expression:'think'},{type:'text',text:'照常说。',expression:'delete_database'}]}));
 assert.equal(r.messages[0].expression,'happy');assert.equal(r.messages[1].expression,'think');assert.equal(r.messages[2].expression,undefined);assert.equal(r.messages[2].text,'照常说。');
});
test('QQ Bridge public search cleans query and keeps public URL provenance',async()=>{
 assert.equal(sanitizeQuery('[CQ:at,qq=123] 查资料'),'查资料');
 const r=await bingSearch('公开资料',async()=>({statusCode:200,body:'<li class="b_algo"><h2><a href="https://example.org/book">公开资料</a></h2><p>简介</p></li>'}));
 assert.equal(r.results[0].url,'https://example.org/book');assert.equal(r.results[0].title,'公开资料');
 for(const ip of ['127.0.0.1','192.168.1.2','::1','::ffff:127.0.0.1'])assert.equal(isPrivateIp(ip),true);
 assert.equal(isPrivateIp('1.1.1.1'),false);
});
