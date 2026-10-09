import test from 'node:test';
import assert from 'node:assert/strict';
import {readerTarget,readerURL} from '../src/js/site-reader.js';
import {canParticipate} from '../src/js/hub.js';
test('reader maps stored documents, uploads, mirrors and structured questions',()=>{
  assert.deepEqual(readerTarget('/api/file/paper-123'),{kind:'document',id:'paper-123'});
  assert.deepEqual(readerTarget('/api/hub/uploads/abcd-123/file'),{kind:'upload',id:'abcd-123'});
  assert.deepEqual(readerTarget('/api/hub/mirror/abcd-123/file'),{kind:'mirror',id:'abcd-123'});
  assert.ok(readerURL('/api/hub/question-papers/collected/ub-123/json').includes('viewer.html?file='));
  for(const input of ['https://evil.test/file.pdf','/api/hub/auth/session','/files/../../api/hub/auth/session','javascript:alert(1)','/art/%252e%252e/secret'])assert.equal(readerTarget(input),null);
});
test('frontend uses actual server participation capability, not moderator role',()=>{
  assert.equal(canParticipate({emailVerified:false,canParticipate:true}),true);
  assert.equal(canParticipate({emailVerified:false,moderator:true}),false);
  assert.equal(canParticipate({emailVerified:true,canParticipate:false}),false);
});
