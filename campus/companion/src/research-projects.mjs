import {randomUUID} from 'node:crypto';
import {clip} from './research-tools.mjs';
import {characterName} from './character-card.mjs';

// Long research tasks run in the background, one at a time, outside the chat lock.
// Results persist in SQLite; the character announces completion in her own voice on the requesting channel.
const readLevels={'full-text':'全文','page-text':'网页正文','repository-readme':'仓库 README',abstract:'摘要','video-description':'视频简介','search-excerpt':'搜索摘要'};
const fmtDate=ms=>new Date(ms).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
const bibKey=(s,i)=>((s.authors?.[0]||s.site||'ref').split(/\s+/).pop().replace(/[^A-Za-z0-9]/g,'')||'ref')+(s.year||'')+'_'+(i+1);
const bibEscape=v=>String(v??'').replace(/[{}\\]/g,'');

export function reportMarkdown(row){
  const r=row.result;if(!r)return `# ${row.question}\n\n状态：${row.status}${row.error?'（'+row.error+'）':''}\n`;
  const lines=[`# 研究报告：${row.question}`,'',`生成于 ${fmtDate(row.updated*60000)} · 引用来源 ${r.sources.length} 个（共检索到 ${r.seen}） · 引文逐字核对 ${r.stats.verified}/${r.stats.findings} · 约 ¥${r.stats.cost} · 可信度 ${({high:'高',medium:'中',low:'低'})[r.confidence]}`,'','## 摘要','',r.answer||'（未形成摘要）',''];
  for(const s of r.sections)lines.push('## '+s.heading,'',s.content,'');
  if(r.findings.length){lines.push('## 关键发现','');for(const f of r.findings){lines.push(`- ${f.claim} ${f.sources.map(x=>'['+x+']').join('')}${f.verified?' ✓已核对原文':' ⚠未能逐字核对'}`);if(f.quote)lines.push(`  > ${f.quote}`);}lines.push('');}
  if(r.gaps.length)lines.push('## 尚未查清','',...r.gaps.map(g=>'- '+g),'');
  if(r.followups.length)lines.push('## 值得继续研究','',...r.followups.map(g=>'- '+g),'');
  lines.push('## 参考文献','');
  for(const s of r.sources){const who=s.authors?.length?s.authors.slice(0,6).join(', ')+(s.authors.length>6?' et al.':''):s.site||'';lines.push(`- [${s.ref}] ${who?who+'. ':''}${s.year?'('+s.year+'). ':''}${s.title||'（无标题）'}.${s.venue?' *'+s.venue+'*.':''} ${s.doi?'https://doi.org/'+s.doi:s.url||''}${s.readLevel?' 〔读取：'+(readLevels[s.readLevel]||s.readLevel)+'〕':''}`);}
  lines.push('','## 检索过程','',...r.trace.map(t=>`- 第 ${t.step} 步 ${t.args}：${t.ok?'成功':'失败（'+t.error+'）'}，${t.ms}ms`),'',`> 由 ${characterName} 检索执行器自动生成。只读取公开资料；“未能逐字核对”的条目请回到原文确认。`);
  return lines.join('\n');
}
export function reportBibtex(row){
  return (row.result?.sources||[]).map((s,i)=>{const key=bibKey(s,i),paper=!!(s.doi||s.arxiv||s.venue&&s.authors?.length);
    const f=[['title',s.title],['author',(s.authors||[]).join(' and ')],['year',s.year],[paper?'journal':'howpublished',paper?s.venue:s.url],['doi',s.doi],['eprint',s.arxiv],['url',s.doi?'https://doi.org/'+s.doi:s.url],['note',s.ref+(s.readLevel?' · '+(readLevels[s.readLevel]||s.readLevel):'')]].filter(([,v])=>v);
    return `@${paper?'article':'misc'}{${key},\n${f.map(([k,v])=>`  ${k} = {${bibEscape(v)}}`).join(',\n')}\n}`;}).join('\n\n');
}

