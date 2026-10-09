import {bingSearch} from '../vendor/qq-bridge/search.js';
import {createHash} from 'node:crypto';
import {XMLParser,XMLValidator} from 'fast-xml-parser';
import {sourceUrl} from './research-state.mjs';
import {publicBytes} from './downloads.mjs';

// Research toolkit for the tool agent. Every tool is read-only; URLs must come from the user's
// message or from earlier tool results in the same run (tracked by Ledger). Retrieved text is data.
const UA='MikuResearch/1.0 (personal low-frequency research)';
const CJK=/[\u3400-\u9fff]/;
export const clip=(s,n)=>{s=String(s??'').replace(/\s+/g,' ').trim();return s.length>n?s.slice(0,n)+'…':s;};
export const stripTags=s=>String(s??'').replace(/<[^>]*>/g,' ').replace(/&nbsp;/g,' ').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#0?39;|&apos;/g,"'").replace(/&amp;/g,'&').replace(/\s+/g,' ').trim();
const safeUrl=v=>{try{return sourceUrl(String(v).replace(/^http:\/\//i,'https://'));}catch{return null;}};
const hash=v=>createHash('sha256').update(v).digest('hex');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const list=v=>v==null?[]:Array.isArray(v)?v:[v];
const year=v=>{const n=Number(String(v??'').slice(0,4));return n>1000&&n<3000?n:null;};

export async function getJson(fetcher,url,{method='GET',headers={},body,timeout=20000}={}){
  const res=await fetcher(url,{method,body,headers:{'User-Agent':UA,Accept:'application/json',...headers},signal:AbortSignal.timeout(timeout)});
  const text=await res.text();if(text.length>4e6)throw new Error('接口返回内容过大。');
  if(!res.ok)throw new Error(`HTTP ${res.status}`+(res.status===429?'（接口限流，稍后再试或换来源）':res.status===401||res.status===403?'（密钥无效或无权限）':''));
  try{return JSON.parse(text);}catch{throw new Error('接口返回格式无效。');}
}
async function getText(fetcher,url,{headers={},timeout=25000}={}){
  const res=await fetcher(url,{headers:{'User-Agent':UA,...headers},signal:AbortSignal.timeout(timeout)});
  const text=await res.text();if(text.length>6e6)throw new Error('接口返回内容过大。');if(!res.ok)throw new Error('HTTP '+res.status);return text;
}

// ---- Passage selection: return the parts of a long text that match the agent's focus ----
const STOP=new Set('the a an of and or to in on for with by from is are was were be been as at that this these those it its into via using use used based than then also can may our we their which such not but have has had more most other'.split(' '));
export function terms(text){
  const s=String(text||'').toLowerCase(),out=(s.match(/[a-z0-9][a-z0-9+#]*(?:[.-][a-z0-9+#]+)*/g)||[]).filter(w=>w.length>=2&&!STOP.has(w));
  for(const run of s.match(/[\u3400-\u9fff]+/g)||[]){if(run.length===1)out.push(run);for(let i=0;i<run.length-1;i++)out.push(run.slice(i,i+2));}
  return out;
}
export function chunks(text,size=700){
  const sentences=String(text||'').replace(/\r/g,'').split(/(?<=[。！？!?；;])\s*|(?<=\.)\s+(?=[A-Z0-9“"(])|\n+/).map(x=>x.trim()).filter(Boolean),out=[];let cur='';
  for(const s of sentences){if(cur&&cur.length+s.length>size){out.push(cur);cur='';}if(s.length>size*1.5){for(let i=0;i<s.length;i+=size)out.push(s.slice(i,i+size));continue;}cur+=(cur?' ':'')+s;}
  if(cur)out.push(cur);return out;
}
export function passages(text,focus,{size=700,limit=4}={}){
  const parts=chunks(text,size),q=[...new Set(terms(focus))];
  if(!q.length)return parts.slice(0,limit).map((t,index)=>({index,text:t}));
  const bags=parts.map(p=>{const m=new Map();for(const t of terms(p))m.set(t,(m.get(t)||0)+1);return m;}),N=parts.length;
  const df=new Map(q.map(t=>[t,bags.filter(b=>b.has(t)).length])),phrase=String(focus||'').trim().toLowerCase();
  const scored=parts.map((p,index)=>{let s=0;for(const t of q){const tf=bags[index].get(t)||0;if(tf)s+=(1+Math.log(tf))*Math.log(1+N/(1+df.get(t)));}if(phrase.length>=4&&p.toLowerCase().includes(phrase))s+=3;return {index,text:p,score:s};});
  const top=scored.filter(x=>x.score>0).sort((a,b)=>b.score-a.score).slice(0,limit);
  return (top.length?top:scored.slice(0,limit)).sort((a,b)=>a.index-b.index).map(({index,text})=>({index,text}));
}

// ---- Ledger: stable reference ids (S=web/page, P=paper), URL provenance and verbatim-quote checks ----
const normalizeQuote=s=>String(s||'').toLowerCase().replace(/[\s"'“”‘’「」『』《》（）()\[\]【】,，.。:：;；!！?？、\-–—…·]/g,'');
export class Ledger{
  constructor(allowedUrls=[]){this.items=new Map();this.keys=new Map();this.allowed=new Set(allowedUrls.map(safeUrl).filter(Boolean));this.count={S:0,P:0};}
  get size(){return this.items.size;}
  key(x){return x.doi?'doi:'+String(x.doi).toLowerCase():x.arxiv?'arxiv:'+String(x.arxiv).replace(/v\d+$/,''):x.url?'url:'+x.url:'title:'+normalizeQuote(x.title).slice(0,120);}
  allow(url){const u=safeUrl(url);if(u)this.allowed.add(u);return u;}
  allows(url){const u=safeUrl(url);return !!u&&this.allowed.has(u);}
  add(x,prefix='S'){
    const url=x.url?this.allow(x.url):null;for(const u of [x.oaPdf,x.oaUrl,x.discussion])if(u)this.allow(u);
    const k=this.key({...x,url});let ref=this.keys.get(k);
    if(!ref){ref=prefix+(++this.count[prefix]);this.keys.set(k,ref);this.items.set(ref,{ref,texts:[]});}
    const item=this.items.get(ref);for(const [key,value]of Object.entries(x))if(value!=null&&value!==''&&key!=='text'&&(item[key]==null||item[key]===''))item[key]=key==='url'?url:value;
    if(x.text)this.addText(ref,x.text);return ref;
  }
  addText(ref,text){const item=this.items.get(ref);if(item&&text){const t=String(text).slice(0,300000);if(!item.texts.includes(t))item.texts.push(t);}}
  get(ref){return this.items.get(String(ref||'').trim().toUpperCase());}
  resolve(target){
    const t=String(target||'').trim(),item=/^[SP]\d+$/i.test(t)?this.get(t):null;
    if(/^[SP]\d+$/i.test(t)&&!item)throw new Error('编号 '+t+' 不存在，请使用本次结果中出现过的编号。');
    const url=item?item.url:t;if(!url)throw new Error('该条目没有可读取的网址。');
    if(!this.allows(url))throw new Error('只能读取用户消息里的网址或本次检索结果中出现过的网址/编号。');return {url:safeUrl(url),item};
  }
  verify(quote,refs){const q=normalizeQuote(quote);if(q.length<6)return false;return refs.some(r=>this.get(r)?.texts.some(t=>normalizeQuote(t).includes(q)));}
  public(ref){const x=this.get(ref);if(!x)return null;const {texts,...rest}=x;return Object.fromEntries(Object.entries(rest).filter(([k,v])=>v!=null&&v!==''&&!['abstract','snippet','score'].includes(k)));}
}

// ---- General web search providers (need a key; tried in order, failures recorded as tool experience) ----
const fresh={tavily:{day:'day',week:'week',month:'month',year:'year'},bocha:{day:'oneDay',week:'oneWeek',month:'oneMonth',year:'oneYear'},brave:{day:'pd',week:'pw',month:'pm',year:'py'},searxng:{day:'day',week:'week',month:'month',year:'year'}};
export const webProviders={
  bing:{label:'Bing 公共搜索',ready:c=>c.publicSearchEnabled===true,async search(f,c,{query,site,max}){return (await bingSearch(site?query+' site:'+site:query)).results.slice(0,max);}},
  bocha:{label:'博查',ready:c=>!!c.bochaKey,async search(f,c,{query,freshness,site,max}){
    const d=await getJson(f,'https://api.bochaai.com/v1/web-search',{method:'POST',headers:{Authorization:'Bearer '+c.bochaKey,'Content-Type':'application/json'},body:JSON.stringify({query:site?query+' site:'+site:query,freshness:fresh.bocha[freshness]||'noLimit',summary:true,count:max})});
    if(d.code&&Number(d.code)!==200)throw new Error('博查返回错误 '+d.code+(d.msg?'：'+d.msg:''));
    return list(d.data?.webPages?.value).map(x=>({title:x.name,url:x.url,snippet:x.summary||x.snippet,published:x.datePublished||null,site:x.siteName}));}},
  tavily:{label:'Tavily',ready:c=>!!c.tavilyKey,async search(f,c,{query,freshness,site,max}){
    const d=await getJson(f,'https://api.tavily.com/search',{method:'POST',headers:{Authorization:'Bearer '+c.tavilyKey,'Content-Type':'application/json'},body:JSON.stringify({query,max_results:max,search_depth:'basic',include_answer:false,...(fresh.tavily[freshness]?{time_range:fresh.tavily[freshness]}:{}),...(site?{include_domains:[site]}:{})})});
    return list(d.results).map(x=>({title:x.title,url:x.url,snippet:x.content,published:x.published_date||null}));}},
  brave:{label:'Brave',ready:c=>!!c.braveKey,async search(f,c,{query,freshness,site,max}){
    const d=await getJson(f,'https://api.search.brave.com/res/v1/web/search?'+new URLSearchParams({q:site?query+' site:'+site:query,count:String(max),...(fresh.brave[freshness]?{freshness:fresh.brave[freshness]}:{})}),{headers:{'X-Subscription-Token':c.braveKey}});
    return list(d.web?.results).map(x=>({title:stripTags(x.title),url:x.url,snippet:stripTags(x.description),published:x.age||null}));}},
  searxng:{label:'SearXNG',ready:c=>!!c.searxngUrl,async search(f,c,{query,freshness,site,max}){
    const d=await getJson(f,c.searxngUrl+'/search?'+new URLSearchParams({q:site?query+' site:'+site:query,format:'json',...(fresh.searxng[freshness]?{time_range:fresh.searxng[freshness]}:{})}));
    return list(d.results).slice(0,max).map(x=>({title:x.title,url:x.url,snippet:x.content,published:x.publishedDate||null}));}},
};

// ---- Scholarly sources (keyless). Normalised paper records share one shape. ----
export function invertedAbstract(index){if(!index||typeof index!=='object')return '';const words=[];for(const [w,pos]of Object.entries(index))for(const p of list(pos))if(Number.isInteger(p)&&p<20000)words[p]=w;return words.filter(Boolean).join(' ');}
const arxivId=v=>String(v||'').match(/(?:arxiv\.org\/(?:abs|pdf)\/|10\.48550\/arxiv\.|^)(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})/i)?.[1]||null;
export function fromOpenAlex(w){
  const doi=w.doi?String(w.doi).replace(/^https?:\/\/doi\.org\//i,''):null,landing=w.primary_location?.landing_page_url||null;
  const arxiv=arxivId(doi)||(landing&&/arxiv\.org/.test(landing)?arxivId(landing):null);
  return {title:stripTags(w.display_name||w.title),authors:list(w.authorships).map(a=>a.author?.display_name).filter(Boolean),year:w.publication_year||null,venue:w.primary_location?.source?.display_name||null,doi,arxiv,openalex:String(w.id||'').split('/').pop()||null,citations:w.cited_by_count??null,abstract:invertedAbstract(w.abstract_inverted_index),oaPdf:w.best_oa_location?.pdf_url||null,oaUrl:w.open_access?.oa_url||w.best_oa_location?.landing_page_url||null,isOa:!!w.open_access?.is_oa,url:doi?'https://doi.org/'+doi:arxiv?'https://arxiv.org/abs/'+arxiv:landing||w.id,type:w.type||null,references:w.referenced_works_count??null,source:'openalex'};
}
const OA_SELECT='id,doi,display_name,publication_year,authorships,primary_location,cited_by_count,abstract_inverted_index,open_access,best_oa_location,type,referenced_works_count';
export function parseArxiv(xml){
  if(/<!DOCTYPE|<!ENTITY/i.test(xml)||XMLValidator.validate(xml)!==true)throw new Error('arXiv 返回的 XML 无效。');
  const feed=new XMLParser({ignoreAttributes:false,attributeNamePrefix:'@',parseTagValue:false}).parse(xml).feed||{};
  return list(feed.entry).map(e=>{const title=stripTags(e.title?.['#text']??e.title);if(title==='Error')throw new Error('arXiv 查询参数无效（接口以 HTTP 200 返回错误条目）。');const id=arxivId(e.id);if(!id)return null;
    return {title,authors:list(e.author).map(a=>stripTags(a.name)).filter(Boolean),year:year(e.published),venue:'arXiv'+(e['arxiv:primary_category']?.['@term']?' '+e['arxiv:primary_category']['@term']:''),doi:e['arxiv:doi']?stripTags(e['arxiv:doi']['#text']??e['arxiv:doi']):null,arxiv:id,citations:null,abstract:stripTags(e.summary?.['#text']??e.summary),oaPdf:'https://arxiv.org/pdf/'+id,isOa:true,url:'https://arxiv.org/abs/'+id,type:'preprint',source:'arxiv',published:e.published||null};}).filter(Boolean);
}
export const scholarSources={
  async openalex(f,c,{query,fromYear,toYear,sort,openAccess,reviews,max}){
    const filter=[fromYear&&`from_publication_date:${fromYear}-01-01`,toYear&&`to_publication_date:${toYear}-12-31`,openAccess&&'is_oa:true',reviews&&'type:review'].filter(Boolean).join(',');
    const d=await getJson(f,'https://api.openalex.org/works?'+new URLSearchParams({search:query,per_page:String(max),select:OA_SELECT,...(filter?{filter}:{}),...(sort==='cited'?{sort:'cited_by_count:desc'}:sort==='recent'?{sort:'publication_date:desc'}:{})}));
    return list(d.results).map(fromOpenAlex);},
  async arxiv(f,c,{query,sort,max},state){
    const wait=3100-(Date.now()-(state.lastArxiv||0));if(wait>0)await sleep(wait);state.lastArxiv=Date.now();
    const words=query.replace(/["\\()]/g,' ').split(/\s+/).filter(Boolean).slice(0,10);if(!words.length)return [];
    const xml=await getText(f,'https://export.arxiv.org/api/query?'+new URLSearchParams({search_query:words.map(w=>'all:'+w).join(' AND '),start:'0',max_results:String(max),sortBy:sort==='recent'?'submittedDate':'relevance',sortOrder:'descending'}),{headers:{Accept:'application/atom+xml'},timeout:30000});
    return parseArxiv(xml);},
  async europepmc(f,c,{query,fromYear,toYear,sort,openAccess,reviews,max}){
    let q='('+query+')';if(fromYear||toYear)q+=` AND (PUB_YEAR:[${fromYear||1900} TO ${toYear||2100}])`;if(openAccess)q+=' AND OPEN_ACCESS:y';if(reviews)q+=' AND PUB_TYPE:"review"';
    const d=await getJson(f,'https://www.ebi.ac.uk/europepmc/webservices/rest/search?'+new URLSearchParams({query:q,format:'json',pageSize:String(max),resultType:'core',...(sort==='cited'?{sort:'CITED desc'}:sort==='recent'?{sort:'P_PDATE_D desc'}:{})}));
    if(d.errCode)throw new Error('Europe PMC 返回错误 '+d.errCode+'（HTTP 200 内的错误）。');
    return list(d.resultList?.result).map(x=>{const pdf=list(x.fullTextUrlList?.fullTextUrl).find(u=>u.documentStyle==='pdf'&&u.availabilityCode==='OA');return {title:stripTags(x.title),authors:String(x.authorString||'').split(/,\s*/).filter(Boolean),year:year(x.pubYear),venue:x.journalInfo?.journal?.title||x.bookOrReportDetails?.publisher||null,doi:x.doi||null,pmid:x.pmid||null,pmcid:x.pmcid||null,citations:x.citedByCount??null,abstract:stripTags(x.abstractText),isOa:x.isOpenAccess==='Y',oaPdf:pdf?.url||null,url:x.doi?'https://doi.org/'+x.doi:`https://europepmc.org/article/${x.source}/${x.id}`,type:list(x.pubTypeList?.pubType).join(', ')||null,source:'europepmc'};});},
  async crossref(f,c,{query,fromYear,toYear,sort,max}){
    const filter=[fromYear&&'from-pub-date:'+fromYear,toYear&&'until-pub-date:'+toYear].filter(Boolean).join(',');
    const d=await getJson(f,'https://api.crossref.org/works?'+new URLSearchParams({'query.bibliographic':query,rows:String(max),select:'DOI,title,author,issued,container-title,is-referenced-by-count,abstract,URL,type',...(filter?{filter}:{}),...(sort==='cited'?{sort:'is-referenced-by-count',order:'desc'}:sort==='recent'?{sort:'published',order:'desc'}:{})}));
    return list(d.message?.items).map(x=>({title:stripTags(list(x.title)[0]),authors:list(x.author).map(a=>[a.given,a.family].filter(Boolean).join(' ')||a.name).filter(Boolean),year:x.issued?.['date-parts']?.[0]?.[0]||null,venue:list(x['container-title'])[0]||null,doi:x.DOI,citations:x['is-referenced-by-count']??null,abstract:stripTags(x.abstract),url:'https://doi.org/'+x.DOI,type:x.type||null,source:'crossref'}));},
  async semanticscholar(f,c,{query,fromYear,toYear,max}){
    const d=await getJson(f,'https://api.semanticscholar.org/graph/v1/paper/search?'+new URLSearchParams({query,limit:String(max),fields:'title,year,authors,venue,citationCount,abstract,externalIds,openAccessPdf,url,tldr',...(fromYear||toYear?{year:`${fromYear||''}-${toYear||''}`}:{})}),{headers:c.s2Key?{'x-api-key':c.s2Key}:{}});
    return list(d.data).map(x=>{const doi=x.externalIds?.DOI||null,arxiv=x.externalIds?.ArXiv||null;return {title:x.title,authors:list(x.authors).map(a=>a.name),year:x.year||null,venue:x.venue||null,doi,arxiv,citations:x.citationCount??null,abstract:x.abstract||x.tldr?.text||'',oaPdf:x.openAccessPdf?.url||null,url:doi?'https://doi.org/'+doi:arxiv?'https://arxiv.org/abs/'+arxiv:x.url,source:'semanticscholar'};});},
};

export async function pdfText(bytes,{maxPages=40}={}){
  const {DOMMatrix,ImageData,Path2D}=await import('@napi-rs/canvas');globalThis.DOMMatrix??=DOMMatrix;globalThis.ImageData??=ImageData;globalThis.Path2D??=Path2D;
  const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs'),task=pdfjs.getDocument({data:new Uint8Array(bytes),isEvalSupported:false,useSystemFonts:true,verbosity:0}),doc=await task.promise;
  try{const pages=[],n=Math.min(doc.numPages,maxPages);for(let i=1;i<=n;i++){const c=await(await doc.getPage(i)).getTextContent();pages.push(c.items.map(x=>(x.str||'')+(x.hasEOL?'\n':' ')).join(''));}
    return {text:pages.join('\n').replace(/(\w)-\n(\w)/g,'$1$2').replace(/[ \t]+/g,' ').replace(/\n\s*\n+/g,'\n').trim(),pages:doc.numPages,readPages:n};}
  finally{await task.destroy();}
}

const paperView=(p,ref,abstract=500)=>({ref,title:p.title,authors:p.authors?.length>4?[...p.authors.slice(0,4),'et al.']:p.authors,year:p.year,venue:p.venue,doi:p.doi||undefined,arxiv:p.arxiv||undefined,citations:p.citations??undefined,type:p.type||undefined,openAccess:p.isOa||!!p.oaPdf||undefined,abstract:clip(p.abstract,abstract)||'（无摘要）'});
const SE_SITES=['stackoverflow','superuser','serverfault','askubuntu','math','stats','physics','tex','unix','softwareengineering','ai','datascience','cs','chemistry','biology','electronics','robotics'];
const tool=(name,description,properties,required=[])=>({type:'function',function:{name,description,parameters:{type:'object',properties,required}}});

export class ResearchToolkit{
  constructor({config=()=>({}),fetcher=fetch,reader,repositories,models,memory,skills,db,fetchBytes=publicBytes,clock=()=>Date.now()}={}){
    Object.assign(this,{config,fetcher,reader,repositories,models,memory,skills,db,fetchBytes,clock});this.state={};
    db?.exec('CREATE TABLE IF NOT EXISTS tool_cache(key TEXT PRIMARY KEY,body TEXT NOT NULL,expires INTEGER NOT NULL)');
  }
  webProviders(){const c=this.config();return Object.entries(webProviders).filter(([,p])=>p.ready(c)).map(([id])=>id);}
  status(){const c=this.config(),web=this.webProviders();return {webSearch:web.length?web:(c.openaiEnabled&&c.openaiKey&&c.webResearchEnabled!==false?['openai-advisor']:[]),scholarly:Object.keys(scholarSources),reference:['wikipedia','github','stackexchange','hackernews'],community:this.reader?['bilibili','zhihu','niconico']:[],skills:this.skills?.catalog().map(s=>s.name)||[]};}
  cached(key){if(!this.db)return null;const row=this.db.prepare('SELECT body FROM tool_cache WHERE key=? AND expires>?').get(key,this.clock());return row?JSON.parse(row.body):null;}
  store(key,value,ttlMs){if(!this.db)return;this.db.prepare('INSERT OR REPLACE INTO tool_cache VALUES(?,?,?)').run(key,JSON.stringify(value),this.clock()+ttlMs);this.db.exec('DELETE FROM tool_cache WHERE key NOT IN (SELECT key FROM tool_cache ORDER BY expires DESC LIMIT 300)');}
  async remember(key,ttlMs,fn){const k=hash(key),hit=this.cached(k);if(hit)return {...hit,cached:true};const value=await fn();this.store(k,value,ttlMs);return value;}
  record(capability,implementation,scope,started,error){this.memory?.record({capability,implementation,scope,ok:!error,error:error?.message||'',latency:Date.now()-started});}
  order(capability,scope,ids){return this.memory?this.memory.order(capability,scope,ids):ids;}

  definitions(){
    const max={type:'integer',description:'返回条数，默认 6，最多 10'};
    const web=this.status().webSearch.length>0;
    return [
      tool('load_skill','读取一项技能的完整做法。遇到与技能描述相符的任务时先读取，再按做法使用其他工具。',{name:{type:'string',description:'技能名称'}},['name']),
      web&&tool('web_search','通用网页搜索，返回标题、网址、摘要（S 编号）。适合新闻、官方公告、产品/政策/事件等当前信息。摘要不是原文，关键结论需 read_page 核对。',{query:{type:'string',description:'检索词：公开主题，具体，含关键实体；不要包含用户隐私'},freshness:{type:'string',enum:['any','day','week','month','year'],description:'时效限制'},site:{type:'string',description:'可选，限定域名，如 gov.cn、who.int'},max},['query']),
      tool('wiki_search','维基百科检索，适合概念定义、人物、历史、作品等百科事实。返回 S 编号与摘要。',{query:{type:'string'},lang:{type:'string',enum:['zh','en','ja'],description:'英文条目通常更全'},max},['query']),
      tool('scholar_search','学术文献检索，返回 P 编号论文（题目、作者、年份、期刊、引用数、摘要）。多词术语可加英文双引号做短语检索，如 "retrieval augmented generation"。sort=cited/recent 会在最相关的候选中再按引用数/年份排序。openalex 覆盖最广；arxiv 适合计算机/物理/数学预印本；europepmc 适合生物医学；crossref 适合按题目找 DOI；semanticscholar 可能限流。',{query:{type:'string',description:'英文学术术语效果最好，可用 2—6 个核心词'},source:{type:'string',enum:['auto','openalex','arxiv','europepmc','crossref','semanticscholar']},from_year:{type:'integer'},to_year:{type:'integer'},sort:{type:'string',enum:['relevance','cited','recent']},open_access_only:{type:'boolean'},reviews_only:{type:'boolean',description:'只找综述（openalex/europepmc）'},max},['query']),
      tool('paper_details','读取一篇论文的完整摘要、主题、开放获取地址与参考文献数量。',{ref:{type:'string',description:'P 编号，或 DOI，或 arXiv 编号'}},['ref']),
      tool('citations','沿引用网络扩展：references=它引用的文献，cited_by=引用它的后续工作。用于找奠基论文或最新进展。',{ref:{type:'string',description:'P 编号或 DOI'},direction:{type:'string',enum:['references','cited_by']},sort:{type:'string',enum:['cited','recent']},max},['ref','direction']),
      tool('read_paper','读取论文开放获取全文（PDF/PMC/arXiv），按 focus 返回最相关段落；没有全文时返回摘要并说明。',{ref:{type:'string',description:'P 编号'},focus:{type:'string',description:'想在全文中找的内容，如 方法、数据集、实验结果、局限'}},['ref']),
      tool('read_page','读取网页正文，按 focus 返回最相关段落。只能读取用户消息里的网址或本次结果中的编号/网址。',{target:{type:'string',description:'S 编号或网址'},focus:{type:'string',description:'要在页面里找的具体问题'}},['target']),
      tool('code_search','GitHub 仓库检索（名称、简介、星标、更新时间、许可）。',{query:{type:'string'},sort:{type:'string',enum:['best','stars','updated']},max},['query']),
      tool('repository','读取 GitHub 仓库元数据和固定提交的 README（不运行代码）。',{target:{type:'string',description:'S 编号或 https://github.com/owner/repo'}},['target']),
      tool('qa_search','Stack Exchange 问答检索（编程、数学、统计等），返回问题、得分、是否已解决。',{query:{type:'string'},site:{type:'string',enum:SE_SITES},max},['query']),
      tool('community_search','社区内容检索：bilibili、zhihu、niconico（视频/回答简介）或 hackernews（技术讨论）。',{platform:{type:'string',enum:['bilibili','zhihu','niconico','hackernews']},query:{type:'string'}},['platform','query']),
    ].filter(Boolean);
  }

  async execute(name,args,ctx){
    const {ledger}=ctx,started=Date.now(),n=Math.max(3,Math.min(10,Number.isInteger(args.max)?args.max:6)),query=clip(args.query,200);
    const needQuery=()=>{if(!query)throw new Error('缺少检索词。');};
    switch(name){
      case 'load_skill':{const s=this.skills.get(args.name);ctx.skills?.add(s.name);return {skill:s.name,instructions:s.body};}
      case 'web_search':{needQuery();const c=this.config(),freshness=['day','week','month','year'].includes(args.freshness)?args.freshness:'any',site=args.site?String(args.site).replace(/^https?:\/\//,'').replace(/\/.*$/,'').slice(0,80):'',scope=CJK.test(query)?'zh':'en';
        let ids=this.webProviders();if(scope==='zh')ids.sort((a,b)=>(b==='bocha')-(a==='bocha'));ids=this.order('web-search',scope,ids);
        if(!ids.length){
          if(c.openaiEnabled&&c.openaiKey&&c.webResearchEnabled!==false&&this.models?.research){const r=await this.models.research(query+(site?' site:'+site:''));const results=r.sources.map(s=>({ref:ledger.add({title:s.title,url:s.url,provider:'openai-advisor',tool:'web_search',text:r.text},'S'),title:s.title,url:s.url}));return {provider:'openai-advisor',note:clip(r.text,1500),results};}
          throw new Error('通用网页搜索尚未配置（在「资料与目标 → 检索与科研」填写 Tavily 或博查 Key）。可以改用 wiki_search、scholar_search、qa_search、community_search。');}
        let lastError;for(const id of ids){const t=Date.now();try{
          const rows=await this.remember(['web',id,query,freshness,site,n].join('|'),freshness==='day'?20*60000:freshness==='any'?6*3600000:3600000,async()=>({rows:(await webProviders[id].search(this.fetcher,c,{query,freshness,site,max:n})).filter(r=>safeUrl(r.url)).slice(0,n)}));
          this.record('web-search',id,scope,t);if(!rows.rows.length){lastError=new Error(webProviders[id].label+' 没有结果');continue;}
          return {provider:webProviders[id].label,cached:rows.cached||undefined,results:rows.rows.map(r=>({ref:ledger.add({...r,url:safeUrl(r.url),provider:id,tool:'web_search',text:r.snippet},'S'),title:clip(r.title,150),site:r.site||new URL(safeUrl(r.url)).hostname,published:r.published||undefined,snippet:clip(stripTags(r.snippet),320)}))};
        }catch(e){this.record('web-search',id,scope,t,e);lastError=e;}}
        throw lastError||new Error('网页搜索没有结果。');}
      case 'wiki_search':{needQuery();const lang=['zh','en','ja'].includes(args.lang)?args.lang:CJK.test(query)?'zh':'en',base=`https://${lang}.wikipedia.org`,headers=lang==='zh'?{'Accept-Language':'zh-CN'}:{};
        const data=await this.remember(['wiki',lang,query,n].join('|'),24*3600000,async()=>{const d=await getJson(this.fetcher,base+'/w/rest.php/v1/search/page?'+new URLSearchParams({q:query,limit:String(Math.min(n,6))}),{headers});
          const pages=list(d.pages).slice(0,6);const summaries=await Promise.all(pages.slice(0,2).map(p=>getJson(this.fetcher,base+'/api/rest_v1/page/summary/'+encodeURIComponent(p.key),{headers}).then(s=>s.extract||'',()=>'')));
          return {pages:pages.map((p,i)=>({title:p.title,url:base+(lang==='zh'?'/zh-cn/':'/wiki/')+encodeURIComponent(p.key),snippet:stripTags(p.excerpt)+(p.description?'（'+p.description+'）':''),summary:summaries[i]||''}))};});
        this.record('wiki-search','wikipedia-'+lang,lang,started);
        return {results:data.pages.map(p=>({ref:ledger.add({title:p.title,url:p.url,provider:'wikipedia',tool:'wiki_search',text:p.summary||p.snippet},'S'),title:p.title,snippet:clip(p.summary||p.snippet,p.summary?900:300)}))};}
      case 'scholar_search':{needQuery();const opts={query,fromYear:Number.isInteger(args.from_year)?args.from_year:null,toYear:Number.isInteger(args.to_year)?args.to_year:null,sort:['cited','recent'].includes(args.sort)?args.sort:'relevance',openAccess:args.open_access_only===true,reviews:args.reviews_only===true,max:n};
        const chosen=scholarSources[args.source]?args.source:'auto',ids=chosen==='auto'?this.order('scholar-search','auto',['openalex','crossref']):[chosen];let lastError;
        const rerank=opts.sort!=='relevance'&&!(chosen==='arxiv'),pool=rerank?{...opts,sort:'relevance',max:Math.max(20,n*3)}:opts;
        for(const id of ids){const t=Date.now();try{
          const data=await this.remember(['scholar',id,JSON.stringify(pool)].join('|'),24*3600000,async()=>({papers:await scholarSources[id](this.fetcher,this.config(),pool,this.state)}));
          if(rerank)data.papers=data.papers.slice(0,Math.max(12,n*2)).sort((a,b)=>opts.sort==='cited'?(b.citations??-1)-(a.citations??-1):(b.year??0)-(a.year??0)).slice(0,n);
          this.record('scholar-search',id,chosen,t);if(!data.papers.length){lastError=new Error(id+' 没有结果，可放宽检索词或换数据库。');continue;}
          return {source:id,cached:data.cached||undefined,papers:data.papers.map(p=>paperView(p,ledger.add({...p,provider:id,tool:'scholar_search',text:p.abstract},'P')))};
        }catch(e){this.record('scholar-search',id,chosen,t,e);lastError=e;}}
        throw lastError;}
      case 'paper_details':{const p=await this.paper(args.ref,ledger);return {...paperView(p.item,p.ref,4000),topics:p.item.topics,referencesCount:p.item.references??undefined,openAccessUrl:p.item.oaPdf||p.item.oaUrl||undefined};}
      case 'citations':{const p=await this.paper(args.ref,ledger);if(!p.item.openalex)throw new Error('这篇论文没有 OpenAlex 编号，无法展开引用网络。');const direction=args.direction==='cited_by'?'cited_by':'references';
        const d=await this.remember(['cites',p.item.openalex,direction,args.sort,n].join('|'),24*3600000,async()=>{const r=await getJson(this.fetcher,'https://api.openalex.org/works?'+new URLSearchParams({filter:(direction==='cited_by'?'cites:':'cited_by:')+p.item.openalex,per_page:String(n),select:OA_SELECT,sort:args.sort==='recent'?'publication_date:desc':'cited_by_count:desc'}));return {papers:list(r.results).map(fromOpenAlex)};});
        this.record('citations','openalex',direction,started);return {of:p.ref,direction,papers:d.papers.map(x=>paperView(x,ledger.add({...x,provider:'openalex',tool:'citations',text:x.abstract},'P'),300))};}
      case 'read_paper':{const p=await this.paper(args.ref,ledger,{lookup:false});ctx.fullTexts??=new Map();const reused=ctx.fullTexts.has(p.ref),doc=reused?ctx.fullTexts.get(p.ref):await this.fullText(p.item,ledger);ctx.fullTexts.set(p.ref,doc);ledger.addText(p.ref,doc.text);const item=ledger.get(p.ref);item.readLevel=doc.readLevel;this.record('read-paper',doc.via,doc.readLevel,started);
        return {ref:p.ref,title:p.item.title,readLevel:doc.readLevel,via:doc.via,pages:doc.pages,length:doc.text.length,passages:passages(doc.text,args.focus,{limit:doc.readLevel==='abstract'?2:5}),limitation:doc.limitation,note:doc.readLevel==='abstract'?'已确认这篇没有可取得的开放全文，不要再次 read_paper 它；需要细节请找其他论文或网页。':reused?'复用本次已读取的全文。':undefined};}
      case 'read_page':{if(!this.reader)throw new Error('网页阅读工具尚未接入。');const {url,item}=ctx.ledger.resolve(args.target),t=Date.now();let doc;
        try{doc=await this.reader.document(url);this.record('read-page','reader',new URL(url).hostname,t);}catch(e){this.record('read-page','reader',new URL(url).hostname,t,e);throw e;}
        const ref=item?.ref||ledger.add({title:doc.title,url,provider:'user-link',tool:'read_page'},'S');ledger.addText(ref,doc.text);const it=ledger.get(ref);it.readLevel=doc.readLevel;if(!it.title)it.title=doc.title;
        return {ref,title:clip(doc.title,150),url,readLevel:doc.readLevel,length:doc.text.length,cached:doc.cached||undefined,passages:passages(doc.text,args.focus,{limit:4}),comments:doc.comments?clip(JSON.stringify(doc.comments),600):undefined,limitations:doc.limitations};}
      case 'code_search':{needQuery();const sort=['stars','updated'].includes(args.sort)?args.sort:'best';
        const d=await this.remember(['gh',query,sort,n].join('|'),6*3600000,async()=>{const r=await getJson(this.fetcher,'https://api.github.com/search/repositories?'+new URLSearchParams({q:query,per_page:String(n),...(sort==='best'?{}:{sort,order:'desc'})}),{headers:{Accept:'application/vnd.github+json'}});return {items:list(r.items).map(x=>({title:x.full_name,url:x.html_url,snippet:x.description||'',stars:x.stargazers_count,updated:x.pushed_at,license:x.license?.spdx_id||null,language:x.language||null}))};});
        this.record('code-search','github','repositories',started);return {results:d.items.map(x=>({ref:ledger.add({...x,provider:'github',tool:'code_search',text:x.snippet},'S'),title:x.title,stars:x.stars,updated:x.updated,license:x.license,language:x.language,snippet:clip(x.snippet,240)}))};}
      case 'repository':{if(!this.repositories)throw new Error('仓库读取工具尚未接入。');const {url,item}=ledger.resolve(args.target),r=await this.repositories.get(url),ref=item?.ref||ledger.add({title:r.repo,url:r.url,provider:'github',tool:'repository'},'S');ledger.addText(ref,r.readme);
        return {ref,repo:r.repo,sha:r.sha,license:r.license,stars:r.stars,updatedAt:r.updatedAt,description:r.description,readme:passages(r.readme,args.focus||'install usage features',{limit:4}),limitations:r.limitations};}
      case 'qa_search':{needQuery();const site=SE_SITES.includes(args.site)?args.site:'stackoverflow';
        const d=await this.remember(['se',site,query,n].join('|'),6*3600000,async()=>{const r=await getJson(this.fetcher,'https://api.stackexchange.com/2.3/search/advanced?'+new URLSearchParams({order:'desc',sort:'relevance',q:query,site,pagesize:String(n)}));return {items:list(r.items).map(x=>({title:stripTags(x.title),url:x.link,snippet:`得分 ${x.score} · ${x.answer_count} 个回答${x.is_answered?' · 已有采纳/有效回答':''} · ${list(x.tags).join(', ')}`,published:x.creation_date?new Date(x.creation_date*1000).toISOString().slice(0,10):null}))};});
        this.record('qa-search','stackexchange',site,started);return {site,results:d.items.map(x=>({ref:ledger.add({...x,provider:'stackexchange',tool:'qa_search',text:x.title},'S'),title:x.title,snippet:x.snippet,published:x.published}))};}
      case 'community_search':{needQuery();const platform=args.platform;let rows;
        if(platform==='hackernews'){const r=await getJson(this.fetcher,'https://hn.algolia.com/api/v1/search?'+new URLSearchParams({query,hitsPerPage:'8'}));rows=list(r.hits).map(x=>({title:x.title||x.story_title,url:x.url||'https://news.ycombinator.com/item?id='+x.objectID,discussion:'https://news.ycombinator.com/item?id='+x.objectID,snippet:`${x.points??0} points · ${x.num_comments??0} comments`,published:String(x.created_at||'').slice(0,10)})).filter(x=>x.title&&safeUrl(x.url));}
        else{const kinds={bilibili:['bilibili-search','https://www.bilibili.com/'],zhihu:['zhihu-search','https://www.zhihu.com/'],niconico:['niconico-search','https://www.nicovideo.jp/']};if(!kinds[platform]||!this.reader)throw new Error('不支持的平台。');
          rows=list(await this.reader.discover({kind:kinds[platform][0],url:kinds[platform][1],query})).map(x=>({title:x.title,url:x.url,snippet:x.text||x.description||'',published:x.published||null}));}
        this.record('community-search',platform,platform,started);return {platform,results:rows.slice(0,8).map(x=>({ref:ledger.add({...x,provider:platform,tool:'community_search',text:x.snippet},'S'),title:clip(x.title,150),snippet:clip(x.snippet,280),published:x.published||undefined}))};}
      default:throw new Error('未知工具：'+name);
    }
  }

  // Resolve a P ref / DOI / arXiv id to a paper; fills details from OpenAlex when needed.
  async paper(target,ledger,{lookup=true}={}){
    const t=String(target||'').trim();let item=/^P\d+$/i.test(t)?ledger.get(t):null;if(/^[SP]\d+$/i.test(t)&&!item)throw new Error('编号 '+t+' 不存在。');
    const doi=item?.doi||t.match(/10\.\d{4,9}\/[^\s"<>]+/)?.[0],arxiv=item?.arxiv||(!doi?arxivId(t):null);
    if(!item&&!doi&&!arxiv)throw new Error('请提供 P 编号、DOI 或 arXiv 编号。');
    if(lookup||!item){const path=item?.openalex?item.openalex:doi?'doi:'+doi:'doi:10.48550/arXiv.'+arxiv.replace(/v\d+$/,'');
      try{const w=await this.remember('oa-work|'+path,24*3600000,()=>getJson(this.fetcher,'https://api.openalex.org/works/'+path.split('/').map(encodeURIComponent).join('/').replace(/%3A/gi,':')+'?select='+OA_SELECT+',topics'));const p={...fromOpenAlex(w),topics:list(w.topics).slice(0,5).map(x=>x.display_name)};
        if(item){for(const [k,v]of Object.entries(p))if(v!=null&&v!==''&&(item[k]==null||item[k]===''||k==='abstract'&&String(v).length>String(item[k]).length))item[k]=v;if(p.abstract)ledger.addText(item.ref,p.abstract);return {ref:item.ref,item};}
        const ref=ledger.add({...p,provider:'openalex',tool:'paper_details',text:p.abstract},'P');return {ref,item:ledger.get(ref)};
      }catch(e){if(!item)throw new Error('没有找到这篇论文的元数据：'+e.message);}}
    return {ref:item.ref,item};
  }
  // Paywalled CS/physics papers often have an arXiv version with the same title.
  async arxivByTitle(title){
    // Phrase queries break on typographic dashes, so AND the distinctive ASCII title words and compare titles afterwards.
    const clean=String(title).normalize('NFKD').replace(/\s+/g,' ').trim(),words=[...new Set(clean.split(/[^A-Za-z0-9]+/).filter(w=>w.length>=3&&!STOP.has(w.toLowerCase())))];
    if(words.length<3)return null;
    const hit=await this.remember('arxiv-title|'+clean.toLowerCase(),7*86400000,async()=>{const wait=3100-(Date.now()-(this.state.lastArxiv||0));if(wait>0)await sleep(wait);this.state.lastArxiv=Date.now();
      const rows=parseArxiv(await getText(this.fetcher,'https://export.arxiv.org/api/query?'+new URLSearchParams({search_query:words.slice(0,8).map(w=>'ti:'+w).join(' AND '),max_results:'5'}),{headers:{Accept:'application/atom+xml'},timeout:30000}));
      const key=t=>String(t).normalize('NFKD').toLowerCase().replace(/[^a-z0-9]/g,''),bag=t=>new Set(String(t).toLowerCase().split(/[^a-z0-9]+/).filter(w=>w.length>=3)),want=bag(clean);
      const similar=r=>{const got=bag(r.title);let both=0;for(const w of want)if(got.has(w))both++;return both/(want.size+got.size-both)>=0.85;};
      return {id:(rows.find(r=>key(r.title)===key(clean))||rows.find(similar))?.arxiv||null};});
    return hit.id;
  }
  async fullText(p,ledger){
    const tried=[];const ok=(text,via,readLevel,extra={})=>({text,via,readLevel,...extra});
    if(p.pmcid){try{const xml=await this.remember('pmc|'+p.pmcid,7*86400000,async()=>({xml:await getText(this.fetcher,`https://www.ebi.ac.uk/europepmc/webservices/rest/${p.pmcid}/fullTextXML`)}));const body=xml.xml.match(/<body[\s\S]*<\/body>/)?.[0];
      if(body&&body.length>2000)return ok(stripTags(body.replace(/<\/(p|title|sec)>/g,'。\n')).slice(0,250000),'europepmc-'+p.pmcid,'full-text');tried.push('PMC 没有可再分发的正文');}catch(e){tried.push('PMC：'+e.message);}}
    if(!p.arxiv&&!p.oaPdf&&p.title){try{const id=await this.arxivByTitle(p.title);if(id){p.arxiv=id;tried.push('找到 arXiv 版本 '+id);}}catch(e){tried.push('arXiv 标题查找：'+e.message);}}
    for(const url of [...new Set([p.arxiv&&'https://arxiv.org/pdf/'+p.arxiv,p.oaPdf].filter(Boolean))]){ledger.allow(url);
      try{const doc=await this.remember('pdf|'+url,7*86400000,async()=>{const file=await this.fetchBytes(url);if(file.mime!=='application/pdf')throw new Error('不是 PDF');const t=await pdfText(file.bytes);if(t.text.length<1500)throw new Error('PDF 可提取文字太少（可能是扫描件）');return {text:t.text.slice(0,250000),pages:t.pages};});
        return ok(doc.text,url,'full-text',{pages:doc.pages});}catch(e){tried.push(new URL(url).hostname+'：'+e.message);}}
    if(p.oaUrl&&this.reader&&safeUrl(p.oaUrl)){try{const doc=await this.reader.document(safeUrl(p.oaUrl));if(doc.text.length>1500)return ok(doc.text,doc.url||p.oaUrl,doc.readLevel||'page-text');}catch(e){tried.push('落地页：'+e.message);}}
    if(p.abstract)return ok(p.abstract,'abstract','abstract',{limitation:'没有取得开放全文，只有摘要。'+(tried.length?'尝试：'+tried.join('；'):'该论文可能不是开放获取。')});
    throw new Error('没有可读取的全文或摘要。'+tried.join('；'));
  }
}
