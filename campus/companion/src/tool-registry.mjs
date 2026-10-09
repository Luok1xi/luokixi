import {clip} from './research-tools.mjs';
// Tool registry: every tool has a group and a risk level. Groups are "on" (always offered), "search" (hidden
// until search_tools finds them, keeping the prompt small) or "off". The idea of grouped tools plus a
// search_tools meta-tool comes from Shinsekai; this is an independent implementation.
const RISK={read:0,write:1,publish:2},STATES=['on','search','off'];
const fn=(name,description,parameters,required=[])=>({type:'function',function:{name,description,parameters:{type:'object',properties:parameters,required}}});
export class ToolRegistry{
  constructor({states=()=>({})}={}){Object.assign(this,{states,tools:new Map(),mounts:new Map(),groupInfo:new Map()});
    this.group('default',{title:'基础（找工具）',state:'on'});
    this.register({name:'search_tools',group:'default',description:'按关键词搜索可用工具（含暂未放进列表的工具组）。当前列表里没有需要的能力时先调用它；搜到的工具从下一步起可以直接调用。',parameters:{keyword:{type:'string',description:'能力关键词，如 网站、公告、天气、论文；留空列出全部'}},
      handler:({keyword=''},ctx)=>{const found=this.search(keyword,ctx);ctx.activate?.(found.map(t=>t.name));return {tools:found,note:found.length?'这些工具已加入可用列表。':'没有找到匹配的工具。'};}});
    this.register({name:'list_tool_groups',group:'default',description:'列出所有工具组、状态和工具数量。',handler:(_,ctx)=>({groups:this.groups().filter(g=>g.state!=='off').map(g=>({...g,usable:g.tools.filter(t=>RISK[t.risk]<=RISK[ctx.maxRisk||'read']).length}))})});
  }
  group(id,{title=id,state='on'}={}){if(!/^[a-z][a-z0-9_]{0,40}$/.test(id))throw new Error('工具组名称无效：'+id);this.groupInfo.set(id,{title,state});return this;}
  register({name,group='default',description,parameters={},required=[],risk='read',handler}){
    if(!/^[a-z][a-z0-9_]{1,63}$/.test(name)||this.tools.has(name))throw new Error('工具名称无效或重复：'+name);
    if(!(risk in RISK)||typeof handler!=='function'||!this.groupInfo.has(group))throw new Error('工具定义不完整：'+name);
    this.tools.set(name,{name,group,risk,definition:fn(name,clip(description,600),parameters,required),run:handler});return this;
  }
  // A mounted provider supplies a changing set of tools (the research toolkit, an MCP server).
  mount(group,provider,{title=group,state='on',risk='read'}={}){this.group(group,{title,state});this.mounts.set(group,{provider,risk});return this;}
  unmount(group){this.mounts.delete(group);this.groupInfo.delete(group);}
  state(group){const saved=this.states()[group];return group==='default'?'on':STATES.includes(saved)?saved:this.groupInfo.get(group)?.state||'off';}
  entries(){
    const out=[...this.tools.values()];
    for(const [group,{provider,risk}] of this.mounts)for(const d of provider.definitions()||[]){const name=d.function?.name;if(name&&!this.tools.has(name))out.push({name,group,risk:d.risk in RISK?d.risk:risk,definition:{type:'function',function:d.function},run:(args,ctx)=>provider.execute(name,args,ctx)});}
    return out.filter(t=>this.groupInfo.has(t.group));
  }
  usable(t,ctx={}){return this.state(t.group)!=='off'&&RISK[t.risk]<=RISK[ctx.maxRisk||'read'];}
  // Tools offered to the model this step: "on" groups plus anything search_tools activated.
  definitions({active=new Set(),maxRisk='read'}={}){return this.entries().filter(t=>this.usable(t,{maxRisk})&&(this.state(t.group)==='on'||active.has(t.name))).map(t=>t.definition);}
  names(){return new Set(this.entries().filter(t=>this.state(t.group)!=='off').map(t=>t.name));}
  risk(name){return this.entries().find(t=>t.name===name)?.risk;}
  search(keyword,ctx={}){const words=String(keyword||'').toLowerCase().split(/[\s,，、]+/).filter(Boolean);
    return this.entries().filter(t=>t.group!=='default'&&this.usable(t,ctx)).map(t=>{const text=(t.name+' '+t.group+' '+(this.groupInfo.get(t.group)?.title||'')+' '+t.definition.function.description).toLowerCase();return {t,score:words.length?words.filter(w=>text.includes(w)).length:1};})
      .filter(x=>x.score>0).sort((a,b)=>b.score-a.score).slice(0,12).map(({t})=>({name:t.name,group:t.group,description:clip(t.definition.function.description,200)}));}
  groups(){return [...this.groupInfo].map(([group,{title}])=>{const tools=this.entries().filter(t=>t.group===group);return {group,title,state:this.state(group),count:tools.length,tools:tools.map(({name,risk})=>({name,risk}))};});}
  status(){const research=this.mounts.get('research')?.provider.status?.()||{};return {...research,toolGroups:this.groups().map(({group,title,state,count})=>({group,title,state,count}))};}
  async execute(name,args,ctx={}){
    const t=this.entries().find(x=>x.name===name);if(!t)throw new Error('没有这个工具：'+name+'。可以先用 search_tools 查找。');
    if(!this.usable(t,ctx))throw new Error(this.state(t.group)==='off'?'这个工具组已被关闭。':'这个工具会修改外部内容，当前流程只允许只读工具。');
    if(this.state(t.group)!=='on'&&!ctx.active?.has(name)&&t.group!=='default')throw new Error('请先用 search_tools 找到这个工具再调用。');
    return t.run(args||{},ctx);
  }
}