export class ResearchProjects{
  constructor(service,{agent,chat}={}){
    Object.assign(this,{service,agent,chat});this.db=service.store.db;this.running=null;this.controller=null;this.inflight=Promise.resolve();
    this.db.exec('CREATE TABLE IF NOT EXISTS research_projects(id TEXT PRIMARY KEY,question TEXT NOT NULL,channel TEXT NOT NULL,status TEXT NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL,progress TEXT,result TEXT,error TEXT,cost REAL NOT NULL DEFAULT 0)');
    // A process restart cannot resume a half-finished agent run.
    this.db.prepare("UPDATE research_projects SET status='interrupted',error='服务重启，研究中断；可以重新开始。' WHERE status='running'").run();
  }
  row(id){const r=this.db.prepare('SELECT * FROM research_projects WHERE id=?').get(id);if(!r)throw new Error('研究项目不存在。');return {...r,progress:r.progress?JSON.parse(r.progress):null,result:r.result?JSON.parse(r.result):null};}
  list(){return this.db.prepare('SELECT id,question,channel,status,created,updated,progress,error,cost,result FROM research_projects ORDER BY created DESC LIMIT 30').all().map(r=>{const res=r.result?JSON.parse(r.result):null;return {id:r.id,question:r.question,channel:r.channel,status:r.status,created:r.created,updated:r.updated,error:r.error,cost:r.cost,progress:r.progress?JSON.parse(r.progress):null,summary:res?clip(res.answer,240):'',sources:res?.sources.length||0,verified:res?.stats.verified||0,findings:res?.stats.findings||0};});}
  start({question,channel='local'}){
    question=clip(question,500);if(question.length<4)throw new Error('研究问题太短。');
    if(!['local','weixin','feishu'].includes(channel))channel='local';
    const now=this.service.clock(),active=this.db.prepare("SELECT COUNT(*) n FROM research_projects WHERE status IN ('queued','running')").get().n;
    if(active>=3)throw new Error('已有 3 个研究在排队，等它们完成后再开始新的。');
    if(this.db.prepare('SELECT COUNT(*) n FROM research_projects WHERE created>?').get(now-1440).n>=6)throw new Error('今天已经开始了 6 个研究项目，明天再继续。');
    const dup=this.db.prepare("SELECT id FROM research_projects WHERE question=? AND status IN ('queued','running')").get(question);if(dup)return {...this.row(dup.id),duplicate:true};
    const id=randomUUID();this.db.prepare("INSERT INTO research_projects(id,question,channel,status,created,updated,progress) VALUES(?,?,?,'queued',?,?,?)").run(id,question,channel,now,now,JSON.stringify({step:0,text:'排队中'}));
    this.kick();return {id,question,status:'queued',position:active+1};
  }
  kick(){
    if(this.running)return;const next=this.db.prepare("SELECT * FROM research_projects WHERE status='queued' ORDER BY created LIMIT 1").get();if(!next)return;
    this.running=next.id;this.inflight=this.execute(next).catch(()=>{}).finally(()=>{this.running=null;this.controller=null;this.kick();});
  }
  update(id,fields){const keys=Object.keys(fields);this.db.prepare(`UPDATE research_projects SET ${keys.map(k=>k+'=?').join(',')},updated=? WHERE id=?`).run(...keys.map(k=>typeof fields[k]==='object'&&fields[k]!==null?JSON.stringify(fields[k]):fields[k]),this.service.clock(),id);}
  async execute(row){
    this.controller=new AbortController();const trail=[];
    this.update(row.id,{status:'running',progress:{step:0,text:'开始拆解问题',trail}});
    try{
      const result=await this.agent.run({task:row.question,mode:'deep',preload:['literature-review'],signal:this.controller.signal,purpose:'agent-research',
        onProgress:p=>{trail.push({step:p.step,text:p.text});this.update(row.id,{progress:{step:p.step,text:p.text,trail:trail.slice(-12)}});}});
      if(this.status(row.id)!=='running')return;
      const ok=!['error','incomplete'].includes(result.stats.stopped)&&!!result.answer;
      this.update(row.id,{status:ok?'done':'partial',result,cost:result.stats.cost,progress:{step:result.stats.steps,text:ok?'完成':'部分完成',trail:trail.slice(-12)},error:ok?null:result.gaps[0]||'研究未完整结束'});
      await this.notify(this.row(row.id));
    }catch(e){if(this.status(row.id)==='running')this.update(row.id,{status:'failed',error:clip(e.message,300)});}
  }
  status(id){return this.db.prepare('SELECT status FROM research_projects WHERE id=?').get(id)?.status;}
  async notify(row){
    const r=row.result,now=this.service.clock(),footer=`（完整报告：电脑端「资料与目标 → 科研项目」，含 ${r.sources.length} 个参考来源，可导出 Markdown / BibTeX。）`;
    let reply=null;
    try{if(this.chat)reply=await this.chat.exclusive(()=>this.chat.compose({trigger:'manual',act:'sharing',material:{researchReport:{question:row.question,status:row.status,summary:clip(r.answer,1600),keyFindings:r.findings.slice(0,5).map(f=>f.claim),gaps:r.gaps.slice(0,3),confidence:r.confidence,note:'这是你在后台完成的调研结果，现在告诉对方结论要点；不要逐条念参考文献，引用和完整报告会另外附上。'}}}));}catch{}
    const base=reply?.text?.trim()?reply:{text:`调研完成：${row.question}\n\n${clip(r.answer,900)}`,messages:[{type:'text',text:`调研完成：${row.question}\n\n${clip(r.answer,900)}`}]};
    const text=base.text+'\n\n'+footer,messages=[...(base.messages?.length?base.messages:[{type:'text',text:base.text}]),{type:'text',text:footer}];
    this.service.store.transaction(()=>{this.service.store.addChat('assistant',text,now,messages);if(['weixin','feishu'].includes(row.channel))this.service.store.enqueue(row.channel+':reply:project:'+row.id,now,now+360,{kind:'reply',text,messages},row.channel);});
  }
  shutdown(){if(this.running)this.update(this.running,{status:'interrupted',error:'服务停止，研究中断；可以重新开始。'});this.controller?.abort();return this.inflight;}
  cancel(id){const s=this.status(id);if(!s)throw new Error('研究项目不存在。');if(!['queued','running'].includes(s))return {message:'这个研究已经结束。'};this.update(id,{status:'cancelled',error:'已手动停止'});if(this.running===id)this.controller?.abort();return {message:'已停止。已经产生的模型费用仍计入账本。'};}
  remove(id){const s=this.status(id);if(!s)throw new Error('研究项目不存在。');if(['queued','running'].includes(s))this.cancel(id);this.db.prepare('DELETE FROM research_projects WHERE id=?').run(id);return {message:'已删除这个研究项目及其报告。'};}
}
