import {lookup} from 'node:dns/promises';
import {Agent,fetch as request} from 'undici';
import ipaddr from 'ipaddr.js';
import robotsParser from 'robots-parser';
import {XMLParser,XMLValidator} from 'fast-xml-parser';
import {parseHTML} from 'linkedom';
import {Readability} from '@mozilla/readability';
import {createHash} from 'node:crypto';
import {sourceUrl} from './research-state.mjs';

export const digest=text=>createHash('sha256').update(text).digest('hex');
export function publicAddress(address){try{return ipaddr.process(address).range()==='unicast';}catch{return false;}}
// Resolve once, validate every answer, then pin the connection to those addresses (also for IPv6).
export async function publicText(url,{lookupFn=lookup,fetcher=request,method='GET',headers={},body}={}){
  const u=new URL(sourceUrl(url)),addresses=await lookupFn(u.hostname,{all:true,verbatim:true});
  if(!addresses.length||addresses.some(x=>!publicAddress(x.address)))throw new Error('该网址解析到非公网地址，已停止读取。');
  const agent=new Agent({connect:{lookup:(host,opts,cb)=>{
    if(host!==u.hostname)return cb(new Error('目标域名发生变化。'));
    const rows=opts.family?addresses.filter(x=>x.family===opts.family):addresses;
    if(!rows.length)return cb(new Error('没有可用的公网地址。'));
    if(opts.all)cb(null,rows);else cb(null,rows[0].address,rows[0].family);
  }}});
  try{
    const res=await fetcher(u.href,{dispatcher:agent,redirect:'manual',signal:AbortSignal.timeout(20000),method,body,headers:{'User-Agent':'MikuResearch/1.0 (personal low-frequency research)','Accept':'text/html,application/atom+xml,application/rss+xml,application/xml,text/plain',...headers}});
    if(res.status>=300&&res.status<400){await res.body?.cancel();throw new Error('网址发生跳转，请直接添加最终公开网址。');}
    if(!res.ok){await res.body?.cancel();return {status:res.status,text:'',type:''};}
    const type=res.headers.get('content-type')||'';
    if(!/text\/|xml|json/.test(type)){await res.body?.cancel();throw new Error('当前只支持网页正文、RSS 和 Atom。');}
    const chunks=[];let bytes=0;for await(const chunk of res.body){bytes+=chunk.length;if(bytes>1500000)throw new Error('页面超过 1.5MB，本轮停止。');chunks.push(chunk);}
    return {status:res.status,type,text:Buffer.concat(chunks).toString('utf8')};
  }finally{await agent.close();}
}
const clean=value=>String(value??'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
export function parseFeed(xml,base){
  if(/<!DOCTYPE|<!ENTITY/i.test(xml)||XMLValidator.validate(xml)!==true)throw new Error('订阅 XML 无效或包含不允许的实体声明。');
  const parsed=new XMLParser({ignoreAttributes:false,attributeNamePrefix:'@',parseTagValue:false,processEntities:true}).parse(xml);
  const list=value=>value==null?[]:Array.isArray(value)?value:[value];
  const rows=parsed.feed?list(parsed.feed.entry):parsed['rdf:RDF']?list(parsed['rdf:RDF'].item):list(parsed.rss?.channel?.item);
  if(!parsed.feed&&!parsed.rss?.channel&&!parsed['rdf:RDF'])throw new Error('没有识别到 RSS 或 Atom 订阅。');
  return rows.slice(0,12).map(row=>{
    if(clean(row.title)==='Error')throw new Error('资料接口返回错误条目，没有论文结果。');
    const links=list(row.link),href=typeof row.link==='string'?row.link:links.find(x=>x['@rel']==='alternate')?.['@href']||links.find(x=>x['@href'])?.['@href']||row.id;
    let url;try{let u=new URL(href,base);if(u.hostname==='arxiv.org'&&u.protocol==='http:')u.protocol='https:';url=sourceUrl(u.href);}catch{return null;}
    const body=row.summary||row.description||row.content||row['content:encoded']||'';
    return {title:clean(row.title?.['#text']??row.title).slice(0,250),url,text:clean(body?.['#text']??body).slice(0,7000),published:clean(row.published||row.pubDate||row.updated||row['dc:date']),readLevel:'abstract-or-feed'};
  }).filter(x=>x&&x.title&&x.text.length>=30);
}
export function parsePage(html,url){
  const {document}=parseHTML(html);for(const e of document.querySelectorAll('script,style,iframe,form,nav,footer'))e.remove();
  const title=clean(document.title||new URL(url).hostname),fallback=clean(document.querySelector('main,article')?.textContent||document.body?.textContent);
  const article=new Readability(document.cloneNode(true)).parse();const body=clean(article?.textContent||fallback).slice(0,16000);
  if(body.length<100||/checking your browser|verify you are human|access denied|captcha/i.test(body.slice(0,400)))throw new Error('页面没有可用正文，或需要登录/验证码。');
  return {title:clean(article?.title||title),url,text:body,readLevel:'page-text'};
}
export class PublicReader{
  constructor({read=publicText}={}){this.read=read;this.lastArxiv=0;this.robotsCache=new Map();}
  async source(source){
    const base=new URL(sourceUrl(source.url));const robotsUrl=base.origin+'/robots.txt';let cached=this.robotsCache.get(robotsUrl);
    if(!cached||cached.until<Date.now()){const value=await this.read(robotsUrl);cached={value,until:Date.now()+([200,404,410].includes(value.status)?6*3600000:30000)};this.robotsCache.set(robotsUrl,cached);if(this.robotsCache.size>100)this.robotsCache.delete(this.robotsCache.keys().next().value);}
    const robots=cached.value;
    if(robots.status===200&&robotsParser(robotsUrl,robots.text).isAllowed(base.href,'MikuResearch')===false)throw new Error('网站 robots.txt 不允许抓取该页。');
    if(![200,404,410].includes(robots.status))throw new Error('暂时无法核对网站抓取规则，本轮跳过。');
    const res=await this.read(base.href);if(res.status!==200)throw new Error('信息源返回 HTTP '+res.status+'。');
    return source.kind==='feed'?parseFeed(res.text,base.href):[parsePage(res.text,base.href)];
  }
  async papers(keywords){
    if(Date.now()-this.lastArxiv<3100)throw new Error('论文接口有访问间隔，请稍后再试。');this.lastArxiv=Date.now();
    const terms=keywords.trim().split(/\s+/).filter(Boolean).slice(0,12);if(!terms.length)return [];
    const query=terms.map(t=>'all:"'+t.replace(/["\\]/g,'')+'"').join(' AND ');
    const u=new URL('https://export.arxiv.org/api/query');u.search=new URLSearchParams({search_query:query,start:'0',max_results:'8',sortBy:'submittedDate',sortOrder:'descending'}).toString();
    const res=await this.read(u.href);if(res.status!==200)throw new Error('论文接口返回 HTTP '+res.status+'，本轮不重试。');
    return parseFeed(res.text,u.href).filter(row=>new URL(row.url).hostname==='arxiv.org').map(row=>({...row,readLevel:'abstract',preprint:true}));
  }
}
