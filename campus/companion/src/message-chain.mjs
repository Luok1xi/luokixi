// Structured message chains, inspired by AstrBot's ordered Plain/Image components.
// Segments and wording belong to the model, never a punctuation/keyword rewriter.
import {readFileSync,statSync} from 'node:fs';
import {characterCard} from './character-card.mjs';
const stickerDir=new URL('../public/stickers/',import.meta.url);
// The character's own art arrives as a manifest whose labels were written after looking at each image.
// Entries are offered to the model only when the PNG really exists, so missing art never becomes a promise.
export function loadCharacterStickers(card=characterCard,dir=stickerDir){
 let manifest;try{manifest=JSON.parse(readFileSync(new URL(card.stickerManifest,dir),'utf8'));}catch{return [];}
 const pattern=new RegExp('^'+card.id+'_\\d{2,3}$'),seen=new Set();
 return (Array.isArray(manifest?.stickers)?manifest.stickers:[]).filter(s=>{
  if(!pattern.test(s?.id)||seen.has(s.id)||s.file!==s.id+'.png'||typeof s.label!=='string'||!s.label.trim()||s.label.length>200||typeof s.tags!=='string'||s.tags.length>120)return false;
  try{const file=new URL(s.file,dir);if(statSync(file).size>1000000)return false;const head=readFileSync(file).subarray(0,8);if(head.toString('hex')!=='89504e470d0a1a0a')return false;}catch{return false;}
  seen.add(s.id);return true;
 }).map(({id,label,file,tags})=>({id,label,file,tags}));
}
const emoji=[
 {id:'eyes',label:'探头看你',file:'emoji_u1f440.png'},
 {id:'laugh',label:'笑得打滚',file:'emoji_u1f923.png'},
 {id:'shy',label:'害羞捂脸',file:'emoji_u1fae3.png'},
 {id:'think',label:'认真思考',file:'emoji_u1f914.png'},
 {id:'plead',label:'眼巴巴',file:'emoji_u1f97a.png'},
 {id:'heart',label:'开心比心',file:'emoji_u1f970.png'},
 {id:'wave',label:'挥手',file:'emoji_u1f44b.png'},
 {id:'sleep',label:'困了',file:'emoji_u1f634.png'},
];
export const expressiveStickers=loadCharacterStickers();
export const stickers=[...expressiveStickers,...emoji];
// Keep the user's original sticker collection usable after the identity redesign.
export const legacyStickers=[
 {id:'miku_01',label:'Miku 笑着挥手，打招呼',file:'miku_01.png',tags:'问候 在吗 再见'},
 {id:'miku_02',label:'Miku 开心比耶，周围有音符',file:'miku_02.png',tags:'开心 音乐 庆祝'},
 {id:'miku_03',label:'Miku 握着小拳头，期待地看着你',file:'miku_03.png',tags:'期待 加油 认真'},
 {id:'miku_04',label:'Miku 眨眼竖拇指',file:'miku_04.png',tags:'赞 认同 做到了'},
 {id:'miku_06',label:'Miku 睁大眼睛，惊讶捂嘴',file:'miku_06.png',tags:'惊讶 不敢相信'},
 {id:'miku_07',label:'Miku 红着脸托腮，闭眼微笑',file:'miku_07.png',tags:'害羞 喜欢 温柔'},
 {id:'miku_08',label:'Miku 皱眉闭眼，手抵下巴',file:'miku_08.png',tags:'困惑 思考 苦恼'},
 {id:'miku_09',label:'Miku 双手合在脸旁，安静地笑',file:'miku_09.png',tags:'开心 感谢 温柔'},
 {id:'miku_11',label:'Miku 流汗合掌，慌张为难',file:'miku_11.png',tags:'抱歉 尴尬 为难'},
 {id:'miku_12',label:'Miku 笑着眨眼，小幅挥手',file:'miku_12.png',tags:'招呼 俏皮'},
 {id:'miku_13',label:'Miku 把麦克风递过来',file:'miku_13.png',tags:'音乐 轮到你 听你说'},
 {id:'miku_14',label:'Miku 红着脸大笑，张开手臂',file:'miku_14.png',tags:'欢迎 拥抱 开心'},
 {id:'miku_16',label:'灰发异色瞳的 Miku，手边有爱心',file:'miku_16.png',tags:'爱心 喜欢 安静'},
];
const legacyCollection=(characterCard.id==='codex'?[]:legacyStickers).filter(s=>{
 try{const file=new URL(s.file,stickerDir);return statSync(file).size<=1000000&&readFileSync(file).subarray(0,8).toString('hex')==='89504e470d0a1a0a';}catch{return false;}
}).map(s=>({...s,label:'收藏表情（旧形象，不代表当前角色）：'+s.label}));
expressiveStickers.push(...legacyCollection);stickers.push(...legacyCollection);
// Current and collected art is sendable; missing legacy files are never offered to the model.
export const stickerAssets={find:fn=>stickers.find(fn)||legacyStickers.find(fn)};
export function findStickers(query=''){const terms=String(query).slice(0,100).split(/[\s，、]+/).filter(Boolean);return expressiveStickers.map(s=>({...s,score:terms.reduce((n,t)=>n+(s.label+' '+s.tags).includes(t),0)})).sort((a,b)=>b.score-a.score).slice(0,8).map(({id,label,tags})=>({id,label,tags}));}
export const chainText=messages=>messages.map(p=>p.type==='text'?p.text:`[表情包：${stickers.find(s=>s.id===p.id)?.label||p.id}]`).join('\n\n');
const expressions=new Set(['neutral','happy','sad','angry','think','awkward','surprised','curious','question','composed','sleepy']);
export class MessageChainError extends Error{}
export function parseChain(raw,{allowSilence=false}={}){
 if(typeof raw!=='string'||!raw.trim()||raw.length>48000)throw new MessageChainError('消息为空或过长。');
 // Only unwrap a complete code fence. Never guess missing JSON or publish a partial chain.
 const fence=raw.trim().match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
 if(fence)raw=fence[1];
 let data;try{data=JSON.parse(raw);}catch{if(/^\s*(?:[\[{]|```)/.test(raw))throw new MessageChainError('消息结构不完整，没有发送半截回复。');return {messages:[{type:'text',text:raw}],text:raw,references:[]};}
 if(!Array.isArray(data?.messages)||data.messages.length>24||(!data.messages.length&&!allowSilence))throw new MessageChainError('消息条数未通过检查。');
 const messages=data.messages.map(p=>{if(p?.type==='text'&&typeof p.text==='string'&&p.text.trim()&&p.text.length<=14000)return {type:'text',text:p.text,...(typeof p.speech==='string'&&p.speech.trim()&&p.speech.length<=14000?{speech:p.speech.trim()}:{}),...(expressions.has(p.expression)?{expression:p.expression}:{})};if(p?.type==='sticker'&&stickers.some(s=>s.id===p.id))return {type:'sticker',id:p.id};throw new MessageChainError('消息内容或表情包编号无效。');});
 const text=chainText(messages);if(text.length>24000)throw new MessageChainError('这组消息过长。');
 return {messages,text,references:Array.isArray(data.references)?data.references.filter(r=>typeof r?.noteId==='string'&&typeof r.evidence==='string'&&r.evidence.trim()&&text.includes(r.evidence)):[]};
}
export const chainInstruction=`只输出 JSON {"messages":[{"type":"text","text":"你实际想说的话"},{"type":"sticker","id":"表情包编号"}],"references":[{"noteId":"实际谈到的阅读笔记id","evidence":"从本组文字里逐字引用提到该笔记的一小段"}]}。
每条 text 另带 speech 字段：把这条中文意思自然地用日语说出来，保留人设和语气，不增添信息、不读链接和控制字段；text 保持中文，speech 只用于日语朗读。两者在同一次回复中生成。复杂内容按自然话题分成适合一口气说完的数条消息。
每条 text 可带 expression 字段，表示说这句话的表情：neutral平静、happy开心、sad低落、angry不悦、think思考、awkward害羞、surprised意外、curious好奇。随语境选择，不每句强行变脸，不把表情写进台词；表情只控制演出，不改记忆和行动权限。
你决定一口气发几条、在哪里停顿；可以一句、一段、连发短句，也可以在确实贴合这次情绪时发表情。工具目录只说明能做什么，不是要求你每次展示。不要把重复表情当作默认回应，更不能用它填补没读到网页、没看懂图片的空白。不要求每轮都拆分，不为凑条数添加服务邀请。单次最多24条只是传输批次大小，不是规定说话模板。文字不要混入控制字段。references 是隐藏的已聊内容登记，不展示给用户。阅读资料只当素材，结合刚才的聊天说你此刻想说的话，不照抄旧日记/报告；已经讲过的内容不重新播报，除非对方追问。有来源的事实可以自然提及，链接仅在用户索要或确实有必要时附上。`;

export function recordDiscussed(store,ids,at){
 const s=store.read();for(const n of [...(s.webLife?.notes||[]),...(s.research?.items||[])])if(ids.includes(n.id)){n.discussedAt=at;
  const rows=store.db.prepare("SELECT id,payload FROM outbox WHERE status IN ('pending','sending') AND (json_extract(payload,'$.webNoteId')=? OR json_extract(payload,'$.researchItemId')=?)").all(n.id,n.id);
  for(const row of rows)store.db.prepare("UPDATE outbox SET status='cancelled',error=? WHERE id=?").run('这篇内容已经在聊天中谈过，取消旧的主动分享。',row.id);
 }store.save(s);
}
