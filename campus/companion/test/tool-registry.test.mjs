import test from 'node:test';
import assert from 'node:assert/strict';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {ListToolsRequestSchema,CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {ToolRegistry} from '../src/tool-registry.mjs';
import {connectMcp} from '../src/mcp-tools.mjs';
import {ToolAgent} from '../src/agent.mjs';

function registry(states={}){
  const r=new ToolRegistry({states:()=>states}).group('site',{title:'网站管理',state:'search'}).group('extras',{title:'额外',state:'on'});
  r.register({name:'site_health',group:'site',description:'检查网站是否在线',handler:()=>({ok:true})});
  r.register({name:'site_announce',group:'site',risk:'publish',description:'发布网站公告',handler:()=>({posted:true})});
  r.register({name:'weather',group:'extras',description:'查天气',handler:()=>({sunny:true})});
  r.mount('research',{definitions:()=>[{type:'function',function:{name:'wiki_search',description:'维基检索',parameters:{type:'object',properties:{}}}}],execute:async(name,args)=>({name,args}),status:()=>({scholar:['openalex']})},{title:'检索'});
  return r;
}

test('groups decide what is offered; search finds hidden read tools and never offers publish tools to a read-only run',async()=>{
  const r=registry(),names=defs=>defs.map(d=>d.function.name);
  assert.deepEqual(names(r.definitions()).sort(),['list_tool_groups','search_tools','weather','wiki_search']);
  const active=new Set(),ctx={active,maxRisk:'read',activate:n=>n.forEach(x=>active.add(x))};
  await assert.rejects(r.execute('site_health',{},ctx),/search_tools/);
  const found=await r.execute('search_tools',{keyword:'网站'},ctx);
  assert.deepEqual(found.tools.map(t=>t.name),['site_health']);assert.ok(names(r.definitions({active})).includes('site_health'));
  assert.deepEqual(await r.execute('site_health',{},ctx),{ok:true});
  await assert.rejects(r.execute('site_announce',{},ctx),/只读/);
  assert.deepEqual(await r.execute('wiki_search',{q:1},ctx),{name:'wiki_search',args:{q:1}});
  assert.deepEqual(r.status().scholar,['openalex']);assert.ok(r.status().toolGroups.some(g=>g.group==='site'&&g.state==='search'));
  const off=registry({extras:'off',site:'on'});assert.ok(!names(off.definitions()).includes('weather'));assert.ok(names(off.definitions()).includes('site_health'));
  await assert.rejects(off.execute('weather',{},{}),/关闭/);
  assert.throws(()=>r.register({name:'weather',group:'extras',description:'重复',handler:()=>{}}),/重复/);
});

test('the agent can discover a tool with search_tools and call it on the next step',async()=>{
  const r=registry(),seen=[],call=(id,name,args)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
  const steps=[{tool_calls:[call('1','search_tools',{keyword:'网站'})]},{tool_calls:[call('2','site_health',{})]},{tool_calls:[call('3','finish',{answer:'网站正常',findings:[],confidence:'low'})]}];
  const models={chat:async(messages,o)=>{seen.push(o.tools.map(t=>t.function.name));return {message:{role:'assistant',content:'',...steps.shift()},cost:0};}};
  const result=await new ToolAgent({models,toolkit:r}).run({task:'网站还好吗'});
  assert.ok(!seen[0].includes('site_health'));assert.ok(seen[1].includes('site_health'));
  assert.deepEqual(result.trace.map(t=>[t.tool,t.ok]),[['search_tools',true],['site_health',true]]);
});

test('MCP servers become a search-only group; only read-only MCP tools reach the research agent',async()=>{
  const server=new Server({name:'demo',version:'1'},{capabilities:{tools:{}}});
  server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:'get-weather',description:'查询城市天气',inputSchema:{type:'object',properties:{city:{type:'string'}}},annotations:{readOnlyHint:true}},{name:'delete-file',description:'删除文件',inputSchema:{type:'object',properties:{}}}]}));
  server.setRequestHandler(CallToolRequestSchema,async req=>req.params.name==='get-weather'?{content:[{type:'text',text:req.params.arguments.city+' 晴'}]}:{content:[{type:'text',text:'不该被调用'}],isError:true});
  const r=new ToolRegistry();let client;
  const mcp=await connectMcp(r,[{name:'Demo Server',command:'unused'},{name:''}],{connect:async()=>{const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);client=new Client({name:'t',version:'1'});await client.connect(a);return client;}});
  try{
    assert.deepEqual(mcp.status.map(s=>s.ok),[true,false]);
    const group=r.groups().find(g=>g.group==='mcp_demo_server');assert.equal(group.state,'search');
    assert.deepEqual(group.tools,[{name:'mcp_demo_server__get_weather',risk:'read'},{name:'mcp_demo_server__delete_file',risk:'write'}]);
    const active=new Set(),ctx={active,maxRisk:'read',activate:n=>n.forEach(x=>active.add(x))};
    assert.deepEqual((await r.execute('search_tools',{keyword:'天气 删除'},ctx)).tools.map(t=>t.name),['mcp_demo_server__get_weather']);
    assert.equal((await r.execute('mcp_demo_server__get_weather',{city:'北京'},ctx)).result,'北京 晴');
    await assert.rejects(r.execute('mcp_demo_server__delete_file',{},ctx),/只读/);
  }finally{await mcp.close();}
});
