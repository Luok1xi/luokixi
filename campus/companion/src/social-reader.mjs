import {PublicReader,publicText,parsePage} from './public-reader.mjs';
import {webUrl} from './web-life-state.mjs';
const clean=s=>String(s??'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
const limited=rows=>rows.slice(0,20).map((x,i)=>({id:'comment-'+i,text:clean(x).slice(0,400)})).filter(x=>x.text);
// Protocol adapters informed by the maintained upstream extractors listed in WEB-LIFE.md.
// Only read endpoints; no account cookies, posting, arbitrary URLs or shell execution.
export class SocialReader{
  constructor({read=publicText,reader}={}){this.read=read;this.reader=reader||new PublicReader({read});}
  async json(url,options){const r=await this.read(url,options);if(r.status!==200)throw new Error('公开接口返回 HTTP '+r.status+'；没有取得该内容。');let data;try{data=JSON.parse(r.text);}catch{throw new Error('接口没有返回有效资料，可能需要登录或验证码。');}return data;}
  async biliApi(path){const x=await this.json('https://api.bilibili.com'+path,{headers:{Referer:'https://www.bilibili.com/'}});if(x.code!==0)throw new Error('B 站未开放本次读取（代码 '+x.code+'），没有绕过登录或访问限制。');return x.data;}
  async discover(source){if(source.kind==='bilibili-search'){const d=await this.biliApi('/x/web-interface/search/type?search_type=video&keyword='+encodeURIComponent(source.query)+'&page=1');return (d.result||[]).slice(0,8).filter(x=>/^BV[\da-zA-Z]{10}$/.test(x.bvid)).map(x=>({title:clean(x.title),url:'https://www.bilibili.com/video/'+x.bvid,text:clean(x.description),readLevel:'video-description'}));}
    if(source.kind==='niconico-search'){const data=await this.json('https://snapshot.search.nicovideo.jp/api/v2/snapshot/video/contents/search?'+new URLSearchParams({q:source.query,targets:'tagsExact',fields:'contentId,title,description,startTime',_sort:'-startTime',_limit:'8',_context:'MikuCompanion'}));if(data.meta?.status!==200||!Array.isArray(data.data))throw new Error('niconico 公开搜索没有返回有效目录。');return data.data.filter(x=>/^(sm|so)\d+$/.test(x.contentId)).map(x=>({url:'https://www.nicovideo.jp/watch/'+x.contentId,title:clean(x.title),text:clean(x.description).slice(0,7000),published:x.startTime,readLevel:'video-description'}));}
    if(source.kind==='zhihu-search'){const d=await this.json('https://www.zhihu.com/api/v4/search_v3?'+new URLSearchParams({t:'general',q:source.query,offset:'0',limit:'10',correction:'1',search_source:'Filter'}));if(!Array.isArray(d.data))throw new Error('知乎公开搜索未返回内容，可能需要登录。');return d.data.map(x=>x.object).filter(x=>x&&['answer','article'].includes(x.type)).slice(0,8).flatMap(x=>{const id=String(x.id),question=String(x.question?.id||'');if(!/^\d+$/.test(id)||(x.type==='answer'&&!/^\d+$/.test(question)))return [];return [{title:clean(x.title||x.question?.title),text:clean(x.content||x.excerpt).slice(0,2000),url:x.type==='article'?'https://zhuanlan.zhihu.com/p/'+id:'https://www.zhihu.com/question/'+question+'/answer/'+id,readLevel:'search-excerpt'}];});}
    return this.reader.source(source);
  }
  async document(url){url=webUrl(url);const u=new URL(url);
    if(u.hostname.endsWith('bilibili.com'))return this.bilibili(url);
    if(u.hostname.endsWith('nicovideo.jp'))return this.niconico(url);
    const [doc]=await this.reader.source({url,kind:'page'});doc.comments=[];doc.limitations=[];
    if(u.hostname==='www.zhihu.com'||u.hostname==='zhuanlan.zhihu.com'){
      const answer=u.pathname.match(/\/answer\/(\d+)/),article=u.pathname.match(/^\/p\/(\d+)/),id=answer?.[1]||article?.[1];
      if(id)try{const data=await this.json(`https://www.zhihu.com/api/v4/comment_v5/${answer?'answers':'articles'}/${id}/root_comment?order=score&limit=20`);if(!Array.isArray(data.data))throw new Error('评论需要登录或接口已变化。');doc.comments=limited(data.data.map(x=>x.content));}catch(e){doc.limitations.push('未读到知乎评论：'+e.message);}
    }
    return doc;
  }
  async bilibili(url){const id=new URL(url).pathname.match(/^\/video\/(BV[\da-zA-Z]{10})\/?$/)?.[1];if(!id)throw new Error('请添加完整 BV 视频链接。');
    const d=await this.biliApi('/x/web-interface/view?bvid='+id),doc={url,title:clean(d.title),text:clean(d.desc),readLevel:'video-description',comments:[],limitations:['没有观看视频画面。B 站 AI 总结需登录授权，本版不冒充调用成功。']};
    try{const comments=await this.biliApi('/x/v2/reply?type=1&oid='+encodeURIComponent(d.aid)+'&pn=1&ps=20&sort=2');if(!Array.isArray(comments.replies)&&comments.replies!==null)throw new Error('评论结构不完整。');doc.comments=limited((comments.replies||[]).map(x=>x.content?.message));}catch(e){doc.limitations.push('未读到评论：'+e.message);}
    try{const player=await this.biliApi('/x/player/v2?bvid='+id+'&cid='+encodeURIComponent(d.cid));const subtitle=(player.subtitle?.subtitles||[]).find(x=>/^zh|^ai-zh/.test(x.lan))||player.subtitle?.subtitles?.[0];if(!subtitle)throw new Error('没有公开字幕，可能需要登录。');const u=new URL(subtitle.subtitle_url,'https://www.bilibili.com');if(u.protocol!=='https:'||!['hdslb.com','bilibili.com'].some(h=>u.hostname===h||u.hostname.endsWith('.'+h)))throw new Error('字幕地址不在预期域名中。');const data=await this.json(u.href);if(!Array.isArray(data.body))throw new Error('字幕格式不正确。');const text=data.body.map(x=>clean(x.content)).join('\n').slice(0,12000);if(!text.trim())throw new Error('字幕为空。');doc.text=text;doc.readLevel='video-subtitles';}catch(e){doc.limitations.push('未读到字幕：'+e.message);}
    return doc;
  }
  async niconico(url){const id=new URL(url).pathname.match(/^\/watch\/((?:sm|so)\d+)$/)?.[1];if(!id)throw new Error('当前支持 niconico 的 sm/so 单个视频链接。');
    const headers={'X-Frontend-ID':'6','X-Frontend-Version':'0'},d=await this.json('https://www.nicovideo.jp/api/watch/v3_guest/'+id+'?actionTrackId=AAAAAAAAAA_'+Date.now(),{headers});if(d.meta?.status!==200||!d.data?.video)throw new Error('niconico 未提供访客视频资料，可能需要登录或受地区限制。');
    const doc={url,title:clean(d.data.video.title),text:clean(d.data.video.description),readLevel:'video-description',comments:[],limitations:['仅取得视频介绍；弹幕属于观众反应，不能作为字幕或视频事实。没有观看画面。']},c=d.data.comment?.nvComment;
    try{if(!c?.server)throw new Error('没有可用的评论入口。');const server=new URL(c.server);if(server.protocol!=='https:'||server.hostname!=='public.nvcomment.nicovideo.jp'||server.port||server.username||server.password)throw new Error('评论服务地址不符合预期。');const res=await this.json(server.origin+'/v1/threads',{method:'POST',headers:{...headers,'Content-Type':'text/plain;charset=UTF-8',Origin:'https://www.nicovideo.jp',Referer:'https://www.nicovideo.jp/','X-Client-Os-Type':'others'},body:JSON.stringify({additionals:{},params:c.params,threadKey:c.threadKey})});if(res.meta?.status!==200||!Array.isArray(res.data?.threads))throw new Error('没有取得弹幕样本。');doc.comments=limited(res.data.threads.flatMap(t=>(t.comments||[]).map(x=>x.body)));}catch(e){doc.limitations.push('未读到弹幕：'+e.message);}return doc;
  }
}
