import {readdirSync,readFileSync,statSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {terms} from './research-tools.mjs';

// Agent-Skills style procedures: the agent always sees name+description and loads a body on demand.
// Skills only describe how to use existing tools; they cannot add tools, URLs or permissions.
export const skillsDir=resolve(dirname(fileURLToPath(import.meta.url)),'../skills');
const NAME=/^[a-z0-9][a-z0-9-]{1,39}$/;
export function parseSkill(text,origin='skill'){
  const m=String(text).replace(/^﻿/,'').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if(!m)throw new Error(origin+' 缺少 --- 开头的技能说明。');
  const meta={};for(const line of m[1].split(/\r?\n/)){const x=line.match(/^([A-Za-z_-]+):\s*(.*)$/);if(x)meta[x[1].toLowerCase()]=x[2].trim().replace(/^["']|["']$/g,'');}
  if(!NAME.test(meta.name||''))throw new Error(origin+' 的 name 只能使用小写字母、数字和连字符。');
  if(!meta.description||meta.description.length>400)throw new Error(origin+' 需要 400 字以内的 description。');
  const body=m[2].trim();if(!body||body.length>16000)throw new Error(origin+' 正文为空或超过 16000 字。');
  return {name:meta.name,description:meta.description,tools:(meta.tools||'').split(/[,，\s]+/).filter(Boolean),keywords:(meta.keywords||'').split(/[,，]+/).map(x=>x.trim().toLowerCase()).filter(Boolean).slice(0,40),body};
}
export class Skills{
  constructor(dir=skillsDir){this.dir=dir;this.cache=null;this.errors=[];}
  load(){
    if(!existsSync(this.dir))return this.cache={stamp:0,items:new Map()};
    const folders=readdirSync(this.dir,{withFileTypes:true}).filter(d=>d.isDirectory()&&existsSync(resolve(this.dir,d.name,'SKILL.md')));
    const stamp=folders.map(d=>d.name+':'+statSync(resolve(this.dir,d.name,'SKILL.md')).mtimeMs).join('|');
    if(this.cache?.stamp===stamp)return this.cache;
    const items=new Map();this.errors=[];
    for(const d of folders){try{const s=parseSkill(readFileSync(resolve(this.dir,d.name,'SKILL.md'),'utf8'),d.name+'/SKILL.md');if(!items.has(s.name))items.set(s.name,s);}catch(e){this.errors.push(e.message);}}
    return this.cache={stamp,items};
  }
  list(){return [...this.load().items.values()];}
  catalog(){return this.list().map(({name,description,tools})=>({name,description,tools}));}
  get(name){const s=this.load().items.get(String(name));if(!s)throw new Error('没有名为 '+name+' 的技能。可用：'+this.list().map(x=>x.name).join('、'));return s;}
  // Cheap fallback selection when the router did not name a skill: trigger keywords weigh double,
  // plus distinct task terms found in the name/description.
  match(task,min=2){const text=String(task||'').toLowerCase(),q=new Set(terms(text));let best=null;
    for(const s of this.list()){const bag=new Set(terms(s.name.replace(/-/g,' ')+' '+s.description));let n=s.keywords.filter(w=>text.includes(w)).length*2;for(const t of q)if(bag.has(t))n++;if(n>=min&&(!best||n>best.n))best={name:s.name,n};}
    return best?.name||null;}
  prompt(){return this.list().map(s=>`- ${s.name}：${s.description}`).join('\n');}
}
