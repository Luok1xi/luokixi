import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';
import {Service} from '../src/service.mjs';
import {Chat} from '../src/chat.mjs';
import {Skills,parseSkill} from '../src/skills.mjs';
import {Ledger,ResearchToolkit,passages,invertedAbstract,fromOpenAlex,parseArxiv,scholarSources} from '../src/research-tools.mjs';
import {ToolAgent} from '../src/agent.mjs';
import {ResearchProjects,reportMarkdown,reportBibtex} from '../src/research-projects.mjs';
import {publicConfig} from '../src/config.mjs';

const at=29823000;
function fixture(){const store=new Store(':memory:',at),service=new Service(store,()=>at);return {store,service};}
const reply=(body,status=200)=>({ok:status>=200&&status<300,status,text:async()=>typeof body==='string'?body:JSON.stringify(body)});
const call=(id,name,args)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
const fakeModels=steps=>{const seen=[];return {seen,chat:async(messages,opts)=>{seen.push({messages:structuredClone(messages),tools:opts.tools.map(t=>t.function.name),opts});const next=steps.shift();if(!next)throw new Error('no more scripted steps');return {message:{role:'assistant',content:'',...next},cost:0.01};}};};

test('maintenance handoff is not truncated by the short research-task limit',async()=>{
  const models=fakeModels([{tool_calls:[call('finish-one','finish',{answer:'核验完成',findings:[],confidence:'low',gaps:[]})]}]);
  const agent=new ToolAgent({models,toolkit:{status:()=>({}),definitions:()=>[]},config:()=>({toolReflection:false})});
  await agent.run({task:'背景'.repeat(900)+'当前搭档凭据:task-current-99',purpose:'website-maintenance'});
  assert.ok(models.seen[0].messages.some(m=>m.content.includes('task-current-99')));
});

test('content workflow restricts legacy tools without removing the original registry',async()=>{
  const executed=[];
  const models=fakeModels([
    {tool_calls:[call('wrong','campus_maintenance_read',{operation:'content_list',arguments:{id:'entry/invalid'}})]},
    {tool_calls:[call('right','content_read',{key:'entry/current'})]},
    {tool_calls:[call('done','finish',{answer:'读到了',findings:[],confidence:'low',gaps:[]})]},
  ]);
  const toolkit={status:()=>({}),definitions:()=>['content_read','campus_maintenance_read'].map(name=>({type:'function',function:{name,parameters:{type:'object'}}})),
    execute:async name=>{executed.push(name);return {key:'entry/current'};}};
  const agent=new ToolAgent({models,toolkit,config:()=>({toolReflection:false})});
  await agent.run({task:'读这项内容',toolNames:['content_read']});
  assert.deepEqual(models.seen[0].tools,['content_read','finish']);assert.deepEqual(executed,['content_read']);
  assert.equal(toolkit.definitions().length,2);
});

test('maintenance status polling refreshes queued results and preserves actual receipts',async()=>{
  let reads=0;
  const models=fakeModels([
    {tool_calls:[call('s1','campus_maintenance_read',{operation:'job_status',arguments:{id:'job-1'}})]},
    {tool_calls:[call('s2','campus_maintenance_read',{operation:'job_status',arguments:{id:'job-1'}})]},
    {tool_calls:[call('f','finish',{answer:'完成',findings:[],confidence:'high',gaps:[]})]},
  ]);
  const toolkit={status:()=>({}),definitions:()=>[],execute:async()=>({id:'job-1',state:++reads===1?'queued':'done',completed:reads===2,result:{preserved:4}})};
  const agent=new ToolAgent({models,toolkit,config:()=>({toolReflection:false})});
  const result=await agent.run({task:'检查真实任务'});
  assert.equal(reads,2);assert.equal(result.trace[1].receipt.state,'done');
  assert.equal(result.trace[1].receipt.result.preserved,4);
});

test('passage selection returns the chunks that match the focus, for Chinese and English',()=>{
  const text=['机器人底盘采用差速驱动。','激光雷达用于建图和定位，常见算法是 Cartographer。','电池续航大约两小时。','The evaluation uses the KITTI dataset and reports a 12% error reduction.'].join('\n');
  const zh=passages(text,'建图 定位 算法',{size:40,limit:1});assert.match(zh[0].text,/激光雷达/);
  const en=passages(text,'dataset evaluation results',{size:40,limit:1});assert.match(en[0].text,/KITTI/);
  assert.equal(passages(text,'',{size:40,limit:2}).length,2);
});

