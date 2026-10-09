import {clip} from './research-tools.mjs';
// MCP servers listed in config.mcpServers become tool groups (mcp_<name>), discovered through search_tools.
// Tools without readOnlyHint count as "write", so the read-only research agent never calls them.
const slug=v=>String(v||'').toLowerCase().replace(/[^a-z0-9_]+/g,'_').replace(/^_+|_+$/g,'').slice(0,24);
export function mcpProvider(client,tools,prefix){
  const byName=new Map(tools.map(t=>[prefix+slug(t.name),t]));
  return {
    definitions:()=>[...byName].map(([name,t])=>({type:'function',risk:t.annotations?.readOnlyHint===true?'read':'write',function:{name,description:clip(t.description||t.name,600),parameters:t.inputSchema?.type==='object'?t.inputSchema:{type:'object',properties:{}}}})),
    async execute(name,args){
      const t=byName.get(name);if(!t)throw new Error('MCP 工具不存在。');
      const r=await client.callTool({name:t.name,arguments:args},undefined,{timeout:30000});
      const text=(r.content||[]).map(c=>c.type==='text'?c.text:c.type==='resource'?c.resource?.text||'':'['+c.type+']').join('\n');
      if(r.isError)throw new Error(clip(text||'MCP 工具返回错误。',500));
      return {result:clip(text,8000),structured:r.structuredContent};
    },
  };
}
export async function connectMcp(registry,servers=[],{connect=defaultConnect}={}){
  const clients=[],status=[];
  for(const s of Array.isArray(servers)?servers.slice(0,8):[]){
    const name=slug(s?.name);if(!name){status.push({name:String(s?.name||''),ok:false,error:'名称无效'});continue;}
    try{
      const client=await connect(s);const {tools}=await client.listTools();
      registry.mount('mcp_'+name,mcpProvider(client,tools,'mcp_'+name+'__'),{title:'MCP · '+name,state:'search',risk:'write'});
      clients.push(client);status.push({name,ok:true,tools:tools.length});
    }catch(e){status.push({name,ok:false,error:clip(e.message,200)});}
  }
  return {status,close:()=>Promise.allSettled(clients.map(c=>c.close()))};
}
async function defaultConnect(s){
  const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');let transport;
  if(typeof s.url==='string'){const u=new URL(s.url);if(!['http:','https:'].includes(u.protocol))throw new Error('MCP 地址只接受 http(s)。');const {StreamableHTTPClientTransport}=await import('@modelcontextprotocol/sdk/client/streamableHttp.js');transport=new StreamableHTTPClientTransport(u);}
  else if(typeof s.command==='string'){const {StdioClientTransport}=await import('@modelcontextprotocol/sdk/client/stdio.js');transport=new StdioClientTransport({command:s.command,args:Array.isArray(s.args)?s.args.map(String):[],env:s.env&&typeof s.env==='object'?{...process.env,...s.env}:undefined,stderr:'ignore'});}
  else throw new Error('需要 command 或 url。');
  const client=new Client({name:'campus-companion',version:'1.0.0'});await client.connect(transport);return client;
}
