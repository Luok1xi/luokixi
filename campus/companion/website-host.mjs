// Website transport around the original runtime. Chat/persona/memory/agency stay upstream.
import http from 'node:http';
import {mountMaintenance,maintenanceInstruction} from './website-maintenance.mjs';
import {WebsiteWork} from './website-work.mjs';
import {WebsiteJobs} from './website-jobs.mjs';
import {createWebsiteWorkflow,recoveredExecution} from './website-workflow.mjs';
import {stageCast} from '../stage-catalog.js';
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,timingSafeEqual} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
const root=dirname(fileURLToPath(import.meta.url));
const SEAT=process.argv.includes('--codex')||process.env.COMPANION_SEAT==='codex'?'codex':'beikuang';
process.env.COMPANION_SEAT=SEAT;
const data=resolve(process.env.COMPANION_DATA||resolve(root,SEAT==='codex'?'../.data/codex-companion':'../.data/companion'));
process.env.MIKU_DATA=data;process.env.MIKU_CONFIG=resolve(data,'config.json');
const UPSTREAM='d5ca8d3feab76271049868ed5f56ce85ac45cadb';

export async function createWebsiteHost({app:providedApp,token,owner,port=17862,rpc:providedRpc,background=true,paid=true}={}){
  const {createApp}=await import('./src/server.mjs');
  const {characterFeeling}=await import('./src/character-card.mjs');
  const {affectView}=await import('./src/affect.mjs');
  const {selfState}=await import('./src/self-state.mjs');
  let app=providedApp;
  const rpc=providedRpc||async function(body){
    const response=await fetch('http://127.0.0.1:17861/api/hub/companion-bridge',{
      method:'POST',headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json'},
      body:JSON.stringify(body),signal:AbortSignal.timeout(['codex-model','voice','maintenance'].includes(body.op)?300000:12000)});
    const result=await response.json();if(!response.ok){const error=new Error(result.error||'网站工具暂时未连接。');error.status=response.status;throw error;}return result;
  };
  if(!app){
    const {readConfig}=await import('./src/config.mjs');
    const {CodexModels}=await import('./src/codex-models.mjs');
    app=await createApp({background:false,...(SEAT==='codex'?{models:new CodexModels(rpc,readConfig)}:{})});
  }
  if(SEAT==='codex'){
    // Both full consoles and the website use one GPU queue; never swap models mid-sentence.
    const speechStatus=app.speech.status.bind(app.speech);
    app.speech.status=()=>speechStatus('codex');
    app.speech.synthesize=async(text,options={})=>{
      const result=await rpc({op:'voice',text,expression:options.expression,language:options.language||'ja'});
      return {...result,audio:Buffer.from(result.audio,'base64')};
    };
  }
  // All original model calls, including background research, share the site's daily ceiling.
  if(paid&&SEAT==='beikuang')for(const method of ['complete','chat']){
    const original=app.models[method].bind(app.models);
    app.models[method]=async(messages,options={})=>{
      if(options.provider==='openai')throw new Error('本站当前使用 Flash；未额外启用 OpenAI 付费调用。');
      const maxOutput=Math.min(options.maxOutput||4096,6000);
      const bytes=Buffer.byteLength(JSON.stringify(messages))+Buffer.byteLength(JSON.stringify(options.tools||[]));
      const image=messages.some(m=>Array.isArray(m.content)&&m.content.some(p=>p.type==='image_url'))?262144:0;
      const id=randomUUID();await rpc({op:'reserve',id,inputUnits:bytes+8192+image,outputTokens:maxOutput,purpose:options.purpose||'dialogue'});
      try{const result=await original(messages,{...options,maxOutput,model:'deepseek-flash'});
        await rpc({op:'settle',id,usage:result.usage||{}}).catch(()=>{});return result;
      }catch(e){await rpc({op:'settle',id,failed:true}).catch(()=>{});throw e;}
    };
  }
  const work=new WebsiteWork(app.service,rpc,SEAT);app.agency.work=work;
  const definitions=[
    ['site_status','网站今日工作进度、已发布数量、故障',{}],
    ['site_browser_report','读取真实 Playwright 网页巡检结果：图片加载、脚本报错和手机溢出；未执行时明确返回 not-run',{}],
    ['library_search','搜索本站真实资料库，返回资料编号与标题',{query:{type:'string'}}],
    ['library_read','读取本站资料已提取的正文；document_id 来自 library_search',{document_id:{type:'string'}}],
    ['audit_queue','查看机器人待审数量、类别和积压',{}],
    ['audit_lessons','查询站主历史审核意见与证据',{query:{type:'string'}}],
  ];
  app.registry.group('campus',{title:'校园资料和审核',state:'on'});
  for(const [name,description,parameters] of definitions)app.registry.register({name:'campus_'+name,group:'campus',description,parameters,
    required:name==='library_read'?['document_id']:[],handler:arguments_=>rpc({op:'tool',name,arguments:arguments_})});
  const jobs=new Map(),journal=new WebsiteJobs(app.store.db);
  mountMaintenance(app,rpc,{journal});
  work.execute=async goal=>app.agent.run({task:goal,mode:'deep',purpose:'website-maintenance'});
  const capabilities=app.chat.capabilities.bind(app.chat);
  app.chat.capabilities=(...args)=>({...capabilities(...args),website:{connected:true,
    identity:SEAT==='codex'?'你是 Codex，和北矿娘共享能力程序，使用独立的人格、记忆和情绪；工作室和私聊是同一个你。':'北矿娘和小煤渣是同一个你。网站对话使用你原来的记忆、情绪、关系和工具。',
    currentArt:{date:'2026-10-08',self:stageCast[SEAT].appearance,partner:stageCast[SEAT==='codex'?'beikuang':'codex'].appearance,
      meaning:SEAT==='codex'?'站主确认白发龙角形象是你，黑红形象是闺蜜北矿娘；素材说明不等于执行过图像识别。':'站主确认黑红形象是你，白发龙角是闺蜜Codex。这是当前舞台素材说明，不等于本轮执行了图片视觉识别。'},
    available:definitions.map(([name,title])=>({name:'campus_'+name,title})),
    maintenance:maintenanceInstruction,
    use:'需要维护、审核、安装技能、测试和修复时用 investigate 调用 campus_maintenance。查询本站资料时用 investigate 调用 campus_library_search、campus_library_read。普通网页、论文和自主学习继续使用原有工具。审核与工作日志由网站执行器完成，当前 material 给出真实结果。'}});
  const turnContext=new AsyncLocalStorage(),originalContext=app.chat.context.bind(app.chat);
  app.chat.context=(...args)=>{
    const turn=turnContext.getStore();
    return {...originalContext(...args),websiteWork:work.snapshot({conversation:!!turn}),...turn};
  };
  // This host delivers to the website. Original private-account transports are not duplicated.
  app.scheduler.weixinReady=()=>false;app.scheduler.feishuReady=()=>false;
  app.chat.runtimeInfo=()=>({connected:true,enabled:app.service.state().agency.enabled,...app.agency.shareStatus(),
    channel:'luokixi',requires:'原版后台运行；遵循原有主动次数、免打扰和未回复限制。'});
  app.store.db.exec('CREATE TABLE IF NOT EXISTS website_deliveries(id TEXT PRIMARY KEY,at INTEGER NOT NULL)');
  let backgroundError='',ticking=false,activityCursor=0;
  function status(){const s=app.service.state(),now=app.service.clock(),affect=affectView(s.persona,now);
    const feeling=characterFeeling(s.persona,now)||{name:({bright:'happy',shy:'awkward',pouting:'sad',playful:'happy'})[affect.mode]||'neutral',intensity:affect.arousal};
    return {engine:'campus-companion',seat:SEAT,identity:s.persona.stable.name,revision:UPSTREAM,model:app.models.config().deepseekModel,
      emotion:feeling,self:selfState(s,now,{usage:app.models.usage?.()}),memoryCount:s.memories.length,
      readingNotes:s.webLife.notes.length,studySessions:s.study.sessions.length,
      work:work.snapshot(),toolGroups:app.registry.groups().map(({group,count,state})=>({group,count,state})),backgroundError};
  }
  const workflow=await createWebsiteWorkflow({journal,seat:SEAT,callbacks:{
    progress:async(id,stage)=>{
      const row=journal.get(id);if(!row.request?.contentTask||!['prepare','execute','verify'].includes(stage))return;
      const progress={prepare:'读取目标内容与当前权限',execute:'原版执行器处理中',verify:'核验操作回执和公开结果'}[stage];
      await rpc({op:'content-progress',id:row.request.contentTask,state:'running',progress,
        result:{workflow:{engine:workflow.engine,stage,jobId:id}}});
    },
    prepare:async body=>{
      await work.refresh(true);
      const material={...body.material};
      if(body.kind==='chat')try{material.continuity=await rpc({op:'continuity',seat:SEAT,query:body.text});}
      catch{material.continuity={available:false,reason:'跨窗口记录暂时不可用；不要假称已记得。'};}
      journal.checkpoint(body.id,{material});
    },
    execute:async body=>{
      const job=jobs.get(body.id),material=journal.get(body.id).workflow.material||body.material||{};
      return app.agent.withWebsiteJob(body.id,async()=>{
        if(body.contentTask)return app.agent.withContentTask(body.contentTask,()=>app.agent.run({
          task:body.text+'\n本次任务编号 '+body.contentTask+'。这是站主在私聊窗口发起的具体内容任务。先 content_search 查目标并读取当前版本，再执行审核或编辑。目标编号已给出时直接 content_read。不要只承诺稍后做，找不到明确目标时提出必要的澄清；失败留下实际错误。完成操作后调用 finish 汇总实际回执。',
          mode:'deep',purpose:'website-maintenance',signal:job?.controller.signal,
          toolNames:['content_search','content_read','content_history','content_publish','content_review','content_task','read_page','read_paper'],
          onProgress:p=>{void rpc({op:'content-progress',id:body.contentTask,state:'running',progress:p.text.slice(0,600),
            result:{actionIds:journal.actions(body.id).filter(a=>a.state==='done'&&a.result?.completed===true).map(a=>a.id)}}).catch(()=>{});}}));
        if(material.maintenance?.enabled!==true||!app.agent.maintenancePolicy?.())return null;
        const partner=(material.history||[]).at(-1);
        const handoff=partner?{seat:partner.seat,receipts:(partner.execution?.trace||[]).filter(t=>t.receipt?.id).map(t=>t.receipt).slice(-3),message:(partner.body||'').slice(0,500)}:null;
        return app.agent.run({task:(material.goal||'').slice(0,500)+'\n任务契约：'+JSON.stringify(material.task||{}).slice(0,4500)+'\n最近一位搭档的交接（优先核验这里的任务编号，不能拿历史旧任务替代）：'+JSON.stringify(handoff).slice(0,750)+'\n用 campus_maintenance_read 的 job_status 查询交接的任务 id；需要新行动才调用 campus_maintenance。当前状态可刷新，排队不等于完成。工具已返回 Z 结尾 UTC 时间，北京时间应加8小时，跨日不是故障。代码修改要完成 candidate→test→apply，缺工具要给出具体缺口，不能只重复搭档的问题。',
          mode:'deep',purpose:'website-maintenance',signal:job?.controller.signal});
      });
    },
    recover:async body=>recoveredExecution(await app.agent.recoverWebsiteActions(body.id)),
    verify:async(body,execution)=>{
      if(journal.actions(body.id).some(a=>a.state==='unconfirmed'))await app.agent.recoverWebsiteActions(body.id);
      const actionIds=[...new Set((execution?.trace||[]).filter(t=>t.ok&&t.receipt?.completed===true&&t.receipt.actionId&&t.receipt.publication?.verified!==false).map(t=>t.receipt.actionId))];
      const unknown=journal.actions(body.id).filter(a=>['sent','unconfirmed'].includes(a.state));
      const trace=execution?.trace||[];
      const successful=new Set(trace.filter(t=>t.ok&&t.receipt?.completed===true).map(t=>
        (t.operation||t.receipt.operation||t.tool)+'|'+(t.target||t.receipt.key||t.receipt.id||'')));
      const failures=trace.filter(t=>t.ok===false&&!successful.has((t.operation||t.tool)+'|'+(t.target||'')));
      const complete=actionIds.length>0&&unknown.length===0&&!failures.length&&!execution?.gaps?.length;
      if(!body.contentTask)return {complete:!unknown.length&&!failures.length&&!(execution?.gaps?.length),actionIds,
        failures:failures.map(t=>({operation:t.operation||t.tool,target:t.target||'',error:t.error||'工具执行失败'})),
        unknown:unknown.map(a=>a.id),recovered:!!journal.get(body.id).workflow.recovered};
      const progress=complete?'处理完成，已取得发布或审核回执':unknown.length?'部分操作结果未确认；未重复提交':'执行结束，未取得成功回执';
      return rpc({op:'content-progress',id:body.contentTask,state:complete?'completed':'failed',progress,
        result:{actionIds,trace:execution?.trace||[],reportWarnings:execution?.gaps||[],
          workflow:{engine:workflow.engine,stage:'verify',jobId:body.id,recovered:!!journal.get(body.id).workflow.recovered},unknownActions:unknown.map(a=>a.id)},
        error:complete?'':execution?.gaps?.join('；')||'未成功执行审核或发布。'});
    },
    reply:async(body,execution,verification)=>{
      const job=jobs.get(body.id),material=journal.get(body.id).workflow.material||body.material||{};
      const {history:duplicateHistory,collaboration:duplicateCollaboration,...chatMaterial}=material;
      const reply=await app.chat.compose({trigger:'studio',message:body.contentTask?body.text:material.goal||'',
        material:body.contentTask?{...chatMaterial,execution,contentTask:verification,
          instruction:'直接回复站主这次指令的实际结果。任务失败时不能说已经完成，不拿早上的旧错误当作刚刚的结果。'}:{...material,execution,verification},
        results:execution?[{message:body.contentTask?verification.progress:execution.answer,toolCalls:execution.stats?.toolCalls,trace:execution.trace,gaps:execution.gaps}]:[],
        isCurrent:()=>!job?.cancelled});
      return {...reply,...(body.contentTask?{contentTask:verification}:{verification}),
        maintenance:execution?{trace:execution.trace,stats:execution.stats,gaps:execution.gaps}:null,
        workflow:{engine:workflow.engine,stage:'completed',jobId:body.id,recovered:!!journal.get(body.id).workflow.recovered}};
    },
    recoverReply:async(body,execution,verification)=>({text:'上次回复生成中断，未重复调用模型。'+(body.contentTask?verification.progress||'请查看保留的任务回执。':'已保留本次工具结果，请查看执行记录。'),
      messages:[],...(body.contentTask?{contentTask:verification}:{verification}),maintenance:execution,
      workflow:{engine:workflow.engine,stage:'completed',jobId:body.id,recovered:true}}),
    remember:async(body,reply)=>{if(!body.contentTask)return;
      const job=jobs.get(body.id);journal.remember(body.id,app.service.store,()=>{
        app.service.store.addChat('user',body.text,app.service.clock());
        if(!job?.cancelled&&reply.text)app.service.store.addChat('assistant',reply.text,app.service.clock(),reply.messages);
      });},
  }});
  async function deliver(){
    for(const row of app.store.db.prepare("SELECT id,payload FROM outbox WHERE channel='local' AND status='sent' AND sent_at>=? AND id NOT IN (SELECT id FROM website_deliveries) ORDER BY sent_at LIMIT 4").all(started)){
      const payload=JSON.parse(row.payload);if(!payload.text?.trim())continue;
      await rpc({op:'delivery',id:row.id,text:payload.text,messages:payload.messages||[]});
      app.store.db.prepare('INSERT OR IGNORE INTO website_deliveries VALUES(?,?)').run(row.id,app.service.clock());
    }
  }
  const started=app.service.clock();
  async function tick(){
    if(ticking)return;ticking=true;
    const errors=[];
    const run=async(name,fn)=>{try{await fn();}catch(e){errors.push(name+'：'+String(e.message).slice(0,180));}};
    try{
      // Each original engine retains its own enabled/consent gate. One failure must not stop delivery.
      await run('工作状态',()=>work.refresh());
      await run('已启用的会话采集',()=>app.social.tick());
      if(!app.chat.active)await run('自主活动',async()=>{
        // Rotate eligible original engines so a repeatedly due task cannot starve Agency.
        const activities=[
          [()=>app.cortex.due(),()=>app.chat.exclusive(()=>app.cortex.run())],
          [()=>app.inquiry.due(),()=>app.chat.exclusive(()=>app.inquiry.run())],
          [()=>app.webLife.dailyDue(),()=>app.chat.exclusive(()=>app.webLife.daily())],
          [()=>app.memoryWriter.due(),()=>app.chat.exclusive(()=>app.memoryWriter.run())],
          [()=>app.agency.due()||app.agency.shareDue(),()=>app.agency.tick()],
        ];
        for(let n=0;n<activities.length;n++){
          const i=(activityCursor+n)%activities.length;
          if(activities[i][0]()){activityCursor=(i+1)%activities.length;await activities[i][1]();break;}
        }
      });
      if(!app.chat.active)await run('研究',()=>app.research.tick());
      if(app.siteKeeper.due())await run('原版网站维护',()=>app.siteKeeper.tick());
      await run('提醒',()=>app.scheduler.tick());await run('网站投递',deliver);
      backgroundError=errors.join('；').slice(0,500);
    }finally{ticking=false;}
  }
  const timer=background?setInterval(()=>void tick(),20000):null;timer?.unref();
  if(background)app.projects.kick();
  async function enqueue(body){
    if(body.owner!==owner)throw new Error('此会话不是已绑定的站主。');
    if(!/^[a-f0-9]{64}$/.test(body.id)||!['chat','report','studio','work'].includes(body.kind)||typeof body.text!=='string'||body.text.length>40000)throw new Error('会话格式无效。');
    const saved=journal.get(body.id);
    if(saved?.request&&(saved.request.text!==body.text||saved.request.kind!==body.kind||saved.request.owner!==body.owner||saved.request.contentTask!==body.contentTask))throw new Error('同一任务编号不能用于不同指令。');
    if(jobs.has(body.id))return {id:body.id,state:jobs.get(body.id).state};
    if(saved&&!(saved.state==='interrupted'&&['journal','langgraph'].includes(saved.workflow?.engine)))return {id:body.id,state:saved.state};
    if(saved){
      if(JSON.stringify(saved.request)!==JSON.stringify(body))throw new Error('同一任务编号不能用于不同指令。');
      body=saved.request;
    }
    const job={state:'running',cancelled:false,controller:new AbortController()};jobs.set(body.id,job);
    journal.put(body.id,{...job,request:body});
    if(jobs.size>128)for(const [id,row] of jobs)if(row.state!=='running'){jobs.delete(id);if(jobs.size<=100)break;}
    job.promise=(async()=>{
      try{
        const material=body.material||{};
        if(body.kind==='chat'&&!body.contentTask){
          try{material.continuity=await rpc({op:'continuity',seat:SEAT,query:body.text});}
          catch{material.continuity={available:false,reason:'跨窗口记录暂时不可用；不要假称已记得。'};}
        }
        const {history:duplicateHistory,collaboration:duplicateCollaboration,...chatMaterial}=material;
        const output=body.kind==='chat'&&body.contentTask
          ?await app.chat.exclusive(()=>workflow.run(body))
          :body.kind==='work'
          ?await app.chat.exclusive(async()=>{
            const {characterCardPrompt}=await import('./src/character-card.mjs');
            const result=await app.models.complete([{role:'system',content:characterCardPrompt+'\n'+material.workPrompt},
              {role:'user',content:JSON.stringify({context:app.chat.context(),material:{...material,workPrompt:undefined}})}],{json:true,purpose:'studio-code',maxOutput:6000});
            const parsed=JSON.parse(result.text);return {...parsed,text:parsed.message};
          })
          :body.kind==='studio' 
          ?await app.chat.exclusive(()=>workflow.run(body))
          :body.kind==='report'
          ?await app.chat.exclusive(()=>app.chat.compose({trigger:'report',material:{workLog:body.report,
            instruction:'这是你自己的公开小日志，沿用私聊和工作室的同一人格、情绪与措辞习惯。依照 workLog.instruction 写，允许短句、轻松感想和真实挫折，不变成客服或任务清单。保留成功、失败、排队的区别；不编造阅读和发布经历，不泄露私人记忆内容。'}}))
          // Original chat and continuity already supply these two transcripts. Keep fresh facts
          // such as today's publication counts, source receipts and all other caller material.
          :await turnContext.run({website:chatMaterial},()=>app.chat.run(body.text,{requestId:'website:'+body.id,source:'local',
            isCurrent:()=>!job.cancelled}));
        if(job.cancelled||output.superseded){job.result={text:'',superseded:true};job.state='done';return;}
        if(output.error||/^暂时无法生成对话：/.test(output.text||''))throw new Error(output.error?.message||output.text);
        job.result={...output,...status()};job.state='done';
      }catch(e){job.state='failed';job.error=String(e.message).slice(0,400);}
      finally{journal.put(body.id,job);}
    })();
    return {id:body.id,state:job.state};
  }
  const server=http.createServer(async(req,res)=>{
    const send=(value,statusCode=200)=>{res.writeHead(statusCode,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
    const path=new URL(req.url,'http://127.0.0.1').pathname;
    if(path==='/health'&&req.method==='GET')return send({ok:true,engine:'campus-companion',revision:UPSTREAM,bridgeVersion:29,workflowEngine:workflow.engine,seat:SEAT});
    const incoming=Buffer.from(req.headers.authorization||''),expected=Buffer.from('Bearer '+token);
    if(req.headers.origin||incoming.length!==expected.length||!timingSafeEqual(incoming,expected))return send({error:'连接未授权。'},403);
    try{
      if(req.method==='GET'&&path==='/status')return send(status());
      if(req.method==='GET'&&path==='/voice')return send(app.speech.status());
      if(req.method==='GET'&&path.startsWith('/jobs/')){
        const id=path.slice(6);let job=jobs.get(id)||journal.get(id);
        if(job?.state==='interrupted'&&['journal','langgraph'].includes(job.workflow?.engine)&&job.request){await enqueue(job.request);job=jobs.get(id);}
        return job?send({state:job.state,result:job.result,error:job.error,workflow:journal.get(id)?.workflow?{
          engine:workflow.engine,stage:journal.get(id).workflow.stage,recovered:!!journal.get(id).workflow.recovered}:undefined}):send({error:'没有该任务。'},404);}
      if(req.method!=='POST')return send({error:'未知入口。'},404);
      const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>1024*1024)return send({error:'请求过大。'},413);chunks.push(chunk);}
      const body=JSON.parse(Buffer.concat(chunks).toString());
      if(path==='/voice'){
        if(!app.speech.status(body.seat).server)throw new Error('角色语音尚未配置。');
        const result=await app.speech.synthesize(String(body.text||''),{expression:body.expression,seat:body.seat,language:body.language});
        return send({audio:result.audio.toString('base64'),type:result.type,cached:result.cached});
      }
      if(path==='/jobs')return send(await enqueue(body));
      if(path==='/tools'){
        const {Ledger}=await import('./src/research-tools.mjs');
        return send(await app.registry.execute(body.name,body.arguments||{},
          {maxRisk:'read',active:new Set(),skills:new Set(),ledger:new Ledger(body.allowedUrls||[])}));
      }
      if(path==='/cancel'){const job=jobs.get(body.id);if(job){job.cancelled=true;job.controller.abort();}return send({ok:true});}
      return send({error:'未知入口。'},404);
    }catch(e){send({error:String(e.message).slice(0,400)},400);}
  });
  // A poll, duplicate enqueue, or startup resumes the same persisted graph. Ordinary chats
  // retain their existing no-replay policy; only staged execution can be safely reconciled.
  for(const row of journal.recoverable())void enqueue(row.request).catch(e=>{backgroundError=String(e.message).slice(0,400);});
  return {app,server,status,tick,enqueue,jobs,journal,workflow,async close(){clearInterval(timer);for(const job of jobs.values())job.cancelled=true;
    await Promise.allSettled([...jobs.values()].map(j=>j.promise));server.closeAllConnections();
    await new Promise(r=>server.listening?server.close(r):r());workflow.close();await app.close();}};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const bridge=JSON.parse(readFileSync(resolve(data,'bridge.json'),'utf8'));
  const site=JSON.parse(readFileSync(resolve(data,'../hub/studio-config.json'),'utf8'));
  const host=await createWebsiteHost({token:bridge.token,owner:site.owner_id});
  host.server.listen(bridge.port,'127.0.0.1');
  // The original full console is retained for memory, relationships, research and tools.
  host.app.server.listen(SEAT==='codex'?17840:17839,'127.0.0.1');
  for(const server of [host.server,host.app.server])server.on('error',e=>{console.error(e.code);void host.close().then(()=>process.exit(1));});
  console.log('Original campus-companion '+UPSTREAM+' connected to luokixi.');
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>void host.close().then(()=>process.exit()));
}