test('ledger assigns stable refs, enforces URL provenance and checks verbatim quotes',()=>{
  const l=new Ledger(['https://example.com/given']);
  const a=l.add({title:'Paper',doi:'10.1/ABC',url:'https://doi.org/10.1/abc',text:'Transformers reduce error by 12% on KITTI.'},'P');
  assert.equal(l.add({title:'Paper again',doi:'10.1/abc'},'P'),a,'same DOI keeps one ref');
  assert.equal(l.resolve('https://example.com/given').url,'https://example.com/given');
  assert.throws(()=>l.resolve('https://evil.example.org/x'),/只能读取/);
  assert.throws(()=>l.resolve('S9'),/不存在/);
  assert.equal(l.verify('reduce error by 12%',[a]),true);
  assert.equal(l.verify('reduce error by 50%',[a]),false);
  assert.equal(l.verify('“Transformers  reduce error”',[a]),true,'quote marks and spacing are normalised');
  assert.equal(l.public(a).texts,undefined);
});

test('scholarly parsers rebuild abstracts and treat HTTP-200 error payloads as failures',async()=>{
  assert.equal(invertedAbstract({world:[1],hello:[0]}),'hello world');
  const p=fromOpenAlex({id:'https://openalex.org/W1',doi:'https://doi.org/10.48550/arXiv.2401.00001',display_name:'A <i>study</i>',publication_year:2024,authorships:[{author:{display_name:'Ada'}}],cited_by_count:3,abstract_inverted_index:{x:[0]},best_oa_location:{pdf_url:'https://arxiv.org/pdf/2401.00001'}});
  assert.equal(p.title,'A study');assert.equal(p.arxiv,'2401.00001');assert.equal(p.openalex,'W1');assert.equal(p.url,'https://doi.org/10.48550/arXiv.2401.00001');
  assert.throws(()=>parseArxiv('<?xml version="1.0"?><feed><entry><id>http://arxiv.org/api/errors</id><title>Error</title><summary>bad</summary></entry></feed>'),/HTTP 200/);
  const rows=parseArxiv('<?xml version="1.0"?><feed><entry><id>http://arxiv.org/abs/2401.00002v2</id><title>Good Paper</title><summary>Abstract text here.</summary><published>2024-01-02T00:00:00Z</published><author><name>Bo</name></author><author><name>Cy</name></author></entry></feed>');
  assert.deepEqual([rows[0].arxiv,rows[0].year,rows[0].authors.length,rows[0].oaPdf],['2401.00002v2',2024,2,'https://arxiv.org/pdf/2401.00002v2']);
  await assert.rejects(scholarSources.europepmc(async()=>reply({errCode:500,errMsg:'x'}),{},{query:'q',max:3}),/HTTP 200/);
});

test('web search tries Chinese-friendly provider first, falls back on failure, caches and explains when unconfigured',async()=>{
  const {store}=fixture();const hits=[];
  const fetcher=async(url,opts)=>{hits.push(new URL(url).hostname);if(url.includes('bochaai'))return reply({code:500,msg:'quota'});return reply({results:[{title:'官方公告',url:'https://www.example.gov.cn/a',content:'报名截止 10 月 20 日'}]});};
  const kit=new ResearchToolkit({config:()=>({bochaKey:'b',tavilyKey:'t'}),fetcher,db:store.db});
  const ctx={ledger:new Ledger()};
  const r=await kit.execute('web_search',{query:'某比赛 报名 截止'},ctx);
  assert.deepEqual(hits,['api.bochaai.com','api.tavily.com']);assert.equal(r.provider,'Tavily');assert.equal(r.results[0].ref,'S1');
  assert.ok(ctx.ledger.allows('https://www.example.gov.cn/a'),'search results become readable URLs');
  const again=await kit.execute('web_search',{query:'某比赛 报名 截止'},{ledger:new Ledger()});
  assert.equal(again.cached,true);assert.equal(hits.filter(h=>h==='api.tavily.com').length,1,'second identical search served from cache');
  const bare=new ResearchToolkit({config:()=>({}),fetcher,db:store.db});
  await assert.rejects(bare.execute('web_search',{query:'x'},{ledger:new Ledger()}),/尚未配置.*wiki_search/);
  assert.deepEqual(bare.status().webSearch,[]);
});

