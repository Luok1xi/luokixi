import {Vision} from './vision.mjs';
import {CrawlEngine} from './crawl-engine.mjs';
import {Inquiry} from './inquiry.mjs';
import {StickerFinder} from './sticker-finder.mjs';
import {CapabilityMemory} from './capability-memory.mjs';
import {ResearchCortex,RepositoryReader} from './research-cortex.mjs';
import {BrowserReader} from './browser-reader.mjs';
import {Downloads} from './downloads.mjs';
import {AdaptiveReader,WebTools} from './web-tools.mjs';
import {stickerAssets} from './message-chain.mjs';
import {characterCard,characterName,characterPublic} from './character-card.mjs';
import {existsSync} from 'node:fs';
import {Weixin} from './weixin.mjs';
import http from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {resolve,extname,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {Store} from './store.mjs';
import {Service,id} from './service.mjs';
import {nowMinute} from './time.mjs';
import {Models} from './models.mjs';
import {Chat} from './chat.mjs';
import {readConfig,saveConfig,publicConfig} from './config.mjs';
import {Feishu} from './feishu.mjs';
import {ConversationLibrary} from './conversation-library.mjs';
import {SocialWatch} from './social-watch.mjs';
import {WechatReader,QQReader} from './social-readers.mjs';
import {Scheduler} from './reminders.mjs';
import {WebLife} from './web-life.mjs';
import {Agency} from './agency.mjs';
import {Learning} from './learning.mjs';
import {Research} from './research.mjs';
import {Skills} from './skills.mjs';
import {ResearchToolkit} from './research-tools.mjs';
import {ToolAgent} from './agent.mjs';
import {ToolRegistry} from './tool-registry.mjs';
import {connectMcp} from './mcp-tools.mjs';
import {Speech} from './tts.mjs';
import {Embedder,SemanticMemory} from './semantic-memory.mjs';
import {MemoryWriter} from './memory-writer.mjs';
import {HubClient,SiteKeeper,siteBoards} from './site-hub.mjs';
import {SelfStudy} from './self-study.mjs';
import {selfState} from './self-state.mjs';
import {ResearchProjects,reportMarkdown,reportBibtex} from './research-projects.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export async function createApp({dbPath=resolve(process.env.MIKU_DATA||root+'/data','miku.sqlite'),clock=nowMinute,models:providedModels,background=true,weixinOptions={},researchOptions={}}={}){
  const store=new Store(dbPath,clock()),service=new Service(store,clock),models=providedModels||new Models(store,readConfig,{clock}),chat=new Chat(service,models),feishu=new Feishu(service,chat),weixin=new Weixin(service,chat,weixinOptions),scheduler=new Scheduler(service,{chat,sendFeishu:(p,k)=>feishu.send(p,k),feishuReady:()=>feishu.ready(),sendWeixin:(p,k)=>weixin.send(p,k),weixinReady:()=>weixin.ready()});
  const conversations=new ConversationLibrary(service,models,chat);
  const social=new SocialWatch(service,conversations,{weixin:new WechatReader(root),qq:new QQReader(root)});
  scheduler.social=social;weixin.social=social;chat.social=social;
  const learning=new Learning(service,models);
  const research=new Research(service,models,researchOptions);
  const dataDir=dbPath===':memory:'?resolve(process.env.TEMP||root,'miku-test-'+randomBytes(8).toString('hex')):dirname(dbPath);
  const memory=new CapabilityMemory(service),repositories=new RepositoryReader(),cortex=new ResearchCortex(service,models,{repositories,memory});
  const vision=new Vision(service,models),browser=new BrowserReader({dataDir}),downloads=new Downloads(service,{directory:resolve(dataDir,'downloads')}),reader=new CrawlEngine({service,reader:new AdaptiveReader({browser,downloads,memory})}),tools=new WebTools({reader,downloads,vision,models,memory,repositories});
  const inquiry=new Inquiry(service,models,{reader}),stickerFinder=new StickerFinder(service,{downloads,vision});tools.stickerFinder=stickerFinder;weixin.stickerFile=id=>downloads.file(id);
  learning.reader=async url=>{const doc=await reader.document(url);return {...doc,hash:(await import('./public-reader.mjs')).digest(doc.text)};};
  chat.vision=vision;chat.tools=tools;chat.cortex=cortex;
  // Skill-guided multi-step research: toolkit (read-only sources) + agent loop + background projects.
  const agentConfig=()=>({...readConfig(),...(providedModels&&typeof models.config==='function'?models.config():{})});
  const skills=new Skills(),toolkit=new ResearchToolkit({config:agentConfig,reader,repositories,models,memory,skills,db:store.db}),registry=new ToolRegistry({states:()=>service.state().toolGroups||{}}).mount('research',toolkit,{title:'检索与研究',state:'on'}),agent=new ToolAgent({models,toolkit:registry,skills,memory,config:agentConfig}),projects=new ResearchProjects(service,{agent,chat});
  if(agentConfig().agentEnabled!==false){chat.agent=agent;chat.projects=projects;}
  chat.conversation.register(registry);
  const mcp=agentConfig().mcpServers.length?await connectMcp(registry,agentConfig().mcpServers):{status:[],close:async()=>{}};
  const webLife=new WebLife(service,models,{reader});
  const selfStudy=new SelfStudy(service,models,agent),speech=new Speech({config:agentConfig,dir:resolve(dataDir,'tts-cache')}),embedder=new Embedder({config:agentConfig,cacheDir:resolve(dataDir,'models')}),memoryWriter=new MemoryWriter(service,models);chat.semantic=new SemanticMemory(store.db,embedder);
  const siteClient=new HubClient({config:agentConfig}),siteKeeper=new SiteKeeper(service,models,chat,{client:siteClient,config:agentConfig});siteKeeper.registerTools(registry);
  const agency=new Agency(service,chat,models,learning,webLife,selfStudy,siteKeeper);
  chat.webLife=webLife;chat.runtimeInfo=()=>({connected:true,enabled:service.state().agency.enabled,...agency.shareStatus(),weixinReady:weixin.ready(),weixinStatus:weixin.info().status,requires:'电脑服务运行、有有效微信会话；受免打扰、每日次数和未回复限制。发送由后台定时检查，不需要新消息触发。'});
  const viewState=()=>({...service.state(),self:selfState(service.state(),service.clock(),{usage:models.usage?.()}),proactive:{...agency.shareStatus(),weixinReady:weixin.ready(),weixinStatus:weixin.info().status}});
  const token=randomBytes(32).toString('hex');let lastError='';
  const auth=value=>typeof value==='string'&&value.length===token.length&&timingSafeEqual(Buffer.from(value),Buffer.from(token));
  const json=(res,data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
  const body=async(req,limit=256000)=>{let size=0,chunks=[];for await(const c of req){size+=c.length;if(size>limit)throw new Error('请求内容过大。');chunks.push(c);}return Buffer.concat(chunks);};
  const server=http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Content-Security-Policy',"default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");
    const port=server.address()?.port,host=`127.0.0.1:${port}`;
    if(req.headers.host!==host){json(res,{error:'请使用本机 127.0.0.1 地址访问。'},403);return;}
    if(req.headers.origin&&req.headers.origin!==`http://${host}`||req.headers['sec-fetch-site']==='cross-site'){json(res,{error:'拒绝跨站请求。'},403);return;}
    const url=new URL(req.url,`http://${host}`);
    try{
      if(req.method==='GET'&&url.pathname==='/api/bootstrap'){res.setHeader('Set-Cookie',`miku_session=${token}; HttpOnly; SameSite=Strict; Path=/`);json(res,{csrf:token,character:characterPublic(file=>existsSync(resolve(root,'public/art',file))),state:viewState(),config:publicConfig(agentConfig()),usage:models.usage(),feishu:feishu.info(),weixin:weixin.info(),lastError});return;}
      if(req.method==='GET'&&url.pathname==='/health'){json(res,{app:'miku-local',version:'0.1.0',ready:true});return;}
      if(url.pathname.startsWith('/api/')){
        const cookie=req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith('miku_session='))?.slice(13);
        if(!auth(cookie)||req.method!=='GET'&&!auth(req.headers['x-miku-token'])){json(res,{error:'会话已过期，请刷新页面。'},403);return;}
        if(req.method==='GET'&&url.pathname==='/api/state'){json(res,{state:viewState(),usage:models.usage(),feishu:feishu.info(),weixin:weixin.info(),lastError});return;}
        if(req.method==='GET'&&url.pathname==='/api/export'){res.setHeader('Content-Disposition','attachment; filename="miku-backup.json"');json(res,{exportedAt:new Date().toISOString(),state:store.read(),chat:store.chats(),usage:models.usage(),cognition:cortex.status(),capabilityExperience:memory.view()});return;}
        if(req.method==='POST'&&url.pathname==='/api/import'){const mime=String(req.headers['content-type']||'');const buffer=await body(req,12*1024*1024);const {importTimetable}=await import('./importer.mjs');const draft=await importTimetable(buffer,mime,models);json(res,service.command('draft.add',draft));return;}
        if(req.method==='POST'&&url.pathname==='/api/vision/chat'){const imageBuffer=await body(req,8*1024*1024);json(res,await chat.run(url.searchParams.get('text')||'看看这张图片',{requestId:url.searchParams.get('requestId')||id(),imageBuffer}));return;}
        if(req.method==='GET'&&url.pathname==='/api/research-kit'){const c=publicConfig(readConfig());json(res,{status:toolkit.status(),skills:skills.catalog(),skillErrors:skills.errors,projects:projects.list(),config:{tavilyConfigured:c.tavilyConfigured,bochaConfigured:c.bochaConfigured,braveConfigured:c.braveConfigured,s2Configured:c.s2Configured,searxngUrl:c.searxngUrl,agentEnabled:c.agentEnabled,agentQuickLimit:c.agentQuickLimit,researchRunLimit:c.researchRunLimit},experience:memory.view().filter(r=>/search|read-|citations|cited-source/.test(r.capability)).slice(0,30)});return;}
        if(req.method==='GET'&&url.pathname==='/api/projects/get'){json(res,projects.row(url.searchParams.get('id')));return;}
        if(req.method==='GET'&&url.pathname==='/api/projects/export'){const row=projects.row(url.searchParams.get('id')),bib=url.searchParams.get('format')==='bib';res.writeHead(200,{'Content-Type':(bib?'application/x-bibtex':'text/markdown')+'; charset=utf-8','Content-Disposition':`attachment; filename="miku-research-${row.id.slice(0,8)}.${bib?'bib':'md'}"`,'Cache-Control':'no-store'});res.end(bib?reportBibtex(row):reportMarkdown(row));return;}
        if(req.method==='GET'&&url.pathname==='/api/site'){const site=service.state().site||{};json(res,{configured:siteClient.configured(),account:siteClient.user?.username||null,boards:siteBoards,site:{...site,drafts:(site.drafts||[]).slice(-20).reverse(),handled:undefined}});return;}
        if(req.method==='GET'&&url.pathname==='/api/memory/recall'){json(res,{embedding:embedder.status(),writer:service.state().memoryWriter||null});return;}
        if(req.method==='GET'&&url.pathname==='/api/tools/registry'){json(res,{groups:registry.groups(),mcp:mcp.status});return;}
        if(req.method==='GET'&&url.pathname==='/api/tools'){json(res,{browser:browser.status,reading:reader.health,downloads:downloads.list(),traces:tools.traces,vision:models.config().deepseekModel,capabilities:memory.view()});return;}
        if(req.method==='GET'&&url.pathname.startsWith('/api/download/')){const file=await downloads.file(url.pathname.slice(14));res.writeHead(200,{'Content-Type':file.mime,'Content-Disposition':'attachment; filename="miku-'+file.id.slice(0,12)+'.'+file.ext+'"'});res.end(file.bytes);return;}
        const input=req.method==='POST'?JSON.parse((await body(req)).toString()||'{}'):{};
        if(req.method==='POST'&&url.pathname==='/api/site/check'){const row=await siteKeeper.check();if(agentConfig().sitePath)await siteKeeper.checkContent();json(res,{check:row,validation:service.state().site?.validation||null});return;}
        if(req.method==='POST'&&url.pathname==='/api/site/submit'){json(res,await siteKeeper.submit(String(input.id||'')));return;}
        if(req.method==='POST'&&url.pathname==='/api/tts'){const r=await speech.synthesize(String(input.text||''),{language:input.language||'zh',expression:input.expression});res.writeHead(200,{'Content-Type':r.type,'Cache-Control':'no-store','X-Tts-Cached':String(r.cached)});res.end(r.audio);return;}
        if(req.method==='GET'&&url.pathname==='/api/social'){json(res,social.status());return;}
        if(req.method==='POST'&&url.pathname==='/api/social/settings'){json(res,social.configure(input.platform,input.enabled));return;}
        if(req.method==='POST'&&url.pathname==='/api/social/check'){await social.tick();json(res,social.status());return;}
        if(req.method==='GET'&&url.pathname==='/api/conversations'){json(res,{sources:conversations.sources()});return;}
        if(req.method==='GET'&&url.pathname==='/api/conversations/read'){const sourceId=url.searchParams.get('id');json(res,{...conversations.read(sourceId),analysis:conversations.result(sourceId)});return;}
        if(req.method==='POST'&&url.pathname==='/api/conversations/import'){json(res,conversations.import(input));return;}
        if(req.method==='POST'&&url.pathname==='/api/conversations/analyze'){json(res,await conversations.analyze(input.sourceId));return;}
        if(req.method==='POST'&&url.pathname==='/api/conversations/remove'){json(res,conversations.remove(input.sourceId));return;}
        if(req.method==='POST'&&url.pathname==='/api/chat'){
          res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache','Connection':'keep-alive'});
          const send=(type,data)=>{if(!res.destroyed)res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);};
          const heartbeat=setInterval(()=>{if(!res.destroyed)res.write(': keepalive\n\n');},15000);
          try{send('status',{text:'…'});const r=await chat.run(input.text,{requestId:input.requestId||id(),deep:input.deep===true,mode:['auto','fast','deep'].includes(input.mode)?input.mode:'auto',onDelta:text=>send('delta',{text}),onStatus:text=>send('status',{text})});send('done',r);}catch(e){send('error',{error:e.message});}finally{clearInterval(heartbeat);res.end();}return;
        }
        if(req.method==='POST'&&url.pathname==='/api/command'){
          if(['proposal.create','draft.add','relationship.confirm'].includes(input.action))throw new Error('该操作只能从有效的模型结果或提议进入。');json(res,['agency.settings','agency.clear','web.settings','web.clear','web.source.toggle','tools.group','site.settings','site.draft.discard'].includes(input.action)?service.command(input.action,input.args,input.requestId||id()):await chat.exclusive(()=>service.command(input.action,input.args,input.requestId||id())));return;
        }
        if(req.method==='POST'&&url.pathname==='/api/download/remove'){json(res,await downloads.remove(input.id));reader.clear();return;}
        if(req.method==='POST'&&url.pathname==='/api/browser/login'){json(res,await browser.openLogin(input.site));return;}
        if(req.method==='POST'&&url.pathname==='/api/browser/confirm'){const r=browser.confirm(input.site);reader.clear();memory.resetAccess();webLife.save(w=>{w.accessRestoredAt=clock();});json(res,r);return;}
        if(req.method==='POST'&&url.pathname==='/api/config'){json(res,saveConfig(input));return;}
        if(req.method==='POST'&&url.pathname==='/api/projects/start'){json(res,projects.start({question:String(input.question||''),channel:'local'}));return;}
        if(req.method==='POST'&&url.pathname==='/api/projects/cancel'){json(res,projects.cancel(String(input.id||'')));return;}
        if(req.method==='POST'&&url.pathname==='/api/projects/remove'){json(res,projects.remove(String(input.id||'')));return;}
        if(req.method==='POST'&&url.pathname==='/api/investigate'){const question=String(input.question||'').trim();if(question.length<2)throw new Error('请输入要查的问题。');json(res,await agent.run({task:question,mode:'quick'}));return;}
        if(req.method==='GET'&&url.pathname==='/api/weixin/status'){json(res,weixin.info());return;}
        if(req.method==='POST'&&url.pathname==='/api/weixin/login'){json(res,await weixin.startLogin());return;}
        if(req.method==='POST'&&url.pathname==='/api/weixin/poll'){json(res,await weixin.pollLogin(input.id,input.verifyCode));return;}
        if(req.method==='POST'&&url.pathname==='/api/weixin/disconnect'){await weixin.disconnect();json(res,{message:'已断开微信并删除本机登录凭证。手机授权可在微信插件管理中解除。'});return;}
        if(req.method==='POST'&&url.pathname==='/api/weixin/test'){
          if(!weixin.ready())throw new Error('请先扫码绑定，再从微信发一条文字消息。');
          const key='weixin:reply:test:'+id(),text=input.stickerTest===true?'连接测试：下面连续发送两张表情图片。':characterName+' 微信连接测试。手机收到此条消息后，文字收发通道才算完成验收。';
          store.enqueue(key,clock(),clock()+10,{kind:'reply',text,...(input.stickerTest===true?{messages:[{type:'text',text},{type:'sticker',id:'eyes'},{type:'sticker',id:'wave'}]}:{})},'weixin');
          await scheduler.deliver();const row=store.db.prepare('SELECT status,error FROM outbox WHERE id=?').get(key);json(res,{message:'测试消息已提交，请以手机实际收到为准。',delivery:row});return;
        }
        if(req.method==='POST'&&url.pathname==='/api/feishu/connect'){void feishu.connect().catch(e=>{lastError='飞书连接未成功，请检查应用凭证与网络。';feishu.status=lastError;});json(res,{message:'正在连接，稍后查看连接状态。'});return;}
        if(req.method==='POST'&&url.pathname==='/api/feishu/pair'){json(res,feishu.pairingCode());return;}
        if(req.method==='POST'&&url.pathname==='/api/research'){json(res,await research.run({manual:true}));return;}
        if(req.method==='POST'&&url.pathname==='/api/web/share'){
          const {key,composed,noteId}=await chat.exclusive(async()=>{
            const state=service.state(),note=state.webLife.notes.find(n=>n.id===input.noteId);
            if(!state.webLife.enabled||!note)throw new Error('这篇阅读日记不存在或网上见闻已暂停。');
            if(!weixin.ready())throw new Error('微信当前没有有效会话，不能发送。');
            const key='weixin:reply:web-note:'+note.id;
            const delivery=store.db.prepare('SELECT payload FROM outbox WHERE id=?').get(key);
            const composed=delivery?JSON.parse(delivery.payload):await chat.compose({trigger:'manual',material:{reading:note}});
            store.enqueue(key,clock(),clock()+10,{kind:'reply',manual:true,text:composed.text,messages:composed.messages},'weixin');
            return {key,composed,noteId:note.id};
          });
          // Delivery may itself request the shared writer; never wait for it while owning Chat's lock.
          await scheduler.deliver();
          const row=store.db.prepare('SELECT status,error FROM outbox WHERE id=?').get(key);
          if(row?.status==='sent')store.transaction(()=>{const current=store.read(),saved=current.webLife.notes.find(n=>n.id===noteId);if(saved&&!saved.sharedAt){saved.sharedAt=clock();store.save(current);store.addChat('assistant',composed.text,clock(),composed.messages);}});
          json(res,{status:row?.status||'cancelled',message:row?.status==='sent'?'日记已由微信接口接受；手机是否弹出通知仍需设备确认。':'日记尚未送达：'+(row?.error||row?.status||'已取消')});return;
        }
        if(req.method==='POST'&&url.pathname==='/api/web/read'){json(res,await chat.exclusive(()=>webLife.run({sourceId:input.sourceId})));return;}
        if(req.method==='POST'&&url.pathname==='/api/agency'){json(res,await agency.run());return;}
        if(req.method==='GET'&&url.pathname==='/api/cognition'){json(res,{...cortex.status(),capabilities:memory.view()});return;}
        if(req.method==='POST'&&url.pathname==='/api/cognition/research'){json(res,await chat.exclusive(()=>cortex.run({manual:true})));return;}
        if(req.method==='POST'&&url.pathname==='/api/study'){json(res,await learning.run({manual:true,topicId:input.topicId}));return;}
        if(req.method==='POST'&&url.pathname==='/api/check-model'){const r=await models.complete([{role:'user',content:'只回复：连接成功'}],{maxOutput:256,json:false});json(res,{message:r.text,model:r.model,latencyMs:r.latencyMs});return;}
        if(req.method==='POST'&&url.pathname==='/api/check-style'){const {previewStyle}=await import('./style-eval.mjs');json(res,await chat.exclusive(()=>previewStyle(models,clock,{suite:['emotion','natural','sincerity','freeform'].includes(input.suite)?input.suite:'style'})));return;}
        if(req.method==='POST'&&url.pathname==='/api/feishu/test'){if(!feishu.ready())throw new Error('请先连接飞书并绑定你的账号。');const key='feishu:reply:test:'+id();store.enqueue(key,clock(),clock()+10,{kind:'reply',text:'这是一条 '+characterName+' 的连接测试消息。收到后，回复“你好”试试。'},'feishu');await scheduler.deliver();json(res,{message:'已提交测试消息，请以手机实际收到为准。'});return;}
        json(res,{error:'没有这个接口。'},404);return;
      }
      if(req.method==='GET'&&url.pathname==='/wechat-guide'){const guide=await readFile(resolve(root,'WECHAT-GUIDE.md'),'utf8');res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8'});res.end(guide);return;}
      if(req.method==='GET'&&url.pathname==='/character-guide'){const guide=await readFile(resolve(root,'CHARACTER-MOYU.md'),'utf8');res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8'});res.end(guide);return;}
      if(req.method!=='GET'){json(res,{error:'不支持的方法。'},405);return;}
      // Only the character card's named art files are served, and only once they exist on disk.
      if(url.pathname.startsWith('/art/')){const name=url.pathname.slice(5),file=resolve(root,'public/art',name);if(!Object.values(characterCard.art||{}).includes(name)||!existsSync(file)){json(res,{error:'图片不存在。'},404);return;}res.writeHead(200,{'Content-Type':name.endsWith('.webp')?'image/webp':'image/png','Cache-Control':'no-cache'});res.end(await readFile(file));return;}
      if(req.method==='GET'&&url.pathname.startsWith('/stickers/')){const sticker=stickerAssets.find(s=>url.pathname==='/stickers/'+s.file);if(!sticker){json(res,{error:'表情不存在。'},404);return;}const bytes=sticker.downloadId?(await downloads.file(sticker.downloadId)).bytes:await readFile(resolve(root,'public/stickers',sticker.file));res.writeHead(200,{'Content-Type':'image/png','Cache-Control':'public, max-age=86400'});res.end(bytes);return;}
      const files={'/':'index.html','/app.js':'app.js','/tools-ui.js':'tools-ui.js','/voice-ui.js':'voice-ui.js','/memory-search-ui.js':'memory-search-ui.js','/site-ui.js':'site-ui.js','/cognition-ui.js':'cognition-ui.js','/learning-ui.js':'learning-ui.js','/agency-ui.js':'agency-ui.js','/web-life-ui.js':'web-life-ui.js','/research-ui.js':'research-ui.js','/research-kit-ui.js':'research-kit-ui.js','/social-ui.js':'social-ui.js','/conversation-library-ui.js':'conversation-library-ui.js','/weixin-ui.js':'weixin-ui.js','/character.js':'character.js','/style.css':'style.css'};const file=files[url.pathname];if(!file){json(res,{error:'页面不存在。'},404);return;}
      const content=await readFile(resolve(root,'public',file));res.writeHead(200,{'Content-Type':({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'})[extname(file)],'Cache-Control':'no-cache'});res.end(content);
    }catch(e){if(!res.headersSent)json(res,{error:e.message},400);else res.end();}
  });
  let timer;if(background){const tick=async()=>{void social.tick().catch(e=>{lastError=e.message;});void weixin.processInbox();void feishu.processInbox().catch(e=>{lastError=e.message;});if(!chat.active&&cortex.due())void chat.exclusive(()=>cortex.run()).catch(e=>{lastError=e.message;});else if(!chat.active&&inquiry.due())void chat.exclusive(()=>inquiry.run()).catch(e=>{lastError=e.message;});else if(!chat.active&&webLife.dailyDue())void chat.exclusive(()=>webLife.daily()).catch(e=>{lastError=e.message;});else if(!chat.active&&memoryWriter.due())void chat.exclusive(()=>memoryWriter.run()).catch(e=>{lastError=e.message;});else void agency.tick().catch(e=>{lastError=e.message;});if(!chat.active){void research.tick()?.catch(e=>{lastError=e.message;});}if(siteKeeper.due())void siteKeeper.tick().catch(e=>{lastError=e.message;});try{await scheduler.tick();}catch(e){lastError=e.message;}};timer=setInterval(tick,20000);timer.unref();projects.kick();await scheduler.tick();weixin.connect();void feishu.connect().catch(()=>{feishu.status='连接失败，请检查凭证和网络。';});}
  return {server,store,service,models,chat,scheduler,conversations,social,feishu,weixin,learning,research,agency,selfStudy,speech,embedder,memoryWriter,siteKeeper,webLife,vision,browser,downloads,tools,cortex,memory,inquiry,skills,toolkit,registry,agent,projects,async close(){clearInterval(timer);await mcp.close();await projects.shutdown();await social.close();await feishu.close();await weixin.close();await agency.inflight;await agent.pending;await scheduler.inflight;await chat.queue;await chat.conversation.pending;await learning.inflight;await research.inflight;await reader.tail;await browser.close();server.closeAllConnections();await new Promise(r=>server.listening?server.close(r):r());store.close();}};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const app=await createApp();const port=Number(process.env.MIKU_PORT)||17839;
  app.server.on('error',e=>{console.error(e.code==='EADDRINUSE'?`端口 ${port} 已被占用。若 ${characterName} 已启动，请打开 http://127.0.0.1:${port}`:e.message);process.exitCode=1;void app.close();});
  app.server.listen(port,'127.0.0.1',()=>console.log(`${characterName} 本地控制台：http://127.0.0.1:${port}\n关闭此进程后，主动提醒暂停。密钥仅保存在本机 data/config.json。`));
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{void app.close().then(()=>process.exit());});
}
