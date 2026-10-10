import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WebsiteJobs,actionIdentity} from '../website-jobs.mjs';
import {WebsiteWorkflow,recoveredExecution} from '../website-workflow.mjs';
const Workflow=process.env.WORKFLOW_TEST_ENGINE==='langgraph'
  ?(await import('../website-langgraph.mjs')).WebsiteWorkflow:WebsiteWorkflow;

function fixture(t,callbacks={}) {
  const directory=mkdtempSync(join(process.env.WORKFLOW_TEST_TMP||tmpdir(),'website-workflow-'));
  const path=join(directory,'character.sqlite3'),db=new DatabaseSync(path);
  const journal=new WebsiteJobs(db),calls=[];
  const defaults={prepare:async()=>calls.push('prepare'),execute:async()=>{calls.push('execute');return {trace:[]};},
    recover:async()=>{calls.push('recover');return recoveredExecution(journal.actions('one'));},
    verify:async()=>{calls.push('verify');return {state:'completed'};},
    reply:async()=>{calls.push('reply');return {text:'已返回实际结果'};},
    recoverReply:async()=>{calls.push('recoverReply');return {text:'回复中断，已保留结果'};},
    remember:async()=>calls.push('remember')};
  const request={id:'one',kind:'chat',text:'审核这条内容',contentTask:'task-one'};
  journal.put(request.id,{state:'running',request});
  const options={journal,seat:'beikuang',callbacks:{...defaults,...callbacks}};
  t.after(()=>{db.close();rmSync(directory,{recursive:true,force:true});});
  return {db,journal,calls,request,options,path};
}

test('duplicate requests execute once and preserve the returned reply across a reopened database',async t=>{
  const f=fixture(t),workflow=new Workflow(f.options);
  const [one,two]=await Promise.all([workflow.run(f.request),workflow.run({...f.request})]);
  assert.deepEqual(one,two);assert.deepEqual(f.calls,['prepare','execute','verify','reply','remember']);
  const reopened=new DatabaseSync(f.path);
  try{const journal=new WebsiteJobs(reopened);
    const recovered=new Workflow({...f.options,journal});
    assert.deepEqual(await recovered.run(f.request),one);assert.equal(f.calls.length,5);
  }finally{reopened.close();}
});

test('a crash after sending a mutation recovers its receipt without repeating execution',async t=>{
  const f=fixture(t),args={key:'entry/one',revision:1},id=actionIdentity('one','content_review',args);
  const workflow=new Workflow({...f.options,callbacks:{...f.options.callbacks,execute:async()=>{
    f.calls.push('execute');f.journal.prepareAction('one',id,'content_review',args);
    throw new Error('simulated process crash after request');
  }}});
  await assert.rejects(workflow.run(f.request),/simulated process crash/);
  assert.equal(f.journal.get('one').workflow.executionStarted,true);
  f.journal.settleAction(id,{state:'done',result:{completed:true,publication:{verified:true}}});
  const recovered=new Workflow(f.options);await recovered.run(f.request);
  assert.equal(f.calls.filter(x=>x==='execute').length,1);
  assert.equal(f.calls.filter(x=>x==='recover').length,1);
  assert.equal(f.journal.get('one').workflow.execution.trace[0].receipt.actionId,id);
});

test('a crash after generating a paid reply uses recovery text and does not call the model again',async t=>{
  const f=fixture(t),workflow=new Workflow({...f.options,callbacks:{...f.options.callbacks,reply:async()=>{
    f.calls.push('reply');throw new Error('reply connection lost');
  }}});
  await assert.rejects(workflow.run(f.request),/connection lost/);
  const recovered=await new Workflow(f.options).run(f.request);
  assert.equal(recovered.text,'回复中断，已保留结果');
  assert.equal(f.calls.filter(x=>x==='reply').length,1);
  assert.equal(f.calls.filter(x=>x==='recoverReply').length,1);
});

test('one task identifier cannot be reused with a different instruction',async t=>{
  const f=fixture(t);await assert.rejects(new Workflow(f.options).run({...f.request,text:'换一个指令'}),/不同指令/);
  assert.deepEqual(f.calls,[]);
});

test('action identity ignores object key ordering but changes when version or task changes',()=>{
  assert.equal(actionIdentity('one','publish',{key:'entry/one',patch:{a:1,b:2}}),
    actionIdentity('one','publish',{patch:{b:2,a:1},key:'entry/one'}));
  assert.notEqual(actionIdentity('one','publish',{revision:1}),actionIdentity('one','publish',{revision:2}));
  assert.notEqual(actionIdentity('one','publish',{}),actionIdentity('two','publish',{}));
});

test('chat insertion and its marker commit together and failed insertion is recoverable',t=>{
  const f=fixture(t);f.db.exec('CREATE TABLE messages(body TEXT)');
  const store={transaction:fn=>{f.db.exec('BEGIN');try{fn();f.db.exec('COMMIT');}catch(e){f.db.exec('ROLLBACK');throw e;}}};
  assert.throws(()=>f.journal.remember('one',store,()=>{f.db.prepare('INSERT INTO messages VALUES(?)').run('半条');throw new Error('rollback');}),/rollback/);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM messages').get().n,0);
  const write=()=>f.db.prepare('INSERT INTO messages VALUES(?)').run('完整结果');
  f.journal.remember('one',store,write);f.journal.remember('one',store,write);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM messages').get().n,1);
});

test('an unknown mutation never becomes a success receipt',()=>{
  const recovered=recoveredExecution([{id:'action-one',operation:'content_publish',arguments:{key:'entry/one'},state:'unconfirmed',error:'请求超时'}]);
  assert.equal(recovered.trace[0].ok,false);assert.equal(recovered.trace[0].target,'entry/one');
  assert.equal(recovered.trace[0].receipt,undefined);assert.equal(recovered.gaps.length,1);
});