test('scholar auto search falls back from OpenAlex to Crossref and read_page only accepts known URLs',async()=>{
  const {store}=fixture();
  const fetcher=async url=>url.includes('openalex')?reply('down',503):reply({message:{items:[{DOI:'10.5/x',title:['Crossref Paper'],author:[{given:'Li',family:'Wei'}],issued:{'date-parts':[[2023]]},'is-referenced-by-count':9}]}});
  let reads=0;const reader={document:async url=>{reads++;return {title:'页面',text:'第一段无关内容。'.repeat(30)+'关键数据：成功率 87%。',readLevel:'page-text',url};}};
  const kit=new ResearchToolkit({config:()=>({}),fetcher,db:store.db,reader});const ctx={ledger:new Ledger(['https://user.example.com/page'])};
  const r=await kit.execute('scholar_search',{query:'robot grasping'},ctx);
  assert.equal(r.source,'crossref');assert.equal(r.papers[0].ref,'P1');assert.deepEqual(r.papers[0].authors,['Li Wei']);
  await assert.rejects(kit.execute('read_page',{target:'https://other.example.com/'},ctx),/只能读取/);assert.equal(reads,0);
  const page=await kit.execute('read_page',{target:'https://user.example.com/page',focus:'成功率'},ctx);
  assert.match(page.passages.map(p=>p.text).join(''),/87%/);assert.equal(page.ref,'S1');
});

