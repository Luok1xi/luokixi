// Explicit owner-authorized integration check. Uses the real two-seat conversation path.
import {request} from 'playwright';
import {readFile,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
const base='http://127.0.0.1:17860';
const client=await request.newContext({baseURL:base});
try{
 let session=await (await client.get('/api/hub/auth/session')).json();
 const c=await readFile('campus/.data/hub/owner-private/developer-account.txt','utf8');
 const email=c.match(/登录邮箱（仅本机占位）：([^\r\n]+)/)?.[1]?.trim(),password=c.match(/初始密码：([^\r\n]+)/)?.[1]?.trim();
 async function post(route,data){const r=await client.post('/api/hub/'+route,{headers:{'X-CSRFToken':session.csrfToken,Origin:base},data});const body=await r.json();if(!r.ok())throw Error(route+': '+r.status()+' '+JSON.stringify(body));return body;}
 await post('auth/login',{email,password});
 session=await (await client.get('/api/hub/auth/session')).json();
 const rooms=await (await client.get('/api/hub/studio/rooms')).json();
 const room=rooms.items.find(r=>r.title==='她们的工作间')||await post('studio/rooms',{title:'她们的工作间',brief:'依据真实维护工具结果协作，保留每次尝试和未解决原因。',contextFiles:[]});
 const run=await post(`studio/rooms/${room.id}/runs`,{requestKey:randomUUID(),mode:'discuss',seats:['beikuang','codex'],rounds:2,
   prompt:'站主授权的工具交接验收：北矿娘先使用 campus_maintenance_read 查看机器人 inventory，再使用 campus_maintenance 的 run_robot 发起 pipeline-illustrations 自动配图检查（已有配图不覆盖）。Codex 接着读取任务状态验证结果。只执行这一项，不创建新技能或改代码。请报告真实任务编号、状态和未解决原因；排队不等于完成，不要只讨论应该怎么做。'});
 console.log(JSON.stringify({run:run.id,room:room.id,state:run.state}));
 for(let i=0;i<240;i++){
   const result=await (await client.get('/api/hub/studio/runs/'+run.id)).json();
   if(!['queued','running'].includes(result.state)){
     await writeFile('campus/.data/verification-20261008/studio-maintenance.json',JSON.stringify(result,null,2));
     console.log(JSON.stringify({state:result.state,error:result.error,messages:result.messages.map(m=>({seat:m.seat,execution:m.usage?.maintenance,body:m.body}))}));
     break;
   }
   if(i%12===0)console.log(JSON.stringify({waiting:result.state,turns:result.messages.length}));
   await new Promise(r=>setTimeout(r,2500));
 }
}finally{await client.dispose();}
