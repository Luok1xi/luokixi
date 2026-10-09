// Live check of the keyless research tools against real public APIs. No model calls, no cost.
// Usage: node test/live-research-tools.mjs   (writes test-output/live-research-tools.json)
import {mkdir,writeFile} from 'node:fs/promises';
import {createApp} from '../src/server.mjs';
import {Ledger} from '../src/research-tools.mjs';

const app=await createApp({dbPath:':memory:',background:false,models:{config:()=>({}),usage:()=>({spent:0,limit:0,rows:[]})}});
const ctx={ledger:new Ledger(),skills:new Set()},rows=[];
async function step(name,args,check){const t=Date.now();try{const r=await app.toolkit.execute(name,args,ctx);const note=check(r);rows.push({tool:name,args,ok:true,ms:Date.now()-t,note});console.log('✔',name,JSON.stringify(args),Date.now()-t+'ms',note);return r;}catch(e){rows.push({tool:name,args,ok:false,ms:Date.now()-t,error:e.message});console.log('✘',name,JSON.stringify(args),e.message);return null;}}
try{
  await step('wiki_search',{query:'初音未来',lang:'zh'},r=>`${r.results.length} 条；首条 ${r.results[0]?.title}`);
  await step('wiki_search',{query:'Simultaneous localization and mapping',lang:'en'},r=>`${r.results.length} 条；摘要 ${r.results[0]?.snippet.length} 字`);
  const oa=await step('scholar_search',{query:'retrieval augmented generation',source:'openalex',reviews_only:true,sort:'cited',max:5},r=>`${r.papers.length} 篇；首篇 ${r.papers[0]?.title}（${r.papers[0]?.year}，被引 ${r.papers[0]?.citations}）`);
  await step('scholar_search',{query:'CRISPR off-target detection',source:'europepmc',open_access_only:true,max:4},r=>`${r.papers.length} 篇；首篇 ${r.papers[0]?.title}`);
  await step('scholar_search',{query:'Attention is all you need',source:'crossref',max:3},r=>`首篇 DOI ${r.papers[0]?.doi}`);
  const ax=await step('scholar_search',{query:'visual SLAM transformer',source:'arxiv',sort:'recent',max:4},r=>`${r.papers.length} 篇；首篇 ${r.papers[0]?.title}`);
  const first=oa?.papers[0]?.ref;
  if(first){await step('paper_details',{ref:first},r=>`摘要 ${r.abstract.length} 字；主题 ${(r.topics||[]).slice(0,2).join(' / ')}`);
    await step('citations',{ref:first,direction:'cited_by',sort:'recent',max:4},r=>`${r.papers.length} 篇后续工作；最新 ${r.papers[0]?.year}`);}
  const paper=ax?.papers[0]?.ref||first;
  if(paper)await step('read_paper',{ref:paper,focus:'experiments results dataset'},r=>`读取级别 ${r.readLevel}，${r.pages||'-'} 页，${r.length} 字，返回 ${r.passages.length} 段`);
  await step('code_search',{query:'visual slam',sort:'stars',max:4},r=>`${r.results.length} 个仓库；首个 ${r.results[0]?.title} ★${r.results[0]?.stars}`);
  await step('qa_search',{query:'node sqlite database is locked',site:'stackoverflow',max:4},r=>`${r.results.length} 个问题；首个 ${r.results[0]?.title}`);
  await step('community_search',{platform:'hackernews',query:'deepseek'},r=>`${r.results.length} 条讨论`);
  const wikiRef=ctx.ledger.items.get('S1')?.ref;
  if(wikiRef)await step('read_page',{target:wikiRef,focus:'声库 发售'},r=>`${r.readLevel}，${r.length} 字，返回 ${r.passages.length} 段`);
  await step('web_search',{query:'测试'},r=>r.provider);
}finally{await app.close();}
const summary={at:new Date().toISOString(),ok:rows.filter(r=>r.ok).length,total:rows.length,ledgerSize:ctx.ledger.size,rows};
await mkdir(new URL('../test-output/',import.meta.url),{recursive:true});await writeFile(new URL('../test-output/live-research-tools.json',import.meta.url),JSON.stringify(summary,null,2));
console.log(`\n${summary.ok}/${summary.total} 项成功；来源账本 ${summary.ledgerSize} 条。结果写入 test-output/live-research-tools.json`);
