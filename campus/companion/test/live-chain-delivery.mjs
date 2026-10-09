import {writeFileSync} from 'node:fs';
if(!process.argv.includes('--send-test'))throw new Error('Explicit --send-test required');
const base='http://127.0.0.1:17839',response=await fetch(base+'/api/bootstrap'),initial=await response.json();
const headers={'Content-Type':'application/json','x-miku-token':initial.csrf,Cookie:response.headers.get('set-cookie').split(';')[0]};
const r=await fetch(base+'/api/weixin/test',{method:'POST',headers,body:JSON.stringify({stickerTest:true}),signal:AbortSignal.timeout(90000)}),result=await r.json();
const current=await (await fetch(base+'/api/state',{headers})).json();
const report={at:new Date().toISOString(),httpStatus:r.status,delivery:result.delivery||null,error:result.error||null,lastReceivedBefore:initial.weixin.lastReceivedAt,lastReceivedAfter:current.weixin.lastReceivedAt,ready:current.weixin.ready};
writeFileSync('test-output/live-chain-delivery.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
if(!r.ok||result.delivery?.status!=='sent')process.exitCode=1;