test('skills parse strictly, the bundled skills all load, and load_skill returns the procedure',async()=>{
  assert.throws(()=>parseSkill('no header'),/---/);
  assert.throws(()=>parseSkill('---\nname: Bad Name\ndescription: x\n---\nbody'),/name/);
  const s=parseSkill('---\nname: demo-skill\ndescription: 示例\ntools: web_search, read_page\n---\n步骤一');assert.deepEqual([s.name,s.tools,s.body],['demo-skill',['web_search','read_page'],'步骤一']);
  const bundled=new Skills();const names=bundled.catalog().map(x=>x.name);
  for(const n of ['web-research','fact-check','news-tracking','paper-search','literature-review','tech-research','learn-concept'])assert.ok(names.includes(n),n);
  assert.deepEqual(bundled.errors,[]);
  const dir=await mkdtemp(join(tmpdir(),'miku-skills-'));try{await mkdir(join(dir,'mine'));await writeFile(join(dir,'mine','SKILL.md'),'---\nname: mine\ndescription: 我的技能\n---\n先做A再做B');
    const skills=new Skills(dir),kit=new ResearchToolkit({skills});const ctx={ledger:new Ledger(),skills:new Set()};
    assert.equal((await kit.execute('load_skill',{name:'mine'},ctx)).instructions,'先做A再做B');assert.ok(ctx.skills.has('mine'));
    await assert.rejects(kit.execute('load_skill',{name:'nope'},ctx),/没有名为/);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('agent runs parallel tools, reuses duplicates, keeps reasoning_content and verifies quotes',async()=>{
  const executed=[];const toolkit={status:()=>({webSearch:['tavily']}),definitions:()=>[{type:'function',function:{name:'web_search',parameters:{}}},{type:'function',function:{name:'read_page',parameters:{}}}],
    execute:async(name,args,ctx)=>{executed.push(name);if(name==='web_search'){const ref=ctx.ledger.add({title:'官方',url:'https://example.org/a',provider:'tavily',tool:'web_search',text:'摘要'},'S');return {results:[{ref}]};}
      if(name==='read_page'){ctx.ledger.resolve(args.target);ctx.ledger.addText('S1','比赛将于 2026 年 11 月 3 日在上海举行。');return {ref:'S1',passages:[]};}throw new Error('boom');}};
  const models=fakeModels([
    {tool_calls:[call('a','web_search',{query:'比赛 时间'}),call('b','web_search',{query:'比赛 时间'}),call('c','broken_tool',{})],reasoning_content:'先并行搜索'},
    {tool_calls:[call('d','read_page',{target:'S1',focus:'时间地点'}),call('e','read_page',{target:'https://not-allowed.example.net'})]},
    {tool_calls:[call('f','finish',{answer:'比赛在上海举行 [S1]',confidence:'high',findings:[{claim:'11月3日在上海',sources:['S1','S99'],quote:'2026 年 11 月 3 日在上海举行'},{claim:'编的',sources:['S1'],quote:'在北京举行'},{claim:'无来源',sources:[]}]})]},
  ]);
  const progress=[];const agent=new ToolAgent({models,toolkit,skills:{prompt:()=>'- web-research：通用查询',get:()=>{throw new Error('x');}},config:()=>({agentQuickLimit:1})});
  const r=await agent.run({task:'比赛什么时候',onProgress:p=>progress.push(p.step)});
  assert.equal(r.stats.stopped,'finish');
  assert.deepEqual(executed.filter(x=>x==='web_search').length,1,'duplicate call in one batch reuses the result');
  const second=models.seen[1].messages;assert.equal(second.find(m=>m.role==='assistant').reasoning_content,'先并行搜索','thinking content is passed back');
  assert.match(second.filter(m=>m.role==='tool').map(m=>m.content).join(''),/完全相同/);
  assert.match(models.seen[2].messages.filter(m=>m.role==='tool').map(m=>m.content).join(''),/只能读取/);
  assert.deepEqual(r.findings.map(f=>[f.claim,f.sources,f.verified]),[['11月3日在上海',['S1'],true],['编的',['S1'],false]]);
  assert.deepEqual(r.sources.map(s=>s.ref),['S1']);assert.deepEqual(progress,[1,2]);
});

test('agent closes with a finish-only step when the budget runs low',async()=>{
  const toolkit={status:()=>({}),definitions:()=>[{type:'function',function:{name:'web_search',parameters:{}}}],execute:async()=>({results:[]})};
  const models={seen:[],chat:async(messages,opts)=>{models.seen.push(opts.tools.map(t=>t.function.name));return models.seen.length===1?{message:{role:'assistant',content:'',tool_calls:[call('a','web_search',{query:'x'})]},cost:0.5}:{message:{role:'assistant',content:'',tool_calls:[call('b','finish',{answer:'资料不足',findings:[],confidence:'low',gaps:['没有找到']})]},cost:0.01};}};
  const r=await new ToolAgent({models,toolkit,config:()=>({})}).run({task:'x',budget:0.6});
  assert.deepEqual(models.seen[1],['finish']);assert.equal(r.answer,'资料不足');assert.deepEqual(r.gaps,['没有找到']);
});

test('chat routes information needs to the agent, streams status and appends real sources',async()=>{
  const {service}=fixture();let composed;
  const models={config:()=>({deepseekKey:'test'}),complete:async(m,o)=>{if((o.json && !['dialogue','initiative-share','initiative-reminder','work-log'].includes(o.purpose)))return {text:JSON.stringify({actions:[],act:'question',thinking:'fast',advisor:'none',toolRequest:{tool:'investigate',question:'RoboMaster 2027 规则变化',depth:'quick',evidence:'查一下'}})};composed=m;return {text:JSON.stringify({messages:[{type:'text',text:'查到啦，主要变化是…'}]})};}};
  const chat=new Chat(service,models),status=[];
  chat.agent={toolkit:{status:()=>({})},run:async({task,mode})=>{assert.equal(task,'RoboMaster 2027 规则变化');assert.equal(mode,'quick');return {answer:'规则改了 [S1]',findings:[{claim:'改了',sources:['S1'],verified:true}],confidence:'medium',gaps:[],sources:[{ref:'S1',title:'官方规则手册',url:'https://www.robomaster.com/rules'}],stats:{steps:3}};}};
  const r=await chat.run('帮我查一下今年比赛规则',{onStatus:t=>status.push(t)});
  assert.match(r.text,/查到啦/);assert.match(r.text,/参考来源：\n\[S1\] 官方规则手册\nhttps:\/\/www\.robomaster\.com\/rules/);
  assert.match(JSON.stringify(composed),/规则改了/);assert.ok(status.some(s=>/查资料/.test(s)));
  assert.equal(r.advisor,'not_needed');
});

test('deep requests start a background project; completion is saved, announced and exportable',async()=>{
  const {service,store}=fixture();let release;const gate=new Promise(r=>{release=r;});
  const agent={run:async({task,mode,preload,onProgress})=>{assert.equal(mode,'deep');assert.deepEqual(preload,['literature-review']);onProgress({step:1,text:'scholar_search「x」'});await gate;
    return {answer:'综述结论 [P1]',findings:[{claim:'方法A更好',sources:['P1'],quote:'A outperforms B',verified:true}],sections:[{heading:'主要发现',content:'A 优于 B [P1]'}],confidence:'medium',gaps:['缺少真实场景数据'],followups:['在真实场景复现'],
      sources:[{ref:'P1',title:'A vs B',authors:['Ada Lovelace','Bo Li'],year:2025,venue:'ICRA',doi:'10.1/ab',url:'https://doi.org/10.1/ab',readLevel:'full-text'}],seen:12,stats:{stopped:'finish',steps:9,cost:0.8,verified:1,findings:1},trace:[{step:1,args:'scholar_search「x」',ok:true,ms:30}]};}};
  const chat={compose:async({material})=>({text:'调研好啦：A 比 B 好。',messages:[{type:'text',text:'调研好啦：A 比 B 好。'}],material}),exclusive:fn=>fn()};
  const projects=new ResearchProjects(service,{agent,chat});
  const started=projects.start({question:'抓取算法 A 和 B 哪个好',channel:'weixin'});assert.equal(started.status,'queued');
  assert.equal(projects.start({question:'抓取算法 A 和 B 哪个好'}).duplicate,true);
  await new Promise(r=>setImmediate(r));assert.equal(projects.list()[0].status,'running');assert.equal(projects.list()[0].progress.step,1);
  release();await projects.inflight;
  const row=projects.row(started.id);assert.equal(row.status,'done');assert.equal(row.cost,0.8);
  const last=store.chats().at(-1);assert.match(last.text,/调研好啦/);assert.match(last.text,/科研项目/);
  const out=store.messages().find(m=>m.id==='weixin:reply:project:'+started.id);assert.equal(out.payload.kind,'reply');
  const md=reportMarkdown(row);assert.match(md,/## 主要发现/);assert.match(md,/\[P1\] Ada Lovelace, Bo Li\. \(2025\)\. A vs B\./);assert.match(md,/✓已核对原文/);
  assert.match(reportBibtex(row),/@article\{Lovelace2025_1,[\s\S]*doi = \{10\.1\/ab\}/);
  assert.match(projects.remove(started.id).message,/已删除/);assert.equal(projects.list().length,0);
});

test('chat deep investigate creates a project instead of answering inline; shutdown marks running work interrupted',async()=>{
  const {service}=fixture();let hold;const agent={run:()=>new Promise((res,rej)=>{hold=rej;})};
  const projects=new ResearchProjects(service,{agent});const chat=new Chat(service,{config:()=>({})});chat.agent={toolkit:{status:()=>({})}};chat.projects=projects;
  const r=await chat.investigate({tool:'investigate',question:'机器人 SLAM 方法综述',depth:'deep',evidence:'深入研究'},'帮我深入研究一下 SLAM');
  assert.equal(r.project.status,'queued');assert.match(r.project.note,/后台/);
  assert.match((await chat.investigate({tool:'investigate',question:'x',evidence:'不在原话里'},'别的话')).error,/依据/);
  await new Promise(r=>setImmediate(r));const done=projects.shutdown();hold(new Error('检索已取消。'));await done;
  assert.equal(projects.row(r.project.id).status,'interrupted');
});

test('public config never exposes search keys',()=>{
  const c=publicConfig({deepseekKey:'d',tavilyKey:'t',bochaKey:'b',braveKey:'x',s2Key:'s',searxngUrl:'http://127.0.0.1:8080'});
  for(const k of ['deepseekKey','tavilyKey','bochaKey','braveKey','s2Key'])assert.equal(c[k],undefined);
  assert.deepEqual([c.tavilyConfigured,c.bochaConfigured,c.braveConfigured,c.s2Configured,c.searxngUrl],[true,true,true,true,'http://127.0.0.1:8080']);
});

test('skills are auto-selected from trigger keywords and the agent preloads the match',async()=>{
  const s=new Skills();
  assert.equal(s.match('ORB-SLAM3 相比 ORB-SLAM2 增加了什么？给出论文出处'),'paper-search');
  assert.equal(s.match('今天 OpenAI 发布了什么新模型'),'news-tracking');
  assert.equal(s.match('学校四六级报名截止是什么时候'),'web-research');
  assert.equal(s.match('npm install 报错 EACCES'),'tech-research');
  const models=fakeModels([{tool_calls:[call('z','finish',{answer:'好',findings:[],confidence:'low'})]}]);
  const toolkit={status:()=>({}),definitions:()=>[],execute:async()=>({})};
  const r=await new ToolAgent({models,toolkit,skills:s,config:()=>({})}).run({task:'这篇论文的 DOI 出处是什么'});
  assert.deepEqual(r.stats.skills,['paper-search']);assert.match(models.seen[0].messages.map(m=>m.content).join(''),/学术文献检索/);
});

test('unusable web search is hidden; paywalled papers fall back to the arXiv version and full text is reused in a run',async()=>{
  const {store}=fixture();assert.ok(!new ResearchToolkit({config:()=>({}),db:store.db}).definitions().some(t=>t.function.name==='web_search'));
  assert.ok(new ResearchToolkit({config:()=>({tavilyKey:'t'}),db:store.db}).definitions().some(t=>t.function.name==='web_search'));
  const urls=[];const fetcher=async url=>{urls.push(url);if(url.includes('export.arxiv.org'))return reply('<?xml version="1.0"?><feed><entry><id>http://arxiv.org/abs/2007.11898v2</id><title>ORB-SLAM3: An Accurate Open-Source Library</title><summary>abs</summary></entry></feed>');throw new Error('unexpected '+url);};
  let downloads=0;const kit=new ResearchToolkit({config:()=>({}),fetcher,db:store.db,fetchBytes:async url=>{downloads++;assert.equal(url,'https://arxiv.org/pdf/2007.11898v2');throw new Error('offline in test');}});
  const ctx={ledger:new Ledger()};const ref=ctx.ledger.add({title:'ORB-SLAM3: An Accurate Open-Source Library',doi:'10.1109/tro.2021.3075644',abstract:'We present ORB-SLAM3.',text:'We present ORB-SLAM3.'},'P');
  const first=await kit.execute('read_paper',{ref,focus:'atlas'},ctx);
  assert.equal(first.readLevel,'abstract');assert.match(first.limitation,/找到 arXiv 版本 2007\.11898v2/);assert.match(first.note,/不要再次/);assert.equal(downloads,1);
  const again=await kit.execute('read_paper',{ref,focus:'imu'},ctx);assert.equal(downloads,1,'second read in the same run reuses the result');assert.equal(again.readLevel,'abstract');
});

test('maintenance batches overlap reads while writes remain barriers and are not replayed',async()=>{
 const events=[];let readers=0,maxReaders=0;
 const sequence=[
  {tool_calls:[call('r1','read_a',{}),call('r2','read_b',{}),call('w1','write_a',{}),call('r3','read_a',{})]},
  {tool_calls:[call('w2','write_a',{})]},
  {tool_calls:[call('f','finish',{answer:'维护完成',findings:[],confidence:'low'})]},
 ];
 const models=fakeModels(sequence),toolkit={status:()=>({}),definitions:()=>[],risk:n=>n.startsWith('read')?'read':'publish',execute:async(name)=>{
  events.push('start:'+name);
  if(name.startsWith('read')){readers++;maxReaders=Math.max(maxReaders,readers);await new Promise(r=>setTimeout(r,20));readers--;}
  else assert.equal(readers,0,'write must not overlap reads');
  events.push('end:'+name);return {state:'done'};
 }};
 const agent=new ToolAgent({models,toolkit,config:()=>({toolReflection:false})});agent.maintenancePolicy=()=>true;
 await agent.run({task:'读后维护',mode:'deep',purpose:'website-maintenance'});
 assert.equal(maxReaders,2);assert.equal(events.filter(e=>e==='start:write_a').length,1);
 assert.equal(events.filter(e=>e==='start:read_a').length,2,'read cache invalidated after write');
 assert.ok(events.indexOf('start:write_a')>events.indexOf('end:read_b'));
 assert.ok(models.seen[0].messages[0].content.includes('网站维护任务'));
 assert.equal(models.seen[0].opts.thinking,'fast');
});
